import type { GlobalEvent, SessionSummary } from "@mendcode/protocol"
import { withPushedDraft } from "./session-label"

export type ActivityEvent = Extract<GlobalEvent, { type: "session.activity" }>

/**
 * What a push changes in a session's row, as one comparable string: its state, tool, title, queue, pause, agents, compaction, the request
 * it waits on, its draft, archive or lifecycle. A working session pushes up to four times a second with only its clock moved; those
 * pushes need no frame of their own (the spinner tick redraws the list) and no new list of background work.
 */
export function activityShown(event: ActivityEvent): string {
  return JSON.stringify([event.state, event.tool, event.title, event.queued ?? 0, event.paused === true, event.agents, event.compacting, event.pendingKind, event.pending, event.draft, event.archivedAt, event.lifecycle, event.hub, event.hubDirectory])
}

/** Remembers what each session's last push showed (bounded): `changed` is true for a push that shows something new. */
export function createActivityMemory(max = 500) {
  const shown = new Map<string, string>()
  return {
    changed(event: ActivityEvent): boolean {
      const next = activityShown(event)
      if (shown.get(event.sessionId) === next) return false
      shown.delete(event.sessionId)
      shown.set(event.sessionId, next)
      if (shown.size > max) shown.delete(shown.keys().next().value!)
      return true
    },
  }
}

/**
 * One `session.activity` push applied to a session list: a listed session takes the pushed fields in place, an unlisted one joins at
 * the top, and past `cap` the oldest go (`keep`, the open session, stays). The one rule for every list that follows the pushes.
 */
export function mergeActivity(list: SessionSummary[], event: ActivityEvent, { cap, keep }: { cap: number; keep: string }): SessionSummary[] {
  const { sessionId: id, title, directory, state, updatedAt } = event
  const archived = event.archivedAt === null ? { archivedAt: undefined } : event.archivedAt !== undefined ? { archivedAt: event.archivedAt } : {}
  // The live detail of a running turn is replaced by every push: gone from the push means the turn or the request ended.
  const live = { since: event.since, tool: event.tool, pending: event.pending, pendingKind: event.pendingKind, agents: event.agents, compacting: event.compacting }
  // A copy of a chat the sync hub runs carries the hub's name and folder in every push; a push without them leaves what the list already knows.
  const owner = event.hub ? { hub: event.hub, ...(event.hubDirectory ? { hubDirectory: event.hubDirectory } : {}) } : {}
  const known = list.some((session) => session.sessionId === id)
  // The draft of an untitled session labels it in every list: the push carries it when it appeared, changed its first line or went.
  const merged = known
    ? list.map((session) => (session.sessionId === id ? withPushedDraft({ ...session, ...archived, ...(event.lifecycle ? { lifecycle: event.lifecycle } : {}), title, directory, state, updatedAt, queued: event.queued ?? 0, paused: event.paused === true, ...owner, ...live }, event.draft) : session))
    : [withPushedDraft({ sessionId: id, ...archived, ...(event.lifecycle ? { lifecycle: event.lifecycle } : {}), title, directory, createdAt: updatedAt, updatedAt, lastSeq: 0, state, queued: event.queued ?? 0, paused: event.paused === true, ...owner, ...live }, event.draft), ...list]
  return merged.length > cap ? merged.filter((session, at) => at < cap || session.sessionId === keep) : merged
}
