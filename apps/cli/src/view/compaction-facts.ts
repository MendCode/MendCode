import type { SessionEvent } from "@mendcode/protocol"
import { usageContext } from "@mendcode/protocol/wire"
import { compactionFacts } from "./compaction-panel"

/** One model call's token usage; `context` is what the footer counts (input + cache read + output). */
export type UsageSample = { turnId: string; input: number; cacheRead: number; cacheWrite: number; output: number; context: number }

export type CompactionPhase = "capture" | "memory" | "packed"

/** What the live compaction panel knows, taken only from session events. */
export type CompactionSnapshot = {
  active: boolean
  turnId?: string
  reason?: "auto" | "manual"
  phase: CompactionPhase
  startedAt?: number
  endedAt?: number
  method?: string
  tailTurns?: number
  tailTokens?: number
  fallbackReason?: string
  /** The last model call before the compaction: the context it replaces. */
  before?: UsageSample
  /** Output tokens of the model calls the compaction made itself: the written memory. */
  summaryTokens?: number
  /** Context sizes of the most recent calls, oldest first. */
  history: number[]
}

const HISTORY = 24

/**
 * Folds session events into the facts the live compaction panel draws: when the compaction began, its phase, the
 * context the last model call used, the tail it keeps and the tokens the memory call produced. Pure data;
 * events at or below the last seen `seq` are ignored. Nothing is estimated here.
 */
export function createCompactionFacts() {
  let lastSeq = 0
  const calls: UsageSample[] = []
  let current: Omit<CompactionSnapshot, "history"> = { active: false, phase: "capture" }

  function begin(event: SessionEvent & { turnId: string }) {
    if (current.active && current.turnId === event.turnId) return
    const before = calls.at(-1)
    current = { active: true, turnId: event.turnId, phase: "capture", startedAt: event.at, ...(before ? { before } : {}) }
  }

  return {
    apply(event: SessionEvent) {
      if (event.seq <= lastSeq) return
      lastSeq = event.seq
      switch (event.type) {
        case "usage.recorded":
          if (current.active) current = { ...current, summaryTokens: (current.summaryTokens ?? 0) + event.output + event.reasoning }
          else {
            calls.push({ turnId: event.turnId, input: event.input, cacheRead: event.cacheRead, cacheWrite: event.cacheWrite, output: event.output, context: usageContext(event) ?? 0 })
            if (calls.length > 64) calls.shift()
          }
          break
        case "compaction.updated":
          if (event.state === "writing") begin(event)
          else if (current.turnId === event.turnId) current = { ...current, active: false, phase: event.state === "packed" ? "packed" : current.phase, endedAt: event.at }
          if (event.state === "writing") current = { ...current, reason: event.reason }
          break
        case "item.started":
          if (event.kind !== "compaction") break
          begin(event)
          current = { ...current, phase: "memory", ...compactionFacts(event.meta) }
          break
        case "foreground.state":
          if (event.state === "compacting" && event.turnId) begin({ ...event, turnId: event.turnId })
          else if (event.state !== "compacting" && current.active) current = { ...current, active: false, endedAt: event.at }
          break
        case "turn.completed":
        case "turn.cancelled":
        case "turn.interrupted":
        case "turn.failed":
          if (current.active && current.turnId === event.turnId) current = { ...current, active: false, endedAt: event.at }
          break
      }
    },
    snapshot(): CompactionSnapshot {
      return { ...current, history: calls.slice(-HISTORY).map((call) => call.context) }
    },
    /** The last model call, whichever turn it belongs to: the cache figures of the live context. */
    get lastCall(): UsageSample | undefined {
      return calls.at(-1)
    },
  }
}
export type CompactionFactsStore = ReturnType<typeof createCompactionFacts>
