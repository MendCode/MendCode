import { estimateTokens } from "@mendcode/protocol/wire"
import { mkdirSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import { EXTENSIONS_DIR, EXTENSION_API_VERSION, HOOK_TIMEOUT_MS, type DaemonExtensionAPI, type DaemonHookName, type DaemonHooks, type ExtensionCommand, type ExtensionTool } from "@mendcode/extension-api"
import { layerAllows, type ExtensionLayer } from "@mendcode/packages"
import { tierIncludes, type ExtensionConflict, type ExtensionInfo, type ModelInfo, type Tier } from "@mendcode/protocol"
import type { Tool } from "@mendcode/tools"
import type { CustomCommand } from "../custom-commands"
import { createHookBus, type HookBus } from "./hooks"
import { adaptTool, toolProblem, wrapBuiltin, type ExtensionEngineTool } from "./tool-adapter"
import { CONTEXT_REWRITE_HOOKS, DAEMON_HOOKS, MAX_EXTENSION_ERRORS, type ExtensionLog, type ExtensionRecord } from "./types"
import { discoverPluginFiles, type PluginFile } from "@mendcode/extension-api/plugin-files"
import { preflightModule } from "@mendcode/extension-api/preflight"
import { adaptPluginModule } from "./plugin-adapter"
import { createPluginAuth } from "./plugin-auth"
import { registerPluginToolImports } from "./plugin-tool"
import { providerEntry, providerProblem, type ExtensionProviderEntry } from "./provider-registration"
import { extensionExec } from "./exec"
import { createSessionApi, type ExtensionSessionPort } from "./session-api"
import { createDialogApi, type ExtensionDialogPort } from "./dialogs"
import { createSessionEntries } from "./entries"
import { createExtensionEvents } from "./event-bus"
import { checkFlagValues, declaredFlags, flagProblem, type FlagValues } from "./flags"
import { extensionMcpServers, mcpServerProblem } from "./mcp-registration"
import { registeredVirtualModels, routeVirtual, virtualCatalog, virtualModelProblem } from "./virtual-models"

/** Names are used for the extension's data folder, so they stay path-safe. */
const EXTENSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const COMMAND_NAME = /^[a-z0-9][a-z0-9:_-]{0,63}$/
const SOURCE_FILE = /\.(ts|js)$/
const MAX_EXTENSIONS_PER_LAYER = 64
const MAX_NOTICE_CHARS = 8_000
const HOOKS = new Set<string>(DAEMON_HOOKS)
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500)

export type ExtensionsOptions = {
  /** The MendCode data dir: extensions keep private data in `<dataDir>/extensions-data/<name>`. */
  dataDir: string
  /** Extension layers of a project (packages, the user's and the project's own folders), lowest precedence first. */
  layersFor(directory: string): ExtensionLayer[]
  /** Whether project-layer code may run in `directory`: the same trust as project custom tools. */
  isTrusted(directory: string): boolean
  /** The engine's built-in tools, for `api.builtinTool` and to tell an override from a clash. */
  builtinTools?(): readonly Tool[]
  /** Queues a notice turn in a session (like a finished background task). */
  notify(sessionId: string, text: string): void
  log?: ExtensionLog
  /** Off (nothing is discovered or imported) when false; the daemon passes `MENDCODE_EXTENSIONS !== "0"`. */
  enabled?: boolean
  /** Per-handler time limit; defaults to HOOK_TIMEOUT_MS. */
  hookTimeoutMs?: number
  /** Consecutive failures after which a handler is not called again this session; defaults to BREAKER_THRESHOLD. */
  breakerThreshold?: number
  /** How long a module's import may take before it is given up on; defaults to 10 s. */
  importTimeoutMs?: number
  /** The user turned this extension off (`disabledExtensions`): its module is not imported, or not run when it is only known by its name. */
  isDisabled?(name: string): boolean
  /** The user's tier, to tell which extension tools cost context (a tool above the tier is not offered). */
  tier?(): Tier | undefined
  /** A note for the terminal's toast line (`api.toast`): never stored, never sent to the model. */
  feedback?(event: { extension: string; text: string; level: "info" | "success" | "warning" | "error" }): void
  /** What extensions may do to a session (model, effort, tools, a message); without it those calls answer an error. */
  sessions?: ExtensionSessionPort
  /** Dialogs from daemon hooks (`api.ui`); without it every dialog answers its default. */
  dialogs?: ExtensionDialogPort
  /** The extension flag values a session's CLI invocation passed (`extensions.flags`). */
  flagValues?(sessionId: string): FlagValues | undefined
  /** Whether a session exists, for `appendEntry`. */
  sessionExists?(sessionId: string): boolean
  now?(): number
}

/** What loading a project's extensions produced: everything a hook, tool or command lookup needs. */
export type ExtensionScope = {
  records: readonly ExtensionRecord[]
  hooks: ReadonlySet<DaemonHookName>
  tools: ReadonlyMap<string, { record: ExtensionRecord; tool: ExtensionTool }>
  commands: ReadonlyMap<string, { record: ExtensionRecord; command: ExtensionCommand }>
  /** Who won and who lost where two extensions (or an extension and the host) claim the same tool, command or name. */
  conflicts: readonly ExtensionConflict[]
}

const EMPTY_SCOPE: ExtensionScope = { records: [], hooks: new Set(), tools: new Map(), commands: new Map(), conflicts: [] }

/** A module whose top level never settles (an import the runtime cannot finish) is given up on, so one extension cannot hold a directory's load forever. */
const IMPORT_TIMEOUT_MS = 10_000
async function withinLoadLimit<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`import did not finish in ${ms} ms`)), ms) })])
  } finally {
    clearTimeout(timer)
  }
}

/** `api.toast`: at most this many notes per extension per window; the rest are dropped, so a loop cannot flood the terminal. */
const TOAST_LIMIT = 10
const TOAST_WINDOW_MS = 10_000
const MAX_TOAST_CHARS = 300
const estimateValueTokens = (value: unknown) => estimateTokens(JSON.stringify(value).length)
const plain = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim()

type Candidate = { file: string; dir: string; layer: ExtensionLayer; plugin?: PluginFile["plugin"] }

/** `<layer>/extensions/*.ts|js` and `<layer>/extensions/<name>/index.ts|js`, by name. */
function discover(layer: ExtensionLayer): Candidate[] {
  const root = path.join(layer.dir, EXTENSIONS_DIR)
  let names: string[]
  try {
    names = readdirSync(root).filter((name) => !name.startsWith(".")).sort()
  } catch {
    return []
  }
  const found: Candidate[] = []
  for (const name of names) {
    if (found.length >= MAX_EXTENSIONS_PER_LAYER) break
    const entry = path.join(root, name)
    const info = statSync(entry, { throwIfNoEntry: false })
    if (!layerAllows(layer, "extensions", name.replace(SOURCE_FILE, ""))) continue
    if (info?.isFile() && SOURCE_FILE.test(name) && !name.endsWith(".d.ts")) found.push({ file: entry, dir: root, layer })
    else if (info?.isDirectory()) {
      const index = ["index.ts", "index.js"].map((file) => path.join(entry, file)).find((file) => statSync(file, { throwIfNoEntry: false })?.isFile())
      if (index) found.push({ file: index, dir: entry, layer })
    }
  }
  return found
}

const originOf = (layer: ExtensionLayer) => (layer.pkg ? ("package" as const) : layer.source)

function blankRecord(candidate: Candidate, trusted: boolean): ExtensionRecord {
  const fallbackName = path.basename(candidate.file) === "index.ts" || path.basename(candidate.file) === "index.js" ? path.basename(candidate.dir) : path.basename(candidate.file).replace(SOURCE_FILE, "")
  return {
    name: fallbackName,
    origin: originOf(candidate.layer),
    ...(candidate.layer.pkg ? { pkg: candidate.layer.pkg } : {}),
    layer: candidate.layer.source,
    file: candidate.file,
    dir: candidate.dir,
    daemon: false,
    tui: false,
    trusted,
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
    errors: [],
    logged: false,
    sealed: false,
    breaker: new Map(),
  }
}

/**
 * Loads extension modules and answers every question the daemon and engine have about them. Nothing is imported until
 * a session of a directory first needs it (then cached per directory; user-layer extensions are loaded once for the
 * whole daemon). A daemon without extension files does a directory listing per project and no `import()` at all.
 */
export function createExtensions(options: ExtensionsOptions) {
  const enabled = options.enabled ?? true
  const log: ExtensionLog = options.log ?? (() => {})
  const bus: HookBus = createHookBus({ timeoutMs: options.hookTimeoutMs ?? HOOK_TIMEOUT_MS, log, ...(options.breakerThreshold ? { breakerThreshold: options.breakerThreshold } : {}) })
  /** The last version of each module that loaded cleanly: a reload that fails keeps running it instead of leaving the project with nothing. */
  const lastGood = new Map<string, ExtensionRecord>()
  const toasts = new Map<string, { since: number; count: number }>()
  const auth = createPluginAuth(options.dataDir, bus)
  const now = options.now ?? Date.now
  /** The records loaded beside `record` (every scope it is part of): who hears what it emits. */
  const peersOf = (record: ExtensionRecord) => {
    const found = new Set<ExtensionRecord>()
    for (const scope of [...ready.values(), ...stale.values()]) if (scope.records.includes(record)) for (const peer of scope.records) found.add(peer)
    return [...found]
  }
  const events = createExtensionEvents({ bus, peers: peersOf, fail: (record, message) => fail(record, message), now })
  const stamp = Date.now()
  let loads = 0

  /** The engine registers its tools once it is built (it is built after this), before any extension loads. */
  let engineTools: readonly Tool[] | undefined
  const builtins = () => new Map((engineTools ?? options.builtinTools?.() ?? []).map((tool) => [tool.name, tool] as const))

  function fail(record: ExtensionRecord, message: string) {
    if (record.errors.length < MAX_EXTENSION_ERRORS) record.errors.push(message)
    if (!record.logged) {
      record.logged = true
      log("warn", `[EXTENSIONS]: ${record.name}: ${message}`)
    }
  }

  function createApi(record: ExtensionRecord, name: string): DaemonExtensionAPI {
    let dataDir: string | undefined
    const refuse = (what: string) => {
      if (!record.sealed) return false
      fail(record, `${what} after setup finished; register during daemon(api)`)
      return true
    }
    const sessions = createSessionApi({ record, port: options.sessions, fail: (message) => fail(record, message), now })
    const owns = (sessionId: unknown) => {
      const directory = typeof sessionId === "string" ? options.sessions?.directory(sessionId) : undefined
      if (!directory) return "ui: unknown session"
      return record.layer === "project" && record.scopeDir !== undefined && path.resolve(directory) !== path.resolve(record.scopeDir) ? "ui: a project extension asks only in its project's sessions" : undefined
    }
    const entries = createSessionEntries({ extensionData: () => path.join(options.dataDir, "extensions-data", name), ...(options.sessionExists ? { sessionExists: options.sessionExists } : {}), now })
    return {
      ...sessions,
      events: events.for(record, () => record.sealed),
      ui: createDialogApi({ extension: name, port: options.dialogs, owns, fail: (message) => fail(record, message), waiting: (delta) => { record.waiting = Math.max(0, (record.waiting ?? 0) + delta); if (delta < 0) record.waitEnded = Date.now() } }),
      appendEntry(sessionId, type, data) {
        if (record.disabled) return false
        const stored = entries.append(sessionId, type, data)
        if (!stored.ok) fail(record, stored.error)
        return stored.ok
      },
      entries: (sessionId, type) => entries.read(sessionId, type),
      registerFlag(flagName, flag) {
        if (refuse("registerFlag")) return
        const problem = flagProblem(flagName, flag)
        if (problem) return fail(record, problem)
        record.flags ??= new Map()
        if (record.flags.has(flagName)) return fail(record, `registerFlag: --${flagName} is registered twice`)
        record.flags.set(flagName, { ...flag })
      },
      getFlag(flagName, sessionId) {
        const declared = record.flags?.get(flagName)
        if (!declared) return undefined
        const passed = typeof sessionId === "string" ? options.flagValues?.(sessionId)?.[flagName] : undefined
        return typeof passed === declared.type ? passed : declared.default
      },
      registerMcpServer(serverName, server) {
        if (refuse("registerMcpServer")) return
        const problem = mcpServerProblem(serverName, server)
        if (problem) return fail(record, problem)
        record.mcpServers ??= new Map()
        if (record.mcpServers.has(serverName)) return fail(record, `registerMcpServer: ${serverName} is registered twice`)
        record.mcpServers.set(serverName, structuredClone(server))
      },
      registerVirtualModel(model) {
        if (refuse("registerVirtualModel")) return
        const problem = virtualModelProblem(model)
        if (problem) return fail(record, problem)
        // The catalog serves every project, so a project's own extension cannot add to it (like a provider).
        if (record.layer === "project") return fail(record, "registerVirtualModel: a virtual model comes from a user extension (<data dir>/extensions or a user package), not a project")
        record.virtualModels ??= []
        if (record.virtualModels.some((entry) => entry.id === model.id)) return fail(record, `registerVirtualModel: ${model.id} is registered twice`)
        record.virtualModels.push({ id: model.id, models: [...model.models], ...(model.name ? { name: model.name } : {}), ...(model.route ? { route: model.route } : {}) })
      },
      version: EXTENSION_API_VERSION,
      dir: record.dir,
      get dataDir() {
        if (!dataDir) {
          dataDir = path.join(options.dataDir, "extensions-data", name)
          mkdirSync(dataDir, { recursive: true })
        }
        return dataDir
      },
      on(hook, handler) {
        if (refuse(`on("${String(hook)}")`)) return
        if (!HOOKS.has(hook)) return fail(record, `unknown hook "${String(hook)}"`)
        if (typeof handler !== "function") return fail(record, `on("${hook}") needs a function`)
        const handlers = record.handlers.get(hook) ?? []
        handlers.push(handler as never)
        record.handlers.set(hook, handlers)
      },
      registerTool(tool) {
        if (refuse("registerTool")) return
        const problem = toolProblem(tool)
        if (problem) return fail(record, `registerTool: ${problem}`)
        if (record.tools.has(tool.name)) return fail(record, `registerTool: ${tool.name} is registered twice`)
        if (builtins().has(tool.name) && tool.override !== true) return fail(record, `registerTool: ${tool.name} is a built-in tool; set override: true to replace it`)
        record.tools.set(tool.name, tool)
      },
      registerCommand(command) {
        if (refuse("registerCommand")) return
        const commandName = isRecord(command) && typeof command.name === "string" ? command.name.toLowerCase() : ""
        if (!COMMAND_NAME.test(commandName)) return fail(record, "registerCommand: command names use lowercase letters, digits, : _ and - (max 64)")
        if (typeof command.description !== "string" || typeof command.run !== "function") return fail(record, `registerCommand: /${commandName} needs a description and a run function`)
        if (record.commands.has(commandName)) return fail(record, `registerCommand: /${commandName} is registered twice`)
        record.commands.set(commandName, { ...command, name: commandName })
      },
      builtinTool(toolName) {
        const builtin = builtins().get(toolName)
        return builtin ? wrapBuiltin(builtin) : undefined
      },
      notify(sessionId, text) {
        if (typeof sessionId !== "string" || typeof text !== "string" || !text.trim()) return
        options.notify(sessionId, text.slice(0, MAX_NOTICE_CHARS))
      },
      log(level, message) {
        log(level, `[EXTENSIONS]: ${name}: ${String(message).slice(0, 2_000)}`)
      },
      toast(text, toastOptions) {
        if (typeof text !== "string" || record.disabled) return
        const line = plain(text).slice(0, MAX_TOAST_CHARS)
        if (!line || !options.feedback) return
        const now = Date.now()
        const window = toasts.get(name)
        if (!window || now - window.since >= TOAST_WINDOW_MS) toasts.set(name, { since: now, count: 1 })
        else if (window.count >= TOAST_LIMIT) return
        else window.count++
        const level = toastOptions?.level
        try {
          options.feedback({ extension: name.slice(0, 64), text: line, level: level === "success" || level === "warning" || level === "error" ? level : "info" })
        } catch {
          // A terminal that cannot be reached must not break the extension.
        }
      },
      registerAuth(value) {
        if (refuse("registerAuth")) return
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value.provider) || !Array.isArray(value.methods) || value.methods.some((method) => !["api", "oauth"].includes(method.type) || typeof method.label !== "string" || method.type === "oauth" && typeof method.authorize !== "function")) return fail(record, "registerAuth: invalid provider or methods")
        record.auth = value
      },
      registerProvider(value) {
        if (refuse("registerProvider")) return
        const problem = providerProblem(value)
        if (problem) return fail(record, problem)
        // Providers serve every project (like providers.json in the data dir), so a project's own extension cannot add one.
        if (value.baseUrl !== undefined && record.layer === "project") return fail(record, "registerProvider: a provider with baseUrl comes from a user extension (<data dir>/extensions or a user package), not a project")
        record.provider = value
      },
      exec: extensionExec,
    }
  }

  /** Imports one module and runs its `daemon(api)`. Never throws: problems land in the record's errors. */
  async function load(candidate: Candidate, directory: string): Promise<ExtensionRecord> {
    const record = blankRecord(candidate, true)
    if (candidate.layer.source === "project") record.scopeDir = directory
    if (options.isDisabled?.(record.name)) return Object.assign(record, { disabled: true, sealed: true })
    const loaded = await loadFresh(candidate, directory, record)
    if (loaded.disabled) return loaded
    const failure = loaded.failed
    delete (loaded as { failed?: string }).failed
    const previous = lastGood.get(candidate.file)
    if (failure !== undefined) {
      if (!previous) return loaded
      // The edit that broke the module does not take the working version away: it keeps serving until the file loads again.
      log("warn", `[EXTENSIONS]: ${previous.name}: reload failed, keeping the previous version: ${failure}`)
      return Object.assign(previous, { kept: failure.slice(0, 400) })
    }
    lastGood.set(candidate.file, loaded)
    return loaded
  }

  /** Imports one module and runs its `daemon(api)`; `failed` carries why the module cannot be used when it cannot. */
  async function loadFresh(candidate: Candidate, directory: string, record: ExtensionRecord): Promise<ExtensionRecord & { failed?: string }> {
    let extension: Record<string, unknown> | undefined
    const result = record as ExtensionRecord & { failed?: string }
    try {
      if (candidate.plugin?.error) throw new Error(candidate.plugin.error)
      if (candidate.plugin) registerPluginToolImports()
      else {
        // A syntax error or a missing import is found without importing: the runtime would remember the failed import and refuse the fix.
        const problem = preflightModule(candidate.file)
        if (problem) throw new Error(problem)
      }
      // The query gives each load its own module instance, so a reload after a trust change runs the file again.
      const cache = createRequire(import.meta.url).cache
      for (const key of Object.keys(cache)) if (key === candidate.file || key.startsWith(candidate.dir + path.sep)) delete cache[key]
      const module = await withinLoadLimit(import(`${pathToFileURL(candidate.file).href}?v=${stamp}.${++loads}`), options.importTimeoutMs ?? IMPORT_TIMEOUT_MS) as Record<string, unknown>
      const value = candidate.plugin ? adaptPluginModule(module, { ...candidate, plugin: candidate.plugin }, directory) : module.default
      if (!isRecord(value) || typeof value.name !== "string" || !EXTENSION_NAME.test(value.name)) fail(record, "invalid extension: the default export must be { name, daemon?, tui? } with a name of letters, digits, . _ - (max 64)")
      else if ((value.daemon !== undefined && typeof value.daemon !== "function") || (value.tui !== undefined && typeof value.tui !== "function")) fail(record, "invalid extension: daemon and tui must be functions")
      else extension = value
    } catch (error) {
      fail(record, `load failed: ${messageOf(error)}`)
    }
    if (!extension) {
      result.failed = record.errors.at(-1) ?? "load failed"
      return result
    }
    record.name = extension.name as string
    record.daemon = typeof extension.daemon === "function"
    record.tui = typeof extension.tui === "function"
    if (options.isDisabled?.(record.name)) {
      record.disabled = true
      record.sealed = true
      return result
    }
    if (typeof extension.pluginId === "string") record.pluginId = extension.pluginId
    if (extension.abi === "v1-adapter" || extension.abi === "tool-module") record.abi = extension.abi
    if (record.daemon) {
      const api = createApi(record, record.name)
      const setup = await bus.guard(record, "daemon()", () => (extension.daemon as (api: DaemonExtensionAPI) => unknown)(api))
      if (!setup.ok) {
        result.failed = record.errors.at(-1) ?? "daemon() failed"
        // What a setup that did not finish registered is staged, never published: a half-initialised extension must not own a tool, command, hook, auth or provider.
        discardRegistrations(record)
      }
    }
    record.sealed = true
    return result
  }

  /** Drops everything a failed `daemon(api)` registered before it threw; the error stays listed on the record. */
  function discardRegistrations(record: ExtensionRecord) {
    record.handlers.clear()
    record.tools.clear()
    record.commands.clear()
    delete record.auth
    delete record.provider
    delete record.listeners
    delete record.flags
    delete record.mcpServers
    delete record.virtualModels
  }

  async function loadAll(candidates: Candidate[], directory: string) {
    const records: ExtensionRecord[] = []
    // Sequential: layer order is the hook order, and one extension's setup may depend on another's files.
    for (const candidate of candidates) records.push(await load(candidate, directory))
    return records
  }

  /** User-layer extensions (user folder, user packages, builtin): the same for every directory, loaded once. */
  let userRecords: Promise<ExtensionRecord[]> | undefined
  const candidatesFor = (layer: ExtensionLayer) => [...discover(layer), ...discoverPluginFiles(layer.dir, options.dataDir, "server").map((file) => ({ ...file, layer })), ...(layer.source === "project" && !layer.pkg && path.basename(layer.dir) === ".mendcode" ? discoverPluginFiles(path.dirname(layer.dir), options.dataDir, "server").map((file) => ({ ...file, layer })) : [])]
  async function loadUser(layers: ExtensionLayer[], directory: string) {
    const candidates = layers.filter((layer) => layer.source === "user").flatMap(candidatesFor)
    const native = await (userRecords ??= loadAll(candidates.filter((candidate) => !candidate.plugin), directory))
    const plugins = await loadAll(candidates.filter((candidate) => candidate.plugin), directory)
    return [...native, ...plugins]
  }

  /** Project-layer extensions of one directory: imported only when it is trusted, otherwise listed as untrusted records. */
  async function loadProject(layers: ExtensionLayer[], directory: string) {
    const candidates = layers.filter((layer) => layer.source === "project").flatMap(candidatesFor)
    if (candidates.length === 0) return []
    if (options.isTrusted(directory)) return loadAll(candidates, directory)
    return candidates.map((candidate) => blankRecord(candidate, false))
  }

  function buildScope(records: ExtensionRecord[]): ExtensionScope {
    if (records.length === 0) return EMPTY_SCOPE
    const hooks = new Set<DaemonHookName>()
    const tools = new Map<string, { record: ExtensionRecord; tool: ExtensionTool }>()
    const commands = new Map<string, { record: ExtensionRecord; command: ExtensionCommand }>()
    const conflicts: ExtensionConflict[] = []
    const claimed = new Map<string, ExtensionRecord>()
    const known = builtins()
    for (const record of records) {
      if (record.disabled) continue
      const sameName = claimed.get(record.name)
      if (sameName) conflicts.push({ kind: "name", name: record.name, winner: sameName.name, losers: [record.name], note: `${record.name} (${record.origin}) shares its name with one from ${sameName.origin}, so both use the data folder extensions-data/${record.name}` })
      else claimed.set(record.name, record)
      for (const [hook, handlers] of record.handlers) if (handlers.length) hooks.add(hook)
      for (const tool of record.tools.values()) {
        const prior = tools.get(tool.name)
        if (prior && tool.override !== true) {
          const message = `registerTool: ${tool.name} is already registered by ${prior.record.name}; set override: true to replace it`
          if (!record.errors.includes(message)) fail(record, message)
          conflicts.push({ kind: "tool", name: tool.name, winner: prior.record.name, losers: [record.name], note: `${record.name} did not get tool ${tool.name}: ${prior.record.name} registered it first; set override: true to replace it` })
          continue
        }
        if (prior) conflicts.push({ kind: "tool", name: tool.name, winner: record.name, losers: [prior.record.name], note: `${record.name} replaced tool ${tool.name} of ${prior.record.name} with override: true` })
        else if (known.has(tool.name)) conflicts.push({ kind: "builtin-tool", name: tool.name, winner: record.name, losers: ["built-in"], note: `${record.name} replaces the built-in tool ${tool.name} with override: true` })
        tools.set(tool.name, { record, tool })
      }
      // A later layer wins on a command name, like markdown commands.
      for (const command of record.commands.values()) {
        const prior = commands.get(command.name)
        if (prior && prior.record !== record) conflicts.push({ kind: "command", name: command.name, winner: record.name, losers: [prior.record.name], note: `/${command.name} of ${prior.record.name} is hidden by ${record.name}, which loads later` })
        commands.set(command.name, { record, command })
      }
    }
    return { records, hooks, tools, commands, conflicts: conflicts.slice(0, 100) }
  }

  const ready = new Map<string, ExtensionScope>()
  /** What was loaded before a reload, served to synchronous lookups (the engine's hooks) until the new load replaces it, so a reload never leaves a running turn without its extensions. */
  const stale = new Map<string, ExtensionScope>()
  const loading = new Map<string, Promise<ExtensionScope>>()
  let epoch = 0
  const keyOf = (directory: string) => path.resolve(directory)

  /** Loads (once) what `directory` needs. Never throws; a daemon with no extension files gets an empty scope. */
  function ensure(directory: string): Promise<ExtensionScope> {
    if (!enabled) return Promise.resolve(EMPTY_SCOPE)
    const key = keyOf(directory)
    const hit = ready.get(key)
    if (hit) return Promise.resolve(hit)
    const pending = loading.get(key)
    if (pending) return pending
    const currentEpoch = epoch
    const started = (async () => {
      try {
        const layers = options.layersFor(key)
        const user = await loadUser(layers, key)
        const project = await loadProject(layers, key)
        const scope = buildScope([...user, ...project])
        if (currentEpoch === epoch) {
          ready.set(key, scope)
          stale.delete(key)
        }
        return scope
      } catch (error) {
        log("error", `[EXTENSIONS]: loading for ${key} failed: ${messageOf(error)}`)
        stale.delete(key)
        return EMPTY_SCOPE
      } finally {
        if (currentEpoch === epoch) loading.delete(key)
      }
    })()
    loading.set(key, started)
    return started
  }

  /** What an extension adds to every request: the schemas of the tools it won (those the tier offers), plus the hooks that may rewrite context. */
  function contextOf(record: ExtensionRecord, scope: ExtensionScope): ExtensionInfo["context"] {
    const tier = options.tier?.()
    const tools = [...scope.tools.values()].filter((entry) => entry.record === record).map(({ tool }) => ({ name: tool.name, tokens: estimateValueTokens({ name: tool.name, description: tool.description, parameters: tool.parameters }), offered: tierIncludes(tier, tool.tier ?? "minimalist") }))
    const rewrites = CONTEXT_REWRITE_HOOKS.filter((hook) => (record.handlers.get(hook)?.length ?? 0) > 0)
    if (tools.length === 0 && rewrites.length === 0) return undefined
    return { tokens: tools.reduce((sum, tool) => sum + (tool.offered ? tool.tokens : 0), 0), tools, rewrites: [...rewrites] }
  }

  function conflictLines(record: ExtensionRecord, scope: ExtensionScope): string[] {
    return scope.conflicts.filter((entry) => entry.winner === record.name || entry.losers.includes(record.name)).map((entry) => entry.note).slice(0, 40)
  }

  const infoOf = (record: ExtensionRecord, scope: ExtensionScope): ExtensionInfo => ({
    name: record.name,
    source: record.origin,
    file: record.file,
    daemon: record.daemon,
    tui: record.tui,
    tools: [...scope.tools].filter(([, entry]) => entry.record === record).map(([name]) => name),
    commands: [...scope.commands].filter(([, entry]) => entry.record === record).map(([name]) => name),
    hooks: [...record.handlers].filter(([, handlers]) => handlers.length).map(([hook]) => hook),
    errors: [...record.errors],
    trusted: record.trusted,
    ...(record.pluginId ? { pluginId: record.pluginId } : {}),
    ...(record.abi ? { abi: record.abi } : {}),
    ...(record.auth ? { authProvider: record.auth.provider } : {}),
    ...(record.provider ? { provider: record.provider.id } : {}),
    ...(record.flags?.size ? { flags: [...record.flags.keys()].slice(0, 64) } : {}),
    ...(record.mcpServers?.size ? { mcpServers: [...record.mcpServers.keys()].slice(0, 64) } : {}),
    ...(record.virtualModels?.length ? { virtualModels: record.virtualModels.map((model) => `virtual:${model.id}`).slice(0, 64) } : {}),
    ...(record.listeners?.size ? { events: [...record.listeners].filter(([, list]) => list.length).map(([event]) => event).slice(0, 64) } : {}),
    ...(record.disabled ? { disabled: true } : {}),
    ...(conflictLines(record, scope).length ? { conflicts: conflictLines(record, scope) } : {}),
    ...([...record.breaker].some(([, state]) => state.open) ? { breaker: [...record.breaker].filter(([, state]) => state.open).map(([key]) => key).slice(0, 40) } : {}),
    ...(record.kept ? { kept: record.kept } : {}),
    ...(contextOf(record, scope) ? { context: contextOf(record, scope)! } : {}),
  })

  const syncScope = (cwd: string) => ready.get(keyOf(cwd)) ?? (loading.has(keyOf(cwd)) ? stale.get(keyOf(cwd)) : undefined)

  return {
    enabled,
    ensure,

    /** Tells the extensions which tools are built in (for `api.builtinTool` and override checks). Called by the engine factory. */
    setBuiltinTools(tools: readonly Tool[]) {
      engineTools = tools
    },

    builtinTools() { return [...builtins().values()] },

    /** Every extension found for `directory` (loading them first), in hook order. Untrusted project ones are listed, not imported. */
    async list(directory: string): Promise<ExtensionInfo[]> {
      const scope = await ensure(directory)
      return scope.records.map((record) => infoOf(record, scope))
    },

    /** The same listing with who won and who lost where extensions collide: the answer of `extensions.list`. */
    async report(directory: string): Promise<{ extensions: ExtensionInfo[]; conflicts?: ExtensionConflict[] }> {
      const scope = await ensure(directory)
      return { extensions: scope.records.map((record) => infoOf(record, scope)), ...(scope.conflicts.length ? { conflicts: [...scope.conflicts] } : {}) }
    },

    /** Estimated tokens each extension adds to a request in `directory` (tool schemas the tier offers), biggest first. */
    async costs(directory: string): Promise<Array<{ name: string; tokens: number; tools: number }>> {
      const scope = await ensure(directory)
      return scope.records.flatMap((record) => {
        const context = contextOf(record, scope)
        const offered = context?.tools.filter((tool) => tool.offered) ?? []
        return context && context.tokens > 0 ? [{ name: record.name, tokens: context.tokens, tools: offered.length }] : []
      }).sort((a, b) => b.tokens - a.tokens)
    },

    /** Which extension registered each tool name in `directory`: the owner column of the context rent. */
    async toolOwners(directory: string): Promise<Map<string, string>> {
      const scope = await ensure(directory)
      return new Map([...scope.tools.values()].map(({ record, tool }) => [tool.name, record.name]))
    },

    /** Tools of the extensions for one session, in the shape the engine takes from `projectTools`. */
    async tools(directory: string, sessionId: string): Promise<ExtensionEngineTool[]> {
      const scope = await ensure(directory)
      return [...scope.tools.values()].map(({ record, tool }) => adaptTool({ tool, sessionId, breaker: { stopped: () => bus.stopped(record, `tool:${tool.name}`), failed: () => bus.strike(record, `tool:${tool.name}`, `tool ${tool.name}`), ok: () => bus.succeed(record, `tool:${tool.name}`) } }))
    },

    /** Extension commands shaped like custom commands, for the palette (`commands.list`). */
    async commandEntries(directory: string): Promise<CustomCommand[]> {
      const scope = await ensure(directory)
      return [...scope.commands.values()].map(({ record, command }) => ({ name: command.name, description: command.description.slice(0, 120), argumentHint: "", body: "", source: record.layer, ...(record.pkg ? { pkg: record.pkg } : {}) }))
    },

    async hasCommand(directory: string, name: string) {
      return (await ensure(directory)).commands.has(name.toLowerCase())
    },

    /**
     * What to do with the text of `user.submit`: the `input` hooks rewrite it or swallow it; then `/name args` of an
     * extension command runs here. `submit` carries the text to queue (and a notice to show beside it); `handled`
     * means no turn starts.
     */
    async routeInput(ref: { sessionId: string; cwd: string }, text: string): Promise<{ kind: "submit"; text: string; notice?: string } | { kind: "handled"; notice?: string }> {
      const scope = await ensure(ref.cwd)
      if (scope.records.length === 0) return { kind: "submit", text }
      let current = text
      if (scope.hooks.has("input")) {
        const result = await bus.input(scope.records, { ...ref, text })
        if (result.handled) return { kind: "handled", ...(result.notice ? { notice: result.notice } : {}) }
        current = result.text
      }
      const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(current.trim())
      if (scope.hooks.has("command.before") && match) {
        current = await bus.transform(scope.records, "command.before", { ...ref, command: match[1]!, args: match[2] ?? "", text: current }, current, (value) => typeof value === "string")
      }
      const typed = scope.commands.size ? /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(current.trim()) : null
      const entry = typed ? scope.commands.get(typed[1]!.toLowerCase()) : undefined
      if (!typed || !entry) return { kind: "submit", text: current }
      const name = entry.command.name
      const key = `/${name}`
      if (bus.stopped(entry.record, key)) return { kind: "handled", notice: `/${name} is stopped for this session after repeated failures; /extensions reload turns it back on` }
      const answer = await bus.guard(entry.record, key, () => entry.command.run(typed[2] ?? "", ref), key)
      if (!answer.ok) return { kind: "handled", notice: `/${name} failed; /extensions lists the error` }
      const result = answer.value
      const notice = isRecord(result) && typeof result.notice === "string" && result.notice ? result.notice : undefined
      if (isRecord(result) && typeof result.prompt === "string" && result.prompt.trim()) return { kind: "submit", text: result.prompt, ...(notice ? { notice } : {}) }
      return { kind: "handled", ...(notice ? { notice } : {}) }
    },

    /** Observer events from the daemon (session and turn lifecycle); fire and forget, never throws. */
    async fire<K extends "session.start" | "turn.start" | "turn.end">(hook: K, cwd: string, event: DaemonHooks[K]["event"]) {
      const scope = await ensure(cwd)
      if (scope.hooks.has(hook)) await bus.notify(scope.records, hook, event)
    },
    async fireEvent(cwd: string, event: Record<string, unknown> & { sessionId: string }) {
      const scope = await ensure(cwd)
      if (scope.hooks.has("event")) await bus.notify(scope.records, "event", { sessionId: event.sessionId, cwd, event: structuredClone(event) })
    },
    async authMethods(directory: string) {
      const scope = await ensure(directory)
      return auth.methods(scope.records.filter((record) => record.auth).map((record) => ({ record, auth: record.auth! })))
    },
    async authStart(directory: string, provider: string, method: number, inputs: Record<string, string>) {
      const scope = await ensure(directory)
      const record = [...scope.records].reverse().find((record) => record.auth?.provider === provider)
      if (!record?.auth) throw new Error("plugin auth provider unavailable")
      return auth.start({ record, auth: record.auth }, keyOf(directory), method, inputs)
    },
    authComplete: (directory: string, flowId: string, code?: string) => auth.complete(keyOf(directory), flowId, code),
    authSet: (provider: string, value: import("@mendcode/extension-api/plugin").PluginAuthValue) => auth.set(provider, value),
    authRemove: (provider: string) => auth.remove(provider),
    async providerOptions(directory: string, provider: string, info: Record<string, unknown> = { id: provider }) {
      const scope = await ensure(directory)
      const entry = [...scope.records].reverse().find((record) => record.auth?.provider === provider)
      const models = [...scope.records].reverse().find((record) => record.provider?.id === provider)
      return auth.options(entry?.auth ? { record: entry, auth: entry.auth } : undefined, models?.provider ? { record: models, provider: models.provider } : undefined, info)
    },
    async providerModels(directory: string): Promise<ModelInfo[]> {
      const scope = await ensure(directory)
      const result: ModelInfo[] = []
      // A provider registered with a baseUrl is a whole provider: the provider service lists its models (`transportProviders`).
      const providers = [...new Set(scope.records.flatMap((record) => record.provider && record.provider.baseUrl === undefined ? [record.provider.id] : []))]
      for (const id of providers) {
        const owner = [...scope.records].reverse().find((record) => record.provider?.id === id)!
        const entry = [...scope.records].reverse().find((record) => record.auth?.provider === id)
        const loaded = await auth.options(entry?.auth ? { record: entry, auth: entry.auth } : undefined, { record: owner, provider: owner.provider! }, { id })
        for (const [key, value] of Object.entries(loaded.models ?? {}).slice(0, 1000)) {
          if (!isRecord(value)) continue
          const limit = isRecord(value.limit) ? value.limit.context : value.contextWindow
          result.push({ id: `${id}:${key}`, name: typeof value.name === "string" ? value.name : key, provider: id, efforts: [], ...(typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? { contextWindow: limit } : {}) })
        }
      }
      return result
    },

    /**
     * Providers that loaded extensions registered with a `baseUrl`, by id, as `providers.json` entries (synchronous: what is loaded
     * now; user extensions load with the first session, `/extensions` or model list). A later layer wins an id; a disabled
     * extension adds nothing. The provider service merges them under the user's own configuration.
     */
    transportProviders(): Record<string, ExtensionProviderEntry> {
      const found: Record<string, ExtensionProviderEntry> = {}
      const scopes = [...stale.values(), ...ready.values()]
      for (const scope of scopes) for (const record of scope.records) {
        if (record.disabled || !record.provider || record.layer !== "user") continue
        const entry = providerEntry(record.provider)
        if (entry) found[record.provider.id] = entry
      }
      return found
    },

    /** Checks the extension flags a CLI invocation passed for a session of `directory` against what its extensions declare. */
    async checkFlags(directory: string, values: Record<string, string | boolean>) {
      return checkFlagValues((await ensure(directory)).records, values)
    },
    /** Every flag the extensions of `directory` declare, for help and `/extensions`. */
    async flags(directory: string) {
      return [...declaredFlags((await ensure(directory)).records)].map(([name, { record, flag }]) => ({ name, extension: record.name, ...flag }))
    },

    /** MCP servers the extensions of `directory` register, as mcp.json entries (loading them first). */
    async mcpServers(directory: string) {
      return extensionMcpServers((await ensure(directory)).records, keyOf(directory))
    },

    /** Catalog entries of the virtual models loaded user extensions register (synchronous, like `transportProviders`). */
    virtualModels(catalog: readonly ModelInfo[]): ModelInfo[] {
      return virtualCatalog(registeredVirtualModels(new Set([...stale.values(), ...ready.values()].flatMap((scope) => scope.records))), catalog)
    },
    /** The real model a call of a virtual model goes to (any other choice unchanged). */
    routeModel<C extends import("@mendcode/protocol").ModelChoice>(choice: C, context: { sessionId: string; cwd: string; role: string }, catalog: readonly ModelInfo[]): C {
      if (!choice.model.startsWith("virtual:")) return choice
      const registered = registeredVirtualModels(new Set([...stale.values(), ...ready.values()].flatMap((scope) => scope.records)))
      return routeVirtual({ choice, registered, catalog, context, fail, now }) as C
    },

    /** The hook bus and the already-loaded scope of a directory (synchronous; undefined until a session there loaded it), for the engine adapter. */
    bus,
    syncScope,

    /** Forgets the per-directory (project) extensions so the next use reloads them: the trust of a directory changed. User-layer ones stay. */
    invalidateProject() {
      ready.clear()
      stale.clear()
      loading.clear()
    },
    /** A reload: everything loads again, but the scopes in use keep serving synchronous lookups until their replacement is ready. */
    invalidateAll() {
      epoch++
      auth.invalidate()
      userRecords = undefined
      for (const [key, scope] of ready) stale.set(key, scope)
      ready.clear()
      loading.clear()
    },
  }
}

export type DaemonExtensions = ReturnType<typeof createExtensions>
