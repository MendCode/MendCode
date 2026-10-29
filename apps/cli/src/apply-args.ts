import type { Common, ParseResult } from "./automation"
import { PROGRAM_NAME } from "@mendcode/program"

export const APPLY_USAGE = `usage: ${PROGRAM_NAME} apply [SESSION_ID | --session ID] [--to DIR] [--check] [--json] [--dir DATA]\n  applies the files a session changed (default: the project's latest session) onto another checkout; all or nothing, never overwrites a file that differs from the diff`
export type ApplyAutomation = { kind: "apply"; session?: string; to?: string; check: boolean }

export function parseApply(argv: string[]): ParseResult | undefined {
  let topic: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === "--dir" || token === "--data-dir") { i++; continue }
    if (token.startsWith("--")) continue
    topic = token
    break
  }
  if (topic !== "apply") return undefined
  const words: string[] = []
  const values = new Map<string, string>()
  const flags = new Set<string>()
  const bad = (message: string): ParseResult => ({ ok: false, message, topic: "apply" })
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith("--")) { words.push(token); continue }
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2)
    if (["check", "json", "help"].includes(name!)) flags.add(name!)
    else if (["session", "to", "dir", "data-dir"].includes(name!)) {
      const value = inline ?? argv[++i]
      if (!value || value.startsWith("--")) return bad(`--${name} needs a value`)
      values.set(name!, value)
    } else return bad(`unknown flag ${token}`)
  }
  if (words[0] !== "apply") return undefined
  if (flags.has("help")) return { ok: true, command: { kind: "help", topic: "apply", json: false } }
  if (words.length > 2 || words[1] && values.has("session")) return bad(APPLY_USAGE)
  const session = words[1] ?? values.get("session")
  const common: Common = { json: flags.has("json"), ...(values.has("dir") || values.has("data-dir") ? { dir: values.get("data-dir") ?? values.get("dir")! } : {}) }
  return { ok: true, command: { ...common, kind: "apply", check: flags.has("check"), ...(session ? { session } : {}), ...(values.has("to") ? { to: values.get("to")! } : {}) } }
}
