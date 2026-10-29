import { describe, expect, test } from "bun:test"
import type { Settings } from "@mendcode/protocol"
import type { UsageCallRow, UsageCompactionRow } from "@mendcode/store"
import { analyzeWaste, type WasteInput } from "../src/usage-waste"

const MIN = 60_000
const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 18, 12)
const T0 = NOW - 20 * DAY
let seq = 0

/** A native main call holding `prompt` tokens, `read` of them from the cache. */
function call(at: number, prompt: number, read: number, extra: Partial<UsageCallRow> = {}): UsageCallRow {
  seq++
  return { sessionId: "s1", seq, at, turnId: `t${seq}`, provider: "anthropic", model: "opus", input: prompt - read, output: 500, reasoning: 0, cacheRead: read, cacheWrite: 0, costMicros: null, context: null, compactAt: 400_000, ttl: null, durationMs: null, ...extra }
}

function input(calls: UsageCallRow[], extra: Partial<WasteInput> = {}): WasteInput {
  return {
    from: "2026-09-01", to: "2026-10-18", scope: { kind: "global" }, now: NOW, calls, compactions: [], recentCalls: calls, recentCompactions: [],
    history: [], settings: {} as Settings, titles: (ids) => new Map(ids.map((id) => [id, `title ${id}`])),
    price: () => undefined, providerType: () => "anthropic", feature: () => false, ...extra,
  }
}

describe("misses, measured from what the provider reported", () => {
  test("a pause past the cache's lifetime whose read collapsed is a cold return; the same collapse a minute later is a break", () => {
    const calls = [
      call(T0, 150_000, 0),
      call(T0 + MIN, 152_000, 150_000),
      // Ten minutes later the cache is gone: 152K sent again.
      call(T0 + 11 * MIN, 154_000, 0),
      // A minute later it missed again: the start of the prompt changed.
      call(T0 + 12 * MIN, 156_000, 1_000),
      call(T0 + 13 * MIN, 158_000, 156_000),
    ]
    const report = analyzeWaste(input(calls))
    expect(report.cold).toMatchObject({ count: 1, sessions: 1, resent: 152_000 })
    expect(report.cold.worst[0]).toMatchObject({ sessionId: "s1", title: "title s1", gapMs: 10 * MIN, tokens: 152_000 })
    expect(report.breaks).toEqual({ count: 1, sessions: 1, resent: 154_000 })
    expect(report.top[0]).toMatchObject({ sessionId: "s1", calls: 5, cold: 1, peak: 158_000 })
  })

  test("a compaction between two calls, a small context or an hour's cache within its hour is not waste", () => {
    const calls = [
      call(T0, 150_000, 0),
      call(T0 + 30 * MIN, 151_000, 0),
      call(T0 + 31 * MIN, 10_000, 0),
      call(T0 + 50 * MIN, 12_000, 0),
      call(T0 + 51 * MIN, 120_000, 100_000, { ttl: "1h" }),
      // 40 minutes after an hour's write: a miss, but not an expiry, so a break.
      call(T0 + 91 * MIN, 121_000, 0),
    ]
    const compactions: UsageCompactionRow[] = [{ sessionId: "s1", seq: 99, at: T0 + 20 * MIN, reason: "auto", state: "packed", waitMs: 30_000 }]
    const report = analyzeWaste(input(calls, { compactions }))
    expect(report.cold.count).toBe(0)
    expect(report.breaks.count).toBe(1)
    expect(report.compactions).toEqual({ auto: 1, manual: 0, idle: 0, failed: 0, waitMs: 30_000 })
  })

  test("another model after a long context is a switch; an external engine's turn counts as cold only by what it wrote again", () => {
    const calls = [
      call(T0, 150_000, 0),
      call(T0 + MIN, 151_000, 0, { model: "sonnet" }),
      call(T0 + 2 * MIN, 0, 0, { sessionId: "s2", provider: "claude", context: 200_000, cacheRead: 900_000, cacheWrite: 1_000, input: 10, compactAt: null }),
      // Claude Code reports a turn's sums: the large reads of its later calls do not hide that it wrote the context again.
      call(T0 + 70 * MIN, 0, 0, { sessionId: "s2", provider: "claude", context: 201_000, cacheRead: 600_000, cacheWrite: 190_000, input: 10, compactAt: null }),
    ]
    const report = analyzeWaste(input(calls))
    expect(report.switches).toEqual({ count: 1, resent: 150_000 })
    expect(report.cold).toMatchObject({ count: 1, resent: 190_010 })
    expect(report.breaks.count).toBe(0)
  })
})

describe("money only where a price is known", () => {
  test("a cold return is priced at what was written again against a warm read; an hour's write costs twice the input", () => {
    const calls = [call(T0, 100_000, 0, { ttl: "1h" }), call(T0 + 2 * 60 * MIN, 100_000, 0, { cacheWrite: 100_000, input: 0, ttl: "1h" })]
    const report = analyzeWaste(input(calls, { price: () => ({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }) }))
    expect(report.cold).toMatchObject({ count: 1, resent: 100_000, micros: 1_000_000, warmMicros: 50_000 })
    expect(report.priced).toEqual({ billed: 0, list: 2 })
    expect(report.splitMicros).toEqual({ reread: 0, written: 1_000_000, fresh: 500_000, output: 25_000 })
    expect(analyzeWaste(input(calls)).cold.micros).toBeUndefined()
  })
})

describe("findings", () => {
  const coldTwice = [call(T0, 150_000, 0), call(T0 + 10 * MIN, 151_000, 0), call(T0 + 30 * MIN, 152_000, 0)]

  test("cold returns of large native sessions suggest the idle compaction, as a patch that keeps the other features", () => {
    const report = analyzeWaste(input(coldTwice, { settings: { features: { computer: true } } as Settings }))
    const idle = report.findings.find((finding) => finding.id === "idle_compact")
    expect(idle).toMatchObject({ certainty: "likely", tokens: 301_000, fix: { patch: { features: { computer: true, idle_compact: true } } } })
    expect(report.findings.find((finding) => finding.id === "wait_cache")).toMatchObject({ fix: { patch: { features: { computer: true, wait_cache: true } } } })
    // Already on: nothing to suggest.
    expect(analyzeWaste(input(coldTwice, { feature: () => true })).findings).toEqual([])
  })

  test("a quarter of the calls past 200K suggests compacting there, as an upper bound to test", () => {
    const calls = Array.from({ length: 20 }, (_, index) => call(T0 + index * MIN, index < 5 ? 260_000 : 120_000, index < 5 ? 259_000 : 119_000))
    const finding = analyzeWaste(input(calls)).findings.find((entry) => entry.id === "compact_earlier")
    expect(finding).toMatchObject({ certainty: "test", tokens: 5 * 60_000, fix: { patch: { compactAtTokens: 200_000 } } })
    expect(analyzeWaste(input(calls, { settings: { compactAtTokens: 200_000 } as Settings })).findings.find((entry) => entry.id === "compact_earlier")).toBeUndefined()
  })
})

describe("changes", () => {
  test("a change is measured against the days before it, a quick back-and-forth folds away, and the revert restores the old value", () => {
    const at = NOW - 5 * DAY
    const history = [
      { at: NOW - 30 * DAY, settings: { theme: "a" } },
      // Tried and set back within minutes: no change.
      { at: NOW - 10 * DAY, settings: { theme: "a", promptCache: "smart" } },
      { at: NOW - 10 * DAY + 2 * MIN, settings: { theme: "a" } },
      { at, settings: { theme: "b", compactAtTokens: 200_000, features: { idle_compact: true, panel: true } } },
    ]
    const calls = [
      ...Array.from({ length: 12 }, (_, index) => call(at - 4 * DAY + index * 60 * MIN, 300_000, 290_000)),
      ...Array.from({ length: 12 }, (_, index) => call(at + DAY + index * 60 * MIN, 150_000, 140_000)),
    ]
    const report = analyzeWaste(input(calls, { history, settings: { compactAtTokens: 200_000, features: { idle_compact: true, panel: true } } as Settings }))
    // Saved together: one comparison and one revert for both. The chrome-only panel feature is not a cost setting.
    expect(report.changes).toHaveLength(1)
    const change = report.changes[0]!
    expect(change.keys.sort()).toEqual(["compactAtTokens", "features.idle_compact"])
    expect(change.label).toContain("compactAtTokens default → 200K")
    expect(change.label).toContain("features.idle_compact default → on")
    expect(change.early).toBeUndefined()
    expect(change.before).toMatchObject({ turns: 12, promptPerTurn: 300_000, uncachedPerTurn: 10_000, over200k: 1 })
    expect(change.after).toMatchObject({ turns: 12, promptPerTurn: 150_000, over200k: 0 })
    expect(change.revert).toEqual({ compactAtTokens: null, features: { panel: true } })
    // Changed again since: there is nothing of it left to put back.
    expect(analyzeWaste(input(calls, { history, settings: { compactAtTokens: 300_000 } as Settings })).changes[0]!.revert).toBeUndefined()
  })
})
