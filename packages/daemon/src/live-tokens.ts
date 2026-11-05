import type { Clock } from "@mendcode/kernel"
import type { GlobalEvent, SessionId, TurnId } from "@mendcode/protocol"

export type TurnTokensEvent = Extract<GlobalEvent, { type: "turn.tokens" }>

/** At most one push per session in this window. */
export const LIVE_TOKENS_MIN_INTERVAL_MS = 250

/**
 * Rate-limits the live output-token count of running turns: never stored, one push per session per 250 ms, the newest figure delivered when
 * the window ends. A 0 (a usage record took the figures, or the turn ended) goes out at once and drops anything still waiting, so a late
 * figure never lands over the record.
 */
export function createLiveTokens(input: { clock: Clock; emit(event: TurnTokensEvent): void; minIntervalMs?: number }) {
  const interval = input.minIntervalMs ?? LIVE_TOKENS_MIN_INTERVAL_MS
  const sessions = new Map<SessionId, { lastAt: number; sent: number; pending?: { turnId: TurnId; output: number }; timer?: { cancel(): void } }>()

  function send(sessionId: SessionId, turnId: TurnId, output: number) {
    const known = sessions.get(sessionId)
    if (known) { known.lastAt = input.clock.now(); known.sent = output }
    input.emit({ type: "turn.tokens", gseq: 0, at: input.clock.now(), sessionId, turnId, output })
  }

  function drop(sessionId: SessionId) {
    const known = sessions.get(sessionId)
    known?.timer?.cancel()
    if (known) { delete known.timer; delete known.pending }
  }

  return {
    push(sessionId: SessionId, turnId: TurnId, output: number) {
      const now = input.clock.now()
      const known = sessions.get(sessionId)
      if (!known) {
        // Nothing was shown for this session: a 0 has nothing to clear.
        if (output === 0) return
        sessions.set(sessionId, { lastAt: now, sent: output })
        return send(sessionId, turnId, output)
      }
      if (output === 0) {
        drop(sessionId)
        if (known.sent === 0) return
        return send(sessionId, turnId, 0)
      }
      if (output === known.sent && !known.pending) return
      if (now - known.lastAt >= interval) {
        drop(sessionId)
        return send(sessionId, turnId, output)
      }
      known.pending = { turnId, output }
      if (known.timer) return
      known.timer = input.clock.setTimer(interval - (now - known.lastAt), () => {
        const pending = known.pending
        delete known.timer
        delete known.pending
        if (pending) send(sessionId, pending.turnId, pending.output)
      })
    },
    /** Drops a deleted session's timer and history. */
    forget(sessionId: SessionId) {
      drop(sessionId)
      sessions.delete(sessionId)
    },
  }
}
