import { MAX_FRAME_BYTES, type ForegroundState, type SessionDetail, type SessionId, type SessionInspection } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { readEventsWindow } from "./events-window"
import { readSessionHistory } from "./session-reader"
import { lifecycleOf } from "./session-lifecycle"
import { redactValue } from "./secrets"

function fileDiff(file: ReturnType<Store["turns"]["files"]["list"]>[number]) {
  const entry = { path: file.path, before: file.before.state, ...(file.after ? { after: file.after.state } : {}) }
  if (!file.after || file.before.state === "skipped" || file.after.state === "skipped") return entry
  try {
    const decode = (state: typeof file.before) => state.state === "content" ? new TextDecoder("utf-8", { fatal: true }).decode(state.content) : ""
    const before = decode(file.before)
    const after = decode(file.after)
    if (before === after) return entry
    const lines = (text: string) => text ? text.replace(/\n$/, "").split("\n") : []
    const old = lines(before)
    const next = lines(after)
    const patch = [`--- ${file.before.state === "absent" ? "/dev/null" : `a/${file.path}`}`, `+++ ${file.after.state === "absent" ? "/dev/null" : `b/${file.path}`}`, `@@ -${old.length ? 1 : 0},${old.length} +${next.length ? 1 : 0},${next.length} @@`, ...old.map((line) => `-${line}`), ...next.map((line) => `+${line}`)].join("\n")
    return { ...entry, patch: patch.slice(0, 6_000), ...(patch.length > 6_000 ? { truncated: true } : {}) }
  } catch { return entry }
}

/** Defensive redaction for metadata and older events which predate secret capture. */
export function sanitizeSession<T>(value: T): T {
  return redactValue(value, { keys: /^(?:api[_-]?key|authorization|password|credential|secret|access[_-]?token|refresh[_-]?token|private[_-]?key|cookie)$/i })
}

export function createSessionAutomation(input: {
  store: Store
  foreground(id: SessionId): ForegroundState | undefined
  loops(): SessionInspection["loops"]
  tasks(id: SessionId): SessionInspection["subagents"]
}) {
  const { store } = input
  function detail(id: SessionId): SessionDetail | undefined {
    const row = store.sessionSummary(id)
    if (!row) return undefined
    const summary = { ...row, lifecycle: lifecycleOf(store, id) }
    const last = store.lastTurnStatus(id)
    const state = input.foreground(id) ?? (summary.queued ? "queued" : "idle")
    const pending = store.pendingRequestsOf(id)
    const status = pending.some((event) => event.kind === "question") ? "waiting_for_input"
      : pending.length ? "waiting_for_approval"
      : summary.queued || !["idle", "error"].includes(state) ? "running"
      : state === "error" || last === "failed" ? "failed"
      // A deliberate cancel and a turn the daemon lost (restart, transport) are different facts: a script retries only the second.
      : last === "cancelled" ? "cancelled"
      : last === "interrupted" ? "interrupted"
      : last === "completed" ? "completed" : "idle"
    const agent = store.sessionAgent(id)
    const model = store.sessionModel(id)
    // The tags and color the user gave the session (its agent-view metadata), for the picker.
    const marks = store.agentCommands.getMetadata(id)
    return sanitizeSession({ ...summary, ...(store.meta.get(`session.summary:${id}`) ? { summary: store.meta.get(`session.summary:${id}`) } : {}), ...(store.meta.get(`session.title.manual:${id}`) === "true" ? { named: true } : {}), ...(marks?.tags.length ? { tags: marks.tags } : {}), ...(marks?.color ? { color: marks.color } : {}), state, status, permission: store.permissionModeOf(id), ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(store.detached.has(id) ? { detached: true } : {}) })
  }

  function list(options: { limit?: number | undefined; directory?: string | undefined; project?: string | undefined; roots?: boolean | undefined; since?: number | undefined; search?: string | undefined; agent?: string | undefined; model?: string | undefined; state?: string | undefined; active?: boolean | undefined; archived?: boolean | undefined; hideEmpty?: boolean | undefined }) {
    const sessions: SessionDetail[] = []
    const limit = options.limit ?? 100
    // Bytes of `JSON.stringify(sessions)`, kept as entries are added: "[", "]" and a comma before every entry after the first.
    let bytes = 2
    for (let offset = 0; sessions.length < limit; offset += 500) {
      const candidates = store.listSessions({ ...options, directory: options.project ?? options.directory, limit: 500, offset })
      for (const candidate of candidates) {
        const session = detail(candidate.sessionId)!
        const active = session.queued > 0 || !["idle", "error"].includes(session.state)
        const state = options.state === "busy" ? active : options.state === undefined || options.state === session.state || options.state === session.status
        if (!state || options.active !== undefined && options.active !== active) continue
        const size = Buffer.byteLength(JSON.stringify(session)) + (sessions.length ? 1 : 0)
        if (bytes + size > MAX_FRAME_BYTES - 16_000) return sessions
        bytes += size
        sessions.push(session)
        if (sessions.length === limit) break
      }
      if (candidates.length < 500) break
    }
    return sessions
  }

  function inspect(id: SessionId, limit = 50): SessionInspection | undefined {
    const session = detail(id)
    if (!session) return undefined
    const messages = readSessionHistory(store, { sessionId: id, limit: limit || 50 })
    const window = readEventsWindow({ store, sessionId: id, limit: 500 })
    const pending = store.pendingRequestsOf(id)
    const result: SessionInspection = {
      session, state: session.status, messages: messages.ok ? messages.result : { turns: [] },
      children: store.sessionChildren(id).slice(0, 100).map((child) => detail(child)!),
      subagents: input.tasks(id), loops: input.loops().filter((loop) => loop.sessionId === id).slice(0, 100),
      pending: { questions: pending.filter((event) => event.kind === "question"), permissions: pending.filter((event) => event.kind === "approval" && event.tool !== "plan_review"), planReviews: pending.filter((event) => event.tool === "plan_review") },
      events: window.events,
      diff: store.turns.list(id).filter((turn) => !turn.reverted).flatMap((turn) => store.turns.files.list(id, turn.turnId).map(fileDiff)).slice(-500),
      truncated: window.more || !!(messages.ok && messages.result.older),
    }
    if (limit === 0 && messages.ok) {
      while (result.messages.older !== undefined) {
        const older = readSessionHistory(store, { sessionId: id, before: result.messages.older, limit: 50 })
        if (!older.ok || !older.result.turns.length) break
        const next = { ...result.messages, turns: [...older.result.turns, ...result.messages.turns], older: older.result.older }
        if (Buffer.byteLength(JSON.stringify({ ...result, messages: next })) > MAX_FRAME_BYTES - 16_000) break
        result.messages = next
      }
      result.truncated = window.more || result.messages.older !== undefined
    }
    const safe = sanitizeSession(result)
    const collections = [safe.events, safe.messages.turns, safe.children, safe.subagents, safe.loops, safe.diff, safe.pending.questions, safe.pending.permissions, safe.pending.planReviews]
    while (Buffer.byteLength(JSON.stringify(safe)) > MAX_FRAME_BYTES - 8_000) {
      const largest = collections.filter((entries) => entries.length).sort((a, b) => Buffer.byteLength(JSON.stringify(b)) - Buffer.byteLength(JSON.stringify(a)))[0]
      if (!largest) break
      largest.shift()
      safe.truncated = true
    }
    return safe
  }
  return { detail, list, inspect }
}
