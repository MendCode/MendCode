import type { Client } from "@mendcode/client"
import type { BlobRef, HistoryItem, HistoryTurn, ModelChoice, ModelsReport, PermissionMode, SessionDetail, SessionEvent, SessionId, SessionSummary, TurnId } from "@mendcode/protocol"
import {
  APP_SERVER_ERRORS,
  APP_SERVER_PROTOCOL,
  REASONING_EFFORTS,
  redactSecrets,
  type AppServerDecision,
  type AppServerInput,
  type AppServerItem,
  type AppServerMessage,
  type AppServerModel,
  type AppServerStatus,
  type AppServerThread,
  type AppServerTurn,
} from "@mendcode/protocol/wire"
import { toolKind } from "./acp"
import { sessionSelection } from "./session-output"
import { parseToolTitle } from "./view/tool-card"

/**
 * `mendcode app-server`: a JSON-RPC 2.0 server on stdio (one message per line) shaped like Codex's app-server, so a
 * third-party UI (t3 code and similar) can drive MendCode threads, turns and approvals. Like `acp`, it is only a
 * daemon client: threads are sessions, nothing runs here, and every approval still goes through the daemon's permissions.
 * The wire types are in `@mendcode/protocol/wire` (app-server.ts); docs/embedding.md describes the conversation.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined }
type RpcId = number | string

const MODES: readonly PermissionMode[] = ["ask", "edits", "full", "plan", "smart"]
const MAX_INPUT_CHARS = 200_000
const RECENT = 64

const METHODS = ["initialize", "thread/start", "thread/resume", "thread/fork", "thread/list", "thread/read", "thread/name/set", "thread/archive", "thread/compact/start", "turn/start", "turn/interrupt", "model/list"]

class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message)
  }
}

const invalid = (message: string) => new RpcError(APP_SERVER_ERRORS.invalidParams, message)

type TrackedItem = { kind: string; turnId: string; tool: string; title: string }
type PendingStart = { rpcId: RpcId; queueId: string; timer?: ReturnType<typeof setTimeout> | undefined }
type ThreadState = {
  id: SessionId
  items: Map<string, TrackedItem>
  /** While a `turn/start` waits for its queue id, events are held so the reply precedes the notifications of its turn. */
  submitting: number
  held: SessionEvent[]
  activeTurn?: TurnId | undefined
  starts: Map<string, PendingStart>
  /** Approval and question requests still waiting for the host's answer. */
  requests: Set<string>
}

export type AppServerDeps = {
  client: Pick<Client, "send" | "subscribe">
  /** Routes the daemon's session events here (the client's onEvent is fixed at construction). */
  listen(handler: (event: SessionEvent) => void): void
  write(line: string): void
  version: string
  cwd: string
  /** How long `turn/start` waits for its turn to begin before answering `queued: true` (default 2000). */
  startWaitMs?: number
}

const str = (value: unknown, name: string, optional = false) => {
  if (value === undefined && optional) return undefined
  if (typeof value !== "string" || !value.trim()) throw invalid(`${name} must be a non-empty string`)
  return value
}

function mode(value: unknown): PermissionMode | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !MODES.includes(value as PermissionMode)) throw invalid(`approvalPolicy must be one of ${MODES.join(", ")}`)
  return value as PermissionMode
}

function effort(value: unknown) {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !(REASONING_EFFORTS as readonly string[]).includes(value)) throw invalid(`effort must be one of ${REASONING_EFFORTS.join(", ")}`)
  return value as (typeof REASONING_EFFORTS)[number]
}

const statusOf = (value: string | undefined): AppServerStatus => (value === "ok" ? "completed" : value === "error" ? "failed" : value === "cancelled" ? "cancelled" : value === "interrupted" ? "interrupted" : "completed")

function threadOf(summary: SessionSummary | SessionDetail): AppServerThread {
  return {
    id: summary.sessionId,
    cwd: summary.directory,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    state: summary.state,
    queued: summary.queued,
    lastSeq: summary.lastSeq,
    ...(summary.permission ? { approvalPolicy: summary.permission as PermissionMode } : {}),
    ...(summary.model ? { model: summary.model.model } : {}),
    ...(summary.agent ? { agent: summary.agent } : {}),
    ...(summary.parentId ? { parentId: summary.parentId } : {}),
    ...(summary.archivedAt ? { archived: true } : {}),
  }
}

function itemOf(input: { id: string; kind: string; text?: string; status?: AppServerStatus; title?: string; tool?: string; meta?: Record<string, string | number | boolean> | undefined }): AppServerItem {
  const text = input.text ?? ""
  if (input.kind === "user_message") return { id: input.id, type: "userMessage", text }
  if (input.kind === "agent_message") return { id: input.id, type: "agentMessage", text }
  if (input.kind === "reasoning") return { id: input.id, type: "reasoning", text }
  if (input.kind === "compaction") return { id: input.id, type: "contextCompaction", text }
  if (input.kind === "tool_call") {
    const title = input.title ?? input.tool ?? "tool"
    const parsed = parseToolTitle(title)
    const base = { id: input.id, tool: parsed.name, status: input.status ?? "inProgress", ...(text ? { output: text } : {}), ...(input.meta ? { meta: input.meta } : {}) }
    const kind = toolKind(parsed.name)
    if (kind === "execute") return { ...base, type: "commandExecution", command: parsed.detail }
    if (kind === "edit") return { ...base, type: "fileChange", title }
    return { ...base, type: "toolCall", title }
  }
  return { id: input.id, type: "other", kind: input.kind, text }
}

function turnOf(turn: HistoryTurn): AppServerTurn {
  const outcome = turn.outcome
  const status: AppServerStatus = outcome === "running" ? "inProgress" : outcome === "failed" ? "failed" : outcome === "cancelled" || outcome === "interrupted" ? "interrupted" : "completed"
  return {
    id: turn.turnId,
    status,
    items: turn.items.map((item: HistoryItem) => itemOf({ id: item.itemId, kind: item.kind, text: item.text, status: statusOf(item.status), ...(item.title !== undefined ? { title: item.title } : {}), ...(item.tool !== undefined ? { tool: item.tool } : {}) })),
  }
}

/** The prompt text of a turn's input: text as is, mentions as `@path`. Images are handled separately. */
export function inputText(input: readonly AppServerInput[]) {
  const parts: string[] = []
  for (const entry of input) {
    if (entry.type === "text" && typeof entry.text === "string") parts.push(entry.text)
    else if (entry.type === "mention" && typeof entry.path === "string" && entry.path) parts.push(`@${entry.path}`)
  }
  return parts.join("\n\n").trim()
}

export function createAppServer(deps: AppServerDeps) {
  const threads = new Map<SessionId, ThreadState>()
  const outgoing = new Map<RpcId, (message: AppServerMessage) => void>()
  let nextOutgoing = 1
  let initialized = false
  const startWait = deps.startWaitMs ?? 2_000

  const send = (message: Record<string, Json | undefined>) => deps.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  const respond = (id: RpcId, result: unknown) => send({ id, result: result as Json })
  const fail = (id: RpcId | null, error: RpcError) => send({ id, error: { code: error.code, message: redactSecrets(error.message).text, ...(error.data !== undefined ? { data: error.data as Json } : {}) } })
  const notify = (method: string, params: unknown) => send({ method, params: params as Json })
  const ask = (method: string, params: unknown) =>
    new Promise<AppServerMessage>((resolve) => {
      const id = `mend-${nextOutgoing++}`
      outgoing.set(id, resolve)
      send({ id, method, params: params as Json })
    })

  deps.listen((event) => onEvent(event))

  async function daemon(command: Parameters<AppServerDeps["client"]["send"]>[0]) {
    const reply = await deps.client.send(command)
    if (!reply.ok) throw new RpcError(reply.error.code === "unknown_session" ? APP_SERVER_ERRORS.unknownThread : APP_SERVER_ERRORS.daemon, reply.error.message, { code: reply.error.code })
    return reply.result ?? {}
  }

  async function detail(id: SessionId) {
    const reply = await daemon({ type: "session.get", sessionId: id })
    return reply.session as SessionDetail
  }

  async function attach(id: SessionId) {
    const existing = threads.get(id)
    if (existing) return existing
    // From the newest event on: history is read with thread/read, only what happens next streams here.
    const summary = await detail(id)
    const state: ThreadState = { id, items: new Map(), submitting: 0, held: [], starts: new Map(), requests: new Set() }
    threads.set(id, state)
    const reply = await deps.client.subscribe(id, summary.lastSeq)
    if (!reply.ok) {
      threads.delete(id)
      throw new RpcError(APP_SERVER_ERRORS.daemon, reply.error.message, { code: reply.error.code })
    }
    return state
  }

  const threadId = (params: Record<string, unknown>) => str(params.threadId, "threadId") as SessionId

  function remember(state: ThreadState, itemId: string, tracked: TrackedItem) {
    state.items.set(itemId, tracked)
    if (state.items.size > RECENT * 8) state.items.delete(state.items.keys().next().value as string)
  }

  function onEvent(event: SessionEvent) {
    const state = threads.get(event.sessionId)
    if (!state) return
    if (state.submitting > 0) {
      state.held.push(event)
      return
    }
    handle(state, event)
  }

  function handle(state: ThreadState, event: SessionEvent) {
    const threadId = state.id
    switch (event.type) {
      case "turn.started": {
        state.activeTurn = event.turnId
        const turn: AppServerTurn = { id: event.turnId, status: "inProgress" }
        for (const queueId of [event.queueId, ...(event.joinedQueueIds ?? [])]) {
          const pending = state.starts.get(String(queueId))
          if (!pending) continue
          clearTimeout(pending.timer)
          state.starts.delete(pending.queueId)
          respond(pending.rpcId, { queueId: pending.queueId, queued: false, turn })
        }
        notify("turn/started", { threadId, turn, queueId: event.queueId, ...(event.joinedQueueIds?.length ? { joinedQueueIds: [...event.joinedQueueIds] } : {}) })
        return
      }
      case "item.started": {
        const title = String(event.meta?.tool ?? "")
        remember(state, event.itemId, { kind: event.kind, turnId: event.turnId, tool: parseToolTitle(title).name, title })
        notify("item/started", { threadId, turnId: event.turnId, item: itemOf({ id: event.itemId, kind: event.kind, title, status: "inProgress" }) })
        return
      }
      case "item.delta": {
        const item = state.items.get(event.itemId)
        if (!item) return
        if (item.kind === "agent_message") notify("item/agentMessage/delta", { threadId, itemId: event.itemId, delta: event.text })
        else if (item.kind === "reasoning") notify("item/reasoning/textDelta", { threadId, itemId: event.itemId, delta: event.text })
        else if (item.kind === "tool_call") {
          const kind = toolKind(item.tool)
          notify(kind === "execute" ? "item/commandExecution/outputDelta" : kind === "edit" ? "item/fileChange/outputDelta" : "item/toolCall/outputDelta", { threadId, itemId: event.itemId, delta: event.text })
        }
        return
      }
      case "item.completed": {
        const item = state.items.get(event.itemId)
        if (!item) return
        state.items.delete(event.itemId)
        notify("item/completed", {
          threadId,
          turnId: item.turnId,
          item: itemOf({ id: event.itemId, kind: item.kind, title: item.title, status: statusOf(event.status), ...(event.text !== undefined ? { text: event.text } : {}), meta: event.meta }),
        })
        return
      }
      case "server.request":
        void onRequest(state, event)
        return
      case "server.request.resolved":
        state.requests.delete(event.requestId)
        notify("serverRequest/resolved", { threadId, requestId: event.requestId, resolution: event.resolution })
        return
      case "usage.recorded": {
        const total = event.input + event.output + event.reasoning
        notify("thread/tokenUsage/updated", {
          threadId,
          turnId: event.turnId,
          model: event.model,
          last: { inputTokens: event.input, outputTokens: event.output, reasoningOutputTokens: event.reasoning, cachedInputTokens: event.cacheRead, cacheWriteTokens: event.cacheWrite, totalTokens: total, ...(event.costMicros !== undefined ? { costMicros: event.costMicros } : {}) },
        })
        return
      }
      case "compaction.updated":
        notify("thread/compaction/updated", { threadId, turnId: event.turnId, reason: event.reason, state: event.state })
        return
      case "session.permission":
        notify("thread/approvalPolicy/changed", { threadId, approvalPolicy: event.mode })
        return
      case "turn.retrying":
        notify("turn/retrying", { threadId, turnId: event.turnId, attempt: event.attempt, nextAt: event.nextAt, message: event.message })
        return
      case "turn.completed":
      case "turn.cancelled":
      case "turn.interrupted":
      case "turn.failed": {
        if (state.activeTurn === event.turnId) state.activeTurn = undefined
        const turn: AppServerTurn =
          event.type === "turn.completed" ? { id: event.turnId, status: "completed" }
          : event.type === "turn.failed" ? { id: event.turnId, status: "failed", error: event.error }
          : { id: event.turnId, status: "interrupted", reason: event.type === "turn.cancelled" ? event.by : event.reason }
        notify("turn/completed", { threadId, turn })
        return
      }
      default:
        return
    }
  }

  async function onRequest(state: ThreadState, event: Extract<SessionEvent, { type: "server.request" }>) {
    const base = { threadId: state.id, turnId: event.turnId, requestId: event.requestId, ...(event.itemId ? { itemId: event.itemId } : {}) }
    const resolve = (decision: { kind: "approve"; scope: "once" | "session" } | { kind: "deny"; reason?: string } | { kind: "answer"; text: string; answers: string[][] }) =>
      deps.client.send({ type: "request.resolve", sessionId: state.id, requestId: event.requestId, decision })
    if (event.planReview) {
      notify("thread/attention", { threadId: state.id, turnId: event.turnId, requestId: event.requestId, reason: "planReview", title: event.title })
      return
    }
    state.requests.add(event.requestId)
    if (event.kind === "question") {
      const questions = event.questions ?? [{ header: "Question", question: event.title, options: event.options ?? [], ...(event.multiple ? { multiple: true } : {}) }]
      const reply = await ask("item/tool/requestUserInput", {
        ...base,
        questions: questions.map((question, index) => ({ id: `q${index}`, header: question.header, question: question.question, options: question.options, ...(question.multiple ? { multiple: true } : {}), isOther: question.custom !== false })),
      })
      if (!state.requests.delete(event.requestId)) return
      const answers = (reply.result as { answers?: Record<string, { answers?: unknown }> } | undefined)?.answers
      if (reply.error || !answers) {
        await resolve({ kind: "deny", reason: "the host did not answer; decide, state your assumption and continue" })
        return
      }
      const rows = questions.map((_, index) => {
        const given = answers[`q${index}`]?.answers
        const values = Array.isArray(given) ? given.filter((value): value is string => typeof value === "string" && value.length > 0).slice(0, 10) : []
        return values.length ? values : ["(no answer)"]
      })
      const text = questions.length === 1 ? rows[0]!.join("\n") : rows.map((row, index) => `${questions[index]!.header}: ${row.join(", ")}`).join("\n")
      await resolve({ kind: "answer", text, answers: rows })
      return
    }
    const kind = toolKind(event.tool ?? "")
    const method = kind === "execute" ? "item/commandExecution/requestApproval" : kind === "edit" ? "item/fileChange/requestApproval" : "item/tool/requestApproval"
    const reply = await ask(method, { ...base, ...(event.tool ? { tool: event.tool } : {}), title: event.title, detail: event.detail, ...(event.permission ? { permission: event.permission } : {}) })
    if (!state.requests.delete(event.requestId)) return
    const decision = (reply.result as { decision?: AppServerDecision } | undefined)?.decision
    if (decision === "accept") await resolve({ kind: "approve", scope: "once" })
    else if (decision === "acceptForSession") await resolve({ kind: "approve", scope: "session" })
    else {
      await resolve({ kind: "deny", reason: decision === "cancel" ? "the host cancelled the turn" : reply.error ? "the host could not answer the request" : "declined by the host" })
      if (decision === "cancel") await deps.client.send({ type: "turn.cancel", sessionId: state.id, turnId: event.turnId })
    }
  }

  async function attachments(input: readonly AppServerInput[]) {
    const refs: BlobRef[] = []
    for (const entry of input) {
      if (entry.type === "localImage") refs.push((await daemon({ type: "attachment.add", path: str(entry.path, "localImage.path")! })).attachment as BlobRef)
      else if (entry.type === "image") refs.push((await daemon({ type: "attachment.put", name: str(entry.name, "image.name")!, data: str(entry.data, "image.data")! })).attachment as BlobRef)
    }
    return refs
  }

  async function selection(params: Record<string, unknown>, id: SessionId) {
    const model = str(params.model, "model", true)
    const agent = str(params.agent, "agent", true)
    const level = effort(params.effort)
    if (!model && !agent && !level) return undefined
    const picked = await sessionSelection(deps.client, { ...(model ? { model } : {}), ...(agent ? { agent } : {}) }, { sessionId: id })
    if (!picked.ok) throw invalid(picked.message)
    const choice: ModelChoice | undefined = picked.model ? { ...picked.model, ...(level ? { effort: level } : {}) } : level ? await currentChoice(id, level) : undefined
    return { ...(choice ? { model: choice } : {}), ...(picked.agent ? { agent: picked.agent } : {}) }
  }

  async function currentChoice(id: SessionId, level: (typeof REASONING_EFFORTS)[number]): Promise<ModelChoice | undefined> {
    const report = (await daemon({ type: "models.list", sessionId: id })) as unknown as ModelsReport
    const base = report.effective ?? report.session ?? report.roles.main ?? report.defaults
    return base ? { ...base, effort: level } : undefined
  }

  async function startTurn(params: Record<string, unknown>, rpcId: RpcId) {
    const id = threadId(params)
    const state = await attach(id)
    const input = Array.isArray(params.input) ? (params.input as AppServerInput[]) : undefined
    if (!input?.length) throw invalid("input must be a non-empty array")
    for (const entry of input) {
      if (typeof entry !== "object" || entry === null || !["text", "mention", "localImage", "image"].includes((entry as { type?: string }).type ?? "")) throw invalid("input entries must be text, mention, localImage or image")
    }
    const text = inputText(input)
    if (text.length > MAX_INPUT_CHARS) throw invalid("input text is too long")
    const refs = await attachments(input)
    if (!text && !refs.length) throw invalid("input has no text, mention or image")
    const policy = mode(params.approvalPolicy)
    if (policy) await daemon({ type: "session.permission.set", sessionId: id, mode: policy })
    const selected = await selection(params, id)
    state.submitting++
    let queueId = ""
    try {
      const queued = await daemon({ type: "user.submit", sessionId: id, text, attachments: refs, ...(selected && Object.keys(selected).length ? { selection: selected } : {}) })
      queueId = String(queued.queueId ?? "")
    } catch (error) {
      state.submitting--
      drain(state)
      throw error
    }
    const pending: PendingStart = { rpcId, queueId }
    state.starts.set(queueId, pending)
    state.submitting--
    drain(state)
    if (!state.starts.has(queueId)) return
    if (state.activeTurn) {
      state.starts.delete(queueId)
      respond(rpcId, { queueId, queued: true, turn: null })
      return
    }
    pending.timer = setTimeout(() => {
      if (state.starts.delete(queueId)) respond(rpcId, { queueId, queued: true, turn: null })
    }, startWait)
    pending.timer.unref?.()
  }

  function drain(state: ThreadState) {
    if (state.submitting > 0) return
    for (const event of state.held.splice(0)) handle(state, event)
  }

  async function handleRequest(message: AppServerMessage) {
    const id = message.id as RpcId
    const params = (typeof message.params === "object" && message.params !== null && !Array.isArray(message.params) ? message.params : {}) as Record<string, unknown>
    if (message.method === "initialize") {
      if (initialized) throw new RpcError(APP_SERVER_ERRORS.alreadyInitialized, "already initialized")
      const info = params.clientInfo as { name?: unknown } | undefined
      if (!info || typeof info.name !== "string" || !info.name) throw invalid("clientInfo.name is required")
      initialized = true
      return respond(id, { protocol: APP_SERVER_PROTOCOL, serverInfo: { name: "MendCode", version: deps.version }, methods: METHODS, cwd: deps.cwd })
    }
    if (!initialized) throw new RpcError(APP_SERVER_ERRORS.notInitialized, "send initialize first")
    switch (message.method) {
      case "thread/start": {
        const cwd = str(params.cwd, "cwd", true) ?? deps.cwd
        const created = await daemon({ type: "session.create", directory: cwd, title: str(params.title, "title", true) ?? "" })
        const sessionId = created.sessionId as SessionId
        await attach(sessionId)
        const policy = mode(params.approvalPolicy)
        if (policy) await daemon({ type: "session.permission.set", sessionId, mode: policy })
        const chosen = await selection(params, sessionId)
        if (chosen?.model) await daemon({ type: "session.model.set", sessionId, choice: chosen.model })
        if (chosen?.agent) await daemon({ type: "session.agent.set", sessionId, agent: chosen.agent })
        const thread = threadOf(await detail(sessionId))
        respond(id, { thread })
        return notify("thread/started", { thread })
      }
      case "thread/resume": {
        const target = threadId(params)
        await attach(target)
        const policy = mode(params.approvalPolicy)
        if (policy) await daemon({ type: "session.permission.set", sessionId: target, mode: policy })
        const thread = threadOf(await detail(target))
        respond(id, { thread })
        return notify("thread/started", { thread })
      }
      case "thread/fork": {
        const forked = await daemon({ type: "session.fork", sessionId: threadId(params), ...(str(params.title, "title", true) ? { title: params.title as string } : {}), transcript: true })
        const sessionId = forked.sessionId as SessionId
        await attach(sessionId)
        const thread = threadOf(await detail(sessionId))
        respond(id, { thread })
        return notify("thread/started", { thread })
      }
      case "thread/list": {
        const limit = typeof params.limit === "number" ? Math.min(Math.max(Math.trunc(params.limit), 1), 200) : 50
        const cwd = str(params.cwd, "cwd", true)
        const search = str(params.search, "search", true)
        const listed = await daemon({ type: "session.list", limit, roots: true, ...(cwd ? { directory: cwd } : {}), ...(search ? { search } : {}), ...(params.archived === true ? { archived: true } : {}) })
        return respond(id, { data: ((listed.sessions ?? []) as SessionSummary[]).map(threadOf) })
      }
      case "thread/read": {
        const target = threadId(params)
        const thread = threadOf(await detail(target))
        if (params.includeTurns !== true) return respond(id, { thread })
        const limit = typeof params.limit === "number" ? Math.min(Math.max(Math.trunc(params.limit), 1), 50) : 20
        const page = await daemon({
          type: "session.history",
          sessionId: target,
          limit,
          ...(typeof params.before === "number" ? { before: params.before } : {}),
          ...(typeof params.after === "number" && typeof params.before !== "number" ? { after: params.after } : {}),
        })
        const turns = ((page.turns ?? []) as HistoryTurn[]).map(turnOf)
        return respond(id, { thread, turns, ...(page.older !== undefined ? { older: page.older } : {}), ...(page.newer !== undefined ? { newer: page.newer } : {}) })
      }
      case "thread/name/set":
        await daemon({ type: "session.rename", sessionId: threadId(params), title: str(params.name, "name")! })
        return respond(id, {})
      case "thread/archive":
        await daemon({ type: "session.archive", sessionId: threadId(params), ...(params.restore === true ? { restore: true } : {}) })
        return respond(id, {})
      case "thread/compact/start": {
        const instructions = str(params.instructions, "instructions", true)
        await daemon({ type: "session.compact", sessionId: threadId(params), ...(instructions ? { instructions } : {}) })
        return respond(id, {})
      }
      case "turn/start":
        return startTurn(params, id)
      case "turn/interrupt": {
        const target = threadId(params)
        const state = await attach(target)
        const turnId = (str(params.turnId, "turnId", true) as TurnId | undefined) ?? state.activeTurn
        if (!turnId) throw invalid("the thread has no running turn")
        await daemon({ type: "turn.cancel", sessionId: target, turnId })
        return respond(id, {})
      }
      case "model/list": {
        const target = str(params.threadId, "threadId", true) as SessionId | undefined
        const report = (await daemon({ type: "models.list", ...(target ? { sessionId: target } : {}) })) as unknown as ModelsReport
        const data: AppServerModel[] = report.models.map((model) => ({
          id: model.id,
          name: model.name,
          efforts: model.efforts,
          ...(model.provider ? { provider: model.provider } : {}),
          ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        }))
        const current = report.effective ?? report.session ?? report.defaults
        return respond(id, { data, ...(current?.model ? { default: current.model } : {}) })
      }
      default:
        throw new RpcError(APP_SERVER_ERRORS.methodNotFound, `method not found: ${message.method}`)
    }
  }

  return {
    /** One line from stdin: a request, a notification, or the host's reply to one of our requests. */
    async handleLine(line: string) {
      if (!line.trim()) return
      let message: AppServerMessage
      try {
        message = JSON.parse(line) as AppServerMessage
      } catch {
        return fail(null, new RpcError(APP_SERVER_ERRORS.parse, "parse error"))
      }
      if (typeof message !== "object" || message === null || Array.isArray(message)) return fail(null, new RpcError(APP_SERVER_ERRORS.invalidRequest, "invalid request"))
      if (message.method === undefined && message.id !== undefined && message.id !== null) {
        const waiter = outgoing.get(message.id)
        outgoing.delete(message.id)
        return waiter?.(message)
      }
      if (typeof message.method !== "string") return fail(message.id ?? null, new RpcError(APP_SERVER_ERRORS.invalidRequest, "invalid request"))
      if (message.id === undefined || message.id === null) return // notifications (initialized, ...) need no work
      try {
        await handleRequest(message)
      } catch (error) {
        fail(message.id, error instanceof RpcError ? error : new RpcError(APP_SERVER_ERRORS.internal, "internal error"))
      }
    },
  }
}
