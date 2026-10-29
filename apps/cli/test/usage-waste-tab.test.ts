import { describe, expect, test } from "bun:test"
import type { UsageReport, UsageWasteReport, WasteWindow } from "@mendcode/protocol"
import { createUsagePageState, renderUsagePage, usagePageKey, usageWasteAction, usageWasteOpen } from "../src/view/usage-page"
import { wasteText } from "../src/view/usage-waste-text"
import { lineWidth } from "../src/view/deck"

const TODAY = "2026-10-18"
const side = (extra: Partial<WasteWindow> = {}): WasteWindow => ({ from: 0, to: 1, days: 6, turns: 40, calls: 90, promptPerTurn: 300_000, uncachedPerTurn: 20_000, over200k: 0.4, compactionsPerDay: 0.2, waitMsPerDay: 20_000, ...extra })

const waste: UsageWasteReport = {
  from: "2026-09-19", to: TODAY, scope: { kind: "global" }, calls: 3_472, turns: 845, sessions: 137, priced: { billed: 0, list: 373 },
  split: { reread: 1_994_295_083, written: 24_334_728, fresh: 19_377_342, output: 10_865_906 },
  splitMicros: { reread: 344_574_242, written: 120_722_980, fresh: 997_220, output: 191_788_485 },
  bands: [{ min: 0, max: 50_000, calls: 922, prompt: 20_603_437 }, { min: 50_000, max: 100_000, calls: 969, prompt: 74_172_964 }, { min: 100_000, max: 200_000, calls: 1_269, prompt: 178_113_808 }, { min: 200_000, calls: 312, prompt: 93_371_674 }],
  cold: { count: 60, sessions: 19, resent: 8_751_729, micros: 38_240_917, warmMicros: 1_529_673, priced: 46, worst: [{ sessionId: "s1", title: "Rediseñar Dreamroll con Opus", at: 1, gapMs: 93_305_105, tokens: 380_243 }] },
  breaks: { count: 23, sessions: 9, resent: 2_093_149 },
  switches: { count: 2, resent: 121_369 },
  compactions: { auto: 0, manual: 2, idle: 16, failed: 5, waitMs: 1_990_966 },
  topBy: "prompt",
  top: [{ sessionId: "s2", title: "Voladuras y terremotos en Balboa", calls: 79, turns: 79, prompt: 19_597_393, costMicros: 233_158_303, cold: 15, peak: 416_741, lastAt: 1 }],
  findings: [
    { id: "prompt_cache", certainty: "likely", title: "Smart prompt-cache keys", detail: "23 calls missed a cache that was still warm and sent 2.1M again.", tokens: 2_093_149, fix: { label: "promptCache smart", patch: { promptCache: "smart" } } },
    { id: "model_switch", certainty: "clear", title: "Switch models at the start, not mid-session", detail: "3 model switches sent 400K again.", tokens: 400_000 },
  ],
  changes: [{ at: Date.UTC(2026, 9, 12), keys: ["compactAtTokens"], label: "compactAtTokens 475K → 200K", before: side(), after: side({ promptPerTurn: 150_000, over200k: 0, compactionsPerDay: 3 }), revert: { compactAtTokens: 475_000 } }],
}
const report = { from: "2025-10-19", to: TODAY, days: [], models: [], quotas: [] } as unknown as UsageReport
const text = (rows: ReturnType<typeof renderUsagePage>) => rows.map((row) => row.map((span) => span.text).join(""))

describe("the Waste tab", () => {
  test("7 opens it; the arrows move between the actions in the order shown, and Enter applies a fix or puts a change back", () => {
    let state = usagePageKey(createUsagePageState(TODAY), "7", TODAY, report, waste)
    expect(usageWasteOpen(state)).toBe(true)
    expect(usageWasteAction(state, waste)).toMatchObject({ kind: "apply", patch: { promptCache: "smart" } })
    state = usagePageKey(state, "\x1b[B", TODAY, report, waste)
    expect(usageWasteAction(state, waste)).toMatchObject({ kind: "undo", patch: { compactAtTokens: 475_000 } })
    // The habit without a setting is not an action: two actions, the second is the last.
    expect(usagePageKey(state, "\x1b[B", TODAY, report, waste)).toBe(state)
    expect(usageWasteAction(createUsagePageState(TODAY), waste)).toBeUndefined()
  })

  test("the selected action is marked and kept on screen, every row fits the width, and a narrow terminal still draws it", () => {
    for (const [width, height] of [[120, 40], [72, 30], [56, 24]] as const) {
      let state = usagePageKey(createUsagePageState(TODAY), "7", TODAY, report, waste)
      state = usagePageKey(state, "\x1b[B", TODAY, report, waste)
      const rows = renderUsagePage({ report, state, today: TODAY, width, height, now: Date.UTC(2026, 9, 18), waste })
      for (const row of rows) expect(lineWidth(row)).toBeLessThanOrEqual(width)
      const shown = text(rows).join("\n")
      expect(shown).toContain("› ")
      expect(shown).toContain("compactAtTokens 475K → 200K")
    }
  })

  test("before the report arrives it says so, and a failed ask says how to retry", () => {
    const state = usagePageKey(createUsagePageState(TODAY), "7", TODAY, report)
    expect(text(renderUsagePage({ report, state, today: TODAY, width: 100, height: 20, now: 0 })).join("\n")).toContain("Reading the calls of this range")
    expect(text(renderUsagePage({ report, state, today: TODAY, width: 100, height: 20, now: 0, wasteLoading: false })).join("\n")).toContain("R tries again")
  })
})

describe("mendcode stats --waste", () => {
  test("prints the same panels without selection marks, with the money only of the priced calls and the honest ranking", () => {
    const out = wasteText(waste)
    expect(out).not.toContain("› ")
    expect(out).not.toContain("enter ")
    expect(out).toContain("fix: promptCache smart")
    expect(out).toContain("[likely] Smart prompt-cache keys")
    expect(out).toContain("The 46 on a priced model cost $38.24")
    expect(out).toContain("Largest conversations")
    expect(out).toContain("All calls, in tokens: re-read 2B")
    for (const line of out.trimEnd().split("\n")) expect([...line].length).toBeLessThanOrEqual(92)
  })
})
