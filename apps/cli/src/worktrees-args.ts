import { WORKTREES_HELP } from "./help-text"
import type { Common, ParseResult } from "./automation"

export const WORKTREES_USAGE = WORKTREES_HELP
export type WorktreesAutomation = { kind: "worktrees"; action: "list" | "size" | "gc"; yes: boolean; artifacts: boolean; idleDays?: number }
const booleans = new Set(["json", "help", "yes", "artifacts", "dry-run"])
const values = new Set(["idle", "dir", "data-dir"])

export function parseWorktrees(argv: string[]): ParseResult | undefined {
  let topic: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === "--dir" || token === "--data-dir") { i++; continue }
    if (token.startsWith("--")) continue
    topic = token
    break
  }
  if (topic !== "worktrees") return undefined
  const words: string[] = [], flags = new Map<string, string | boolean>()
  const bad = (message: string): ParseResult => ({ ok: false, message, topic: "worktrees" })
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
    } else if (words[0] === "worktrees") return bad(`unknown flag ${token}`)
  }
  if (words[0] !== "worktrees") return undefined
  if (flags.has("help")) return { ok: true, command: { kind: "help", topic: "worktrees", json: false } }
  const action = words[1] ?? "list"
  if (!["list", "size", "gc"].includes(action) || words.length > 2) return bad(WORKTREES_USAGE)
  const idle = flags.get("idle")
  const parsed = typeof idle === "string" ? /^(\d+)d?$/.exec(idle)?.[1] : undefined
  if (idle !== undefined && parsed === undefined) return bad("--idle needs a number of days like 14d")
  if (action !== "gc" && (flags.has("yes") || flags.has("artifacts"))) return bad(`--yes and --artifacts belong to gc`)
  if (flags.has("yes") && flags.has("dry-run")) return bad("--yes and --dry-run exclude each other")
  const dir = typeof flags.get("data-dir") === "string" ? String(flags.get("data-dir")) : typeof flags.get("dir") === "string" ? String(flags.get("dir")) : undefined
  const common: Common = { json: flags.has("json"), ...(dir ? { dir } : {}) }
  return { ok: true, command: { ...common, kind: "worktrees", action: action as WorktreesAutomation["action"], yes: flags.has("yes"), artifacts: flags.has("artifacts"), ...(parsed === undefined ? {} : { idleDays: Number(parsed) }) } }
}
