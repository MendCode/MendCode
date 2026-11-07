import type { SessionSummary } from "@mendcode/protocol"
import type { SessionColor } from "@mendcode/protocol/wire"
import { selectSessions, sortSessions, type SessionScope, type SessionSort, type SessionView } from "./session-query"

export { shortenMiddle, truncateEnd } from "./wrap"

/**
 * The /sessions state and the helpers other views share (times, home paths, grouping). The page itself (drawing and keys) is
 * `sessions-page.ts`, loaded when /sessions first opens.
 */

/** Inline modal editing of one row: rename (with a draft title), tags and color, or delete confirmation. */
export type SessionListEdit = { mode: "rename"; sessionId: string; draft: string } | { mode: "tag"; sessionId: string; draft: string } | { mode: "delete"; sessionId: string }

export type SessionListState = {
  /** Position in the selection order; `selectedId` wins while that session is still listed, so pushes that reorder the list do not move it. */
  selected: number
  selectedId?: string
  filter: string
  edit?: SessionListEdit
  note?: string
  archived?: boolean
  sort?: SessionSort
  scope?: SessionScope
  /** The folder the list shows in "project" scope: where MendCode runs (`origin`) or a folder picked with Tab. */
  directory?: string
  /** The folder MendCode runs in, named "this folder". */
  origin?: string
  named?: boolean
  /** Also look in the messages (asked of the daemon); `hits` are its answers for the current filter, session id to a snippet. */
  content?: boolean
  hits?: Record<string, string>
  /** Sessions the daemon found for `foundFor` past the loaded page (title, folder or id). */
  found?: SessionSummary[]
  foundFor?: string
  /** The `?` keys section. */
  keys?: boolean
  /** The folder picker (Tab): its own filter text, selected row and the scope Esc goes back to. */
  folders?: { query: string; selected: number; back?: SessionScope }
}

export type SessionListAction =
  | { type: "none" }
  | { type: "changed" }
  | { type: "open"; sessionId: string }
  | { type: "close" }
  | { type: "rename"; sessionId: string; title: string }
  | { type: "delete"; sessionId: string }
  | { type: "archive"; sessionId: string; restore: boolean }
  | { type: "pin"; sessionId: string; pinned: boolean }
  | { type: "tag"; sessionId: string; tags: string[]; color: SessionColor | null | undefined }
  | { type: "reload" }
  | { type: "search" }

/** A picker opened in `directory` starts on that folder's sessions; without one it lists every project, as before. */
export function createSessionListState(directory?: string): SessionListState {
  return directory ? { selected: 0, filter: "", directory, origin: directory, scope: "project" } : { selected: 0, filter: "" }
}

/** The query language of the picker (words, "phrases", `re:`, `tag:`, `color:`; see session-query.ts); every part must match. */
export function filterSessions(sessions: SessionSummary[], filter: string, view: SessionView = {}): SessionSummary[] {
  return selectSessions(sessions, filter, view)
}

/** The picker's view options held in its state. */
export function viewOf(state: SessionListState): SessionView {
  return { ...(state.sort ? { sort: state.sort } : {}), ...(state.scope ? { scope: state.scope } : {}), ...(state.directory ? { directory: state.directory } : {}), ...(state.named ? { named: true } : {}), ...(state.content && state.hits ? { hits: state.hits } : {}) }
}

/** The loaded sessions plus what the daemon found past them for the current filter, each once. */
export function listedSessions(sessions: SessionSummary[], state: Pick<SessionListState, "filter" | "found" | "foundFor">): SessionSummary[] {
  if (!state.found?.length || !state.filter || state.foundFor !== state.filter) return sessions
  const known = new Set(sessions.map((session) => session.sessionId))
  const extra = state.found.filter((session) => !known.has(session.sessionId))
  return extra.length ? [...sessions, ...extra] : sessions
}

export type SessionGroup = { directory: string; sessions: SessionSummary[]; section?: string }

/**
 * Filtered sessions grouped by project: the open session's project first, then the others by most
 * recent activity (or creation, or name); newest first inside each group unless sorted by name. This is also the selection order.
 */
export function groupSessions(sessions: SessionSummary[], filter: string, currentSessionId?: string, archived = false, view: SessionView = {}): SessionGroup[] {
  const currentDirectory = view.directory ?? sessions.find((session) => session.sessionId === currentSessionId)?.directory
  const byDirectory = new Map<string, SessionSummary[]>()
  for (const session of selectSessions(sessions, filter, view, currentDirectory)) {
    if (!archived && session.archivedAt !== undefined) continue
    const group = byDirectory.get(session.directory)
    if (group) group.push(session)
    else byDirectory.set(session.directory, [session])
  }
  const sort = view.sort ?? "recent"
  const newest = (group: SessionSummary[]) => Math.max(...group.map((session) => sort === "created" ? session.createdAt : session.updatedAt))
  const projects = [...byDirectory.entries()]
    .map(([directory, group]) => ({ directory, sessions: sortSessions(group, sort) }))
    .sort((a, b) => Number(b.directory === currentDirectory) - Number(a.directory === currentDirectory) || (sort === "name" ? a.directory.localeCompare(b.directory) : newest(b.sessions) - newest(a.sessions)))
  return projects.flatMap((project) => ["Pinned", "Active", "Settled"].map((section) => ({ ...project, section, sessions: project.sessions.filter((session) => (session.archivedAt !== undefined ? "Settled" : session.lifecycle?.pinnedAt !== undefined ? "Pinned" : "Active") === section) })).filter((group) => group.sessions.length))
}

/** The selection order: every visible session, group by group. */
export function orderSessions(sessions: SessionSummary[], filter: string, currentSessionId?: string, archived = false, view: SessionView = {}): SessionSummary[] {
  return groupSessions(sessions, filter, currentSessionId, archived, view).flatMap((group) => group.sessions)
}

/** <60s "now", <60m "Nm", <24h "Nh", <14d "Nd", else "Nw". */
export function relativeTime(now: number, then: number) {
  const seconds = Math.max(0, Math.floor((now - then) / 1000))
  if (seconds < 60) return "now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d`
  return `${Math.floor(days / 7)}w`
}

/** `relativeTime` as a past moment: "just now", "5m ago". */
export function timeAgo(now: number, then: number) {
  const time = relativeTime(now, then)
  return time === "now" ? "just now" : `${time} ago`
}

/** `/Users/me/Code/app` → `~/Code/app` when `home` is a prefix. */
export function abbreviateHome(directory: string, home?: string) {
  if (!home) return directory
  const base = home.replace(/\/+$/, "")
  if (directory === base) return "~"
  return directory.startsWith(`${base}/`) ? `~${directory.slice(base.length)}` : directory
}
