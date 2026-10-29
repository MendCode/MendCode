import type { Client } from "@mendcode/client"
import type { PermissionMode, SessionEvent, SessionId, SessionSummary, TurnId } from "@mendcode/protocol"
import { parseTodoText } from "./view/dock"
import { parseToolTitle } from "./view/tool-card"

/**
 * `mendcode acp`: an Agent Client Protocol agent over stdio (JSON-RPC 2.0, one message per line), so editors
 * such as Zed can drive MendCode sessions, as v1's `mendcode acp` did. It is only a daemon client: sessions, turns,
 * approvals and history all live in the daemon; this maps them to ACP's session updates and permission requests.
 */
export const ACP_PROTOCOL_VERSION = 1

type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined }
type RpcId = number | string
type RpcMessage = { jsonrpc: "2.0"; id?: RpcId; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } }

const MODES: Array<{ id: PermissionMode; name: string; description: string }> = [
  { id: "ask", name: "Ask", description: "Ask before edits and commands" },
  { id: "edits", name: "Edits", description: "Edit files freely; ask before commands" },
  { id: "full", name: "Full access", description: "Run everything without asking" },
  { id: "plan", name: "Plan", description: "Read-only; propose a plan to approve" },
]

/** ACP tool kinds from MendCode tool names (read, edit, execute, search, fetch, think, other). */
export function toolKind(tool: string): string {
  if (tool === "read" || tool === "ls") return "read"
  if (tool === "glob" || tool === "grep") return "search"
  if (tool === "write" || tool === "edit" || tool === "apply_patch" || tool === "notebook_edit") return "edit"
  if (tool === "shell" || tool === "shell_output" || tool === "shell_kill" || tool === "shell_session" || tool === "shell_monitor" || tool.startsWith("custom__")) return "execute"
  if (tool === "webfetch" || tool === "web_search" || tool === "browser") return "fetch"
  if (tool === "task" || tool === "todo" || tool === "plan_submit") return "think"
  return "other"
}

/** The prompt's content blocks as MendCode text: text as is, linked files as `@path`, embedded resources fenced. */
export function promptText(blocks: unknown[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue
    const b = block as { type?: string; text?: string; uri?: string; resource?: { uri?: string; text?: string } }
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text)
    else if (b.type === "resource_link" && typeof b.uri === "string") parts.push(`@${b.uri.startsWith("file://") ? decodeURIComponent(b.uri.slice("file://".length)) : b.uri}`)
    else if (b.type === "resource" && typeof b.resource?.text === "string") parts.push(`[${b.resource.uri ?? "attached"}]\n\`\`\`\n${b.resource.text}\n\`\`\``)
  }
  return parts.join("\n\n").trim()
}

type PendingPrompt = { rpcId: RpcId; queueId?: string; turnId?: TurnId | undefined }
type SessionState = {
  id: SessionId
  items: Map<string, { kind: string; tool?: string }>
  /** Events up to here were history replayed on load; after it they are live. */
  replayUntil: number
  prompt?: PendingPrompt | undefined
  activeTurn?: TurnId | undefined
  /** Turn per queued message and how recent turns ended: events can arrive before user.submit's reply does. */
  startedByQueue: Map<string, TurnId>
  ended: Map<TurnId, Extract<SessionEvent, { type: "turn.completed" | "turn.cancelled" | "turn.failed" | "turn.interrupted" }>>
}

const RECENT_TURNS = 32
const remember = <K, V>(map: Map<K, V>, key: K, value: V) => {
  map.set(key, value)
  if (map.size > RECENT_TURNS) map.delete(map.keys().next().value as K)
}

export type AcpDeps = {
  client: Pick<Client, "send" | "subscribe">
  /** Routes the daemon's session events here (the client's onEvent is fixed at construction). */
  listen(handler: (event: SessionEvent) => void): void
  write(line: string): void
  version: string
  cwd?: string
}

export function createAcpAgent(deps: AcpDeps) {
  const sessions = new Map<SessionId, SessionState>()
  const outgoing = new Map<RpcId, (message: RpcMessage) => void>()
  let nextOutgoing = 1

  const send = (message: Record<string, Json | undefined>) => deps.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  const respond = (id: RpcId, result: Json) => send({ id, result })
  const fail = (id: RpcId, code: number, message: string) => send({ id, error: { code, message } })
  const update = (sessionId: SessionId, value: Record<string, Json | undefined>) => send({ method: "session/update", params: { sessionId, update: value } })
  /** An agent → client request (permission prompts); resolves with the client's reply message. */
  const request = (method: string, params: Record<string, Json | undefined>) =>
    new Promise<RpcMessage>((resolve) => {
      const id = `mend-${nextOutgoing++}`
      outgoing.set(id, resolve)
      send({ id, method, params })
    })

  deps.listen((event) => void onEvent(event))

  async function daemon(command: Parameters<AcpDeps["client"]["send"]>[0]) {
    const reply = await deps.client.send(command)
    if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code })
    return reply.result ?? {}
  }

  async function attach(sessionId: SessionId): Promise<SessionState> {
    const existing = sessions.get(sessionId)
    if (existing) return existing
    const state: SessionState = { id: sessionId, items: new Map(), replayUntil: Number.POSITIVE_INFINITY, startedByQueue: new Map(), ended: new Map() }
    sessions.set(sessionId, state)
    const reply = await deps.client.subscribe(sessionId, 0)
    if (!reply.ok) {
      sessions.delete(sessionId)
      throw new Error(reply.error.message)
    }
    state.replayUntil = Number(reply.result?.lastSeq ?? 0)
    return state
  }

  function textOf(value: unknown) {
    return typeof value === "string" ? value : ""
  }

  async function onEvent(event: SessionEvent) {
    const state = sessions.get(event.sessionId)
    if (!state) return
    const replay = event.seq <= state.replayUntil
    switch (event.type) {
      case "turn.started":
        state.activeTurn = event.turnId
        for (const queueId of [event.queueId, ...(event.joinedQueueIds ?? [])]) {
          remember(state.startedByQueue, String(queueId), event.turnId)
          if (state.prompt && !state.prompt.turnId && queueId === state.prompt.queueId) state.prompt.turnId = event.turnId
        }
        return
      case "item.started":
        state.items.set(event.itemId, { kind: event.kind, ...(event.meta?.tool !== undefined ? { tool: String(event.meta.tool) } : {}) })
        if (event.kind === "tool_call") {
          const title = String(event.meta?.tool ?? "tool")
          update(state.id, { sessionUpdate: "tool_call", toolCallId: event.itemId, title, kind: toolKind(parseToolTitle(title).name), status: "in_progress" })
        }
        return
      case "item.delta": {
        const item = state.items.get(event.itemId)
        if (item?.kind === "agent_message") update(state.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } })
        else if (item?.kind === "reasoning") update(state.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.text } })
        return
      }
      case "item.completed": {
        const item = state.items.get(event.itemId)
        if (!item) return
        // History replays whole messages; live turns already streamed them as deltas.
        if (replay && item.kind === "user_message" && event.text) update(state.id, { sessionUpdate: "user_message_chunk", content: { type: "text", text: event.text } })
        if (replay && item.kind === "agent_message" && event.text) update(state.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } })
        if (item.kind === "tool_call") {
          const name = parseToolTitle(item.tool ?? "").name
          update(state.id, {
            sessionUpdate: "tool_call_update",
            toolCallId: event.itemId,
            status: event.status === "ok" ? "completed" : "failed",
            ...(event.text ? { content: [{ type: "content", content: { type: "text", text: event.text } }] } : {}),
          })
          if (name === "todo" && event.text) {
            const entries = parseTodoText(event.text).filter((todo) => todo.status !== "cancelled")
            update(state.id, { sessionUpdate: "plan", entries: entries.map((todo) => ({ content: todo.text, priority: "medium", status: todo.status === "done" ? "completed" : todo.status })) })
          }
        }
        return
      }
      case "server.request":
        if (!replay) void answerRequest(state, event)
        return
      case "turn.completed":
      case "turn.cancelled":
      case "turn.failed":
      case "turn.interrupted": {
        if (state.activeTurn === event.turnId) state.activeTurn = undefined
        remember(state.ended, event.turnId, event)
        finishPrompt(state)
        return
      }
      default:
        return
    }
  }

  /** Answers the pending session/prompt once its turn is known and has ended (in whichever order those arrive). */
  function finishPrompt(state: SessionState) {
    const prompt = state.prompt
    if (!prompt?.queueId) return
    prompt.turnId ??= state.startedByQueue.get(prompt.queueId)
    const end = prompt.turnId ? state.ended.get(prompt.turnId) : undefined
    if (!end) return
    state.prompt = undefined
    if (end.type === "turn.completed") respond(prompt.rpcId, { stopReason: "end_turn" })
    else if (end.type === "turn.cancelled") respond(prompt.rpcId, { stopReason: "cancelled" })
    else if (end.type === "turn.failed") fail(prompt.rpcId, -32603, end.error.message)
    else fail(prompt.rpcId, -32603, `turn interrupted (${end.reason})`)
  }

  async function answerRequest(state: SessionState, event: Extract<SessionEvent, { type: "server.request" }>) {
    const resolve = (decision: { kind: "approve"; scope: "once" | "session" } | { kind: "deny"; reason?: string }) =>
      deps.client.send({ type: "request.resolve", sessionId: state.id, requestId: event.requestId, decision })
    if (event.kind === "question") {
      // ACP has no free-text question; the model is told to decide and say so.
      await resolve({ kind: "deny", reason: "the editor cannot answer questions; decide, state your assumption and continue" })
      return
    }
    const reply = await request("session/request_permission", {
      sessionId: state.id,
      toolCall: { toolCallId: event.itemId ?? event.requestId, title: event.title, status: "pending", kind: toolKind(event.tool ?? ""), rawInput: { detail: textOf(event.detail) } },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-session", name: "Allow for this session", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    })
    const outcome = (reply.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome
    if (outcome?.outcome === "selected" && outcome.optionId === "allow-once") await resolve({ kind: "approve", scope: "once" })
    else if (outcome?.outcome === "selected" && outcome.optionId === "allow-session") await resolve({ kind: "approve", scope: "session" })
    else await resolve({ kind: "deny", reason: outcome?.outcome === "selected" ? "rejected in the editor" : "the editor cancelled the prompt" })
  }

  function modesFor(current: PermissionMode = "ask") {
    return { currentModeId: current, availableModes: MODES.map((mode) => ({ id: mode.id, name: mode.name, description: mode.description })) }
  }

  async function handleRequest(message: RpcMessage) {
    const id = message.id!
    const params = message.params ?? {}
    switch (message.method) {
      case "initialize":
        return respond(id, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
          authMethods: [],
          agentInfo: { name: "MendCode", version: deps.version },
        })
      case "authenticate":
        return respond(id, {})
      case "session/new": {
        const cwd = String(params.cwd ?? deps.cwd ?? process.cwd())
        const created = await daemon({ type: "session.create", directory: cwd, title: "" })
        const sessionId = created.sessionId as SessionId
        await attach(sessionId)
        return respond(id, { sessionId, modes: modesFor() })
      }
      case "session/load": {
        const sessionId = String(params.sessionId) as SessionId
        sessions.delete(sessionId)
        await attach(sessionId)
        return respond(id, { modes: modesFor() })
      }
      case "session/list": {
        const cwd = typeof params.cwd === "string" ? params.cwd : deps.cwd
        const listed = await daemon({ type: "session.list", limit: 100, ...(cwd ? { directory: cwd } : {}) })
        const summaries = (listed.sessions ?? []) as SessionSummary[]
        return respond(id, { sessions: summaries.map((s) => ({ sessionId: s.sessionId, cwd: s.directory, title: s.title || null, updatedAt: new Date(s.updatedAt).toISOString() })) })
      }
      case "session/prompt": {
        const sessionId = String(params.sessionId) as SessionId
        const state = await attach(sessionId)
        if (state.prompt) return fail(id, -32602, "a prompt is already running in this session")
        const text = promptText(Array.isArray(params.prompt) ? params.prompt : [])
        if (!text) return fail(id, -32602, "empty prompt")
        state.prompt = { rpcId: id }
        const queued = await deps.client.send({ type: "user.submit", sessionId, text, attachments: [] })
        if (!queued.ok) {
          state.prompt = undefined
          return fail(id, -32603, queued.error.message)
        }
        state.prompt.queueId = String(queued.result?.queueId ?? "")
        finishPrompt(state)
        return
      }
      case "session/set_mode": {
        const mode = String(params.modeId) as PermissionMode
        if (!MODES.some((m) => m.id === mode)) return fail(id, -32602, `unknown mode ${mode}`)
        await daemon({ type: "session.permission.set", sessionId: String(params.sessionId) as SessionId, mode })
        return respond(id, {})
      }
      default:
        return fail(id, -32601, `method not found: ${message.method}`)
    }
  }

  async function handleNotification(message: RpcMessage) {
    if (message.method !== "session/cancel") return
    const state = sessions.get(String(message.params?.sessionId) as SessionId)
    const turnId = state?.prompt?.turnId ?? state?.activeTurn
    if (state && turnId) await deps.client.send({ type: "turn.cancel", sessionId: state.id, turnId })
  }

  return {
    /** One line from stdin: a request, a notification, or a reply to one of our requests. */
    async handleLine(line: string) {
      if (!line.trim()) return
      let message: RpcMessage
      try {
        message = JSON.parse(line) as RpcMessage
      } catch {
        return send({ id: null, error: { code: -32700, message: "parse error" } })
      }
      if (message.method === undefined && message.id !== undefined) {
        const waiter = outgoing.get(message.id)
        outgoing.delete(message.id)
        return waiter?.(message)
      }
      if (message.id === undefined) return handleNotification(message)
      try {
        await handleRequest(message)
      } catch (error) {
        fail(message.id, -32603, error instanceof Error ? error.message : String(error))
      }
    },
  }
}
