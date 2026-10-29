import { createIdFactory, type GlobalEvent, type SessionEvent, type TurnId } from "@mendcode/protocol"
import { createVirtualClock } from "../src/clock"
import type { EnginePort, GlobalEventDraft, SessionEventDraft, TurnInput, TurnOutcome } from "../src/ports"
import { createResourceRegistry, createScope } from "../src/scope"

export function createHarness() {
  const clock = createVirtualClock(1_790_000_000_000)
  let seed = 0
  const ids = createIdFactory({ now: () => clock.now(), random: (n) => new Uint8Array(n).fill(seed++ % 32) })
  const registry = createResourceRegistry()
  const root = createScope({ name: "root", clock, registry })
  const events: SessionEvent[] = []
  const globals: GlobalEvent[] = []
  const seqBySession = new Map<string, number>()
  let gseq = 0
  const sink = {
    append(draft: SessionEventDraft) {
      const seq = (seqBySession.get(draft.sessionId) ?? 0) + 1
      seqBySession.set(draft.sessionId, seq)
      const event = { ...draft, seq, at: clock.now() } as SessionEvent
      events.push(event)
      return event
    },
  }
  const globalSink = {
    append(draft: GlobalEventDraft) {
      const event = { ...draft, gseq: ++gseq, at: clock.now() } as GlobalEvent
      globals.push(event)
      return event
    },
  }
  return { clock, ids, registry, root, events, globals, sink, globalSink }
}

/** Lets queued microtasks and resolved promises run. */
export async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

type ManualTurn = { input: TurnInput; finish(outcome?: TurnOutcome): void; phase: "turn" | "compaction" | "shell" }

/** Engine fully driven by the test. `ignoreAbort` simulates an engine that does not stop (I6). */
export function createManualEngine(options: { ignoreAbort?: boolean } = {}) {
  const turns: ManualTurn[] = []
  let compactNext = false
  const engine: EnginePort = {
    runTurn(input) {
      return new Promise<TurnOutcome>((resolve) => {
        turns.push({ input, finish: (outcome = { status: "ok" }) => resolve(outcome), phase: "turn" })
        if (!options.ignoreAbort) input.signal.addEventListener("abort", () => resolve({ status: "ok" }), { once: true })
      })
    },
    runShell(input) {
      return new Promise<TurnOutcome>((resolve) => {
        turns.push({ input, finish: (outcome = { status: "ok" }) => resolve(outcome), phase: "shell" })
        if (!options.ignoreAbort) input.signal.addEventListener("abort", () => resolve({ status: "ok" }), { once: true })
      })
    },
    needsCompaction() {
      const value = compactNext
      compactNext = false
      return value
    },
    compact(input) {
      return new Promise<TurnOutcome>((resolve) => {
        turns.push({
          input: { ...input, text: "", attachments: [], ask: () => Promise.resolve({ kind: "abandoned" }), permissionMode: () => "ask", setPermissionMode: () => {} },
          finish: (outcome = { status: "ok" }) => resolve(outcome),
          phase: "compaction",
        })
        if (!options.ignoreAbort) input.signal.addEventListener("abort", () => resolve({ status: "ok" }), { once: true })
      })
    },
  }
  return {
    engine,
    turns,
    requestCompaction() {
      compactNext = true
    },
    last() {
      const turn = turns.at(-1)
      if (!turn) throw new Error("no turn started")
      return turn
    },
  }
}

export function types(events: SessionEvent[]) {
  return events.map((event) => event.type)
}

export function turnIds(events: SessionEvent[]): TurnId[] {
  return events.flatMap((event) => (event.type === "turn.started" ? [event.turnId] : []))
}
