import { readFile, realpath } from "node:fs/promises"
import { extname, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import type { LspInput, LspReport } from "../../protocol/src/lsp"
import { createLspClient, type LspClient, type LspClientOptions, type LspDiagnostic } from "./client"
import { languageIdForFile, matchesFile, loadLspRegistry, type LoadedRegistry, type LspServerSpec } from "./registry"
import { createOfflineBootstrap, PROVISIONED_SERVERS, localCommand, serverInitialization, serverRoot } from "./bootstrap"
import { presetUnavailable } from "./other-launch"

export const DEFAULT_IDLE_MS = 5 * 60 * 1000
export const DEFAULT_SETTLE_MS = 1_500
export const DEFAULT_TIMEOUT_MS = 4_000
/** How long a failed provisioning or warm-up of one (project root, server) is remembered before it is tried again. */
export const DEFAULT_RETRY_MS = 10 * 60 * 1000
const MAX_REMEMBERED = 256

/** Timers are injectable so idle shutdown can be tested without waiting. */
export interface LspClock {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: LspClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type DiagnosticsResult =
  | { file: string; diagnostics: LspDiagnostic[]; issues?: Array<{ server: string; message: string }>; /** False when the wait ended by timeout before the server went quiet. */ settled: boolean }
  | { unavailable: string }

/** What running servers said about a file within the bound, and a promise for what they say once they go quiet. */
export type LiveDiagnostics = {
  file: string
  /** `undefined`: nothing was published for this content within the bound. */
  diagnostics: LspDiagnostic[] | undefined
  /** True when every server went quiet within the bound, so `diagnostics` is final. */
  settled: boolean
  /** Present when not settled: the final diagnostics, or `undefined` when the servers published nothing before `timeoutMs`. */
  late?: Promise<LspDiagnostic[] | undefined>
}
type Snapshot = { diagnostics: LspDiagnostic[] | undefined; settled: boolean }

export interface LspManager {
  status?(cwd: string): import("@mendcode/protocol").RestLspStatus[]
  query(input: LspInput & { cwd: string; timeoutMs?: number; signal?: AbortSignal }): Promise<LspReport>
  /** Search only live servers; REST file discovery never provisions or starts a server. */
  workspaceSymbols(input: { cwd: string; query: string; signal?: AbortSignal }): Promise<LspReport>
  diagnostics(input: { path: string; cwd: string; content?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<DiagnosticsResult>
  /**
   * Diagnostics of one file from the servers already running for it. It never resolves a command, provisions or
   * starts a server: `undefined` when none runs, at the cost of a map lookup. The promise resolves within `boundMs`.
   */
  live(input: { path: string; cwd: string; boundMs: number; timeoutMs?: number; signal?: AbortSignal }): Promise<LiveDiagnostics | undefined>
  /**
   * Starts, in the background, the servers of these files that are installed locally and not running yet. It returns at
   * once and does nothing before the next timer tick; `enabled` is asked then. It never provisions, never throws and
   * reports nothing: a server that is missing or fails to start is remembered for `retryMs` and skipped until then.
   */
  warm(input: { paths: string[]; cwd: string; enabled?: () => boolean }): void
  running(): Array<{ root: string; server: string; pid: number | undefined }>
  /** Kill every language server (process groups included) and cancel every timer. */
  stop(): Promise<void>
}

type Entry = { key: string; root: string; server: string; client: LspClient; inFlight: number; timer: unknown }
type Remembered = { at: number; reason: string }

const inside = (file: string, cwd: string) => file === cwd || file.startsWith(cwd + sep)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value == null ? [] : [value]).filter((item) => item != null)
const METHODS: Partial<Record<LspInput["operation"], string>> = {
  goToDefinition: "textDocument/definition", findReferences: "textDocument/references", hover: "textDocument/hover",
  documentSymbol: "textDocument/documentSymbol", workspaceSymbol: "workspace/symbol",
  goToImplementation: "textDocument/implementation", prepareCallHierarchy: "textDocument/prepareCallHierarchy",
}

export function createLspManager({
  registryLoader = (directory: string) => loadLspRegistry({ directory }),
  idleMs = DEFAULT_IDLE_MS,
  settleMs = DEFAULT_SETTLE_MS,
  clock = realClock,
  which = Bun.which,
  clientFactory = createLspClient,
  cacheDir,
  bootstrap,
  retryMs = DEFAULT_RETRY_MS,
  now = Date.now,
}: {
  registryLoader?: (directory: string) => Promise<LoadedRegistry> | LoadedRegistry
  idleMs?: number
  settleMs?: number
  clock?: LspClock
  which?: (binary: string) => string | null
  clientFactory?: (input: LspClientOptions) => LspClient
  cacheDir?: string
  bootstrap?: ReturnType<typeof createOfflineBootstrap>
  /** A failed provisioning or warm-up is not repeated for this long. */
  retryMs?: number
  /** Injectable so the retry interval can be tested without waiting. */
  now?: () => number
} = {}): LspManager {
  const registries = new Map<string, Promise<LoadedRegistry>>()
  const entries = new Map<string, Entry>()
  const lifetime = new AbortController()
  const provisioning = new Set<Promise<string[] | undefined>>()
  const provision = bootstrap ?? (cacheDir ? createOfflineBootstrap({ cacheDir, which }) : undefined)
  /** Per `root\0server`: provisioning that failed, and warm-ups that found nothing to start or failed to start it. */
  const unprovisioned = new Map<string, Remembered>()
  const unwarmed = new Map<string, Remembered>()
  const warming = new Map<string, Promise<void>>()
  const warmTimers = new Set<ReturnType<typeof setTimeout>>()
  const warmTasks = new Set<Promise<void>>()
  const remember = (memory: Map<string, Remembered>, key: string, reason: string) => {
    memory.delete(key)
    if (memory.size >= MAX_REMEMBERED) memory.delete(memory.keys().next().value!)
    memory.set(key, { at: now(), reason })
  }
  const remembered = (memory: Map<string, Remembered>, key: string): Remembered | undefined => {
    const known = memory.get(key)
    if (known && now() - known.at >= retryMs) memory.delete(key)
    return memory.get(key)
  }
  /**
   * The command of a server: what is installed locally (PATH, project `node_modules/.bin`, data-dir caches), else what
   * offline provisioning produces. `failed` is set when provisioning was tried and failed, now or within `retryMs`:
   * a remembered failure costs only the local lookup, which is also what notices a binary installed since.
   */
  const commandFor = async (spec: LspServerSpec, cwd: string, root: string, disabled: boolean, signal?: AbortSignal): Promise<{ command?: string[]; failed?: string }> => {
    const key = `${root}\0${spec.id}`
    const installed = await localCommand({ spec, cwd, root, ...(cacheDir ? { cacheDir } : {}), which, ...(signal ? { signal } : {}) })
    if (installed) {
      unprovisioned.delete(key)
      return { command: installed }
    }
    if (disabled || spec.disableDownload || spec.bootstrap === false || signal?.aborted || !provision) return {}
    const known = remembered(unprovisioned, key)
    if (known) return { failed: known.reason }
    let reason = ""
    const task = provision({ spec, cwd, ...(signal ? { signal } : {}), explain: (why) => { reason = why } })
    provisioning.add(task)
    try {
      const command = await task
      if (command) return { command }
      if (signal?.aborted) return {}
      remember(unprovisioned, key, reason)
      return { failed: reason }
    } finally { provisioning.delete(task) }
  }
  /** Appended to "not installed" when offline provisioning failed; the same text on the first and on every remembered answer. */
  const provisionNote = (failed: string | undefined) => failed ? `; offline provisioning failed (${failed}), next attempt in ${Math.round(retryMs / 60_000)} min` : ""

  const registryFor = (directory: string) => {
    let loaded = registries.get(directory)
    if (!loaded) {
      loaded = Promise.resolve(registryLoader(directory))
      registries.set(directory, loaded)
    }
    return loaded
  }

  const armTimer = (entry: Entry) => {
    clock.clearTimeout(entry.timer)
    entry.timer = clock.setTimeout(() => {
      if (entry.inFlight > 0) return armTimer(entry)
      if (entries.get(entry.key) === entry) entries.delete(entry.key)
      void entry.client.close()
    }, idleMs)
  }

  const entryFor = ({ root, spec, command, initialization }: { root: string; spec: LspServerSpec; command: string[]; initialization: Record<string, unknown> }): Entry => {
    const key = `${root}\0${spec.id}`
    let entry = entries.get(key)
    if (!entry) {
      entry = { key, root, server: spec.id, client: clientFactory({ id: spec.id, command, root, ...(spec.env ? { env: spec.env } : {}), initialization }), inFlight: 0, timer: undefined }
      entries.set(key, entry)
    }
    return entry
  }

  async function attempt({ entry, file, languageId, text, timeoutMs, signal }: { entry: Entry; file: string; languageId: string; text: string; timeoutMs: number; signal: AbortSignal | undefined }): Promise<DiagnosticsResult> {
    entry.inFlight++
    clock.clearTimeout(entry.timer)
    try {
      const { changed, after } = await entry.client.sync({ path: file, languageId, text })
      const known = entry.client.current(file)
      if (!changed && known) return { file, diagnostics: known, settled: true }
      const waited = await entry.client.waitForDiagnostics({ path: file, after, settleMs, timeoutMs, ...(signal ? { signal } : {}) })
      if (!entry.client.alive) throw new Error(`language server ${entry.server} stopped while waiting: ${entry.client.stderr().trim().slice(-200)}`)
      return { file, diagnostics: waited.diagnostics ?? known ?? [], settled: waited.settled }
    } finally {
      entry.inFlight--
      if (entries.get(entry.key) === entry) armTimer(entry)
    }
  }

  /** Starts one installed server and opens `file` in it, so the project is loaded before the next write asks. */
  async function warmServer({ key, spec, root, cwd, file }: { key: string; spec: LspServerSpec; root: string; cwd: string; file: string }): Promise<void> {
    const signal = lifetime.signal
    const initialization = await serverInitialization({ spec, root, cwd })
    if (signal.aborted) return
    if (!initialization) return remember(unwarmed, key, "a project dependency of the server is not installed")
    // Local lookup only: the provisioning half of `commandFor` is never reached from a warm-up.
    const command = await localCommand({ spec, cwd, root, ...(cacheDir ? { cacheDir } : {}), which, signal })
    if (signal.aborted) return
    if (!command) return remember(unwarmed, key, `${spec.command[0]} is not installed locally`)
    const message = (error: unknown) => error instanceof Error ? error.message : String(error)
    let entry: Entry
    try {
      entry = entryFor({ root, spec, command, initialization })
    } catch (error) {
      return remember(unwarmed, key, message(error))
    }
    entry.inFlight++
    clock.clearTimeout(entry.timer)
    let failed = false
    try {
      await entry.client.start()
      const text = await readFile(file, "utf8").catch(() => undefined)
      if (text !== undefined && !signal.aborted) await entry.client.sync({ path: file, languageId: languageIdForFile(file, spec.id), text })
      unwarmed.delete(key)
    } catch (error) {
      failed = true
      if (!signal.aborted) remember(unwarmed, key, message(error))
    } finally {
      entry.inFlight--
      if (entries.get(entry.key) === entry) {
        if (failed && !entry.inFlight && !entry.client.alive) {
          entries.delete(entry.key)
          void entry.client.close()
        } else armTimer(entry)
      }
    }
  }

  async function warmFile(path: string, cwd: string): Promise<void> {
    const file = resolve(cwd, path)
    const registry = await registryFor(cwd)
    await Promise.all(registry.servers.filter((spec) => matchesFile(spec, file)).map(async (spec) => {
      const root = await serverRoot({ file, cwd, spec })
      if (!root) return
      const real = await realpath(root).catch(() => root)
      if (lifetime.signal.aborted) return
      const key = `${root}\0${spec.id}`
      // One attempt at a time per (root, server); nothing between this check and `warming.set` awaits.
      if (warming.has(key) || remembered(unwarmed, key) || entries.get(key)?.client.alive || entries.get(`${real}\0${spec.id}`)?.client.alive) return
      const task = warmServer({ key, spec, root, cwd, file }).catch(() => undefined).finally(() => warming.delete(key))
      warming.set(key, task)
      await task
    }))
  }

  return {
    status(cwd) {
      const directory = resolve(cwd)
      return [...entries.values()].filter((entry) => inside(entry.root, directory) || inside(directory, entry.root)).map((entry) => ({ id: entry.server, name: entry.server, root: entry.root, status: entry.client.alive ? "connected" as const : "error" as const }))
    },
    async query({ cwd, filePath, operation, line, character, query = "", timeoutMs = DEFAULT_TIMEOUT_MS, signal }) {
      signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      if (signal?.aborted) return { result: [], unavailable: "cancelled" }
      if (!Number.isInteger(line) || line < 1 || !Number.isInteger(character) || character < 1) return { result: [], unavailable: "line and character must be positive integers" }
      const directory = await realpath(cwd).catch(() => resolve(cwd))
      const file = await realpath(resolve(cwd, filePath)).catch(() => resolve(cwd, filePath))
      if (!inside(file, directory)) return { result: [], unavailable: "file is outside the project" }
      const text = await readFile(file, "utf8").catch(() => undefined)
      if (text === undefined) return { result: [], unavailable: `cannot read ${file}` }
      const registry = await registryFor(cwd)
      const specs = registry.servers.filter((spec) => matchesFile(spec, file))
      if (!specs.length) return { result: [], unavailable: "No LSP server available for this file type." }
      const issues: Array<{ server: string; message: string }> = []
      const selected = new Map<string, Entry>()
      for (const spec of specs) {
        const root = await serverRoot({ file, cwd: directory, spec })
        if (!root) continue
        const initialization = await serverInitialization({ spec, root, cwd: directory })
        if (!initialization) {
          issues.push({ server: spec.id, message: `project ${spec.id === "astro" ? "TypeScript" : "ESLint"} dependency is not installed` })
          continue
        }
        const { command, failed } = await commandFor(spec, directory, root, registry.disableDownload === true, signal)
        if (signal.aborted) return { result: [], unavailable: "cancelled" }
        if (!command) {
          issues.push({ server: spec.id, message: presetUnavailable(spec) ?? `${spec.command[0]} is not installed${registry.disableDownload || spec.disableDownload ? "; downloads disabled" : `${provisionNote(failed)}; install the language server locally`}` })
          continue
        }
        const entry = entryFor({ root, spec, command, initialization })
        selected.set(entry.key, entry)
      }
      const fileEntries = new Set(selected.keys())
      if (operation === "workspaceSymbol") for (const entry of entries.values()) if (entry.client.alive && inside(entry.root, directory)) selected.set(entry.key, entry)
      let successful = 0
      const uri = pathToFileURL(file).href
      const position = { line: line - 1, character: character - 1 }
      const results = await Promise.all([...selected.values()].map(async (entry) => {
        entry.inFlight++
        clock.clearTimeout(entry.timer)
        try {
          if (signal?.aborted) throw new Error("cancelled")
          if (fileEntries.has(entry.key)) await entry.client.sync({ path: file, languageId: languageIdForFile(file, entry.server), text })
          const request = (method: string, params: Record<string, unknown>) => entry.client.query({ method, params, timeoutMs, ...(signal ? { signal } : {}) })
          const params = { textDocument: { uri }, position }
          if (operation === "incomingCalls" || operation === "outgoingCalls") {
            const items = list(await request("textDocument/prepareCallHierarchy", params))
            const calls = items.length ? list(await request(`callHierarchy/${operation}`, { item: items[0] })) : []
            successful++
            return calls
          }
          const value = await request(METHODS[operation]!, operation === "workspaceSymbol" ? { query } : operation === "documentSymbol" ? { textDocument: { uri } } : operation === "findReferences" ? { ...params, context: { includeDeclaration: true } } : params)
          const values = list(value)
          successful++
          return operation === "workspaceSymbol" ? values.filter((item) => typeof item === "object" && item !== null && [5, 6, 10, 11, 12, 13, 14, 23].includes((item as { kind: number }).kind)).slice(0, 10) : values
        } catch (error) {
          issues.push({ server: entry.server, message: error instanceof Error ? error.message : String(error) })
          return []
        } finally {
          entry.inFlight--
          if (entries.get(entry.key) === entry) armTimer(entry)
        }
      }))
      const result = results.flat()
      return { result, ...(issues.length ? { issues } : {}), ...(!successful ? { unavailable: issues.map((issue) => `${issue.server}: ${issue.message}`).join("; ") || "No LSP server available for this file type." } : {}) }
    },

    async workspaceSymbols({ cwd, query, signal }) {
      signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      const directory = await realpath(cwd).catch(() => resolve(cwd))
      const selected = [...entries.values()].filter((entry) => entry.client.alive && inside(entry.root, directory))
      const issues: Array<{ server: string; message: string }> = []
      let successful = 0
      const result = await Promise.all(selected.map(async (entry) => {
        entry.inFlight++
        clock.clearTimeout(entry.timer)
        try {
          signal.throwIfAborted()
          const values = list(await entry.client.query({ method: "workspace/symbol", params: { query }, timeoutMs: DEFAULT_TIMEOUT_MS, signal }))
          successful++
          return values.filter((item) => typeof item === "object" && item !== null && [5, 6, 10, 11, 12, 13, 14, 23].includes((item as { kind: number }).kind)).slice(0, 10)
        } catch {
          issues.push({ server: entry.server, message: "Workspace symbol search failed" })
          return []
        } finally {
          entry.inFlight--
          if (entries.get(entry.key) === entry) armTimer(entry)
        }
      }))
      return { result: result.flat(), ...(issues.length ? { issues } : {}), ...(selected.length && !successful ? { unavailable: "Workspace symbol search failed" } : {}) }
    },

    async diagnostics({ path, cwd, content, timeoutMs = DEFAULT_TIMEOUT_MS, signal }) {
      signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      if (signal.aborted) return { unavailable: "cancelled" }
      const file = resolve(cwd, path)
      const extension = extname(file).toLowerCase()
      const registry = await registryFor(cwd)
      const specs = registry.servers.filter((candidate) => matchesFile(candidate, file))
      if (!specs.length) return { unavailable: `no language server configured for ${extension || "this file type"}` }
      let text = content
      if (text === undefined) {
        text = await readFile(file, "utf8").catch(() => undefined)
      }
      const results = await Promise.all(specs.map(async (spec) => {
        const root = await serverRoot({ file, cwd, spec })
        if (!root) return undefined
        const initialization = await serverInitialization({ spec, root, cwd })
        if (!initialization) return { server: spec.id, message: `project ${spec.id === "astro" ? "TypeScript" : "ESLint"} dependency is not installed` }
        const { command, failed } = await commandFor(spec, cwd, root, registry.disableDownload === true, signal)
        if (signal.aborted) return undefined
        if (!command) return { server: spec.id, message: presetUnavailable(spec) ?? `${spec.command[0]} is not installed (not found on PATH)${registry.disableDownload || spec.disableDownload ? "; downloads disabled" : `${provisionNote(failed)}; ${(PROVISIONED_SERVERS as readonly string[]).includes(spec.id) ? `run \`mendcode lsp install ${spec.id}\`` : "install it"} to get diagnostics for ${extension} files`}` }
        if (text === undefined) return { unavailable: `cannot read ${file}` }
        let lastError = ""
        for (let tries = 0; tries < 2; tries++) {
          if (signal.aborted) return undefined
          const entry = entryFor({ root, spec, command, initialization })
          try {
            return await attempt({ entry, file, languageId: languageIdForFile(file, spec.id), text: text!, timeoutMs, signal })
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
          }
        }
        return { server: spec.id, message: lastError }
      }))
      if (signal.aborted) return { unavailable: "cancelled" }
      const unreadable = results.find((result) => result !== undefined && "unavailable" in result)
      if (unreadable && "unavailable" in unreadable) return { unavailable: unreadable.unavailable }
      const available = results.filter((result): result is Extract<DiagnosticsResult, { diagnostics: LspDiagnostic[] }> => result !== undefined && "diagnostics" in result)
      const issues = results.filter((result): result is { server: string; message: string } => result !== undefined && "server" in result)
      if (!available.length) return { unavailable: issues.map((issue) => `${issue.server}: ${issue.message}`).join("; ") || `no language server configured for ${extension || "this file type"}` }
      return { file, diagnostics: available.flatMap((result) => result.diagnostics), settled: available.every((result) => result.settled), ...(issues.length ? { issues } : {}) }
    },

    async live({ path, cwd, boundMs, timeoutMs = DEFAULT_TIMEOUT_MS, signal }) {
      const alive = [...entries.values()].filter((entry) => entry.client.alive)
      if (!alive.length) return undefined
      signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      if (signal.aborted) return undefined
      const file = resolve(cwd, path)
      const registry = await registryFor(cwd)
      const selected = new Map<string, Entry>()
      for (const spec of registry.servers) {
        if (!matchesFile(spec, file) || !alive.some((entry) => entry.server === spec.id)) continue
        const root = await serverRoot({ file, cwd, spec })
        if (!root) continue
        // `lsp` queries key their server by the real path, `diagnostics` by the given one.
        for (const candidate of new Set([root, await realpath(root).catch(() => root)])) {
          const entry = entries.get(`${candidate}\0${spec.id}`)
          if (entry?.client.alive) selected.set(entry.key, entry)
        }
      }
      if (!selected.size) return undefined
      const text = await readFile(file, "utf8").catch(() => undefined)
      if (text === undefined || signal.aborted) return undefined
      const none: Snapshot = { diagnostics: undefined, settled: false }
      const started = Date.now()
      let boundTimer: ReturnType<typeof setTimeout> | undefined
      // A server still handshaking holds `sync`; the bound covers that too.
      const bound = new Promise<undefined>((done) => { boundTimer = setTimeout(() => done(undefined), boundMs) })
      const watches = [...selected.values()].map((entry) => {
        entry.inFlight++
        clock.clearTimeout(entry.timer)
        const synced = entry.client.sync({ path: file, languageId: languageIdForFile(file, entry.server), text })
        const wait = (ms: number, gate: Promise<{ changed: boolean; after: number } | undefined>): Promise<Snapshot> => gate.then((sync) => {
          if (!sync) return none
          const known = entry.client.current(file)
          if (!sync.changed && known) return { diagnostics: known, settled: true }
          return entry.client.waitForDiagnostics({ path: file, after: sync.after, settleMs, timeoutMs: Math.max(0, ms - (Date.now() - started)), signal })
        }).catch(() => none)
        const final = wait(timeoutMs, synced)
        void final.finally(() => {
          entry.inFlight--
          if (entries.get(entry.key) === entry) armTimer(entry)
        })
        return { first: wait(boundMs, Promise.race([synced, bound])), final }
      })
      const merge = (snapshots: Snapshot[]): Snapshot => {
        const published = snapshots.filter((snapshot) => snapshot.diagnostics !== undefined)
        return { diagnostics: published.length ? published.flatMap((snapshot) => snapshot.diagnostics!) : undefined, settled: snapshots.every((snapshot) => snapshot.settled) }
      }
      const first = merge(await Promise.all(watches.map((watch) => watch.first)))
      clearTimeout(boundTimer)
      if (first.settled) return { file, diagnostics: first.diagnostics, settled: true }
      return { file, diagnostics: first.diagnostics, settled: false, late: Promise.all(watches.map((watch) => watch.final)).then((snapshots) => merge(snapshots).diagnostics) }
    },

    warm({ paths, cwd, enabled }) {
      if (lifetime.signal.aborted || !paths.length) return
      // A timer, not a microtask: the caller's own continuation (the write's tool result) runs first.
      const timer = setTimeout(() => {
        warmTimers.delete(timer)
        if (lifetime.signal.aborted) return
        try {
          if (enabled && !enabled()) return
        } catch { return }
        for (const path of new Set(paths)) {
          const task: Promise<void> = warmFile(path, cwd).catch(() => undefined).finally(() => warmTasks.delete(task))
          warmTasks.add(task)
        }
      }, 0)
      warmTimers.add(timer)
    },

    running() {
      return [...entries.values()].map((entry) => ({ root: entry.root, server: entry.server, pid: entry.client.pid }))
    },

    async stop() {
      lifetime.abort()
      for (const timer of warmTimers) clearTimeout(timer)
      warmTimers.clear()
      const all = [...entries.values()]
      entries.clear()
      registries.clear()
      for (const entry of all) clock.clearTimeout(entry.timer)
      await Promise.all(all.map((entry) => entry.client.close()))
      await Promise.all([...provisioning])
      await Promise.all([...warmTasks])
    },
  }
}
