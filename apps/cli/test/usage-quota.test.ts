import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { startDaemon } from "@mendcode/daemon"
import { createFauxEngine } from "@mendcode/engine-faux"
import { parseUsageQuota, runUsageQuota } from "../src/usage-quota"

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-quota-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const NOW = Date.UTC(2026, 10, 4, 12)

async function run(argv: string[], dataDir: string, now = NOW) {
  let out = ""
  let err = ""
  const code = await runUsageQuota(parseUsageQuota(argv)!, { dataDir, out: { write: (text) => void (out += text) }, err: { write: (text) => void (err += text) }, now: () => now })
  return { code, out, err }
}

describe("usage --quota", () => {
  test("only `usage --quota` is this command; a stray flag is a usage error", async () => {
    expect(parseUsageQuota(["usage", "--days", "7"])).toBeUndefined()
    expect(parseUsageQuota(["docs", "--quota"])).toBeUndefined()
    expect(parseUsageQuota(["usage", "--quota", "--json", "--dir", "/x"])).toEqual({ json: true, dir: "/x" })
    const bad = await run(["usage", "--quota", "--days", "3"], temp())
    expect(bad.code).toBe(64)
    expect(bad.err).toContain("--quota does not combine with --days")
  })

  test("without a daemon nothing is known, and none is started", async () => {
    const dataDir = temp()
    const json = await run(["usage", "--quota", "--json"], dataDir)
    expect(json.code).toBe(0)
    expect(JSON.parse(json.out)).toEqual({ now: NOW, daemon: false, quota: [] })
    expect((await run(["usage", "--quota"], dataDir)).out).toBe("quota: unknown (no daemon is running)\n")
    expect(readdirSync(dataDir)).toEqual([])
  })

  test("with a daemon: the footer's list of windows, fresh and stale, read from what the daemon already holds", async () => {
    const dataDir = temp()
    const daemon = await startDaemon({ dir: dataDir, socketPath: path.join(dataDir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    expect(JSON.parse((await run(["usage", "--quota", "--json"], dataDir)).out)).toMatchObject({ daemon: true, quota: [] })
    expect((await run(["usage", "--quota"], dataDir)).out).toBe("quota: no provider has reported a window yet\n")

    daemon.store.globalSink.append({ type: "quota.snapshot", provider: "codex", windows: [{ id: "primary", label: "5h", usedPercent: 37.6, resetsAt: NOW + 2 * 3_600_000 }, { id: "secondary", label: "7d", usedPercent: 12, resetsAt: NOW + 3 * 86_400_000 }], fetchedAt: NOW - 60_000, source: "test" })
    daemon.store.globalSink.append({ type: "quota.snapshot", provider: "claude", windows: [{ id: "seven_day", label: "7d", usedPercent: 60 }], fetchedAt: NOW - 3 * 3_600_000, source: "test" })
    const { quota, daemon: running } = JSON.parse((await run(["usage", "--quota", "--json"], dataDir)).out) as { daemon: boolean; quota: Array<Record<string, unknown>> }
    expect(running).toBe(true)
    expect(quota).toEqual([
      { provider: "claude", window: "7d", usedPercent: 60, leftPercent: 40, observedAt: NOW - 3 * 3_600_000, ageMs: 3 * 3_600_000, stale: true },
      { provider: "codex", window: "5h", usedPercent: 38, leftPercent: 62, resetsAt: NOW + 2 * 3_600_000, observedAt: NOW - 60_000, ageMs: 60_000, stale: false },
      { provider: "codex", window: "7d", usedPercent: 12, leftPercent: 88, resetsAt: NOW + 3 * 86_400_000, observedAt: NOW - 60_000, ageMs: 60_000, stale: false },
    ])
    expect((await run(["usage", "--quota"], dataDir)).out).toBe([
      "claude 7d  40% left (60% used) · stale, seen 3h ago",
      "codex 5h  62% left (38% used) · resets in 2h · seen 1m ago",
      "codex 7d  88% left (12% used) · resets in 3d · seen 1m ago",
      "",
    ].join("\n"))
    expect(existsSync(path.join(dataDir, "mendd.sock"))).toBe(true)
  }, 60_000)
})

test("`docs usage` names the command and says it is read-only", async () => {
  const { findCard } = await import("../src/docs-run")
  const text = findCard("usage")!.text
  expect(text).toContain("{{program}} usage --quota [--json]")
  expect(text).toContain("read-only, sends nothing")
})
