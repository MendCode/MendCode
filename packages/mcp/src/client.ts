import { spawn, type ChildProcess } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { killProcessTree } from "@mendcode/tools"
import { DEFAULT_SERVER_TIMEOUT_MS, type McpServerConfig } from "./config"
import { serverEnvironment } from "./env"
import type { AuthChallenge } from "./oauth"
import { TailBuffer } from "./tail-buffer"
import { DeadlineGroup } from "./deadline"
import { respondToElicitation, type ElicitHandler } from "./elicitation"
import { listAllPrompts, promptText, type McpPromptInfo } from "./prompts"
import { catalogList, parsePrompt, parseResource, parseTemplate, promptResult, resourceContents, type McpCatalog, type McpPromptResult, type McpResourceContent } from "./catalog"

export const MCP_PROTOCOL_VERSION = "2025-06-18"
export const STDERR_LIMIT_BYTES = 64 * 1024
const MAX_LINE_CHARS = 32 * 1024 * 1024
const MAX_TOOL_PAGES = 100
const CLOSE_STDIN_GRACE_MS = 300
const CLOSE_TERM_GRACE_MS = 1_000
const EXIT_DRAIN_MS = 200

export type McpToolInfo = { name: string; description?: string; inputSchema: Record<string, unknown> }
export type McpCallResult = { text: string; isError: boolean }

export class McpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message)
    this.name = "McpError"
  }
}

export type McpClientState = "stopped" | "starting" | "running" | "failed"

export interface McpClient {
  readonly name: string
  /** stopped: not running, no error · starting: handshake in progress · running · failed: the last start or run ended in an error. */
  readonly state: McpClientState
  readonly lastError: string | undefined
  /** Tools cached from the last `tools/list`; 0 when unknown. */
  readonly toolCount: number
  /** True while a child process is connected. */
  readonly alive: boolean
  readonly pid: number | undefined
  /** Spawns and handshakes if not running. Called implicitly by listTools/callTool. */
  start(): Promise<void>
  listTools(): Promise<McpToolInfo[]>
  listPrompts?(): Promise<McpPromptInfo[]>
  getPrompt?(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<string>
  /** `elicit` answers the server's `elicitation/create` requests made while this call runs; without it they are declined. */
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, elicit?: ElicitHandler): Promise<McpCallResult>
  catalog?(): Promise<McpCatalog>
  readResource?(uri: string, signal?: AbortSignal): Promise<McpResourceContent[]>
  getPromptResult?(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<McpPromptResult>
  /** Last 64 KB of the server's stderr. */
  stderr(): string
  close(): Promise<void>
  /** Remote servers: the last request was refused (401) and no usable token exists, so the user must authorize it. */
  readonly needsAuth?: boolean
  /** Remote servers: the challenge of the last 401, which starts OAuth discovery. */
  readonly authChallenge?: AuthChallenge | undefined
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void }
type Json = Record<string, unknown>

export const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

/** Every page of `tools/list`, through whatever transport `request` sends on. */
export async function listAllTools(request: (params?: Json) => Promise<unknown>): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = await request(cursor ? { cursor } : undefined)
    if (!isRecord(result)) break
    for (const item of Array.isArray(result.tools) ? result.tools : []) {
      if (!isRecord(item) || typeof item.name !== "string") continue
      const info: McpToolInfo = { name: item.name, inputSchema: isRecord(item.inputSchema) ? item.inputSchema : { type: "object" } }
      if (typeof item.description === "string") info.description = item.description
      tools.push(info)
    }
    cursor = typeof result.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : undefined
    if (!cursor) break
  }
  return tools
}

function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

/** Map an MCP `tools/call` result to text the model can read. */
export function mapCallResult(result: unknown): McpCallResult {
  if (!isRecord(result)) return { text: "", isError: false }
  const parts: string[] = []
  const content = Array.isArray(result.content) ? result.content : []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text)
    else if ((part.type === "image" || part.type === "audio") && typeof part.data === "string") {
      parts.push(`[${part.type}: ${String(part.mimeType ?? "unknown")}, ${base64Bytes(part.data)} bytes]`)
    } else if (part.type === "resource" && isRecord(part.resource)) {
      const resource = part.resource
      if (typeof resource.text === "string") parts.push(resource.text)
      else if (typeof resource.uri === "string") parts.push(resource.uri)
    } else if (part.type === "resource_link" && typeof part.uri === "string") parts.push(part.uri)
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent))
  return { text: parts.join("\n"), isError: result.isError === true }
}

function waitFor({ promise, ms }: { promise: Promise<unknown>; ms: number }): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    void promise.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

class StdioMcpClient implements McpClient {
  private capabilities: Record<string, unknown> = {}
  private resources: McpCatalog["resources"] | undefined
  private templates: McpCatalog["templates"] | undefined
  private prompts: McpCatalog["prompts"] | undefined
  private child: ChildProcess | undefined
  private ready: Promise<void> | undefined
  private readonly pending = new Map<number, Pending>()
  private readonly deadlines = new DeadlineGroup()
  /** Handlers of the tool calls in flight, newest last: the server's questions go to the latest one. */
  private readonly elicitors: ElicitHandler[] = []
  private nextId = 1
  private tools: McpToolInfo[] | undefined
  private closed = false
  private connected = false
  private error: string | undefined
  private readonly tail = new TailBuffer(STDERR_LIMIT_BYTES)

  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
    private readonly directory: string | undefined,
  ) {}

  get alive(): boolean {
    return this.child !== undefined
  }

  get state(): McpClientState {
    if (this.closed) return "stopped"
    if (this.child) return this.connected ? "running" : "starting"
    return this.error ? "failed" : "stopped"
  }

  get lastError(): string | undefined {
    return this.error
  }

  get toolCount(): number {
    return this.tools?.length ?? 0
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  private get timeoutMs(): number {
    return this.config.timeoutMs ?? DEFAULT_SERVER_TIMEOUT_MS
  }

  stderr(): string {
    return this.tail.toString()
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new McpError(`MCP server "${this.name}" is closed`))
    if (this.ready && this.child) return this.ready
    const attempt = this.connect().catch((error: unknown) => {
      if (this.ready === attempt) this.ready = undefined
      throw error
    })
    this.ready = attempt
    return attempt
  }

  private async connect(): Promise<void> {
    this.tools = undefined
    this.resources = this.templates = this.prompts = undefined
    this.capabilities = {}
    const child = spawn(this.config.command as string, this.config.args ?? [], {
      cwd: this.config.cwd ?? this.directory,
      env: serverEnvironment({ config: this.config }),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child = child
    this.connected = false
    this.error = undefined
    this.attach(child)
    try {
      const initialized = await this.request({
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSION, clientInfo: { name: "mendcode", version: "2" }, capabilities: this.config.elicitation === false ? {} : { elicitation: {} } },
        timeoutMs: this.timeoutMs,
      })
      this.capabilities = isRecord(initialized) && isRecord(initialized.capabilities) ? initialized.capabilities : {}
      this.notify("notifications/initialized")
      this.connected = true
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.dropChild(child)
      this.killGroup({ child, signal: "SIGKILL" })
      throw error
    }
  }

  private attach(child: ChildProcess): void {
    const stdout = new StringDecoder("utf8")
    const stderr = new StringDecoder("utf8")
    // An unfinished line is kept as chunks and joined once its newline arrives: appending to one string and searching it again at
    // every read copied a long message (a tool result with an image) once per chunk.
    let pending: string[] = []
    let pendingChars = 0
    child.stdin?.on("error", () => undefined)
    child.stdout?.on("data", (chunk: Buffer) => {
      let text = stdout.write(chunk)
      let newline = text.indexOf("\n")
      while (newline !== -1) {
        this.handleLine(pending.length ? pending.join("") + text.slice(0, newline) : text.slice(0, newline))
        pending = []
        pendingChars = 0
        text = text.slice(newline + 1)
        newline = text.indexOf("\n")
      }
      if (text) {
        pending.push(text)
        pendingChars += text.length
      }
      if (pendingChars > MAX_LINE_CHARS) {
        this.tail.append(`[mendcode] stdout line exceeded ${MAX_LINE_CHARS} chars; stopping server\n`)
        this.fail({ child, reason: "sent an oversized message" })
        this.killGroup({ child, signal: "SIGKILL" })
      }
    })
    child.stderr?.on("data", (chunk: Buffer) => this.tail.append(stderr.write(chunk)))
    child.on("error", (error) => this.fail({ child, reason: `could not start: ${error.message}` }))
    let drain: ReturnType<typeof setTimeout> | undefined
    child.on("exit", (code, signal) => {
      drain = setTimeout(() => this.fail({ child, reason: `exited (${signal ?? `code ${code}`})` }), EXIT_DRAIN_MS)
    })
    child.on("close", (code, signal) => {
      if (drain) clearTimeout(drain)
      this.fail({ child, reason: `exited (${signal ?? `code ${code}`})` })
    })
  }

  private handleLine(line: string): void {
    if (line.trim() === "") return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.tail.append(`[mendcode] non-JSON stdout: ${line.slice(0, 200)}\n`)
      return
    }
    if (!isRecord(message)) return
    const { id, method } = message
    if (typeof method === "string") {
      if (method === "notifications/tools/list_changed") this.tools = undefined
      if (method === "notifications/resources/list_changed") this.resources = this.templates = undefined
      if (method === "notifications/prompts/list_changed") this.prompts = undefined
      if (id !== undefined && method === "elicitation/create") {
        const handler = this.config.elicitation === false ? undefined : this.elicitors[this.elicitors.length - 1]
        void respondToElicitation({ server: this.name, params: message.params, handler, waiting: { start: () => this.deadlines.hold(), end: () => this.deadlines.release() } }).then((reply) => this.send({ jsonrpc: "2.0", id, ...reply }))
        return
      }
      if (id !== undefined) {
        const reply = method === "ping" ? { result: {} } : { error: { code: -32601, message: `method not supported: ${method}` } }
        this.send({ jsonrpc: "2.0", id, ...reply })
      }
      return
    }
    if (typeof id !== "number") return
    const pending = this.pending.get(id)
    if (!pending) return
    if (isRecord(message.error)) {
      pending.reject(new McpError(String(message.error.message ?? "request failed"), typeof message.error.code === "number" ? message.error.code : undefined))
    } else pending.resolve(message.result)
  }

  /** The child is gone (or unusable): reject everything in flight and forget it. */
  private fail({ child, reason }: { child: ChildProcess; reason: string }): void {
    if (this.child !== child) return
    this.dropChild(child)
    this.killGroup({ child, signal: "SIGKILL" })
    const tail = this.tail.toString().trim().slice(-300)
    const error = new McpError(`MCP server "${this.name}" ${reason}${tail ? `: ${tail}` : ""}`)
    this.error = error.message
    this.rejectAll(error)
  }

  private dropChild(child: ChildProcess): void {
    if (this.child === child) {
      this.connected = false
      this.child = undefined
      this.ready = undefined
      this.tools = undefined
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of [...this.pending.values()]) pending.reject(error)
  }

  private killGroup({ child, signal }: { child: ChildProcess; signal: NodeJS.Signals }): void {
    killProcessTree({ pid: child.pid, signal, fallback: (name) => { try { child.kill(name) } catch { /* already gone */ } } })
  }

  private send(message: Json): void {
    const stdin = this.child?.stdin
    if (stdin?.writable) stdin.write(`${JSON.stringify(message)}\n`)
  }

  private notify(method: string, params?: Json): void {
    this.send(params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method })
  }

  private request({ method, params, timeoutMs, signal }: { method: string; params?: Json; timeoutMs: number; signal?: AbortSignal }): Promise<unknown> {
    if (!this.child) return Promise.reject(new McpError(`MCP server "${this.name}" is not running`))
    if (signal?.aborted) return Promise.reject(new McpError("cancelled"))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const cancel = (reason: string) => {
        if (method !== "initialize") this.notify("notifications/cancelled", { requestId: id, reason })
      }
      const { deadline, done } = this.deadlines.start(timeoutMs)
      const cleanup = () => {
        done()
        signal?.removeEventListener("abort", onAbort)
        this.pending.delete(id)
      }
      deadline.signal.addEventListener("abort", () => {
        cleanup()
        cancel("timeout")
        reject(new McpError(`${method} timed out after ${timeoutMs} ms`))
      }, { once: true })
      const onAbort = () => {
        cleanup()
        cancel("aborted")
        reject(new McpError("cancelled"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
      })
      this.send(params ? { jsonrpc: "2.0", id, method, params } : { jsonrpc: "2.0", id, method })
    })
  }

  async listTools(): Promise<McpToolInfo[]> {
    await this.start()
    if (this.tools) return this.tools
    const tools = await listAllTools((params) => this.request({ method: "tools/list", ...(params ? { params } : {}), timeoutMs: this.timeoutMs }))
    this.tools = tools
    return tools
  }

  async listPrompts(): Promise<McpPromptInfo[]> {
    await this.start()
    return listAllPrompts((params) => this.request({ method: "prompts/list", ...(params ? { params } : {}), timeoutMs: this.timeoutMs }))
  }

  async getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<string> {
    await this.start()
    return promptText(await this.request({ method: "prompts/get", params: { name, arguments: args }, timeoutMs: this.timeoutMs, ...(signal ? { signal } : {}) }), true)
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, elicit?: ElicitHandler): Promise<McpCallResult> {
    await this.start()
    if (elicit) this.elicitors.push(elicit)
    try {
      const result = await this.request({ method: "tools/call", params: { name, arguments: args }, timeoutMs: this.timeoutMs, ...(signal ? { signal } : {}) })
      return mapCallResult(result)
    } finally {
      if (elicit) this.elicitors.splice(this.elicitors.lastIndexOf(elicit), 1)
    }
  }

  async catalog(): Promise<McpCatalog> {
    await this.start()
    const list = <T>(method: string, field: string, parse: (value: unknown) => T | undefined) => catalogList((params) => this.request({ method, ...(params ? { params } : {}), timeoutMs: this.timeoutMs }), field, parse)
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
    return resourceContents(await this.request({ method: "resources/read", params: { uri }, timeoutMs: this.timeoutMs, ...(signal ? { signal } : {}) }))
  }

  async getPromptResult(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<McpPromptResult> {
    await this.start()
    return promptResult(await this.request({ method: "prompts/get", params: { name, arguments: args }, timeoutMs: this.timeoutMs, ...(signal ? { signal } : {}) }))
  }

  async close(): Promise<void> {
    this.closed = true
    const child = this.child
    this.dropChild(child as ChildProcess)
    this.rejectAll(new McpError(`MCP server "${this.name}" was closed`))
    if (!child) return
    const finished = child.exitCode !== null || child.signalCode !== null
    if (!finished) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
      child.stdin?.end()
      await waitFor({ promise: exited, ms: CLOSE_STDIN_GRACE_MS })
      if (child.exitCode === null && child.signalCode === null) {
        this.killGroup({ child, signal: "SIGTERM" })
        await waitFor({ promise: exited, ms: CLOSE_TERM_GRACE_MS })
      }
    }
    this.killGroup({ child, signal: "SIGKILL" })
  }
}

/** A local server run over stdio; `createMcpClient` (factory.ts) picks this or the remote client from the config. */
export function createStdioMcpClient({ name, config, directory }: { name: string; config: McpServerConfig; directory?: string | undefined }): McpClient {
  if (config.command === undefined) throw new McpError(`MCP server "${name}" has no command`)
  return new StdioMcpClient(name, config, directory)
}
