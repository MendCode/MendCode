import type { MflowActivation, MflowChange, MflowRead } from "@mendcode/protocol"
import type { Common, ParseResult } from "./automation"
import { PROGRAM_NAME } from "@mendcode/program"

export type MflowAutomation = { kind: "mflow"; request: { type: "mflow.query"; query: MflowRead } | { type: "mflow.change"; change: MflowChange } }
export const MFLOW_USAGE = `usage: ${PROGRAM_NAME} [control-plane] mflow <status|activate|deactivate|remove|setup|scan|relay-guide|plan|doctor|legacy-status|start|stop> [--json]\n  activate|setup [--room ROOM] [--url embedded|http://127.0.0.1:PORT] [--token-file PRIVATE_FILE] [--priority 0–9]\n  --dir DATA selects daemon storage; --project PATH selects the project\n  opt-in coordination; setup configures only, start is explicit; file sync is off`
const values = new Set(["dir", "data-dir", "engine", "format", "project", "room", "url", "signaling", "token-file", "priority", "relay"])
const options = new Set(["room", "url", "signaling", "token-file", "priority", "relay"])
const safe = (value: string) => value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)

export function parseMflow(argv: string[]): ParseResult | undefined {
  const roots: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token.startsWith("--")) { if (values.has(token.slice(2)) && !token.includes("=")) index++; continue }
    roots.push(token)
  }
  if (!(roots[0] === "mflow" || roots[0] === "control-plane" && roots[1] === "mflow")) return
  const bad = (message: string): ParseResult => ({ ok: false, topic: "mflow", message })
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
      if (!value || value.startsWith("--") || !safe(value)) return bad(`--${name} needs a bounded value`)
      flags.set(name!, value)
    } else return bad("Unsupported Mflow flag; use a private token file and local relay")
  }
  const args = positional.slice(positional[0] === "control-plane" ? 2 : 1)
  if (flags.has("help")) return { ok: true, command: { kind: "help", topic: "mflow", json: false } }
  if (args.length > 1) return bad("Mflow takes one operation; configuration uses flags")
  const operation = args[0] ?? "status"
  if (flags.has("format") && !["json", "table", "text", "default"].includes(String(flags.get("format")))) return bad("Invalid Mflow output format")
  const common: Common = { json: flags.has("json") || flags.get("format") === "json", ...(flags.has("dir") || flags.has("data-dir") ? { dir: String(flags.get("dir") ?? flags.get("data-dir")) } : {}), ...(flags.has("project") ? { projectDir: String(flags.get("project")) } : {}) }
  if (operation === "activate" || operation === "setup") {
    if (flags.has("relay") && flags.get("relay") !== "local") return bad("Only local Mflow relays are enabled")
    const priority = flags.has("priority") ? Number(flags.get("priority")) : undefined
    if (priority !== undefined && (!Number.isInteger(priority) || priority < 0 || priority > 9)) return bad("Priority must be 0–9")
    const room = flags.has("room") ? String(flags.get("room")).trim() : undefined
    if (room !== undefined && (!room || room.length > 200)) return bad("Room must use 1–200 characters")
    const signaling = flags.has("url") || flags.has("signaling") ? String(flags.get("url") ?? flags.get("signaling")) : undefined
    const input: MflowActivation = { ...(room ? { room } : {}), ...(signaling ? { signaling } : {}), ...(flags.has("token-file") ? { tokenFile: String(flags.get("token-file")) } : {}), ...(priority !== undefined ? { hookPriority: priority } : {}) }
    return { ok: true, command: { ...common, kind: "mflow", request: { type: "mflow.change", change: { operation, input } } } }
  }
  if ([...flags.keys()].some((key) => options.has(key))) return bad("Configuration flags require activate or setup")
  if (["status", "scan", "relay-guide", "doctor", "legacy-status"].includes(operation)) return { ok: true, command: { ...common, kind: "mflow", request: { type: "mflow.query", query: { operation: operation as MflowRead["operation"] } } } }
  if (["deactivate", "remove", "plan", "start", "stop"].includes(operation)) return { ok: true, command: { ...common, kind: "mflow", request: { type: "mflow.change", change: { operation: operation as "deactivate" | "remove" | "plan" | "start" | "stop" } } } }
  return bad("Unknown Mflow operation")
}
