import type { MessageRevision, SessionEvent } from "./events"

/** Projects immutable item events through the latest revision, including pages predating that revision. */
export function projectMessageEvent(event: SessionEvent, revision: MessageRevision | undefined): SessionEvent | undefined {
  if (!revision || event.type === "message.revised") return event
  if (event.type !== "item.started" && event.type !== "item.delta" && event.type !== "item.completed") return event
  if (revision.deleted || event.type === "item.delta") return undefined
  if (event.type === "item.completed") return { ...event, ...revision.snapshot }
  return event
}

export function revisedEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const latest = new Map<string, MessageRevision>()
  for (const event of events) if (event.type === "message.revised") latest.set(event.itemId, event)
  return events.flatMap((event) => {
    const projected = projectMessageEvent(event, "itemId" in event && event.itemId ? latest.get(event.itemId) : undefined)
    return projected ? [projected] : []
  })
}
