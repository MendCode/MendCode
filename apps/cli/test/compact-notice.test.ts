import { describe, expect, test } from "bun:test"
import { createIdFactory, type SessionEvent, type Settings } from "@mendcode/protocol"
import { compactEstimate, compactEstimateText, compactNoticePercent, createCompactNotice } from "@mendcode/protocol/wire"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { contextLimitsLines, forecastLine } from "../src/support-output"
import { SETTINGS_GROUPS, renderSettingsPage, settingsPageKey, settingsRows, type SettingsPageState, type SettingsValues } from "../src/view/settings-page"
import { createTranscript } from "../src/view/transcript"
import { compactNoticeConfig, createUsageNotes, type CompactNoticeConfig } from "../src/view/usage-notes"
import { compact } from "../src/view/format"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const sessionId = ids("session")
let seq = 0
const ev = (patch: Record<string, unknown>) => ({ sessionId, seq: ++seq, at: NOW, ...patch }) as SessionEvent
/** A main call that leaves the context at `context` tokens; `compactAt` is where MendCode says it packs. */
const call = (turn: string, context: number, patch: Record<string, unknown> = {}) => ev({ type: "usage.recorded", turnId: turn, provider: "openai", model: "m", input: context, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, compactAt: 100_000, ...patch })
const packed = () => ev({ type: "compaction.updated", turnId: "turn_c", reason: "auto", state: "packed", followUp: "" })
const on: CompactNoticeConfig = { percent: 80, autoCompact: true }
const notes = (...config: [] | [CompactNoticeConfig | undefined]) => createUsageNotes({ notice: () => (config.length ? config[0] : on) })
const said = (list: ReturnType<ReturnType<typeof createUsageNotes>["apply"]>) => list.filter((note) => note.kind === "context").map((note) => note.text)

describe("the notice before a compaction", () => {
  test("is said once, at the call that crosses 80% of the compaction point, with the tokens left", () => {
    const usage = notes()
    expect(said(usage.apply(call("t1", 70_000)))).toEqual([])
    expect(said(usage.apply(call("t2", 82_000)))).toEqual(["compaction in 18K tokens · /compact to pack it now"])
    expect(said(usage.apply(call("t3", 90_000)))).toEqual([])
    expect(said(usage.apply(call("t4", 79_000)))).toEqual([])
    expect(said(usage.apply(call("t5", 85_000)))).toEqual([])
  })

  test("says about how many turns from the third turn of growth on, and only tokens before that", () => {
    const two = notes()
    two.apply(call("t1", 60_000))
    expect(said(two.apply(call("t2", 81_000)))).toEqual(["compaction in 19K tokens · /compact to pack it now"])

    const three = notes()
    three.apply(call("t1", 60_000))
    three.apply(call("t2", 70_000))
    expect(said(three.apply(call("t3", 80_000)))).toEqual(["compaction in 20K tokens · about 2 turns (10K a turn) · /compact to pack it now"])

    const next = notes({ percent: 95, autoCompact: true })
    next.apply(call("t1", 60_000))
    next.apply(call("t2", 78_000))
    expect(said(next.apply(call("t3", 96_000)))).toEqual(["compaction in 4,000 tokens · next turn · /compact to pack it now"])
  })

  test("several calls of one tool loop are one turn of data", () => {
    const usage = notes()
    usage.apply(call("t1", 50_000))
    usage.apply(call("t1", 60_000))
    usage.apply(call("t2", 70_000))
    expect(said(usage.apply(call("t2", 81_000)))).toEqual(["compaction in 19K tokens · /compact to pack it now"])
  })

  test("is armed again by a compaction, and by a context that fell well under the threshold", () => {
    const usage = notes()
    expect(said(usage.apply(call("t1", 85_000)))).toHaveLength(1)
    usage.apply(packed())
    expect(said(usage.apply(call("t2", 30_000)))).toEqual([])
    expect(said(usage.apply(call("t3", 84_000)))).toHaveLength(1)
    // An engine that packed on its own, or undone turns: no compaction event, but the context is far below again.
    expect(said(usage.apply(call("t4", 50_000)))).toEqual([])
    expect(said(usage.apply(call("t5", 81_000)))).toHaveLength(1)
  })

  test("off, an unset feature and a call that states no limit say nothing", () => {
    expect(said(notes(undefined).apply(call("t1", 95_000)))).toEqual([])
    expect(said(createUsageNotes().apply(call("t1", 95_000)))).toEqual([])
    // Plan mode and sub-agent calls carry neither `compactAt` nor a window.
    expect(said(notes().apply(call("t1", 95_000, { compactAt: undefined })))).toEqual([])
    // Claude Code events recorded before it reported a context cannot be measured.
    expect(said(notes().apply(call("t1", 95_000, { provider: "claude", contextWindow: 100_000, compactAt: undefined })))).toEqual([])
  })

  test("automatic compaction off: said with what that means when the point is real, never for the default of an unknown window", () => {
    const off: CompactNoticeConfig = { percent: 80, autoCompact: false }
    expect(said(notes(off).apply(call("t1", 82_000)))).toEqual(["18K tokens to the compaction point · automatic compaction is off · /compact to pack it"])
    expect(said(notes(off).apply(call("t1", 150_000, { compactAt: 160_000 })))).toEqual([])
    expect(said(notes({ ...off, compactAtTokens: 160_000 }).apply(call("t1", 150_000, { compactAt: 160_000 })))).toHaveLength(1)
    expect(said(notes(on).apply(call("t1", 150_000, { compactAt: 160_000 })))).toEqual(["compaction in 10K tokens · /compact to pack it now"])
  })

  test("an engine that compacts on its own is measured against its window, as the meter does, and is not told to /compact", () => {
    const text = said(notes().apply(call("t1", 170_000, { context: 170_000, contextWindow: 200_000, compactAt: undefined })))
    expect(text).toEqual(["30K tokens to the model window · the engine compacts it by itself"])
  })

  test("the threshold is the setting: default 80, a number, or off; the feature follows the tier", () => {
    expect(compactNoticePercent(undefined)).toBe(80)
    expect(compactNoticePercent(60)).toBe(60)
    expect(compactNoticePercent("off")).toBeUndefined()
    expect(compactNoticeConfig({ tier: "balanced" })).toEqual({ percent: 80, autoCompact: true, compactAtTokens: undefined })
    expect(compactNoticeConfig({ tier: "full", compactNoticePercent: 60, compaction: { auto: false }, compactAtTokens: 90_000 })).toEqual({ percent: 60, autoCompact: false, compactAtTokens: 90_000 })
    expect(compactNoticeConfig({ tier: "balanced", compactNoticePercent: "off" })).toBeUndefined()
    expect(compactNoticeConfig({ tier: "minimalist" })).toBeUndefined()
    expect(compactNoticeConfig({})).toBeUndefined()
    expect(compactNoticeConfig({ tier: "minimalist", features: { compact_notice: true } })?.percent).toBe(80)
    expect(compactNoticeConfig({ tier: "balanced", features: { compact_notice: false } })).toBeUndefined()
    const sixty = notes({ percent: 60, autoCompact: true })
    expect(said(sixty.apply(call("t1", 61_000)))).toHaveLength(1)
  })

  test("the crossing detector alone: once, then again only after packed() or a fall under three quarters of the threshold", () => {
    const notice = createCompactNotice()
    expect(notice.crossed(79, 100, 80)).toBe(false)
    expect(notice.crossed(80, 100, 80)).toBe(true)
    expect(notice.crossed(99, 100, 80)).toBe(false)
    expect(notice.crossed(61, 100, 80)).toBe(false)
    expect(notice.crossed(90, 100, 80)).toBe(false)
    expect(notice.crossed(59, 100, 80)).toBe(false)
    expect(notice.crossed(90, 100, 80)).toBe(true)
    notice.packed()
    expect(notice.crossed(90, 100, 80)).toBe(true)
    expect(notice.crossed(90, 0, 80)).toBe(false)
  })

  test("the transcript draws it as one muted line without the cacheNotices key, and keeps the cache notes behind that key", () => {
    const transcript = createTranscript({ glyphs: glyphs({}), appearance: { cacheNotices: false }, compactNotice: () => on })
    transcript.apply(call("t1", 60_000, { cacheWrite: 6_000, input: 54_000 }))
    transcript.apply(call("t2", 70_000, { input: 70_000 }))
    transcript.apply(call("t3", 80_000))
    const lines = transcript.viewport(100, 50)
    const shown = lines.map((line) => line.text).join("\n")
    expect(shown).toContain("── compaction in 20K tokens · about 2 turns (10K a turn) · /compact to pack it now")
    expect(shown).not.toContain("cache miss")
    const narrow = transcript.viewport(40, 50).map((line) => line.text)
    expect(narrow.every((line) => line.length <= 40)).toBe(true)
    expect(narrow.join(" ").replace(/\s+/g, " ")).toContain("/compact to pack it now")
    const silent = createTranscript({ glyphs: glyphs({}), appearance: { cacheNotices: false } })
    silent.apply(call("t1", 90_000))
    expect(silent.viewport(100, 50).map((line) => line.text).join("\n")).not.toContain("compaction in")
  })
})

describe("the notice in the app", () => {
  const text = (line: Line) => line.map((span) => span.text).join("")
  function harness(settings: Record<string, unknown>) {
    const frames: Line[][] = []
    const id = ids("session")
    const screen = { size: { width: 160, height: 24 }, draw: (rows: Line[]) => void frames.push(rows), setTitle() {} } as unknown as Parameters<typeof createApp>[0]["screen"]
    const app = createApp({ sessionId: id, screen, directory: "/work/app", exit() {}, schedule: (fn: () => void) => fn(), glyphs: glyphs({}), now: () => NOW, mode: "full", send: async () => ({ ok: true }) } as never)
    app.applySettings(settings as never)
    let n = 0
    const usage = (turn: string, context: number) => app.onEvent({ sessionId: id, seq: ++n, at: NOW, type: "usage.recorded", turnId: turn, provider: "openai", model: "m", input: context, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, compactAt: 100_000 } as SessionEvent)
    return { usage, all: () => { app.render(); return frames.at(-1)!.map(text).join("\n") } }
  }

  test("balanced shows it in the transcript; no tier, minimalist and off do not", () => {
    const balanced = harness({ tier: "balanced" })
    balanced.usage("t1", 85_000)
    expect(balanced.all()).toContain("compaction in 15K tokens · /compact to pack it now")
    for (const settings of [{}, { tier: "minimalist" }, { tier: "balanced", compactNoticePercent: "off" }]) {
      const quiet = harness(settings)
      quiet.usage("t1", 85_000)
      expect(quiet.all()).not.toContain("compaction in")
    }
  })
})

describe("/settings: the compact notice row", () => {
  const values = (settings: Settings): SettingsValues => ({ settings, theme: "mend", view: "balanced", reducedMotion: false })
  const rows = SETTINGS_GROUPS.flatMap((group) => group.rows)
  const at: SettingsPageState = { row: rows.findIndex((row) => row.id === "compactNoticePercent") }
  const key = (input: string, settings: Settings = {}) => settingsPageKey(at, input, values(settings), { themes: ["mend"] }).action
  const valueOf = (settings: Settings) => settingsRows(values(settings)).find((row) => row.id === "compactNoticePercent")?.value

  test("is in Behavior with the compaction and cache rows", () => {
    const behavior = SETTINGS_GROUPS.find((group) => group.title === "Behavior")!.rows.map((row) => row.id)
    expect(behavior.slice(behavior.indexOf("compactAtTokens"), behavior.indexOf("compactNoticePercent") + 1)).toEqual(["compactAtTokens", "idleCompactAtTokens", "promptCacheTtl", "claudeCacheTtl", "compactNoticePercent"])
    expect(rows.find((row) => row.id === "compactNoticePercent")).toEqual({ id: "compactNoticePercent", label: "compact notice", kind: "cycle" })
  })

  test("cycles default, 50, 60, 70, 90 and off, and shows what is set", () => {
    expect(key("l")).toEqual({ type: "set", patch: { compactNoticePercent: 50 } })
    expect(key("l", { compactNoticePercent: 90 })).toEqual({ type: "set", patch: { compactNoticePercent: "off" } })
    expect(key("l", { compactNoticePercent: "off" })).toEqual({ type: "set", patch: { compactNoticePercent: null } })
    expect(key("h")).toEqual({ type: "set", patch: { compactNoticePercent: "off" } })
    expect(valueOf({})).toBe("default (80% of the compaction point)")
    expect(valueOf({ compactNoticePercent: 60 })).toBe("60%")
    expect(valueOf({ compactNoticePercent: "off" })).toBe("off")
    const page = (settings: Settings) => renderSettingsPage({ state: at, values: values(settings), width: 140, height: 60 }).map((line) => line.map((span) => span.text).join("")).join("\n")
    expect(page({ tier: "balanced" })).toContain("says once that a compaction is near")
    expect(page({})).toContain("off · /tier compact_notice on")
  })
})

describe("mendcode context: the estimate line", () => {
  const limits = { model: "m", contextWindow: 200_000, contextWindowSource: "catalog" as const, compactAtTokens: 190_000, compactAtSource: "threshold" as const, thresholdPercent: 95, thresholdSource: "default" as const, autoCompact: true, contextTokens: 160_000, contextTokensSource: "last-call" as const }

  test("one line after the context, with the turns when there are three of them and the share the terminal says it at", () => {
    expect(contextLimitsLines(limits)).toHaveLength(3)
    const lines = contextLimitsLines({ ...limits, forecast: { limit: "compaction", auto: true, tokensLeft: 30_000, turns: 3, perTurn: 10_000, noticePercent: 80, noticeDue: true } })
    expect(lines).toHaveLength(4)
    expect(lines[3]).toBe("compaction in 30,000 tokens · about 3 turns (10,000 a turn) · /compact to pack it now · notice at 80% (reached)")
    expect(forecastLine({ limit: "compaction", auto: true, tokensLeft: 90_000, noticeDue: false })).toBe("compaction in 90,000 tokens · /compact to pack it now · notice off")
    expect(forecastLine({ limit: "window", auto: true, tokensLeft: 30_000, turns: 1, perTurn: 20_000, noticePercent: 60, noticeDue: false })).toBe("30,000 tokens to the model window · about 1 turn (20,000 a turn) · the engine compacts it by itself · notice at 60%")
  })

  test("the estimate is tokens left, plus turns only from three samples of growth", () => {
    const samples = [{ turnId: "a", tokens: 60_000 }, { turnId: "b", tokens: 70_000 }, { turnId: "c", tokens: 80_000 }]
    expect(compactEstimate({ tokens: 80_000, limitTokens: 100_000, limit: "compaction", auto: true, samples: samples.slice(1) })).toEqual({ limit: "compaction", auto: true, tokensLeft: 20_000 })
    expect(compactEstimate({ tokens: 80_000, limitTokens: 100_000, limit: "compaction", auto: true, samples })).toEqual({ limit: "compaction", auto: true, tokensLeft: 20_000, turns: 2, perTurn: 10_000 })
    expect(compactEstimate({ tokens: 120_000, limitTokens: 100_000, limit: "compaction", auto: true, samples: [] }).tokensLeft).toBe(0)
    expect(compactEstimateText({ limit: "compaction", auto: true, tokensLeft: 20_000, turns: 2, perTurn: 10_000 }, compact)).toBe("compaction in 20K tokens · about 2 turns (10K a turn) · /compact to pack it now")
  })
})
