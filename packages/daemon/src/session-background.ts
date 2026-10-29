import type { AgentViewMetadataPatch, Command, SessionBackgroundEntry, SessionEvent, SessionId } from "@mendcode/protocol"
import { replaceSecretMarkers } from "@mendcode/protocol/wire"
import type { Store } from "@mendcode/store"
import { sanitizeSession } from "./session-automation"

export function createSessionBackground(input: {
  store: Store
  now(): number
  changed(sessionId: SessionId): void
  metadataChanged(sessionId: SessionId): void
  mask(sessionId: SessionId, text: string): string
}) {
  const { store } = input
  const records = store.sessionBackground
  const safe = (id: SessionId, text: string) => replaceSecretMarkers(input.mask(id, text), () => "[redacted:session-secret]")
  function check(id: SessionId) {
    if (!store.hasSession(id)) throw new Error("Unknown session")
  }
  function register(id: SessionId, patch: Parameters<typeof records.register>[1] = {}) {
    check(id)
    const info = records.register(id, { ...patch, ...(patch.summary !== undefined ? { summary: safe(id, patch.summary).slice(0, 4000) } : {}), ...(patch.error !== undefined ? { error: safe(id, patch.error).slice(0, 4000) } : {}) })
    input.changed(id)
    return info
  }
  function list(directory?: string): SessionBackgroundEntry[] {
    const activeSessions = new Set(store.sessionsWithActiveTurn().map((entry) => entry.sessionId))
    return records.list().flatMap((info) => {
      const session = store.sessionSummary(info.sessionId)
      if (!session || directory && session.directory !== directory) return []
      const pending = store.pendingRequestsOf(info.sessionId)
      const active = activeSessions.has(info.sessionId)
      const state: SessionBackgroundEntry["state"] = info.state === "failed" || info.state === "stopped" ? info.state : pending.length ? "needs_input" : active ? "working" : info.state === "working" ? "completed" : info.state
      const writer = info.writer && info.writer.expiresAt > input.now() ? info.writer : undefined
      return [sanitizeSession({ ...info, state, writer, session: { sessionId: session.sessionId, title: safe(session.sessionId, session.title), directory: session.directory, ...(session.parentId ? { parentId: session.parentId } : {}), ...(store.sessionAgent(session.sessionId) ? { agent: store.sessionAgent(session.sessionId) } : {}) }, ...(store.agentCommands.getMetadata(session.sessionId) ? { metadata: store.agentCommands.getMetadata(session.sessionId) } : {}) })]
    }).slice(0, 100)
  }
  return {
    register,
    list,
    observe(event: SessionEvent) {
      if (!records.get(event.sessionId)) return
      if (event.type === "turn.started" || event.type === "server.request.resolved") register(event.sessionId, { state: "working" })
      else if (event.type === "server.request") register(event.sessionId, { state: "needs_input" })
      else if (event.type === "turn.completed") register(event.sessionId, { state: "completed" })
      else if (event.type === "turn.failed") register(event.sessionId, { state: "failed", error: event.error.message })
      else if (event.type === "turn.cancelled" || event.type === "turn.interrupted") register(event.sessionId, { state: "stopped" })
    },
    handle(command: Command): Record<string, unknown> | undefined {
      switch (command.type) {
        case "session.background.list": return { sessions: list(command.directory) }
        case "session.background.register": {
          const { sessionId, type, id, clientId, ...patch } = command
          check(sessionId)
          store.detached.set(sessionId)
          return { info: register(sessionId, patch) }
        }
        case "session.background.remove": {
          check(command.sessionId)
          const removed = records.remove(command.sessionId)
          input.changed(command.sessionId)
          return { removed }
        }
        case "session.background.writer.acquire": {
          check(command.sessionId)
          const result = records.acquire(command.sessionId, command.clientId, command.ttlMs)
          if (result.acquired) input.changed(command.sessionId)
          return result
        }
        case "session.background.writer.release": {
          check(command.sessionId)
          const info = records.release(command.sessionId, command.clientId)
          if (info) input.changed(command.sessionId)
          return { info: info ?? null }
        }
        case "session.agent-view.metadata.list": return { metadata: sanitizeSession(store.agentCommands.metadata(command.directory)) }
        case "session.agent-view.metadata.get": {
          check(command.sessionId)
          return { metadata: sanitizeSession(store.agentCommands.getMetadata(command.sessionId) ?? null) }
        }
        case "session.agent-view.metadata.patch": {
          check(command.sessionId)
          const limits: Record<string, number> = { title: 120, group: 80, notes: 4000 }
          const patch = Object.fromEntries(Object.entries(command.patch).map(([key, value]) => [key, typeof value === "string" && key !== "priority" ? safe(command.sessionId, value).slice(0, limits[key]) : Array.isArray(value) ? value.map((tag) => safe(command.sessionId, tag).slice(0, 40)) : value])) as AgentViewMetadataPatch
          const metadata = store.agentCommands.patchMetadata(command.sessionId, patch)
          input.metadataChanged(command.sessionId)
          return { metadata }
        }
      }
    },
  }
}
