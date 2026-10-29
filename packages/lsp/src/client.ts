import { spawn, type ChildProcess } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { pathToFileURL } from "node:url"
import { killProcessTree } from "@mendcode/tools"
import { FrameDecoder, encodeMessage } from "./framing"
import { TailBuffer } from "./tail-buffer"

export const STDERR_LIMIT_BYTES = 64 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const SHUTDOWN_GRACE_MS = 300
const TERM_GRACE_MS = 1_000
const EXIT_DRAIN_MS = 200

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint"
/** `line` and `col` are 1-based. */
export type LspDiagnostic = { line: number; col: number; severity: DiagnosticSeverity; message: string; source?: string; code?: string }

export class LspError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LspError"
  }
}

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const SEVERITIES: Record<number, DiagnosticSeverity> = { 1: "error", 2: "warning", 3: "info", 4: "hint" }

function toDiagnostic(raw: unknown): LspDiagnostic | undefined {
  if (!isRecord(raw) || typeof raw.message !== "string" || !isRecord(raw.range) || !isRecord(raw.range.start)) return undefined
  const start = raw.range.start
  const diagnostic: LspDiagnostic = {
    line: (typeof start.line === "number" ? start.line : 0) + 1,
    col: (typeof start.character === "number" ? start.character : 0) + 1,
    severity: SEVERITIES[typeof raw.severity === "number" ? raw.severity : 1] ?? "error",
    message: raw.message,
  }
  if (typeof raw.source === "string") diagnostic.source = raw.source
  const code = isRecord(raw.code) ? raw.code.value : raw.code
  if (typeof code === "string" || typeof code === "number") diagnostic.code = String(code)
  return diagnostic
}

export interface LspClient {
  readonly id: string
  readonly alive: boolean
  readonly pid: number | undefined
  /** Spawns and handshakes if not running. Called implicitly by `sync`. */
  start(): Promise<void>
  query(input: { method: string; params: Json; timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>
  /**
   * Opens the document, or sends a full-text change when the text differs from what the server has.
   * `changed: false` means nothing was sent (no new publish will follow); `after` marks the publishes
   * seen so far, for `waitForDiagnostics`.
   */
  sync(input: { path: string; languageId: string; text: string }): Promise<{ changed: boolean; after: number }>
  /** Latest published diagnostics for a document, if the server published any. */
  current(path: string): LspDiagnostic[] | undefined
  /**
   * Resolves with the diagnostics of `path` once a publish newer than `after` arrived and no further
   * publish followed within `settleMs`, or when `timeoutMs`/`signal`/server exit cuts the wait short.
   */
  waitForDiagnostics(input: { path: string; after: number; settleMs: number; timeoutMs: number; signal?: AbortSignal }): Promise<{ diagnostics: LspDiagnostic[] | undefined; settled: boolean }>
  stderr(): string
  close(): Promise<void>
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void }
type Published = { count: number; diagnostics: LspDiagnostic[] }

class StdioLspClient implements LspClient {
  private child: ChildProcess | undefined
  private ready: Promise<void> | undefined
  private closed = false
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly docs = new Map<string, { version: number; text: string }>()
  private readonly published = new Map<string, Published>()
  private readonly listeners = new Set<(uri: string) => void>()
  private readonly exitListeners = new Set<() => void>()
  private readonly tail = new TailBuffer(STDERR_LIMIT_BYTES)

  constructor(
    readonly id: string,
    private readonly command: string[],
    private readonly root: string,
    private readonly requestTimeoutMs: number,
    private readonly env: Record<string, string>,
    private readonly initialization: Json,
  ) {}

  get alive(): boolean {
    return this.child !== undefined
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  stderr(): string {
    return this.tail.toString()
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new LspError(`language server ${this.id} is closed`))
    if (this.ready && this.child) return this.ready
    const attempt = this.connect().catch((error: unknown) => {
      if (this.ready === attempt) this.ready = undefined
      throw error
    })
    this.ready = attempt
    return attempt
  }

  private async connect(): Promise<void> {
    this.docs.clear()
    this.published.clear()
    const [binary, ...args] = this.command
    const child = spawn(binary as string, args, { cwd: this.root, env: { ...process.env, ...this.env }, detached: true, stdio: ["pipe", "pipe", "pipe"] })
    this.child = child
    this.attach(child)
    try {
      const rootUri = pathToFileURL(this.root).href
      await this.request({
        method: "initialize",
        params: {
          processId: process.pid,
          clientInfo: { name: "mendcode", version: "2" },
          rootUri,
          initializationOptions: this.initialization,
          workspaceFolders: [{ uri: rootUri, name: this.root.split("/").pop() || this.root }],
          capabilities: {
            textDocument: {
              synchronization: { dynamicRegistration: false, didSave: false },
              publishDiagnostics: { relatedInformation: false, versionSupport: true },
              hover: { contentFormat: ["markdown", "plaintext"] },
              definition: { linkSupport: true }, implementation: { linkSupport: true },
              references: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true }, callHierarchy: {},
            },
            workspace: { configuration: true, workspaceFolders: true, symbol: {} },
            window: { workDoneProgress: true },
          },
        },
      })
      this.notify("initialized", {})
      if (Object.keys(this.initialization).length) this.notify("workspace/didChangeConfiguration", { settings: this.initialization })
    } catch (error) {
      this.drop(child)
      this.killGroup({ child, signal: "SIGKILL" })
      throw error
    }
  }

  private attach(child: ChildProcess): void {
    const decoder = new FrameDecoder()
    const stderr = new StringDecoder("utf8")
    child.stdin?.on("error", () => undefined)
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) this.handle(message)
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

  private handle(message: unknown): void {
    if (!isRecord(message)) return
    const { id, method } = message
    if (typeof method === "string") {
      if (method === "textDocument/publishDiagnostics" && isRecord(message.params)) this.onPublish(message.params)
      else if (id !== undefined) this.answerServerRequest({ id, method, params: message.params })
      return
    }
    if (typeof id !== "number") return
    const pending = this.pending.get(id)
    if (!pending) return
    if (isRecord(message.error)) pending.reject(new LspError(String(message.error.message ?? "request failed")))
    else pending.resolve(message.result)
  }

  private answerServerRequest({ id, method, params }: { id: unknown; method: string; params: unknown }): void {
    let result: unknown = null
    if (method === "workspace/configuration" && isRecord(params) && Array.isArray(params.items)) result = params.items.map((item) => {
      let value: unknown = this.initialization
      if (isRecord(item) && typeof item.section === "string") for (const part of item.section.split(".")) value = isRecord(value) ? value[part] : undefined
      return Object.keys(this.initialization).length ? value ?? null : null
    })
    else if (method === "workspace/workspaceFolders") result = [{ uri: pathToFileURL(this.root).href, name: this.root.split("/").pop() || this.root }]
    this.send({ jsonrpc: "2.0", id, result })
  }

  private onPublish(params: Json): void {
    const uri = params.uri
    if (typeof uri !== "string") return
    const doc = [...this.docs.entries()].find(([path]) => pathToFileURL(path).href === uri)?.[1]
    if (typeof params.version === "number" && doc && params.version < doc.version) return
    const diagnostics = (Array.isArray(params.diagnostics) ? params.diagnostics : []).map(toDiagnostic).filter((d): d is LspDiagnostic => d !== undefined)
    this.published.set(uri, { count: (this.published.get(uri)?.count ?? 0) + 1, diagnostics })
    for (const listener of [...this.listeners]) listener(uri)
  }

  private fail({ child, reason }: { child: ChildProcess; reason: string }): void {
    if (this.child !== child) return
    this.drop(child)
    this.killGroup({ child, signal: "SIGKILL" })
    const tail = this.tail.toString().trim().slice(-300)
    const error = new LspError(`language server ${this.id} ${reason}${tail ? `: ${tail}` : ""}`)
    for (const pending of [...this.pending.values()]) pending.reject(error)
    for (const listener of [...this.exitListeners]) listener()
  }

  private drop(child: ChildProcess): void {
    if (this.child === child) {
      this.child = undefined
      this.ready = undefined
    }
  }

  private killGroup({ child, signal }: { child: ChildProcess; signal: NodeJS.Signals }): void {
    killProcessTree({ pid: child.pid, signal, fallback: (name) => { try { child.kill(name) } catch { /* already gone */ } } })
  }

  private send(message: Json): void {
    const stdin = this.child?.stdin
    if (stdin?.writable) stdin.write(encodeMessage(message))
  }

  private notify(method: string, params: Json): void {
    this.send({ jsonrpc: "2.0", method, params })
  }

  private request({ method, params, timeoutMs = this.requestTimeoutMs, signal }: { method: string; params?: Json; timeoutMs?: number; signal?: AbortSignal }): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new LspError("cancelled"))
    if (!this.child) return Promise.reject(new LspError(`language server ${this.id} is not running`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        this.pending.delete(id)
      }
      const abort = () => {
        this.notify("$/cancelRequest", { id })
        cleanup()
        reject(new LspError("cancelled"))
      }
      const timer = setTimeout(() => {
        this.notify("$/cancelRequest", { id })
        cleanup()
        reject(new LspError(`${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => (cleanup(), resolve(value)),
        reject: (error) => (cleanup(), reject(error)),
      })
      signal?.addEventListener("abort", abort, { once: true })
      this.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })
    })
  }

  async query(input: { method: string; params: Json; timeoutMs?: number; signal?: AbortSignal }): Promise<unknown> {
    if (input.signal?.aborted) throw new LspError("cancelled")
    await this.start()
    return this.request(input)
  }

  async sync({ path, languageId, text }: { path: string; languageId: string; text: string }): Promise<{ changed: boolean; after: number }> {
    await this.start()
    const uri = pathToFileURL(path).href
    const after = this.published.get(uri)?.count ?? 0
    const doc = this.docs.get(path)
    if (doc && doc.text === text) return { changed: false, after }
    const version = (doc?.version ?? 0) + 1
    this.docs.set(path, { version, text })
    if (doc) this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] })
    else this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } })
    return { changed: true, after }
  }

  current(path: string): LspDiagnostic[] | undefined {
    return this.published.get(pathToFileURL(path).href)?.diagnostics
  }

  waitForDiagnostics({ path, after, settleMs, timeoutMs, signal }: { path: string; after: number; settleMs: number; timeoutMs: number; signal?: AbortSignal }): Promise<{ diagnostics: LspDiagnostic[] | undefined; settled: boolean }> {
    const uri = pathToFileURL(path).href
    return new Promise((resolve) => {
      let settle: ReturnType<typeof setTimeout> | undefined
      let seen = false
      const done = (settled: boolean) => {
        clearTimeout(overall)
        if (settle) clearTimeout(settle)
        this.listeners.delete(onPublish)
        this.exitListeners.delete(onExit)
        signal?.removeEventListener("abort", onExit)
        resolve({ diagnostics: seen ? this.published.get(uri)?.diagnostics : undefined, settled })
      }
      const arm = () => {
        seen = true
        if (settle) clearTimeout(settle)
        settle = setTimeout(() => done(true), settleMs)
      }
      const onPublish = (published: string) => {
        if (published === uri) arm()
      }
      const onExit = () => done(false)
      const overall = setTimeout(() => done(false), timeoutMs)
      this.listeners.add(onPublish)
      this.exitListeners.add(onExit)
      signal?.addEventListener("abort", onExit, { once: true })
      if ((this.published.get(uri)?.count ?? 0) > after) arm()
    })
  }

  async close(): Promise<void> {
    this.closed = true
    const child = this.child
    this.drop(child as ChildProcess)
    for (const pending of [...this.pending.values()]) pending.reject(new LspError(`language server ${this.id} was closed`))
    for (const listener of [...this.exitListeners]) listener()
    if (!child) return
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    const finished = child.exitCode !== null || child.signalCode !== null
    if (!finished) {
      const waitFor = (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms)
          void exited.then(() => (clearTimeout(timer), resolve()))
        })
      try {
        this.send({ jsonrpc: "2.0", id: this.nextId++, method: "shutdown" })
        this.notify("exit", {})
        child.stdin?.end()
      } catch {
        /* the process may already be gone */
      }
      await waitFor(SHUTDOWN_GRACE_MS)
      if (child.exitCode === null && child.signalCode === null) {
        this.killGroup({ child, signal: "SIGTERM" })
        await waitFor(TERM_GRACE_MS)
      }
    }
    this.killGroup({ child, signal: "SIGKILL" })
  }
}

export type LspClientOptions = { id: string; command: string[]; root: string; requestTimeoutMs?: number; env?: Record<string, string>; initialization?: Json }

export function createLspClient({ id, command, root, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, env = {}, initialization = {} }: LspClientOptions): LspClient {
  return new StdioLspClient(id, command, root, requestTimeoutMs, env, initialization)
}
