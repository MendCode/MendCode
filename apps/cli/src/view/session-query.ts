import type { SessionSummary } from "@mendcode/protocol"
import { sessionActivityAt } from "./session-label"

/**
 * The session picker's query language, shared by the view and the key handler:
 *   plain words      every word must be in the title, directory, tags, agent or model
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

export function matchesQuery(session: SessionSummary, query: SessionQuery, hits?: Readonly<Record<string, string>>): boolean {
  if (query.invalid) return false
  if (!query.tags.every((tag) => (session.tags ?? []).some((own) => own.startsWith(tag)))) return false
  if (!query.colors.every((color) => session.color === color)) return false
  if (!query.regex && query.terms.length === 0) return true
  if (hits?.[session.sessionId] !== undefined) return true
  if (query.regex) return query.regex.test(haystack(session))
  const own = haystack(session)
  return query.terms.every((term) => own.includes(term))
}

/** The sessions left by the filter, the named-only switch and the scope; order is the caller's. */
export function selectSessions(sessions: SessionSummary[], filter: string, view: SessionView, currentDirectory?: string): SessionSummary[] {
  const query = parseSessionQuery(filter)
  return sessions.filter((session) => {
    // A session that holds only an unsent draft was never worked in: /drafts lists it, this list does not.
    if (isDraftOnly(session)) return false
    if (view.named && !session.named) return false
    if (view.scope === "project" && currentDirectory !== undefined && session.directory !== currentDirectory) return false
    return matchesQuery(session, query, view.hits)
  })
}

const SORT_KEYS: Record<SessionSort, (session: SessionSummary) => number> = {
  recent: sessionActivityAt,
  created: (session) => session.createdAt,
  name: () => 0,
}

/** Orders sessions inside a project: newest activity, newest creation, or title A-Z. */
export function sortSessions(sessions: SessionSummary[], sort: SessionSort = "recent"): SessionSummary[] {
  const key = SORT_KEYS[sort]
  return [...sessions].sort((a, b) => sort === "name" ? a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || b.updatedAt - a.updatedAt : key(b) - key(a))
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
