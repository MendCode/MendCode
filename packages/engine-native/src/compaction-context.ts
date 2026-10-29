import type { BlobRef } from "@mendcode/protocol"
import { SUMMARY_PREFIX } from "./compaction-policy"
import { ENGINE_ANCHOR_HEADING } from "./compaction-summary"
import type { ModelMessage, ToolCall } from "./provider"

const REQUEST_MAX_CHARS = 2_500
const TAIL_MAX_MESSAGES = 12
const TAIL_PART_MAX_CHARS = 900
const TAIL_TOOL_OUTPUT_MAX_CHARS = 700
const OPERATIONAL_MAX_MESSAGES = 24
const OPERATIONAL_MAX_ITEMS = 18
const OPERATIONAL_OUTPUT_MAX_CHARS = 1_200
const SUBAGENT_MAX_TASKS = 12
const SUBAGENT_OUTPUT_MAX_CHARS = 2_500
const IMAGE_CONTEXT_MAX_ITEMS = 12
const NEARBY_TEXT_MAX_CHARS = 600
const TODO_MAX_ITEMS = 50
/** Images of the compacted turns that go back into the context with the summary (v1: ten). */
export const RESUME_IMAGE_MAX_ITEMS = 10
export const RESUME_IMAGE_MAX_BYTES = 20 * 1024 * 1024
const TRANSCRIPT_TEXT_MAX_CHARS = 64 * 1024
const TRANSCRIPT_TOOL_OUTPUT_MAX_CHARS = 32 * 1024
const TRANSCRIPT_ARGS_MAX_CHARS = 16 * 1024
const TRANSCRIPT_MAX_CHARS = 4 * 1024 * 1024

type ToolResult = Extract<ModelMessage, { role: "tool" }>
type ToolStatus = "completed" | "error" | "pending"

/** Keeps the start and the latest tail of a long text, saying how much is gone. */
export function compactText(text: string, maxChars: number) {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  const marker = `\n[truncated: omitted ${trimmed.length - maxChars} chars; showing start and latest tail]\n`
  const budget = Math.max(0, maxChars - marker.length)
  if (budget <= 0) return trimmed.slice(-maxChars)
  const head = Math.floor(budget / 3)
  return `${trimmed.slice(0, head)}${marker}${trimmed.slice(trimmed.length - (budget - head))}`
}

export function compactTextHead(text: string, maxChars: number) {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  const marker = `\n[truncated: omitted ${trimmed.length - maxChars} chars; showing initial context only]\n`
  const budget = Math.max(0, maxChars - marker.length)
  return budget <= 0 ? trimmed.slice(0, maxChars) : `${trimmed.slice(0, budget)}${marker}`
}

const indent = (text: string, pad = "  ") => text.split("\n").filter(Boolean).map((line) => `${pad}${line}`).join("\n")

/** A user message the person wrote: not a summary, checkpoint or other engine-made turn. */
export const isRealUser = (message: ModelMessage): message is Extract<ModelMessage, { role: "user" }> => message.role === "user" && !message.compaction && !message.content.startsWith(SUMMARY_PREFIX)

export const latestRealUserIndex = (messages: readonly ModelMessage[]) => messages.findLastIndex(isRealUser)

const resultsByCall = (messages: readonly ModelMessage[]) => new Map(messages.filter((message): message is ToolResult => message.role === "tool").map((message) => [message.callId, message]))

const statusOf = (result: ToolResult | undefined): ToolStatus => (result ? (result.isError ? "error" : "completed") : "pending")

function argsSummary(args: unknown) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return ""
  const record = args as Record<string, unknown>
  const picked = ["command", "cmd", "cwd", "path", "filePath", "file", "pattern", "url", "description"].flatMap((key) => {
    const value = record[key]
    return typeof value === "string" && value.trim() ? [`${key}=${JSON.stringify(value.trim())}`] : []
  })
  if (picked.length) return picked.join(" ")
  try {
    const json = JSON.stringify(args)
    return json && json !== "{}" ? compactText(json, 500) : ""
  } catch {
    return ""
  }
}

export function latestUserRequestContext(messages: readonly ModelMessage[]): string[] {
  const index = latestRealUserIndex(messages)
  if (index < 0) return []
  const latest = messages[index]
  if (latest?.role !== "user") return []
  const turn = messages.slice(0, index + 1).filter(isRealUser).length
  const text = compactTextHead(latest.content, REQUEST_MAX_CHARS) || "(empty user message)"
  return [[
    "Latest Real User Request Evidence:",
    `- turn: ${turn} of ${messages.filter(isRealUser).length} real user turns in the history below`,
    "- text:",
    indent(text),
    "",
    "Use this as the source of truth for Request Trace. Compare completed work and remaining work against this request, not against assistant confidence.",
  ].join("\n")]
}

const LANGUAGE_MARKERS = {
  Spanish: ["el", "la", "los", "las", "que", "para", "por", "cuando", "tambien", "usuario", "compactar", "revisar", "arregla", "solo", "esto", "quiero", "necesito", "termina", "flujo", "trabajo"],
  Portuguese: ["que", "para", "por", "quando", "usuario", "compactar", "revisar", "corrija", "isso", "quero", "preciso", "termina", "trabalho", "fluxo"],
  French: ["le", "la", "les", "que", "pour", "quand", "utilisateur", "compacter", "revoir", "corrige", "cela", "veux", "besoin", "termine"],
  German: ["der", "die", "das", "und", "fur", "wenn", "benutzer", "kompaktieren", "prufen", "behebe", "dies", "mochte", "brauche", "fertig"],
  Italian: ["il", "la", "gli", "le", "che", "per", "quando", "utente", "compattare", "rivedere", "sistema", "questo", "voglio", "bisogno", "finisci"],
  English: ["the", "and", "for", "when", "user", "compact", "review", "fix", "this", "want", "need", "finish", "continue"],
} as const

export function latestUserLanguage(messages: readonly ModelMessage[]) {
  const latest = messages[latestRealUserIndex(messages)]
  if (latest?.role !== "user") return "infer it from the conversation"
  const normalized = ` ${latest.content.toLocaleLowerCase().normalize("NFD").replace(/\p{Mark}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ")} `
  const best = Object.entries(LANGUAGE_MARKERS)
    .map(([language, markers]) => ({ language, score: markers.reduce((total, marker) => total + (normalized.includes(` ${marker} `) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score)[0]
  return best && best.score >= 2 ? best.language : "the dominant language of the latest real user message"
}

export const languageContinuityContext = (messages: readonly ModelMessage[]): string[] => [[
  "Language Continuity:",
  `- Latest real user language hint: ${latestUserLanguage(messages)}.`,
  "- Write summary prose, progress, status and the next action in that language.",
  "- Never switch to English merely because the template or internal instructions are in English.",
  "- Keep code, file paths, commands, identifiers and exact error strings unchanged.",
].join("\n")]

const isImage = (ref: BlobRef) => ref.mime.startsWith("image/")

export function imageAttachmentContext(messages: readonly ModelMessage[]): string[] {
  const images = messages.flatMap((message, index) => message.role === "user" ? (message.attachments ?? []).filter(isImage).map((ref) => ({ message, ref, turn: messages.slice(0, index + 1).filter(isRealUser).length })) : [])
  if (!images.length) return []
  const recent = images.slice(-IMAGE_CONTEXT_MAX_ITEMS)
  const omitted = images.length - recent.length
  return [[
    "Image Attachment Context:",
    "- If the image binaries are part of your input, inspect them and keep the relevant visual facts without inventing details; otherwise keep these references in the summary.",
    "- Descriptions come from attachment metadata and the surrounding user text; they are not vision-generated captions.",
    omitted > 0 ? `- Older image attachments omitted from this context: ${omitted}` : undefined,
    ...recent.map(({ message, ref, turn }) => {
      const nearby = compactText(message.content, NEARBY_TEXT_MAX_CHARS)
      return [
        `- turn ${turn}: ${ref.name ?? "clipboard"} (${ref.mime}, ${ref.bytes} bytes, sha256 ${ref.sha256.slice(0, 12)})`,
        `  nearbyUserText: ${nearby ? nearby.replaceAll("\n", " ") : "(none)"}`,
        "  visualContent: do not call the image irrelevant just because only a placeholder is visible; say what is unavailable.",
      ].join("\n")
    }),
  ].filter(Boolean).join("\n")]
}

/** The newest distinct images of the compacted turns that the retained tail does not already carry. */
export function resumeImageRefs(head: readonly ModelMessage[], tail: readonly ModelMessage[]): BlobRef[] {
  const inTail = new Set(tail.flatMap((message) => message.role === "user" ? (message.attachments ?? []).map((ref) => ref.sha256) : []))
  const seen = new Set<string>()
  const picked: BlobRef[] = []
  let bytes = 0
  for (const message of head.toReversed()) {
    if (message.role !== "user") continue
    for (const ref of (message.attachments ?? []).toReversed()) {
      if (!isImage(ref) || inTail.has(ref.sha256) || seen.has(ref.sha256)) continue
      seen.add(ref.sha256)
      if (bytes + ref.bytes > RESUME_IMAGE_MAX_BYTES) continue
      bytes += ref.bytes
      picked.push(ref)
      if (picked.length === RESUME_IMAGE_MAX_ITEMS) return picked.toReversed()
    }
  }
  return picked.toReversed()
}

export const isFinalAssistant = (message: ModelMessage | undefined) => message?.role === "assistant" && message.toolCalls.length === 0 && message.content.trim().length > 0

export function assistantPhaseContext(messages: readonly ModelMessage[]): string[] {
  const index = messages.findLastIndex((message) => message.role === "assistant")
  if (index < 0) return []
  const assistant = messages[index]
  if (assistant?.role !== "assistant") return []
  const results = resultsByCall(messages.slice(index + 1))
  const statuses = assistant.toolCalls.map((call) => ({ call, status: statusOf(results.get(call.callId)) }))
  const unfinished = statuses.filter(({ status }) => status === "pending")
  const final = isFinalAssistant(assistant)
  const later = messages.slice(index + 1)
  const last = statuses.at(-1)
  return [[
    "Latest Assistant Phase Context:",
    `- hasFinalText: ${assistant.content.trim() ? "yes" : "no"}`,
    `- toolCount: ${statuses.length}`,
    `- toolStatuses: ${statuses.length ? statuses.map(({ call, status }) => `${call.name}:${status}`).join(", ") : "(none)"}`,
    last ? `- lastTool: ${last.call.name} (${last.status})` : "- lastTool: (none)",
    `- unfinishedTools: ${unfinished.length ? unfinished.map(({ call }) => call.name).join(", ") : "(none)"}`,
    `- realUserInputAfterAssistant: ${later.some(isRealUser) ? "yes" : "no"}`,
    final ? "- Interpretation: this assistant turn can be treated as final only if Request Trace and verification evidence show the latest request was actually satisfied." : "- Interpretation: this assistant turn is not final. Do not mark Progress Against Latest Request complete. Put any pending handoff, pending response, pending verification or continue-tools work under Still required.",
  ].join("\n")]
}

export function compactionTriggerContext(input: { reason: "auto" | "manual"; messages: readonly ModelMessage[] }): string[] {
  const last = input.messages.findLast((message) => message.role === "assistant")
  const final = isFinalAssistant(last)
  return [[
    "Compaction Trigger:",
    `- reason: ${input.reason}`,
    final || !last ? "- Interpretation: compaction ran after a final assistant turn; only continue if Still required or Active Work says required work remains." : "- Interpretation: compaction interrupted a non-final assistant turn. Do not mark the latest request complete unless the preserved tail or transcript proves every required action and verification finished.",
  ].join("\n")]
}

function tailPart(message: ModelMessage, results: Map<string, ToolResult>) {
  if (message.role === "user") {
    const refs = (message.attachments ?? []).map((ref) => `${ref.name ?? "attachment"} (${ref.mime})`)
    return [`text:\n${compactText(message.content, TAIL_PART_MAX_CHARS)}`, refs.length ? `attachments: ${refs.join(", ")}` : undefined].filter(Boolean).join("\n")
  }
  if (message.role === "tool") return `output (${message.isError ? "error" : "completed"}):\n${compactText(message.output, TAIL_TOOL_OUTPUT_MAX_CHARS)}`
  const calls = message.toolCalls.map((call) => {
    const result = results.get(call.callId)
    const args = argsSummary(call.args)
    return `tool ${call.name} - ${statusOf(result)}${args ? ` - ${args}` : ""}`
  })
  return [message.content.trim() ? `text:\n${compactText(message.content, TAIL_PART_MAX_CHARS)}` : undefined, ...calls].filter(Boolean).join("\n")
}

export function preservedTailSnapshotContext(tail: readonly ModelMessage[]): string[] {
  if (!tail.length) return []
  const recent = tail.slice(-TAIL_MAX_MESSAGES)
  const omitted = tail.length - recent.length
  const results = resultsByCall(tail)
  const lines = [
    "Preserved Recent Tail Snapshot:",
    "- Meaning: this is the exact recent conversation slice kept verbatim after the summary. Treat it as the best evidence of what was happening immediately before compaction.",
    "- If the latest user request, unfinished assistant work, running tools or verification gaps appear here, preserve them under Request Trace, Resume Anchor, Session State Snapshot and Relevant Files.",
    omitted > 0 ? `- Older preserved tail messages omitted from this snapshot: ${omitted}` : undefined,
  ].filter((line): line is string => line !== undefined)
  for (const message of recent) {
    lines.push(`- ${message.role}`)
    const part = tailPart(message, results)
    if (part) lines.push(indent(part, "    "))
  }
  return [lines.join("\n")]
}

export function recentOperationalContext(messages: readonly ModelMessage[]): string[] {
  const window = messages.slice(-OPERATIONAL_MAX_MESSAGES)
  const results = resultsByCall(window)
  const items: string[] = []
  for (const message of window) {
    if (message.role !== "assistant") continue
    for (const call of message.toolCalls) {
      if (call.name === "task") continue
      const result = results.get(call.callId)
      const args = argsSummary(call.args)
      const output = result ? compactText(result.output, OPERATIONAL_OUTPUT_MAX_CHARS) : "Tool did not finish."
      items.push([`- ${call.name} - ${statusOf(result)}${args ? ` - ${args}` : ""}`, indent(output)].filter(Boolean).join("\n"))
    }
  }
  const recent = items.slice(-OPERATIONAL_MAX_ITEMS)
  if (!recent.length) return []
  return [["Recent Operational Context:", ...recent, "", "Use this as first-class state evidence for commands, files, directories, saved tool-output paths, failed or unfinished tools and the next required action."].join("\n")]
}

function taskEvidence(output: string) {
  return output.split("\n").filter((line) => !/^\s*task_(?:id|status|generation|revision|source):/i.test(line)).map((line) => line.replace(/^\s*<\/?task_result>\s*$/i, "")).join("\n").trim()
}

const stringArg = (call: ToolCall, key: string) => {
  const value = call.args !== null && typeof call.args === "object" ? (call.args as Record<string, unknown>)[key] : undefined
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function subagentTaskContext(messages: readonly ModelMessage[]): string[] {
  const results = resultsByCall(messages)
  const tasks: string[] = []
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const call of message.toolCalls) {
      if (call.name !== "task") continue
      const result = results.get(call.callId)
      const output = result?.output ?? ""
      const taskId = stringArg(call, "task_id") ?? output.match(/^\s*task_id:\s*(\S+)/im)?.[1]
      tasks.push([
        `- ${stringArg(call, "description") ?? "subagent task"} (${stringArg(call, "subagent_type") ?? stringArg(call, "agent") ?? "unknown"}) - ${statusOf(result)}`,
        taskId ? `  task_id: ${taskId}` : undefined,
        indent(compactText(taskEvidence(output), SUBAGENT_OUTPUT_MAX_CHARS)),
      ].filter(Boolean).join("\n"))
    }
  }
  const recent = tasks.slice(-SUBAGENT_MAX_TASKS)
  if (!recent.length) return []
  return [["Subagent Task Context (supplemental output evidence only):", ...recent, "", "Use subagent outputs as first-class evidence for concrete results, blockers, changed files and unfinished work. A task still pending or without output is active work: check it with task_status before treating it as done or lost."].join("\n")]
}

export type Todo = { text: string; status: string; priority?: string }

/** The agent's current list: the last `todo` call, which replaces every earlier one. */
export function currentTodos(messages: readonly ModelMessage[]): Todo[] {
  for (const message of messages.toReversed()) {
    if (message.role !== "assistant") continue
    const call = message.toolCalls.findLast((candidate) => candidate.name === "todo")
    if (!call) continue
    const items = call.args !== null && typeof call.args === "object" ? (call.args as { items?: unknown }).items : undefined
    if (!Array.isArray(items)) return []
    return items.flatMap((item): Todo[] => {
      if (item === null || typeof item !== "object") return []
      const { text, status, priority } = item as Record<string, unknown>
      return typeof text === "string" && typeof status === "string" ? [{ text, status, ...(typeof priority === "string" ? { priority } : {}) }] : []
    }).slice(0, TODO_MAX_ITEMS)
  }
  return []
}

export const openTodos = (todos: readonly Todo[]) => todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress")

export function todoContext(messages: readonly ModelMessage[]): string[] {
  const todos = currentTodos(messages)
  if (!todos.length) return []
  return [["Current TODO List:", ...todos.map((todo, index) => `${index + 1}. [${todo.status}]${todo.priority ? ` (${todo.priority})` : ""} ${todo.text}`), "", "Use TODOs as state evidence, not as automatic instructions. Pending or in-progress items only become Active Work when consistent with the latest explicit user request."].join("\n")]
}

export function transcriptReferenceContext(path: string | undefined): string[] {
  if (!path) return []
  return [["Full Transcript Reference:", `- markdown: ${path}`, "- This file is the local full-session transcript at compaction time.", "- If the summary is unclear, incomplete or conflicts with recent messages, inspect it before continuing.", "- Use it to recover exact user requests, assistant claims, command inputs, tool statuses, file paths and saved output paths."].join("\n")]
}

/** The whole history as bounded Markdown, for the local file the summary points to. Callers redact secrets before writing it. */
export function renderTranscript(messages: readonly ModelMessage[], header: { sessionId: string; generation: number }): string {
  const results = resultsByCall(messages)
  const fence = (value: string) => `\`\`\`\n${value.replaceAll("```", "'''")}\n\`\`\``
  const body = messages.map((message, index) => {
    if (message.role === "user") return `## ${index + 1}. user${message.compaction || message.content.startsWith(SUMMARY_PREFIX) ? " (earlier summary)" : ""}\n\n${compactText(message.content, TRANSCRIPT_TEXT_MAX_CHARS)}${message.attachments?.length ? `\n\nAttachments: ${message.attachments.map((ref) => `${ref.name ?? "attachment"} (${ref.mime}, sha256 ${ref.sha256})`).join(", ")}` : ""}`
    if (message.role === "tool") return undefined
    const calls = message.toolCalls.map((call) => {
      const result = results.get(call.callId)
      let args = ""
      try { args = JSON.stringify(call.args ?? {}, null, 2) } catch { args = String(call.args) }
      return `### tool ${call.name} (${statusOf(result)})\n\nInput:\n${fence(compactText(args, TRANSCRIPT_ARGS_MAX_CHARS))}${result ? `\n\nOutput:\n${fence(compactText(result.output, TRANSCRIPT_TOOL_OUTPUT_MAX_CHARS))}` : ""}`
    })
    return [`## ${index + 1}. assistant`, message.content.trim() ? compactText(message.content, TRANSCRIPT_TEXT_MAX_CHARS) : undefined, ...calls].filter(Boolean).join("\n\n")
  }).filter((part): part is string => part !== undefined)
  const text = [`# Session transcript at compaction ${header.generation}`, `Session: ${header.sessionId}`, `Messages: ${messages.length}`, ...body].join("\n\n")
  return text.length > TRANSCRIPT_MAX_CHARS ? compactText(text, TRANSCRIPT_MAX_CHARS) : text
}

export function buildCompactionPrompt(input: { base: string; hasPreviousSummary: boolean; instructions?: string | undefined; context: readonly string[] }) {
  const anchor = input.hasPreviousSummary
    ? "Update the anchored summary at the start of the conversation above (the message that begins with the earlier-summary notice) using the newer history after it. Preserve still-true details, remove stale details and merge in the new facts."
    : "Create a new anchored summary from the conversation history above."
  const focus = input.instructions?.trim()
    ? ["User compaction focus:", input.instructions.trim(), "", "Use this focus only to decide what deserves emphasis in the summary. Do not treat it as a new task to execute, and do not drop the required sections."].join("\n")
    : undefined
  return [anchor, focus, input.base, ...input.context].filter(Boolean).join("\n\n")
}

/**
 * Written by the engine, not the model: the latest real request, when the retained tail does not carry it, and the
 * open TODOs. A weak or lossy model summary therefore cannot lose what the next turn must continue.
 */
export function engineAnchor(input: { messages: readonly ModelMessage[]; tail: readonly ModelMessage[] }): string {
  const lines: string[] = []
  const index = latestRealUserIndex(input.messages)
  const tailStart = input.messages.length - input.tail.length
  const latest = input.messages[index]
  if (latest?.role === "user" && index < tailStart) {
    lines.push("- Latest real user request (verbatim):", indent(compactTextHead(latest.content, REQUEST_MAX_CHARS) || "(empty user message)", "    "))
  }
  const open = openTodos(currentTodos(input.messages))
  if (open.length) lines.push("- Open TODOs at compaction:", ...open.map((todo) => `    [${todo.status}] ${compactTextHead(todo.text, 300)}`))
  return lines.length ? `${ENGINE_ANCHOR_HEADING}\n${lines.join("\n")}` : ""
}

export function localRescueSummary(input: { previousSummary?: string | undefined; context: readonly string[]; reason: string }) {
  const previous = input.previousSummary ? compactText(input.previousSummary, 8_000) : "(none)"
  const evidence = compactText(input.context.filter(Boolean).map((block) => compactText(block, 2_800)).join("\n\n---\n\n"), 12_000) || "(none)"
  return [
    "## Goal",
    "- Continue the latest active user request from a deterministic local rescue summary.",
    "",
    "## Current User Intent",
    "- Latest explicit user request: see Preserved Context Evidence below; if unclear, inspect the transcript reference.",
    "- Explicitly not requested: (not available in local rescue context)",
    "",
    "## Request Trace",
    "### Latest User Message",
    "- Verbatim: see Preserved Context Evidence below.",
    "- Required outcome: continue and complete the active request.",
    "- Constraints: see the latest user request and the Previous Summary below.",
    "",
    "### Progress Against Latest Request",
    "- Completed: see Previous Summary and Preserved Context Evidence below.",
    "- In progress: continue from TODOs, active assistant/tool state and the preserved recent context below.",
    "- Still required: finish the latest explicit user request; inspect the transcript if this rescue summary is insufficient.",
    "- Verification status: local rescue summary only; downstream work still needs normal verification.",
    "",
    "## Resume Anchor",
    "### Active Work",
    "- Current task in progress: see Preserved Context Evidence and Previous Summary below.",
    "- Last completed action: a local rescue summary was written instead of a model summary.",
    "- Next required action: continue from the latest in-progress or pending work preserved below.",
    "",
    "### Blocked / Needs User",
    "- (none known from local rescue context)",
    "",
    "## Confirmed Done",
    "- See Previous Summary and Preserved Context Evidence below.",
    "",
    "## Key Decisions",
    "- (none recorded by the local rescue)",
    "",
    "## Optional Follow-ups",
    "- (none)",
    "",
    "## Critical Context",
    `- Local rescue reason: ${input.reason}`,
    "- Previous Summary:",
    previous,
    "",
    "## Commands / Evidence",
    "- Preserved Context Evidence below was collected locally before the rescue.",
    "",
    "## Session State Snapshot",
    "- TODOs / subagents / tool state: see Preserved Context Evidence below.",
    "- Running or failed tools: see Preserved Context Evidence below.",
    "- Active files / directories: see Preserved Context Evidence below.",
    "",
    "## Transcript Reference",
    "- Full transcript: see Preserved Context Evidence below.",
    "- Use when: the rescue summary is ambiguous or misses exact tool output or file paths.",
    "",
    "## Relevant Files",
    "- See Preserved Context Evidence below.",
    "",
    "## Preserved Context Evidence",
    evidence,
  ].join("\n")
}
