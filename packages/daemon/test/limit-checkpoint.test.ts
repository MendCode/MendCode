import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type GlobalEvent, type SessionEvent } from "@mendcode/protocol"
import { openStore, type Store } from "@mendcode/store"
import { createLimitCheckpoint } from "../src/limit-checkpoint"
import { createUsageLimit, RESET_GRACE_MS } from "../src/usage-limit"
import { answer, boot, openSession, say } from "./native-harness"
import { createTuiControl } from "../src/tui-control"

const ids = createIdFactory()
const stores: Store[] = [], dirs: string[] = []
function quotaEvent(store: Store, now: number, usedPercent: number, resetsAt = 100_000, provider = "codex") {
  return store.globalSink.append({ type: "quota.snapshot", provider, windows: [{ id: "5h", label: "5h", usedPercent, resetsAt }], fetchedAt: now, source: "fake" }) as Extract<GlobalEvent, { type: "quota.snapshot" }>
}
function fixture(subscription = true, enabled = true) {
  const dir = mkdtempSync(path.join(tmpdir(), "limit-cases-"))
  dirs.push(dir)
  let now = 1000
  const store = openStore({ dir, now: () => now })
  stores.push(store)
  store.settings.set({ tier: "balanced" })
  const sessionId = ids("session"), turnId = ids("turn")
  store.createSession({ id: sessionId, directory: dir, title: "fake subscription" })
  store.engineMessages.save(sessionId, "native", [{ role: "user", content: "finish the parser; preserve compatibility and ‹secret:1›" }])
  let notices = 0
  const service = createLimitCheckpoint(store, () => now, () => { notices++ }, () => subscription, () => enabled)
  service.observe({ type: "usage.recorded", sessionId, turnId, provider: "chatgpt", model: "fake", input: 10, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, seq: 1, at: now })
  return { dir, store, sessionId, service, now: () => now, advance: () => { now += 1000 }, notices: () => notices }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test("90% checkpoint is bounded, durable, once per window, and never rewrites the full history", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "limit-checkpoint-"))
  dirs.push(dir)
  let now = 1000
  const open = () => {
    const store = openStore({ dir, now: () => now })
    stores.push(store)
    return store
  }
  const store = open()
  store.settings.set({ tier: "balanced" })
  const sessionId = ids("session"), turnId = ids("turn")
  store.createSession({ id: sessionId, directory: dir, title: "limit" })
  const messages = Array.from({ length: 40 }, (_, n) => ({ role: "user", content: `request ${n}: preserve constraints and secret marker ‹secret:1›` }))
  store.engineMessages.save(sessionId, "native", messages)
  const service = createLimitCheckpoint(store, () => now)
  const usage: SessionEvent = { type: "usage.recorded", sessionId, turnId, provider: "codex", model: "fake", input: 10, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, seq: 1, at: now }
  service.observe(usage)
  const quota = (usedPercent: number, resetsAt = 2000) => store.globalSink.append({ type: "quota.snapshot", provider: "codex", windows: [{ id: "5h", label: "5h", usedPercent, resetsAt }], fetchedAt: now, source: "fake" })
  quota(89)
  const ended: SessionEvent = { type: "turn.completed", sessionId, turnId, seq: 2, at: now }
  service.observe(ended)
  expect(store.limitCheckpoints.get(sessionId)).toBeUndefined()
  quota(90)
  service.observe(ended)
  const checkpoint = store.limitCheckpoints.get(sessionId)!
  expect(checkpoint.summary).toContain("request 39")
  expect(checkpoint.summary).toContain("‹secret:1›")
  expect(checkpoint.summary.length).toBeLessThanOrEqual(16_000)
  expect(store.engineMessages.load(sessionId, "native")).toEqual(messages)
  now = 1100
  service.observe(ended)
  expect(store.limitCheckpoints.get(sessionId)?.at).toBe(1000)
  store.usagePauses.put({ sessionId, turnId, provider: "fake", state: "scheduled", resetsAt: 2000, message: "limit reached", createdAt: 1000, updatedAt: 1000 })
  stores.splice(stores.indexOf(store), 1)
  store.close()
  const restarted = open()
  expect(restarted.limitCheckpoints.get(sessionId)).toEqual(checkpoint)
  expect(restarted.engineMessages.load(sessionId, "native")).toEqual(messages)
  createLimitCheckpoint(restarted, () => now, () => { throw new Error("duplicate after restart") }).quota(quotaEvent(restarted, now, 99, 2000))
  now = 2000 + RESET_GRACE_MS
  let resumed = 0
  const timer = { cancel() {} }
  const manager = createUsageLimit({ store: restarted, clock: { now: () => now, setTimer: () => timer }, emit: () => {}, quotas: () => restarted.latestQuota(), resume: async () => {
    resumed++
    return true
  }, log: () => {} })
  manager.recover()
  await new Promise((resolve) => setTimeout(resolve, 0))
  manager.recover()
  expect(resumed).toBe(1)
  manager.dispose()
  restarted.deleteSession(sessionId)
  expect(restarted.limitCheckpoints.get(sessionId)).toBeUndefined()
})

test("a deleted session is dropped from quota tracking; the next quota snapshot still serves the other sessions", () => {
  const { dir, store, sessionId, service, now } = fixture()
  const other = ids("session")
  store.createSession({ id: other, directory: dir, title: "survivor" })
  store.engineMessages.save(other, "native", [{ role: "user", content: "keep working" }])
  service.observe({ type: "usage.recorded", sessionId: other, turnId: ids("turn"), provider: "chatgpt", model: "fake", input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, seq: 1, at: now() })
  store.deleteSession(sessionId)
  // The snapshot arrives with the response headers of any later turn: a throw here fails that turn.
  expect(() => service.quota(quotaEvent(store, now(), 95))).not.toThrow()
  expect(store.limitCheckpoints.state(sessionId)).toBeUndefined()
  expect(store.limitCheckpoints.get(other)?.summary).toContain("keep working")
  // The deleted session stays forgotten on the following snapshots and on a late turn end.
  expect(() => service.quota(quotaEvent(store, now(), 96))).not.toThrow()
  expect(() => service.observe({ type: "turn.cancelled", sessionId, turnId: ids("turn"), seq: 2, at: now() } as SessionEvent)).not.toThrow()
  expect(store.limitCheckpoints.tracked()).toEqual([other])
})

test("deleting a parent or its sub-agent child leaves quota tracking working for the one that remains", () => {
  for (const victim of ["parent", "child"] as const) {
    const { dir, store, sessionId, service, now } = fixture()
    const child = ids("session")
    store.createSession({ id: child, directory: dir, title: "sub-agent", parentId: sessionId })
    service.observe({ type: "usage.recorded", sessionId: child, turnId: ids("turn"), provider: "chatgpt", model: "fake", input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, seq: 1, at: now() })
    const [gone, kept] = victim === "parent" ? [sessionId, child] : [child, sessionId]
    store.deleteSession(gone)
    expect(() => service.quota(quotaEvent(store, now(), 95))).not.toThrow()
    expect(store.limitCheckpoints.tracked()).toEqual([kept])
    expect(store.limitCheckpoints.state(kept)?.used).not.toEqual({})
  }
})

test("minimalist checkpointing stays off", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "limit-min-"))
  dirs.push(dir)
  const store = openStore({ dir })
  stores.push(store)
  store.settings.set({ tier: "minimalist" })
  const sessionId = ids("session")
  store.createSession({ id: sessionId, directory: dir, title: "min" })
  store.engineMessages.save(sessionId, "native", [{ role: "user", content: "private work" }])
  const service = createLimitCheckpoint(store, () => 1000)
  service.observe({ type: "usage.recorded", sessionId, turnId: ids("turn"), provider: "codex", model: "fake", input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, seq: 1, at: 0 })
  service.quota(quotaEvent(store, 1000, 95))
  expect(store.limitCheckpoints.get(sessionId)).toBeUndefined()
})

test("projected burn checkpoints during a turn before 90%, including restart between samples", () => {
  const h = fixture()
  h.service.quota(quotaEvent(h.store, h.now(), 50))
  expect(h.store.limitCheckpoints.get(h.sessionId)).toBeUndefined()
  h.store.close()
  stores.splice(stores.indexOf(h.store), 1)
  h.advance()
  const restarted = openStore({ dir: h.dir, now: h.now })
  stores.push(restarted)
  let notices = 0
  const service = createLimitCheckpoint(restarted, h.now, () => { notices++ })
  const before = restarted.engineMessages.load(h.sessionId, "native")
  const quota = quotaEvent(restarted, h.now(), 80)
  service.quota(quota)
  expect(restarted.limitCheckpoints.get(h.sessionId)?.checkpoint).toMatchObject({ generation: 1, method: "incremental" })
  expect(restarted.limitCheckpoints.get(h.sessionId)?.summary).toContain("preserve compatibility")
  expect(restarted.engineMessages.load(h.sessionId, "native")).toEqual(before)
  service.quota(quota)
  expect(notices).toBe(1)
})

test("each simultaneous window triggers once and its new reset re-arms independently", () => {
  const h = fixture()
  const refresh = (a: number, b: number, reset = 100_000) => {
    h.advance()
    h.service.quota(h.store.globalSink.append({ type: "quota.snapshot", provider: "codex", windows: [{ id: "5h", label: "5h", usedPercent: a, resetsAt: reset }, { id: "7d", label: "7d", usedPercent: b, resetsAt: 900_000 }], fetchedAt: h.now(), source: "fake" }))
  }
  refresh(90, 80)
  refresh(91, 90)
  expect(h.notices()).toBe(2)
  refresh(92, 91)
  expect(h.notices()).toBe(2)
  h.service.quota({ ...quotaEvent(h.store, h.now(), 92), windows: [] })
  refresh(92, 91)
  expect(h.notices()).toBe(2)
  refresh(90, 92, 200_000)
  expect(h.notices()).toBe(3)
})

test("fresh compaction is reused without a checkpoint write or notice", () => {
  const h = fixture()
  h.store.engineMessages.replace(h.sessionId, "native", [{ role: "user", content: "[Summary] existing", compaction: { version: 1, generation: 3, method: "incremental", tailTurns: 1, tailMessages: 1 } }, { role: "user", content: "preserved request" }])
  h.service.quota(quotaEvent(h.store, h.now(), 90))
  expect(h.store.limitCheckpoints.get(h.sessionId)).toBeUndefined()
  expect(h.notices()).toBe(0)
  expect(h.store.limitCheckpoints.state(h.sessionId)?.saved).toHaveLength(1)
  // Assistant/tool progress within the same user turn also makes the checkpoint stale.
  h.store.engineMessages.save(h.sessionId, "native", [...h.store.engineMessages.load(h.sessionId, "native"), { role: "assistant", content: "new progress", toolCalls: [] }])
  h.advance()
  h.service.quota(quotaEvent(h.store, h.now(), 90, 200_000))
  expect(h.store.limitCheckpoints.get(h.sessionId)?.checkpoint.generation).toBe(4)
  expect(h.notices()).toBe(1)
})

test("API billing, setting off, tier override, credits, stale and unknown windows never checkpoint", () => {
  for (const [subscription, enabled] of [[false, true], [true, false]]) {
    const h = fixture(subscription, enabled)
    h.service.quota(quotaEvent(h.store, h.now(), 99))
    expect(h.store.limitCheckpoints.get(h.sessionId)).toBeUndefined()
  }
  const h = fixture()
  h.store.settings.set({ features: { limit_checkpoint: false } })
  h.service.quota(quotaEvent(h.store, h.now(), 99))
  expect(h.store.limitCheckpoints.get(h.sessionId)).toBeUndefined()
  h.store.settings.set({ features: { limit_checkpoint: true } })
  for (const patch of [{ provider: "api" }, { credits: { unit: "usd" as const, remaining: 10 } }, { fetchedAt: 1001 }, { windows: [{ id: "unknown", label: "unknown", usedPercent: 99 }] }]) {
    h.service.quota({ ...quotaEvent(h.store, h.now(), 99), ...patch })
    expect(h.store.limitCheckpoints.get(h.sessionId)).toBeUndefined()
  }
})

test("daemon publishes in sequence, honors customize, and replays one checkpoint after restart without compaction", async () => {
  const h = await boot({ provider: { id: "chatgpt" }, steps: [answer("first answer", { input: 10, output: 10 }), answer("second answer", { input: 10, output: 10 })] })
  let restarted: Awaited<ReturnType<typeof boot>> | undefined
  try {
    await h.client.send({ type: "settings.set", patch: { tier: "balanced" } })
    const sessionId = await openSession(h)
    quotaEvent(h.store, Date.now(), 95, Date.now() + 60_000)
    createTuiControl(h.dir).run({ operation: "apply", profile: { limitCheckpoint: false } })
    await say(h, sessionId, "preserve compatibility")
    expect(h.store.limitCheckpoints.get(sessionId)).toBeUndefined()
    createTuiControl(h.dir).run({ operation: "apply", profile: { limitCheckpoint: true } })
    await say(h, sessionId, "finish verification")
    const checkpoint = h.store.limitCheckpoints.get(sessionId)!
    expect(checkpoint.summary).toContain("finish verification")
    expect(h.events.filter((event) => event.type === "limit.checkpoint")).toHaveLength(1)
    expect(h.events.filter((event) => event.type === "turn.completed")).toHaveLength(2)
    expect(h.requests).toHaveLength(2)
    const messages = h.store.engineMessages.load(sessionId, "native")
    expect(messages).toHaveLength(4)
    h.client.close()
    await h.daemon.stop()
    restarted = await boot({ dir: h.dir, project: h.project, provider: { id: "chatgpt" }, steps: [answer("resumed", { input: 10, output: 10 })] })
    await restarted.client.subscribe(sessionId, 0)
    await say(restarted, sessionId, "continue")
    expect(restarted.store.limitCheckpoints.get(sessionId)).toEqual(checkpoint)
    expect(restarted.events.filter((event) => event.type === "limit.checkpoint")).toHaveLength(1)
    expect(restarted.requests).toHaveLength(1)
    expect(restarted.requests[0]!.messages).toEqual(expect.arrayContaining(messages))
  } finally {
    await restarted?.cleanup()
    await h.cleanup()
  }
})
