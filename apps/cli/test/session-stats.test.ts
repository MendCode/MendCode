import { describe, expect, test } from "bun:test"
import { STAT_PART_IDS } from "@mendcode/protocol/wire"
import { SAMPLE_STATS, computeSessionStats, createStatsHub, sameStats, EMPTY_USAGE, type SessionStatsInput } from "../src/view/session-stats"
import { PART_BY_ID, STAT_PARTS, partSpans, partsLine, plain } from "../src/view/stat-parts"
import type { Line } from "../src/ui/theme"

const text = (line: Line) => line.map((span) => span.text).join("")

describe("computeSessionStats", () => {
  test("a session with no calls has counters and nothing derived", () => {
    const stats = computeSessionStats({ usage: EMPTY_USAGE })
    expect(stats).toEqual({ calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 })
    expect(Object.isFrozen(stats)).toBe(true)
  })

  test("cache share is read tokens over the whole prompt (uncached, read and written), per session and per last call", () => {
    const stats = computeSessionStats({
      usage: { calls: 4, input: 1_000, output: 500, reasoning: 100, cacheRead: 18_000, cacheWrite: 1_000 },
      last: { input: 100, cacheRead: 900, cacheWrite: 0 },
    })
    expect(stats.cachePercent).toBe(90)
    expect(stats).toMatchObject({ lastPrompt: 1_000, lastCacheRead: 900, lastCachePercent: 90 })
  })

  test("context share is measured against the limit and may pass 100; no limit means no context figures", () => {
    expect(computeSessionStats({ usage: EMPTY_USAGE, contextTokens: 21_000, contextLimit: 100_000 })).toMatchObject({ contextTokens: 21_000, contextLimit: 100_000, contextPercent: 21 })
    expect(computeSessionStats({ usage: EMPTY_USAGE, contextTokens: 130_000, contextLimit: 100_000 }).contextPercent).toBe(130)
    const without = computeSessionStats({ usage: EMPTY_USAGE, contextTokens: 5, contextLimit: 0 })
    expect(without.contextPercent).toBeUndefined()
    expect(without.contextApprox).toBeUndefined()
    expect(computeSessionStats({ usage: EMPTY_USAGE, contextTokens: 5, contextLimit: 10, contextApprox: true }).contextApprox).toBe(true)
  })

  test("speed and first-token time come from the last call that reported them; cost, model and effort pass through", () => {
    const stats = computeSessionStats({
      usage: { calls: 2, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      calls: [
        { at: 0, model: "m", output: 400, reasoning: 0, firstTokenMs: 800, durationMs: 8_800, toolCount: 1 },
        { at: 1, model: "m", output: 10, reasoning: 0, firstTokenMs: null, durationMs: undefined, toolCount: 1 },
      ],
      costMicros: 42_000, model: "gpt-6-luna", effort: "high", forecastTurns: 7,
    })
    expect(stats).toMatchObject({ firstTokenMs: 800, costMicros: 42_000, model: "gpt-6-luna", effort: "high", forecastTurns: 7 })
    expect(stats.tokensPerSecond).toBeGreaterThan(0)
  })

  test("the same input gives the same figures", () => {
    const source: SessionStatsInput = { usage: { calls: 1, input: 10, output: 2, reasoning: 0, cacheRead: 90, cacheWrite: 0 } }
    expect(sameStats(computeSessionStats(source), computeSessionStats(source))).toBe(true)
    expect(sameStats(computeSessionStats(source), computeSessionStats({ usage: { ...source.usage, cacheRead: 91 } }))).toBe(false)
  })
})

describe("createStatsHub", () => {
  const usage = (cacheRead: number) => ({ calls: 1, input: 10, output: 2, reasoning: 0, cacheRead, cacheWrite: 0 })

  test("read keeps the same object while nothing moved and a new one when a figure did", () => {
    let current = usage(90)
    const hub = createStatsHub(() => ({ usage: current }))
    const first = hub.read()
    expect(hub.read()).toBe(first)
    current = usage(95)
    const second = hub.read()
    expect(second).not.toBe(first)
    expect(second.cacheRead).toBe(95)
  })

  test("a change is announced once, in a microtask, never from inside read; no change means no call; no timer is used", async () => {
    let current = usage(90)
    const hub = createStatsHub(() => ({ usage: current }))
    const seen: number[] = []
    hub.subscribe((stats) => seen.push(stats.cacheRead))
    const timers = globalThis.setTimeout
    let timerCalls = 0
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => { timerCalls += 1; return timers(...args) }) as typeof setTimeout
    try {
      hub.read()
      await Promise.resolve()
      expect(seen).toEqual([])
      current = usage(95)
      hub.read()
      hub.read()
      expect(seen).toEqual([])
      await Promise.resolve()
      expect(seen).toEqual([95])
      current = usage(96)
      current = usage(97)
      hub.read()
      await Promise.resolve()
      expect(seen).toEqual([95, 97])
    } finally {
      globalThis.setTimeout = timers
    }
    expect(timerCalls).toBe(0)
  })

  test("a throwing listener is reported and skipped, the others still hear; an unsubscribed listener hears nothing", async () => {
    let current = usage(1)
    const errors: unknown[] = []
    const hub = createStatsHub(() => ({ usage: current }), { onListenerError: (error) => errors.push(error) })
    const heard: number[] = []
    hub.subscribe(() => { throw new Error("boom") })
    const stop = hub.subscribe((stats) => heard.push(stats.cacheRead))
    const gone = hub.subscribe(() => heard.push(-1))
    gone()
    expect(hub.listeners).toBe(2)
    hub.read()
    current = usage(2)
    hub.read()
    await Promise.resolve()
    expect(heard).toEqual([2])
    expect(errors).toHaveLength(1)
    stop()
    expect(hub.listeners).toBe(1)
  })

  test("without listeners a change schedules nothing", async () => {
    let current = usage(1)
    const hub = createStatsHub(() => ({ usage: current }))
    hub.read()
    current = usage(2)
    hub.read()
    await Promise.resolve()
    expect(hub.listeners).toBe(0)
  })
})

describe("stat parts", () => {
  test("the registry has one entry per id, in the documented order, and every part is silent until it has something to say", () => {
    expect(STAT_PARTS.map((part) => part.id)).toEqual([...STAT_PART_IDS])
    const nothing = computeSessionStats({ usage: EMPTY_USAGE })
    for (const part of STAT_PARTS) {
      expect(part.short(nothing)).toBeUndefined()
      expect(part.long(nothing)).toBeUndefined()
      expect(partSpans(part.id, nothing)).toEqual([])
    }
  })

  test("short and long forms of the sample session", () => {
    const short = (id: (typeof STAT_PART_IDS)[number]) => plain(PART_BY_ID[id].short(SAMPLE_STATS) ?? [])
    const long = (id: (typeof STAT_PART_IDS)[number]) => plain(PART_BY_ID[id].long(SAMPLE_STATS) ?? [])
    expect(short("cache")).toBe("94%")
    expect(long("cache")).toContain("read")
    expect(short("hit")).toBe("98%")
    expect(short("ctx")).toBe("14%")
    expect(short("tokens")).toBe("in 225K out 6,500 cr 212K cw 9,800")
    expect(short("calls")).toBe("14 calls")
    expect(short("spend")).toBe("$0.18")
    expect(short("tps")).toBe("77.8 tok/s")
    expect(short("ttft")).toBe("900ms")
    expect(short("effort")).toBe("medium")
    expect(short("forecast")).toBe("~12 turns to compact")
    expect(long("think")).toBe("1,400 reasoning tokens")
  })

  test("colours follow thresholds: cache green from 60 and amber under 25, context amber from 60 and red from 85, first token amber over 8 s, forecast amber at 3 turns", () => {
    const tone = (id: (typeof STAT_PART_IDS)[number], patch: Parameters<typeof computeSessionStats>[0]) => PART_BY_ID[id].tone(computeSessionStats(patch))
    const base = { calls: 1, input: 0, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    expect(tone("cache", { usage: { ...base, input: 40, cacheRead: 60 } })).toBe("success")
    expect(tone("cache", { usage: { ...base, input: 60, cacheRead: 40 } })).toBe("text")
    expect(tone("cache", { usage: { ...base, input: 80, cacheRead: 20 } })).toBe("warning")
    expect(tone("ctx", { usage: base, contextTokens: 59, contextLimit: 100 })).toBe("success")
    expect(tone("ctx", { usage: base, contextTokens: 60, contextLimit: 100 })).toBe("warning")
    expect(tone("ctx", { usage: base, contextTokens: 85, contextLimit: 100 })).toBe("error")
    expect(tone("ttft", { usage: base, calls: [{ at: 0, model: "m", output: 1, reasoning: 0, firstTokenMs: 8_001, durationMs: 9_000, toolCount: 0 }] })).toBe("warning")
    expect(tone("ttft", { usage: base, calls: [{ at: 0, model: "m", output: 1, reasoning: 0, firstTokenMs: 8_000, durationMs: 9_000, toolCount: 0 }] })).toBe("text")
    expect(tone("forecast", { usage: base, forecastTurns: 3 })).toBe("warning")
    expect(tone("forecast", { usage: base, forecastTurns: 4 })).toBe("muted")
  })

  test("an approximate context is marked with a tilde and a compaction due is said plainly", () => {
    expect(plain(PART_BY_ID.ctx.short(computeSessionStats({ usage: EMPTY_USAGE, contextTokens: 50, contextLimit: 100, contextApprox: true }))!)).toBe("~50%")
    expect(plain(PART_BY_ID.forecast.short(computeSessionStats({ usage: EMPTY_USAGE, forecastTurns: 0 }))!)).toBe("compacts next turn")
    expect(plain(PART_BY_ID.forecast.short(computeSessionStats({ usage: EMPTY_USAGE, forecastTurns: 1 }))!)).toBe("~1 turn to compact")
  })

  test("spans label a labelled part in muted, colour the figure, and quiet rows turn the neutral colour muted", () => {
    expect(partSpans("cache", SAMPLE_STATS)).toEqual([{ text: "cache ", fg: "muted" }, { text: "94%", fg: "success" }])
    expect(partSpans("calls", SAMPLE_STATS, { quiet: true }).map((span) => span.fg)).toEqual(["muted", "muted"])
    expect(partSpans("effort", SAMPLE_STATS, { quiet: true })[1]!.fg).toBe("muted")
    expect(partSpans("ctx", SAMPLE_STATS, { form: "long" }).map((span) => span.text).join("")).toBe("ctx 14% · 22K of 160K")
  })

  test("a line joins the parts that have a value, skips unknown names and empty parts, and uses the separator it is given", () => {
    const line = partsLine(["cache", "bogus", "ctx", "think"], computeSessionStats({ usage: EMPTY_USAGE }))
    expect(line).toEqual([])
    expect(text(partsLine(["cache", "bogus", "ctx"], SAMPLE_STATS, { separator: " · " }))).toBe("cache 94% · ctx 14%")
    expect(text(partsLine(["cache", "ctx"], SAMPLE_STATS))).toBe("cache 94%  ctx 14%")
  })
})
