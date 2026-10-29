import { randomUUID } from "node:crypto"
import { RetryableProviderError, type ModelMessage, type ModelProvider, type ModelRequest, type ToolCall } from "./provider"
import type { Fetch } from "./provider-http"
import { joinUrl } from "./provider-http"
import type { ResolvedProvider } from "./provider-factory"
import { gitlabConfig, gitlabJson, gitlabKey, gitlabUrl } from "./gitlab-http"
import { GITLAB_WORKFLOW_REFS } from "./gitlab-models"

/** Bun's built-in WebSocket supports upgrade headers; tests inject a local in-memory peer. */
export type GitLabSocket = Pick<WebSocket, "readyState" | "onopen" | "onmessage" | "onerror" | "onclose" | "send" | "close">
export type GitLabSocketFactory = (url: string, headers: Record<string, string>) => GitLabSocket
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => GitLabSocket
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const failure = (message: string) => new Error(`[PROVIDER]: GitLab Workflow ${message}`)
const MAX_BYTES = 4_000_000
const REF = /^[A-Za-z0-9_/.-]{1,200}$/

function tools(action: Record<string, unknown>): ToolCall[] | undefined {
  const callId = action.requestID
  if (typeof callId !== "string" || !/^[A-Za-z0-9_.:-]{1,190}$/.test(callId)) throw failure("action has no valid request ID")
  const mcp = object(action.runMCPTool)
  if (mcp && typeof mcp.name === "string" && typeof mcp.args === "string") {
    let args: unknown
    try { args = JSON.parse(mcp.args) } catch { throw failure("tool arguments are invalid JSON") }
    if (!object(args)) throw failure("tool arguments must be an object")
    return [{ callId, name: mcp.name, args }]
  }
  const read = object(action.runReadFile) ?? object(action.listDirectory)
  if (read) return [{ callId, name: "read", args: { path: read.filepath ?? read.directory } }]
  const write = object(action.runWriteFile)
  if (write) return [{ callId, name: "write", args: { path: write.filepath, content: write.contents } }]
  const edit = object(action.runEditFile)
  if (edit) return [{ callId, name: "edit", args: { path: edit.filepath, oldString: edit.oldString, newString: edit.newString } }]
  const shell = object(action.runShellCommand)
  if (shell) return [{ callId, name: "shell", args: { command: shell.command } }]
  const glob = object(action.findFiles)
  if (glob) return [{ callId, name: "glob", args: { pattern: glob.name_pattern ?? glob.namePattern } }]
  const grep = object(action.grep)
  if (grep) return [{ callId, name: "grep", args: { pattern: grep.pattern, path: grep.search_directory ?? grep.searchDirectory, ignoreCase: grep.case_insensitive ?? grep.caseInsensitive } }]
  const reads = object(action.runReadFiles)
  if (reads && Array.isArray(reads.filepaths) && reads.filepaths.length > 0 && reads.filepaths.length <= 64 && reads.filepaths.every((path) => typeof path === "string")) return reads.filepaths.map((path, index) => ({ callId: `${callId}:${index}`, name: "read", args: { path } }))
  const quote = (value: unknown) => {
    if (typeof value !== "string" || value.includes("\0")) throw failure("command arguments are invalid")
    return "'" + value.replaceAll("'", "'\"'\"'") + "'"
  }
  const command = object(action.runCommand) ?? object(action.runGitCommand)
  if (command) {
    const argv = [...(action.runGitCommand ? ["git", command.command] : [command.program]), ...(Array.isArray(command.flags) ? command.flags : []), ...(Array.isArray(command.arguments) ? command.arguments : [])]
    if (argv.length > 256) throw failure("command has too many arguments")
    return [{ callId, name: "shell", args: { command: argv.map(quote).join(" ") } }]
  }
  const mkdir = object(action.mkdir)
  if (mkdir) return [{ callId, name: "shell", args: { command: `mkdir -p -- ${quote(mkdir.directory_path ?? mkdir.directoryPath)}` } }]
  return undefined
}

type Session = { id: string; emitted: Map<string, string>; emittedBytes: number; touched: number; binding: string }
type Run = {
  handle: string
  model: string
  key: string
  session: Session
  socket: GitLabSocket
  pending?: { requestId: string; calls: ToolCall[] }
  seen: Set<string>
  queue: unknown[]
  bytes: number
  wake?: (() => void) | undefined
  error?: Error
  closed: boolean
  timer?: ReturnType<typeof setTimeout>
  heartbeat?: ReturnType<typeof setInterval>
  stop(terminate?: boolean): void
  send(value: unknown): void
  arm(ms: number): void
}

/** DWS drives generation; every local tool still runs in the native engine's permission loop. */
export function createGitLabWorkflowProvider(input: { provider: ResolvedProvider; fetch?: Fetch; gitlabSocket?: GitLabSocketFactory; idleTimeoutMs?: number }): ModelProvider {
  const { provider } = input
  const config = gitlabConfig(provider.gitlab)
  const base = gitlabUrl(provider.baseUrl).href.replace(/\/+$/, "")
  const fetcher = input.fetch ?? ((url, init) => fetch(url, init))
  const socketFactory = input.gitlabSocket ?? ((url, headers) => new BunWebSocket(url, { headers }))
  const runs = new Map<string, Run>()
  const sessions = new Map<string, Session>()
  const idle = input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000)
  const flags = { duo_agent_platform_agentic_chat: true, duo_agent_platform: true, ...config.featureFlags }

  async function start(request: ModelRequest, model: string, key: string): Promise<Run> {
    if (runs.size >= 32) throw failure("has too many active runs")
    const metadata = provider.models.find((entry) => entry.id === model)
    const ref = request.parameters?.workflowRef ?? metadata?.options?.workflowRef ?? Object.entries(GITLAB_WORKFLOW_REFS).find(([, id]) => id === model)?.[0] ?? (model === "duo-workflow" ? "default" : undefined)
    const definition = request.parameters?.workflowDefinition ?? metadata?.options?.workflowDefinition ?? "chat"
    if (typeof ref !== "string" || !REF.test(ref) || typeof definition !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(definition)) throw failure("requires a valid model reference and definition")
    const user = request.messages.findLast((message) => message.role === "user")
    const goal = user?.role === "user" ? user.content : ""
    if (!goal.trim() || goal.length > 10_000) throw failure("goal must contain 1–10000 characters")
    const transport = request.fetch ?? fetcher
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" }
    const guarded: Fetch = async (url, init) => { try { return await transport(url, init) } catch { throw failure("transport failed") } }
    const post = (route: string, body: unknown) => gitlabJson(guarded, joinUrl(base, route), { method: "POST", headers, body: JSON.stringify(body), signal: request.signal }, "workflow setup")
    // Rails scopes the DWS session here. Returned service URLs/tokens never choose our transport.
    await post("/api/v4/ai/duo_workflows/direct_access", { workflow_definition: definition, ...(config.rootNamespaceId ? { root_namespace_id: config.rootNamespaceId } : {}), feature_flags: flags })
    const binding = JSON.stringify([model, ref, definition, key])
    let session = request.conversationId ? sessions.get(request.conversationId) : undefined
    if (session?.binding !== binding || session && Date.now() - session.touched > 30 * 60_000) session = undefined
    const fresh = !session
    if (!session) {
      const result = await post("/api/v4/ai/duo_workflows/workflows", { goal, workflow_definition: definition, environment: "ide", agent_privileges: [6], allow_agent_to_request_user: false, ...(config.projectId ? { project_id: config.projectId } : {}), ...(config.rootNamespaceId ? { namespace_id: config.rootNamespaceId.split("/").at(-1) } : {}) })
      if (!((typeof result.id === "number" && Number.isSafeInteger(result.id) && result.id > 0) || typeof result.id === "string" && /^[1-9][0-9]{0,19}$/.test(result.id))) throw failure("returned an invalid workflow ID")
      session = { id: String(result.id), emitted: new Map(), emittedBytes: 0, touched: Date.now(), binding }
    }
    const url = new URL(joinUrl(base, "/api/v4/ai/duo_workflows/ws"))
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    if (ref !== "default") url.searchParams.set("user_selected_model_identifier", ref)
    url.searchParams.set("workflow_definition", definition)
    const socket = socketFactory(url.href, { authorization: `Bearer ${key}`, origin: new URL(base).origin, "x-gitlab-client-type": "node-websocket", "x-gitlab-language-server-version": "8.51.0", "user-agent": "mendcode GitLab", ...(config.projectId ? { "x-gitlab-project-id": config.projectId } : {}), ...(config.rootNamespaceId ? { "x-gitlab-root-namespace-id": config.rootNamespaceId } : {}) })
    const turnSignal = request.turnSignal ?? request.signal
    const run: Run = {
      handle: randomUUID(), model, key, session, socket, seen: new Set(), queue: [], bytes: 0, closed: false,
      send(value) {
        const text = JSON.stringify(value)
        if (Buffer.byteLength(text) > MAX_BYTES) throw failure("outgoing message exceeds 4MB")
        if (socket.readyState !== 1) throw failure("connection is closed")
        socket.send(text)
      },
      arm(ms) {
        clearTimeout(run.timer)
        if (!run.closed && ms > 0) run.timer = setTimeout(() => { run.error = failure("stream timed out"); run.stop() }, ms)
      },
      stop(terminate = true) {
        if (run.closed) return
        run.closed = true
        clearTimeout(run.timer); clearInterval(run.heartbeat)
        turnSignal.removeEventListener("abort", abort)
        runs.delete(run.handle)
        socket.onmessage = null; socket.onerror = null; socket.onopen = null; socket.onclose = null
        try { if (terminate && socket.readyState === 1) socket.send(JSON.stringify({ stopWorkflow: { reason: "USER_ACTION_TRIGGERED_STOP" } })) } catch {}
        try { socket.close(1000, "Client stopping") } catch {}
        run.wake?.()
      },
    }
    const abort = () => run.stop()
    turnSignal.addEventListener("abort", abort, { once: true })
    runs.set(run.handle, run)
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => { run.error = error; reject(error); run.stop() }
        run.wake = () => reject(run.error ?? failure("cancelled during connection"))
        run.arm(Math.min(idle || 30_000, 30_000))
        socket.onopen = () => { run.arm(idle); resolve() }
        socket.onerror = () => fail(failure("WebSocket transport failed"))
        socket.onclose = () => fail(failure("connection closed before completion"))
        socket.onmessage = (event) => {
          if (run.closed) return
          const data = event.data
          const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : ArrayBuffer.isView(data) ? new TextDecoder().decode(data) : undefined
          if (text === undefined || Buffer.byteLength(text) > MAX_BYTES || run.queue.length >= 128 || run.bytes + Buffer.byteLength(text) > MAX_BYTES) { fail(failure("incoming message exceeds limits")); return }
          try { const value = JSON.parse(text); if (!object(value)) throw new Error(); run.queue.push(value); run.bytes += Buffer.byteLength(text) } catch { fail(failure("received invalid JSON")); return }
          if (!run.pending) run.arm(idle)
          run.wake?.()
        }
        if (turnSignal.aborted || request.signal.aborted) abort()
        else if (socket.readyState === 1) { run.arm(idle); resolve() }
      })
      run.wake = undefined
      const additional_context = fresh ? [
        { category: "system_prompt", content: request.system, metadata: JSON.stringify({ role: "system" }) },
        ...request.messages.slice(0, request.messages.lastIndexOf(user!)).map((message) => ({ category: "conversation", content: message.role === "tool" ? message.output : message.content, metadata: JSON.stringify({ role: message.role }) })),
      ] : [{ category: "system_prompt", content: request.system, metadata: JSON.stringify({ role: "system" }) }]
      run.send({ startRequest: { workflowID: session.id, clientVersion: "8.51.0", workflowDefinition: definition, goal, additional_context, clientCapabilities: [], mcpTools: request.tools.map((entry) => ({ name: entry.name, description: entry.description, inputSchema: JSON.stringify(entry.parameters) })), preapproved_tools: request.tools.map((entry) => entry.name) } })
      if (run.error) throw run.error
      if (run.closed) throw failure("cancelled during setup")
      run.heartbeat = setInterval(() => { try { run.send({ heartbeat: { timestamp: Date.now() } }) } catch { run.error = failure("heartbeat failed"); run.stop() } }, 60_000)
      return run
    } catch (error) { run.stop(); throw error }
  }

  return {
    id: provider.id, model: "duo-workflow",
    async *stream(request) {
      if (request.signal.aborted || request.turnSignal?.aborted) return
      const model = request.model ?? "duo-workflow"
      const key = gitlabKey(provider)
      // The handle is private reasoning state, never a credential or wire-visible command.
      const assistant = request.messages.findLast((message) => message.role === "assistant")
      const state = request.messages.at(-1)?.role === "tool" && assistant?.role === "assistant" ? assistant.reasoning : undefined
      const handle = state?.provider === provider.id && state.model === model ? object(state.blocks[0])?.gitlabWorkflow : undefined
      let run: Run | undefined
      let handedOff = false
      const abortCall = () => run?.stop()
      request.signal.addEventListener("abort", abortCall, { once: true })
      try {
        if (state?.provider === provider.id && object(state.blocks[0])?.gitlabWorkflow && state.model !== model) throw failure("tool continuation belongs to a different model")
        if (typeof handle === "string") {
          run = runs.get(handle)
          if (!run || run.closed || run.key !== key || !run.pending) { run?.stop(); throw failure("tool continuation expired; start a new turn") }
          const pending = run.pending
          const results = pending.calls.map((call) => request.messages.findLast((message): message is Extract<ModelMessage, { role: "tool" }> => message.role === "tool" && message.callId === call.callId && message.name === call.name))
          if (results.some((result) => !result)) throw failure("tool continuation has no matching result")
          run.send({ actionResponse: { requestID: pending.requestId, plainTextResponse: { response: results.map((result) => result!.output).join("\n"), error: results.some((result) => result!.isError) ? "Local tool failed or was denied" : null } } })
          delete run.pending
          run.arm(idle)
        } else run = await start(request, model, key)
        if (request.signal.aborted || request.turnSignal?.aborted) return
        const active = run
        while (!active.closed || active.queue.length) {
          if (active.error) throw active.error
          if (!active.queue.length) { await new Promise<void>((resolve) => { active.wake = resolve; if (active.closed || active.queue.length) resolve() }); active.wake = undefined; continue }
          const action = object(active.queue.shift())!
          active.bytes = Math.max(0, active.bytes - Buffer.byteLength(JSON.stringify(action)))
          const checkpoint = object(action.newCheckpoint)
          if (checkpoint) {
            if (checkpoint.status === "FAILED") throw failure("failed on the server")
            if (["TOOL_CALL_APPROVAL_REQUIRED", "PLAN_APPROVAL_REQUIRED", "INPUT_REQUIRED", "PAUSED"].includes(String(checkpoint.status))) throw failure("requires server approval/input; no local permission was bypassed")
            if (typeof checkpoint.checkpoint === "string") {
              let data: Record<string, unknown> | undefined
              try { data = object(JSON.parse(checkpoint.checkpoint)) } catch { throw failure("checkpoint is invalid JSON") }
              const log = object(data?.channel_values)?.ui_chat_log
              if (Array.isArray(log)) for (const [index, value] of log.entries()) {
                const entry = object(value)
                if (entry?.message_type !== "agent" || typeof entry.content !== "string") continue
                const id = typeof entry.message_id === "string" ? entry.message_id : `agent-${index}`
                const previous = active.session.emitted.get(id) ?? ""
                if (!entry.content.startsWith(previous)) throw failure("checkpoint rewrote streamed text")
                const delta = entry.content.slice(previous.length)
                if (active.session.emitted.size >= 512 && !active.session.emitted.has(id)) throw failure("has too many checkpoint messages")
                active.session.emittedBytes += Buffer.byteLength(delta)
                if (active.session.emittedBytes > MAX_BYTES) throw failure("checkpoint history exceeds 4MB")
                active.session.emitted.set(id, entry.content)
                if (delta) yield { type: entry.message_sub_type === "reasoning" ? "reasoning" : "text", delta }
              }
            } else if (typeof checkpoint.content === "string" && checkpoint.content) yield { type: "text", delta: checkpoint.content }
            if (["FINISHED", "COMPLETED", "STOPPED", "CANCELLED"].includes(String(checkpoint.status))) {
              active.session.touched = Date.now()
              if (request.conversationId) {
                if (!sessions.has(request.conversationId) && sessions.size >= 64) sessions.delete(sessions.keys().next().value!)
                sessions.set(request.conversationId, active.session)
              }
              // DWS has no measured usage; do not invent token counts from character counts.
              active.stop(false)
              yield { type: "finish", reason: "stop" }
              return
            }
            continue
          }
          const calls = tools(action)
          if (active.seen.has(String(action.requestID))) continue
          active.seen.add(String(action.requestID))
          if (active.seen.size > 512) throw failure("has too many tool actions")
          if (!calls || calls.some((call) => !request.tools.some((entry) => entry.name === call.name))) {
            active.send({ actionResponse: { requestID: action.requestID, plainTextResponse: { response: "", error: "Tool not advertised by this client" } } })
            continue
          }
          active.pending = { requestId: String(action.requestID), calls }
          active.arm(provider.timeout === false ? 0 : provider.timeout ?? 300_000)
          yield { type: "reasoning_state", state: { provider: provider.id, model, blocks: [{ gitlabWorkflow: active.handle }] } }
          for (const call of calls) yield { type: "tool_call", call }
          yield { type: "finish", reason: "tool_calls" }
          handedOff = true
          return
        }
        if (active.error) throw active.error
        if (!request.signal.aborted) throw failure("connection closed before completion")
      } catch (error) {
        if (request.signal.aborted || request.turnSignal?.aborted) return
        if (request.conversationId) sessions.delete(request.conversationId)
        // Only our own structured errors can leave the transport; never echo remote content.
        if (error instanceof RetryableProviderError) throw error
        if (error instanceof Error && /^\[(PROVIDER|AUTH)\]: GitLab/.test(error.message)) throw error
        throw failure("transport failed")
      } finally {
        request.signal.removeEventListener("abort", abortCall)
        if (!handedOff) run?.stop()
      }
    },
  }
}
