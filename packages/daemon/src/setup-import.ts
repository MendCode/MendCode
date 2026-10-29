import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { serverConfigSchema } from "@mendcode/mcp"
import { redactSecrets, type McpConfigInput, type SetupImportItem, type SetupImportReport } from "@mendcode/protocol"
import { setupImportKey } from "@mendcode/protocol/wire"
import { addMcpConfig, readMcpServers } from "./mcp-config"
import { defaultHomes, readRegular, type ForeignHomes } from "./session-import-source"

/**
 * `/import setup`: takes over what another agent's setup holds that MendCode does not already read in place. Skills,
 * commands and agents of `.claude`, and a project's CLAUDE.md or AGENTS.md, need no copy. What it copies: MCP servers
 * (Claude Code `.claude.json` / `.mcp.json`, Codex `config.toml`), Codex prompts (as commands) and the global
 * instructions file. A preview is the default; `apply` writes, never over an entry that exists, and no secret value is
 * ever copied: an env var or header that holds one becomes a `${NAME}` reference and the server is imported disabled.
 */
export type SetupHomes = Required<ForeignHomes> & { claudeJson: string }
/** `only`: with `apply`, write just the items whose `setupImportKey` is listed (absent: every new item, empty: none). */
export type SetupImportInput = { directory: string; from: "auto" | "claude-code" | "codex"; apply: boolean; only?: readonly string[] | undefined }

/** Whether `apply` writes this item: always without a selection, else only when its key was chosen. */
const chosen = (input: SetupImportInput, item: SetupImportItem) => input.apply && (!input.only || input.only.includes(setupImportKey(item)))

export function defaultSetupHomes(env: NodeJS.ProcessEnv = process.env): SetupHomes {
  const claudeDir = env.CLAUDE_CONFIG_DIR?.trim()
  return { ...defaultHomes(env), claudeJson: path.join(claudeDir || os.homedir(), ".claude.json") }
}

type Json = Record<string, unknown>
type Tool = "claude-code" | "codex"
type Scope = "user" | "project"
type Candidate = { name: string; tool: Tool; scope: Scope; raw: Json }
type Converted = { config: McpConfigInput; needs: string[]; skip?: undefined } | { skip: string }

const CONFIG_MAX = 16 * 1024 * 1024
const SERVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/
const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]{0,60}$/
const SECRET_KEY = /key|token|secret|passw|auth|credential|bearer|cookie|signature/i
const VARIABLE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g
const DEFAULTED = /\$\{([A-Za-z_][A-Za-z0-9_]*):-[^}]*\}/g

const obj = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined
const str = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined
const strings = (value: unknown) => Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value as string[] : undefined
const stringMap = (value: unknown): Record<string, string> => Object.fromEntries(Object.entries(obj(value) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
const hasSecret = (text: string) => redactSecrets(text).count > 0
const refName = (...parts: string[]) => parts.join("_").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "MCP_VALUE"

/** One env or header value: a `${NAME}` reference or a plain value stays; anything that looks like a credential becomes a reference. */
function safeValue({ key, value, reference, needs }: { key: string; value: string; reference: string; needs: string[] }): string {
  const normalized = value.replace(DEFAULTED, "${$1}")
  const literal = normalized.replace(VARIABLE, "").trim()
  const bareScheme = /^(bearer|basic|token)$/i.test(literal)
  if (!hasSecret(literal) && (literal === "" || bareScheme || !SECRET_KEY.test(key))) return normalized
  needs.push(reference)
  return `\${${reference}}`
}

const literalValue = (value: string) => value.replace(DEFAULTED, "").replace(VARIABLE, "").trim() !== ""

/** `--password hunter2` or `--api-key=hunter2`: a flag whose name says credential, given a literal value (not a `${NAME}` reference); pattern matching alone cannot see these. */
function flagCarriesValue(args: string[]): boolean {
  return args.some((arg, index) => {
    const joined = /^(--?[A-Za-z0-9][\w-]*)=(.*)$/s.exec(arg)
    if (joined) return SECRET_KEY.test(joined[1]!) && literalValue(joined[2]!)
    const next = args[index + 1]
    return /^--?[A-Za-z0-9][\w-]*$/.test(arg) && SECRET_KEY.test(arg) && next !== undefined && !next.startsWith("-") && literalValue(next)
  })
}

function safeUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url.replace(VARIABLE, "x"))
    if (parsed.username || parsed.password) return undefined
    for (const [name, value] of parsed.searchParams) if (SECRET_KEY.test(name) || hasSecret(value)) return undefined
    return url.replace(DEFAULTED, "${$1}")
  } catch { return undefined }
}

function convert({ name, tool, raw }: Candidate): Converted {
  const needs: string[] = []
  const command = str(raw.command)
  const rawUrl = str(raw.url)
  if (command === undefined && rawUrl === undefined) return { skip: "no command or url" }
  const type = str(raw.type)
  if (type !== undefined && !["stdio", "http", "sse", "streamable_http"].includes(type)) return { skip: `unsupported type ${type}` }
  const config: McpConfigInput = {}
  if (command !== undefined && rawUrl === undefined) {
    const args = strings(raw.args) ?? []
    if (hasSecret(command) || args.some(hasSecret) || flagCarriesValue(args)) return { skip: "command or arguments carry a credential; add the server by hand with ${NAME} references" }
    config.command = command
    if (args.length) config.args = args
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(stringMap(raw.env))) env[key] = safeValue({ key, value, reference: key, needs })
    for (const key of strings(raw.env_vars) ?? []) env[key] = `\${${key}}`
    if (Object.keys(env).length) config.env = env
    const cwd = str(raw.cwd)
    if (cwd) config.cwd = cwd
  } else if (rawUrl !== undefined) {
    const url = safeUrl(rawUrl)
    if (!url) return { skip: "url carries credentials; add the server by hand with ${NAME} references" }
    config.url = url
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries({ ...stringMap(raw.headers), ...stringMap(raw.http_headers) })) headers[key] = safeValue({ key, value, reference: refName(name, key), needs })
    for (const [key, variable] of Object.entries(stringMap(raw.env_http_headers))) headers[key] = `\${${variable}}`
    const bearer = str(raw.bearer_token_env_var)
    if (bearer && tool === "codex") headers.Authorization = `Bearer \${${bearer}}`
    if (Object.keys(headers).length) config.headers = headers
  }
  const seconds = typeof raw.tool_timeout_sec === "number" ? raw.tool_timeout_sec : undefined
  if (seconds !== undefined && seconds > 0) config.timeoutMs = Math.min(600_000, Math.max(1, Math.round(seconds * 1000)))
  if (raw.enabled === false || needs.length) config.enabled = false
  return { config, needs: [...new Set(needs)] }
}

async function readJson(file: string): Promise<Json | undefined> {
  try { return obj(JSON.parse((await readRegular(file, CONFIG_MAX)).text)) } catch { return undefined }
}

async function readToml(file: string): Promise<Json | undefined> {
  try { return obj(Bun.TOML.parse((await readRegular(file, CONFIG_MAX)).text)) } catch { return undefined }
}

const entries = (value: unknown, tool: Tool, scope: Scope): Candidate[] => Object.entries(obj(value) ?? {}).flatMap(([name, raw]) => obj(raw) ? [{ name, tool, scope, raw: raw as Json }] : [])

/** Markdown files under `dir` (two levels deep at most), without following links. */
const countMarkdown = (dir: string, depth = 0): number => {
  try {
    return readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
      if (entry.isSymbolicLink()) return total
      if (entry.isDirectory()) return total + (depth < 2 ? countMarkdown(path.join(dir, entry.name), depth + 1) : 0)
      return total + (entry.isFile() && entry.name.endsWith(".md") ? 1 : 0)
    }, 0)
  } catch { return 0 }
}

/** Skill folders: the direct subfolders holding a SKILL.md. */
const countSkills = (dir: string): number => {
  try { return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, "SKILL.md"))).length } catch { return 0 }
}

const tilde = (file: string) => { const home = os.homedir(); return file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file }
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

export function createSetupImport(ctx: { dir: string; homes?: Partial<SetupHomes> | undefined }) {
  const homes = (): SetupHomes => ({ ...defaultSetupHomes(), ...ctx.homes })

  async function run(input: SetupImportInput): Promise<SetupImportReport> {
    const root = path.resolve(input.directory)
    const where = homes()
    const wantClaude = input.from !== "codex"
    const wantCodex = input.from !== "claude-code"
    const found: SetupImportReport["found"] = []
    const items: SetupImportItem[] = []
    const candidates: Candidate[] = []
    const note = (file: string, tool: Tool) => found.push({ tool, file: tilde(file) })

    if (wantClaude) {
      const user = await readJson(where.claudeJson)
      if (user) {
        note(where.claudeJson, "claude-code")
        candidates.push(...entries(user.mcpServers, "claude-code", "user"), ...entries(obj(obj(user.projects)?.[root])?.mcpServers, "claude-code", "project"))
      }
      const project = await readJson(path.join(root, ".mcp.json"))
      if (project) { note(path.join(root, ".mcp.json"), "claude-code"); candidates.push(...entries(project.mcpServers, "claude-code", "project")) }
    }
    if (wantCodex) {
      const user = await readToml(path.join(where.codex, "config.toml"))
      if (user) { note(path.join(where.codex, "config.toml"), "codex"); candidates.push(...entries(user.mcp_servers, "codex", "user")) }
      const project = await readToml(path.join(root, ".codex", "config.toml"))
      if (project) { note(path.join(root, ".codex", "config.toml"), "codex"); candidates.push(...entries(project.mcp_servers, "codex", "project")) }
    }

    const files = new Map<Scope, { file: string; servers: Record<string, unknown> | undefined }>()
    for (const scope of ["user", "project"] as const) {
      const file = path.join(scope === "user" ? ctx.dir : path.join(root, ".mendcode"), "mcp.json")
      let servers: Record<string, unknown> | undefined
      try { servers = readMcpServers(file) } catch { servers = undefined }
      files.set(scope, { file, servers })
    }
    const taken = new Set<string>()
    for (const candidate of candidates) {
      const name = candidate.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "").slice(0, 100)
      const base: SetupImportItem = { kind: "mcp", name: name || candidate.name.slice(0, 100), tool: candidate.tool, scope: candidate.scope, status: "new" }
      const target = files.get(candidate.scope)!
      if (!SERVER_NAME.test(name)) { items.push({ ...base, status: "skipped", note: "name cannot be used" }); continue }
      if (!target.servers) { items.push({ ...base, status: "skipped", note: "the MendCode mcp.json is unreadable; fix it first" }); continue }
      if (Object.hasOwn(target.servers, name) || taken.has(`${candidate.scope}:${name}`)) { items.push({ ...base, status: "exists", note: "kept the MendCode entry" }); continue }
      const converted = convert({ ...candidate, name })
      if (converted.skip !== undefined) { items.push({ ...base, status: "skipped", note: converted.skip }); continue }
      const valid = serverConfigSchema.safeParse(converted.config)
      if (!valid.success) { items.push({ ...base, status: "skipped", note: "not a valid MCP server entry" }); continue }
      taken.add(`${candidate.scope}:${name}`)
      const item: SetupImportItem = { ...base, enabled: converted.config.enabled !== false, ...(converted.needs.length ? { needs: converted.needs, note: "imported disabled: set the variables, then enable it" } : {}) }
      if (chosen(input, item)) {
        try {
          addMcpConfig({ dir: ctx.dir, directory: root, name, scope: candidate.scope, config: converted.config })
          item.status = "imported"
        } catch (error) { item.status = "failed"; item.note = (error as Error).message.slice(0, 200) }
      }
      items.push(item)
    }

    if (wantCodex) await commands({ input, items, where })
    await instructions({ input, items, where, wantClaude, wantCodex })

    const inPlace: string[] = []
    if (wantClaude) {
      for (const [label, base] of [["~/.claude", where.claude], [".claude", path.join(root, ".claude")]] as const) {
        const skills = countSkills(path.join(base, "skills"))
        const commandFiles = countMarkdown(path.join(base, "commands"))
        const agents = countMarkdown(path.join(base, "agents"))
        if (skills + commandFiles + agents > 0) inPlace.push(`${label}: ${[skills ? plural(skills, "skill") : "", commandFiles ? plural(commandFiles, "command") : "", agents ? plural(agents, "agent") : ""].filter(Boolean).join(", ")} (read where they are)`)
      }
      if (["CLAUDE.md", "AGENTS.md"].some((name) => existsSync(path.join(root, name)))) inPlace.push("project CLAUDE.md / AGENTS.md (read where they are)")
    }
    const notImported: string[] = []
    if (found.length || inPlace.length) notImported.push("permission rules and approvals (review them in /permissions)", "hooks, model and provider settings", "login tokens and API keys (use /connect)")
    if (wantCodex && existsSync(path.join(where.codex, "skills"))) notImported.push("Codex skills (copy a skill folder into .agents/skills to use it)")
    return { applied: input.apply, found, items, inPlace, notImported }
  }

  /** Codex prompts become user commands; one that uses inline shell stays behind. */
  async function commands({ input, items, where }: { input: SetupImportInput; items: SetupImportItem[]; where: SetupHomes }) {
    const folder = path.join(where.codex, "prompts")
    let names: string[]
    try { names = readdirSync(folder).filter((name) => name.endsWith(".md")).sort().slice(0, 100) } catch { return }
    for (const file of names) {
      const name = file.slice(0, -3).toLowerCase()
      const base: SetupImportItem = { kind: "command", name, tool: "codex", scope: "user", status: "new" }
      if (!COMMAND_NAME.test(name)) { items.push({ ...base, status: "skipped", note: "name cannot be used" }); continue }
      let text: string
      try { text = (await readRegular(path.join(folder, file), 64_000)).text } catch { items.push({ ...base, status: "skipped", note: "unreadable or too large" }); continue }
      if (text.includes("!`")) { items.push({ ...base, status: "skipped", note: "uses inline shell; copy it by hand after review" }); continue }
      const target = path.join(ctx.dir, "commands", `${name}.md`)
      if (existsSync(target)) { items.push({ ...base, status: "exists", note: "kept the MendCode command" }); continue }
      if (chosen(input, base)) {
        try {
          mkdirSync(path.dirname(target), { recursive: true })
          writeFileSync(target, text, { flag: "wx", mode: 0o600 })
          base.status = "imported"
        } catch (error) { base.status = "failed"; base.note = (error as Error).message.slice(0, 200) }
      }
      items.push(base)
    }
  }

  /** The global instructions file: the first tool found fills `<data dir>/AGENTS.md` when it is not there yet. */
  async function instructions({ input, items, where, wantClaude, wantCodex }: { input: SetupImportInput; items: SetupImportItem[]; where: SetupHomes; wantClaude: boolean; wantCodex: boolean }) {
    const target = path.join(ctx.dir, "AGENTS.md")
    const sources: Array<{ tool: Tool; file: string }> = [
      ...(wantClaude ? [{ tool: "claude-code" as const, file: path.join(where.claude, "CLAUDE.md") }] : []),
      ...(wantCodex ? [{ tool: "codex" as const, file: path.join(where.codex, "AGENTS.md") }] : []),
    ]
    let claimed = false
    for (const source of sources) {
      let text: string
      try { text = (await readRegular(source.file, 256 * 1024)).text } catch { continue }
      if (!text.trim()) continue
      const base: SetupImportItem = { kind: "instructions", name: "AGENTS.md", tool: source.tool, scope: "user", status: "new" }
      if (existsSync(target)) { items.push({ ...base, status: "exists", note: "kept the MendCode global instructions" }); break }
      if (claimed) { items.push({ ...base, status: "skipped", note: `use /import setup ${source.tool} to take these instead` }); continue }
      claimed = true
      if (chosen(input, base)) {
        try {
          mkdirSync(ctx.dir, { recursive: true })
          writeFileSync(target, text, { flag: "wx", mode: 0o600 })
          base.status = "imported"
        } catch (error) { base.status = "failed"; base.note = (error as Error).message.slice(0, 200) }
      }
      items.push(base)
    }
  }

  return { run }
}
