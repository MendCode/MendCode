import { EVENTS_PAGE_DEFAULT, EVENTS_PAGE_MAX, MAX_FRAME_BYTES, type EventsWindow, type SessionEvent, type SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"

/** What the ack keeps free for the frame around the events. */
const FRAME_HEADROOM = 4_096

/** Events whose turn is known from their place in the log: they belong to the turn that started last before them. */
const TURN_EVENTS: ReadonlySet<SessionEvent["type"]> = new Set([
  "turn.started",
  "turn.completed",
  "turn.cancelled",
  "turn.interrupted",
  "turn.retrying",
  "turn.failed",
  "item.started",
  "item.delta",
  "item.completed",
  "server.request",
  "server.request.resolved",
  "usage.recorded",
])

/**
 * A window of a session's event log for `session.events`. The store appends one turn at a time, so a turn's events are
 * the ones between its `turn.started` and the next turn's: an event is hidden as undone when the turn covering its seq
 * is currently reverted (which needs no event before the window, unlike reading `turn.reverted` markers). The markers
 * themselves are never returned, like `visibleEvents`.
 */
export function readEventsWindow(input: { store: Store; sessionId: SessionId; before?: number | undefined; after?: number | undefined; limit?: number | undefined; includeReverted?: boolean | undefined }): EventsWindow {
  const { store, sessionId } = input
  const limit = Math.min(input.limit ?? EVENTS_PAGE_DEFAULT, EVENTS_PAGE_MAX)
  const forward = input.after !== undefined
  const fetched = forward ? store.readAfter(sessionId, input.after!, limit) : store.readBefore(sessionId, input.before, limit)
  const raw = fitFrame(fetched, forward, (event) => store.messages.project([event])[0])
  const sessionLastSeq = store.lastSeq(sessionId) ?? 0
  const firstSeq = raw[0]?.seq ?? (forward ? (input.after ?? 0) : (input.before ?? 0))
  const lastSeq = raw.at(-1)?.seq ?? (forward ? (input.after ?? 0) : (input.before ?? 0))
  const more = forward ? lastSeq < sessionLastSeq : raw.length > 0 && store.readBefore(sessionId, firstSeq, 1).length > 0
  const projected = store.messages.project(raw)
  return { events: input.includeReverted ? projected : withoutUndone(store, sessionId, projected), firstSeq, lastSeq, more, sessionLastSeq }
}

/** Cuts the window to what one frame can carry, keeping the end nearest the cursor: the newest events when paging backwards, the oldest when forwards. */
function fitFrame(events: SessionEvent[], forward: boolean, project: (event: SessionEvent) => SessionEvent | undefined): SessionEvent[] {
  const budget = MAX_FRAME_BYTES - FRAME_HEADROOM
  const order = forward ? events : [...events].reverse()
  let used = 0
  let keep = 0
  for (const event of order) {
    used += Buffer.byteLength(JSON.stringify(project(event) ?? null)) + 1
    if (used > budget && keep > 0) break
    keep++
  }
  return keep === events.length ? events : forward ? events.slice(0, keep) : events.slice(events.length - keep)
}

function withoutUndone(store: Store, sessionId: SessionId, events: SessionEvent[]): SessionEvent[] {
  const visible = events.filter((event) => event.type !== "turn.reverted" && event.type !== "turn.restored")
  if (!visible.length) return visible
  // Only the turns covering this window decide what it hides: a page reads a few turns, not the session's every turn.
  const turns = store.turns.covering(sessionId, visible[0]!.seq, visible.at(-1)!.seq)
  if (!turns.some((turn) => turn.reverted)) return visible
  // Turns and events are both in ascending seq, so one pointer walks the turns.
  let at = -1
  return visible.filter((event) => {
    while (turns[at + 1] && turns[at + 1]!.seq <= event.seq) at++
    return !TURN_EVENTS.has(event.type) || at < 0 || !turns[at]!.reverted
  })
}
