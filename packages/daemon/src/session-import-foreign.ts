import type { SessionTranscript, SessionTranscriptItem, SessionTranscriptTurn, TranscriptMetadata } from "@mendcode/protocol"

/**
 * Readers for other agents' transcripts. They only translate: the result is a `mendcode-session@1` value that goes
 * through the same validation, redaction and import as a native file (so tool calls are history, never executed, and
 * attachment files are not transferred). Unknown rows are skipped; limits are the native ones and the newest turns win.
 */
export type ForeignKind = "claude-code" | "codex"
type Json = Record<string, unknown>
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }
type Ctx = { fallbackAt: number; now: number }

const TEXT_MAX = 65_536
const INPUT_MAX = 4_000
const TURNS_MAX = 1_000
const ITEMS_MAX = 2_000
const PER_TURN_MAX = 200
const SKIPPED_PREAMBLE = /^\s*(<environment_context>|<user_instructions>|<INSTRUCTIONS>|<user_action>|# AGENTS\.md instructions|<permissions instructions>|<local-command-caveat>)/

const obj = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined
const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
const time = (value: unknown, fallback: number) => {
  const parsed = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

function rows(text: string): Json[] {
  const out: Json[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      const row = obj(JSON.parse(trimmed))
      if (row) out.push(row)
    } catch { /* A half-written last line is normal in a live transcript. */ }
  }
  return out
}

/** Which tool wrote a JSONL transcript, from the first rows; undefined when it looks like neither. */
export function detectForeign(text: string): ForeignKind | undefined {
  for (const row of rows(text.slice(0, 200_000)).slice(0, 60)) {
    const type = str(row.type)
    if (type === "session_meta" || type === "response_item" || type === "turn_context" || type === "event_msg") return "codex"
    if (typeof row.id === "string" && typeof row.instructions === "string" && type === undefined) return "codex"
    if ((type === "message" || type === "function_call") && row.payload === undefined) return "codex"
    if ((type === "user" || type === "assistant") && obj(row.message)) return "claude-code"
    if (type === "summary" || type === "file-history-snapshot" || typeof row.sessionId === "string" && typeof row.uuid === "string") return "claude-code"
  }
  return undefined
}

const clip = (text: string, max = TEXT_MAX) => text.length > max ? { text: text.slice(0, max), cut: true } : { text, cut: false }
const joined = (parts: unknown, kinds: string[]): string => Array.isArray(parts) ? parts.map((part) => { const block = obj(part); return block && kinds.includes(String(block.type)) ? str(block.text) ?? "" : "" }).filter(Boolean).join("\n") : typeof parts === "string" ? parts : ""

/** Output of a tool as text: a string, or a list of text blocks, or an object with `content`/`output`. */
function toolText(value: unknown): string {
  if (typeof value === "string") {
    if (value.startsWith("{")) {
      try { const parsed = obj(JSON.parse(value)); if (parsed && typeof parsed.output === "string") return parsed.output } catch { /* plain text */ }
    }
    return value
  }
  if (Array.isArray(value)) return joined(value, ["text", "output_text", "input_text"])
  const record = obj(value)
  if (!record) return ""
  return toolText(record.content ?? record.output ?? "")
}

class Builder {
  turns: SessionTranscriptTurn[] = []
  usage = new Map<SessionTranscriptTurn, Map<string, Usage & { model: string }>>()
  truncated = false
  private seq = 0
  start(at: number): SessionTranscriptTurn {
    const turn: SessionTranscriptTurn = { turnId: `t${this.turns.length + 1}`, at, outcome: "completed", items: [] }
    this.turns.push(turn)
    return turn
  }
  add(item: Omit<SessionTranscriptItem, "itemId">, at: number): SessionTranscriptItem {
    const turn = this.turns.at(-1) ?? this.start(at)
    const text = clip(item.text)
    const made: SessionTranscriptItem = { ...item, itemId: `i${++this.seq}`, text: text.text, at, ...(text.cut ? { truncated: true as const } : {}) }
    turn.items.push(made)
    return made
  }
  input(value: unknown): { input: string; cut: boolean } | undefined {
    const raw = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value) ?? ""
    if (!raw) return undefined
    const text = clip(raw, INPUT_MAX)
    return { input: text.text, cut: text.cut }
  }
  note(turn: SessionTranscriptTurn | undefined, messageId: string, model: string, usage: Usage) {
    if (!turn) return
    const map = this.usage.get(turn) ?? new Map()
    map.set(messageId, { ...usage, model })
    this.usage.set(turn, map)
  }
  finish({ sessionId, title, directory, exportedAt, provider }: { sessionId: string; title: string; directory: string; exportedAt: number; provider?: string }): SessionTranscript {
    const withItems = this.turns.filter((turn) => turn.items.length > 0)
    const kept: SessionTranscriptTurn[] = []
    let items = 0
    for (const turn of withItems.toReversed()) {
      const size = Math.min(turn.items.length, PER_TURN_MAX)
      if (kept.length >= TURNS_MAX || items + size > ITEMS_MAX) { this.truncated = true; break }
      if (turn.items.length > PER_TURN_MAX) { turn.items = turn.items.slice(-PER_TURN_MAX); this.truncated = true }
      const usage = [...(this.usage.get(turn)?.values() ?? [])]
      if (usage.length && provider) {
        const sum = usage.reduce((total, one) => ({ input: total.input + one.input, output: total.output + one.output, cacheRead: total.cacheRead + one.cacheRead, cacheWrite: total.cacheWrite + one.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
        const metadata: TranscriptMetadata = { provider, model: usage.at(-1)!.model.slice(0, 200), tokens: sum.input + sum.output, input: sum.input, output: sum.output, cacheRead: sum.cacheRead, cacheWrite: sum.cacheWrite }
        turn.metadata = metadata
      }
      items += size
      kept.push(turn)
    }
    kept.reverse()
    const last = kept.at(-1)
    return { format: "mendcode-session@1", sessionId: sessionId.slice(0, 200) || "imported", title: title.slice(0, 200), directory: directory.slice(0, 4096), exportedAt: Math.max(exportedAt, last?.at ?? 0), truncated: this.truncated, turns: kept }
  }
}

const firstLine = (text: string) => text.trim().split("\n")[0]?.trim().slice(0, 80) ?? ""

/** Claude Code `~/.claude/projects/<project>/<session>.jsonl`. */
export function claudeCodeTranscript(text: string, ctx: Ctx): SessionTranscript {
  const all = rows(text)
  const builder = new Builder()
  const calls = new Map<string, SessionTranscriptItem>()
  let sessionId = ""
  let directory = ""
  let title = ""
  let firstPrompt = ""
  let at = ctx.fallbackAt
  for (const row of all) {
    sessionId ||= str(row.sessionId) ?? ""
    directory ||= str(row.cwd) ?? ""
    const type = str(row.type)
    if (type === "summary" && str(row.summary)) title = str(row.summary)!
    if ((type === "custom-title" || type === "ai-title") && (str(row.customTitle) ?? str(row.aiTitle))) title = (str(row.customTitle) ?? str(row.aiTitle))!
    if (row.isSidechain === true || (type !== "user" && type !== "assistant")) continue
    const message = obj(row.message)
    if (!message) continue
    at = time(row.timestamp, at)
    const content = message.content
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.map(obj).filter((block): block is Json => block !== undefined) : []
    if (type === "user") {
      if (row.isMeta === true) continue
      for (const block of blocks) {
        if (block.type !== "tool_result") continue
        const call = calls.get(str(block.tool_use_id) ?? "")
        if (!call) continue
        const out = clip(toolText(block.content))
        call.text = out.text
        call.status = block.is_error === true ? "error" : "ok"
        if (out.cut) call.truncated = true
      }
      const prompt = blocks.filter((block) => block.type === "text").map((block) => str(block.text) ?? "").filter(Boolean).join("\n")
      const images = blocks.filter((block) => block.type === "image").map((block) => { const source = obj(block.source); return { name: "image", mime: str(source?.media_type) ?? "image/*", bytes: Math.floor((str(source?.data)?.length ?? 0) * 3 / 4) } })
      if (row.isCompactSummary === true) { builder.add({ kind: "compaction", text: prompt, status: "ok" }, at); continue }
      if (!prompt.trim() && !images.length || SKIPPED_PREAMBLE.test(prompt)) continue
      builder.start(at)
      firstPrompt ||= firstLine(prompt)
      builder.add({ kind: "user_message", text: prompt, status: "ok", ...(images.length ? { attachments: images.slice(0, 32) } : {}) }, at)
      continue
    }
    const model = str(message.model) ?? ""
    if (model === "<synthetic>") continue
    for (const block of blocks) {
      if (block.type === "text" && str(block.text)?.trim()) builder.add({ kind: "agent_message", text: str(block.text)!, status: "ok" }, at)
      else if (block.type === "thinking" && str(block.thinking)?.trim()) builder.add({ kind: "reasoning", text: str(block.thinking)!, status: "ok" }, at)
      else if (block.type === "tool_use") {
        const input = builder.input(block.input)
        const item = builder.add({ kind: "tool_call", text: "", status: "unknown", tool: (str(block.name) ?? "tool").slice(0, 200), ...(input ? { input: input.input } : {}) }, at)
        if (str(block.id)) calls.set(str(block.id)!, item)
      }
    }
    const usage = obj(message.usage)
    if (usage && model) builder.note(builder.turns.at(-1), str(message.id) ?? str(row.uuid) ?? String(builder.turns.length), model, { input: count(usage.input_tokens), output: count(usage.output_tokens), cacheRead: count(usage.cache_read_input_tokens), cacheWrite: count(usage.cache_creation_input_tokens) })
  }
  return builder.finish({ sessionId: `claude-code:${sessionId}`, title: title || firstPrompt || "Claude Code session", directory, exportedAt: ctx.now, provider: "anthropic" })
}

/** Codex `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, current (`response_item` rows) and older flat rows. */
export function codexTranscript(text: string, ctx: Ctx): SessionTranscript {
  const builder = new Builder()
  const calls = new Map<string, SessionTranscriptItem>()
  let sessionId = ""
  let directory = ""
  let firstPrompt = ""
  let at = ctx.fallbackAt
  for (const row of rows(text)) {
    at = time(row.timestamp, at)
    const type = str(row.type)
    const payload = obj(row.payload)
    if (type === "session_meta" && payload) { sessionId ||= str(payload.id) ?? ""; directory ||= str(payload.cwd) ?? ""; continue }
    if (type === undefined && typeof row.id === "string") { sessionId ||= row.id; continue }
    const entry = type === "response_item" ? payload : type === "message" || type === "reasoning" || type?.endsWith("_call") || type?.endsWith("_call_output") ? row : undefined
    if (!entry) continue
    switch (str(entry.type)) {
      case "message": {
        const role = str(entry.role)
        if (role === "user") {
          const prompt = joined(entry.content, ["input_text", "text"])
          const images = (Array.isArray(entry.content) ? entry.content : []).filter((part) => obj(part)?.type === "input_image").map(() => ({ name: "image", mime: "image/*", bytes: 0 }))
          if (!prompt.trim() && !images.length || SKIPPED_PREAMBLE.test(prompt)) break
          builder.start(at)
          firstPrompt ||= firstLine(prompt)
          builder.add({ kind: "user_message", text: prompt, status: "ok", ...(images.length ? { attachments: images.slice(0, 32) } : {}) }, at)
        } else if (role === "assistant") {
          const answer = joined(entry.content, ["output_text", "text"])
          if (answer.trim()) builder.add({ kind: "agent_message", text: answer, status: "ok" }, at)
        }
        break
      }
      case "reasoning": {
        const summary = joined(entry.summary, ["summary_text", "text"])
        if (summary.trim()) builder.add({ kind: "reasoning", text: summary, status: "ok" }, at)
        break
      }
      case "function_call": case "custom_tool_call": case "local_shell_call": {
        const raw = entry.type === "custom_tool_call" ? entry.input : entry.type === "local_shell_call" ? entry.action : entry.arguments
        const input = builder.input(raw)
        const item = builder.add({ kind: "tool_call", text: "", status: "unknown", tool: (str(entry.name) ?? (entry.type === "local_shell_call" ? "shell" : "tool")).slice(0, 200), ...(input ? { input: input.input } : {}) }, at)
        const id = str(entry.call_id) ?? str(entry.id)
        if (id) calls.set(id, item)
        break
      }
      case "function_call_output": case "custom_tool_call_output": {
        const call = calls.get(str(entry.call_id) ?? "")
        if (!call) break
        const out = clip(toolText(entry.output))
        call.text = out.text
        call.status = obj(entry.output)?.success === false ? "error" : "ok"
        if (out.cut) call.truncated = true
        break
      }
    }
  }
  return builder.finish({ sessionId: `codex:${sessionId}`, title: firstPrompt || "Codex session", directory, exportedAt: ctx.now })
}

/**
 * MendCode v1's `mendcode export` JSON: `{ info, messages: [{ info, parts }] }` (opencode's message and part shapes). A user
 * message starts a turn; text, reasoning and tool parts become its items, with the tool's input, output and status. Files are
 * described, never transferred; step, patch and snapshot parts carry nothing to show and are skipped.
 */
export function v1ExportTranscript(raw: unknown, ctx: Ctx): SessionTranscript {
  const root = obj(raw) ?? {}
  const info = obj(root.info) ?? {}
  const builder = new Builder()
  let provider = ""
  let firstPrompt = ""
  for (const message of Array.isArray(root.messages) ? root.messages : []) {
    const head = obj(obj(message)?.info) ?? {}
    const parts = (Array.isArray(obj(message)?.parts) ? obj(message)!.parts as unknown[] : []).map(obj).filter((part): part is Json => part !== undefined)
    const at = time(obj(head.time)?.created, builder.turns.at(-1)?.at ?? ctx.fallbackAt)
    if (head.role === "user") {
      const prompt = parts.filter((part) => part.type === "text" && part.synthetic !== true).map((part) => str(part.text) ?? "").filter(Boolean).join("\n")
      const files = parts.filter((part) => part.type === "file").map((part) => ({ name: (str(part.filename) ?? "file").slice(0, 1000), mime: (str(part.mime) ?? "application/octet-stream").slice(0, 200), bytes: 0 }))
      if (!prompt.trim() && !files.length) continue
      builder.start(at)
      firstPrompt ||= firstLine(prompt)
      builder.add({ kind: "user_message", text: prompt, status: "ok", ...(files.length ? { attachments: files.slice(0, 32) } : {}) }, at)
      continue
    }
    if (head.role !== "assistant") continue
    provider ||= str(head.providerID) ?? ""
    for (const part of parts) {
      if (part.type === "text" && str(part.text)?.trim() && part.synthetic !== true) builder.add({ kind: "agent_message", text: str(part.text)!, status: "ok" }, at)
      else if (part.type === "reasoning" && str(part.text)?.trim()) builder.add({ kind: "reasoning", text: str(part.text)!, status: "ok" }, at)
      else if (part.type === "tool") {
        const state = obj(part.state) ?? {}
        const input = builder.input(state.input)
        const status = state.status === "completed" ? "ok" : state.status === "error" ? "error" : "unknown"
        const out = clip(toolText(state.status === "error" ? state.error : state.output))
        builder.add({ kind: "tool_call", text: out.text, status, tool: (str(part.tool) ?? "tool").slice(0, 200), ...(input ? { input: input.input } : {}), ...(out.cut ? { truncated: true as const } : {}) }, at)
      }
    }
    const tokens = obj(head.tokens)
    const model = str(head.modelID)
    if (tokens && model) builder.note(builder.turns.at(-1), str(head.id) ?? String(builder.turns.length), model, { input: count(tokens.input), output: count(tokens.output), cacheRead: count(obj(tokens.cache)?.read), cacheWrite: count(obj(tokens.cache)?.write) })
    if (obj(head.error) && builder.turns.at(-1)) {
      const turn = builder.turns.at(-1)!
      turn.outcome = "failed"
      turn.error = { code: "imported", message: (str(obj(obj(head.error)!.data)?.message) ?? str(obj(head.error)!.name) ?? "failed in v1").slice(0, 4000) }
    }
  }
  return builder.finish({ sessionId: `mendcode-v1:${str(info.id) ?? ""}`, title: str(info.title) || firstPrompt || "MendCode v1 session", directory: str(info.directory) ?? "", exportedAt: time(obj(info.time)?.updated, ctx.now), ...(provider ? { provider } : {}) })
}

/** True for the JSON `mendcode export` of v1 wrote. */
export const isV1Export = (raw: unknown) => Boolean(obj(raw) && "info" in obj(raw)! && Array.isArray(obj(raw)!.messages))

export const foreignTranscript = (kind: ForeignKind, text: string, ctx: Ctx) => kind === "claude-code" ? claudeCodeTranscript(text, ctx) : codexTranscript(text, ctx)
