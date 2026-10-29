import { afterEach, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, watch, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaultUiWatchMode, reloadDescends } from "../src/customize-ui"
import { watchTree, type DirectoryWatch } from "../src/watch-tree"
import { budgetMs } from "../../../scripts/test-budget"

const cleanups: Array<() => void> = []
afterEach(() => { for (const fn of cleanups.splice(0)) fn() })

function sandbox() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "watch-tree-")))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function put(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
/** `again` repeats the action each round: macOS starts its native watch on another thread, so a write made right after arming can precede it (inotify arms synchronously). */
async function until(check: () => boolean, what: string, again?: () => void, detail?: () => string) {
  const end = Date.now() + budgetMs(3_000)
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${detail ? `\n${detail()}` : ""}`)
    again?.()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
function observe(root: string, options: Partial<Parameters<typeof watchTree>[0]> = {}) {
  const seen: Array<string | undefined> = []
  const watcher = watchTree({ ...options, root, descend: options.descend ?? (() => true), onChange: (relative) => seen.push(relative) })
  cleanups.push(watcher.close)
  return { seen, watcher, has: (relative: string) => seen.includes(relative) }
}

test("a file written into a directory created after the watch started is reported, also several levels down and written at once", async () => {
  const root = sandbox()
  const { has } = observe(root)
  // The first write follows the arming at once, and the last one the arming of a new directory: both repeat (see `until`).
  // What the root's watch may have missed is `skills` appearing in the root, and writing the file again changes nothing there: with
  // the machine loaded the watch started after the first write and the file was never reported, however long the wait. Each round
  // therefore also writes in the root itself, which a watch that has started sees, and the rescan it causes finds `skills`.
  let round = 0
  put(path.join(root, "skills", "x", "SKILL.md"), "body")
  await until(() => has("skills/x/SKILL.md"), "the skill file in a new directory", () => {
    put(path.join(root, "skills", "x", "SKILL.md"), "body")
    writeFileSync(path.join(root, "again.txt"), String(round++))
  })
  put(path.join(root, "a", "b", "c", "deep.md"), "deep")
  await until(() => has("a/b/c/deep.md"), "a file three new levels down")
  writeFileSync(path.join(root, "a", "b", "c", "later.md"), "later")
  await until(() => has("a/b/c/later.md"), "a later write in the directory armed on the way", () => writeFileSync(path.join(root, "a", "b", "c", "later.md"), "later"))
})

test("directories that existed at the start are armed, ones the filter refuses are not", async () => {
  const root = sandbox()
  mkdirSync(path.join(root, "skills", "x"), { recursive: true })
  mkdirSync(path.join(root, "sessions", "deep"), { recursive: true })
  const { watcher, has, seen } = observe(root, { descend: (relative) => relative === "skills" || relative.startsWith("skills/") })
  expect(watcher.directories()).toBe(3)
  put(path.join(root, "skills", "x", "a.md"), "a")
  await until(() => has("skills/x/a.md"), "an existing directory", () => put(path.join(root, "skills", "x", "a.md"), "a"))
  put(path.join(root, "sessions", "deep", "b.md"), "b")
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(seen.some((relative) => relative?.startsWith("sessions/deep"))).toBe(false)
})

/**
 * What a platform's watch may report instead of the plain truth. `native` is this machine's own; the others are the shapes inotify (via
 * Bun) is allowed to produce: no file name at all, the name of a temp file that no longer exists, or a watch that goes dead once its
 * directory is deleted and says nothing about the directory made again under the same path.
 */
type Shape = Partial<Pick<Parameters<typeof watchTree>[0], "watchDirectory" | "stat" | "suspectPollMs">>
const plain: DirectoryWatch = (dir, listener) => watch(dir, { recursive: false }, listener)
/** What this machine's own filesystem would have to report for a Linux one: no birth time, and a directory made right after a delete gets the old inode back. */
const linuxStat = (file: string) => {
  const found = lstatSync(file)
  return { ino: found.isDirectory() ? 4242 : found.ino, size: found.size, mtimeMs: found.mtimeMs, birthtimeMs: 0 }
}
/** A fresh set of shapes per test: some keep state (which paths were watched before). */
const shapes: Record<string, () => Shape> = {
  native: () => ({ watchDirectory: plain }),
  "no file name": () => ({ watchDirectory: (dir, listener) => watch(dir, { recursive: false }, () => listener("rename", null)) }),
  "a stale file name": () => ({ watchDirectory: (dir, listener) => watch(dir, { recursive: false }, () => listener("rename", "stale.tmp")) }),
  "a watch that dies with its directory": () => ({
    watchDirectory: (dir, listener) => {
      let dead = false
      return watch(dir, { recursive: false }, (event, filename) => {
        if (!existsSync(dir)) dead = true
        if (!dead) listener(event, filename === null ? undefined : String(filename))
      })
    },
  }),
  // Whether a watch on a path that was watched and lost reports is up to the platform's own bookkeeping; this one never does.
  "a re-created path whose new watch never reports": () => {
    const watchedBefore = new Set<string>()
    return {
      watchDirectory: (dir, listener) => {
        const mute = watchedBefore.has(dir)
        watchedBefore.add(dir)
        return watch(dir, { recursive: false }, (event, filename) => { if (!mute) listener(event, filename === null ? undefined : String(filename)) })
      },
    }
  },
  "Linux stat numbers (no birth time, a reused directory inode)": () => ({ watchDirectory: plain, stat: linuxStat }),
  "Linux stat numbers and a muted re-created watch": () => {
    const muted = shapes["a re-created path whose new watch never reports"]!()
    return { ...muted, stat: linuxStat }
  },
}

for (const [name, make] of Object.entries(shapes)) {
  test(`with ${name}: a directory deleted and created again is watched again, and an atomic save by rename and a rename over an existing file are reported`, async () => {
    const root = sandbox()
    mkdirSync(path.join(root, "commands"), { recursive: true })
    const { has, watcher, seen } = observe(root, make())
    const detail = () => `${watcher.describe()}\nreported so far: ${JSON.stringify(seen)}\nlisting now: ${JSON.stringify(readdirSync(path.join(root, "commands")))}`
    const fixed = new Date("2026-01-02T03:04:05.000Z")
    put(path.join(root, "commands", "one.md"), "1")
    await until(() => has("commands/one.md"), "the first write", () => put(path.join(root, "commands", "one.md"), "1"), detail)
    rmSync(path.join(root, "commands"), { recursive: true })
    await until(() => watcher.directories() === 1, "the deleted directory to be dropped", undefined, detail)
    put(path.join(root, "commands", "two.md"), "2")
    utimesSync(path.join(root, "commands", "two.md"), fixed, fixed)
    await until(() => has("commands/two.md"), "the recreated directory", undefined, detail)
    // A file renamed in keeps its inode, size and mtime (here equal to the file already seen): only its name is new.
    writeFileSync(path.join(root, "commands", "three.md.tmp"), "3")
    utimesSync(path.join(root, "commands", "three.md.tmp"), fixed, fixed)
    renameSync(path.join(root, "commands", "three.md.tmp"), path.join(root, "commands", "three.md"))
    await until(() => has("commands/three.md"), "the renamed file", undefined, detail)
    // An editor's save over an existing file: an event may mention only the temp file's name.
    await new Promise((resolve) => setTimeout(resolve, 100))
    const before = seen.filter((relative) => relative === "commands/two.md").length
    writeFileSync(path.join(root, "commands", "four.md.tmp"), "4")
    utimesSync(path.join(root, "commands", "four.md.tmp"), fixed, fixed)
    renameSync(path.join(root, "commands", "four.md.tmp"), path.join(root, "commands", "two.md"))
    await until(() => seen.filter((relative) => relative === "commands/two.md").length > before, "the file replaced by a rename", undefined, detail)
  })
}

test("the number of armed directories never passes the bound", async () => {
  const root = sandbox()
  const { watcher } = observe(root, { maxDirectories: 5 })
  for (let i = 0; i < 20; i++) put(path.join(root, `d${i}`, "f.md"), "x")
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(watcher.directories()).toBeLessThanOrEqual(5)
})

test("nothing is reported after close", async () => {
  const root = sandbox()
  const { watcher, seen } = observe(root)
  watcher.close()
  put(path.join(root, "late", "x.md"), "x")
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(seen).toEqual([])
  expect(watcher.directories()).toBe(0)
})

test("a layer's folders that can reload are descended, everything else is not; Linux watches the tree itself, the others use the native recursive watch", () => {
  const accepted = ["packages", "packages/kit", "skills", "skills/x/deep", "packages/kit/commands", "packages/kit/extensions/sub", "agents", "command"]
  const refused = ["sessions", "blobs/ab", "packages/kit/notes", "packages/kit/cache/skills", "notes"]
  expect(accepted.filter((relative) => !reloadDescends(relative))).toEqual([])
  expect(refused.filter((relative) => reloadDescends(relative))).toEqual([])
  expect(defaultUiWatchMode({}, "linux")).toBe("tree")
  expect(defaultUiWatchMode({}, "darwin")).toBe("native")
  expect(defaultUiWatchMode({ MENDCODE_UI_WATCH: "native" }, "linux")).toBe("native")
  expect(defaultUiWatchMode({ MENDCODE_UI_WATCH: "tree" }, "darwin")).toBe("tree")
  expect(defaultUiWatchMode({ MENDCODE_UI_WATCH: "bogus" }, "linux")).toBe("tree")
})
