import type { GlobalEvent, SessionEvent } from "@mendcode/protocol"

export type Violation = { invariant: string; message: string; seq?: number }

const BUSY = new Set(["generating", "tool", "waiting_approval", "compacting", "cancelling"])
const TERMINAL = new Set(["turn.completed", "turn.cancelled", "turn.interrupted", "turn.failed"])

/**
 * Checks a session's event log against the session invariants (one active turn, terminal events close it…) that
 * are observable from events alone. Pure function: same log, same violations.
 */
export function checkSessionLog(events: SessionEvent[], options: { final?: boolean } = {}): Violation[] {
  const violations: Violation[] = []
  let activeTurn: string | undefined
  const openItems = new Map<string, string>()
  const itemTurn = new Map<string, string>()
  const openRequests = new Set<string>()
  const resolvedRequests = new Set<string>()
  const startedQueueIds = new Set<string>()
  let lastState = "idle"

  events.forEach((event, index) => {
    if (event.seq !== index + 1) violations.push({ invariant: "I4", message: `seq ${event.seq} at position ${index + 1}`, seq: event.seq })
    switch (event.type) {
      case "turn.started":
        if (activeTurn) violations.push({ invariant: "I1", message: `turn ${event.turnId} started while ${activeTurn} active`, seq: event.seq })
        if (startedQueueIds.has(event.queueId)) violations.push({ invariant: "I9", message: `queue item ${event.queueId} started twice`, seq: event.seq })
        startedQueueIds.add(event.queueId)
        activeTurn = event.turnId
        break
      case "item.started":
        if (event.turnId !== activeTurn) violations.push({ invariant: "I1", message: `item for inactive turn ${event.turnId}`, seq: event.seq })
        openItems.set(event.itemId, event.turnId)
        itemTurn.set(event.itemId, event.turnId)
        break
      case "item.delta":
        if (!openItems.has(event.itemId)) violations.push({ invariant: "I4", message: `delta for closed item ${event.itemId}`, seq: event.seq })
        break
      case "item.completed":
        if (!openItems.delete(event.itemId)) violations.push({ invariant: "I4", message: `completion for unknown/closed item ${event.itemId}`, seq: event.seq })
        break
      case "server.request":
        if (event.turnId !== activeTurn) violations.push({ invariant: "I7", message: `request for inactive turn`, seq: event.seq })
        openRequests.add(event.requestId)
        break
      case "server.request.resolved":
        if (resolvedRequests.has(event.requestId)) violations.push({ invariant: "I9", message: `request ${event.requestId} resolved twice`, seq: event.seq })
        if (!openRequests.delete(event.requestId)) violations.push({ invariant: "I7", message: `resolution for unknown request`, seq: event.seq })
        resolvedRequests.add(event.requestId)
        break
      case "foreground.state":
        lastState = event.state
        if (BUSY.has(event.state) && !activeTurn) violations.push({ invariant: "I3", message: `foreground ${event.state} with no active turn`, seq: event.seq })
        if (!BUSY.has(event.state) && activeTurn) violations.push({ invariant: "I3", message: `foreground ${event.state} while turn ${activeTurn} active`, seq: event.seq })
        break
      default:
        if (TERMINAL.has(event.type) && "turnId" in event) {
          if (event.turnId !== activeTurn) violations.push({ invariant: "I1", message: `terminal event for inactive turn ${event.turnId}`, seq: event.seq })
          for (const [itemId, turnId] of openItems) {
            if (turnId === event.turnId) violations.push({ invariant: "I6", message: `item ${itemId} still open at turn end`, seq: event.seq })
          }
          for (const requestId of openRequests) violations.push({ invariant: "I7", message: `request ${requestId} still open at turn end`, seq: event.seq })
          activeTurn = undefined
        }
    }
  })

  if (options.final) {
    if (activeTurn) violations.push({ invariant: "I6", message: `turn ${activeTurn} never ended` })
    if (BUSY.has(lastState)) violations.push({ invariant: "I2", message: `final foreground state ${lastState}` })
  }
  return violations
}

/** Job events must never reference a session or foreground state (I3). */
export function checkGlobalLog(events: GlobalEvent[]): Violation[] {
  const violations: Violation[] = []
  events.forEach((event, index) => {
    if (event.gseq !== index + 1) violations.push({ invariant: "I4", message: `gseq ${event.gseq} at position ${index + 1}` })
    if ("sessionId" in event || "foregroundState" in event) violations.push({ invariant: "I3", message: `global event references session state` })
  })
  return violations
}
