import { createIdFactory, type GlobalEvent, type ItemId, type QueueId, type SessionEvent, type TurnId } from "@mendcode/protocol"
import {
  createJobScheduler,
  createResourceRegistry,
  createScope,
  createSessionActor,
  createVirtualClock,
  type EngineEvent,
  type EnginePort,
  type GlobalEventDraft,
  type SessionEventDraft,
  type TurnOutcome,
} from "@mendcode/kernel"
import { checkGlobalLog, checkSessionLog, type Violation } from "./invariants"

/** Small, fast, seedable PRNG (mulberry32). Same seed → same interleaving. */
export function createRng(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    chance: (p: number) => next() < p,
    pick<T>(items: readonly T[]): T | undefined {
      return items.length === 0 ? undefined : items[Math.floor(next() * items.length)]
    },
  }
}

export type SimFaults = {
  /** Reproduces v1's FC-01 class: a background job writes the session's foreground state directly. */
  jobWritesForeground?: boolean
}

export type SimResult = { seed: number; steps: string[]; violations: Violation[]; events: SessionEvent[]; globals: GlobalEvent[] }

type RunningEngineTurn = {
  turnId: TurnId
  phase: "turn" | "compaction"
  ignoreAbort: boolean
  emit(event: EngineEvent): void
  newItemId(): ItemId
  ask?: (request: { kind: "approval" | "question"; title: string; detail: string }) => Promise<unknown>
  openItems: ItemId[]
  finish(outcome: TurnOutcome): void
  done: boolean
}

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * Randomly interleaves user commands, engine progress, approvals, interruptions, clock jumps and
 * background Dream jobs against one SessionActor and one JobScheduler, then checks invariants.
 */
export async function simulate(input: { seed: number; steps?: number; faults?: SimFaults; cancelGraceMs?: number }): Promise<SimResult> {
  const rng = createRng(input.seed)
  const stepsToRun = input.steps ?? 60
  const cancelGraceMs = input.cancelGraceMs ?? 2_000
  const clock = createVirtualClock(1_790_000_000_000)
  let idSeed = input.seed
  const ids = createIdFactory({ now: () => clock.now(), random: (n) => Uint8Array.from({ length: n }, () => (idSeed = (idSeed * 1103515245 + 12345) >>> 0) % 256) })
  const registry = createResourceRegistry()
  const root = createScope({ name: "sim", clock, registry })
  const events: SessionEvent[] = []
  const globals: GlobalEvent[] = []
  let seq = 0
  let gseq = 0
  const sink = { append: (draft: SessionEventDraft) => { const e = { ...draft, seq: ++seq, at: clock.now() } as SessionEvent; events.push(e); return e } }
  const globalSink = { append: (draft: GlobalEventDraft) => { const e = { ...draft, gseq: ++gseq, at: clock.now() } as GlobalEvent; globals.push(e); return e } }

  const engineTurns: RunningEngineTurn[] = []
  let compactNext = false
  function track(phase: "turn" | "compaction", turnId: TurnId, signal: AbortSignal, emit: (e: EngineEvent) => void, newItemId: () => ItemId, ask?: RunningEngineTurn["ask"]) {
    return new Promise<TurnOutcome>((resolve) => {
      const turn: RunningEngineTurn = {
        turnId, phase, emit, newItemId, openItems: [], done: false,
        ignoreAbort: rng.chance(0.25),
        finish: (outcome) => { if (!turn.done) { turn.done = true; resolve(outcome) } },
        ...(ask ? { ask } : {}),
      }
      engineTurns.push(turn)
      signal.addEventListener("abort", () => { if (!turn.ignoreAbort) turn.finish({ status: "ok" }) }, { once: true })
    })
  }
  const engine: EnginePort = {
    runTurn: (t) => track("turn", t.turnId, t.signal, t.emit, t.newItemId, t.ask),
    needsCompaction: () => { const v = compactNext; compactNext = false; return v },
    compact: (t) => track("compaction", t.turnId, t.signal, t.emit, t.newItemId),
  }

  const sessionId = ids("session")
  const clientA = ids("client")
  const clientB = ids("client")
  const scheduler = createJobScheduler({ clock, scope: root.child("jobs"), sink: globalSink, ids })
  const actor = createSessionActor({
    sessionId, clock, scope: root.child("session"), engine, sink, ids, cancelGraceMs,
    onForeground: (state) => scheduler.setForegroundBusy(sessionId, !["idle", "queued", "error"].includes(state)),
  })

  const steps: string[] = []
  const violations: Violation[] = []
  let texts = 0
  let cancelledAt: { turnId: TurnId; at: number } | undefined

  const live = () => engineTurns.filter((t) => !t.done)
  const pendingRequests = () => {
    const open = new Set<string>()
    for (const e of events) {
      if (e.type === "server.request") open.add(e.requestId)
      if (e.type === "server.request.resolved") open.delete(e.requestId)
    }
    return [...open]
  }

  const actions: Array<[number, () => Promise<string | undefined>]> = [
    [3, async () => { await actor.handle({ id: ids("command"), clientId: rng.chance(0.5) ? clientA : clientB, type: "user.submit", sessionId, text: `msg-${++texts}`, attachments: [] }); return `submit msg-${texts}` }],
    [1, async () => {
      const current = actor.snapshot().turnId
      const turnId = current && rng.chance(0.8) ? current : ids("turn")
      const result = await actor.handle({ id: ids("command"), clientId: clientA, type: "turn.cancel", sessionId, turnId })
      if (result.ok && turnId === current && !cancelledAt) cancelledAt = { turnId, at: clock.now() }
      return `cancel ${turnId === current ? "active" : "stale"} → ${result.ok ? "ok" : result.code}`
    }],
    [1, async () => {
      const queueId = rng.pick(actor.snapshot().queue) as QueueId | undefined
      if (!queueId) return undefined
      await actor.handle({ id: ids("command"), clientId: clientB, type: "queue.promote", sessionId, queueId })
      return `promote ${queueId}`
    }],
    [0.5, async () => {
      const queueId = rng.pick(actor.snapshot().queue) as QueueId | undefined
      if (!queueId) return undefined
      await actor.handle({ id: ids("command"), clientId: clientA, type: "queue.remove", sessionId, queueId })
      return `remove ${queueId}`
    }],
    [1.5, async () => {
      const requestId = rng.pick(pendingRequests())
      if (!requestId) return undefined
      const r = await actor.handle({ id: ids("command"), clientId: rng.chance(0.5) ? clientA : clientB, type: "request.resolve", sessionId, requestId: requestId as never, decision: rng.chance(0.5) ? { kind: "approve", scope: "once" } : { kind: "deny" } })
      return `resolve → ${r.ok ? "ok" : r.code}`
    }],
    [0.3, async () => { await actor.interrupt(rng.chance(0.5) ? "transport" : "stream_idle"); return "interrupt" }],
    [6, async () => {
      const turn = rng.pick(live())
      if (!turn) return undefined
      const roll = rng.next()
      if (roll < 0.3) {
        const itemId = turn.newItemId()
        turn.openItems.push(itemId)
        turn.emit({ type: "item.started", itemId, kind: rng.chance(0.4) ? "tool_call" : "agent_message" })
        return "engine item.started"
      }
      if (roll < 0.5 && turn.openItems.length) {
        turn.emit({ type: "item.delta", itemId: rng.pick(turn.openItems)!, text: "…" })
        return "engine delta"
      }
      if (roll < 0.65 && turn.openItems.length) {
        const itemId = turn.openItems.splice(rng.int(turn.openItems.length), 1)[0]!
        turn.emit({ type: "item.completed", itemId, status: "ok" })
        return "engine item.completed"
      }
      if (roll < 0.75 && turn.ask) {
        void turn.ask({ kind: "approval", title: "bash", detail: "ls" })
        return "engine ask"
      }
      if (roll < 0.8) compactNext = true
      turn.finish(rng.chance(0.85) ? { status: "ok" } : { status: "error", code: "provider", message: "boom" })
      return `engine finish ${turn.phase}`
    }],
    [1, async () => { const ms = rng.int(cancelGraceMs * 2); clock.advance(ms); return `advance ${ms}ms` }],
    [0.6, async () => {
      scheduler.schedule({
        jobType: "dream", priority: "P5", runAt: clock.now() + rng.int(3_000),
        run: async (ctx) => {
          if (input.faults?.jobWritesForeground) sink.append({ type: "foreground.state", sessionId, state: "generating" })
          await ctx.checkpoint()
        },
      })
      return "schedule dream"
    }],
  ]
  const totalWeight = actions.reduce((sum, [w]) => sum + w, 0)

  for (let i = 0; i < stepsToRun; i++) {
    let roll = rng.next() * totalWeight
    const action = actions.find(([w]) => (roll -= w) < 0)?.[1] ?? actions[0]![1]
    const label = await action()
    await settle()
    if (label) steps.push(label)
    if (cancelledAt && actor.snapshot().turnId === cancelledAt.turnId && clock.now() - cancelledAt.at > cancelGraceMs) {
      violations.push({ invariant: "I6", message: `cancelled turn still active ${clock.now() - cancelledAt.at}ms after cancel` })
      break
    }
    if (actor.snapshot().turnId !== cancelledAt?.turnId) cancelledAt = undefined
  }

  // Drain: let every engine finish, answer nothing more, and let timers fire.
  for (let round = 0; round < 50 && (live().length > 0 || actor.snapshot().turnId); round++) {
    for (const turn of live()) turn.finish({ status: "ok" })
    clock.advance(cancelGraceMs + 1)
    await settle()
  }
  await actor.interrupt("restart")
  for (let round = 0; round < 10; round++) { clock.advance(cancelGraceMs + 1); for (const t of live()) t.finish({ status: "ok" }); await settle() }

  violations.push(...checkSessionLog(events, { final: true }), ...checkGlobalLog(globals))
  const snap = actor.snapshot()
  if (snap.queue.length > 0 && !snap.held) violations.push({ invariant: "I2", message: `queue of ${snap.queue.length} not held and not running` })
  root.dispose()
  if (registry.counters.timers !== 0 || clock.pendingTimers() !== 0) violations.push({ invariant: "I11", message: `timers left after dispose: ${registry.counters.timers}/${clock.pendingTimers()}` })
  return { seed: input.seed, steps, violations, events, globals }
}
