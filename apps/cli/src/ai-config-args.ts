import type { Common, ParseResult } from "./automation"
import { PROGRAM_NAME } from "@mendcode/program"

export const AI_CONFIG_USAGE = `usage: ${PROGRAM_NAME} ai-config inspect|plan|validate|apply [--input JSON | --file FILE] [--scope project|global] [--target PATH] [--expected-hash HASH] [--yes] [--dir DIR] [--json]`
export type AIConfigAutomation = Common & { kind: "ai.config"; action: "inspect" | "plan" | "validate" | "apply"; input?: string; file?: string; scope?: "project" | "global"; target?: string; expectedHash?: string; yes: boolean }

export function parseAIConfig(argv: string[]): ParseResult | undefined {
  const names: string[] = []
  const flags = new Map<string, string | true>()
  const values = new Set(["input", "file", "scope", "target", "expected-hash", "dir", "project"])
  const booleans = new Set(["yes", "json", "help"])
  let problem: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith("--")) { names.push(token); continue }
    const [name, inline] = token.slice(2).split(/=(.*)/s)
    if (booleans.has(name!)) { flags.set(name!, true); continue }
    if (!values.has(name!)) { problem ??= `Unknown flag --${name}`; continue }
    const value = inline ?? argv[++i]
    if (!value || value.startsWith("--")) { problem ??= `--${name} needs a value`; continue }
    flags.set(name!, value)
  }
  if (names[0] !== "ai-config") return undefined
  const bad = (message: string): ParseResult => ({ ok: false, message, topic: "ai-config" })
  if (problem) return bad(problem)
  if (flags.has("help")) return { ok: true, command: { kind: "help", topic: "ai-config", json: false } }
  const action = names[1] ?? "inspect"
  if (!["inspect", "plan", "validate", "apply"].includes(action) || names.length > 2) return bad(AI_CONFIG_USAGE)
  if (flags.has("input") && flags.has("file")) return bad("Choose --input or --file")
  const scope = flags.get("scope")
  if (scope !== undefined && scope !== "project" && scope !== "global") return bad("Scope must be project or global")
  if (action !== "inspect" && !flags.has("input") && !flags.has("file")) return bad(`${action} requires --input or --file`)
  if (action === "apply" && !flags.has("yes")) return bad("Apply requires --yes after reviewing the preview and validation")
  const optional = (flag: string, key = flag) => flags.has(flag) ? { [key]: String(flags.get(flag)) } : {}
  return { ok: true, command: { kind: "ai.config", action: action as AIConfigAutomation["action"], yes: flags.has("yes"), json: flags.has("json"), ...optional("dir"), ...optional("project", "projectDir"), ...optional("input"), ...optional("file"), ...optional("target"), ...optional("expected-hash", "expectedHash"), ...(scope ? { scope } : {}) } }
}
