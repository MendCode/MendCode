import type { McpCallResult, McpClient, McpClientState, McpToolInfo } from "./client"
import { displayUrl, type LoadedMcpConfig, type McpIssue, type McpServerConfig } from "./config"
import type { ElicitHandler } from "./elicitation"
import { createMcpClient } from "./factory"
import type { FetchFn, McpAuth } from "./oauth"
import { discoverAuthorization, parseChallenge } from "./oauth"
import type { McpServerPrompt } from "./prompts"
import { catalogName, type McpCatalog, type McpPromptResult, type McpResourceContent } from "./catalog"

export type McpCatalogReport = {
  resources: Array<McpCatalog["resources"][number] & { server: string; id: string }>
  templates: Array<McpCatalog["templates"][number] & { server: string; id: string }>
  prompts: Array<McpCatalog["prompts"][number] & { server: string; id: string }>
  issues: McpIssue[]
}

export type McpDebugReport = {
  server: string; url: string; auth: "none" | "pending" | "authorized" | "expired"
  credentials: { accessToken: boolean; refreshToken: boolean; client: boolean; expiresAt?: number }
  httpStatus?: number
  oauth?: { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; registrationAvailable: boolean; clientRegistrationRequired: boolean }
  error?: string
}

export const DEFAULT_IDLE_MS = 10 * 60 * 1000

/** Timers are injectable so idle shutdown can be tested without waiting. */
export interface McpClock {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: McpClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type McpServerTool = { server: string; tool: McpToolInfo }

export const STATUS_STDERR_LINES = 20
/** How the user lets a project's servers run; shown next to every server held back. */
export const TRUST_HINT = "run /trust on (or /tools, t) in this project"
const STATUS_LINE_CHARS = 400

/**
 * OAuth state of a remote server: none (no credentials stored, nothing refused yet), needs_auth (the server answered
 * 401 and no usable token exists), pending (a flow waits for the browser redirect), authorized (tokens stored).
 */
export type McpServerAuth = "none" | "needs_auth" | "pending" | "authorized"

export type McpServerStatus = {
  name: string
  /** Command line (or the URL, without query or credentials, of a remote server) for display; the value of any `key=value` argument is masked (expanded secrets never leave the process). */
  command: string
  enabled: boolean
  state: McpClientState
  pid?: number
  tools: number
  lastError?: string
  /** Last lines of the server's stderr (newest last). */
  stderr: string[]
  /** Set to "remote" for a server with a `url`; absent for a local (stdio) one. */
  transport?: "remote"
  /** Remote servers with OAuth available only. */
  auth?: McpServerAuth
  authStored?: boolean
  authExpiresAt?: number
  /** A project server held back until the project is trusted: no client, no process, no connection. */
  needsTrust?: boolean
}
export type McpStatusReport = { servers: McpServerStatus[]; issues: McpIssue[] }

const AUTH_LABEL: Record<McpServerAuth, string> = { none: "", needs_auth: " [oauth: needs authorization]", pending: " [oauth: waiting for the browser]", authorized: " [oauth: authorized]" }

async function waitForAuthorization<T>(completion: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return completion
  if (signal.aborted) throw new Error("authorization wait cancelled")
  let abort = () => {}
  try {
    return await Promise.race([completion, new Promise<never>((_, reject) => {
      abort = () => reject(new Error("authorization wait cancelled"))
      signal.addEventListener("abort", abort, { once: true })
    })])
  } finally { signal.removeEventListener("abort", abort) }
}

function displayCommand(config: McpServerConfig, auth?: McpServerAuth): string {
  if (config.url !== undefined) return `${displayUrl(config.url)}${auth ? AUTH_LABEL[auth] : ""}`
  const args = (config.args ?? []).map((arg) => {
    const equals = arg.indexOf("=")
    return equals > 0 ? `${arg.slice(0, equals + 1)}***` : arg
  })
  return [config.command, ...args].join(" ")
}

function statusOf({ name, command, enabled, client, remote, auth }: { name: string; command: string; enabled: boolean; client: McpClient | undefined; remote?: boolean; auth?: McpServerAuth | undefined }): McpServerStatus {
  const status: McpServerStatus = {
    name,
    command,
    enabled,
    state: client?.state ?? "stopped",
    tools: client?.toolCount ?? 0,
    stderr: (client?.stderr() ?? "").split("\n").filter((line) => line.trim() !== "").slice(-STATUS_STDERR_LINES).map((line) => line.slice(0, STATUS_LINE_CHARS)),
  }
  if (client?.pid !== undefined) status.pid = client.pid
  if (client?.lastError) status.lastError = client.lastError
  if (remote) status.transport = "remote"
  if (auth) status.auth = auth
  return status
}

export interface McpManager {
  connect?(input: { directory: string; server: string }): Promise<McpServerStatus>
  disconnect?(input: { directory: string; server: string }): Promise<McpServerStatus>
  finishAuth?(input: { directory: string; server: string; code: string }): Promise<McpServerStatus>
  waitAuth?(input: { directory: string; server: string; signal?: AbortSignal }): Promise<McpServerStatus>
  catalog(directory: string): Promise<McpCatalogReport>
  readResource(input: { directory: string; server: string; uri: string; signal?: AbortSignal }): Promise<McpResourceContent[]>
  getPromptResult(input: { directory: string; server: string; name: string; args: Record<string, string>; signal?: AbortSignal }): Promise<McpPromptResult>
  debug(input: { directory: string; server: string }): Promise<McpDebugReport>
  /** Starts every enabled server of the directory (lazily, once) and lists their tools. Failures come back as issues. */
  listTools(directory: string): Promise<{ tools: McpServerTool[]; issues: McpIssue[] }>
  cachedPrompts(directory: string): McpServerPrompt[]
  listPrompts(directory: string): Promise<{ prompts: McpServerPrompt[]; issues: McpIssue[] }>
  getPrompt(input: { directory: string; server: string; name: string; args: Record<string, string>; signal?: AbortSignal }): Promise<string>
  /** `elicit` answers the server's questions to the user while the call runs (MCP elicitation); without it they are declined. */
  callTool(input: { directory: string; server: string; tool: string; args: Record<string, unknown>; signal?: AbortSignal; elicit?: ElicitHandler }): Promise<McpCallResult>
  /**
   * Forget the cached config for a directory (or all), so the next use re-reads it, and stop the running servers the new
   * config removed, disabled, blocked (untrusted project) or changed; their tools are gone from the next request.
   */
  invalidate(directory?: string): Promise<void>
  running(): Array<{ directory: string; server: string; pid: number | undefined }>
  /** Read-only: reports every configured server (re-reading the config files) without starting anything. */
  status(directory: string): Promise<McpStatusReport>
  /** Stops the server if running and starts it again with the current config; a failed start is reported in the status, not thrown. */
  restart(input: { directory: string; server: string }): Promise<McpServerStatus>
  /**
   * Starts OAuth for a remote server (one that answered 401): resolves with the URL to open in a browser as soon as it
   * is ready; `completion` resolves with the restarted server's status once the loopback redirect arrived and the
   * tokens are stored, and rejects on denial, timeout or cancel. Throws when the server is local, has `oauth: false`
   * or the server's authorization metadata cannot be found.
   */
  startAuth(input: { directory: string; server: string; signal?: AbortSignal }): Promise<{ url: string; completion: Promise<McpServerStatus> }>
  /** Cancels a waiting authorization. */
  cancelAuth(input: { directory: string; server: string }): Promise<void>
  /** Drops the stored OAuth client and tokens of a remote server and disconnects it. */
  forgetAuth(input: { directory: string; server: string }): Promise<McpServerStatus>
  /** Kill every child (process groups included) and cancel every timer. */
  stop(): Promise<void>
  suspend(input: { directory?: string; server: string }): Promise<void>
}

type Entry = { directory: string; server: string; config: McpServerConfig; client: McpClient; inFlight: number; timer: unknown; tools?: McpToolInfo[]; catalog?: McpCatalog | undefined }
/**
 * What a server that stopped for idleness last listed, so the next turn still shows the model its tools (and resources)
 * without spawning it again; a real use (a call, a read, a prompt) starts it as before.
 */
type Parked = { config: McpServerConfig; tools?: McpToolInfo[]; catalog?: McpCatalog }

export function createMcpManager({
  configLoader,
  idleMs = DEFAULT_IDLE_MS,
  clock = realClock,
  auth,
  fetch,
  clientFactory = (input) => createMcpClient({ ...input, auth, fetch }),
}: {
  configLoader: (directory: string) => Promise<LoadedMcpConfig> | LoadedMcpConfig
  idleMs?: number
  clock?: McpClock
  /** OAuth for remote servers (`createMcpAuth`); without it a 401 is reported as rejected credentials. */
  auth?: McpAuth | undefined
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: FetchFn | undefined
  clientFactory?: (input: { name: string; config: McpServerConfig; directory: string }) => McpClient
}): McpManager {
  const configs = new Map<string, Promise<LoadedMcpConfig>>()
  const entries = new Map<string, Entry>()
  const disconnected = new Set<string>()
  const authorizations = new Map<string, Promise<McpServerStatus>>()
  const authorizationUrls = new Map<string, string>()
  let generation = 0
  const configGenerations = new WeakMap<McpServerConfig, number>()

  const loadConfig = (directory: string) => {
    let loaded = configs.get(directory)
    if (!loaded) {
      const current = generation
      loaded = Promise.resolve(configLoader(directory)).then((config) => {
        for (const server of Object.values(config.servers)) configGenerations.set(server, current)
        return config
      })
      configs.set(directory, loaded)
      loaded.catch(() => configs.delete(directory))
    }
    return loaded
  }

  const promptCache = new Map<string, McpServerPrompt[]>()
  const keyOf = (directory: string, server: string) => `${directory}\0${server}`

  const parked = new Map<string, Parked>()
  const unpark = (matches: (directory: string, server: string) => boolean) => {
    for (const key of parked.keys()) {
      const [directory, server] = key.split("\0") as [string, string]
      if (matches(directory, server)) parked.delete(key)
    }
  }
  /** The parked listing of a server that is not running, if it was made under the same config. */
  const parkedFor = (key: string, config: McpServerConfig) => {
    const listing = entries.has(key) ? undefined : parked.get(key)
    return listing && JSON.stringify(listing.config) === JSON.stringify(config) ? listing : undefined
  }

  const armTimer = (entry: Entry) => {
    clock.clearTimeout(entry.timer)
    entry.timer = clock.setTimeout(() => {
      if (entry.inFlight > 0) return armTimer(entry)
      const key = keyOf(entry.directory, entry.server)
      entries.delete(key)
      if (entry.tools || entry.catalog) parked.set(key, { config: entry.config, ...(entry.tools ? { tools: entry.tools } : {}), ...(entry.catalog ? { catalog: entry.catalog } : {}) })
      void entry.client.close()
    }, idleMs)
  }

  const entryFor = ({ directory, server, config }: { directory: string; server: string; config: McpServerConfig }): Entry => {
    if (configGenerations.get(config) !== generation || config.enabled === false) throw new Error(`MCP configuration changed; retry after review`)
    const key = keyOf(directory, server)
    if (disconnected.has(key)) throw new Error(`MCP server ${server} is disconnected`)
    let entry = entries.get(key)
    if (!entry) {
      entry = { directory, server, config, client: clientFactory({ name: server, config, directory }), inFlight: 0, timer: undefined }
      entries.set(key, entry)
      parked.delete(key)
    }
    return entry
  }

  /**
   * Runs `run` on the entry's client. A use restarts the idle timer; a listing (`touch: false`: the tool list and catalog every
   * turn reads) does not, so a server the model never calls stops after the idle period instead of living as long as turns come.
   */
  const use = async <T>(entry: Entry, run: (client: McpClient) => Promise<T>, touch = true): Promise<T> => {
    entry.inFlight++
    if (touch) clock.clearTimeout(entry.timer)
    try {
      return await run(entry.client)
    } finally {
      entry.inFlight--
      if (entries.get(keyOf(entry.directory, entry.server)) === entry && (touch || entry.timer === undefined)) armTimer(entry)
    }
  }

  /** Status of one configured server, with the OAuth state of a remote one. */
  const statusFor = async ({ name, serverConfig, client }: { name: string; serverConfig: McpServerConfig; client: McpClient | undefined }): Promise<McpServerStatus> => {
    const remote = serverConfig.url !== undefined
    const oauthState = remote && auth && serverConfig.oauth !== false ? await auth.state(serverConfig.url as string).catch(() => "none" as const) : undefined
    const state: McpServerAuth | undefined = oauthState === undefined ? undefined : client?.needsAuth && oauthState !== "pending" ? "needs_auth" : oauthState
    const status = statusOf({ name, command: displayCommand(serverConfig, state), enabled: serverConfig.enabled !== false, client, remote, auth: state })
    if (remote && serverConfig.oauth !== false && auth?.inspect) {
      const stored = await auth.inspect(serverConfig.url!)
      status.authStored = stored.client || stored.accessToken
      if (stored.expiresAt !== undefined) status.authExpiresAt = stored.expiresAt
    }
    return status
  }

  /** A project server of an untrusted project is declared but never reachable: say so instead of "unknown". */
  const refuseBlocked = (config: LoadedMcpConfig, server: string) => {
    if (config.blocked?.some((item) => item.name === server)) throw new Error(`MCP server ${server} needs project trust: ${TRUST_HINT}`)
  }

  const serverOf = async (directory: string, server: string) => {
    const loaded = await loadConfig(directory)
    refuseBlocked(loaded, server)
    return loaded.servers[server]
  }

  /** Stops what a changed config no longer allows: a server that is gone, disabled, blocked or different from the one running. */
  async function reconcile(directory: string | undefined) {
    const stale: Entry[] = []
    const loaded = new Map<string, LoadedMcpConfig | undefined>()
    for (const entry of [...entries.values()]) {
      if (directory !== undefined && entry.directory !== directory) continue
      if (!loaded.has(entry.directory)) loaded.set(entry.directory, await loadConfig(entry.directory).catch(() => undefined))
      const next = loaded.get(entry.directory)?.servers[entry.server]
      if (loaded.get(entry.directory) && (!next || next.enabled === false || JSON.stringify(next) !== JSON.stringify(entry.config))) stale.push(entry)
    }
    for (const entry of stale) {
      if (entries.get(keyOf(entry.directory, entry.server)) !== entry) continue
      entries.delete(keyOf(entry.directory, entry.server))
      clock.clearTimeout(entry.timer)
      await entry.client.close().catch(() => undefined)
    }
  }

  async function restart({ directory, server }: { directory: string; server: string }): Promise<McpServerStatus> {
    disconnected.delete(keyOf(directory, server))
    configs.delete(directory)
    const config = await loadConfig(directory)
    refuseBlocked(config, server)
    const serverConfig = config.servers[server]
    if (!serverConfig) throw new Error(`unknown MCP server: ${server}`)
    if (serverConfig.enabled === false) throw new Error(`MCP server ${server} is disabled`)
    const key = keyOf(directory, server)
    const previous = entries.get(key)
    if (previous) {
      entries.delete(key)
      clock.clearTimeout(previous.timer)
      await previous.client.close()
    }
    const entry = entryFor({ directory, server, config: serverConfig })
    await use(entry, async (client) => {
      await client.start()
      await client.listTools()
    }).catch(() => undefined)
    return statusFor({ name: server, serverConfig, client: entry.client })
  }

  /** The config of a remote server that can use OAuth; anything else is an error the caller reports. */
  async function remoteConfig({ directory, server }: { directory: string; server: string }): Promise<{ config: McpServerConfig; url: string }> {
    if (!auth) throw new Error("OAuth is not available in this daemon")
    configs.delete(directory)
    const loaded = await loadConfig(directory)
    refuseBlocked(loaded, server)
    const config = loaded.servers[server]
    if (!config || config.enabled === false || configGenerations.get(config) !== generation) throw new Error(`unknown or disabled MCP server: ${server}`)
    if (config.url === undefined) throw new Error(`MCP server ${server} is a local server; OAuth applies to remote (url) servers`)
    if (config.oauth === false) throw new Error(`OAuth is turned off for MCP server ${server} ("oauth": false)`)
    return { config, url: config.url }
  }

  return {
    async suspend({ directory, server }) {
      generation++
      configs.clear()
      const matches = (value: string) => directory === undefined || value === directory
      for (const [key, url] of authorizationUrls) {
        const [value, name] = key.split("\0")
        if (name !== server || !matches(value!)) continue
        auth?.cancel(url)
        authorizationUrls.delete(key)
        authorizations.delete(key)
      }
      for (const key of disconnected) {
        const [value, name] = key.split("\0")
        if (name === server && matches(value!)) disconnected.delete(key)
      }
      for (const [key, entry] of entries) {
        if (entry.server !== server || !matches(entry.directory)) continue
        entries.delete(key)
        clock.clearTimeout(entry.timer)
        await entry.client.close()
      }
      unpark((value, name) => name === server && matches(value))
      for (const [value] of promptCache) if (matches(value)) promptCache.delete(value)
    },
    connect: restart,
    async disconnect({ directory, server }) {
      configs.delete(directory)
      const loaded = await loadConfig(directory)
      refuseBlocked(loaded, server)
      const config = loaded.servers[server]
      if (!config) throw new Error(`unknown MCP server: ${server}`)
      const key = keyOf(directory, server)
      disconnected.add(key)
      parked.delete(key)
      if (config.url) auth?.cancel(config.url)
      authorizations.delete(key)
      const entry = entries.get(key)
      if (entry) { entries.delete(key); clock.clearTimeout(entry.timer); await entry.client.close() }
      promptCache.delete(directory)
      return statusFor({ name: server, serverConfig: { ...config, enabled: false }, client: undefined })
    },
    async finishAuth({ directory, server, code }) {
      const { url } = await remoteConfig({ directory, server })
      if (!auth?.complete) throw new Error("OAuth callback unavailable")
      const completion = authorizations.get(keyOf(directory, server))
      if (!completion) throw new Error("no pending authorization")
      await auth.complete(url, code)
      return completion
    },
    async waitAuth({ directory, server, signal }) {
      const completion = authorizations.get(keyOf(directory, server))
      if (!completion) throw new Error("no pending authorization")
      return waitForAuthorization(completion, signal)
    },
    async catalog(directory) {
      const config = await loadConfig(directory)
      const report: McpCatalogReport = { resources: [], templates: [], prompts: [], issues: [...config.errors] }
      await Promise.all(Object.entries(config.servers).filter(([server, item]) => item.enabled !== false && !disconnected.has(keyOf(directory, server))).map(async ([server, item]) => {
        try {
          const listing = parkedFor(keyOf(directory, server), item)?.catalog
          const entry = listing ? undefined : entryFor({ directory, server, config: item })
          const catalog = listing ?? await use(entry!, (client) => client.catalog?.() ?? Promise.resolve({ resources: [], templates: [], prompts: [] }), false)
          // A listing with issues is not kept: the next one asks the server again, as a running client would.
          if (entry) entry.catalog = catalog.issues?.length ? undefined : catalog
          for (const field of ["resources", "templates", "prompts"] as const) {
            for (const entry of catalog[field]) (report[field] as Array<{ server: string; id: string }>).push({ ...entry, server, id: catalogName(server, entry.name) })
          }
          for (const message of catalog.issues ?? []) report.issues.push({ source: "runtime", server, message })
        } catch (error) {
          report.issues.push({ source: "runtime", server, message: error instanceof Error ? error.message : String(error) })
        }
      }))
      for (const field of ["resources", "templates", "prompts"] as const) report[field].sort((left, right) => left.id.localeCompare(right.id))
      return report
    },
    async readResource({ directory, server, uri, signal }) {
      const config = await serverOf(directory, server)
      if (!config || config.enabled === false) throw new Error(`unknown or disabled MCP server: ${server}`)
      return use(entryFor({ directory, server, config }), (client) => {
        if (!client.readResource) throw new Error(`MCP server "${server}" cannot read resources`)
        return client.readResource(uri, signal)
      })
    },
    async getPromptResult({ directory, server, name, args, signal }) {
      const config = await serverOf(directory, server)
      if (!config || config.enabled === false) throw new Error(`unknown or disabled MCP server: ${server}`)
      return use(entryFor({ directory, server, config }), (client) => {
        if (client.getPromptResult) return client.getPromptResult(name, args, signal)
        if (!client.getPrompt) throw new Error(`MCP server "${server}" cannot get prompts`)
        return client.getPrompt(name, args, signal).then((text) => ({ messages: [{ role: "user" as const, content: { type: "text", text } }] }))
      })
    },
    async debug({ directory, server }) {
      configs.delete(directory)
      const config = (await loadConfig(directory)).servers[server]
      if (!config || config.enabled === false || configGenerations.get(config) !== generation) throw new Error(`unknown or disabled MCP server: ${server}`)
      if (!config.url) throw new Error(`MCP server ${server} is local; OAuth debug requires a remote server`)
      if (config.oauth === false) throw new Error(`OAuth is turned off for MCP server ${server}`)
      const credentials = await auth?.inspect?.(config.url) ?? { accessToken: false, refreshToken: false, client: false }
      const state = await auth?.state(config.url) ?? "none"
      const report: McpDebugReport = { server, url: displayUrl(config.url), credentials, auth: state === "pending" ? state : credentials.expiresAt !== undefined && credentials.expiresAt <= Date.now() ? "expired" : state }
      const request = fetch ?? globalThis.fetch as FetchFn
      const signal = AbortSignal.timeout(Math.min(config.timeoutMs ?? 20_000, 20_000))
      try {
        const response = await request(config.url, { method: "POST", headers: { ...config.headers, "content-type": "application/json", accept: "application/json, text/event-stream" }, signal,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mendcode-debug", version: "2" } } }) })
        report.httpStatus = response.status
        const challenge = parseChallenge(response.headers.get("www-authenticate"))
        await response.body?.cancel()
        if (response.status === 401) {
          const metadata = await discoverAuthorization({ serverUrl: config.url, challenge, fetch: request, signal })
          report.oauth = { issuer: displayUrl(metadata.issuer), authorizationEndpoint: displayUrl(metadata.authorizationEndpoint), tokenEndpoint: displayUrl(metadata.tokenEndpoint), registrationAvailable: Boolean(metadata.registrationEndpoint), clientRegistrationRequired: !(typeof config.oauth === "object" && config.oauth.clientId || credentials.client) }
        } else if (!response.ok) report.error = `HTTP ${response.status}`
      } catch {
        report.error = signal.aborted ? "OAuth debug timed out" : "connection or OAuth discovery failed"
      }
      return report
    },
    async listTools(directory) {
      const config = await loadConfig(directory)
      const issues: McpIssue[] = [...config.errors]
      const found = await Promise.all(
        Object.entries(config.servers)
          .filter(([name, server]) => server.enabled !== false && !disconnected.has(keyOf(directory, name)))
          .map(async ([server, serverConfig]): Promise<McpServerTool[]> => {
            try {
              const listing = parkedFor(keyOf(directory, server), serverConfig)?.tools
              const entry = listing ? undefined : entryFor({ directory, server, config: serverConfig })
              const tools = listing ?? await use(entry!, (client) => client.listTools(), false)
              if (entry) entry.tools = tools
              return tools.map((tool) => ({ server, tool }))
            } catch (error) {
              issues.push({ source: "runtime", server, message: error instanceof Error ? error.message : String(error) })
              return []
            }
          }),
      )
      return { tools: found.flat(), issues }
    },

    cachedPrompts: (directory) => promptCache.get(directory) ?? [],
    async listPrompts(directory) {
      const config = await loadConfig(directory)
      const issues: McpIssue[] = [...config.errors]
      const found = await Promise.all(Object.entries(config.servers).filter(([name, entry]) => entry.enabled !== false && !disconnected.has(keyOf(directory, name))).map(async ([server, serverConfig]): Promise<McpServerPrompt[]> => {
        try {
          const prompts = await use(entryFor({ directory, server, config: serverConfig }), (client) => client.listPrompts?.() ?? Promise.resolve([]))
          return prompts.map((prompt) => ({ server, prompt }))
        } catch (error) {
          issues.push({ source: "runtime", server, message: error instanceof Error ? error.message : String(error) })
          return []
        }
      }))
      const prompts = found.flat().slice(0, 200)
      promptCache.set(directory, prompts)
      return { prompts, issues }
    },
    async getPrompt({ directory, server, name, args, signal }) {
      const config = await serverOf(directory, server)
      if (!config || config.enabled === false) throw new Error(`unknown or disabled MCP server: ${server}`)
      return use(entryFor({ directory, server, config }), (client) => {
        if (!client.getPrompt) throw new Error(`MCP server does not provide prompts: ${server}`)
        return client.getPrompt(name, args, signal)
      })
    },

    async callTool({ directory, server, tool, args, signal, elicit }) {
      const config = await serverOf(directory, server)
      if (!config || config.enabled === false) throw new Error(`unknown or disabled MCP server: ${server}`)
      return use(entryFor({ directory, server, config }), (client) => client.callTool(tool, args, signal, elicit))
    },

    async status(directory) {
      configs.delete(directory)
      const config = await loadConfig(directory)
      const servers = await Promise.all(Object.entries(config.servers).map(async ([name, serverConfig]) => {
        const status = await statusFor({ name, serverConfig: disconnected.has(keyOf(directory, name)) ? { ...serverConfig, enabled: false } : serverConfig, client: entries.get(keyOf(directory, name))?.client })
        // Stopped for idleness: the model still has its tools, so the count stays.
        const listed = parkedFor(keyOf(directory, name), serverConfig)?.tools
        return listed ? { ...status, tools: listed.length } : status
      }))
      for (const entry of entries.values()) {
        if (entry.directory === directory && !(entry.server in config.servers)) {
          servers.push(statusOf({ name: entry.server, command: "(removed from config)", enabled: true, client: entry.client }))
        }
      }
      const issues = [...config.errors]
      for (const item of config.blocked ?? []) {
        servers.push({ name: item.name, command: item.command, enabled: false, state: "stopped", tools: 0, stderr: [], needsTrust: true, ...(item.transport ? { transport: item.transport } : {}) })
        issues.push({ source: item.source, server: item.name, message: `needs project trust: ${TRUST_HINT}` })
      }
      return { servers, issues }
    },

    restart,

    async startAuth({ directory, server, signal }) {
      const { config, url } = await remoteConfig({ directory, server })
      const client = entries.get(keyOf(directory, server))?.client
      const started = await (auth as McpAuth).start({
        serverName: server,
        serverUrl: url,
        challenge: client?.authChallenge,
        oauth: config.oauth || undefined,
        signal,
      })
      const completion = started.completion.then(() => {
        if (disconnected.has(keyOf(directory, server))) throw new Error("MCP server disconnected during authorization")
        return restart({ directory, server })
      })
      // A caller that only opens the URL may never await this; a denied or cancelled flow is not an unhandled rejection.
      completion.catch(() => undefined)
      const key = keyOf(directory, server)
      authorizations.set(key, completion)
      authorizationUrls.set(key, config.url!)
      void completion.finally(() => { if (authorizations.get(key) === completion) { authorizations.delete(key); authorizationUrls.delete(key) } }).catch(() => undefined)
      return { url: started.url, completion }
    },

    async cancelAuth({ directory, server }) {
      const { url } = await remoteConfig({ directory, server })
      ;(auth as McpAuth).cancel(url)
    },

    async forgetAuth({ directory, server }) {
      const { url } = await remoteConfig({ directory, server })
      // Disconnect first: closing a session is an authenticated request.
      const key = keyOf(directory, server)
      parked.delete(key)
      const previous = entries.get(key)
      if (previous) {
        entries.delete(key)
        clock.clearTimeout(previous.timer)
        await previous.client.close()
      }
      await (auth as McpAuth).forget(url)
      const serverConfig = (await loadConfig(directory)).servers[server] as McpServerConfig
      return statusFor({ name: server, serverConfig, client: undefined })
    },

    async invalidate(directory) {
      generation++
      configs.clear()
      if (directory === undefined) promptCache.clear()
      else promptCache.delete(directory)
      unpark((value) => directory === undefined || value === directory)
      await reconcile(directory)
    },

    running() {
      return [...entries.values()].map((entry) => ({ directory: entry.directory, server: entry.server, pid: entry.client.pid }))
    },

    async stop() {
      for (const url of authorizationUrls.values()) auth?.cancel(url)
      authorizationUrls.clear()
      authorizations.clear()
      disconnected.clear()
      promptCache.clear()
      parked.clear()
      const all = [...entries.values()]
      entries.clear()
      for (const entry of all) clock.clearTimeout(entry.timer)
      await Promise.all(all.map((entry) => entry.client.close()))
    },
  }
}
