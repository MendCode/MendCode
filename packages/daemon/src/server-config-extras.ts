import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pluginConfig, pluginIdentity } from "@mendcode/extension-api/plugin-files"
import { HttpServerConfig, REDACTED_VALUE, RestServerConfig, redactSecrets, type McpConfigInput, type RestConfig, type RestMcpConfig } from "@mendcode/protocol"
import { addMcpConfig, mcpFolder, readMcpServers, restMcpNative } from "./mcp-config"
import { installPlugin, pluginRoot, savePluginList } from "./extensions/plugin-install"

type Native = Record<string, unknown>
type Plugin = NonNullable<RestConfig["plugin"]>[number]
/** The donor config fields that live in files rather than in daemon settings. */
export type ConfigExtras = Pick<RestConfig, "mcp" | "plugin" | "server" | "instructions" | "skills">
export type ExtrasChange = { mcp?: boolean; plugin?: boolean; directory?: string }

const SECRET_KEY = /secret|token|password|passwd|api.?key|private.?key|access.?key|authorization|cookie|credential|bearer|^key$/i
const PROJECT_FILE = path.join(".mendcode", "project.json")
const maskable = (key: string, value: string) => SECRET_KEY.test(key) || redactSecrets(value).text !== value
const record = (value: unknown): value is Native => !!value && typeof value === "object" && !Array.isArray(value)

function maskRecord(value: Record<string, string> | undefined) {
  return value ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskable(key, item) ? REDACTED_VALUE : item])) : undefined
}
function maskDeep(value: unknown, key = ""): unknown {
  if (typeof value === "string") return maskable(key, value) ? REDACTED_VALUE : value
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, key))
  return record(value) ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, maskDeep(item, name)])) : value
}
function maskUrl(value: string) {
  try {
    const url = new URL(value)
    url.username = ""; url.password = ""
    for (const [name, item] of [...url.searchParams]) if (maskable(name, item)) url.searchParams.set(name, REDACTED_VALUE)
    return url.href
  } catch { return value }
}
/** A value sent back as REDACTED_VALUE keeps what is stored; anywhere it has nothing to restore it is refused rather than saved. */
function restoreDeep(next: unknown, previous: unknown): unknown {
  if (next === REDACTED_VALUE) {
    if (typeof previous !== "string") throw new Error("redacted value has nothing to restore")
    return previous
  }
  if (Array.isArray(next)) return next.map((item, index) => restoreDeep(item, Array.isArray(previous) ? previous[index] : undefined))
  if (record(next)) return Object.fromEntries(Object.entries(next).map(([name, item]) => [name, restoreDeep(item, record(previous) ? previous[name] : undefined)]))
  return next
}

function mcpView(server: Native): RestMcpConfig | undefined {
  if (server.pendingApproval) return undefined
  const common = { ...(typeof server.enabled === "boolean" ? { enabled: server.enabled } : {}), ...(typeof server.timeoutMs === "number" ? { timeout: server.timeoutMs } : {}) }
  if (typeof server.url === "string") {
    const oauth = server.oauth === false ? false : record(server.oauth) ? { ...server.oauth, ...(typeof server.oauth.clientSecret === "string" ? { clientSecret: REDACTED_VALUE } : {}) } : undefined
    return { type: "remote", url: maskUrl(server.url), ...(record(server.headers) ? { headers: maskRecord(server.headers as Record<string, string>)! } : {}), ...(oauth === undefined ? {} : { oauth: oauth as never }), ...common }
  }
  if (typeof server.command !== "string") return undefined
  return { type: "local", command: [server.command, ...(Array.isArray(server.args) ? server.args.map(String) : [])], ...(typeof server.cwd === "string" ? { cwd: server.cwd } : {}), ...(record(server.env) ? { environment: maskRecord(server.env as Record<string, string>)! } : {}), ...common }
}

function writeJson(file: string, value: unknown, mode?: number) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? {} : { mode })
  renameSync(temporary, file)
}
function readObject(file: string, limit = 64 * 1024): Native {
  try {
    if (statSync(file).size > limit) throw new Error("config file too large")
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown
    if (!record(value)) throw new Error("config file must be an object")
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
}
const specOf = (item: unknown) => typeof item === "string" ? item : Array.isArray(item) && typeof item[0] === "string" ? item[0] : undefined
const optionsOf = (item: unknown) => Array.isArray(item) && record(item[1]) ? item[1] : undefined

/**
 * Donor `mcp`, `plugin`, `server` and project `instructions`/`skills` mapped to the files the daemon already reads:
 * `mcp.json` (user or project), `mendcode.json` plugin lists, `remote.json` listener settings and `.mendcode/project.json`.
 * Nothing is started here: servers connect lazily, plugin specifiers install through the offline installer, and the
 * listener only reads its settings on the next start (it stays opt-in and loopback-only).
 */
export function createServerConfigExtras(input: { dir: string; changed(change: ExtrasChange): void; installPlugin?: typeof installPlugin }) {
  const install = input.installPlugin ?? installPlugin
  const mcpPath = (directory?: string) => path.join(mcpFolder({ dir: input.dir, ...(directory ? { directory } : {}) }), "mcp.json")
  const root = (directory?: string) => pluginRoot({ dataDir: input.dir, directory: directory ?? input.dir, ...(directory ? {} : { global: true }) })
  const pluginList = (directory?: string) => { const list = pluginConfig(root(directory)).value.plugin; return Array.isArray(list) ? list : [] }

  function readServer() {
    const value = readObject(path.join(input.dir, "remote.json")).server
    if (!record(value)) return undefined
    const parsed = RestServerConfig.safeParse(Object.fromEntries(Object.entries(value).filter(([key]) => key in RestServerConfig.shape)))
    return parsed.success && Object.keys(parsed.data).length ? parsed.data : undefined
  }
  function writeServer(patch: NonNullable<RestConfig["server"]>) {
    const file = path.join(input.dir, "remote.json")
    const existing = readObject(file)
    const merged = { ...(record(existing.server) ? existing.server : {}), ...patch }
    const parsed = HttpServerConfig.safeParse(merged)
    if (!parsed.success) throw new Error("invalid server configuration (loopback only)")
    if (parsed.data.mdns) throw new Error("mDNS is unavailable for the loopback server")
    for (const origin of parsed.data.cors) {
      const url = new URL(origin)
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error("CORS entries must be exact HTTP origins")
    }
    writeJson(file, { ...existing, server: merged }, 0o600)
  }

  /** Instructions are read into prompts, so a project may only point at its own files; remote and outside paths never get saved. */
  function projectPaths(directory: string, values: readonly string[]) {
    for (const raw of values) {
      const relative = path.relative(path.resolve(directory), path.resolve(directory, raw))
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith("~") || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("project sources must stay inside the project")
    }
  }
  function writeProject(directory: string, patch: Pick<ConfigExtras, "instructions" | "skills">) {
    if (patch.instructions) projectPaths(directory, patch.instructions)
    if (patch.skills?.paths) projectPaths(directory, patch.skills.paths)
    const file = path.join(directory, PROJECT_FILE)
    const existing = readObject(file)
    writeJson(file, {
      ...existing,
      ...(patch.instructions ? { instructions: patch.instructions } : {}),
      ...(patch.skills ? { skills: { ...(record(existing.skills) ? existing.skills : {}), ...patch.skills } } : {}),
    })
  }

  function mcpEntries(patch: NonNullable<RestConfig["mcp"]>, directory: string | undefined) {
    const stored = readMcpServers(mcpPath(directory))
    return Object.entries(patch).map(([name, value]) => {
      const existing = stored[name]
      let native: Native
      if (!("type" in value)) {
        if (!existing) throw new Error(`MCP server ${name} does not exist`)
        native = { ...existing, enabled: value.enabled }
      } else {
        native = restoreDeep(restMcpNative(value), existing) as Native
        if (typeof native.url === "string" && existing && typeof existing.url === "string" && native.url === maskUrl(existing.url)) native.url = existing.url
        if (JSON.stringify(native).includes(REDACTED_VALUE)) throw new Error("redacted value has nothing to restore")
      }
      return { name, config: native as McpConfigInput }
    })
  }
  async function applyPlugins(requested: readonly Plugin[], directory: string | undefined) {
    const before = pluginList(directory)
    for (const item of requested) {
      const spec = specOf(item)!
      if (!before.some((entry) => specOf(entry) !== undefined && pluginIdentity(specOf(entry)!) === pluginIdentity(spec))) await install({ dataDir: input.dir, directory: directory ?? input.dir, spec, ...(directory ? {} : { global: true }) })
    }
    const current = pluginList(directory)
    const next = requested.map((item) => {
      const found = current.find((entry) => specOf(entry) !== undefined && pluginIdentity(specOf(entry)!) === pluginIdentity(specOf(item)!))
      const options = optionsOf(item) ? restoreDeep(optionsOf(item), optionsOf(found)) as Native : optionsOf(found)
      return options ? [specOf(found ?? item)!, options] : specOf(found ?? item)!
    })
    if (JSON.stringify(next) !== JSON.stringify(current)) savePluginList(root(directory), next)
  }

  return {
    /** What is stored. Project scope reports only the project's own entries, so a read-modify-write never copies global values into the project. */
    get(directory?: string): ConfigExtras {
      const servers = Object.fromEntries(Object.entries(readMcpServers(mcpPath(directory))).flatMap(([name, server]) => { const view = mcpView(server); return view ? [[name, view]] : [] }))
      const plugins = pluginList(directory).flatMap((item) => specOf(item) ? [optionsOf(item) ? [specOf(item)!, maskDeep(optionsOf(item)) as Record<string, never>] as Plugin : specOf(item)!] : [])
      const project = directory ? readObject(path.join(directory, PROJECT_FILE)) : {}
      const server = directory ? undefined : readServer()
      return {
        ...(Object.keys(servers).length ? { mcp: servers } : {}),
        ...(plugins.length ? { plugin: plugins } : {}),
        ...(server ? { server } : {}),
        ...(Array.isArray(project.instructions) ? { instructions: project.instructions.map(String) } : {}),
        ...(record(project.skills) ? { skills: project.skills as NonNullable<ConfigExtras["skills"]> } : {}),
      }
    },
    /** Everything that can fail without side effects: run before anything is written. */
    validate(patch: ConfigExtras, directory?: string) {
      if (patch.mcp) for (const entry of mcpEntries(patch.mcp, directory)) addMcpConfig({ dir: input.dir, directory: directory ?? input.dir, name: entry.name, scope: directory ? "project" : "user", config: entry.config, replace: true, dryRun: true })
      if (patch.server) {
        const config = HttpServerConfig.parse({ ...(readServer() ?? {}), ...patch.server })
        if (config.mdns) throw new Error("mDNS is unavailable for the loopback server")
      }
      if (directory) {
        if (patch.instructions) projectPaths(directory, patch.instructions)
        if (patch.skills?.paths) projectPaths(directory, patch.skills.paths)
      }
    },
    async apply(patch: ConfigExtras, directory?: string, pending = false) {
      const change: ExtrasChange = { ...(directory ? { directory } : {}) }
      try {
        if (patch.mcp) {
          change.mcp = true
          for (const entry of mcpEntries(patch.mcp, directory)) addMcpConfig({ dir: input.dir, directory: directory ?? input.dir, name: entry.name, scope: directory ? "project" : "user", config: entry.config, replace: true, pending })
        }
        if (patch.server) writeServer(patch.server)
        if (directory && (patch.instructions || patch.skills)) writeProject(directory, patch)
        if (patch.plugin) { await applyPlugins(patch.plugin, directory); change.plugin = true }
      }
      finally { if (change.mcp || change.plugin) input.changed(change) }
    },
  }
}
export type ServerConfigExtras = ReturnType<typeof createServerConfigExtras>
