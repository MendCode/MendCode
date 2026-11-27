import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseAutomation } from "../src/automation"
import { runSyncAutomation, type SyncAutomation } from "../src/sync-automation"

const command = (argv: string[]) => {
  const parsed = parseAutomation(argv)
  if (parsed.ok !== true) throw new Error(`not parsed: ${JSON.stringify(parsed)}`)
  return parsed.command as unknown as SyncAutomation
}

test("sync parity and remote parity are the same command, and the flags it takes are checked", () => {
  const plain = command(["sync", "parity"])
  expect(plain).toMatchObject({ kind: "sync", action: "parity", apply: false, allowFlagged: [], allowCode: false })
  expect(plain.remote).toBeUndefined()
  expect(command(["remote", "parity", "vps", "--apply", "--code", "--allow-flagged", "packages/a", "--allow-flagged", "packages/b"])).toMatchObject({ kind: "sync", action: "parity", remote: "vps", apply: true, allowCode: true, allowFlagged: ["packages/a", "packages/b"] })
  for (const argv of [["sync", "parity", "--code"], ["sync", "parity", "--allow-flagged", "x"], ["sync", "parity", "bad name"], ["sync", "status", "--apply"], ["sync", "now", "--follow"], ["sync", "follow"], ["sync", "follow", "maybe"]]) expect([argv, parseAutomation(argv).ok]).toEqual([argv, false])
  expect(command(["sync", "enable", "vps", "--follow"])).toMatchObject({ action: "enable", remote: "vps", follow: true })
  expect(command(["sync", "enable", "vps"])).toMatchObject({ follow: false })
  expect(command(["sync", "follow", "on"])).toMatchObject({ action: "follow", follow: true })
  expect(parseAutomation(["remote", "parity", "--help"])).toMatchObject({ ok: true, command: { kind: "help", topic: "sync" } })
  expect(parseAutomation(["remote", "list"])).toEqual({ ok: "none" })
})

const rows = [
  { kind: "skill", item: "skills/alpha", state: "same" },
  { kind: "profile", item: "autopilot@0.1.0", state: "code", note: "runs tools: add --code to send it" },
  { kind: "mcp", item: "docs", state: "missing", note: "arrives pending there" },
  { kind: "tool", item: "graft 0.18.0", state: "no-tool", note: "not installed there; parity does not install tools" },
]
function harness(reply: Record<string, unknown>, dataDir = "/nonexistent") {
  const sent: Array<Record<string, unknown>> = []
  const out: string[] = []
  const ctx = {
    dataDir,
    request: async (input: Record<string, unknown>) => { sent.push(input); return { ok: true as const, result: reply } },
    result: (_data: Record<string, unknown>, human: string) => { out.push(human); return 0 },
    fail: (message: string) => { out.push(`error: ${message}`); return 1 },
  }
  return { ctx, sent, out }
}

test("the comparison names every row that is not level, then what stays level, and offers the way to apply", async () => {
  const { ctx, sent, out } = harness({ remote: "vps", applied: false, before: rows, counts: { same: 1, code: 1, missing: 1, "no-tool": 1 }, versions: { here: "1.2.3", there: "1.2.3" } })
  expect(await runSyncAutomation({ kind: "sync", action: "parity", remote: "vps", apply: false, allowFlagged: [], allowCode: false } as SyncAutomation, ctx as never)).toBe(0)
  expect(sent).toEqual([{ type: "config.parity", input: { op: "run", remote: "vps" } }])
  const text = out.join("")
  expect(text).toContain("Parity with vps")
  expect(text).toContain("profile  autopilot@0.1.0  code, not sent  runs tools: add --code to send it")
  expect(text).toContain("mcp      docs  missing there  arrives pending there")
  expect(text).toContain("tool     graft 0.18.0  not installed there")
  expect(text).not.toContain("skills/alpha")
  expect(text).toContain("1 level")
  expect(text).toContain("mendcode sync parity --apply")
})

test("an applied run reports the import, what the hub blocked, the undo, and that MCP logins stay per machine", async () => {
  const { ctx, sent, out } = harness({ remote: "vps", applied: true, before: rows, after: [{ kind: "mcp", item: "docs", state: "same", note: "pending approval there" }], counts: { same: 1 }, import: { importId: "imp-1-abc123", summary: "all 1 items match", blocked: ["skills/x: link"], notes: [] } })
  await runSyncAutomation({ kind: "sync", action: "parity", apply: true, allowFlagged: ["packages/a"], allowCode: true } as SyncAutomation, ctx as never)
  expect(sent[0]).toEqual({ type: "config.parity", input: { op: "run", apply: true, allowFlagged: ["packages/a"], allowCode: true } })
  const text = out.join("")
  expect(text).toContain("applied on the hub: import imp-1-abc123")
  expect(text).toContain("blocked there: skills/x: link")
  expect(text).toContain("config-bundle rollback imp-1-abc123")
  expect(text).toContain("approve them in /mcp on the hub")
})

test("follow on and off change only the follow key of sync.json and reload sync", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-follow-"))
  try {
    const file = path.join(dir, "sync.json")
    writeFileSync(file, JSON.stringify({ remote: "vps", tokenFile: path.join(dir, "t"), pathMap: [], memories: true, settings: false }), { mode: 0o600 })
    const { ctx, sent, out } = harness({ mode: "device" }, dir)
    await runSyncAutomation({ kind: "sync", action: "follow", follow: true } as SyncAutomation, ctx as never)
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ remote: "vps", settings: false, follow: true })
    expect(sent).toEqual([{ type: "sync.control", input: { action: "reload" } }])
    expect(out.join("")).toContain("never sent this way")
    await runSyncAutomation({ kind: "sync", action: "follow", follow: false } as SyncAutomation, ctx as never)
    expect(JSON.parse(readFileSync(file, "utf8")).follow).toBeUndefined()
    const off = harness({}, path.join(dir, "none"))
    expect(await runSyncAutomation({ kind: "sync", action: "follow", follow: true } as SyncAutomation, off.ctx as never)).toBe(1)
    expect(off.out.join("")).toContain("sync is off on this machine")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
