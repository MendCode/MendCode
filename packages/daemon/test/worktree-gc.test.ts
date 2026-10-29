import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { StorageWorktreesReport, type ProjectRestInfo } from "@mendcode/protocol"
import { createWorktreeGc } from "../src/worktree-gc"

const DAY = 86_400_000
const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function git(directory: string, ...argv: string[]) {
  const child = Bun.spawn(["git", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "user.name=GC Test", "-c", "user.email=gc@example.invalid", "-c", "commit.gpgsign=false", "-C", directory, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`git ${argv.join(" ")} failed: ${stderr}`)
  return stdout.trimEnd()
}

/** A project with one linked worktree per scenario, all branched from the project's first commit. */
async function fixture(names: string[]) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-gc-")))
  temporary.push(root)
  const project = path.join(root, "project")
  const dir = path.join(root, "data")
  mkdirSync(project)
  mkdirSync(dir)
  await git(project, "init", "-b", "main")
  writeFileSync(path.join(project, "tracked.txt"), "base\n")
  await git(project, "add", "tracked.txt")
  await git(project, "commit", "-m", "base")
  const trees = new Map<string, string>()
  for (const name of names) {
    const directory = path.join(root, name)
    await git(project, "worktree", "add", "-b", `mend/${name}`, directory)
    writeFileSync(path.join(directory, "build-output.bin"), "x".repeat(50_000))
    await git(directory, "add", "build-output.bin")
    await git(directory, "commit", "-m", `${name} work`)
    trees.set(name, directory)
  }
  const info = { id: "p", worktree: project, vcs: "git", time: { created: 0, updated: 0 }, sandboxes: [...trees.values()] } as unknown as ProjectRestInfo
  const forgotten: string[] = []
  const occupied = new Set<string>()
  const lastSession = new Map<string, number>()
  let now = Date.now() + 30 * DAY
  const gc = createWorktreeGc({
    dir,
    projects: () => [info],
    occupied: (directory) => occupied.has(directory),
    lastSession: (directory) => lastSession.get(directory) ?? 0,
    forget: (_project, directory) => void forgotten.push(directory),
    now: () => now,
  })
  return { root, project, dir, trees, gc, forgotten, occupied, lastSession, setNow: (value: number) => void (now = value), info }
}

describe("worktree storage report", () => {
  test("measures each worktree and says why it is kept or removable", async () => {
    const { gc, trees, project, occupied } = await fixture(["merged", "unmerged", "dirty", "busy", "gone"])
    // merged: its branch is in main
    await git(project, "merge", "--no-edit", "mend/merged")
    // unmerged: stays a commit ahead of main (the fixture's own commit), and main moves on
    writeFileSync(path.join(project, "later.txt"), "later\n")
    await git(project, "add", "later.txt")
    await git(project, "commit", "-m", "later")
    await git(project, "merge", "--no-edit", "mend/dirty")
    await git(project, "merge", "--no-edit", "mend/busy")
    await git(project, "merge", "--no-edit", "mend/gone")
    writeFileSync(path.join(trees.get("dirty")!, "scratch.txt"), "work in progress\n")
    occupied.add(trees.get("busy")!)
    rmSync(trees.get("gone")!, { recursive: true, force: true })

    const report = await gc.report(14)
    expect(StorageWorktreesReport.safeParse(report).success).toBe(true)
    const byName = new Map(report.worktrees.map((tree) => [path.basename(tree.directory), tree]))
    expect(byName.get("merged")).toMatchObject({ state: "merged", clean: true, removable: true })
    expect(byName.get("merged")!.bytes).toBeGreaterThan(50_000)
    expect(byName.get("unmerged")).toMatchObject({ state: "unmerged", removable: false, keep: "branch has commits that are not merged" })
    expect(byName.get("dirty")).toMatchObject({ clean: false, removable: false, keep: "uncommitted or untracked changes" })
    expect(byName.get("busy")).toMatchObject({ occupied: true, removable: false })
    expect(byName.get("gone")).toMatchObject({ state: "missing", bytes: 0, removable: true })
    expect(report.removableBytes).toBe(byName.get("merged")!.bytes)
    expect(report.totalBytes).toBeGreaterThan(report.removableBytes)
  })

  test("a worktree used recently is kept until it has been idle long enough", async () => {
    const { gc, trees, project, setNow, lastSession } = await fixture(["fresh"])
    await git(project, "merge", "--no-edit", "mend/fresh")
    const now = Date.now() + 30 * DAY
    setNow(now)
    lastSession.set(trees.get("fresh")!, now - 2 * DAY)
    // The checkout itself is a minute old, but the idle clock follows the newest sign of use, here a session two days ago.
    const first = (await gc.report(14)).worktrees[0]!
    expect(first).toMatchObject({ removable: false })
    expect(first.keep).toBe("used 2 days ago")
    expect((await gc.report(1)).worktrees[0]).toMatchObject({ removable: true })
  })
})

describe("worktree clean", () => {
  test("a dry run removes nothing; the real run removes only what is merged, clean and unused, and forgets it", async () => {
    const { gc, trees, project, forgotten, occupied } = await fixture(["done", "wip", "busy"])
    await git(project, "merge", "--no-edit", "mend/done")
    await git(project, "merge", "--no-edit", "mend/busy")
    occupied.add(trees.get("busy")!)
    const dry = await gc.clean({ idleDays: 14, dryRun: true })
    expect(dry.removed).toBe(1)
    expect(dry.bytes).toBeGreaterThan(50_000)
    expect(existsSync(trees.get("done")!)).toBe(true)
    expect(forgotten).toEqual([])

    const real = await gc.clean({ idleDays: 14 })
    expect(real.removed).toBe(1)
    expect(existsSync(trees.get("done")!)).toBe(false)
    expect(existsSync(trees.get("wip")!)).toBe(true)
    expect(existsSync(trees.get("busy")!)).toBe(true)
    expect(forgotten).toEqual([trees.get("done")!])
    // The branch of a removed worktree goes with it (it was merged), and its objects stay in the project.
    expect(await git(project, "branch", "--list", "mend/done")).toBe("")
    expect(await git(project, "worktree", "list")).not.toContain("done")
  })

  test("git itself refuses to remove a checkout with changes, even when the report thought it clean", async () => {
    const { gc, trees, project, forgotten, info } = await fixture(["race"])
    await git(project, "merge", "--no-edit", "mend/race")
    // The report runs, then work lands before the removal: simulate with a second scan after the file appears.
    const first = await gc.report(14)
    expect(first.worktrees[0]!.removable).toBe(true)
    writeFileSync(path.join(trees.get("race")!, "late.txt"), "late work\n")
    const result = await gc.clean({ idleDays: 14 })
    expect(result.removed).toBe(0)
    expect(existsSync(path.join(trees.get("race")!, "late.txt"))).toBe(true)
    expect(forgotten).toEqual([])
    expect(info.sandboxes).toHaveLength(1)
  })

  test("a worktree whose directory vanished is pruned and forgotten", async () => {
    const { gc, trees, project, forgotten } = await fixture(["vanished"])
    rmSync(trees.get("vanished")!, { recursive: true, force: true })
    const result = await gc.clean({ idleDays: 14 })
    expect(result.removed).toBe(1)
    expect(forgotten).toEqual([trees.get("vanished")!])
    expect(await git(project, "worktree", "list")).not.toContain("vanished")
  })

  test("old trash copies go, recent ones stay", async () => {
    const { gc, dir, setNow } = await fixture([])
    const trash = path.join(dir, "trash", "worktrees")
    mkdirSync(path.join(trash, "old"), { recursive: true })
    mkdirSync(path.join(trash, "new"), { recursive: true })
    writeFileSync(path.join(trash, "old", "file"), "o".repeat(1000))
    writeFileSync(path.join(trash, "new", "file"), "n".repeat(1000))
    const now = Date.now()
    setNow(now)
    const old = new Date(now - 40 * DAY)
    utimesSync(path.join(trash, "old"), old, old)
    expect(await gc.trashBytes()).toBeGreaterThanOrEqual(2000)
    const result = await gc.clean({ idleDays: 14 })
    expect(result.removed).toBe(1)
    expect(existsSync(path.join(trash, "old"))).toBe(false)
    expect(existsSync(path.join(trash, "new"))).toBe(true)
  })
})
