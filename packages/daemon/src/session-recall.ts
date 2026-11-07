import { redactSecrets, type ErrorCode, type SessionId, type SessionRecallFound, type SessionRecallPage, type SessionRecallReadInput, type SessionRecallSearchInput } from "@mendcode/protocol"
import { PROGRAM_NAME } from "@mendcode/program"
import type { Store } from "@mendcode/store"
import { canonicalDir, type SessionRecallPort } from "@mendcode/tools"
import { rankTurns } from "./turn-recall"

const FOUND_SEARCHERS = 32
const FOUND_PER_SEARCHER = 200

export class SessionRecallError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message) }
}

/** `at` as local time with its UTC offset, which a model reads without knowing the machine's zone: `2026-10-28T17:25:03-05:00`. */
export function localTime(at: number): string {
  const offset = -new Date(at).getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const zone = `${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`
  return `${new Date(at + offset * 60_000).toISOString().slice(0, 19)}${zone}`
}

/** At most `length` characters of a message (or of the text around `query`), redacted; undefined when `query` is absent. */
export function excerpt(chunks: Iterable<string>, length: number, offset = 0, query?: string) {
  let position = 0
  let pending = ""
  let text = ""
  let start = query ? undefined : offset
  for (const chunk of chunks) {
    if (start === undefined) {
      const joined = pending + chunk
      const match = joined.toLowerCase().indexOf(query!)
      if (match >= 0) start = Math.max(0, position - pending.length + match - 200)
      else {
        pending = joined.slice(-(200 + query!.length))
        position += chunk.length
        continue
      }
      text = joined.slice(Math.max(0, start - position + pending.length), start - position + pending.length + length + 1)
    } else if (position + chunk.length > start) {
      text += chunk.slice(Math.max(0, start - position), Math.max(0, start + length + 1 - position))
    }
    position += chunk.length
    if (text.length > length) return { text: redactSecrets(text.slice(0, length)).text, truncated: true }
  }
  return start === undefined ? undefined : { text: redactSecrets(text).text, truncated: false }
}

export function createSessionRecall(store: Store) {
  /** Each session's packed-away turns as of its latest compaction; read again only after a newer one. */
  const packedTurns = new Map<SessionId, { packedAt: number; turns: ReturnType<Store["recall"]["turns"]> }>()
  function enabled(sessionId: SessionId) {
    if (store.settings.get().experimental?.session_recall !== true) throw new SessionRecallError("invalid_command", "Session recall is disabled")
    const session = store.sessionInfo(sessionId)
    if (!session) throw new SessionRecallError("unknown_session", "Unknown session")
    return session
  }
  /**
   * The sessions a project search showed each searching session, which it may then read: kept in memory only, bounded
   * (FOUND_SEARCHERS searchers, FOUND_PER_SEARCHER ids each, oldest dropped first), empty until a project search runs.
   */
  const found = new Map<SessionId, Set<SessionId>>()
  function remember(sessionId: SessionId, ids: readonly SessionId[]) {
    if (!ids.length) return
    const known = found.get(sessionId) ?? new Set<SessionId>()
    found.delete(sessionId)
    found.set(sessionId, known)
    for (const id of ids) { known.delete(id); known.add(id) }
    while (known.size > FOUND_PER_SEARCHER) known.delete(known.values().next().value!)
    while (found.size > FOUND_SEARCHERS) found.delete(found.keys().next().value!)
  }
  function projectSearch(sessionId: SessionId, input: SessionRecallSearchInput): SessionRecallFound {
    const origin = enabled(sessionId)
    const text = input.query.trim()
    if (!text) throw new SessionRecallError("invalid_command", "Search requires query")
    const offset = input.cursor === undefined ? 0 : Number(input.cursor)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new SessionRecallError("invalid_command", "Unknown project search cursor")
    const limit = Number.isFinite(input.limit) ? Math.floor(input.limit!) : 10
    const page = store.sessionSearch.find({ text, directory: origin.directory, exclude: sessionId, offset, limit })
    remember(sessionId, page.hits.map((hit) => hit.sessionId))
    return {
      scope: "project",
      sessions: page.hits.map((hit) => ({ session_id: hit.sessionId, title: redactSecrets(hit.title.slice(0, 200)).text, at: localTime(hit.updatedAt), snippet: redactSecrets(hit.snippet).text.slice(0, 200) })),
      more: page.next !== undefined,
      ...(page.next !== undefined ? { next_cursor: String(page.next) } : {}),
    }
  }
  function target(sessionId: SessionId, requested?: SessionId) {
    const origin = enabled(sessionId)
    const id = requested ?? sessionId
    // A session a project search returned: still only while it is in this project.
    if (requested && found.get(sessionId)?.has(requested)) {
      const session = store.sessionInfo(requested)
      if (session && canonicalDir(session.directory) === canonicalDir(origin.directory)) return id
    }
    let cursor = id
    const seen = new Set<SessionId>()
    while (!seen.has(cursor)) {
      seen.add(cursor)
      const session = store.sessionInfo(cursor)
      if (!session || canonicalDir(session.directory) !== canonicalDir(origin.directory)) break
      if (cursor === sessionId) return id
      if (!session.parentId) break
      cursor = session.parentId as SessionId
    }
    throw new SessionRecallError("target_mismatch", "Session is outside the current session and its linked children")
  }
  /** A session of this project (as /sessions lists it) by its full id, or the end of one a search returned or the project holds. */
  function openTarget(sessionId: SessionId, ref: string) {
    const origin = enabled(sessionId)
    let id = store.sessionInfo(ref as SessionId) ? ref as SessionId : undefined
    if (!id) {
      const needle = ref.toLowerCase()
      const known = new Set([...(found.get(sessionId) ?? []), ...store.listSessions({ directory: origin.directory, limit: 200 }).map((session) => session.sessionId as SessionId)])
      const hits = [...known].filter((candidate) => candidate.toLowerCase().endsWith(needle))
      if (hits.length === 1) id = hits[0]
    }
    const session = id ? store.sessionInfo(id) : undefined
    if (!id || !session || canonicalDir(session.directory) !== canonicalDir(origin.directory)) throw new SessionRecallError("target_mismatch", "No session with that id in this project; find it with session_search scope project")
    if (id === sessionId) throw new SessionRecallError("target_mismatch", "That is this session")
    return { session_id: id, title: redactSecrets(session.title.slice(0, 200)).text, attach: `${PROGRAM_NAME} attach ${id}` }
  }
  function page(sessionId: SessionId, input: SessionRecallReadInput, search: boolean): SessionRecallPage {
    const id = target(sessionId, input.session_id)
    const before = input.before ? store.recall.item(id, input.before) : undefined
    if (input.before && !before) throw new SessionRecallError("target_mismatch", "Unknown message cursor in this session")
    const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(10, Math.floor(input.limit!))) : 10
    const query = input.query?.toLowerCase()
    if (search && !query) throw new SessionRecallError("invalid_command", "Search requires query")
    const items = store.recall.page(id, before?.seq ?? Number.MAX_SAFE_INTEGER, limit + 1)
    const selected = items.slice(0, limit)
    const messages: SessionRecallPage["messages"] = []
    for (const item of selected.reverse()) {
      const value = excerpt(store.recall.chunks(item), 2000, 0, search ? query : undefined)
      if (value) messages.push({ message_id: item.itemId, role: item.kind === "user_message" ? "user" : "assistant", at: localTime(item.at), ...value })
    }
    const more = items.length > limit
    const next = selected[0]?.itemId
    return { session_id: id, messages, more, ...(more && next ? { next_cursor: next } : {}) }
  }
  return {
    port(sessionId: SessionId): SessionRecallPort {
      return {
        search: (input) => page(sessionId, input, true),
        find: (input) => projectSearch(sessionId, input),
        open: (input) => openTarget(sessionId, input.session_id),
        read: (input) => {
          if (!input.message_id) return page(sessionId, input, false)
          const id = target(sessionId, input.session_id)
          const item = store.recall.item(id, input.message_id)
          if (!item) throw new SessionRecallError("target_mismatch", "Unknown message in this session")
          const offset = Number.isFinite(input.offset) ? Math.max(0, Math.floor(input.offset!)) : 0
          const value = excerpt(store.recall.chunks(item), 16_000, offset)!
          return { session_id: id, message_id: item.itemId, at: localTime(item.at), text: value.text, ...(value.truncated ? { next_offset: offset + 16_000 } : {}) }
        },
        relevant: (input) => {
          if (store.settings.get().experimental?.auto_recall !== true) return []
          const packedAt = store.recall.packedAt(sessionId)
          if (packedAt === undefined) return []
          let cached = packedTurns.get(sessionId)
          if (cached?.packedAt !== packedAt) packedTurns.set(sessionId, cached = { packedAt, turns: store.recall.turns(sessionId, packedAt) })
          return rankTurns(cached.turns, input.query, input.limit, input.maxChars)
        },
        notes: (input) => {
          enabled(sessionId)
          try { return store.recall.notes(sessionId, input) }
          catch (error) { throw new SessionRecallError("target_mismatch", error instanceof Error ? error.message : String(error)) }
        },
      }
    },
  }
}
