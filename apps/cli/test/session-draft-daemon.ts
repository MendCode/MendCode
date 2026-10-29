import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { GlobalEvent, SessionId } from "@mendcode/protocol"
import { openStore, type Store } from "@mendcode/store"
import { FILES } from "./inline-attachments-helpers"
import { ids } from "./session-ui-harness"

/**
 * A daemon for the draft tests: the real store (drafts, session lists, the empty-chat rule) behind the commands a terminal sends,
 * and the `session.activity` push the real daemon makes when a draft appears, changes its first line or goes (`daemon.ts`,
 * `draft.set`). Terminals attach with `listen`; the push reaches every one of them, the writer included.
 */
export const PROJECT = "/repo"

type Activity = Extract<GlobalEvent, { type: "session.activity" }>

export function draftDaemon() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-draft-daemon-"))
  const store: Store = openStore({ dir })
  const listeners = new Set<(event: GlobalEvent) => void>()
  let clock = 1_000
  const push = (sessionId: SessionId, draft: Activity["draft"]) => {
    const info = store.sessionInfo(sessionId)
    if (!info) return
    const event = { type: "session.activity", gseq: 0, at: clock, sessionId, directory: info.directory, title: info.title, state: "idle", updatedAt: info.updatedAt, ...(draft !== undefined ? { draft } : {}) } as Activity
    for (const listener of listeners) listener(event)
  }
  /** A session as a terminal's "new chat" leaves it: blank, no title, nothing typed. */
  const createSession = (title = ""): SessionId => {
    const id = ids("session")
    store.createSession({ id, directory: PROJECT, title })
    return id
  }
  const reply = (command: CommandInput): CommandReply | undefined => {
    const c = command as CommandInput & Record<string, any>
    switch (command.type) {
      case "draft.set": {
        const before = store.drafts.heads([c.sessionId]).get(c.sessionId)
        clock += 1
        if (!store.drafts.set(c.sessionId, c.text, c.attachments ?? [])) return { ok: false, error: { code: "unknown_session", message: "unknown session" } } as CommandReply
        const after = store.drafts.heads([c.sessionId]).get(c.sessionId)
        if (before?.preview !== after?.preview || before?.attachments !== after?.attachments || before?.images !== after?.images || (before === undefined) !== (after === undefined)) push(c.sessionId, after ?? null)
        return { ok: true }
      }
      case "draft.get": {
        const draft = store.drafts.get(c.sessionId)
        return { ok: true, result: draft ? { draft } : {} } as CommandReply
      }
      case "draft.list": return { ok: true, result: { drafts: store.drafts.list({ directory: c.directory, excludeSessionId: c.excludeSessionId, limit: c.limit }) } } as CommandReply
      case "session.list": {
        const sessions = store.listSessions({ directory: c.directory, limit: c.limit ?? 50, archived: c.archived, hideEmpty: c.hideEmpty })
        const heads = store.drafts.heads(sessions.map((session) => session.sessionId))
        return { ok: true, result: { sessions: sessions.map((session) => ({ ...session, state: "idle", ...(heads.has(session.sessionId) ? { draft: heads.get(session.sessionId) } : {}) })) } } as CommandReply
      }
      case "session.create": {
        const id = createSession(c.title ?? "")
        return { ok: true, result: { sessionId: id } } as CommandReply
      }
      case "user.submit": {
        // The first message names the session; the terminal clears the draft itself.
        const info = store.sessionInfo(c.sessionId)
        if (info && !info.title) {
          store.renameSession(c.sessionId, String(c.text).slice(0, 60))
          push(c.sessionId, undefined)
        }
        return undefined
      }
      case "attachment.paste": {
        const found = FILES[String(c.path).replace(/^['"]|['"]$/g, "")]
        return found ? { ok: true, result: found } as CommandReply : undefined
      }
      default: return undefined
    }
  }
  return {
    store,
    dir,
    reply,
    createSession,
    /** A terminal listens to the daemon's pushes. */
    listen(listener: (event: GlobalEvent) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    close() {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
export type DraftDaemon = ReturnType<typeof draftDaemon>
