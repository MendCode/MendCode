import { describe, expect, test } from "bun:test"
import type { Settings, TurnId } from "@mendcode/protocol"
import { IDLE_COMPACT_NOTE } from "@mendcode/protocol/wire"
import { contextLimitsLines, idleCompactionLine } from "../src/support-output"
import { compactionReason, renderCompactionPanel, type Compaction } from "../src/view/compaction-panel"
import { compactionRows } from "../src/view/transcript-views"
import { createTranscript } from "../src/view/transcript"
import { SETTINGS_GROUPS, renderSettingsPage, settingsPageKey, settingsRows, type SettingsPageState, type SettingsValues } from "../src/view/settings-page"
import { DEFAULT_TUI_PROFILE } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"

const text = (lines: ReturnType<typeof renderCompactionPanel>) => lines.map((line) => line.map((span) => span.text).join(""))
const TURN = "turn_idle" as TurnId
const packed = (idle: boolean, state: Compaction["state"] = "packed"): Compaction => ({ turnId: TURN, reason: idle ? "auto" : "manual", ...(idle ? { idle: true as const } : {}), state, followUp: "", summary: "## Goal\nKeep going." })

describe("the transcript says a compaction ran while idle, in the card's muted line", () => {
  for (const style of ["cockpit", "minimal", "quiet"] as const) for (const width of [48, 100]) {
    test(`${style} at ${width} columns: one muted line with the sentence, inside the width`, () => {
      const lines = renderCompactionPanel({ data: packed(true), profile: { ...DEFAULT_TUI_PROFILE, compactionStyle: style }, width, expanded: false, summaryRows: [] })
      const muted = lines.flatMap((line) => line.filter((span) => span.text.includes("Compacted while idle")))
      expect(muted).toHaveLength(1)
      expect(muted[0]).toMatchObject({ fg: "muted" })
      expect(text(lines).join("\n")).toContain(width >= 60 ? IDLE_COMPACT_NOTE : "Compacted while idle")
      expect(text(lines).join("\n")).toContain("Context packed")
      expect(text(lines).every((line) => textWidth(line) <= width)).toBe(true)
    })
  }

  test("the sentence is exactly the owner's wording", () => {
    expect(IDLE_COMPACT_NOTE).toBe("Compacted while idle, before the prompt cache expired")
    expect(compactionReason(packed(true))).toBe(IDLE_COMPACT_NOTE)
  })

  test("a manual or an automatic compaction keeps its own word; an idle one that did not pack says only idle", () => {
    expect(compactionReason(packed(false))).toBe("manual")
    expect(compactionReason({ reason: "auto", state: "packed" })).toBe("auto")
    expect(compactionReason(packed(true, "failed"))).toBe("idle")
    expect(text(renderCompactionPanel({ data: packed(false), profile: { ...DEFAULT_TUI_PROFILE, compactionStyle: "quiet" }, width: 80, expanded: false, summaryRows: [] }))).toHaveLength(1)
    expect(text(renderCompactionPanel({ data: packed(false), profile: { ...DEFAULT_TUI_PROFILE, compactionStyle: "cockpit" }, width: 80, expanded: false, summaryRows: [] })).join("\n")).not.toContain("idle")
  })

  test("the card model carries it to the built-in view", () => {
    const rows = compactionRows({ itemId: "item_1", turnId: TURN, state: "packed", reason: "auto", idle: true, summary: "s", followUp: "", style: "cockpit", presentation: "mendcode", progress: true, scratchpad: true, expanded: false, width: 90 } as Parameters<typeof compactionRows>[0])
    expect(text(rows).join("\n")).toContain(IDLE_COMPACT_NOTE)
  })

  test("from the event log: the line shows in the transcript and /compaction lists it like any other compaction", () => {
    const transcript = createTranscript()
    const base = { sessionId: "ses_1", turnId: TURN }
    const events = [
      { ...base, seq: 1, at: 1, type: "turn.started", queueId: "q_1" },
      { ...base, seq: 2, at: 2, type: "compaction.updated", reason: "auto", idle: true, state: "writing", followUp: "" },
      { ...base, seq: 3, at: 3, type: "item.started", itemId: "item_c", kind: "compaction", meta: { compactionMethod: "legacy", tailTurns: 2, tailTokens: 120 } },
      { sessionId: "ses_1", seq: 4, at: 4, type: "item.completed", itemId: "item_c", status: "ok", text: "## Goal\nKeep going." },
      { ...base, seq: 5, at: 5, type: "compaction.updated", reason: "auto", idle: true, state: "packed", followUp: "" },
      { ...base, seq: 6, at: 6, type: "turn.completed" },
    ]
    for (const event of events) transcript.apply(event as never)
    expect(transcript.compactions()).toHaveLength(1)
    expect(transcript.compactions()[0]).toMatchObject({ turnId: TURN, idle: true, reason: "auto", state: "packed", summary: "## Goal\nKeep going." })
    const shown = transcript.viewport(100, 200).map((row) => row.text).join("\n")
    expect(shown).toContain(IDLE_COMPACT_NOTE)
    expect(shown.split(IDLE_COMPACT_NOTE)).toHaveLength(2)
  })
})

describe("mendcode context: one line for the compaction while idle", () => {
  const at = new Date(2026, 9, 12, 14, 32, 10).getTime()
  const base = { atTokens: 100_000 }

  test("scheduled: when it starts and which lifetime sets that, with who states it", () => {
    expect(idleCompactionLine({ ...base, scheduled: true, at, provider: "chatgpt", lifetimeMinutes: 5, lifetimeSource: "assumed" })).toBe("idle compaction at 14:32:10: chatgpt keeps the prompt cache 5m after a call (assumed)")
    expect(idleCompactionLine({ ...base, scheduled: true, at, provider: "anthropic", lifetimeMinutes: 5, lifetimeSource: "documented" })).toBe("idle compaction at 14:32:10: anthropic keeps the prompt cache 5m after a call (documented)")
    expect(idleCompactionLine({ ...base, scheduled: true, at, provider: "openrouter", lifetimeMinutes: 10, lifetimeSource: "setting" })).toBe("idle compaction at 14:32:10: openrouter keeps the prompt cache 10m after a call (cacheLifetimeMinutes)")
  })

  test("not scheduled: each reason in a few words", () => {
    const line = (reason: NonNullable<Parameters<typeof idleCompactionLine>[0]["reason"]>, provider?: string) => idleCompactionLine({ ...base, scheduled: false, reason, ...(provider ? { provider } : {}) })
    expect(line("feature-off")).toBe("idle compaction off (/tier idle_compact on)")
    expect(line("auto-off")).toBe("idle compaction off: automatic compaction is off (compaction.auto false)")
    expect(line("native-strategy")).toBe("idle compaction off: compaction.strategy is native")
    expect(line("engine-managed")).toBe("idle compaction off: this engine packs its own context")
    expect(line("child-session")).toBe("idle compaction off: a sub-agent's session")
    expect(line("no-call")).toBe("idle compaction not scheduled: no model call since the daemon started")
    expect(line("below-threshold")).toBe("idle compaction not scheduled: context below 100,000 tokens")
    expect(line("unknown-lifetime", "openrouter")).toBe("idle compaction off: nobody states how long openrouter keeps the prompt cache (cacheLifetimeMinutes)")
    expect(line("already-compacted")).toBe("idle compaction not scheduled: already compacted since the last call")
    expect(line("busy")).toBe("idle compaction not scheduled: the session is busy")
    expect(line("cache-expired")).toBe("idle compaction not scheduled: the prompt cache has expired")
  })

  test("it is the fourth line of the limits, and absent when the daemon does not report it", () => {
    const limits = { model: "gpt-6.1-sol", contextWindow: 500_000, contextWindowSource: "catalog" as const, compactAtTokens: 475_000, compactAtSource: "threshold" as const, thresholdPercent: 95, thresholdSource: "default" as const, autoCompact: true, contextTokens: 212_340, contextTokensSource: "last-call" as const }
    expect(contextLimitsLines(limits)).toHaveLength(3)
    const lines = contextLimitsLines({ ...limits, idleCompaction: { ...base, scheduled: true, at, provider: "chatgpt", lifetimeMinutes: 5, lifetimeSource: "assumed" } })
    expect(lines).toHaveLength(4)
    expect(lines[3]).toBe("idle compaction at 14:32:10: chatgpt keeps the prompt cache 5m after a call (assumed)")
  })
})

describe("/settings: the idle compact row", () => {
  const values = (settings: Settings): SettingsValues => ({ settings, theme: "mend", view: "balanced", reducedMotion: false })
  const rows = SETTINGS_GROUPS.flatMap((group) => group.rows)
  const at: SettingsPageState = { row: rows.findIndex((row) => row.id === "idleCompactAtTokens") }
  const key = (state: SettingsPageState, input: string, settings: Settings = {}) => settingsPageKey(state, input, values(settings), { themes: ["mend"] })

  test("sits right under compact at, in Behavior, with the same kind of input", () => {
    const behavior = SETTINGS_GROUPS.find((group) => group.title === "Behavior")!.rows
    const index = behavior.findIndex((row) => row.id === "compactAtTokens")
    expect(behavior[index + 1]).toEqual({ id: "idleCompactAtTokens", label: "idle compact", kind: "typed" })
    expect(behavior[index]!.kind).toBe("typed")
  })

  test("shows the default of 100k, or the saved count", () => {
    expect(settingsRows(values({})).find((row) => row.id === "idleCompactAtTokens")?.value).toBe("default (100k)")
    expect(settingsRows(values({ idleCompactAtTokens: 250_000 })).find((row) => row.id === "idleCompactAtTokens")?.value).toBe("250k")
  })

  test("arrows step through presets and back to the default", () => {
    expect(key(at, "\x1b[C").action).toEqual({ type: "set", patch: { idleCompactAtTokens: 50_000 } })
    expect(key(at, "\x1b[C", { idleCompactAtTokens: 50_000 }).action).toEqual({ type: "set", patch: { idleCompactAtTokens: 100_000 } })
    expect(key(at, "\x1b[D", { idleCompactAtTokens: 50_000 }).action).toEqual({ type: "set", patch: { idleCompactAtTokens: null } })
  })

  test("a typed count such as 150k saves on Enter; a count out of range is refused with the range", () => {
    let state = at
    for (const char of "150k") state = key(state, char).state
    expect(state.typing).toBe("150k")
    expect(key(state, "\r").action).toEqual({ type: "set", patch: { idleCompactAtTokens: 150_000 } })
    let small = at
    for (const char of "5") small = key(small, char).state
    const refused = key(small, "\r")
    expect(refused.action).toEqual({ type: "none" })
    expect(refused.state.error).toBe("tokens must be 8000-2000000 (200k works)")
  })

  test("the note says whether the feature is on: off without a tier and in balanced, on in full or by the user's switch", () => {
    const note = (settings: Settings) => renderSettingsPage({ state: at, values: values(settings), width: 140, height: 50 }).map((line) => line.map((span) => span.text).join("")).join("\n")
    expect(note({})).toContain("off · /tier idle_compact on")
    expect(note({ tier: "balanced" })).toContain("off · /tier idle_compact on")
    expect(note({ tier: "full" })).toContain("idle sessions past this compact")
    expect(note({ tier: "full" })).not.toContain("off · /tier idle_compact on")
    expect(note({ tier: "balanced", features: { idle_compact: true } })).toContain("idle sessions past this compact")
    expect(note({ tier: "full", features: { idle_compact: false } })).toContain("off · /tier idle_compact on")
  })
})
