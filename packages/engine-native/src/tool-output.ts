import { estimateTokens } from "@mendcode/protocol/wire"
import { graftReportedSavings, redactSecrets, type Settings } from "@mendcode/protocol"
import type { ToolResult } from "@mendcode/tools"
import { filterToolOutput } from "./output-filters"

/** Tool chunks can split credentials. Release complete lines, retaining an unfinished private-key block. */
export function redactedToolStream(limit: number) {
  let pending = ""
  let stopped = false
  const unfinishedKey = (text: string) => {
    const begin = /-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----/g
    for (const match of text.matchAll(begin)) {
      const end = match[0].replace("BEGIN", "END")
      if (!text.includes(end, match.index! + match[0].length)) return match.index!
    }
    return -1
  }
  return {
    push(chunk: string): string {
      if (stopped) return ""
      if (pending.length + chunk.length > limit) {
        pending = ""
        stopped = true
        return "\n[Live output paused; full result when done]\n"
      }
      pending += chunk
      let cut = pending.lastIndexOf("\n") + 1
      const key = unfinishedKey(pending)
      if (key >= 0) cut = Math.min(cut, key)
      const text = pending.slice(0, cut)
      pending = pending.slice(cut)
      return redactSecrets(text).text
    },
    flush(): string {
      const key = unfinishedKey(pending)
      const text = key < 0 ? pending : `${pending.slice(0, key)}[redacted:private-key]`
      pending = ""
      return redactSecrets(text).text
    },
  }
}

/** UTF-8 preview bounded by both configured limits; never splits a character. */
export function limitToolOutput(result: ToolResult, limits: Settings["tool_output"]): ToolResult {
  const maxLines = limits?.max_lines ?? 2000
  const maxBytes = limits?.max_bytes ?? 51200
  if (result.output.split("\n").length <= maxLines && Buffer.byteLength(result.output) <= maxBytes) return result
  const prefix = result.output.split("\n").slice(0, maxLines).join("\n")
  const bytes = Buffer.from(prefix)
  let end = Math.min(bytes.length, maxBytes)
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return { ...result, output: bytes.subarray(0, end).toString("utf8"), truncated: true }
}

/** A graft lookup states its own saving (`[graft] tokens saved ≈ N`); it joins the output filters in the `/usage` tally as source `graft`. */
export function withReportedSavings({ result, tool }: { result: ToolResult; tool: string }): ToolResult {
  if (result.meta?.savedTokens !== undefined || !/(^|__)graft_/.test(tool)) return result
  const saved = graftReportedSavings(result.output)
  return saved === undefined ? result : { ...result, meta: { ...result.meta, savedTokens: saved, filter: "graft" } }
}

/** Estimated header the engine puts above a filtered result (a path is about 80 chars). */
const FILTER_HEADER_CHARS = 150

/**
 * Condenses a command result (colour codes, passing tests, repeats, git hints, grouped hits) when `tool_output.filters` is on. The original
 * text is saved first and its path is the first line of the result, so nothing is lost; without a saved copy the result is returned
 * untouched (undefined). `meta.savedTokens` and `meta.filter` feed the `/usage` tally.
 */
export async function condenseCommandOutput(input: { result: ToolResult; tool: string; args: unknown; limits: Settings["tool_output"]; save: ((text: string, complete: boolean) => Promise<{ path: string; complete: boolean }>) | undefined }): Promise<ToolResult | undefined> {
  const { result, limits, save } = input
  const command = (input.args as { command?: unknown } | null)?.command
  if (!limits?.filters || !save || typeof command !== "string") return undefined
  const filtered = filterToolOutput({ tool: input.tool, command, isError: result.isError, output: result.output, headerChars: FILTER_HEADER_CHARS })
  if (!filtered) return undefined
  const saved = await save(result.output, !result.truncated).catch(() => undefined)
  if (!saved) return undefined
  const header = `[filtered ${filtered.filter}: ${filtered.before} → ${filtered.after} lines, ~${filtered.savedTokens} tokens saved. ${saved.complete ? "Full output" : "Output excerpt"}: ${saved.path}]`
  return { ...result, output: `${header}\n${filtered.output}`, meta: { ...result.meta, outputPath: saved.path, outputComplete: saved.complete, savedTokens: filtered.savedTokens, filter: filtered.filter } }
}

/** Old tool results are replaceable context, while the last two user turns remain verbatim. */
export function pruneToolOutputs(messages: import("./provider").ModelMessage[]): void {
  let turns = 0, kept = 0
  let reclaimed = 0
  const candidates: Array<Extract<import("./provider").ModelMessage, { role: "tool" }>> = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === "user" && !message.content.startsWith("[image from ")) turns++
    if (message.role !== "tool" || turns < 2 || message.name === "skill") continue
    if (message.output.startsWith("[Old tool output pruned;")) break
    kept += estimateTokens(message.output.length)
    if (kept > 40000) { candidates.push(message); reclaimed += estimateTokens(message.output.length) }
  }
  if (reclaimed > 20000) for (const message of candidates) message.output = "[Old tool output pruned; read the file or rerun the tool if needed.]"
}
