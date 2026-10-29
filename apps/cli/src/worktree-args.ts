import type { WorktreeChange, WorktreeRead, WorktreeCreateInput } from "@mendcode/protocol"
import type { Common, ParseResult } from "./automation"
import { COMPAT } from "./compat"
import { PROGRAM_NAME } from "@mendcode/program"

export type WorktreeAutomation = { kind: "worktree"; request: { type: "worktree.query"; query: WorktreeRead } | { type: "worktree.change"; change: WorktreeChange } }
export const WORKTREE_USAGE = `usage: ${PROGRAM_NAME} [control-plane] worktree <status|plan|create|open|adopt|remove|reset|doctor> [target] [--json]\n  plan|create NAME [--branch B] [--base REF] [--path PATH] [--focus F]\n  --dir DATA selects daemon storage; --project PATH selects the project\n  create/open/remove/reset only preview; adopt and plan save registry data`
const values = new Set(["dir", "data-dir", "engine", "format", "compat", "project", "branch", "base", "path", "focus"])
const globalValues = new Set(["dir", "data-dir", "engine", "format", "compat", "project"])
const safe = (value: string) => value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)

export function parseWorktree(argv: string[]): ParseResult | undefined {
  const roots: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token.startsWith("--")) { if (values.has(token.slice(2)) && !token.includes("=")) index++; continue }
    roots.push(token)
  }
  if (!(roots[0] === "worktree" || roots[0] === "control-plane" && roots[1] === "worktree")) return
  const bad = (message: string): ParseResult => ({ ok: false, topic: "worktree", message })
  const flags = new Map<string, string | true>(), positional: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (!token.startsWith("--")) { positional.push(token); continue }
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2)
    if (name === "json" || name === "help") {
      if (inline !== undefined) return bad(`--${name} takes no value`)
      flags.set(name, true)
    } else if (values.has(name!)) {
      const value = inline ?? argv[++index]
      if (!value || value.startsWith("--") || !safe(value)) return bad(`--${name} needs a bounded value without control characters`)
      flags.set(name!, value)
    } else return bad(name === "execute" || name === "force" ? "Worktree execution is unavailable; only previews and explicit adoption are supported" : `Unknown worktree flag --${name}`)
  }
  const args = positional.slice(positional[0] === "control-plane" ? 2 : 1)
  const operation = args[0] ?? "status", target = args[1]
  if (flags.has("help")) return { ok: true, command: { kind: "help", topic: "worktree", json: false } }
  if (flags.has("compat") && flags.get("compat") !== COMPAT) return bad(`--compat must be ${COMPAT}`)
  if (flags.has("format") && !["json", "table", "text"].includes(String(flags.get("format")))) return bad("--format must be json, table or text")
  if (!safe(operation) || target !== undefined && !safe(target) || args.length > 2) return bad("Invalid worktree arguments")
  const common: Common = { json: flags.has("json") || flags.get("format") === "json" || flags.has("compat"), ...(flags.has("compat") ? { compat: COMPAT } : {}), ...(flags.has("dir") || flags.has("data-dir") ? { dir: String(flags.get("dir") ?? flags.get("data-dir")) } : {}), ...(flags.has("project") ? { projectDir: String(flags.get("project")) } : {}) }
  if (["plan", "create"].includes(operation)) {
    if (!target || target.length > 100) return bad(`${operation} needs a name of 1–100 characters`)
    const input: WorktreeCreateInput = { name: target, ...Object.fromEntries(["branch", "base", "path", "focus"].filter((key) => flags.has(key)).map((key) => [key, String(flags.get(key))])) }
    if (String(input.branch ?? "").length > 200 || String(input.base ?? "").length > 200 || String(input.focus ?? "").length > 100) return bad("Branch/base limit is 200 characters; focus limit is 100")
    return { ok: true, command: { ...common, kind: "worktree", request: { type: "worktree.change", change: { operation: operation as "plan" | "create", input } } } }
  }
  if ([...flags.keys()].some((key) => !globalValues.has(key) && key !== "json")) return bad("Create options only apply to plan and create")
  if (operation === "status" || operation === "doctor") {
    if (target) return bad(`${operation} takes no target`)
    return { ok: true, command: { ...common, kind: "worktree", request: { type: "worktree.query", query: { operation } } } }
  }
  if (!target) return bad(`${operation} needs a target id, branch or path`)
  if (operation === "adopt") return { ok: true, command: { ...common, kind: "worktree", request: { type: "worktree.change", change: { operation, target } } } }
  if (["open", "remove", "reset"].includes(operation)) return { ok: true, command: { ...common, kind: "worktree", request: { type: "worktree.query", query: { operation: operation as "open" | "remove" | "reset", target } } } }
  return bad(`Unknown worktree operation: ${operation}`)
}
