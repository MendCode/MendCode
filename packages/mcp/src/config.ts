import { readFileSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { defaultLayers, type ExtensionLayer } from "@mendcode/packages"
import { z } from "zod"

export const DEFAULT_SERVER_TIMEOUT_MS = 30_000

const oauthSchema = z.union([
  z.literal(false),
  z.object({
    /** A client registered by hand; without one, the client registers itself when the server supports it (RFC 7591). */
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    /** Overrides the scope the server asks for. */
    scope: z.string().min(1).optional(),
    callbackPort: z.number().int().min(1).max(65535).optional(),
    redirectUri: z.string().refine((value) => {
      try {
        const url = new URL(value)
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash
      } catch { return false }
    }, "must be an HTTP(S) callback URL without credentials or fragment").optional(),
  }),
])

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * A local server (`command`, run over stdio) or a remote one (`url`, streamable HTTP or legacy SSE). A remote server
 * that answers 401 is authorized with OAuth unless `oauth` is `false`; `headers` (e.g. an API key) are sent on every request.
 */
export const serverConfigSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().min(1).max(600_000).optional(),
    url: z.string().refine(isHttpUrl, "must be an http(s) URL").optional(),
    /** "http" (streamable HTTP) or "sse" (legacy HTTP+SSE); by default streamable HTTP with a fallback to SSE. */
    transport: z.enum(["http", "sse"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    oauth: oauthSchema.optional(),
    /** `false`: the client does not announce elicitation, so this server cannot ask the user for input mid-call. */
    elicitation: z.boolean().optional(),
  })
  .refine((server) => (server.command === undefined) !== (server.url === undefined), {
    message: "set exactly one of command (local server) or url (remote server)",
  })

export type McpServerConfig = z.infer<typeof serverConfigSchema> & {
  /** Set by the loader, never read from a file: a project's server (its `.mendcode/mcp.json` or a project package's) starts with a credential-filtered environment. */
  scope?: "project"
}

/** The URL of a remote server with credentials and query removed, safe to show and to log. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`
  } catch {
    return "(invalid url)"
  }
}

/** A problem found while loading or running MCP servers; reported, never thrown. */
export type McpIssue = { source: string; server?: string; message: string }

/** A project server that is declared but must not start, connect or be listed as running until the project is trusted. */
export type McpBlockedServer = { name: string; command: string; transport?: "remote"; source: string }

export type LoadedMcpConfig = { servers: Record<string, McpServerConfig>; errors: McpIssue[]; blocked?: McpBlockedServer[] }

/** What the user is shown for a server that is not started: nothing expanded, no secret (argument values after `=` and URL queries are masked). */
function blockedCommand(config: McpServerConfig): string {
  if (config.url !== undefined) return displayUrl(config.url)
  const args = (config.args ?? []).map((arg) => (arg.indexOf("=") > 0 ? `${arg.slice(0, arg.indexOf("=") + 1)}***` : arg))
  return [config.command, ...args].join(" ")
}

const fileSchema = z.object({ servers: z.record(z.string(), z.unknown()) })

/** `${VAR}`, or `{env:VAR}` (MendCode v1's and opencode's spelling, which packages may use too). */
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

/** `{file:path}` (v1's and opencode's spelling): a file's text, for a token kept in its own file. */
const FILE_REFERENCE = /\{file:([^}]+)\}/g
const MAX_REFERENCED_BYTES = 64 * 1024

/**
 * Expand `${VAR}` and `{env:VAR}` from `env`; unknown variables become empty so secrets never need to live in files. With
 * `files`, `{file:path}` becomes that file's text without the final newline (`~/` is the home folder, a relative path starts at
 * `files.base`); a missing or oversized file becomes empty and is named in `files.missing`.
 */
export function expandVariables({ value, env, files }: { value: string; env: Record<string, string | undefined>; files?: { base: string; missing: string[] } }): string {
  const expanded = value.replace(VARIABLE, (_, dollar: string | undefined, braced: string | undefined) => env[(dollar ?? braced)!] ?? "")
  if (!files) return expanded
  return expanded.replace(FILE_REFERENCE, (_, reference: string) => {
    const target = reference.startsWith("~/") ? join(homedir(), reference.slice(2)) : resolve(files.base, reference)
    try {
      if (statSync(target).size > MAX_REFERENCED_BYTES) throw new Error("too large")
      return readFileSync(target, "utf8").replace(/\r?\n$/, "")
    } catch {
      files.missing.push(reference)
      return ""
    }
  })
}

function expandServer({ config, env, base, files }: { config: McpServerConfig; env: Record<string, string | undefined>; base: string; files?: { base: string; missing: string[] } }): McpServerConfig {
  const expand = (value: string) => expandVariables({ value, env, ...(files ? { files } : {}) })
  const result: McpServerConfig = {}
  if (config.command !== undefined) result.command = expand(config.command)
  if (config.url !== undefined) result.url = expand(config.url)
  if (config.transport !== undefined) result.transport = config.transport
  if (config.headers) result.headers = Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, expand(value)]))
  if (config.oauth === false) result.oauth = false
  else if (config.oauth) {
    result.oauth = {
      ...(config.oauth.clientId !== undefined ? { clientId: expand(config.oauth.clientId) } : {}),
      ...(config.oauth.clientSecret !== undefined ? { clientSecret: expand(config.oauth.clientSecret) } : {}),
      ...(config.oauth.scope !== undefined ? { scope: config.oauth.scope } : {}),
      ...(config.oauth.callbackPort !== undefined ? { callbackPort: config.oauth.callbackPort } : {}),
      ...(config.oauth.redirectUri !== undefined ? { redirectUri: config.oauth.redirectUri } : {}),
    }
  }
  if (config.args) result.args = config.args.map(expand)
  if (config.env) result.env = Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, expand(value)]))
  if (config.cwd !== undefined) {
    const cwd = expand(config.cwd)
    result.cwd = isAbsolute(cwd) ? cwd : resolve(base, cwd)
  }
  if (config.enabled !== undefined) result.enabled = config.enabled
  if (config.timeoutMs !== undefined) result.timeoutMs = config.timeoutMs
  return result
}

async function readServers({ path, base, env, project, trusted, fileReferences }: { path: string; base: string; env: Record<string, string | undefined>; project: boolean; trusted: boolean; fileReferences: boolean }): Promise<Required<LoadedMcpConfig>> {
  const servers: Record<string, McpServerConfig> = {}
  const blocked: McpBlockedServer[] = []
  const errors: McpIssue[] = []
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push({ source: path, message: `cannot read file: ${(error as Error).message}` })
    return { servers, errors, blocked }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    errors.push({ source: path, message: `invalid JSON: ${(error as Error).message}` })
    return { servers, errors, blocked }
  }
  const file = fileSchema.safeParse(json)
  if (!file.success) {
    errors.push({ source: path, message: 'expected { "servers": { "<name>": { ... } } }' })
    return { servers, errors, blocked }
  }
  for (const [name, raw] of Object.entries(file.data.servers)) {
    // Preserve the name as a disabled tombstone across layers, without exposing submitted secrets in status.
    if (raw && typeof raw === "object" && "pendingApproval" in raw) {
      servers[name] = { command: "(pending approval)", enabled: false }
      continue
    }
    const parsed = serverConfigSchema.safeParse(raw)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")
      errors.push({ source: path, server: name, message: `invalid server config: ${issues}` })
      continue
    }
    // Nothing of an untrusted project's server is expanded, started or contacted: it is only named, so the user can see what trust would start.
    if (project && !trusted && parsed.data.enabled !== false) {
      blocked.push({ name, command: blockedCommand(parsed.data), ...(parsed.data.url !== undefined ? { transport: "remote" as const } : {}), source: path })
      continue
    }
    // `{file:}` reads only from the user's own and a trusted project's own file, never a package's: a package could send the user's files away.
    const files = fileReferences ? { base: dirname(path), missing: [] as string[] } : undefined
    servers[name] = { ...expandServer({ config: parsed.data, env, base, ...(files ? { files } : {}) }), ...(project ? { scope: "project" as const } : {}) }
    if (files?.missing.length) errors.push({ source: path, server: name, message: `{file:} not readable (missing, or over ${MAX_REFERENCED_BYTES / 1024} KB): ${files.missing.join(", ")}` })
  }
  return { servers, errors, blocked }
}

/** User config first, then project config on top: the project wins per server name. */
export async function loadMcpConfig({
  directory,
  userDir,
  env = process.env,
  layers = defaultLayers({ userDir, directory }),
  trusted = true,
}: {
  directory: string
  userDir: string
  env?: Record<string, string | undefined>
  /** Each layer's `mcp.json`, lowest precedence first; a later layer's server replaces one of the same name. */
  layers?: ExtensionLayer[]
  /**
   * Whether the project is trusted. An untrusted project's servers (its own file and its packages') come back in
   * `blocked`, not in `servers`; user servers are unaffected. Every caller that knows the project's trust passes it.
   */
  trusted?: boolean
}): Promise<LoadedMcpConfig> {
  // A package's servers run what it ships: `${PACKAGE_DIR}` and a relative cwd point into the package.
  const loaded = await Promise.all(
    layers.map((layer) =>
      readServers({ path: join(layer.dir, "mcp.json"), base: layer.pkg ? layer.dir : directory, env: layer.pkg ? { ...env, PACKAGE_DIR: layer.dir } : env, project: layer.source === "project", trusted, fileReferences: !layer.pkg }),
    ),
  )
  // A later layer owns a name, even as a blocked one: an untrusted project cannot leave a user server of that name running under it.
  const servers: Record<string, McpServerConfig> = {}
  const blocked = new Map<string, McpBlockedServer>()
  for (const layer of loaded) {
    for (const [name, server] of Object.entries(layer.servers)) { servers[name] = server; blocked.delete(name) }
    for (const server of layer.blocked) { delete servers[server.name]; blocked.set(server.name, server) }
  }
  return { servers, errors: loaded.flatMap((l) => l.errors), ...(blocked.size ? { blocked: [...blocked.values()] } : {}) }
}
