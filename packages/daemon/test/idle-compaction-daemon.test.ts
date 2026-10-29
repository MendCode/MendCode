import { afterEach, expect, test } from "bun:test"
import { CHATGPT_CACHE_LIFETIME_MS, IDLE_COMPACT_MARGIN_MS } from "@mendcode/protocol/wire"
import type { ContextLimits, SessionEvent, SessionId } from "@mendcode/protocol"
import { answer, boot, jumpClock, openSession, say, stop, until, type NativeHarness, type Step } from "./native-harness"

const running: NativeHarness[] = []
afterEach(async () => { for (const h of running.splice(0)) await h.cleanup() })

const FIRE_IN = CHATGPT_CACHE_LIFETIME_MS - IDLE_COMPACT_MARGIN_MS
const SUMMARY = "## Goal\nKeep the pagination fix."
const tick = () => new Promise((resolve) => setTimeout(resolve, 40))

/** The daemon with the native engine on a scripted provider named `chatgpt` and a clock the test moves; no real wait is longer than a tick. */
async function start(steps: Step[], patch: Record<string, unknown> = { features: { idle_compact: true }, idleCompactAtTokens: 8_000 }) {
  const clock = jumpClock()
  const h = await boot({ clock, steps, provider: { id: "chatgpt" } })
  running.push(h)
  expect(await h.client.send({ type: "settings.set", patch })).toMatchObject({ ok: true })
  const sessionId = await openSession(h)
  const idle = async () => ((await h.client.send({ type: "context.recent", sessionId })) as { result?: { limits?: ContextLimits } }).result?.limits?.idleCompaction
  const compactions = () => h.events.filter((event): event is Extract<SessionEvent, { type: "compaction.updated" }> => event.type === "compaction.updated")
  return { h, clock, sessionId, idle, compactions }
}
const lastCallAt = (h: NativeHarness, sessionId: SessionId) => { const usage = h.store.recentUsage(sessionId, 1)[0]!; return usage.at - (usage.profile?.durationMs ?? 0) }

test("an idle session past the threshold compacts once, one margin before its cache expires, on the last call's own request", async () => {
  const { h, clock, sessionId, idle, compactions } = await start([answer("done", { input: 9_000, output: 10 }), stop(SUMMARY)])
  await say(h, sessionId, "Fix pagination")
  expect(await idle()).toMatchObject({ scheduled: true, at: lastCallAt(h, sessionId) + FIRE_IN, atTokens: 8_000, provider: "chatgpt", lifetimeMinutes: 5, lifetimeSource: "assumed" })
  clock.jump(FIRE_IN - 5_000)
  await tick()
  expect(compactions()).toEqual([])
  clock.jump(5_000)
  await until(() => compactions().some((event) => event.state === "packed"))
  expect(compactions().map((event) => [event.reason, event.idle, event.state])).toEqual([["auto", true, "writing"], ["auto", true, "packed"]])
  // The compaction request repeats the main call (tools, system, messages) and appends its prompt.
  const [main, compaction] = [h.requests[0]!, h.requests[1]!]
  expect(compaction.tools.map((tool) => tool.name)).toEqual(main.tools.map((tool) => tool.name))
  expect(compaction.system).toBe(main.system)
  expect(compaction.messages.slice(0, main.messages.length)).toEqual(main.messages)
  expect(h.store.engineMessages.load(sessionId, "native")[0]).toMatchObject({ role: "user", content: expect.stringContaining("Keep the pagination fix") })
  expect(await idle()).toMatchObject({ scheduled: false, reason: "already-compacted" })
  // Once per idle period: hours later nothing else has run (a further model call would exhaust the script and fail a turn).
  clock.jump(6 * 3_600_000)
  await tick()
  expect(h.requests).toHaveLength(2)
  expect(h.events.some((event) => event.type === "turn.failed")).toBe(false)
})

test("a message before it fires cancels it: the next time counts from that turn's call", async () => {
  const { h, clock, sessionId, idle, compactions } = await start([answer("one", { input: 9_000, output: 10 }), answer("two", { input: 9_500, output: 10 })])
  await say(h, sessionId, "first")
  const first = (await idle())!.at!
  clock.jump(FIRE_IN - 30_000)
  await say(h, sessionId, "second")
  const second = (await idle())!.at!
  expect(second).toBe(lastCallAt(h, sessionId) + FIRE_IN)
  expect(second).toBeGreaterThan(first + FIRE_IN - 60_000)
  // Past the first time, before the second: nothing runs.
  clock.jump(60_000)
  await tick()
  expect(compactions()).toEqual([])
  expect(h.requests).toHaveLength(2)
})

test("the machine slept past the expiry: the overdue timer does not compact", async () => {
  const { h, clock, sessionId, idle, compactions } = await start([answer("done", { input: 9_000, output: 10 })])
  await say(h, sessionId, "work")
  clock.jump(CHATGPT_CACHE_LIFETIME_MS + 3_600_000)
  await tick()
  expect(compactions()).toEqual([])
  expect(h.requests).toHaveLength(1)
  expect(await idle()).toMatchObject({ scheduled: false, reason: "cache-expired" })
})

test("off unless the tier or the user turns it on; on in full only; below the default 100,000 tokens nothing is scheduled", async () => {
  const { h, clock, sessionId, idle, compactions } = await start([answer("done", { input: 9_000, output: 10 })], {})
  await say(h, sessionId, "work")
  expect(await idle()).toMatchObject({ scheduled: false, reason: "feature-off" })
  await h.client.send({ type: "settings.set", patch: { tier: "balanced" } })
  expect(await idle()).toMatchObject({ scheduled: false, reason: "feature-off" })
  await h.client.send({ type: "settings.set", patch: { tier: "full" } })
  expect(await idle()).toMatchObject({ scheduled: false, reason: "below-threshold", atTokens: 100_000 })
  await h.client.send({ type: "settings.set", patch: { idleCompactAtTokens: 8_000 } })
  expect(await idle()).toMatchObject({ scheduled: true })
  await h.client.send({ type: "settings.set", patch: { features: { idle_compact: false } } })
  expect(await idle()).toMatchObject({ scheduled: false, reason: "feature-off" })
  await h.client.send({ type: "settings.set", patch: { features: { idle_compact: true }, compaction: { auto: false } } })
  expect(await idle()).toMatchObject({ scheduled: false, reason: "auto-off" })
  await h.client.send({ type: "settings.set", patch: { compaction: null, cacheLifetimeMinutes: { chatgpt: 60 } } })
  expect(await idle()).toMatchObject({ scheduled: true, at: lastCallAt(h, sessionId) + 3_600_000 - IDLE_COMPACT_MARGIN_MS, lifetimeMinutes: 60, lifetimeSource: "setting" })
  // The timer set at the call was for the 5 minute lifetime; with auto off at that moment it would not have run either way.
  await h.client.send({ type: "settings.set", patch: { compaction: { auto: false } } })
  clock.jump(FIRE_IN)
  await tick()
  expect(compactions()).toEqual([])
})

test("a provider whose cache lifetime nobody states is never compacted while idle", async () => {
  const clock = jumpClock()
  const h = await boot({ clock, steps: [answer("done", { input: 9_000, output: 10 })] })
  running.push(h)
  await h.client.send({ type: "settings.set", patch: { features: { idle_compact: true }, idleCompactAtTokens: 8_000 } })
  const sessionId = await openSession(h)
  await say(h, sessionId, "work")
  const reply = (await h.client.send({ type: "context.recent", sessionId })) as { result?: { limits?: ContextLimits } }
  expect(reply.result?.limits?.idleCompaction).toEqual({ scheduled: false, reason: "unknown-lifetime", atTokens: 8_000, provider: "scripted" })
  clock.jump(24 * 3_600_000)
  await tick()
  expect(h.requests).toHaveLength(1)
})
