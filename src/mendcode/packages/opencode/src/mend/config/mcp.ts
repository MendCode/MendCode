import { existsSync } from "fs"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { Glob } from "@mendcode/core/util/glob"
import { ConfigMCP } from "@/config/mcp"
import { ConfigParse } from "@/config/parse"
import { mendPaths } from "./paths"

export type MendMcpServer = ConfigMCP.Info

export type MendMcpReadResult = {
  root: string
  dir: string
  files: string[]
  servers: Record<string, MendMcpServer>
  warnings: string[]
  failures: string[]
  secretsIncluded: false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function serverNameFromFile(file: string) {
  return path.basename(file).replace(/\.(jsonc?|JSONC?)$/, "")
}

function secretLike(value: string) {
  if (value.startsWith("$") || value.startsWith("${")) return false
  return value.length >= 16 && /[A-Za-z]/.test(value) && /\d/.test(value)
}

function scanSecrets(serverName: string, server: MendMcpServer) {
  const failures: string[] = []
  const check = (label: string, values: Record<string, string> | undefined) => {
    for (const [key, value] of Object.entries(values || {})) {
      if (/token|secret|key|authorization|password/i.test(key) && secretLike(value)) {
        failures.push(`${serverName}.${label}.${key} looks like an inline secret; use an environment reference or .mendcode/auth/mcp instead`)
      }
    }
  }
  if (server.type === "local") check("environment", server.environment)
  if (server.type === "remote") {
    check("headers", server.headers)
    if (server.oauth && server.oauth !== false && server.oauth.clientSecret && secretLike(server.oauth.clientSecret)) {
      failures.push(`${serverName}.oauth.clientSecret looks like an inline secret; store it outside shared MCP config`)
    }
  }
  return failures
}

function parseMcpFile(data: unknown, file: string): Record<string, MendMcpServer> {
  if (!isRecord(data)) throw new Error(`MCP file must be an object: ${file}`)
  if (typeof data.type === "string") {
    return { [serverNameFromFile(file)]: ConfigParse.effectSchema(ConfigMCP.Info, data, file) }
  }
  const out: Record<string, MendMcpServer> = {}
  for (const [name, value] of Object.entries(data)) {
    out[name] = ConfigParse.effectSchema(ConfigMCP.Info, value, `${file}:${name}`)
  }
  return out
}

export async function readMendMcpConfig(root?: string): Promise<MendMcpReadResult> {
  const paths = mendPaths(root)
  if (!existsSync(paths.mcpDir)) {
    return {
      root: paths.root,
      dir: path.relative(paths.root, paths.mcpDir),
      files: [],
      servers: {},
      warnings: [],
      failures: [],
      secretsIncluded: false,
    }
  }

  const matches = (await Glob.scan("**/*.{json,jsonc}", {
    cwd: paths.mcpDir,
    absolute: true,
    dot: true,
    symlink: true,
  })).sort()
  const servers: Record<string, MendMcpServer> = {}
  const warnings: string[] = []
  const failures: string[] = []

  for (const file of matches) {
    try {
      const parsed = ConfigParse.jsonc(await readFile(file, "utf8"), file)
      const next = parseMcpFile(parsed, file)
      for (const [name, server] of Object.entries(next)) {
        if (servers[name]) warnings.push(`MCP server ${name} is defined more than once; later file wins`)
        servers[name] = server
        failures.push(...scanSecrets(name, server))
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }

  return {
    root: paths.root,
    dir: path.relative(paths.root, paths.mcpDir),
    files: matches.map((file) => path.relative(paths.root, file)),
    servers,
    warnings,
    failures,
    secretsIncluded: false,
  }
}

export async function writeMendMcpServer(name: string, server: MendMcpServer, root?: string) {
  const paths = mendPaths(root)
  const parsed = ConfigParse.effectSchema(ConfigMCP.Info, server, `.mendcode/mcp/${name}.json`)
  const failures = scanSecrets(name, parsed)
  if (failures.length) throw new Error(failures.join("\n"))
  const target = path.join(paths.mcpDir, `${name}.json`)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(parsed, null, 2)}\n`)
  return {
    ok: true,
    path: path.relative(paths.root, target),
    name,
    secretsIncluded: false,
  }
}

export async function mendMcpStatus(root?: string) {
  const result = await readMendMcpConfig(root)
  return {
    ok: result.failures.length === 0,
    dir: result.dir,
    files: result.files.length,
    servers: Object.keys(result.servers).sort(),
    warnings: result.warnings,
    failures: result.failures,
    projectsToGeneratedConfig: true,
    authDirPolicy: ".mendcode/auth/mcp is local-only and never exported",
    secretsIncluded: false,
  }
}
