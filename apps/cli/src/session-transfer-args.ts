import { PROGRAM_NAME } from "@mendcode/program"
export type TransferExport = {
  kind: "session.export"
  id?: string
  outputFormat?: "markdown" | "json" | "html"
  raw?: boolean
  reasoning?: boolean
  toolDetails?: boolean
  assistantMetadata?: boolean
  timestamps?: boolean
  sanitize?: boolean
}
export type ImportFrom = "auto" | "mendcode" | "claude-code" | "codex"
export type TransferImport = { kind: "session.import"; source?: string; from?: ImportFrom; latest?: boolean }
export const TRANSFER_EXPORT_USAGE = `usage: ${PROGRAM_NAME} export [sessionID] [--format json|markdown|html] [--sanitize] [--no-reasoning] [--no-tools] [--metadata] [--timestamps]`
export const TRANSFER_IMPORT_USAGE = `usage: ${PROGRAM_NAME} import <file.json|file.jsonl|URL> [--from auto|mendcode|claude-code|codex] [--dir DATA] [--json] | import --latest [--from claude-code|codex]`
const IMPORT_FROM: readonly string[] = ["auto", "mendcode", "claude-code", "codex"]
/** `import <file|URL>` or `import --latest`; `--from` names the tool whose transcript it is (sniffed when omitted). */
export function parseTransferImport(words: string[], flags: Map<string, string | true>): TransferImport | { error: string } {
  const from = flags.get("from")
  if (from !== undefined && (typeof from !== "string" || !IMPORT_FROM.includes(from))) return { error: `--from must be one of ${IMPORT_FROM.join(", ")}` }
  const latest = flags.has("latest")
  if (words.length > 1 || latest === (words.length === 1)) return { error: TRANSFER_IMPORT_USAGE }
  if (latest && from === "mendcode") return { error: "--latest reads Claude Code or Codex sessions" }
  return { kind: "session.import", ...(words[0] ? { source: words[0] } : {}), ...(from ? { from: from as ImportFrom } : {}), ...(latest ? { latest: true } : {}) }
}
export function parseTransferExport(words: string[], flags: Map<string, string | true>, raw = false): TransferExport | { error: string } {
  if (words.length > 1) return { error: TRANSFER_EXPORT_USAGE }
  const format = flags.get("format") ?? "json"
  if (!["json", "markdown", "md", "text", "html"].includes(String(format))) return { error: "export format must be json, markdown or html" }
  if (flags.has("json") && format !== "json") return { error: `--json conflicts with --format ${format}` }
  for (const [on, off] of [["reasoning", "no-reasoning"], ["tools", "no-tools"], ["metadata", "no-metadata"], ["timestamps", "no-timestamps"]]) {
    if (flags.has(on!) && flags.has(off!)) return { error: `choose --${on} or --${off}` }
  }
  const option = (on: string, off: string, key: string) => flags.has(on) ? { [key]: true } : flags.has(off) ? { [key]: false } : {}
  const id = words[0] ?? (typeof flags.get("session") === "string" ? String(flags.get("session")) : undefined)
  return { kind: "session.export", ...(id ? { id } : {}), outputFormat: format === "json" ? "json" : format === "html" ? "html" : "markdown", ...(raw ? { raw: true } : {}),
    ...option("reasoning", "no-reasoning", "reasoning"), ...option("tools", "no-tools", "toolDetails"), ...option("metadata", "no-metadata", "assistantMetadata"), ...option("timestamps", "no-timestamps", "timestamps"), ...(flags.has("sanitize") ? { sanitize: true } : {}),
  }
}
