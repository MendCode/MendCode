import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { listProfileBackups, profileBackups, profileFile, recoverProfile, restoreProfile, retainedHistory, updateProfile } from "@mendcode/program/profile-history"
import { normalizeTuiProfile, readTuiProfile, writeTuiProfile } from "../src/view/tui-profile"
import { runProfileRestore } from "../src/profile-restore"
import { createTuiControl } from "../../../packages/daemon/src/tui-control"
import { appHarness } from "./extensions-harness"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture(raw: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), "profile-safety-")); dirs.push(dir)
  const file = profileFile(dir)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(raw))
  return { dir, file, raw: () => JSON.parse(readFileSync(file, "utf8")) }
}
test("older normalizer round trip keeps unknown keys, future values and nested data", () => {
  const box = fixture({ future: { nested: [1, "x"] }, density: "future-density", showTopbar: false })
  expect(writeTuiProfile(box.dir, normalizeTuiProfile(box.raw()))).toEqual({ ok: true })
  expect(box.raw()).toMatchObject({ future: { nested: [1, "x"] }, density: "future-density", showTopbar: false })
  expect(readTuiProfile(box.dir).density).toBe("comfortable")
  expect(writeTuiProfile(box.dir, { ...readTuiProfile(box.dir), density: "compact" }, ["density"])).toEqual({ ok: true })
  expect(box.raw().density).toBe("compact")
})
test("daemon patch preserves unknown and unparseable values", () => {
  const box = fixture({ future: 7, density: "future-density", theme: "old" })
  createTuiControl(box.dir).run({ operation: "apply", profile: { theme: "new" } })
  expect(box.raw()).toMatchObject({ future: 7, density: "future-density", theme: "new" })
  expect(listProfileBackups(box.file)).toHaveLength(1)
})

test("stale proposals apply only proposed keys and rollback dry-run is read-only", () => {
  const box = fixture({ future: 7, density: "future-density", theme: "old" })
  const control = createTuiControl(box.dir)
  const proposal = control.run({ operation: "propose", profile: { theme: "new" } })
  updateProfile(box.file, (raw) => ({ ...raw, future: 8 }))
  const applied = control.run({ operation: "apply", argument: proposal.proposalId })
  expect(box.raw()).toEqual({ future: 8, density: "future-density", theme: "new" })
  const preview = control.run({ operation: "rollback", argument: applied.backupId, dryRun: true })
  expect(preview.profile.theme).toBe("old")
  expect(box.raw().theme).toBe("new")
})

test("unsafe or altered backups and concurrent writer locks fail without replacing data", () => {
  const box = fixture({ theme: "old" })
  updateProfile(box.file, (raw) => ({ ...raw, theme: "new" }))
  const row = profileBackups(box.file)[0]!
  writeFileSync(row.file, '{"theme":"tampered"}')
  expect(() => restoreProfile(box.file, row.id)).toThrow("checksum")
  expect(box.raw().theme).toBe("new")
  rmSync(row.file)
  symlinkSync(box.file, row.file)
  expect(() => restoreProfile(box.file, row.id)).toThrow("Unsafe")
  mkdirSync(`${box.file}.lock`)
  expect(() => updateProfile(box.file, () => ({}))).toThrow("retry")
  expect(box.raw().theme).toBe("new")
})
test("startup captures hand edits, restores only missing keys and offers a durable undo", () => {
  const box = fixture({ future: 7, showTopbar: false, theme: "old" })
  expect(recoverProfile(box.file).restored).toBe(0)
  const count = readdirSync(path.join(box.dir, "tui/backups")).length
  expect(recoverProfile(box.file).restored).toBe(0)
  expect(readdirSync(path.join(box.dir, "tui/backups"))).toHaveLength(count)
  writeFileSync(box.file, JSON.stringify({ theme: "new" }))
  const result = recoverProfile(box.file)
  expect(result.restored).toBe(2)
  expect(box.raw()).toEqual({ future: 7, showTopbar: false, theme: "new" })
  restoreProfile(box.file, result.backupId!)
  expect(box.raw()).toEqual({ theme: "new" })
  expect(recoverProfile(box.file).restored).toBe(0)
})
test("history is bounded, retains daily snapshots and is private", () => {
  const box = fixture({ n: 0 })
  for (let n = 1; n <= 90; n++) updateProfile(box.file, (raw) => ({ ...raw, n }))
  expect(listProfileBackups(box.file)).toHaveLength(30)
  expect(statSync(box.file).mode & 0o777).toBe(0o600)
  expect(statSync(path.join(box.dir, "tui/backups")).mode & 0o777).toBe(0o700)
  const now = Date.now()
  const rows = Array.from({ length: 100 }, (_, n) => ({ at: now - n * 86400000 / 2 }))
  const kept = retainedHistory(rows, now)
  expect(kept.size).toBeGreaterThan(30)
  expect(kept.size).toBeLessThanOrEqual(60)
  for (const row of rows.slice(0, 30)) expect(kept.has(row)).toBe(true)
})
test("restore listing counts differences and restore snapshots first; damaged JSON is not overwritten", () => {
  const box = fixture({ theme: "old" })
  updateProfile(box.file, (raw) => ({ ...raw, theme: "new" }))
  const row = listProfileBackups(box.file)[0]!
  expect(row.differences).toBe(1)
  expect(runProfileRestore(box.dir, []).text).toContain("1 settings differ")
  expect(runProfileRestore(box.dir, [row.id]).restored).toBe(true)
  expect(box.raw().theme).toBe("old")
  expect(() => restoreProfile(box.file, "../../outside")).toThrow("Unknown")
  writeFileSync(box.file, "{broken")
  expect(writeTuiProfile(box.dir, normalizeTuiProfile({})).ok).toBe(false)
  expect(readFileSync(box.file, "utf8")).toBe("{broken")
  restoreProfile(box.file, row.id)
  expect(box.raw().theme).toBe("old")
  expect(listProfileBackups(box.file).some((item) => !item.valid)).toBe(true)
})
test("headless profile restore lists without a daemon or terminal", () => {
  const box = fixture({ theme: "old" })
  updateProfile(box.file, (raw) => ({ ...raw, theme: "new" }))
  const result = Bun.spawnSync([process.execPath, "apps/cli/src/main.ts", "profile", "restore", "--dir", box.dir], { cwd: path.resolve(import.meta.dir, "../../.."), env: { PATH: process.env.PATH, HOME: box.dir, MENDCODE_V2_DIR: box.dir }, stdout: "pipe", stderr: "pipe" })
  expect({ code: result.exitCode, error: result.stderr.toString() }).toEqual({ code: 0, error: "" })
  expect(result.stdout.toString()).toContain("1 settings differ")
})

test("minimalist terminal restores missing settings and /customize restore lists and restores", async () => {
  const box = fixture({ theme: "mend", showTopbar: false })
  recoverProfile(box.file)
  writeFileSync(box.file, JSON.stringify({ theme: "mend" }))
  const h = await appHarness({ dataDir: box.dir, width: 150, height: 35 })
  await h.start({ tier: "minimalist", onboarded: true })
  await h.app.start()
  h.app.render()
  expect(box.raw().showTopbar).toBe(false)
  expect(h.text()).toContain("Restored 1 settings")
  await h.type("/customize restore"); await h.key("\r")
  expect(h.text()).toContain("settings differ")
  const id = listProfileBackups(box.file).find((row) => row.differences === 1)!.id
  await h.type(`/customize restore ${id}`); await h.key("\r")
  expect(box.raw().showTopbar).toBeUndefined()
  expect(h.text()).toContain("Profile restored")
})
