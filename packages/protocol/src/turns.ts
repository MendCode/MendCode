import type { SessionEvent } from "./events"
import { revisedEvents } from "./message-projection"

/**
 * Turns the user undid: a `turn.reverted` with no later `turn.restored`. The log is append-only, so a client (or any
 * reader of the events) hides these turns instead of the store deleting them.
 */
export function revertedTurnIds(events: Iterable<SessionEvent>): Set<string> {
  const reverted = new Set<string>()
  for (const event of events) {
    if (event.type === "turn.reverted") reverted.add(event.turnId)
    else if (event.type === "turn.restored") reverted.delete(event.turnId)
  }
  return reverted
}

/**
 * The events a transcript shows: everything except the events of undone turns (turn, item, request and usage events
 * of those turns) and the `turn.reverted` / `turn.restored` markers themselves. Deltas and request resolutions carry
 * no turn id, so they follow their item or request. Events of no turn (session, queue, permission) always stay.
 */
export function visibleEvents(events: readonly SessionEvent[]): SessionEvent[] {
  events = revisedEvents(events)
  const reverted = revertedTurnIds(events)
  // No marker at all (the common case): nothing to hide.
  if (reverted.size === 0 && !events.some((event) => event.type === "turn.restored")) return [...events]
  const itemTurn = new Map<string, string>()
  const requestTurn = new Map<string, string>()
  const out: SessionEvent[] = []
  for (const event of events) {
    let turnId: string | undefined
    switch (event.type) {
      case "turn.reverted":
      case "turn.restored":
        continue
      case "item.started":
        itemTurn.set(event.itemId, event.turnId)
        turnId = event.turnId
        break
      case "item.delta":
      case "item.completed":
        turnId = itemTurn.get(event.itemId)
        break
      case "server.request":
        requestTurn.set(event.requestId, event.turnId)
        turnId = event.turnId
        break
      case "server.request.resolved":
        turnId = requestTurn.get(event.requestId)
        break
      case "turn.started":
      case "turn.completed":
      case "turn.cancelled":
      case "turn.interrupted":
      case "turn.retrying":
      case "turn.failed":
      case "usage.recorded":
        turnId = event.turnId
        break
    }
    if (turnId === undefined || !reverted.has(turnId)) out.push(event)
  }
  return out
}
