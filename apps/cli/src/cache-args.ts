import type { CacheMutation } from "@mendcode/protocol"
import type { Common, ParseResult } from "./automation"
import { PROGRAM_NAME } from "@mendcode/program"

export const CACHE_USAGE = `usage: ${PROGRAM_NAME} cache <status|enable|on|disable|off> [--global] [--provider ID [--model EXACT]] [--session ID] [--project-path PATH] [--scope session|project] [--format text|json] [--json] [--dir DATA]`
export type CacheAutomation = { kind: "cache"; operation: "status" | "enable" | "disable"; target: Omit<CacheMutation, "directory" | "action"> }
const booleans = new Set(["global", "json", "help"])
const values = new Set(["provider", "model", "session", "project-path", "scope", "format", "dir", "data-dir"])

export function parseCache(argv: string[]): ParseResult | undefined {
  let topic: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === "--dir" || token === "--data-dir") { i++; continue }
    if (token.startsWith("--")) continue
    topic = token
    break
  }
  if (topic !== "cache") return undefined
  const words: string[] = [], flags = new Map<string, string | boolean>()
  const bad = (message: string): ParseResult => ({ ok: false, message, topic: "cache" })
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith("--")) { words.push(token); continue }
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2)
    if (booleans.has(name!)) {
      if (inline !== undefined && !["true", "false"].includes(inline)) return bad(`--${name} needs true|false`)
      if (inline !== "false") flags.set(name!, true)
    } else if (values.has(name!)) {
      const value = inline ?? argv[++i]
      if (!value || value.startsWith("--")) return bad(`--${name} needs a value`)
      flags.set(name!, value)
    } else return bad(`unknown flag ${token}`)
  }
  if (words[0] !== "cache") return undefined
  if (flags.has("help")) return { ok: true, command: { kind: "help", topic: "cache", json: false } }
  const operation = words[1] === "on" ? "enable" : words[1] === "off" ? "disable" : words[1]
  if (!["status", "enable", "disable"].includes(operation ?? "") || words.length !== 2) return bad(CACHE_USAGE)
  const str = (name: string) => typeof flags.get(name) === "string" ? String(flags.get(name)) : undefined
  if (str("format") && !["text", "json"].includes(str("format")!)) return bad("--format needs text|json")
  if (str("scope") && !["session", "project"].includes(str("scope")!)) return bad("--scope needs session|project")
  const provider = str("provider"), model = str("model"), session = str("session"), projectPath = str("project-path")
  if ([provider, model, session].some((value) => value !== undefined && (value.length > 200 || /[\x00-\x1f]/.test(value)))) return bad("cache ids must be 1–200 characters without control characters")
  if (projectPath && (projectPath.length > 4096 || /[\x00-\x1f]/.test(projectPath))) return bad("invalid --project-path")
  if (model && !provider) return bad("A model requires --provider")
  if (projectPath && (!flags.has("global") || provider || model || session)) return bad("--project-path requires --global and cannot combine with another target")
  if (session && (provider || model)) return bad("A session cannot combine with provider or model")
  const common: Common = { json: flags.has("json") || str("format") === "json", ...(str("data-dir") || str("dir") ? { dir: str("data-dir") ?? str("dir")! } : {}) }
  return { ok: true, command: { ...common, kind: "cache", operation: operation as CacheAutomation["operation"], target: { ...(flags.has("global") ? { global: true } : {}), ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(session ? { session } : {}), ...(projectPath ? { projectPath } : {}), ...(str("scope") ? { scope: str("scope") as "session" | "project" } : {}) } } }
}
