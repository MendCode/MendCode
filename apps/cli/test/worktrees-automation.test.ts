import { expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { StorageCleanResult, StorageWorktreesReport } from "@mendcode/protocol"
import { helpText, parseAutomation, runAutomation, type AutomationDeps } from "../src/automation"
import { worktreesListText, worktreesSizeText } from "../src/worktrees-automation"

const GB = 1024 ** 3
const report: StorageWorktreesReport = {
  worktrees: [
    { directory: "/data/compound-worktrees/run1", kind: "compound", branch: null, bytes: 2 * GB, state: "merged", clean: true, idleDays: 20, occupied: false, removable: true },
    { directory: "/data/loop-worktrees/l-r1", kind: "loop", branch: "loop/x-r1", bytes: GB, state: "unmerged", clean: true, idleDays: 20, occupied: false, removable: false, keep: "branch has commits that are not merged" },
    { directory: "/work/other", kind: "external", branch: "feat/y", bytes: 1024, state: "merged", clean: false, idleDays: 3, occupied: false, removable: false, keep: "uncommitted or untracked changes" },
  ],
  totalBytes: 3 * GB + 1024, removableBytes: 2 * GB, trashBytes: 0, loopBytes: GB, capBytes: 2 * GB, managedBytes: 3 * GB,
  artifacts: [{ directory: "/data/compound-worktrees/run1", path: "dist", bytes: 5000, kind: "directory" }], artifactBytes: 5000,
}
const cleaned: StorageCleanResult = { dryRun: true, olderThanDays: 0, sessionsRemoved: 0, eventsRemoved: 0, blobsRemoved: 0, bytesReclaimed: 0, protectedSessions: 0, vacuumed: false, worktreesRemoved: 1, worktreeBytes: 2 * GB }
const parsed = (args: string[]) => { const result = parseAutomation(args); if (result.ok !== true) throw new Error(JSON.stringify(result)); return result.command }
function harness() {
  const sent: CommandInput[] = [], out: string[] = []
  const reply = (command: CommandInput): CommandReply => ({ ok: true, result: (command.type === "storage.clean" ? cleaned : report) as never })
  const deps: AutomationDeps = { client: { send: async (command) => { sent.push(command); return reply(command) }, subscribe: async () => ({ ok: true }) }, cwd: "/work/repo", now: () => 0, listen: () => {}, onInterrupt: () => {}, out: { write: (text) => out.push(text) }, err: { write: () => {} } }
  return { sent, out, run: (args: string[]) => runAutomation(parsed(args), deps) }
}

test("worktrees parses list, size and gc with their options and refuses the rest", () => {
  expect(parsed(["worktrees"])).toMatchObject({ kind: "worktrees", action: "list", yes: false, artifacts: false })
  expect(parsed(["worktrees", "gc", "--yes", "--idle", "7d", "--json"])).toMatchObject({ action: "gc", yes: true, idleDays: 7, json: true })
  expect(parsed(["worktrees", "gc", "--artifacts"])).toMatchObject({ action: "gc", artifacts: true, yes: false })
  expect(parsed(["worktrees", "--help"])).toMatchObject({ kind: "help", topic: "worktrees" })
  for (const args of [["worktrees", "rm"], ["worktrees", "list", "--yes"], ["worktrees", "gc", "--idle", "soon"], ["worktrees", "gc", "--yes", "--dry-run"], ["worktrees", "gc", "--force"]]) expect(parseAutomation(args).ok).toBe(false)
  expect(helpText("worktrees")).toContain("gc")
})

test("list and size ask the daemon for the external worktrees too, and say why each one is kept", async () => {
  const h = harness()
  expect(await h.run(["worktrees", "list"])).toBe(0)
  expect(h.sent).toEqual([{ type: "storage.worktrees", external: true, measure: "cached" }])
  const text = h.out.join("")
  expect(text).toBe(worktreesListText(report))
  expect(text).toContain("kept: branch has commits that are not merged")
  expect(text).toContain("external")
  const size = harness()
  expect(await size.run(["worktrees", "size", "--idle", "3d"])).toBe(0)
  expect(size.sent).toEqual([{ type: "storage.worktrees", external: true, artifacts: true, measure: "full", idleDays: 3 }])
  expect(size.out.join("")).toContain(worktreesSizeText(report))
  expect(size.out.join("")).toContain("over the cap")
})

test("gc previews without --yes and removes with it, never touching sessions or the database", async () => {
  const dry = harness()
  expect(await dry.run(["worktrees", "gc"])).toBe(0)
  expect(dry.sent.at(-1)).toEqual({ type: "storage.clean", olderThanDays: 0, worktreesOnly: true, worktrees: true, external: true, dryRun: true })
  expect(dry.out.join("")).toContain("would remove 1 worktrees/trash entries")
  expect(dry.out.join("")).toContain("--yes")
  const real = harness()
  expect(await real.run(["worktrees", "gc", "--yes", "--idle", "0d"])).toBe(0)
  expect(real.sent.at(-1)).toEqual({ type: "storage.clean", olderThanDays: 0, worktreesOnly: true, worktrees: true, external: true, worktreeIdleDays: 0 })
  const artifacts = harness()
  expect(await artifacts.run(["worktrees", "gc", "--artifacts"])).toBe(0)
  expect(artifacts.sent.at(-1)).toEqual({ type: "storage.clean", olderThanDays: 0, worktreesOnly: true, artifacts: true, dryRun: true })
  expect(artifacts.out.join("")).toContain("dist")
})
