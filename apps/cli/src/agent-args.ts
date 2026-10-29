import { AGENT_CREATE_NAME, AGENT_CREATE_PERMISSIONS } from "@mendcode/protocol/wire"
import type { Common, ParseResult } from "./automation"
import { COMPAT } from "./compat"
import { PROGRAM_NAME } from "@mendcode/program"

export type AgentAutomation =
  | { kind: "agent.list" }
  | { kind: "agent.create"; path?: string; description?: string; name?: string; mode?: "all" | "primary" | "subagent"; permissions?: string[]; model?: string; generate?: boolean }
  | { kind: "agent.debug"; name: string; tool?: string; params?: Record<string, unknown> }

export const AGENT_USAGE = `usage: ${PROGRAM_NAME} agent list\n  agent create [--path DIR] [--description TEXT] [--mode all|primary|subagent]\n    [--permissions bash,read,edit,glob,grep,webfetch,task,todowrite,websearch,lsp,skill] [--model provider/model | -m provider/model] [--name NAME]\n    [--generate]  (the model writes name, when-to-use text and prompt; falls back to the plain template)\n  debug agent <name> [--tool ID] [--params JSON]\n  --dir D | --data-dir D  --json | --format json`
const VALUES = new Set(["dir", "data-dir", "engine", "format", "compat", "path", "description", "mode", "permissions", "tools", "model", "name", "tool", "params"])
const COMMON = ["dir", "data-dir", "engine", "format", "compat", "json", "help"]

export function parseAgent(argv: string[]): ParseResult | undefined {
  const words: string[] = []
  const flags = new Map<string, string | true>()
  let error: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] === "-m" ? "--model" : argv[index]!
    if (token === "--") { words.push(...argv.slice(index + 1)); break }
    if (!token.startsWith("-")) { words.push(token); continue }
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2)
    if (["help", "json", "generate"].includes(name!)) {
      if (inline !== undefined && !["true", "false"].includes(inline)) error ??= `--${name} needs true|false`
      if (inline !== "false") flags.set(name!, true)
    } else if (VALUES.has(name!)) {
      const value = inline ?? argv[++index]
      if (value === undefined || value.startsWith("--")) error ??= `--${name} needs a value`
      else flags.set(name!, value)
    } else error ??= `unknown flag ${token}`
  }
  if (words[0] !== "agent" && !(words[0] === "debug" && words[1] === "agent")) return undefined
  const bad = (message: string): ParseResult => ({ ok: false, topic: "agent", message })
  if (error) return bad(error)
  if (flags.has("help")) return { ok: true, command: { kind: "help", topic: "agent", json: false } }
  const str = (key: string) => typeof flags.get(key) === "string" ? String(flags.get(key)) : undefined
  if (str("format") && !["text", "json", "table"].includes(str("format")!)) return bad("--format needs text|json|table")
  if (str("compat") && str("compat") !== COMPAT) return bad(`--compat must be ${COMPAT}`)
  if (flags.has("dir") && !str("dir") || flags.has("data-dir") && !str("data-dir")) return bad("Data directory cannot be empty")
  const common: Common = { json: flags.has("json") || str("format") === "json" || !!str("compat"), ...(str("data-dir") ?? str("dir") ? { dir: str("data-dir") ?? str("dir")! } : {}), ...(str("compat") ? { compat: COMPAT } : {}) }
  const debug = words[0] === "debug"
  const operation = debug ? "debug" : words[1]
  const allowed = [...COMMON, ...(operation === "create" ? ["path", "description", "mode", "permissions", "tools", "model", "name", "generate"] : debug ? ["tool", "params"] : [])]
  for (const key of flags.keys()) if (!allowed.includes(key)) return bad(`--${key} does not apply to agent ${operation}`)
  if (debug) {
    const name = words[2]
    if (!name || !AGENT_CREATE_NAME.test(name) || words.length !== 3) return bad(AGENT_USAGE)
    if (flags.has("params") && !str("tool")) return bad("--params requires --tool")
    let params: Record<string, unknown> | undefined
    if (str("params")?.trim()) {
      try { params = JSON.parse(str("params")!) } catch { return bad("Failed to parse --params. Use JSON.") }
      if (!params || typeof params !== "object" || Array.isArray(params)) return bad("Tool params must be an object")
    }
    if (flags.has("tool") && !str("tool")?.trim()) return bad("--tool needs a tool id")
    return { ok: true, command: { ...common, kind: "agent.debug", name, ...(str("tool") ? { tool: str("tool")! } : {}), ...(params ? { params } : {}) } }
  }
  if (words.length !== 2) return bad(AGENT_USAGE)
  if (operation === "list") return { ok: true, command: { ...common, kind: "agent.list" } }
  if (operation !== "create") return bad(AGENT_USAGE)
  const description = str("description")?.trim()
  if (flags.has("description") && (!description || description.length > 300)) return bad("Description must be 1–300 characters")
  const mode = str("mode") as "all" | "primary" | "subagent" | undefined
  if (mode !== undefined && !["all", "primary", "subagent"].includes(mode)) return bad("--mode needs all|primary|subagent")
  const name = str("name")
  if (name !== undefined && (!AGENT_CREATE_NAME.test(name) || ["build", "plan"].includes(name))) return bad("Use a nonreserved lowercase agent name (max 64)")
  if (flags.has("path") && !str("path")?.trim()) return bad("--path needs a directory")
  if (flags.has("permissions") && flags.has("tools")) return bad("Use --permissions or its alias --tools")
  const raw = str("permissions") ?? str("tools")
  const permissions = raw === undefined ? undefined : raw.trim() ? raw.split(",").map((key) => key.trim()) : [...AGENT_CREATE_PERMISSIONS]
  if (permissions?.some((key) => !(AGENT_CREATE_PERMISSIONS as readonly string[]).includes(key))) return bad(`Unknown permission; use ${AGENT_CREATE_PERMISSIONS.join(", ")}`)
  const model = str("model")
  if (model !== undefined && (model.length > 100 || !/^[^\s/]+\/\S+$/.test(model))) return bad("--model needs provider/model")
  return { ok: true, command: { ...common, kind: "agent.create", ...(str("path") ? { path: str("path")! } : {}), ...(description ? { description } : {}), ...(mode ? { mode } : {}), ...(permissions ? { permissions: [...new Set(permissions)] } : {}), ...(model ? { model } : {}), ...(name ? { name } : {}), ...(flags.has("generate") ? { generate: true } : {}) } }
}
