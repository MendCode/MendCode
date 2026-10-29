import path from "node:path"
import { expandVariables, serverConfigSchema, type McpServerConfig } from "@mendcode/mcp"
import type { ExtensionMcpServer } from "@mendcode/extension-api"
import type { ExtensionRecord } from "./types"

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Why `registerMcpServer` refuses this entry, or undefined: the same checks as an `mcp.json` server. */
export function mcpServerProblem(name: unknown, server: unknown): string | undefined {
  if (typeof name !== "string" || !SERVER_NAME.test(name) || name.includes("__")) return "registerMcpServer: a name of letters, digits, _ and - (max 64, no __)"
  const parsed = serverConfigSchema.safeParse(server)
  if (!parsed.success) return `registerMcpServer: ${name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ").slice(0, 300)}`
  return undefined
}

/** `${VAR}` expanded from the daemon's environment, like mcp.json, so a token can stay out of the module. */
function expanded(server: ExtensionMcpServer, base: string, env: Record<string, string | undefined>): McpServerConfig {
  const value = (text: string) => expandVariables({ value: text, env })
  const parsed = serverConfigSchema.parse(server) as McpServerConfig
  return {
    ...parsed,
    ...(parsed.command !== undefined ? { command: value(parsed.command) } : {}),
    ...(parsed.url !== undefined ? { url: value(parsed.url) } : {}),
    ...(parsed.args ? { args: parsed.args.map(value) } : {}),
    ...(parsed.env ? { env: Object.fromEntries(Object.entries(parsed.env).map(([key, entry]) => [key, value(entry)])) } : {}),
    ...(parsed.headers ? { headers: Object.fromEntries(Object.entries(parsed.headers).map(([key, entry]) => [key, value(entry)])) } : {}),
    ...(parsed.cwd !== undefined ? { cwd: path.resolve(base, value(parsed.cwd)) } : {}),
  }
}

/**
 * The servers the loaded extensions of `directory` register, as config entries (a later layer wins a name). A project extension's
 * server is a project server (`scope: "project"`: started with a credential-filtered environment, like one in the project's mcp.json).
 */
export function extensionMcpServers(records: readonly ExtensionRecord[], directory: string, env: Record<string, string | undefined> = process.env): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {}
  for (const record of records) {
    if (record.disabled) continue
    for (const [name, server] of record.mcpServers ?? []) servers[name] = { ...expanded(server, directory, env), ...(record.layer === "project" ? { scope: "project" as const } : {}) }
  }
  return servers
}
