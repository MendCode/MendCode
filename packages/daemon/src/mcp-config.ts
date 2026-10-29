import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { redactSecrets, type McpConfigInput, type McpServerStatus, type RestMcpConfig } from "@mendcode/protocol"
import { serverConfigSchema } from "@mendcode/mcp"
import { mcpPendingBudget } from "./mcp-pending-budget"

/** Folder holding `mcp.json`: the project's `.mendcode`, or the daemon data directory for the user scope. */
export const mcpFolder = (input: { dir: string; directory?: string }) => input.directory ? path.join(input.directory, ".mendcode") : input.dir

/** Servers in one `mcp.json` as stored (unexpanded); a missing file has none and a corrupt one is refused. */
export function readMcpServers(file: string): Record<string, Record<string, unknown>> {
  let data: unknown
  try { data = JSON.parse(readFileSync(file, "utf8")) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw new Error("cannot read mcp.json: unreadable or invalid JSON")
  }
  const servers = (data as { servers?: unknown } | null)?.servers
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("cannot read mcp.json: expected a servers object")
  return Object.fromEntries(Object.entries(servers).filter((entry): entry is [string, Record<string, unknown>] => !!entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1])))
}

/** Donor MCP entry to the native config shape (`command` + `args`, `env`, `timeoutMs`). */
export function restMcpNative(config: RestMcpConfig): McpConfigInput {
  const { enabled, timeout } = config
  return { ...(enabled === undefined ? {} : { enabled }), ...(timeout === undefined ? {} : { timeoutMs: timeout }), ...(config.type === "local" ? { command: config.command[0]!, args: config.command.slice(1), ...(config.cwd ? { cwd: config.cwd } : {}), ...(config.environment ? { env: config.environment } : {}) } : { url: config.url, ...(config.headers ? { headers: config.headers } : {}), ...(config.oauth === undefined ? {} : { oauth: config.oauth }) }) }
}

/** Change exactly one unexpanded server entry; refuse corrupt files rather than losing other servers or fields. */
export function addMcpConfig(input: { dir: string; directory: string; name: string; scope: "user" | "project"; config: McpConfigInput; replace?: boolean | undefined; dryRun?: boolean | undefined; pending?: boolean; now?: number }) {
  const folder = input.scope === "user" ? input.dir : path.join(input.directory, ".mendcode")
  const file = path.join(folder, "mcp.json")
  let data: Record<string, unknown> = { servers: {} }
  try {
    data = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("cannot update mcp.json: unreadable or invalid JSON")
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.servers || typeof data.servers !== "object" || Array.isArray(data.servers)) throw new Error("cannot update mcp.json: expected a servers object")
  const servers = data.servers as Record<string, unknown>
  if (Object.hasOwn(servers, input.name) && !input.replace) throw new Error(`MCP server ${input.name} already exists; use --replace`)
  const config = serverConfigSchema.parse(input.config)
  const now = input.now ?? Date.now()
  const approval = input.pending ? { revision: crypto.randomUUID(), expiresAt: now + 24 * 60 * 60 * 1000, enabled: config.enabled !== false } : undefined
  const budgetKey = `${path.resolve(file)}\0${input.name}`
  mcpPendingBudget(input.dir, budgetKey, approval?.expiresAt, now, true)
  // Expiry leaves a disabled tombstone: a lower config layer must not silently reactivate this name.
  for (const [name, value] of Object.entries(servers)) {
    const entry = value as Record<string, unknown>
    if (entry?.pendingApproval && !pendingOf(entry, now)) servers[name] = { command: "(expired)", enabled: false }
  }
  if (!input.dryRun) {
    // Reserve before persisting the request: an interrupted write may waste a slot, never exceed the cap.
    if (approval) mcpPendingBudget(input.dir, budgetKey, approval.expiresAt, now)
    mkdirSync(folder, { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ ...data, servers: { ...servers, [input.name]: { ...config, ...(approval ? { enabled: false, pendingApproval: approval } : {}) } } }, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, file)
    if (!approval) mcpPendingBudget(input.dir, budgetKey, undefined, now)
  }
  return { name: input.name, scope: input.scope, path: file, writesConfig: !input.dryRun, transport: config.url ? "remote" : "local", ...(approval ? { state: "pending", expiresAt: approval.expiresAt } : {}) }
}

function pendingOf(value: unknown, now: number): { revision: string; expiresAt: number; enabled: boolean } | undefined {
  const entry = value as { pendingApproval?: { revision: string; expiresAt: number; enabled: boolean } } | undefined
  const approval = entry?.pendingApproval
  return approval && typeof approval.revision === "string" && approval.expiresAt > now ? approval : undefined
}

export function pendingMcpServers(input: { dir: string; directory: string; now?: number }): McpServerStatus[] {
  const result = new Map<string, McpServerStatus>()
  for (const scope of ["user", "project"] as const) {
    const file = path.join(scope === "user" ? input.dir : path.join(input.directory, ".mendcode"), "mcp.json")
    for (const [name, config] of Object.entries(readMcpServers(file))) {
      result.delete(name)
      const approval = pendingOf(config, input.now ?? Date.now())
      if (!approval) continue
      const mask = (value: string) => redactSecrets(value).text.replace(/[\x00-\x1f\x7f]/g, " ")
      const sensitive = /secret|token|password|passwd|api.?key|authorization|credential|cookie|bearer/i
      const args = (Array.isArray(config.args) ? config.args.map(String) : []).map((value, index, all) => sensitive.test(all[index - 1] ?? "") && (all[index - 1] ?? "").startsWith("-") || value.includes("=") && sensitive.test(value.split("=")[0]!) ? "[redacted]" : mask(value))
      const url = config.url ? new URL(String(config.url)) : undefined
      if (url) {
        url.username = ""
        url.password = ""
        for (const name of [...url.searchParams.keys()]) if (sensitive.test(name)) url.searchParams.set(name, "[redacted]")
      }
      const details = url ? [`URL: ${mask(url.href)}`] : [
        `command: ${mask(JSON.stringify(config.command))}`,
        `args: ${JSON.stringify(args)}`,
        `env names: ${Object.keys((config.env ?? {}) as object).map(mask).join(", ") || "none"}`,
        ...(config.cwd ? [`cwd: ${mask(String(config.cwd))}`] : []),
      ]
      result.set(name, { name, command: "pending approval", enabled: false, state: "stopped", tools: 0, stderr: [], pending: { revision: approval.revision, expiresAt: approval.expiresAt, scope, details } })
    }
  }
  return [...result.values()]
}

export function decideMcpConfig(input: { dir: string; directory: string; server: string; scope: "user" | "project"; revision: string; approve: boolean; now?: number }) {
  const file = path.join(input.scope === "user" ? input.dir : path.join(input.directory, ".mendcode"), "mcp.json")
  const config = readMcpServers(file)[input.server]
  const approval = pendingOf(config, input.now ?? Date.now())
  if (!config || !approval || approval.revision !== input.revision) throw new Error("MCP pending request expired or changed; refresh before approving")
  return addMcpConfig({ ...input, name: input.server, config: input.approve ? { ...config, enabled: approval.enabled } as McpConfigInput : { command: "(rejected)", enabled: false }, replace: true })
}
