import type { SessionSummary } from "@mendcode/protocol"
import { sessionActivityAt } from "./session-label"

/**
 * The session picker's query language, shared by the view and the key handler:
 *   plain words      every word must be in the title, folder, tags, agent or model (or the id, 8 characters or more)
 *   "a phrase"       the quoted text, spaces included
 *   re:pattern       the rest of the line is a case-insensitive regular expression
 *   tag:x  color:x   the session has a tag starting with x / that color mark
 * With content search on, the daemon also looks in the messages and the sessions it finds match as well.
 */

export const SESSION_SORTS = ["recent", "created", "name"] as const
export type SessionSort = (typeof SESSION_SORTS)[number]
export type SessionScope = "all" | "project"

export type SessionView = {
  sort?: SessionSort
  scope?: SessionScope
  /** The folder MendCode runs in: "this project" means it (else the open session's folder). */
  directory?: string
  /** Only sessions the user titled (`/rename`). */
  named?: boolean
  /** Message matches by session id, from the daemon; sessions in it match whatever their metadata says. */
  hits?: Readonly<Record<string, string>>
}

export type SessionQuery = { terms: string[]; regex?: RegExp; invalid?: string; tags: string[]; colors: string[] }

const MAX_PATTERN = 200

export function parseSessionQuery(filter: string): SessionQuery {
  const text = filter.trim()
  const query: SessionQuery = { terms: [], tags: [], colors: [] }
  if (/^re:/i.test(text)) {
    const pattern = text.slice(3).slice(0, MAX_PATTERN)
    if (!pattern) return query
    try {
      query.regex = new RegExp(pattern, "im")
    } catch {
      query.invalid = "invalid regular expression"
    }
    return query
  }
  for (const match of text.matchAll(/"([^"]*)"|(\S+)/g)) {
    const token = (match[1] ?? match[2] ?? "").replace(/^"/, "").toLowerCase()
    if (!token) continue
    if (match[2] !== undefined && token.startsWith("tag:")) {
      if (token.length > 4) query.tags.push(token.slice(4))
    } else if (match[2] !== undefined && token.startsWith("color:")) {
      if (token.length > 6) query.colors.push(token.slice(6))
    } else query.terms.push(token)
  }
  return query
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** What to ask the daemon to look for in messages, or undefined when the query has no text part. */
export function contentQuery(filter: string): { text: string; regex: boolean } | undefined {
  const query = parseSessionQuery(filter)
  if (query.invalid) return undefined
  if (query.regex) return { text: query.regex.source, regex: true }
  if (query.terms.length === 0) return undefined
  if (query.terms.length === 1) return { text: query.terms[0]!.slice(0, MAX_PATTERN), regex: false }
  const text = query.terms.map((term) => `(?=[\\s\\S]*${escapeRegex(term)})`).join("")
  return text.length <= MAX_PATTERN ? { text, regex: true } : undefined
}

/** No title (no message was ever sent) and an unsent draft. */
export const isDraftOnly = (session: Pick<SessionSummary, "title" | "draft">) => !session.title.trim() && session.draft !== undefined

function haystack(session: SessionSummary) {
  // An untitled session with a draft is found by the draft's words and by "draft".
  return [session.title, ...(session.draft ? ["draft", session.draft.preview] : []), session.directory, ...(session.tags ?? []).map((tag) => `#${tag}`), session.color ?? "", session.agent ?? "", session.model?.model ?? ""].join("\n").toLowerCase()
}

/** How many sessions /sessions loads at once; a search past them asks the daemon (`findTerm`). */
export const SESSION_PAGE = 200
/** How many sessions one search past the loaded page may bring back. */
export const FIND_LIMIT = 50

/**
 * The word the daemon is asked for when the loaded page may not hold every match: the longest plain word of the query
 * (title, folder or id), or undefined for a regular expression, an invalid query or tags and colors alone.
 */
export function findTerm(filter: string): string | undefined {
  const query = parseSessionQuery(filter)
  if (query.invalid || query.regex) return undefined
  const term = [...query.terms].sort((a, b) => b.length - a.length)[0]
  return term ? term.slice(0, MAX_PATTERN) : undefined
}

export function matchesQuery(session: SessionSummary, query: SessionQuery, hits?: Readonly<Record<string, string>>): boolean {
  if (query.invalid) return false
  if (!query.tags.every((tag) => (session.tags ?? []).some((own) => own.startsWith(tag)))) return false
  if (!query.colors.every((color) => session.color === color)) return false
  if (!query.regex && query.terms.length === 0) return true
  if (hits?.[session.sessionId] !== undefined) return true
  if (query.regex) return query.regex.test(haystack(session))
  const own = haystack(session)
  const id = session.sessionId.toLowerCase()
  return query.terms.every((term) => own.includes(term) || isIdPart(term) && id.includes(term))
}

/** A pasted session id, whole (`ses_…`) or the end the agent's lists show (8 characters or more): short words never match an id. */
const isIdPart = (term: string) => term.length >= 8 && /^[a-z0-9_]+$/.test(term)

/** The sessions left by the filter, the named-only switch and the scope; order is the caller's. */
export function selectSessions(sessions: SessionSummary[], filter: string, view: SessionView, currentDirectory?: string): SessionSummary[] {
  const query = parseSessionQuery(filter)
  const project = view.directory ?? currentDirectory
  return sessions.filter((session) => {
    // A session that holds only an unsent draft was never worked in: /drafts lists it, this list does not.
    if (isDraftOnly(session)) return false
    if (view.named && !session.named) return false
    if (view.scope === "project" && project !== undefined && session.directory !== project) return false
    return matchesQuery(session, query, view.hits)
  })
}

const SORT_KEYS: Record<SessionSort, (session: SessionSummary) => number> = {
  recent: sessionActivityAt,
  created: (session) => session.createdAt,
  name: () => 0,
}

/** Orders sessions inside a project: newest activity, newest creation, or title A-Z; a child session right under its parent. */
export function sortSessions(sessions: SessionSummary[], sort: SessionSort = "recent"): SessionSummary[] {
  const key = SORT_KEYS[sort]
  const sorted = [...sessions].sort((a, b) => sort === "name" ? a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || b.updatedAt - a.updatedAt : key(b) - key(a))
  return nestChildren(sorted)
}

/** `sessions` in their order with every child moved right under its parent (when listed), so a tree reads top-down. */
export function nestChildren(sessions: SessionSummary[]): SessionSummary[] {
  const listed = new Set(sessions.map((session) => session.sessionId))
  const children = new Map<string, SessionSummary[]>()
  for (const session of sessions) {
    if (!session.parentId || !listed.has(session.parentId) || session.parentId === session.sessionId) continue
    const siblings = children.get(session.parentId)
    if (siblings) siblings.push(session)
    else children.set(session.parentId, [session])
  }
  if (!children.size) return sessions
  const out: SessionSummary[] = []
  const placed = new Set<string>()
  const place = (session: SessionSummary) => {
    if (placed.has(session.sessionId)) return
    placed.add(session.sessionId)
    out.push(session)
    for (const child of children.get(session.sessionId) ?? []) place(child)
  }
  for (const session of sessions) if (!session.parentId || !listed.has(session.parentId) || session.parentId === session.sessionId) place(session)
  // A cycle of parents has no top: its sessions keep their order at the end.
  for (const session of sessions) place(session)
  return out
}

/** How deep each listed session sits under listed parents (0 for a top row), for indenting a nested list. */
export function nestingDepths(sessions: readonly SessionSummary[]): Map<string, number> {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]))
  const depths = new Map<string, number>()
  for (const session of sessions) {
    let depth = 0
    let parent = session.parentId
    while (parent && byId.has(parent) && depth < 8 && parent !== session.sessionId) {
      depth++
      parent = byId.get(parent)!.parentId
    }
    depths.set(session.sessionId, depth)
  }
  return depths
}

export const nextSort = (sort: SessionSort = "recent"): SessionSort => SESSION_SORTS[(SESSION_SORTS.indexOf(sort) + 1) % SESSION_SORTS.length]!

/** Words of the tag editor: `color:name` (or `color:none`) sets the mark, every other word is a tag. */
export function parseTagDraft(draft: string): { tags: string[]; color: string | null | undefined } {
  const tags: string[] = []
  let color: string | null | undefined
  for (const word of draft.split(/\s+/).filter(Boolean)) {
    const lower = word.toLowerCase()
    if (lower.startsWith("color:")) color = lower.slice(6) === "none" || lower.length === 6 ? null : lower.slice(6)
    else tags.push(lower.replace(/^#/, ""))
  }
  return { tags, color }
}
