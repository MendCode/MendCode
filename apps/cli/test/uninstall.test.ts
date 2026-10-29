import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { openStore } from "@mendcode/store"
import { isUninstallCommand, parseUninstallArgs } from "@mendcode/upgrade/uninstall-args"
import { collectUninstallPlan, executeUninstall, runUninstallCommand } from "@mendcode/upgrade/uninstall"
import { helpText } from "../src/automation"
import { completionScript } from "../src/support-output"
import { textWidth } from "../src/view/wrap"
import { uninstallHarness } from "./uninstall-harness"

const boxes: ReturnType<typeof uninstallHarness>[] = []
const fixture = () => { const h = uninstallHarness(); boxes.push(h); return h }
afterEach(() => { for (const box of boxes.splice(0)) box.cleanup() })
const state = (dir: string): object => Object.fromEntries(readdirSync(dir).sort().map((name) => {
  const file = path.join(dir, name)
  return [name, lstatSync(file).isDirectory() ? state(file) : lstatSync(file).isFile() ? readFileSync(file).toString("base64") : "link"]
}))

test("uninstall parser supports every v1 flag/alias, rejects values and dispatches only on the first word", () => {
  const parsed = parseUninstallArgs(["--dir=/tmp/v2", "uninstall", "-c", "-d", "--dry-run", "-f", "--format=json"])
  expect(parsed).toEqual({ ok: true, command: { dir: "/tmp/v2", keepConfig: true, keepData: true, dryRun: true, force: true, json: true, help: false } })
  for (const args of [["uninstall", "extra"], ["uninstall", "--dir"], ["uninstall", "--format=text"], ["uninstall", "--force=false"], ["uninstall", "--unknown=fixture-secret"]]) {
    const result = parseUninstallArgs(args)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain("fixture-secret")
  }
  expect(isUninstallCommand(["--dir", "/tmp/v2", "uninstall", "--dry-run"])).toBe(true)
  expect(isUninstallCommand(["run", "uninstall"])).toBe(false)
  expect(helpText("uninstall")).toContain("--keep-data")
  expect(helpText()).toContain("uninstall")
  expect(completionScript("bash")).toContain("uninstall")
})

test("dry-run shows real targets and bytes without modifying files, sidecars, locks, PATH or credentials", async () => {
  const h = fixture(), before = state(h.root)
  const code = await runUninstallCommand(h.command("--dry-run"), h.deps)
  expect(code).toBe(0)
  expect(state(h.root)).toEqual(before)
  const { out, err } = h.output()
  expect(out).toContain("Dry run: no changes made")
  expect(out).toContain(h.binary)
  expect(out).toContain("Verified installation receipt")
  expect(out).not.toContain("fixture-secret")
  expect(err).toBe("")
})

test("dry-run does not create missing data/default installation directories", async () => {
  const h = fixture(), dir = path.join(h.root, "missing")
  expect(await runUninstallCommand({ ...h.command("--dry-run"), dir }, { ...h.deps, home: path.join(h.root, "other-home") })).toBe(0)
  expect(existsSync(dir)).toBe(false)
  expect(existsSync(path.join(h.root, "other-home"))).toBe(false)
})

test("forced uninstall moves only recognized owned targets to recoverable Trash", async () => {
  const h = fixture()
  expect(await runUninstallCommand(h.command("--force", "--json"), h.deps)).toBe(0)
  const result = JSON.parse(h.output().out.trim().split("\n").at(-1)!)
  expect(result.data.status).toBe("uninstalled")
  expect(existsSync(path.join(result.data.trash, "restore.json"))).toBe(true)
  expect(readdirSync(result.data.trash).some((name) => name.endsWith("mendd.db"))).toBe(true)
  expect(readFileSync(path.join(h.dir, "personal.txt"), "utf8")).toBe("unrelated file")
  expect(existsSync(path.join(h.dir, "mendd.db"))).toBe(false)
  expect(existsSync(path.join(h.dir, "mendd.lock"))).toBe(false)
  expect(existsSync(h.binary)).toBe(false)
  expect(existsSync(path.join(h.bin, ".mendcode-v2-install"))).toBe(false)
  expect(lstatSync(result.data.trash).mode & 0o777).toBe(0o700)
})

for (const [keepConfig, keepData] of [[true, false], [false, true], [true, true]] as const) test(`keep-config=${keepConfig}, keep-data=${keepData} separates SQLite and filesystem state and reopens through v2 store`, async () => {
  const h = fixture()
  const command = h.command("--force", ...(keepConfig ? ["--keep-config"] : []), ...(keepData ? ["--keep-data"] : []))
  expect(await runUninstallCommand(command, h.deps)).toBe(0)
  const store = openStore({ dir: h.dir })
  try {
    expect(store.settings.get().onboarded).toBe(keepConfig ? true : undefined)
    expect(store.hasSession(h.sessionId)).toBe(keepData)
    expect(store.readAfter(h.sessionId, 0).length > 0).toBe(keepData)
  } finally { store.close() }
  for (const name of ["providers.json", "tui/profile.json", "extensions/demo.ts"]) expect(existsSync(path.join(h.dir, name))).toBe(keepConfig)
  for (const name of ["blobs/attachment", "keys/secrets.key", "scratchpads/project.txt", "goals/goal.md"]) expect(existsSync(path.join(h.dir, name))).toBe(keepData)
  expect(existsSync(path.join(h.dir, "pets-cache"))).toBe(false)
  expect(existsSync(h.binary)).toBe(false)
})

test("without force, noninteractive input requires review; Enter/cancellation never mutates", async () => {
  const h = fixture(), before = state(h.root)
  expect(await runUninstallCommand(h.command(), h.deps)).toBe(4)
  expect(await runUninstallCommand(h.command(), { ...h.deps, confirm: async () => false })).toBe(2)
  expect(state(h.root)).toEqual(before)
  expect(await runUninstallCommand(h.command(), { ...h.deps, confirm: async (plan) => plan.owned })).toBe(0)
})

test("force cannot bypass an active or malformed daemon lock; dry-run still reviews it", async () => {
  const h = fixture()
  for (const content of [String(process.pid), "unknown"]) {
    writeFileSync(path.join(h.dir, "mendd.lock"), content)
    const before = state(h.root)
    expect(await runUninstallCommand(h.command("--force"), h.deps)).toBe(1)
    expect(await runUninstallCommand(h.command("--dry-run"), h.deps)).toBe(0)
    expect(state(h.root)).toEqual(before)
  }
})

test("daemon starting during confirmation is rejected by the shared writer lock", async () => {
  const h = fixture()
  expect(await runUninstallCommand(h.command(), { ...h.deps, confirm: async () => {
    writeFileSync(path.join(h.dir, "mendd.lock"), String(process.pid))
    return true
  } })).toBe(1)
  expect(existsSync(h.binary)).toBe(true)
  expect(existsSync(path.join(h.dir, "mendd.db"))).toBe(true)
})

test("reviewed targets changed during confirmation abort before any files move", async () => {
  const h = fixture()
  const command = h.command("--force")
  const plan = collectUninstallPlan(command, h.deps)
  writeFileSync(h.binary, "new install after review")
  await expect(executeUninstall(plan, command, h.deps)).rejects.toThrow("targets changed")
  expect(existsSync(path.join(h.dir, "mendd.db"))).toBe(true)
  expect(readFileSync(h.binary, "utf8")).toBe("new install after review")
  expect(existsSync(path.join(h.home, ".Trash"))).toBe(false)
})

test("a failed move restores earlier originals, including the database; the writer lock is released", async () => {
  const h = fixture(), before = state(h.dir)
  let moves = 0
  const code = await runUninstallCommand(h.command("--force"), { ...h.deps, move: (source, destination) => {
    if (++moves === 3) throw new Error("fixture move failure")
    renameSync(source, destination)
  } })
  expect(code).toBe(1)
  expect(state(h.dir)).toEqual(before)
  expect(existsSync(h.binary)).toBe(true)
  expect(h.output().err).toContain("fixture move failure")
})

test("stale lock is recoverable, and keep-data handles an uncheckpointed WAL without losing history", async () => {
  const h = fixture()
  const db = new Database(path.join(h.dir, "mendd.db"))
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA wal_autocheckpoint = 0")
  db.run("UPDATE sessions SET title = 'WAL history' WHERE id = ?", [h.sessionId])
  expect(existsSync(path.join(h.dir, "mendd.db-wal"))).toBe(true)
  // A paused stale writer fixture leaves an uncheckpointed WAL; the uninstall read must use it.
  writeFileSync(path.join(h.dir, "mendd.lock"), "99999999")
  try {
    const before = state(h.root)
    expect(await runUninstallCommand(h.command("--dry-run"), { ...h.deps, alive: () => false })).toBe(0)
    expect(state(h.root)).toEqual(before)
    expect(await runUninstallCommand(h.command("--force", "--keep-data"), { ...h.deps, alive: () => false })).toBe(0)
    const retained = new Database(path.join(h.dir, "mendd.db"), { readonly: true })
    try { expect(retained.query<{ title: string }, [string]>("SELECT title FROM sessions WHERE id = ?").get(h.sessionId)?.title).toBe("WAL history") } finally { retained.close() }
  } finally { db.close() }
})

test("v1/Codex paths, their parents, and directory aliases are rejected before reads/writes", async () => {
  const h = fixture()
  const v1 = path.join(h.home, ".local", "share", "mendcode")
  mkdirSync(v1, { recursive: true })
  writeFileSync(path.join(v1, "history"), "v1 untouched")
  const alias = path.join(h.root, "alias")
  symlinkSync(v1, alias)
  for (const dir of [h.home, path.join(h.home, ".mendcode"), v1, path.join(v1, "child"), path.dirname(v1), path.join(h.home, ".codex"), alias]) {
    expect(await runUninstallCommand({ ...h.command("--force"), dir }, h.deps)).toBe(1)
  }
  expect(readFileSync(path.join(v1, "history"), "utf8")).toBe("v1 untouched")
})

test("foreign database, unowned binary and mismatched receipt are kept and reported", async () => {
  const h = fixture()
  writeFileSync(h.binary, "v1 executable")
  const before = readFileSync(h.binary)
  expect(await runUninstallCommand(h.command("--force"), h.deps)).toBe(1)
  expect(readFileSync(h.binary)).toEqual(before)
  expect(existsSync(path.join(h.bin, ".mendcode-v2-install"))).toBe(true)
  const foreign = path.join(h.root, "foreign")
  mkdirSync(foreign)
  const db = new Database(path.join(foreign, "mendd.db"))
  db.run("CREATE TABLE foreign_data (text TEXT)")
  db.close()
  writeFileSync(path.join(foreign, "providers.json"), "foreign config")
  const stateBefore = state(foreign)
  expect(await runUninstallCommand({ ...h.command("--force"), dir: foreign }, h.deps)).toBe(1)
  expect(state(foreign)).toEqual(stateBefore)
})

test("standalone discovery finds a verified custom install; source Bun remains outside the plan", async () => {
  const h = fixture()
  const installed = path.join(h.root, "custom", "mendcode")
  mkdirSync(path.dirname(installed))
  const contents = "custom v2 release"
  writeFileSync(installed, contents)
  writeFileSync(path.join(path.dirname(installed), ".mendcode-v2-install"), `schema=mendcode-v2.install.v1\nbinary=mendcode\nsha256=${createHash("sha256").update(contents).digest("hex")}\n`)
  const plan = collectUninstallPlan(h.command(), { ...h.deps, runningBinary: installed })
  expect(plan.targets.some((target) => target.path === installed && target.action === "trash")).toBe(true)
  expect(collectUninstallPlan(h.command(), h.deps).targets.some((target) => target.path === process.execPath)).toBe(false)
  expect(await runUninstallCommand(h.command("--force"), { ...h.deps, runningBinary: installed })).toBe(0)
  expect(existsSync(installed)).toBe(false)
})

test("Windows receipt verifies the exe, uses its recovery folder, and leaves user PATH ownership blocked", async () => {
  const h = fixture()
  const local = path.join(h.home, "AppData", "Local")
  const installed = path.join(local, "Programs", "mendcode", "mendcode.exe")
  mkdirSync(path.dirname(installed), { recursive: true })
  writeFileSync(installed, "windows fixture")
  writeFileSync(path.join(path.dirname(installed), ".mendcode-v2-install"), `schema=mendcode-v2.install.v1\r\nbinary=mendcode.exe\r\nsha256=${createHash("sha256").update("windows fixture").digest("hex")}\r\n`)
  const env = { LOCALAPPDATA: local, PATH: "original path" }
  expect(await runUninstallCommand(h.command("--force", "--json"), { ...h.deps, env, platform: "win32" })).toBe(1)
  const result = JSON.parse(h.output().out.trim().split("\n").at(-1)!)
  expect(result.data.status).toBe("partial")
  expect(result.data.trash.startsWith(path.join(local, "MendCodeV2", "Trash"))).toBe(true)
  expect(result.data.blockers).toContain("Windows user PATH ownership is unrecorded; review it manually")
  expect(existsSync(installed)).toBe(false)
  expect(env.PATH).toBe("original path")
})

test("help/automation startup keeps SQLite/store/protocol schemas out and the uninstall view lazy", () => {
  const probe = Bun.spawnSync([process.execPath, "-e", 'await import("./src/automation.ts"); await import("@mendcode/upgrade/uninstall-args"); const files = Object.keys(require.cache); console.log(JSON.stringify(files.filter((file) => ["/zod/", "/store/src/", "/protocol/src/commands", "/protocol/src/queries", "/protocol/src/events", "uninstall-page"].some((part) => file.includes(part)))))'], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
  expect({ code: probe.exitCode, err: probe.stderr.toString() }).toEqual({ code: 0, err: "" })
  expect(probe.stderr.toString()).toBe("")
  expect(JSON.parse(probe.stdout.toString())).toEqual([])
})

test("symlink targets are left alone and symlink descendants never remove external contents", async () => {
  const h = fixture()
  const outside = path.join(h.root, "outside")
  mkdirSync(outside)
  writeFileSync(path.join(outside, "keep"), "outside unchanged")
  symlinkSync(outside, path.join(h.dir, "blobs", "external"))
  symlinkSync(outside, path.join(h.dir, "mcp.json"))
  expect(await runUninstallCommand(h.command("--force"), h.deps)).toBe(1)
  expect(lstatSync(path.join(h.dir, "mcp.json")).isSymbolicLink()).toBe(true)
  expect(readFileSync(path.join(outside, "keep"), "utf8")).toBe("outside unchanged")
})

test("production entrypoint dispatches uninstall/help/errors before startup and rejects remote attach", async () => {
  const h = fixture()
  const entry = path.join(import.meta.dir, "../src/entry.ts")
  for (const [args, code] of [[['uninstall', '--help'], 0], [['help', 'uninstall'], 0], [['uninstall', '--dry-run', '--json'], 0], [['uninstall', '--unknown'], 64], [['uninstall', '--socket', path.join(h.root, 'missing.sock')], 64]] as const) {
    const child = Bun.spawn([process.execPath, entry, "--dir", h.dir, ...args], { env: { ...process.env, HOME: h.home, MENDCODE_V2_DIR: h.dir }, stdout: "pipe", stderr: "pipe" })
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(exit).toBe(code)
    expect(out + err).not.toContain("fixture-secret")
    expect(existsSync(path.join(h.dir, "mendd.sock"))).toBe(false)
    expect(existsSync(path.join(h.dir, "mendd.lock"))).toBe(false)
  }
})

for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) test(`uninstall review uses real targets, safe defaults and scrolls without overflow at ${width}x${height}`, () => {
  const h = fixture(), ui = h.ui(width!, height!)
  expect(ui.frames[0]).toHaveLength(height!)
  expect(ui.frames[0]!.every((row) => textWidth(row.map((span) => span.text).join("")) === width)).toBe(true)
  expect(ui.frames[0]!.flat().some((span) => span.text.includes("fixture-secret"))).toBe(false)
  ui.app.key("\x1b[6~")
  expect(ui.frames.length).toBe(2)
  ui.app.key("\r")
  ui.app.key("y")
  expect(ui.finishes).toEqual([false])
  const confirmed = h.ui(width!, height!)
  confirmed.app.key("y")
  expect(confirmed.finishes).toEqual([true])
  const dry = h.ui(width!, height!, ["--dry-run"])
  dry.app.key("y")
  expect(dry.finishes).toEqual([])
  dry.app.key("\x1b")
  expect(dry.finishes).toEqual([false])
})
