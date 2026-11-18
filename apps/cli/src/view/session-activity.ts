import type { GlobalEvent, SessionSummary } from "@mendcode/protocol"
import { withPushedDraft } from "./session-label"

export type ActivityEvent = Extract<GlobalEvent, { type: "session.activity" }>

/**
 * One `session.activity` push applied to a session list: a listed session takes the pushed fields in place, an unlisted one joins at
 * the top, and past `cap` the oldest go (`keep`, the open session, stays). The one rule for every list that follows the pushes.
 */
export function mergeActivity(list: SessionSummary[], event: ActivityEvent, { cap, keep }: { cap: number; keep: string }): SessionSummary[] {
  const { sessionId: id, title, directory, state, updatedAt } = event
  const archived = event.archivedAt === null ? { archivedAt: undefined } : event.archivedAt !== undefined ? { archivedAt: event.archivedAt } : {}
  // The live detail of a running turn is replaced by every push: gone from the push means the turn or the request ended.
  const live = { since: event.since, tool: event.tool, pending: event.pending, pendingKind: event.pendingKind, agents: event.agents, compacting: event.compacting }
  const known = list.some((session) => session.sessionId === id)
  // The draft of an untitled session labels it in every list: the push carries it when it appeared, changed its first line or went.
  const merged = known
    ? list.map((session) => (session.sessionId === id ? withPushedDraft({ ...session, ...archived, ...(event.lifecycle ? { lifecycle: event.lifecycle } : {}), title, directory, state, updatedAt, queued: event.queued ?? 0, paused: event.paused === true, ...live }, event.draft) : session))
    : [withPushedDraft({ sessionId: id, ...archived, ...(event.lifecycle ? { lifecycle: event.lifecycle } : {}), title, directory, createdAt: updatedAt, updatedAt, lastSeq: 0, state, queued: event.queued ?? 0, paused: event.paused === true, ...live }, event.draft), ...list]
  return merged.length > cap ? merged.filter((session, at) => at < cap || session.sessionId === keep) : merged
}
