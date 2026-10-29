import { describe, expect, test } from "bun:test"
import { createVirtualClock } from "@mendcode/kernel"
import { ANTHROPIC_CACHE_LIFETIME_1H_MS, ANTHROPIC_CACHE_LIFETIME_MS, CHATGPT_CACHE_LIFETIME_MS, DEFAULT_IDLE_COMPACT_AT_TOKENS, IDLE_COMPACT_MARGIN_MS, OPENAI_CACHE_LIFETIME_MS, cacheLifetime } from "@mendcode/protocol/wire"
import type { SessionEvent, SessionId, Settings, TurnId } from "@mendcode/protocol"
import { createIdleCompaction, idleCompactFireAt } from "../src/idle-compaction"

const START = 1_790_000_000_000
const SESSION = "ses_idle" as SessionId
const TURN = "turn_1" as TurnId
const LIFETIME = CHATGPT_CACHE_LIFETIME_MS
const FIRE_IN = LIFETIME - IDLE_COMPACT_MARGIN_MS

/** The scheduler on a virtual clock, with every condition a switch the test flips. Nothing sleeps. */
function setup(overrides: { settings?: Partial<Settings>; providers?: Record<string, { type?: string; baseUrl?: string }> } = {}) {
  const clock = createVirtualClock(START)
  const state = { enabled: true, packs: true, child: false, idle: true, started: true, settings: (overrides.settings ?? {}) as Partial<Settings> }
  const compacted: SessionId[] = []
  let seq = 0
  const idle = createIdleCompaction({
    clock,
    enabled: () => state.enabled,
    settings: () => state.settings,
    provider: (id) => overrides.providers?.[id],
    packs: () => state.packs,
    child: () => state.child,
    idle: () => state.idle,
    compact: async (sessionId) => { if (state.started) compacted.push(sessionId); return state.started },
  })
  const event = (draft: Record<string, unknown>) => idle.observe({ sessionId: SESSION, seq: ++seq, at: clock.now(), ...draft } as SessionEvent)
  /** A main model call of `tokens` context that ended now, after `durationMs`. */
  const call = (tokens = 150_000, extra: Record<string, unknown> = {}) => event({ type: "usage.recorded", turnId: TURN, provider: "chatgpt", model: "gpt-test", input: tokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, compactAt: 400_000, ...extra })
  const compaction = (stateName: string) => event({ type: "compaction.updated", turnId: TURN, reason: "auto", state: stateName, followUp: "" })
  return { clock, state, compacted, idle, event, call, compaction }
}

describe("compaction while idle: when it fires", () => {
  test("fires one margin before the cache of the last call's provider expires, not a millisecond earlier", async () => {
    const { clock, compacted, idle, call } = setup()
    call()
    expect(idle.status(SESSION)).toEqual({ scheduled: true, at: START + FIRE_IN, atTokens: DEFAULT_IDLE_COMPACT_AT_TOKENS, provider: "chatgpt", lifetimeMinutes: 5, lifetimeSource: "assumed" })
    clock.advance(FIRE_IN - 1)
    await Promise.resolve()
    expect(compacted).toEqual([])
    clock.advance(1)
    await Promise.resolve()
    expect(compacted).toEqual([SESSION])
  })

  test("the lifetime counts from when the provider received the call, so a long call fires sooner", () => {
    const { idle, call } = setup()
    call(150_000, { profile: { estimatedTokens: { instructions: 0, memory: 0, history: 0, toolResults: 0, toolSchemas: 0, media: 0, total: 0 }, firstTokenMs: 10, durationMs: 90_000, toolCount: 0, imageCount: 0 } })
    expect(idle.status(SESSION).at).toBe(START - 90_000 + FIRE_IN)
  })

  test("each new call moves it: the idle period starts at the last one", async () => {
    const { clock, compacted, idle, call } = setup()
    call()
    clock.advance(120_000)
    call()
    expect(idle.pending()).toBe(1)
    expect(idle.status(SESSION).at).toBe(START + 120_000 + FIRE_IN)
    clock.advance(FIRE_IN - 1)
    await Promise.resolve()
    expect(compacted).toEqual([])
    clock.advance(1)
    await Promise.resolve()
    expect(compacted).toEqual([SESSION])
  })

  test("a lifetime shorter than two margins fires at half of it", () => {
    expect(idleCompactFireAt(0, 5 * 60_000)).toBe(4 * 60_000)
    expect(idleCompactFireAt(0, 60_000)).toBe(30_000)
  })

  test("the timer is detached from the process's life", () => {
    const base = createVirtualClock(START)
    let detached = 0
    const idle = createIdleCompaction({ clock: { now: base.now, setTimer: (ms, callback) => ({ ...base.setTimer(ms, callback), unref: () => void detached++ }) }, enabled: () => true, settings: () => ({}), provider: () => undefined, packs: () => true, child: () => false, idle: () => true, compact: async () => true })
    idle.observe({ sessionId: SESSION, seq: 1, at: START, type: "usage.recorded", turnId: TURN, provider: "chatgpt", model: "m", input: 150_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, compactAt: 400_000 } as SessionEvent)
    expect(detached).toBe(1)
  })
})

describe("compaction while idle: what prevents it", () => {
  const prevented = async (arrange: (s: ReturnType<typeof setup>) => void, reason: string, overrides?: Parameters<typeof setup>[0], tokens?: number) => {
    const s = setup(overrides)
    s.call(tokens)
    arrange(s)
    expect(s.idle.status(SESSION)).toMatchObject({ scheduled: false, reason })
    s.clock.advance(24 * 3_600_000)
    await Promise.resolve()
    expect(s.compacted).toEqual([])
  }

  test("the feature is off (tier or switch)", () => prevented((s) => { s.state.enabled = false }, "feature-off"))
  test("automatic compaction is switched off: compaction.auto false wins", () => prevented(() => {}, "auto-off", { settings: { compaction: { auto: false } } }))
  test("compaction.strategy native: whether that endpoint reads the cache is not known", () => prevented(() => {}, "native-strategy", { settings: { compaction: { strategy: "native" } } }))
  test("an engine that packs its own context (Claude Code, Codex, pi, ACP)", () => prevented((s) => { s.state.packs = false }, "engine-managed"))
  test("a sub-agent's or a workflow's session", () => prevented((s) => { s.state.child = true }, "child-session"))
  test("context below the threshold", () => prevented(() => {}, "below-threshold", undefined, DEFAULT_IDLE_COMPACT_AT_TOKENS - 1))
  test("context below the user's own threshold", () => prevented(() => {}, "below-threshold", { settings: { idleCompactAtTokens: 300_000 } }, 250_000))
  test("a running turn, a queued message, a pending approval or a running background task (not idle)", () => prevented((s) => { s.state.idle = false }, "busy"))

  test("a provider whose cache lifetime nobody states: no timer at all, never a guessed time", () => {
    const s = setup()
    s.call(150_000, { provider: "openrouter" })
    expect(s.idle.pending()).toBe(0)
    expect(s.idle.status(SESSION)).toEqual({ scheduled: false, reason: "unknown-lifetime", atTokens: DEFAULT_IDLE_COMPACT_AT_TOKENS, provider: "openrouter" })
  })

  test("a call that is not a main call of a history MendCode packs (no compactAt) schedules nothing", () => {
    const s = setup()
    s.call(150_000, { compactAt: undefined })
    expect(s.idle.pending()).toBe(0)
    expect(s.idle.status(SESSION)).toMatchObject({ scheduled: false, reason: "no-call" })
  })

  test("a later call that is not a main call (plan mode) drops the schedule: the recorded call is no longer the latest request", async () => {
    const s = setup()
    s.call()
    s.event({ type: "turn.started", turnId: TURN, queueId: "q_1" })
    s.call(152_000, { compactAt: undefined })
    s.event({ type: "turn.completed", turnId: TURN })
    await Promise.resolve()
    expect(s.idle.pending()).toBe(0)
    expect(s.idle.status(SESSION)).toMatchObject({ scheduled: false, reason: "no-call" })
    s.clock.advance(24 * 3_600_000)
    await Promise.resolve()
    expect(s.compacted).toEqual([])
  })

  test("already compacted since its last call: an automatic or manual compaction leaves nothing to save", async () => {
    const s = setup()
    s.call()
    s.compaction("writing")
    expect(s.idle.pending()).toBe(0)
    // The compaction's own model call is not the session's last call.
    s.call(150_000, { compactAt: undefined })
    s.call(150_000)
    s.compaction("packed")
    expect(s.idle.status(SESSION)).toMatchObject({ scheduled: false, reason: "already-compacted" })
    s.clock.advance(24 * 3_600_000)
    await Promise.resolve()
    expect(s.compacted).toEqual([])
  })

  test("the machine slept past the expiry: the late timer does not compact", async () => {
    const s = setup()
    s.call()
    // Sleep: time passes without timers running, then the overdue timer runs on wake.
    const late = createVirtualClock(START)
    const real = createIdleCompaction({ clock: { now: () => late.now() + (asleep ? 3_600_000 : 0), setTimer: late.setTimer }, enabled: () => true, settings: () => ({}), provider: () => undefined, packs: () => true, child: () => false, idle: () => true, compact: async (id) => { s.compacted.push(id); return true } })
    let asleep = false
    real.observe({ sessionId: SESSION, seq: 1, at: START, type: "usage.recorded", turnId: TURN, provider: "chatgpt", model: "m", input: 150_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, compactAt: 400_000 } as SessionEvent)
    asleep = true
    late.advance(FIRE_IN)
    await Promise.resolve()
    expect(s.compacted).toEqual([])
    expect(real.status(SESSION)).toMatchObject({ scheduled: false, reason: "cache-expired" })
  })

  test("a fire exactly at the expiry is too late; one millisecond before is not", async () => {
    for (const [lateBy, expected] of [[IDLE_COMPACT_MARGIN_MS - 1, 1], [IDLE_COMPACT_MARGIN_MS, 0]] as const) {
      const base = createVirtualClock(START)
      let skew = 0
      const done: SessionId[] = []
      const idle = createIdleCompaction({ clock: { now: () => base.now() + skew, setTimer: base.setTimer }, enabled: () => true, settings: () => ({}), provider: () => undefined, packs: () => true, child: () => false, idle: () => true, compact: async (id) => { done.push(id); return true } })
      idle.observe({ sessionId: SESSION, seq: 1, at: START, type: "usage.recorded", turnId: TURN, provider: "chatgpt", model: "m", input: 150_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, compactAt: 400_000 } as SessionEvent)
      skew = lateBy
      base.advance(FIRE_IN)
      await Promise.resolve()
      expect(done).toHaveLength(expected)
    }
  })
})

describe("compaction while idle: cancelled, and once per idle period", () => {
  test("a message before it fires cancels it; the turn's own call schedules the next one", async () => {
    const s = setup()
    s.call()
    s.clock.advance(FIRE_IN - 1_000)
    s.event({ type: "queue.added", queueId: "q_1", text: "hello", attachments: [] })
    expect(s.idle.pending()).toBe(0)
    s.event({ type: "turn.started", turnId: TURN, queueId: "q_1" })
    s.state.idle = false
    s.clock.advance(10_000)
    await Promise.resolve()
    expect(s.compacted).toEqual([])
    s.call(160_000)
    s.state.idle = true
    s.event({ type: "turn.completed", turnId: TURN })
    expect(s.idle.status(SESSION).at).toBe(s.clock.now() + FIRE_IN)
    s.clock.advance(FIRE_IN)
    await Promise.resolve()
    expect(s.compacted).toEqual([SESSION])
  })

  test("a turn that made no model call (a !command) leaves the cache as it was: the same time stands", async () => {
    const s = setup()
    s.call()
    s.event({ type: "turn.started", turnId: TURN, queueId: "q_1" })
    expect(s.idle.pending()).toBe(0)
    s.event({ type: "turn.completed", turnId: TURN })
    await Promise.resolve()
    expect(s.idle.status(SESSION)).toMatchObject({ scheduled: true, at: START + FIRE_IN })
  })

  test("a session busy when the time came is tried when its turn ends, if the cache still lives", async () => {
    const s = setup()
    s.call()
    s.state.idle = false
    s.clock.advance(FIRE_IN)
    await Promise.resolve()
    expect(s.compacted).toEqual([])
    s.state.idle = true
    s.event({ type: "turn.completed", turnId: TURN })
    await Promise.resolve()
    s.clock.advance(0)
    await Promise.resolve()
    expect(s.compacted).toEqual([SESSION])
  })

  test("never twice in one idle period, whether it packed, was skipped or failed", async () => {
    for (const end of ["packed", "skipped", "failed"]) {
      const s = setup()
      s.call()
      s.clock.advance(FIRE_IN)
      await Promise.resolve()
      s.event({ type: "turn.started", turnId: TURN, queueId: "q_c" })
      s.compaction("writing")
      s.call(4_000, { compactAt: undefined })
      s.compaction(end)
      s.event({ type: end === "failed" ? "turn.failed" : "turn.completed", turnId: TURN })
      await Promise.resolve()
      s.clock.advance(24 * 3_600_000)
      await Promise.resolve()
      expect(s.compacted, end).toEqual([SESSION])
      expect(s.idle.status(SESSION), end).toMatchObject({ scheduled: false, reason: "already-compacted" })
    }
  })

  test("a compaction that lost the race to a message is not counted as done", async () => {
    const s = setup()
    s.state.started = false
    s.call()
    s.clock.advance(FIRE_IN)
    await Promise.resolve()
    await Promise.resolve()
    expect(s.compacted).toEqual([])
    // Still owed: it is set again (for the same, now past, time) and runs when the session lets it.
    expect(s.idle.status(SESSION)).toMatchObject({ scheduled: true, at: START + FIRE_IN })
    s.state.started = true
    s.clock.advance(0)
    await Promise.resolve()
    expect(s.compacted).toEqual([SESSION])
  })

  test("a lifetime raised after the call moves the timer; the old time does not compact early", async () => {
    const s = setup()
    s.call()
    s.state.settings = { cacheLifetimeMinutes: { chatgpt: 60 } }
    s.clock.advance(FIRE_IN)
    await Promise.resolve()
    expect(s.compacted).toEqual([])
    expect(s.idle.status(SESSION)).toMatchObject({ scheduled: true, at: START + 3_600_000 - IDLE_COMPACT_MARGIN_MS })
    s.clock.advance(3_600_000 - IDLE_COMPACT_MARGIN_MS - FIRE_IN)
    await Promise.resolve()
    expect(s.compacted).toEqual([SESSION])
  })
})

describe("cache lifetimes: a value per provider, never a guess", () => {
  test("the built-in lifetimes and who states each", () => {
    expect(cacheLifetime({ provider: "chatgpt" })).toEqual({ ms: CHATGPT_CACHE_LIFETIME_MS, source: "assumed" })
    expect(cacheLifetime({ provider: "anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com/v1" })).toEqual({ ms: ANTHROPIC_CACHE_LIFETIME_MS, source: "documented" })
    expect(cacheLifetime({ provider: "openai", type: "openai", baseUrl: "https://api.openai.com/v1" })).toEqual({ ms: OPENAI_CACHE_LIFETIME_MS, source: "documented" })
  })

  test("unknown: an OpenAI-style host that is not OpenAI, Chat Completions hosts, Gemini, a provider nobody configured", () => {
    expect(cacheLifetime({ provider: "proxy", type: "openai", baseUrl: "https://llm.example.com/v1" })).toBeUndefined()
    expect(cacheLifetime({ provider: "openrouter", type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1" })).toBeUndefined()
    expect(cacheLifetime({ provider: "google", type: "google" })).toBeUndefined()
    expect(cacheLifetime({ provider: "scripted" })).toBeUndefined()
  })

  test("cacheLifetimeMinutes replaces a built-in lifetime and gives one to a provider that has none", () => {
    expect(cacheLifetime({ provider: "chatgpt", overrides: { chatgpt: 60 } })).toEqual({ ms: 3_600_000, source: "setting" })
    expect(cacheLifetime({ provider: "openrouter", type: "openai-compatible", overrides: { openrouter: 10 } })).toEqual({ ms: 600_000, source: "setting" })
    expect(cacheLifetime({ provider: "openrouter", overrides: { openrouter: 0 } })).toBeUndefined()
  })

  test("the scheduler uses the provider's type and the user's override", () => {
    const anthropic = setup({ providers: { work: { type: "anthropic", baseUrl: "https://api.anthropic.com/v1" } } })
    anthropic.call(150_000, { provider: "work" })
    expect(anthropic.idle.status(SESSION)).toMatchObject({ scheduled: true, at: START + ANTHROPIC_CACHE_LIFETIME_MS - IDLE_COMPACT_MARGIN_MS, lifetimeSource: "documented" })
    const hour = setup({ settings: { cacheLifetimeMinutes: { chatgpt: 60 } } })
    hour.call()
    expect(hour.idle.status(SESSION)).toMatchObject({ scheduled: true, at: START + 3_600_000 - IDLE_COMPACT_MARGIN_MS, lifetimeMinutes: 60, lifetimeSource: "setting" })
  })
})

describe("cache lifetimes: a call written at 1h (promptCacheTtl, wait_cache)", () => {
  const ANTHROPIC = { work: { type: "anthropic", baseUrl: "https://api.anthropic.com/v1" } }

  test("cacheLifetime: an hour for the provider types that take ttl, and only for them", () => {
    expect(cacheLifetime({ provider: "work", type: "anthropic", ttl: "1h" })).toEqual({ ms: ANTHROPIC_CACHE_LIFETIME_1H_MS, source: "documented" })
    expect(cacheLifetime({ provider: "work", type: "anthropic", ttl: "5m" })).toEqual({ ms: ANTHROPIC_CACHE_LIFETIME_MS, source: "documented" })
    expect(cacheLifetime({ provider: "vertex", type: "google-vertex-anthropic", ttl: "1h" })).toEqual({ ms: ANTHROPIC_CACHE_LIFETIME_1H_MS, source: "documented" })
    // Without the field Vertex stays unknown, as before; a provider that takes no ttl is not given an hour by a stray flag.
    expect(cacheLifetime({ provider: "vertex", type: "google-vertex-anthropic" })).toBeUndefined()
    expect(cacheLifetime({ provider: "openai", type: "openai", baseUrl: "https://api.openai.com/v1", ttl: "1h" })).toEqual({ ms: OPENAI_CACHE_LIFETIME_MS, source: "documented" })
    expect(cacheLifetime({ provider: "chatgpt", ttl: "1h" })).toEqual({ ms: CHATGPT_CACHE_LIFETIME_MS, source: "assumed" })
    // The user's own minutes still win.
    expect(cacheLifetime({ provider: "work", type: "anthropic", ttl: "1h", overrides: { work: 30 } })).toEqual({ ms: 1_800_000, source: "setting" })
  })

  test("the compaction of a session whose last call asked for 1h starts at 59 minutes, not at 4", async () => {
    const { clock, compacted, idle, call } = setup({ providers: ANTHROPIC })
    call(150_000, { provider: "work", cacheTtl: "1h" })
    expect(idle.status(SESSION)).toEqual({ scheduled: true, at: START + 59 * 60_000, atTokens: DEFAULT_IDLE_COMPACT_AT_TOKENS, provider: "work", lifetimeMinutes: 60, lifetimeSource: "documented" })
    clock.advance(ANTHROPIC_CACHE_LIFETIME_MS)
    await Promise.resolve()
    expect(compacted).toEqual([])
    clock.advance(59 * 60_000 - ANTHROPIC_CACHE_LIFETIME_MS - 1)
    await Promise.resolve()
    expect(compacted).toEqual([])
    clock.advance(1)
    await Promise.resolve()
    expect(compacted).toEqual([SESSION])
  })

  test("it follows what each call actually sent: a call without ttl (5m, or a host that refused the field) is back at 4 minutes", async () => {
    const { clock, compacted, idle, call } = setup({ providers: ANTHROPIC })
    call(150_000, { provider: "work", cacheTtl: "1h" })
    clock.advance(60_000)
    call(150_000, { provider: "work" })
    expect(idle.status(SESSION)).toMatchObject({ scheduled: true, at: START + 60_000 + ANTHROPIC_CACHE_LIFETIME_MS - IDLE_COMPACT_MARGIN_MS, lifetimeMinutes: 5, lifetimeSource: "documented" })
    clock.advance(ANTHROPIC_CACHE_LIFETIME_MS - IDLE_COMPACT_MARGIN_MS)
    await Promise.resolve()
    expect(compacted).toEqual([SESSION])
  })

  test("a 1h call is still scheduled 30 minutes later: its cache has not expired", () => {
    const { clock, idle, call } = setup({ providers: ANTHROPIC })
    call(150_000, { provider: "work", cacheTtl: "1h" })
    clock.advance(30 * 60_000)
    expect(idle.status(SESSION).scheduled).toBe(true)
  })
})
