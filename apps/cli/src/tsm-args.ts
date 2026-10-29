import type { TsmChange, TsmRead } from "@mendcode/protocol"
import type { Common, ParseResult } from "./automation"
import { COMPAT } from "./compat"
import { PROGRAM_NAME } from "@mendcode/program"

export type TsmAutomation = { kind: "tsm"; request: { type: "tsm.query"; query: TsmRead } | { type: "tsm.change"; change: TsmChange } }
export const TSM_USAGE = `usage: ${PROGRAM_NAME} [control-plane] tsm <status|plan|install|setup|activate|deactivate|remove|doctor> [--mux cmux|kitty|ghostty|wezterm|auto] [--json]\n  open TARGET | create NAME [--branch B] [--base REF] [--path PATH] [--focus F] (preview only)\n  --dir DATA selects daemon storage; --project PATH selects the project\n  plan/install/setup save a dry-run plan; remove recycles only MendCode scaffold`
const values = new Set(["dir", "data-dir", "engine", "format", "compat", "project", "mux", "branch", "base", "path", "focus"])
const muxes = ["cmux", "kitty", "ghostty", "wezterm", "auto"] as const
const safe = (value: string) => value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)

export function parseTsm(argv: string[]): ParseResult | undefined {
  const roots: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token.startsWith("--")) { if (values.has(token.slice(2)) && !token.includes("=")) index++; continue }
    roots.push(token)
  }
  if (!(roots[0] === "tsm" || roots[0] === "control-plane" && roots[1] === "tsm")) return
  const bad = (message: string): ParseResult => ({ ok: false, topic: "tsm", message })
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
    } else return bad(`Unknown TSM flag --${name}`)
  }
  const args = positional.slice(positional[0] === "control-plane" ? 2 : 1)
  const operation = args[0] ?? "status", target = args[1]
  if (flags.has("help")) return { ok: true, command: { kind: "help", topic: "tsm", json: false } }
  if (flags.has("compat") && flags.get("compat") !== COMPAT) return bad(`--compat must be ${COMPAT}`)
  if (flags.has("format") && !["json", "table", "text"].includes(String(flags.get("format")))) return bad("--format must be json, table or text")
  if (args.length > 2 || !safe(operation) || target !== undefined && !safe(target)) return bad("Invalid TSM arguments")
  if (flags.has("mux") && (operation !== "activate" || !muxes.includes(String(flags.get("mux")) as never))) return bad("--mux applies to activate: cmux|kitty|ghostty|wezterm|auto")
  if (["branch", "base", "path", "focus"].some((key) => flags.has(key)) && operation !== "create") return bad("Create options only apply to create previews")
  const common: Common = { json: flags.has("json") || flags.get("format") === "json" || flags.has("compat"), ...(flags.has("compat") ? { compat: COMPAT } : {}), ...(flags.has("dir") || flags.has("data-dir") ? { dir: String(flags.get("dir") ?? flags.get("data-dir")) } : {}), ...(flags.has("project") ? { projectDir: String(flags.get("project")) } : {}) }
  if (operation === "open") {
    if (!target) return bad("open needs a target id, branch or path")
    return { ok: true, command: { ...common, kind: "tsm", request: { type: "tsm.query", query: { operation, target } } } }
  }
  if (operation === "create") {
    if (!target || target.length > 100) return bad("create needs a name of 1–100 characters")
    const input = { name: target, ...Object.fromEntries(["branch", "base", "path", "focus"].filter((key) => flags.has(key)).map((key) => [key, String(flags.get(key))])) }
    if (["branch", "base"].some((key) => String(flags.get(key) ?? "").length > 200) || String(flags.get("focus") ?? "").length > 100) return bad("Branch/base limit is 200 characters; focus limit is 100")
    return { ok: true, command: { ...common, kind: "tsm", request: { type: "tsm.query", query: { operation, input } } } }
  }
  if (target) return bad(`${operation} takes no target`)
  if (operation === "status" || operation === "doctor") return { ok: true, command: { ...common, kind: "tsm", request: { type: "tsm.query", query: { operation } } } }
  if (operation === "activate") return { ok: true, command: { ...common, kind: "tsm", request: { type: "tsm.change", change: { operation, ...(flags.has("mux") ? { muxBackend: flags.get("mux") as typeof muxes[number] } : {}) } } } }
  if (["plan", "install", "setup", "deactivate", "remove"].includes(operation)) return { ok: true, command: { ...common, kind: "tsm", request: { type: "tsm.change", change: { operation: operation as "plan" | "install" | "setup" | "deactivate" | "remove" } } } }
  return bad(`Unknown TSM operation: ${operation}`)
}
