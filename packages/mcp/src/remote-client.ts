import { isRecord, listAllTools, mapCallResult, McpError, MCP_PROTOCOL_VERSION, type McpCallResult, type McpClient, type McpClientState, type McpToolInfo } from "./client"
import { DEFAULT_SERVER_TIMEOUT_MS, type McpServerConfig } from "./config"
import { parseChallenge, type AuthChallenge, type FetchFn, type McpAuth } from "./oauth"
import { parseSse } from "./sse"
import { DeadlineGroup } from "./deadline"
import { respondToElicitation, type ElicitHandler } from "./elicitation"
import { listAllPrompts, promptText, type McpPromptInfo } from "./prompts"
import { catalogList, parsePrompt, parseResource, parseTemplate, promptResult, resourceContents, type McpCatalog, type McpPromptResult, type McpResourceContent } from "./catalog"

type Json = Record<string, unknown>
type Send = (url: string, init: RequestInit) => Promise<Response>
type RpcInput = { method: string; params?: Json | undefined; timeoutMs: number; signal?: AbortSignal | undefined }

const ERROR_BODY_CHARS = 300
const CLOSE_TIMEOUT_MS = 1_000

/** An HTTP answer that is not a success; `status` lets the client tell "no such endpoint" from a real failure. */
export class McpHttpError extends McpError {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "McpHttpError"
  }
}

/** The server answered 401 and no stored token fixes it: the user has to authorize (or fix the configured headers). */
export class McpAuthRequiredError extends McpError {
  constructor(message: string) {
    super(message)
    this.name = "McpAuthRequiredError"
  }
}

async function httpError({ name, response }: { name: string; response: Response }): Promise<McpHttpError> {
  const body = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, ERROR_BODY_CHARS)
  return new McpHttpError(`MCP server "${name}" answered HTTP ${response.status}${body ? `: ${body}` : ""}`, response.status)
}

/** One way to talk to a remote server: streamable HTTP (one POST per message) or the older HTTP+SSE pair. */
interface Transport {
  readonly alive: boolean
  /** A session id is in use; a 404 then means the session expired and the client starts a new one. */
  readonly hasSession: boolean
  rpc(input: RpcInput): Promise<unknown>
  notify(method: string, params?: Json): Promise<void>
  close(): Promise<void>
}

type Hooks = {
  onToolsChanged(): void
  onCatalogChanged(method: string): void
  /** The reply to a server-initiated request: `ping` and `elicitation/create` are supported. */
  onRequest(method: string, params: unknown): Promise<Json>
  /** Request timeouts, which stand still while the person answers an elicitation. */
  deadlines: DeadlineGroup
}

const rpcBody = ({ id, method, params }: { id: number; method: string; params?: Json | undefined }): Json => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })

function responseError(message: Json): McpError {
  const error = isRecord(message.error) ? message.error : {}
  return new McpError(String(error.message ?? "request failed"), typeof error.code === "number" ? error.code : undefined)
}

/** Abort, timeout and network failures of one request, in the same words the stdio client uses. */
function mapFailure({ error, name, method, timeoutMs, signal }: { error: unknown; name: string; method: string; timeoutMs: number; signal?: AbortSignal | undefined }): Error {
  if (error instanceof McpError) return error
  if (signal?.aborted) return new McpError("cancelled")
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return new McpError(`${method} timed out after ${timeoutMs} ms`)
  return new McpError(`MCP server "${name}" request failed: ${error instanceof Error ? error.message : String(error)}`)
}

class StreamableTransport implements Transport {
  alive = true
  private sessionId: string | undefined
  private protocolVersion: string | undefined
  private nextId = 1

  constructor(
    private readonly name: string,
    private readonly url: string,
    private readonly send: Send,
    private readonly hooks: Hooks,
  ) {}

  get hasSession(): boolean {
    return this.sessionId !== undefined
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
    }
  }

  /** Handles one message of a response; returns the final answer to `id` when this is it. */
  private accept({ message, id }: { message: unknown; id: number | undefined }): { value: unknown } | undefined {
    if (!isRecord(message)) return undefined
    if (typeof message.method === "string") {
      if (message.method === "notifications/tools/list_changed") this.hooks.onToolsChanged()
      this.hooks.onCatalogChanged(String(message.method))
      if (message.id !== undefined) {
        const requestId = message.id
        void this.hooks.onRequest(message.method, message.params).then((reply) => this.post({ body: { jsonrpc: "2.0", id: requestId, ...reply }, timeoutMs: 10_000 })).catch(() => undefined)
      }
      return undefined
    }
    if (id === undefined || message.id !== id) return undefined
    if (isRecord(message.error)) throw responseError(message)
    return { value: message.result }
  }

  private async post({ body, id, timeoutMs, signal, method = "request" }: { body: Json; id?: number; timeoutMs: number; signal?: AbortSignal | undefined; method?: string }): Promise<unknown> {
    const { deadline, done } = this.hooks.deadlines.start(timeoutMs)
    const combined = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])])
    try {
      const response = await this.send(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: combined })
      const session = response.headers.get("mcp-session-id")
      if (session) this.sessionId = session
      if (!response.ok) throw await httpError({ name: this.name, response })
      if (id === undefined) {
        await response.body?.cancel().catch(() => undefined)
        return undefined
      }
      const type = response.headers.get("content-type") ?? ""
      if (type.includes("text/event-stream")) {
        if (!response.body) throw new McpError(`MCP server "${this.name}" sent an empty event stream`)
        for await (const event of parseSse(response.body)) {
          let message: unknown
          try {
            message = JSON.parse(event.data)
          } catch {
            continue
          }
          for (const item of Array.isArray(message) ? message : [message]) {
            const answer = this.accept({ message: item, id })
            if (answer) return answer.value
          }
        }
        throw new McpError(`MCP server "${this.name}" ended the stream without answering ${method}`)
      }
      const message = JSON.parse(await response.text()) as unknown
      for (const item of Array.isArray(message) ? message : [message]) {
        const answer = this.accept({ message: item, id })
        if (answer) return answer.value
      }
      throw new McpError(`MCP server "${this.name}" did not answer ${method}`)
    } catch (error) {
      throw error instanceof SyntaxError ? new McpError(`MCP server "${this.name}" sent a response that is not JSON`) : mapFailure({ error, name: this.name, method, timeoutMs, signal })
    } finally {
      done()
    }
  }

  async rpc({ method, params, timeoutMs, signal }: RpcInput): Promise<unknown> {
    if (signal?.aborted) throw new McpError("cancelled")
    const id = this.nextId++
    try {
      const result = await this.post({ body: rpcBody({ id, method, params }), id, timeoutMs, signal, method })
      if (method === "initialize" && isRecord(result) && typeof result.protocolVersion === "string") this.protocolVersion = result.protocolVersion
      return result
    } catch (error) {
      if (signal?.aborted && method !== "initialize") void this.notify("notifications/cancelled", { requestId: id, reason: "aborted" }).catch(() => undefined)
      throw error
    }
  }

  async notify(method: string, params?: Json): Promise<void> {
    await this.post({ body: { jsonrpc: "2.0", method, ...(params ? { params } : {}) }, timeoutMs: 10_000, method })
  }

  async close(): Promise<void> {
    this.alive = false
    if (!this.sessionId) return
    const headers = this.headers()
    this.sessionId = undefined
    await this.send(this.url, { method: "DELETE", headers, signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS) }).then((response) => response.body?.cancel(), () => undefined)
  }
}

type PendingCall = { resolve(value: unknown): void; reject(error: Error): void }

/** The 2024-11-05 transport: a long-lived GET stream carries every answer; requests are POSTed to the URL it announces. */
class LegacySseTransport implements Transport {
  alive = true
  readonly hasSession = false
  private readonly abort = new AbortController()
  private endpoint: string | undefined
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 1

  constructor(
    private readonly name: string,
    private readonly url: string,
    private readonly send: Send,
    private readonly hooks: Hooks,
    private readonly onClosed: (error: McpError) => void,
  ) {}

  async connect(timeoutMs: number): Promise<void> {
    const connectSignal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)])
    let response: Response
    try {
      response = await this.send(this.url, { method: "GET", headers: { accept: "text/event-stream" }, signal: this.abort.signal })
    } catch (error) {
      throw mapFailure({ error, name: this.name, method: "connect", timeoutMs })
    }
    if (!response.ok) throw await httpError({ name: this.name, response })
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream") || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      throw new McpHttpError(`MCP server "${this.name}" did not open an event stream`, 406)
    }
    const announced = new Promise<string>((resolve, reject) => {
      connectSignal.addEventListener("abort", () => reject(new McpError(`MCP server "${this.name}" sent no endpoint event within ${timeoutMs} ms`)), { once: true })
      void this.read({ body: response.body as ReadableStream<Uint8Array>, resolveEndpoint: resolve, rejectEndpoint: reject })
    })
    this.endpoint = await announced
  }

  private async read({ body, resolveEndpoint, rejectEndpoint }: { body: ReadableStream<Uint8Array>; resolveEndpoint(url: string): void; rejectEndpoint(error: Error): void }): Promise<void> {
    let reason = "closed the event stream"
    try {
      for await (const event of parseSse(body)) {
        if (event.event === "endpoint") {
          try {
            const endpoint = new URL(event.data.trim(), this.url)
            if (endpoint.origin !== new URL(this.url).origin) throw new McpError(`MCP server "${this.name}" announced an endpoint on another origin`)
            resolveEndpoint(endpoint.href)
          } catch (error) {
            rejectEndpoint(error instanceof Error ? error : new McpError(String(error)))
          }
          continue
        }
        let message: unknown
        try {
          message = JSON.parse(event.data)
        } catch {
          continue
        }
        this.dispatch(message)
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
    }
    const error = new McpError(`MCP server "${this.name}" ${reason}`)
    rejectEndpoint(error)
    if (this.alive) {
      this.alive = false
      for (const pending of [...this.pending.values()]) pending.reject(error)
      this.onClosed(error)
    }
  }

  private dispatch(message: unknown): void {
    if (!isRecord(message)) return
    if (typeof message.method === "string") {
      if (message.method === "notifications/tools/list_changed") this.hooks.onToolsChanged()
      this.hooks.onCatalogChanged(String(message.method))
      if (message.id !== undefined) {
        const requestId = message.id
        void this.hooks.onRequest(message.method, message.params).then((reply) => this.post({ body: { jsonrpc: "2.0", id: requestId, ...reply }, timeoutMs: 10_000 })).catch(() => undefined)
      }
      return
    }
    if (typeof message.id !== "number") return
    const pending = this.pending.get(message.id)
    if (!pending) return
    if (isRecord(message.error)) pending.reject(responseError(message))
    else pending.resolve(message.result)
  }

  private async post({ body, timeoutMs, signal }: { body: Json; timeoutMs: number; signal?: AbortSignal | undefined }): Promise<void> {
    if (!this.endpoint) throw new McpError(`MCP server "${this.name}" has no message endpoint`)
    const response = await this.send(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    })
    if (!response.ok) throw await httpError({ name: this.name, response })
    await response.body?.cancel().catch(() => undefined)
  }

  rpc({ method, params, timeoutMs, signal }: RpcInput): Promise<unknown> {
    if (!this.alive) return Promise.reject(new McpError(`MCP server "${this.name}" closed the event stream`))
    if (signal?.aborted) return Promise.reject(new McpError("cancelled"))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const { deadline, done } = this.hooks.deadlines.start(timeoutMs)
      const cleanup = () => {
        done()
        signal?.removeEventListener("abort", onAbort)
        this.pending.delete(id)
      }
      deadline.signal.addEventListener("abort", () => {
        cleanup()
        reject(new McpError(`${method} timed out after ${timeoutMs} ms`))
      }, { once: true })
      const onAbort = () => {
        cleanup()
        if (method !== "initialize") void this.notify("notifications/cancelled", { requestId: id, reason: "aborted" }).catch(() => undefined)
        reject(new McpError("cancelled"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => (cleanup(), resolve(value)),
        reject: (error) => (cleanup(), reject(error)),
      })
      this.post({ body: rpcBody({ id, method, params }), timeoutMs, ...(signal ? { signal } : {}) }).catch((error: unknown) => {
        if (this.pending.has(id)) {
          cleanup()
          reject(mapFailure({ error, name: this.name, method, timeoutMs, signal }))
        }
      })
    })
  }

  async notify(method: string, params?: Json): Promise<void> {
    await this.post({ body: { jsonrpc: "2.0", method, ...(params ? { params } : {}) }, timeoutMs: 10_000 })
  }

  async close(): Promise<void> {
    this.alive = false
    this.abort.abort()
    for (const pending of [...this.pending.values()]) pending.reject(new McpError(`MCP server "${this.name}" was closed`))
  }
}

class RemoteMcpClient implements McpClient {
  private transport: Transport | undefined
  private ready: Promise<void> | undefined
  private tools: McpToolInfo[] | undefined
  private closed = false
  private connected = false
  private connecting = false
  private error: string | undefined
  private needsAuthFlag = false
  private capabilities: Record<string, unknown> = {}
  private resources: McpCatalog["resources"] | undefined
  private templates: McpCatalog["templates"] | undefined
  private prompts: McpCatalog["prompts"] | undefined
  private challenge: AuthChallenge | undefined
  private readonly url: string
  private readonly headers: Record<string, string>

  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
    private readonly auth: McpAuth | undefined,
    private readonly fetch: FetchFn,
  ) {
    this.url = config.url as string
    this.headers = Object.fromEntries(Object.entries(config.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
  }

  get state(): McpClientState {
    if (this.closed) return "stopped"
    if (this.connected) return "running"
    if (this.connecting) return "starting"
    return this.error ? "failed" : "stopped"
  }
  get lastError(): string | undefined {
    return this.error
  }
  get toolCount(): number {
    return this.tools?.length ?? 0
  }
  get alive(): boolean {
    return this.connected
  }
  get pid(): number | undefined {
    return undefined
  }
  get needsAuth(): boolean {
    return this.needsAuthFlag
  }
  get authChallenge(): AuthChallenge | undefined {
    return this.challenge
  }
  private get timeoutMs(): number {
    return this.config.timeoutMs ?? DEFAULT_SERVER_TIMEOUT_MS
  }
  stderr(): string {
    return ""
  }

  /** Every request goes through here: configured headers, the stored OAuth token, one refresh on a 401. */
  private readonly send: Send = async (url, init) => {
    let refreshed = false
    for (;;) {
      const token = this.config.oauth === false ? undefined : await this.auth?.accessToken(this.url)
      const headers = { ...this.headers, ...(init.headers as Record<string, string> | undefined), ...(token ? { authorization: `Bearer ${token}` } : {}) }
      const response = await this.fetch(url, { ...init, headers })
      if (response.status !== 401) {
        this.needsAuthFlag = false
        return response
      }
      this.challenge = parseChallenge(response.headers.get("www-authenticate"))
      await response.body?.cancel().catch(() => undefined)
      if (token && !refreshed && this.auth && (await this.auth.refresh(this.url))) {
        refreshed = true
        continue
      }
      if (this.config.oauth === false || !this.auth) throw new McpAuthRequiredError(`MCP server "${this.name}" rejected the configured credentials (HTTP 401); check its headers in mcp.json`)
      this.needsAuthFlag = true
      throw new McpAuthRequiredError(`MCP server "${this.name}" needs authorization: the user must authorize it (OAuth) before its tools can be used`)
    }
  }

  private readonly deadlines = new DeadlineGroup()
  /** Handlers of the tool calls in flight, newest last: the server's questions go to the latest one. */
  private readonly elicitors: ElicitHandler[] = []

  private readonly hooks: Hooks = {
    deadlines: this.deadlines,
    onRequest: async (method, params) => {
      if (method === "ping") return { result: {} }
      if (method === "elicitation/create") {
        const handler = this.config.elicitation === false ? undefined : this.elicitors[this.elicitors.length - 1]
        return { ...(await respondToElicitation({ server: this.name, params, handler, waiting: { start: () => this.deadlines.hold(), end: () => this.deadlines.release() } })) }
      }
      return { error: { code: -32601, message: `method not supported: ${method}` } }
    },
    onToolsChanged: () => (this.tools = undefined),
    onCatalogChanged: (method) => {
      if (method === "notifications/resources/list_changed") this.resources = this.templates = undefined
      if (method === "notifications/prompts/list_changed") this.prompts = undefined
    },
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new McpError(`MCP server "${this.name}" is closed`))
    if (this.ready && this.connected && this.transport?.alive) return this.ready
    const attempt = this.connect().catch((error: unknown) => {
      if (this.ready === attempt) this.ready = undefined
      throw error
    })
    this.ready = attempt
    return attempt
  }

  private async connect(): Promise<void> {
    await this.dropTransport()
    this.tools = undefined
    this.resources = this.templates = this.prompts = undefined
    this.capabilities = {}
    this.error = undefined
    this.connecting = true
    try {
      this.transport = await this.open()
      this.connected = true
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.connecting = false
    }
  }

  private async handshake(transport: Transport): Promise<void> {
    const initialized = await transport.rpc({
      method: "initialize",
      params: { protocolVersion: MCP_PROTOCOL_VERSION, clientInfo: { name: "mendcode", version: "2" }, capabilities: this.config.elicitation === false ? {} : { elicitation: {} } },
      timeoutMs: this.timeoutMs,
    })
    this.capabilities = isRecord(initialized) && isRecord(initialized.capabilities) ? initialized.capabilities : {}
    await transport.notify("notifications/initialized")
  }

  /** Streamable HTTP first; a server that has no such endpoint (400/404/405) gets the legacy SSE transport. */
  private async open(): Promise<Transport> {
    const mode = this.config.transport
    if (mode !== "sse") {
      const streamable = new StreamableTransport(this.name, this.url, this.send, this.hooks)
      try {
        await this.handshake(streamable)
        return streamable
      } catch (error) {
        await streamable.close()
        if (mode === "http" || !(error instanceof McpHttpError) || ![400, 404, 405].includes(error.status)) throw error
      }
    }
    const legacy = new LegacySseTransport(this.name, this.url, this.send, this.hooks, (error) => {
      if (this.transport === legacy) {
        this.connected = false
        this.transport = undefined
        this.ready = undefined
        this.tools = undefined
        this.error = error.message
      }
    })
    try {
      await legacy.connect(this.timeoutMs)
      await this.handshake(legacy)
      return legacy
    } catch (error) {
      await legacy.close()
      throw error
    }
  }

  private async dropTransport(): Promise<void> {
    const transport = this.transport
    this.transport = undefined
    this.connected = false
    this.ready = undefined
    if (transport) await transport.close()
  }

  private async call({ method, params, signal }: { method: string; params?: Json | undefined; signal?: AbortSignal | undefined }): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      await this.start()
      const transport = this.transport
      if (!transport) throw new McpError(`MCP server "${this.name}" is not connected`)
      try {
        return await transport.rpc({ method, params, timeoutMs: this.timeoutMs, signal })
      } catch (error) {
        // A 404 on a session means the server forgot it: start a new one and repeat the request once.
        if (attempt === 0 && error instanceof McpHttpError && error.status === 404 && transport.hasSession) {
          await this.dropTransport()
          continue
        }
        throw error
      }
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    await this.start()
    if (this.tools) return this.tools
    const tools = await listAllTools((params) => this.call({ method: "tools/list", params }))
    this.tools = tools
    return tools
  }

  async listPrompts(): Promise<McpPromptInfo[]> {
    return listAllPrompts((params) => this.call({ method: "prompts/list", params }))
  }

  async getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<string> {
    return promptText(await this.call({ method: "prompts/get", params: { name, arguments: args }, signal }), true)
  }

  async catalog(): Promise<McpCatalog> {
    await this.start()
    const list = <T>(method: string, field: string, parse: (value: unknown) => T | undefined) => catalogList((params) => this.call({ method, params }), field, parse)
    const issues: string[] = []
    const issue = (method: string, error: unknown) => issues.push(`${method}: ${error instanceof Error ? error.message : String(error)}`)
    if (this.capabilities.resources) {
      try { this.resources ??= await list("resources/list", "resources", parseResource) } catch (error) { issue("resources/list", error) }
      try { this.templates ??= await list("resources/templates/list", "resourceTemplates", parseTemplate) } catch (error) {
        if (error instanceof McpError && error.code === -32601) this.templates = []
        else issue("resources/templates/list", error)
      }
    }
    if (this.capabilities.prompts) {
      try { this.prompts ??= await list("prompts/list", "prompts", parsePrompt) } catch (error) { issue("prompts/list", error) }
    }
    return { resources: this.resources ?? [], templates: this.templates ?? [], prompts: this.prompts ?? [], ...(issues.length ? { issues } : {}) }
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpResourceContent[]> {
    await this.start()
    return resourceContents(await this.call({ method: "resources/read", params: { uri }, ...(signal ? { signal } : {}) }))
  }

  async getPromptResult(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<McpPromptResult> {
    await this.start()
    return promptResult(await this.call({ method: "prompts/get", params: { name, arguments: args }, ...(signal ? { signal } : {}) }))
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, elicit?: ElicitHandler): Promise<McpCallResult> {
    if (elicit) this.elicitors.push(elicit)
    try {
      return mapCallResult(await this.call({ method: "tools/call", params: { name, arguments: args }, signal }))
    } finally {
      if (elicit) this.elicitors.splice(this.elicitors.lastIndexOf(elicit), 1)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.dropTransport()
    this.tools = undefined
  }
}

/** A remote server (`url` in the config) over streamable HTTP or legacy SSE, with OAuth when `auth` is given. */
export function createRemoteMcpClient({ name, config, auth, fetch = globalThis.fetch as FetchFn }: { name: string; config: McpServerConfig; auth?: McpAuth | undefined; fetch?: FetchFn }): McpClient {
  if (config.url === undefined) throw new McpError(`MCP server "${name}" has no url`)
  return new RemoteMcpClient(name, config, auth, fetch)
}
