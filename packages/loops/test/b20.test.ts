import { expect, test } from "bun:test"
import { createVirtualClock } from "@mendcode/kernel"
import { createIdFactory, Loop, type LoopId, type QueueId, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { createLoopService } from "../src"

const NOW = Date.UTC(2026, 9, 1, 12)
function harness(initial: Loop[] = []) {
  const clock = createVirtualClock(NOW)
  const ids = createIdFactory({ now: clock.now })
  const saved = new Map<LoopId, Loop>(initial.map((loop) => [loop.loopId, loop]))
  const sessions: Array<{ directory: string; readOnly?: boolean }> = []
  const submitted: Array<{ sessionId: SessionId; text: string; queueId: QueueId }> = []
  const service = createLoopService({
    clock, ids,
    store: { all: () => [...saved.values()], save: (loop) => void saved.set(loop.loopId, loop), remove: (id) => void saved.delete(id) },
    createSession(input) { sessions.push(input); return ids("session") },
    async submit(input) { const queueId = ids("queue"); submitted.push({ ...input, queueId }); return { queueId } },
  })
  let seq = 0
  const complete = (status = "continue") => {
    const sent = submitted.at(-1)!
    const turnId = ids("turn"), itemId = ids("item")
    const event = (input: Record<string, unknown>) => service.observe({ at: clock.now(), seq: ++seq, sessionId: sent.sessionId, ...input } as SessionEvent)
    event({ type: "turn.started", turnId, queueId: sent.queueId })
    event({ type: "item.started", turnId, itemId, kind: "agent_message" })
    event({ type: "item.completed", itemId, status: "ok", text: `\`\`\`LOOP_CHECKPOINT\nstatus: ${status}\nsummary: inspected local files\n\`\`\`` })
    event({ type: "turn.completed", turnId })
  }
  return { clock, ids, saved, service, sessions, submitted, complete }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

test("B20 drafts remain disabled across restart and activation schedules from now", () => {
  const h = harness()
  const draft = h.service.create({ name: "watch", directory: "/repo", template: "pr-watch", draft: true })
  expect(draft).toMatchObject({ draft: true, state: "paused", runs: 0, criteria: "PR merged" })
  expect(draft.nextWakeAt).toBeUndefined()
  h.clock.advance(86_400_000)
  expect(h.submitted).toEqual([])
  expect(h.service.runNow(draft.loopId)).toBe(false)
  h.service.dispose()
  const restored = harness([...h.saved.values()])
  restored.service.start()
  expect(restored.submitted).toEqual([])
  const active = restored.service.activate(draft.loopId, "Start watching")!
  expect(active).toMatchObject({ state: "active", reason: "Activated: Start watching" })
  expect(active.draft).toBeUndefined()
  expect(active.nextWakeAt).toBe(NOW)
  expect(active.journal?.map((event) => event.type)).toEqual(["created", "state"])
  expect(Loop.safeParse(active).success).toBe(true)
  restored.service.dispose()
})

test("B20 tick dry-run is immutable, respects due order, project and limit", async () => {
  const first = harness()
  const base = first.service.create({ name: "watch", directory: "/repo", objective: "inspect", trigger: { kind: "manual" }, budget: { mode: "monitor" } })
  first.service.dispose()
  const h = harness([
    { ...base, name: "later", nextWakeAt: NOW - 1 },
    { ...base, loopId: first.ids("loop"), name: "earlier", nextWakeAt: NOW - 10 },
    { ...base, loopId: first.ids("loop"), directory: "/other", nextWakeAt: NOW - 100 },
    { ...base, loopId: first.ids("loop"), state: "paused", nextWakeAt: NOW - 100 },
  ])
  const before = structuredClone([...h.saved.values()])
  const result = await h.service.tick({ directory: "/repo", limit: 1, execute: false, reportOnly: false })
  expect(result).toHaveLength(1)
  expect(result[0]?.summary).toContain("earlier")
  expect(result[0]?.state).toBe("skipped")
  expect([...h.saved.values()]).toEqual(before)
  expect(h.submitted).toEqual([])
  expect(h.sessions).toEqual([])
  h.service.dispose()
})

test("B20 executing tick waits for the checkpoint and refuses duplicate or verifying runs", async () => {
  const h = harness()
  const loop = h.service.create({ name: "watch", directory: "/repo", objective: "inspect", trigger: { kind: "manual" }, budget: { mode: "monitor" } })
  const input = { directory: "/repo", loopId: loop.loopId, limit: 1, execute: true, reportOnly: false }
  let finished = false
  const tick = h.service.tick(input).then((value) => { finished = true; return value })
  await flush()
  expect(finished).toBe(false)
  expect(await h.service.tick(input)).toMatchObject([{ state: "skipped" }])
  expect(h.submitted).toHaveLength(1)
  h.complete()
  expect(await tick).toMatchObject([{ state: "active", run: 1, summary: "inspected local files" }])
  expect(h.service.get(loop.loopId)?.journal?.map((event) => event.type)).toEqual(["created", "run", "checkpoint"])
  h.service.dispose()
  const verifying = harness([{ ...h.service.get(loop.loopId)!, state: "verifying" }])
  expect(verifying.service.runNow(loop.loopId)).toBe(false)
  expect(verifying.submitted).toEqual([])
  verifying.service.dispose()
})

test("B20 one-off report uses a read-only session and cannot complete an editing goal or launch its checks", async () => {
  const h = harness()
  const loop = h.service.create({ name: "repair", directory: "/repo", objective: "fix files", trigger: { kind: "manual" }, budget: { mode: "goal" }, checks: ["bun test"] })
  const tick = h.service.tick({ directory: "/repo", loopId: loop.loopId, limit: 1, execute: true, reportOnly: true })
  await flush()
  expect(h.sessions.at(-1)).toMatchObject({ readOnly: true })
  expect(h.submitted.at(-1)?.sessionId).not.toBe(loop.sessionId)
  expect(h.submitted.at(-1)?.text).toContain("Report-only loop")
  expect(h.submitted.at(-1)?.text).not.toContain("bun test")
  h.complete("complete")
  expect(await tick).toMatchObject([{ state: "active", run: 1 }])
  const after = h.service.get(loop.loopId)!
  expect(after.reportOnly).toBeUndefined()
  expect(after.budget).toEqual(loop.budget)
  expect(after.checks).toEqual(loop.checks)
  expect(after.history[0]?.checkpoint?.status).toBe("continue")
  expect(after.history[0]?.sessionId).toBe(h.submitted[0]?.sessionId)
  h.service.dispose()
})

test("B20 lifecycle journal is bounded with increasing sequence numbers and old records still parse", () => {
  const h = harness()
  const loop = h.service.create({ name: "watch", directory: "/repo", objective: "inspect", trigger: { kind: "manual" }, budget: { mode: "monitor" } })
  for (let i = 0; i < 205; i++) h.service.update(loop.loopId, { name: `watch ${i}` })
  const saved = h.service.get(loop.loopId)!
  expect(saved.journal).toHaveLength(200)
  expect(saved.journal?.[0]?.seq).toBe(7)
  expect(saved.journal?.at(-1)?.seq).toBe(206)
  expect(Loop.safeParse(saved).success).toBe(true)
  const { journal: _journal, draft: _draft, ...legacy } = loop
  expect(Loop.safeParse(legacy).success).toBe(true)
  h.service.dispose()
})

test("B20 tick timeout leaves the running loop inspectable and releases its wait timer", async () => {
  const h = harness()
  const loop = h.service.create({ name: "watch", directory: "/repo", objective: "inspect", trigger: { kind: "manual" }, budget: { mode: "monitor" } })
  const tick = h.service.tick({ directory: "/repo", loopId: loop.loopId, limit: 1, execute: true, reportOnly: false })
  await flush()
  expect(h.clock.pendingTimers()).toBe(1)
  h.clock.advance(15 * 60_000)
  expect(await tick).toMatchObject([{ state: "running", timedOut: true, run: 1 }])
  expect(h.clock.pendingTimers()).toBe(0)
  expect(h.service.get(loop.loopId)?.state).toBe("running")
  h.complete()
  expect(h.service.get(loop.loopId)?.state).toBe("active")
  h.service.dispose()
})

test("B20 daemon disposal interrupts pending ticks without leaving a deadline timer", async () => {
  const h = harness()
  const loop = h.service.create({ name: "watch", directory: "/repo", objective: "inspect", trigger: { kind: "manual" }, budget: { mode: "monitor" } })
  const tick = h.service.tick({ directory: "/repo", loopId: loop.loopId, limit: 1, execute: true, reportOnly: false })
  await flush()
  h.service.dispose()
  expect(await tick).toMatchObject([{ state: "interrupted", summary: "Daemon stopped during the tick" }])
  expect(h.clock.pendingTimers()).toBe(0)
})
