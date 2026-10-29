import { describe, expect, test } from "bun:test"
import { createVirtualClock } from "@mendcode/kernel"
import { ANTHROPIC_CACHE_LIFETIME_1H_MS, ANTHROPIC_CACHE_LIFETIME_MS, WAIT_CACHE_AFTER, featureOn, nextWaitCache, type WaitCacheState } from "@mendcode/protocol/wire"
import type { SessionId, Settings } from "@mendcode/protocol"
import { createCacheTtl } from "../src/cache-ttl"

const START = 1_790_000_000_000
const MINUTE = 60_000
const SESSION = "ses_ttl" as SessionId
const PROVIDERS: Record<string, { type?: string }> = { anthropic: { type: "anthropic" }, vertex: { type: "google-vertex-anthropic" }, openai: { type: "openai" }, bedrock: { type: "amazon-bedrock" }, chatgpt: {} }

/** The policy on a virtual clock. Nothing sleeps: a wait is `clock.advance`. */
function setup(initial: { settings?: Partial<Settings>; learns?: boolean } = {}) {
  const clock = createVirtualClock(START)
  const state = { settings: (initial.settings ?? {}) as Partial<Settings>, learns: initial.learns ?? true }
  const policy = createCacheTtl({ clock, settings: () => state.settings, learns: () => state.learns, provider: (id) => PROVIDERS[id] })
  /** A call `minutes` after the previous one. */
  const callAfter = (minutes: number, input: { sessionId?: SessionId; role?: "main" | "subagent"; provider?: string } = {}) => {
    clock.advance(minutes * MINUTE)
    return policy.ttlFor({ sessionId: input.sessionId ?? SESSION, role: input.role ?? "main", provider: input.provider ?? "anthropic" })
  }
  return { clock, state, policy, callAfter }
}

describe("cache lifetime: the setting", () => {
  test("1h asks for an hour on every call of an Anthropic-type provider; other providers are never given a lifetime", () => {
    const { callAfter } = setup({ settings: { promptCacheTtl: "1h" }, learns: false })
    expect(callAfter(0)).toBe("1h")
    expect(callAfter(0, { provider: "vertex" })).toBe("1h")
    for (const provider of ["openai", "bedrock", "chatgpt", "unknown"]) expect(callAfter(0, { provider })).toBeUndefined()
  })

  test("5m and unset ask for nothing while the feature is off, whatever the gaps", () => {
    for (const promptCacheTtl of [undefined, "5m"] as const) {
      const { callAfter, policy } = setup({ settings: promptCacheTtl ? { promptCacheTtl } : {}, learns: false })
      expect([callAfter(0), callAfter(10), callAfter(10), callAfter(10)]).toEqual([undefined, undefined, undefined, undefined])
      // Nothing is tracked for a session the rule does not apply to.
      expect(policy.size()).toBe(0)
    }
  })

  test("the setting is read at each call", () => {
    const { callAfter, state } = setup({ learns: false })
    expect(callAfter(0)).toBeUndefined()
    state.settings = { promptCacheTtl: "1h" }
    expect(callAfter(0)).toBe("1h")
    state.settings = {}
    expect(callAfter(0)).toBeUndefined()
  })
})

describe("wait_cache: an hour after long waits", () => {
  test("is on only in the full tier, off with no tier, and an override wins", () => {
    expect(featureOn({}, "wait_cache")).toBe(false)
    expect(featureOn({ tier: "minimalist" }, "wait_cache")).toBe(false)
    expect(featureOn({ tier: "balanced" }, "wait_cache")).toBe(false)
    expect(featureOn({ tier: "full" }, "wait_cache")).toBe(true)
    expect(featureOn({ tier: "full", features: { wait_cache: false } }, "wait_cache")).toBe(false)
    expect(featureOn({ tier: "balanced", features: { wait_cache: true } }, "wait_cache")).toBe(true)
  })

  test("short gaps stay at 5m however many there are", () => {
    const { callAfter } = setup()
    expect(callAfter(0)).toBe("5m")
    for (let call = 0; call < 20; call++) expect(callAfter(4)).toBe("5m")
  })

  test("the first long wait changes nothing; the call after the second one is written at 1h", () => {
    const { callAfter } = setup()
    expect(WAIT_CACHE_AFTER).toBe(2)
    expect(callAfter(0)).toBe("5m")
    expect(callAfter(7)).toBe("5m")
    expect(callAfter(1)).toBe("5m")
    expect(callAfter(7)).toBe("1h")
  })

  test("the switch happens only on a call whose 5m cache has expired: a gap of exactly the lifetime is not a long wait", () => {
    const { clock, policy } = setup()
    const call = () => policy.ttlFor({ sessionId: SESSION, role: "main", provider: "anthropic" })
    call()
    clock.advance(ANTHROPIC_CACHE_LIFETIME_MS)
    expect(call()).toBe("5m")
    clock.advance(ANTHROPIC_CACHE_LIFETIME_MS)
    expect(call()).toBe("5m")
    clock.advance(ANTHROPIC_CACHE_LIFETIME_MS + 1)
    expect(call()).toBe("5m")
    clock.advance(ANTHROPIC_CACHE_LIFETIME_MS + 1)
    expect(call()).toBe("1h")
  })

  test("once at 1h it stays there through short gaps and through waits of up to an hour: no switch while the cache is warm", () => {
    const { callAfter } = setup()
    callAfter(0); callAfter(10); callAfter(10)
    for (const minutes of [0, 1, 4, 30, 2, 59, 60]) expect(callAfter(minutes)).toBe("1h")
  })

  test("a wait past an hour, which no lifetime covers, goes back to 5m and the pattern has to show twice again", () => {
    const { callAfter } = setup()
    callAfter(0); callAfter(10)
    expect(callAfter(10)).toBe("1h")
    expect(callAfter(61)).toBe("5m")
    expect(callAfter(10)).toBe("5m")
    expect(callAfter(10)).toBe("1h")
  })

  test("at 5m a wait past an hour also clears the count: it says nothing about waits an hour would cover", () => {
    const { callAfter } = setup()
    callAfter(0)
    expect(callAfter(10)).toBe("5m")
    expect(callAfter(90)).toBe("5m")
    expect(callAfter(10)).toBe("5m")
    expect(callAfter(10)).toBe("1h")
  })

  test("each session, and the sub-agent calls inside one, learn on their own", () => {
    const { clock, policy } = setup()
    const other = "ses_other" as SessionId
    const call = (sessionId: SessionId, role: "main" | "subagent" = "main") => policy.ttlFor({ sessionId, role, provider: "anthropic" })
    call(SESSION); call(other); call(SESSION, "subagent")
    clock.advance(10 * MINUTE)
    call(SESSION)
    clock.advance(10 * MINUTE)
    expect(call(SESSION)).toBe("1h")
    // Twenty minutes after their only call: one long wait each, not two.
    expect(call(other)).toBe("5m")
    expect(call(SESSION, "subagent")).toBe("5m")
    expect(policy.size()).toBe(3)
  })

  test("plan and compaction calls share the main conversation's prefix and its track", () => {
    const { clock, policy } = setup()
    policy.ttlFor({ sessionId: SESSION, role: "main", provider: "anthropic" })
    clock.advance(10 * MINUTE)
    policy.ttlFor({ sessionId: SESSION, role: "plan", provider: "anthropic" })
    clock.advance(10 * MINUTE)
    expect(policy.ttlFor({ sessionId: SESSION, role: "compaction", provider: "anthropic" })).toBe("1h")
    expect(policy.size()).toBe(1)
  })

  test("the setting at 1h wins and the rule is not consulted; switching the feature off stops it at once", () => {
    const { callAfter, state, policy } = setup({ settings: { promptCacheTtl: "1h" } })
    expect([callAfter(0), callAfter(10), callAfter(10)]).toEqual(["1h", "1h", "1h"])
    expect(policy.size()).toBe(0)
    state.settings = {}
    callAfter(0); callAfter(10)
    expect(callAfter(10)).toBe("1h")
    state.learns = false
    expect(callAfter(1)).toBeUndefined()
  })

  test("providers that take no ttl are never tracked", () => {
    const { callAfter, policy } = setup()
    for (const provider of ["openai", "bedrock", "chatgpt"]) expect([callAfter(0, { provider }), callAfter(10, { provider }), callAfter(10, { provider })]).toEqual([undefined, undefined, undefined])
    expect(policy.size()).toBe(0)
  })

  test("the oldest track is forgotten past 512 sessions", () => {
    const { policy } = setup()
    for (let index = 0; index < 600; index++) policy.ttlFor({ sessionId: `ses_${index}` as SessionId, role: "main", provider: "anthropic" })
    expect(policy.size()).toBe(512)
  })
})

describe("nextWaitCache: every transition", () => {
  const at = (state: WaitCacheState | undefined, gapMs: number) => nextWaitCache(state, (state?.lastAt ?? START) + gapMs)
  const five = (longWaits: number): WaitCacheState => ({ ttl: "5m", lastAt: START, longWaits })
  const hour: WaitCacheState = { ttl: "1h", lastAt: START, longWaits: 2 }

  test("the first call starts at 5m with nothing counted", () => {
    expect(nextWaitCache(undefined, START)).toEqual({ ttl: "5m", lastAt: START, longWaits: 0 })
  })

  test("from 5m", () => {
    expect(at(five(0), 1)).toEqual({ ttl: "5m", lastAt: START + 1, longWaits: 0 })
    expect(at(five(1), ANTHROPIC_CACHE_LIFETIME_MS)).toMatchObject({ ttl: "5m", longWaits: 1 })
    expect(at(five(0), ANTHROPIC_CACHE_LIFETIME_MS + 1)).toMatchObject({ ttl: "5m", longWaits: 1 })
    expect(at(five(1), ANTHROPIC_CACHE_LIFETIME_MS + 1)).toMatchObject({ ttl: "1h", longWaits: 2 })
    expect(at(five(1), ANTHROPIC_CACHE_LIFETIME_1H_MS)).toMatchObject({ ttl: "1h", longWaits: 2 })
    expect(at(five(1), ANTHROPIC_CACHE_LIFETIME_1H_MS + 1)).toMatchObject({ ttl: "5m", longWaits: 0 })
  })

  test("from 1h", () => {
    expect(at(hour, 1)).toMatchObject({ ttl: "1h", longWaits: 2 })
    expect(at(hour, ANTHROPIC_CACHE_LIFETIME_MS + 1)).toMatchObject({ ttl: "1h", longWaits: 2 })
    expect(at(hour, ANTHROPIC_CACHE_LIFETIME_1H_MS)).toMatchObject({ ttl: "1h", longWaits: 2 })
    expect(at(hour, ANTHROPIC_CACHE_LIFETIME_1H_MS + 1)).toEqual({ ttl: "5m", lastAt: START + ANTHROPIC_CACHE_LIFETIME_1H_MS + 1, longWaits: 0 })
  })
})
