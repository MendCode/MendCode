import type { CommandInput } from "@mendcode/client"
import type { Common, ParseResult } from "./automation"
import { PROGRAM_NAME } from "@mendcode/program"

export const CONSOLE_USAGE = `usage: ${PROGRAM_NAME} console <setup [URL] --token-file FILE|off|login [URL]|logout [email]|switch [orgID]|orgs|open|status> [--dir DATA] [--json]`
export const SHARE_USAGE = `usage: ${PROGRAM_NAME} share <status|create|sync|remove> SESSION_ID | share policy <disabled|manual|auto> | share local SESSION_ID [--remove] | share gist SESSION_ID <--yes|--remove> [--dir DATA] [--json]`
export type ConsoleAutomation = { kind: "console"; operation: "status" | "setup" | "off" | "login" | "logout" | "switch" | "orgs" | "open"; argument?: string; tokenFile?: string }
export type ShareAutomation = { kind: "share"; request: CommandInput }
export function parseConsole(argv: string[]): ParseResult | undefined {
  const words: string[] = [], flags = new Map<string, string | true>()
  let error = ""
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith("--")) words.push(arg)
    else if (["--json", "--help", "--yes", "--remove"].includes(arg)) flags.set(arg.slice(2), true)
    else if (["--dir", "--token-file"].includes(arg) && argv[i + 1] && !argv[i + 1]!.startsWith("--")) flags.set(arg.slice(2), argv[++i]!)
    else error = "Unknown or incomplete Console flag"
  }
  const root = words.shift()
  if (!["console", "login", "logout", "switch", "orgs", "open", "share"].includes(root ?? "")) return
  const bad = (message: string): ParseResult => ({ ok: false, message, topic: root === "share" ? "share" : "console" })
  if (error) return bad(error)
  const common: Common = { json: flags.has("json"), ...(flags.has("dir") ? { dir: String(flags.get("dir")) } : {}) }
  if (flags.has("help")) return { ok: true, command: { ...common, kind: "help", topic: root === "share" ? "share" : "console" } }
  if (root === "share") {
    if (flags.has("token-file")) return bad(SHARE_USAGE)
    const [operation, value, extra] = words
    if (extra) return bad(SHARE_USAGE)
    let request: CommandInput
    if (operation === "local" || operation === "gist") {
      if (!value || value.length > 200) return bad(SHARE_USAGE)
      if (operation === "gist" && !flags.has("remove") && !flags.has("yes")) return bad("A gist leaves this machine: add --yes to upload the public transcript as a secret gist")
      request = { type: "session.share.static", sessionId: value as import("@mendcode/protocol").SessionId, target: operation, action: flags.has("remove") ? "remove" : "create", ...(flags.has("yes") ? { confirm: true } : {}) }
    } else if (flags.has("yes") || flags.has("remove")) return bad(SHARE_USAGE)
    else if (operation === "policy" && ["manual", "auto", "disabled"].includes(value ?? "")) request = { type: "settings.set", patch: { share: value } }
    else if (["status", "create", "sync", "remove"].includes(operation ?? "") && value && value.length <= 200) {
      const type = ({ status: "session.share.get", create: "session.share", sync: "session.share.sync", remove: "session.unshare" } as const)[operation as "status" | "create" | "sync" | "remove"]
      request = { type, sessionId: value as import("@mendcode/protocol").SessionId }
    } else return bad(SHARE_USAGE)
    return { ok: true, command: { ...common, kind: "share", request } }
  }
  const operation = (root === "console" ? words.shift() ?? "status" : root) as ConsoleAutomation["operation"]
  if (!["status", "setup", "off", "login", "logout", "switch", "orgs", "open"].includes(operation)) return bad(CONSOLE_USAGE)
  if (words.length > 1 || (["off", "orgs", "open", "status"].includes(operation) && words.length) || operation !== "setup" && flags.has("token-file")) return bad(CONSOLE_USAGE)
  if (operation === "setup" && !flags.has("token-file")) return bad(CONSOLE_USAGE)
  if (["setup", "login"].includes(operation) && words[0]) {
    try {
      const url = new URL(words[0])
      if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return bad("Console URL must be a literal loopback HTTP(S) origin")
    } catch { return bad("Console URL must be a literal loopback HTTP(S) origin") }
  }
  return { ok: true, command: { ...common, kind: "console", operation, ...(words[0] ? { argument: words[0] } : {}), ...(flags.has("token-file") ? { tokenFile: String(flags.get("token-file")) } : {}) } }
}
