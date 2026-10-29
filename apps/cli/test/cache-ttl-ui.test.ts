import { describe, expect, test } from "bun:test"
import type { SessionEvent, SessionId, Settings, TurnId } from "@mendcode/protocol"
import { SETTINGS_GROUPS, renderSettingsPage, settingsPageKey, settingsRows, type SettingsPageState, type SettingsValues } from "../src/view/settings-page"
import { createUsageNotes } from "../src/view/usage-notes"

const values = (settings: Settings): SettingsValues => ({ settings, theme: "mend", view: "balanced", reducedMotion: false })
const rows = SETTINGS_GROUPS.flatMap((group) => group.rows)
const rowOf = (id: string): SettingsPageState => ({ row: rows.findIndex((row) => row.id === id) })
const key = (state: SettingsPageState, input: string, settings: Settings = {}) => settingsPageKey(state, input, values(settings), { themes: ["mend"] })
const page = (state: SettingsPageState, settings: Settings) => renderSettingsPage({ state, values: values(settings), width: 140, height: 50 }).map((line) => line.map((span) => span.text).join("")).join("\n")
/** The page on a narrow terminal, where the detail panel has its own lines: its text with the frame and the wrapping taken out. */
const detail = (state: SettingsPageState, settings: Settings) => renderSettingsPage({ state, values: values(settings), width: 80, height: 70 }).map((line) => line.map((span) => span.text).join("").replace(/[│]/g, " ")).join(" ").replace(/\s+/g, " ")
const valueOf = (id: string, settings: Settings) => settingsRows(values(settings)).find((row) => row.id === id)?.value

describe("/settings: the cache ttl row", () => {
  const at = rowOf("promptCacheTtl")

  test("sits right under idle compact, in Behavior, followed by the Claude Code row", () => {
    const behavior = SETTINGS_GROUPS.find((group) => group.title === "Behavior")!.rows
    const index = behavior.findIndex((row) => row.id === "idleCompactAtTokens")
    expect(behavior[index + 1]).toEqual({ id: "promptCacheTtl", label: "cache ttl", kind: "cycle" })
    expect(behavior[index + 2]).toEqual({ id: "claudeCacheTtl", label: "claude ttl", kind: "toggle" })
  })

  test("shows 5m when unset or 5m, and 1h when saved", () => {
    expect(valueOf("promptCacheTtl", {})).toBe("5m")
    expect(valueOf("promptCacheTtl", { promptCacheTtl: "5m" })).toBe("5m")
    expect(valueOf("promptCacheTtl", { promptCacheTtl: "1h" })).toBe("1h")
  })

  test("either arrow, space and enter switch between the two values; 5m clears the setting", () => {
    for (const input of ["\x1b[C", "\x1b[D", " ", "\r"]) {
      expect(key(at, input).action).toEqual({ type: "set", patch: { promptCacheTtl: "1h" } })
      expect(key(at, input, { promptCacheTtl: "5m" }).action).toEqual({ type: "set", patch: { promptCacheTtl: "1h" } })
      expect(key(at, input, { promptCacheTtl: "1h" }).action).toEqual({ type: "set", patch: { promptCacheTtl: null } })
    }
  })

  test("the note names the price, and at 5m says whether a session moves to 1h by itself (wait_cache: full tier only)", () => {
    expect(page(at, { promptCacheTtl: "1h" })).toContain("Anthropic · writes 2x")
    expect(page(at, {})).toContain("Anthropic · writes 1.25x")
    expect(page(at, { tier: "balanced" })).toContain("Anthropic · writes 1.25x")
    expect(page(at, { tier: "full" })).toContain("1h after two long waits")
    expect(page(at, { tier: "full" })).not.toContain("Anthropic · writes 1.25x")
    expect(page(at, { tier: "full", features: { wait_cache: false } })).toContain("Anthropic · writes 1.25x")
    expect(page(at, { tier: "balanced", features: { wait_cache: true } })).toContain("1h after two long waits")
    // At 1h the feature has nothing to decide, whatever the tier.
    expect(page(at, { tier: "full", promptCacheTtl: "1h" })).not.toContain("1h after two long waits")
  })

  test("the notes are shown whole beside the value at 120 columns", () => {
    const at120 = (state: SettingsPageState, settings: Settings) => renderSettingsPage({ state, values: values(settings), width: 120, height: 46 }).map((line) => line.map((span) => span.text).join("")).join("\n")
    expect(at120(at, { tier: "full" })).toContain("‹ 5m ›                  1h after two long waits ")
    expect(at120(at, {})).toContain("‹ 5m ›                  Anthropic · writes 1.25x")
    expect(at120(at, { promptCacheTtl: "1h" })).toContain("‹ 1h ›                  Anthropic · writes 2x ")
    expect(at120(rowOf("claudeCacheTtl"), {})).toContain("‹ off ›                 1h also to Claude Code ")
    expect(at120(rowOf("claudeCacheTtl"), { claudeCacheTtl: true })).toContain("‹ on ›                  needs cache ttl 1h ")
  })

  test("the detail says which providers it reaches and where it is stored", () => {
    const text = detail(at, {})
    expect(text).toContain("Anthropic API and Claude on Vertex only")
    expect(text).toContain("Stored: daemon database settings.promptCacheTtl")
  })
})

describe("/settings: the claude ttl row", () => {
  const at = rowOf("claudeCacheTtl")

  test("is off until switched on, in every tier", () => {
    for (const settings of [{}, { tier: "minimalist" }, { tier: "balanced" }, { tier: "full" }] as Settings[]) expect(valueOf("claudeCacheTtl", settings)).toBe("off")
    expect(valueOf("claudeCacheTtl", { claudeCacheTtl: true })).toBe("on")
    expect(valueOf("claudeCacheTtl", { claudeCacheTtl: false })).toBe("off")
  })

  test("space, enter and the arrows toggle it", () => {
    for (const input of ["\x1b[C", "\x1b[D", " ", "\r"]) {
      expect(key(at, input).action).toEqual({ type: "set", patch: { claudeCacheTtl: true } })
      expect(key(at, input, { claudeCacheTtl: true }).action).toEqual({ type: "set", patch: { claudeCacheTtl: false } })
    }
  })

  test("on at 5m says nothing is passed yet; the detail names the two variables", () => {
    expect(page(at, { claudeCacheTtl: true })).toContain("needs cache ttl 1h")
    expect(page(at, { claudeCacheTtl: true, promptCacheTtl: "1h" })).toContain("1h also to Claude Code")
    expect(page(at, {})).toContain("1h also to Claude Code")
    const text = detail(at, {})
    expect(text).toContain("CLAUDE_CODE_PROMPT_CACHE_TTL")
    expect(text).toContain("CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL")
  })
})

describe("cache miss note: the lifetime of the call before", () => {
  const NOW = 1_800_000_000_000
  let seq = 0
  const usage = (patch: Record<string, unknown>) => ({ sessionId: "ses_note" as SessionId, seq: ++seq, type: "usage.recorded", turnId: "turn_note" as TurnId, provider: "anthropic", model: "claude", input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...patch }) as SessionEvent

  test("a miss 9 minutes after a call written at 1h is not blamed on the lifetime; after 61 minutes it is", () => {
    const short = createUsageNotes()
    short.apply(usage({ at: NOW, cacheWrite: 6_000 }))
    expect(short.apply(usage({ at: NOW + 9 * 60_000, cacheWrite: 6_000 }))[0]!.text).toContain("idle 9m, past the cache lifetime")

    const long = createUsageNotes()
    long.apply(usage({ at: NOW, cacheWrite: 6_000, cacheTtl: "1h" }))
    expect(long.apply(usage({ at: NOW + 9 * 60_000, cacheWrite: 6_000, cacheTtl: "1h" }))[0]!.text).toContain("prompt prefix changed")
    expect(long.apply(usage({ at: NOW + 70 * 60_000, cacheWrite: 6_000, cacheTtl: "1h" }))[0]!.text).toContain("idle 61m, past the cache lifetime")
  })
})
