/**
 * An ACP tool call in MendCode's own tool names and texts (`edit: path` with a unified diff, `shell: command` with its output, `write:
 * path` with `Created path (N bytes)`), so the terminal draws it as it draws its own cards instead of as an unknown tool. Anything it
 * cannot name keeps the agent's title and text.
 */

type Json = Record<string, any>

/** What an agent told about one call so far: `tool_call` and every `tool_call_update` merged, later fields winning. */
export type AcpToolCall = { title?: string; name?: string; kind?: string; rawInput?: Json; locations?: Json[]; content?: unknown[]; rawOutput?: unknown }

const CONTEXT_LINES = 3
const MAX_HUNK_LINES = 400

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined)
const firstLine = (value: string) => value.split("\n")[0]!.trim()

/** Merges an update into what is known of the call; `null` and absent fields keep the earlier value. */
export function mergeToolCall(call: AcpToolCall, update: Json): AcpToolCall {
  const next = { ...call }
  if (text(update.title)) next.title = update.title
  // The tool's name: the field when the agent sends one, else its first title (OpenCode's is the bare name: `edit`, `bash`).
  const name = next.name ?? text(update.name) ?? text(update.title)
  if (name) next.name = name
  if (text(update.kind)) next.kind = update.kind
  if (update.rawInput && typeof update.rawInput === "object" && Object.keys(update.rawInput).length) next.rawInput = update.rawInput
  if (Array.isArray(update.locations) && update.locations.length) next.locations = update.locations
  if (Array.isArray(update.content) && update.content.length) next.content = update.content
  if (update.rawOutput !== undefined && update.rawOutput !== null) next.rawOutput = update.rawOutput
  return next
}

/** Whether the call's input is known: a pending call with no input yet (OpenCode announces one before its arguments) waits for it. */
export function hasInput(call: AcpToolCall): boolean {
  return Object.keys(call.rawInput ?? {}).some((key) => key !== "cwd" && key !== "workdir")
}

function diffs(call: AcpToolCall): Json[] {
  return (call.content ?? []).filter((item): item is Json => typeof item === "object" && item !== null && (item as Json).type === "diff")
}

function pathOf(call: AcpToolCall): string | undefined {
  const input = call.rawInput ?? {}
  return text(input.filePath) ?? text(input.file_path) ?? text(input.path) ?? text(call.locations?.[0]?.path) ?? text(diffs(call)[0]?.path)
}

/** The tool's own name, lower case: OpenCode's first title is it (`edit`, `write`, `bash`); other agents' titles are sentences. */
function toolName(call: AcpToolCall): string {
  return (call.name ?? "").toLowerCase()
}

function isWrite(call: AcpToolCall): boolean {
  if (toolName(call) === "write") return true
  const input = call.rawInput ?? {}
  return typeof input.content === "string" && input.oldString === undefined && input.old_string === undefined
}

/** `shell: wc -l notes.txt`, `edit: /p/a.ts`…; the agent's title when the kind or the input does not say. */
export function acpToolTitle(call: AcpToolCall): string {
  const input = call.rawInput ?? {}
  const titled = (tool: string, detail: string | undefined) => (detail ? `${tool}: ${firstLine(detail)}` : undefined)
  const fallback = (call.title ?? call.name ?? call.kind ?? "tool").slice(0, 200)
  const name = toolName(call)
  const mapped = (() => {
    switch (call.kind) {
      case "execute":
        return titled("shell", text(input.command) ?? text(input.cmd))
      case "read":
        return titled("read", pathOf(call))
      case "edit":
        if (name === "patch" || name === "apply_patch") return "apply_patch"
        return titled(isWrite(call) ? "write" : "edit", pathOf(call))
      case "search":
        return name === "grep" || name === "glob" ? titled(name, text(input.pattern)) : undefined
      case "fetch":
        return titled("webfetch", text(input.url))
      default:
        return undefined
    }
  })()
  return (mapped ?? fallback).slice(0, 200)
}

/** OpenCode's own unified diff of an edit (`rawOutput.metadata.diff`), from its first hunk: real line numbers and context. */
function agentDiff(call: AcpToolCall): string | undefined {
  const raw = call.rawOutput as Json | undefined
  const diff = text(raw?.metadata?.diff) ?? text(raw?.diff)
  const at = diff?.search(/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m) ?? -1
  return at >= 0 ? diff!.slice(at).replace(/\s+$/, "") : undefined
}

/**
 * A unified hunk from a diff block's `oldText` and `newText`: what both share at either end is cut to three lines of context. The
 * numbers are right when the texts are whole files (the ACP norm) or when the call's location gives the first line.
 */
function hunk(item: Json, firstLineNumber: number): string | undefined {
  const before = typeof item.oldText === "string" && item.oldText !== "" ? item.oldText.split("\n") : []
  const after = typeof item.newText === "string" ? item.newText.split("\n") : []
  if (before.length > MAX_HUNK_LINES * 10 || after.length > MAX_HUNK_LINES * 10) return undefined
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++
  if (prefix === before.length && prefix === after.length) return undefined
  const start = Math.max(0, prefix - CONTEXT_LINES)
  const leading = before.slice(start, prefix)
  const trailing = before.slice(before.length - suffix, before.length - suffix + CONTEXT_LINES)
  const removed = before.slice(prefix, before.length - suffix)
  const added = after.slice(prefix, after.length - suffix)
  const oldCount = leading.length + removed.length + trailing.length
  const newCount = leading.length + added.length + trailing.length
  const rows = [...leading.map((line) => ` ${line}`), ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`), ...trailing.map((line) => ` ${line}`)].slice(0, MAX_HUNK_LINES)
  const first = firstLineNumber + start
  return [`@@ -${before.length ? first : 0},${oldCount} +${first},${newCount} @@`, ...rows].join("\n")
}

/**
 * The finished call's text as MendCode's own tool would write it: an edit's unified diff, a write's `Created path (N bytes)`; undefined
 * keeps the agent's own text (output, failure).
 */
export function acpToolText(call: AcpToolCall, failed: boolean): string | undefined {
  if (failed || call.kind !== "edit") return undefined
  const name = toolName(call)
  if (name === "patch" || name === "apply_patch") return agentDiff(call)
  if (isWrite(call)) {
    const content = call.rawInput?.content
    const path = pathOf(call)
    if (typeof content !== "string" || !path) return undefined
    const created = (call.rawOutput as Json | undefined)?.metadata?.exists === false
    return `${created ? "Created" : "Wrote"} ${path} (${Buffer.byteLength(content)} bytes)`
  }
  const own = agentDiff(call)
  if (own) return own
  const line = Number(call.locations?.[0]?.line)
  const hunks = diffs(call).map((item) => hunk(item, Number.isInteger(line) && line > 0 ? line : 1)).filter((part): part is string => part !== undefined)
  return hunks.length ? hunks.join("\n") : undefined
}
