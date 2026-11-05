import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SessionId } from "@mendcode/protocol"
import { createHostMcp } from "../src/host-mcp"
import { hostMcpPrefix, sweepHostMcpDirs } from "../src/host-mcp-sweep"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const scratch = () => {
  const root = mkdtempSync(path.join(tmpdir(), "host-mcp-sweep-"))
  roots.push(root)
  return root
}
const make = (root: string, name: string, ageDays = 0) => {
  const dir = path.join(root, name)
  mkdirSync(dir)
  writeFileSync(path.join(dir, "mcp.json"), "{}")
  const when = new Date(Date.now() - ageDays * 86_400_000)
  utimesSync(path.join(dir, "mcp.json"), when, when)
  utimesSync(dir, when, when)
  return dir
}
/** A process id that was running a moment ago and is not any more. */
const deadPid = () => {
  const child = Bun.spawnSync([process.execPath, "-e", "1"])
  return (child as unknown as { pid?: number }).pid ?? 2_147_000_000
}

test("the sweep removes the directories of daemons that are gone and nothing else", async () => {
  const root = scratch()
  const gone = deadPid()
  const orphan = make(root, `mendcode-host-mcp-${gone}-abc123`)
  const mine = make(root, `${hostMcpPrefix()}abc123`)
  const legacyOld = make(root, "mendcode-host-mcp-Ab12Cd", 3)
  const legacyFresh = make(root, "mendcode-host-mcp-Zz99Yy", 0)
  const unrelated = make(root, "mendcode-mcp-other", 9)
  const lookalike = make(root, "not-mendcode-host-mcp-1", 9)
  const target = make(root, "target-dir", 9)
  symlinkSync(target, path.join(root, `mendcode-host-mcp-${gone}-link`))
  writeFileSync(path.join(root, `mendcode-host-mcp-${gone}-file`), "x")

  expect(await sweepHostMcpDirs({ root })).toBe(2)
  expect([orphan, legacyOld].map(existsSync)).toEqual([false, false])
  expect([mine, legacyFresh, unrelated, lookalike, target].map(existsSync)).toEqual([true, true, true, true, true])
  expect(existsSync(path.join(root, `mendcode-host-mcp-${gone}-file`))).toBe(true)
  expect(existsSync(path.join(root, `mendcode-host-mcp-${gone}-link`))).toBe(true)
})

test("a sweep removes at most its limit and the next one takes the rest", async () => {
  const root = scratch()
  const pid = deadPid()
  for (let at = 0; at < 60; at++) make(root, `mendcode-host-mcp-${pid}-${String(at).padStart(6, "0")}`)
  expect(await sweepHostMcpDirs({ root, limit: 30 })).toBeLessThan(60)
  expect(await sweepHostMcpDirs({ root, limit: 30 })).toBeGreaterThan(0)
  expect(await sweepHostMcpDirs({ root })).toBeGreaterThanOrEqual(0)
  expect(await sweepHostMcpDirs({ root })).toBe(0)
})

test("a directory the sweep finds in a missing root is not an error", async () => {
  expect(await sweepHostMcpDirs({ root: path.join(scratch(), "missing") })).toBe(0)
})

test("the bridge writes its config under its own process id and removes the directory when it stops", () => {
  const host = createHostMcp({
    enabled: () => true,
    directory: () => "/project",
    tools: async () => [],
    call: async () => ({ output: "", isError: false }),
    listen: () => ({ url: "http://127.0.0.1:1/mcp", stop() {} }),
  })
  const file = host.args("ses_sweep" as SessionId)[1]!
  expect(path.basename(path.dirname(file)).startsWith(hostMcpPrefix())).toBe(true)
  expect(existsSync(file)).toBe(true)
  host.stop()
  expect(existsSync(path.dirname(file))).toBe(false)
})
