import type { DebugInput } from "@mendcode/protocol"
import type { Common, ParseResult } from "./automation"
import { PROGRAM_NAME } from "@mendcode/program"

export type DebugAutomation = { kind: "debug"; input: DebugInput } | { kind: "debug.wait"; timeoutMs?: number } | { kind: "db"; operation: "path" | "query" | "shell"; sql?: string; format: "json" | "tsv" }
export const DEBUG_USAGE = [
  `usage: ${PROGRAM_NAME} debug <command> [--dir DATA] [--json]`,
  "  config · info · paths · scrap · skill · startup",
  "  agent NAME [--tool ID --params JSON --approve]",
  "  file search QUERY | read PATH | status | list PATH | tree [DIR]",
  "  lsp diagnostics FILE | symbols QUERY | document-symbols URI",
  "  snapshot track | patch HASH | diff HASH",
  "  rg tree|files|search PATTERN [--query TEXT] [--glob PATTERN]… [--limit N]",
  "  wait [--timeout-ms MS]                      explicit hold until interrupt",
].join("\n")
export const DATABASE_USAGE = `usage: ${PROGRAM_NAME} db [path|SQL] [--format json|tsv] [--dir DATA]\n  no SQL: read-only SQL shell; .tables · .schema [TABLE] · .quit`

/** Kept separate so db's literal TSV format and debug-only flags do not alter other command parsers. */
export function parseDebug(argv: string[]): ParseResult | undefined {
  const words: string[] = [], flags = new Map<string, string | true>()
  const values = new Set(["dir", "data-dir", "format", "compat", "params", "tool", "timeout-ms"])
  let error: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === "--") { words.push(...argv.slice(i + 1)); break }
    if (!token.startsWith("--")) { words.push(token); continue }
    const [name = "", inline] = token.slice(2).split(/=(.*)/s, 2)
    if (values.has(name)) {
      const value = inline ?? argv[++i]
      if (value === undefined || value.startsWith("--")) error = `--${name} needs a value`
      else flags.set(name, value)
    } else if (["json", "approve", "help"].includes(name)) {
      if (inline !== undefined) error = `--${name} takes no value`
      else flags.set(name, true)
    }
    else error = `unknown flag --${name}`
  }
  const [name, command, ...rest] = words
  if (name !== "db" && name !== "debug" || name === "debug" && command === "rg") return undefined
  const bad = (message: string): ParseResult => ({ ok: false, topic: name, message })
  if (flags.has("help")) return { ok: true, command: { kind: "help", topic: name, json: false } }
  if (error) return bad(error)
  if (flags.has("compat")) return bad("db/debug donor output does not support --compat")
  const format = flags.get("format")
  const common: Common = { json: flags.has("json") || format === "json", ...(flags.get("data-dir") ?? flags.get("dir") ? { dir: String(flags.get("data-dir") ?? flags.get("dir")) } : {}) }
  const ok = (value: DebugAutomation): ParseResult => ({ ok: true, command: { ...common, ...value } })
  if (name === "db") {
    if (format !== undefined && format !== "json" && format !== "tsv") return bad("--format must be json|tsv")
    if (["approve", "params", "tool", "timeout-ms"].some((flag) => flags.has(flag))) return bad("unsupported db flag")
    if (rest.length) return bad("db needs one quoted SQL query")
    if ((command?.length ?? 0) > 65536) return bad("SQL must be at most 65536 characters")
    return ok({ kind: "db", operation: !command ? "shell" : command === "path" ? "path" : "query", ...(command && command !== "path" ? { sql: command } : {}), format: common.json ? "json" : "tsv" })
  }
  if (format !== undefined && format !== "json" && format !== "text" && format !== "table") return bad("--format must be json|text")
  if (command !== "agent" && ["tool", "params", "approve"].some((flag) => flags.has(flag))) return bad("tool flags require debug agent")
  if (command !== "wait" && flags.has("timeout-ms")) return bad("--timeout-ms requires debug wait")
  if (command === "wait") {
    const timeoutMs = flags.has("timeout-ms") ? Number(flags.get("timeout-ms")) : undefined
    if (rest.length || timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000)) return bad("wait accepts --timeout-ms 1–86400000")
    return ok({ kind: "debug.wait", ...(timeoutMs ? { timeoutMs } : {}) })
  }
  if (["config", "info", "paths", "scrap", "skill", "startup"].includes(command ?? "")) {
    if (rest.length) return bad(`${command} takes no arguments`)
    return ok({ kind: "debug", input: { operation: command === "scrap" ? "projects" : command === "skill" ? "skills" : command as "config" | "info" | "paths" | "startup" } })
  }
  if (command === "agent") {
    const [agent, ...extra] = rest
    if (!agent || agent.length > 100 || extra.length) return bad("agent needs one name")
    let params: Record<string, unknown> | undefined
    if (flags.has("params")) {
      try { params = JSON.parse(String(flags.get("params"))) } catch { return bad("--params must be a JSON object") }
      if (!params || typeof params !== "object" || Array.isArray(params)) return bad("--params must be a JSON object")
      if (!flags.has("tool")) return bad("--params requires --tool")
    }
    return ok({ kind: "debug", input: { operation: "agent", name: agent, ...(flags.has("tool") ? { tool: String(flags.get("tool")) } : {}), ...(params ? { params } : {}), ...(flags.has("approve") ? { approve: true } : {}) } })
  }
  const [operation, argument, ...extra] = rest
  if (extra.length || (argument?.length ?? 0) > 4096) return bad("too many arguments or argument too long")
  if (command === "file") {
    if (operation === "status" && !argument) return ok({ kind: "debug", input: { operation: "file.status" } })
    if (operation === "search" && argument !== undefined && argument.length <= 1000) return ok({ kind: "debug", input: { operation: "file.search", query: argument } })
    if (["read", "list", "tree"].includes(operation ?? "") && (argument || operation === "tree")) return ok({ kind: "debug", input: { operation: `file.${operation}` as "file.read" | "file.list" | "file.tree", path: argument ?? "." } })
  }
  if (command === "lsp") {
    if (operation === "symbols" && argument !== undefined && argument.length <= 1000) return ok({ kind: "debug", input: { operation: "lsp.symbols", query: argument } })
    if ((operation === "diagnostics" || operation === "document-symbols") && argument) return ok({ kind: "debug", input: { operation: `lsp.${operation}`, path: argument } })
  }
  if (command === "snapshot") {
    if (operation === "track" && !argument) return ok({ kind: "debug", input: { operation: "snapshot.track" } })
    if ((operation === "patch" || operation === "diff") && argument && /^[a-f0-9]{40,64}$/.test(argument)) return ok({ kind: "debug", input: { operation: `snapshot.${operation}`, hash: argument } })
  }
  return bad("Expected a debug subcommand")
}
