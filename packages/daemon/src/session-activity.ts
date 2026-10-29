import type { Clock } from "@mendcode/kernel"
import type { ForegroundState, GlobalEvent, SessionId } from "@mendcode/protocol"

export type SessionActivityEvent = Extract<GlobalEvent, { type: "session.activity" }>
export type ActivityEntry = { sessionId: SessionId; directory: string; title: string; state: ForegroundState; updatedAt: number; queued?: number; since?: number; tool?: string; pending?: string; paused?: boolean; archivedAt?: number | null; lifecycle?: import("@mendcode/protocol").SessionLifecycle; draft?: import("@mendcode/protocol").SessionDraft | null }

/** At most one event per session in this window. */
export const ACTIVITY_MIN_INTERVAL_MS = 250

const URGENT = new Set<ForegroundState>(["waiting_approval", "error"])

/**
 * Rate-limits session activity pushes. A session's first push, `force`d pushes, and any transition to
 * or from waiting_approval/error go out immediately; everything else is limited to one event per
 * 250 ms, with the newest state delivered when the window ends so a final "idle" is never lost.
 */
export function createActivityThrottle(input: { clock: Clock; emit(event: SessionActivityEvent): void; minIntervalMs?: number }) {
  const interval = input.minIntervalMs ?? ACTIVITY_MIN_INTERVAL_MS
  const sessions = new Map<SessionId, { lastAt: number; lastState: ForegroundState; pending?: ActivityEntry; timer?: { cancel(): void } }>()

  function send(entry: ActivityEntry) {
    input.emit({ type: "session.activity", gseq: 0, at: input.clock.now(), ...entry })
  }

  return {
    push(entry: ActivityEntry, options: { force?: boolean } = {}) {
      const now = input.clock.now()
      const known = sessions.get(entry.sessionId)
      if (!known) {
        sessions.set(entry.sessionId, { lastAt: now, lastState: entry.state })
        return send(entry)
      }
      const transition = entry.state !== known.lastState && (URGENT.has(entry.state) || URGENT.has(known.lastState))
      known.lastState = entry.state
      if (options.force || transition || now - known.lastAt >= interval) {
        known.timer?.cancel()
        delete known.timer
        delete known.pending
        known.lastAt = now
        return send(entry)
      }
      known.pending = entry
      if (known.timer) return
      known.timer = input.clock.setTimer(interval - (now - known.lastAt), () => {
        const pending = known.pending
        delete known.timer
        delete known.pending
        if (!pending) return
        known.lastAt = input.clock.now()
        send(pending)
      })
    },
    /** Drops a deleted session's timer and history. */
    forget(sessionId: SessionId) {
      sessions.get(sessionId)?.timer?.cancel()
      sessions.delete(sessionId)
    },
  }
}
