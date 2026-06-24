import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { mkdir, writeFile } from "fs/promises"
import * as Session from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import path from "path"
import { Token } from "@/util/token"
import * as Log from "@mendcode/core/util/log"
import { Global } from "@mendcode/core/global"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { Todo } from "./todo"
import { NotFoundError } from "@/storage/storage"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Layer, Context, Schema } from "effect"
import * as DateTime from "effect/DateTime"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { makeRuntime } from "@/effect/run-service"
import { fn } from "@/util/fn"
import { EventV2 } from "@/v2/event"
import { SessionEvent } from "@/v2/session-event"

const log = Log.create({ service: "session.compaction" })

export const Event = {
  Compacted: BusEvent.define(
    "session.compacted",
    Schema.Struct({
      sessionID: SessionID,
    }),
  ),
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const RECENT_OPERATIONAL_CONTEXT_MAX_MESSAGES = 24
const RECENT_OPERATIONAL_CONTEXT_MAX_ITEMS = 18
const RECENT_OPERATIONAL_CONTEXT_MAX_OUTPUT_CHARS = 1_200
const PRESERVED_TAIL_SNAPSHOT_MAX_MESSAGES = 12
const PRESERVED_TAIL_SNAPSHOT_MAX_PART_CHARS = 900
const PRESERVED_TAIL_SNAPSHOT_MAX_TOOL_OUTPUT_CHARS = 700
const SUBAGENT_CONTEXT_MAX_TASKS = 12
const SUBAGENT_CONTEXT_MAX_OUTPUT_CHARS = 2_500
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Current User Intent
- Latest explicit user request: [the latest direct ask, or "(none)"]
- Explicitly not requested: [things the user did not ask to continue/do, or "(none)"]

## Request Trace
### Latest User Message
- Verbatim: [quote or faithful paraphrase of the latest real user request]
- Required outcome: [what must be true for the request to be done]
- Constraints: [explicit constraints such as no push, no version bump, local only, or "(none)"]

### Progress Against Latest Request
- Completed: [evidence-backed work completed against the latest request, or "(none)"]
- In progress: [work started but not verified/finished, or "(none)"]
- Still required: [missing work required by the latest request, or "(none)"]
- Verification status: [tests/checks/commands already run and result, or "(none)"]

## Resume Anchor
### Active Work
- Current task in progress: [only work explicitly active before compaction, or "(none)"]
- Last completed action: [last concrete completed action, or "(none)"]
- Next required action: [required next step only, or "(none)"]

### Blocked / Needs User
- [blockers, unresolved required decisions, or "(none)"]

## Confirmed Done
- [completed work or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Optional Follow-ups
- [optional ideas only; do not execute unless the user explicitly asks, or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Commands / Evidence
- [recent command/tool/status/output path and what it proves, or "(none)"]

## Session State Snapshot
- TODOs: [in_progress/pending/completed TODO evidence relevant to the latest request, or "(none)"]
- Subagents / delegated work: [last known subagent/task outputs, blockers, changed files, or "(none)"]
- Running or failed tools: [tools that were running/failed/interrupted and their state, or "(none)"]
- Active files / directories: [paths most likely needed to continue, or "(none)"]

## Transcript Reference
- Full transcript: [local transcript path from context, or "(none)"]
- Use when: [why/when the next agent should inspect it, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Respond with the final Markdown summary only. Do not include prefaces, reasoning notes, status updates, analysis blocks, or commentary about what you are about to do.
- Compaction has no tools. Never request, simulate, print, or narrate tool calls. Do not output strings such as "to=...", "recipient_name", "parameters", "functions.*", "multi_tool_use.parallel", or XML/JSON tool invocation blocks. If a fact is not available in the supplied context, say "(not available in context)" and point to the Full Transcript Reference when present.
- Use concise but sufficiently detailed bullets. Do not collapse active state to one-liners when code paths, files, commands, outputs, tests, or blockers matter.
- The instruction "Create a new anchored summary..." or "Update the anchored summary..." is an internal summarization request. Never copy it into Current User Intent and never treat it as the user's latest explicit request.
- Current User Intent must come from the user's real conversation messages, not from this summary prompt.
- Request Trace is mandatory. Compare the latest user's required outcome against actual completed work, active tools, TODOs, and verification evidence. Do not mark work complete unless every required outcome is satisfied or the summary explicitly names the remaining gap.
- All user messages are evidence: preserve the latest real user message, major corrections, cancellations, constraints, and changed intent. Do not let older assistant plans override newer user corrections.
- Still required must include required unfinished work even if the previous assistant sounded confident or partially summarized completion.
- If the latest real user request was an implementation/debugging request and Active Work/TODO/subagents show unfinished work, Active Work must not be "(none)".
- If a command/tool was running, failed, interrupted, retried, or had output truncated/saved to a path, put that exact state under Running or failed tools and Commands / Evidence. Do not infer that it must be rerun unless the evidence says the required outcome is still missing.
- Convert older summaries into this format. Map old Progress/Done into Confirmed Done, old Progress/In Progress into Resume Anchor/Active Work, old Blocked into Blocked / Needs User, and old Next Steps into Active Work only when the latest user request or preserved tail makes them required; otherwise put them under Optional Follow-ups.
- Only list a Next required action when it is explicitly required by the latest user request or by unfinished active work.
- Treat Optional Follow-ups, possible next steps, polish, cleanup, and ideas as non-instructions.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Read the Full Transcript Reference when the preserved recent messages and summary disagree, when a tool output was truncated, or when Active Work/Still required is ambiguous.
- Read the Current TODO List context when present. Treat in_progress/pending TODOs as evidence for Resume Anchor / Active Work only when they match the latest user intent; completed/cancelled TODOs belong in Confirmed Done or Optional Follow-ups as appropriate.
- Read the Recent Operational Context when present. Commands, cwd, saved tool-output paths, running/failed tools, and verification output are evidence for Commands / Evidence, Relevant Files, and Progress Against Latest Request.
- Read the Subagent Task Context when present. Summarize each subagent's concrete output, files changed, blocker, or current status. Running/pending subagents are active work unless clearly stale or contradicted by a newer real user message.
- Session State Snapshot must preserve the actionable state from TODOs, subagents, running/failed tools, active files, and cwd even when it makes the summary longer.
- Do not mention the summary process or that context was compacted.`
const COMPACTION_RESUME_PROMPT = `The conversation hit a context overflow while handling the current request, so the conversation was compacted.

Resume using this priority:
1. Latest explicit user request from the preserved recent messages.
2. Request Trace and Progress Against Latest Request from the summary.
3. Resume Anchor / Active Work from the summary.
4. Critical Context, Commands / Evidence, and Transcript Reference from the summary.
5. Older summary details.

Overflow compaction is a pause, not a user cancellation. If the latest explicit user request or Resume Anchor / Active Work describes unfinished implementation, debugging, review, testing, or investigation, continue exactly from the next required action or the safest required next step.
Optional Follow-ups are not instructions. Do not execute optional ideas, possible next steps, cleanup, polish, or suggestions unless the user explicitly asked for them after compaction.
Stop only when the summary clearly says the work is complete, blocked, or there is no active user request to continue.
If Still required conflicts with a confident previous assistant message, trust Still required and the transcript evidence.
Do not ask for confirmation before continuing required active work. Ask a concise clarification only when Blocked / Needs User contains a real blocker or the required next action cannot be inferred from the latest user request, Request Trace, Active Work, TODOs, Critical Context, or the transcript reference.`
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

const REQUIRED_SUMMARY_HEADINGS = [
  "## Goal",
  "## Current User Intent",
  "## Request Trace",
  "## Resume Anchor",
  "## Session State Snapshot",
  "## Transcript Reference",
  "## Relevant Files",
]

const TOOL_CALL_COSPLAY_PATTERNS = [
  /^\s*to=[\w.-]+/im,
  /\bmulti_tool_use\.parallel\b/,
  /"recipient_name"\s*:\s*"[^"]+"/,
  /"parameters"\s*:\s*\{/,
  /\bfunctions\.[a-zA-Z_][\w.-]*\b/,
  /<tool_call\b/i,
  /<\/tool_call>/i,
]

function looksLikeStructuredCompactionSummary(text: string) {
  return REQUIRED_SUMMARY_HEADINGS.every((heading) => text.includes(heading))
}

function looksLikeToolCallCosplay(text: string) {
  return TOOL_CALL_COSPLAY_PATTERNS.some((pattern) => pattern.test(text))
}

export function extractCompactionSummaryText(message: MessageV2.WithParts) {
  const texts = message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
  const structured = texts.findLast((text) => looksLikeStructuredCompactionSummary(text))
  if (structured) return structured
  const text = texts
    .filter((item) => !looksLikeToolCallCosplay(item))
    .join("\n\n")
    .trim()
  return text || undefined
}

function summaryText(message: MessageV2.WithParts) {
  return extractCompactionSummaryText(message)
}

function messageText(message: MessageV2.WithParts) {
  return message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

function completedCompactions(messages: MessageV2.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function safePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_")
}

function fence(lang: string, value: string) {
  return [`\`\`\`${lang}`, value.replaceAll("```", "``\\`"), "```"].join("\n")
}

function stringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function toolOutputForTranscript(state: MessageV2.ToolState) {
  if (state.status === "completed") return state.output
  if (state.status === "error") return state.metadata?.output ?? state.error
  if (state.status === "running" || state.status === "pending") return `Tool is still ${state.status}.`
  return ""
}

function transcriptPart(part: MessageV2.Part) {
  switch (part.type) {
    case "text":
      return [`#### text ${part.id}${part.synthetic ? " (synthetic)" : ""}`, part.text].join("\n\n")
    case "reasoning":
      return [`#### reasoning ${part.id}`, part.text].join("\n\n")
    case "tool":
      return [
        `#### tool ${part.tool} ${part.id}`,
        `callID: ${part.callID}`,
        `status: ${part.state.status}`,
        "",
        "input:",
        fence("json", stringify(part.state.input)),
        "",
        "output:",
        fence("text", toolOutputForTranscript(part.state)),
      ].join("\n")
    case "file":
      return [
        `#### file ${part.id}`,
        `mime: ${part.mime}`,
        part.filename ? `filename: ${part.filename}` : undefined,
        `url: ${part.url}`,
        part.source ? ["source:", fence("json", stringify(part.source))].join("\n") : undefined,
      ]
        .filter(Boolean)
        .join("\n")
    case "compaction":
      return [
        `#### compaction ${part.id}`,
        `auto: ${part.auto}`,
        `overflow: ${part.overflow ?? false}`,
        `resume: ${part.resume ?? false}`,
        part.tail_start_id ? `tail_start_id: ${part.tail_start_id}` : undefined,
        part.instructions ? ["instructions:", fence("text", part.instructions)].join("\n") : undefined,
      ]
        .filter(Boolean)
        .join("\n")
    case "patch":
      return [`#### patch ${part.id}`, `hash: ${part.hash}`, "files:", ...part.files.map((file) => `- ${file}`)].join("\n")
    case "snapshot":
      return [`#### snapshot ${part.id}`, part.snapshot].join("\n\n")
    case "step-start":
      return [`#### step-start ${part.id}`, part.snapshot ? `snapshot: ${part.snapshot}` : ""].join("\n").trim()
    case "step-finish":
      return [
        `#### step-finish ${part.id}`,
        `reason: ${part.reason}`,
        `tokens: ${stringify(part.tokens)}`,
        part.snapshot ? `snapshot: ${part.snapshot}` : undefined,
      ]
        .filter(Boolean)
        .join("\n")
    case "agent":
      return [`#### agent ${part.id}`, `name: ${part.name}`, part.source ? fence("json", stringify(part.source)) : ""]
        .filter(Boolean)
        .join("\n\n")
    case "subtask":
      return [
        `#### subtask ${part.id}`,
        `agent: ${part.agent}`,
        `description: ${part.description}`,
        part.command ? `command: ${part.command}` : undefined,
        "",
        fence("text", part.prompt),
      ]
        .filter(Boolean)
        .join("\n")
    case "retry":
      return [`#### retry ${part.id}`, `attempt: ${part.attempt}`, fence("json", stringify(part.error))].join("\n\n")
    default:
      return [`#### part ${(part as any).id ?? "(unknown)"}`, fence("json", stringify(part))].join("\n\n")
  }
}

function transcriptMarkdown(input: {
  sessionID: SessionID
  parentID: MessageID
  messages: MessageV2.WithParts[]
  cwd?: string
  root?: string
}) {
  const header = [
    "# MendCode Full Session Transcript",
    "",
    `sessionID: ${input.sessionID}`,
    `compactionParentID: ${input.parentID}`,
    `generatedAt: ${new Date().toISOString()}`,
    input.cwd ? `cwd: ${input.cwd}` : undefined,
    input.root ? `root: ${input.root}` : undefined,
    "",
    "Use this file when the compaction summary is ambiguous, when a command output was truncated, or when the next action is unclear.",
  ].filter(Boolean)

  const body = input.messages.flatMap((message, index) => {
    const info = message.info
    return [
      "",
      `## ${index + 1}. ${info.role} ${info.id}`,
      "",
      `createdAt: ${new Date(info.time.created).toISOString()}`,
      "agent" in info && info.agent ? `agent: ${info.agent}` : undefined,
      "modelID" in info && info.modelID ? `model: ${info.providerID}/${info.modelID}` : undefined,
      "finish" in info && info.finish ? `finish: ${info.finish}` : undefined,
      "error" in info && info.error ? ["error:", fence("json", stringify(info.error))].join("\n") : undefined,
      "",
      ...message.parts.map(transcriptPart),
    ].filter((item): item is string => typeof item === "string")
  })

  return [...header, ...body, ""].join("\n")
}

function transcriptPaths(sessionID: SessionID, parentID: MessageID) {
  const dir = path.join(Global.Path.data, "session-transcripts", safePathSegment(sessionID))
  return {
    dir,
    snapshot: path.join(dir, `${safePathSegment(parentID)}.md`),
    latest: path.join(dir, "latest.md"),
  }
}

function writeTranscript(input: {
  sessionID: SessionID
  parentID: MessageID
  messages: MessageV2.WithParts[]
  cwd?: string
  root?: string
}) {
  return Effect.promise(async () => {
    const target = transcriptPaths(input.sessionID, input.parentID)
    const content = transcriptMarkdown(input)
    await mkdir(target.dir, { recursive: true })
    await writeFile(target.snapshot, content)
    await writeFile(target.latest, content)
    return target.latest
  })
}

function latestUserRequestContext(messages: MessageV2.WithParts[]) {
  const latest = messages.findLast((msg) => msg.info.role === "user" && !msg.parts.some((part) => part.type === "compaction"))
  if (!latest) return []
  const text = compactText(messageText(latest), 2_500) || "(empty user message)"
  return [
    [
      "Latest Real User Request Evidence:",
      `- messageID: ${latest.info.id}`,
      `- createdAt: ${new Date(latest.info.time.created).toISOString()}`,
      "- text:",
      ...text.split("\n").map((line) => `  ${line}`),
      "",
      "Use this as the source of truth for Request Trace. Compare completed work and remaining work against this request, not against assistant confidence.",
    ].join("\n"),
  ]
}

function transcriptReferenceContext(filepath: string | undefined) {
  if (!filepath) return []
  return [
    [
      "Full Transcript Reference:",
      `- markdown: ${filepath}`,
      "- This file is the local full-session transcript at compaction time.",
      "- If the summary is unclear, incomplete, or conflicts with recent messages, inspect this transcript before continuing.",
      "- Use it to recover exact user requests, assistant claims, command inputs, tool statuses, file paths, and saved output paths.",
    ].join("\n"),
  ]
}

function compactionTriggerContext(input: {
  compactionPart?: MessageV2.CompactionPart
  messages: MessageV2.WithParts[]
}) {
  const part = input.compactionPart
  if (!part?.auto || !part.overflow) return []
  const trigger = part.tail_start_id
    ? input.messages.find((message) => message.info.id === part.tail_start_id)
    : input.messages.findLast((message) => message.info.role === "assistant" && message.info.summary !== true)
  if (!trigger || trigger.info.role !== "assistant") return []
  const finish = trigger.info.finish
  const isFinal = finish === "stop" || finish === "end_turn"
  const activeTools = trigger.parts.filter(
    (item) => item.type === "tool" && item.state.status !== "completed" && item.state.status !== "error",
  )
  return [
    [
      "Auto-Compaction Trigger:",
      `- interruptedAssistantMessageID: ${trigger.info.id}`,
      `- finish: ${finish ?? "(none)"}`,
      part.tail_start_id ? `- preservedTailStartID: ${part.tail_start_id}` : undefined,
      activeTools.length ? `- activeToolParts: ${activeTools.map((item) => item.id).join(", ")}` : undefined,
      isFinal
        ? "- Interpretation: this compaction happened after a final assistant turn; only continue if Still required or Active Work says required work remains."
        : "- Interpretation: this compaction interrupted a non-final assistant turn. Do not mark the latest request complete unless the preserved tail or transcript proves every required action and verification finished.",
    ].filter(Boolean).join("\n"),
  ]
}

function buildPrompt(input: { previousSummary?: string; context: string[]; instructions?: string }) {
  const anchor = input.previousSummary
    ? [
        "Update the anchored summary below using the conversation history above.",
        "Preserve still-true details, remove stale details, and merge in the new facts.",
        "<previous-summary>",
        input.previousSummary,
        "</previous-summary>",
      ].join("\n")
    : "Create a new anchored summary from the conversation history above."
  const instructions = input.instructions?.trim()
    ? [
        "User compaction focus:",
        input.instructions.trim(),
        "",
        "Use this focus only to decide what information deserves emphasis in the summary. Do not treat it as a new task to execute.",
      ].join("\n")
    : undefined
  return [anchor, instructions, SUMMARY_TEMPLATE, ...input.context].filter(Boolean).join("\n\n")
}

function todoContext(todos: Todo.Info[]) {
  if (!todos.length) return []
  return [
    [
      "Current TODO List:",
      ...todos.map((todo, index) => `${index + 1}. [${todo.status}] (${todo.priority}) ${todo.content}`),
      "",
      "Use TODOs as state evidence, not as automatic instructions. Pending or in-progress TODOs only become Active Work when consistent with the latest explicit user request.",
    ].join("\n"),
  ]
}

function toolInputValue(input: Record<string, any>, key: string) {
  const value = input[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function compactText(text: string, maxChars: number) {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}\n[truncated]`
}

function preservedTailPartSnapshot(part: MessageV2.Part) {
  if (part.type === "text" && !part.ignored) {
    return [
      `text${part.synthetic ? " (synthetic)" : ""}:`,
      compactText(part.text, PRESERVED_TAIL_SNAPSHOT_MAX_PART_CHARS),
    ].join("\n")
  }
  if (part.type === "reasoning") {
    return ["reasoning:", compactText(part.text, PRESERVED_TAIL_SNAPSHOT_MAX_PART_CHARS)].join("\n")
  }
  if (part.type === "tool") {
    const input = toolInputSummary(part.state.input)
    const output = compactText(toolStateOutput(part.state), PRESERVED_TAIL_SNAPSHOT_MAX_TOOL_OUTPUT_CHARS)
    const title =
      part.state.status === "running" || part.state.status === "completed" ? part.state.title : undefined
    return [
      `tool ${part.tool} - ${part.state.status}${input ? ` - ${input}` : ""}`,
      title ? `title: ${title}` : undefined,
      output ? `output:\n${output}` : undefined,
    ]
      .filter(Boolean)
      .join("\n")
  }
  if (part.type === "file") return `file: ${part.filename ?? part.mime} (${part.mime})`
  if (part.type === "patch") return `patch: ${part.files.join(", ")}`
  if (part.type === "step-start") return part.snapshot ? `step-start snapshot: ${part.snapshot}` : "step-start"
  if (part.type === "step-finish") {
    return [
      `step-finish: ${part.reason}`,
      `tokens: ${stringify(part.tokens)}`,
      part.snapshot ? `snapshot: ${part.snapshot}` : undefined,
    ]
      .filter(Boolean)
      .join("\n")
  }
  if (part.type === "subtask") {
    return [
      `subtask: ${part.description} (${part.agent})`,
      part.command ? `command: ${part.command}` : undefined,
      compactText(part.prompt, PRESERVED_TAIL_SNAPSHOT_MAX_PART_CHARS),
    ]
      .filter(Boolean)
      .join("\n")
  }
  if (part.type === "agent") return `agent: ${part.name}`
  if (part.type === "retry") return `retry attempt ${part.attempt}: ${stringify(part.error)}`
  if (part.type === "snapshot") return `snapshot: ${compactText(part.snapshot, PRESERVED_TAIL_SNAPSHOT_MAX_PART_CHARS)}`
  return ""
}

function preservedTailSnapshotContext(input: {
  messages: MessageV2.WithParts[]
  tailStartID: MessageID | undefined
}) {
  if (!input.tailStartID) return []
  const start = input.messages.findIndex((message) => message.info.id === input.tailStartID)
  if (start === -1) return []
  const preserved = input.messages.slice(start)
  const recent = preserved.slice(-PRESERVED_TAIL_SNAPSHOT_MAX_MESSAGES)
  const omitted = preserved.length - recent.length
  const lines = [
    "Preserved Recent Tail Snapshot:",
    `- tail_start_id: ${input.tailStartID}`,
    "- Meaning: this is the exact recent conversation slice kept after the summary. Treat it as the best evidence of what was happening immediately before compaction.",
    "- If the latest user request, unfinished assistant work, running tools, or verification gaps appear here, preserve them under Request Trace, Resume Anchor, Session State Snapshot, and Relevant Files.",
    omitted > 0 ? `- Older preserved tail messages omitted from this snapshot: ${omitted}` : undefined,
  ].filter(Boolean) as string[]

  for (const message of recent) {
    const finish = message.info.role === "assistant" ? ` finish=${message.info.finish ?? "(none)"}` : ""
    const parts = message.parts
      .map(preservedTailPartSnapshot)
      .filter(Boolean)
      .flatMap((part) => part.split("\n").map((line) => `  ${line}`))
    lines.push(`- ${message.info.role} ${message.info.id}${finish}`)
    if (parts.length) lines.push(...parts)
  }

  return [lines.join("\n")]
}

function toolStateOutput(state: MessageV2.ToolState) {
  if (state.status === "completed") return state.output
  if (state.status === "error") return state.metadata?.output ?? state.error
  if (state.status === "running" || state.status === "pending") return `Tool is still ${state.status}.`
  return ""
}

function toolInputSummary(input: Record<string, any>) {
  const keys = ["command", "cmd", "cwd", "path", "filePath", "file", "pattern", "url", "description"]
  const picked = keys.flatMap((key) => {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return [`${key}=${JSON.stringify(value.trim())}`]
    return []
  })
  if (picked.length) return picked.join(" ")
  try {
    const json = JSON.stringify(input)
    return json && json !== "{}" ? compactText(json, 500) : ""
  } catch {
    return ""
  }
}

function recentOperationalContext(messages: MessageV2.WithParts[]) {
  const items: string[] = []
  for (const msg of messages.slice(-RECENT_OPERATIONAL_CONTEXT_MAX_MESSAGES)) {
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool" || part.tool === "task") continue
      const input = toolInputSummary(part.state.input)
      const output = compactText(toolStateOutput(part.state), RECENT_OPERATIONAL_CONTEXT_MAX_OUTPUT_CHARS)
      items.push(
        [
          `- ${part.tool} - ${part.state.status}${input ? ` - ${input}` : ""}`,
          output
            .split("\n")
            .filter(Boolean)
            .map((line) => `  ${line}`)
            .join("\n"),
        ]
          .filter(Boolean)
          .join("\n"),
      )
    }
  }

  const recent = items.slice(-RECENT_OPERATIONAL_CONTEXT_MAX_ITEMS)
  if (!recent.length) return []
  return [
    [
      "Recent Operational Context:",
      ...recent,
      "",
      "Use recent operational context as first-class state evidence for commands, files, directories, saved tool-output paths, failed/running tools, and the next required action.",
    ].join("\n"),
  ]
}

function taskOutput(state: MessageV2.ToolState) {
  if (state.status === "completed") return state.output
  if (state.status === "error") return state.metadata?.output ?? state.error
  if (state.status === "running" || state.status === "pending") return `Task is still ${state.status}.`
  return ""
}

function subagentTaskContext(messages: MessageV2.WithParts[]) {
  const tasks: string[] = []
  for (const msg of messages) {
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool" || part.tool !== "task") continue
      const input = part.state.input
      const description = toolInputValue(input, "description") ?? "subagent task"
      const subagent = toolInputValue(input, "subagent_type") ?? "unknown"
      const output = taskOutput(part.state).trim()
      const excerpt =
        output.length > SUBAGENT_CONTEXT_MAX_OUTPUT_CHARS
          ? `${output.slice(0, SUBAGENT_CONTEXT_MAX_OUTPUT_CHARS)}\n[truncated]`
          : output
      tasks.push(
        [
          `- ${description} (${subagent}) — ${part.state.status}`,
          excerpt
            .split("\n")
            .filter(Boolean)
            .map((line: string) => `  ${line}`)
            .join("\n"),
        ]
          .filter(Boolean)
          .join("\n"),
      )
    }
  }

  const recent = tasks.slice(-SUBAGENT_CONTEXT_MAX_TASKS)
  if (!recent.length) return []
  return [
    [
      "Subagent Task Context:",
      ...recent,
      "",
      "Use subagent task outputs as first-class state evidence. Preserve concrete results, blockers, changed files, and unfinished/running work in the anchored summary.",
    ].join("\n"),
  ]
}

function preserveRecentBudget(input: { cfg: Config.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: MessageV2.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: MessageV2.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: MessageV2.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
    resume?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderID; modelID: ModelID }
    auto: boolean
    overflow?: boolean
    resume?: boolean
    instructions?: string
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Bus.Service
  | Config.Service
  | Session.Service
  | Agent.Service
  | Plugin.Service
  | SessionProcessor.Service
  | Provider.Service
  | Todo.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const todos = yield* Todo.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({ cfg: yield* config.get(), tokens: input.tokens, model: input.model })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: MessageV2.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: MessageV2.WithParts[]
      cfg: Config.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) log.info("tail fallback", { budget, size, total })
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      log.info("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: MessageV2.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      log.info("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        log.info("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: MessageV2.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
      resume?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")

      const messages = input.messages

      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const visibleHistory = history.filter((_, index) => !hidden.has(index))
      const selected = yield* select({
        messages: visibleHistory,
        cfg,
        model,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const persistedTodos = yield* todos.get(input.sessionID).pipe(Effect.catch(() => Effect.succeed([])))
      const summaryHistory = selected.head
      const ctx = yield* InstanceState.context
      const transcriptPath = yield* writeTranscript({
        sessionID: input.sessionID,
        parentID: input.parentID,
        messages: history,
        cwd: ctx.directory,
        root: ctx.worktree,
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            log.warn("failed to write compaction transcript", { error: String(error) })
            return undefined
          }),
        ),
      )
      const context = [
        ...latestUserRequestContext(visibleHistory),
        ...preservedTailSnapshotContext({ messages: visibleHistory, tailStartID: selected.tail_start_id }),
        ...transcriptReferenceContext(transcriptPath),
        ...compactionTriggerContext({ compactionPart, messages: history }),
        ...todoContext(persistedTodos),
        ...recentOperationalContext(visibleHistory),
        ...subagentTaskContext(visibleHistory),
        ...compacting.context,
      ]
      const nextPrompt =
        compacting.prompt ?? buildPrompt({ previousSummary, context, instructions: compactionPart?.instructions })
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const msg: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          ...modelMessages,
          {
            role: "user",
            content: [{ type: "text", text: nextPrompt }],
          },
        ],
        model,
      })

      if (result === "compact") {
        processor.message.error = new MessageV2.ContextOverflowError({
          message: "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      const resumeRequested = compactionPart?.resume ?? input.resume ?? (input.auto && input.overflow)
      let shouldResume = result === "continue" && resumeRequested === true

      if (shouldResume) {
        const info = yield* provider.getProvider(userMessage.model.providerID)
        if (
          (yield* plugin.trigger(
            "experimental.compaction.autocontinue",
            {
              sessionID: input.sessionID,
              agent: userMessage.agent,
              model: yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID),
              provider: {
                source: info.source,
                info,
                options: info.options,
              },
              message: userMessage,
              overflow: input.overflow === true,
            },
            { enabled: true },
          )).enabled
        ) {
          const continueMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: userMessage.agent,
            model: userMessage.model,
          })
          const text =
            "The previous request exceeded the provider's size or context limit, so the conversation was compacted. Continue from the summary and preserved recent messages. If attachments were removed from context, say so only when relevant to the user's request.\n\n" +
            COMPACTION_RESUME_PROMPT
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: continueMsg.id,
            sessionID: input.sessionID,
            type: "text",
            // Internal marker for auto-compaction followups so provider plugins
            // can distinguish them from manual post-compaction user prompts.
            // This is not a stable plugin contract and may change or disappear.
            metadata: { compaction_continue: true },
            synthetic: true,
            text,
            time: {
              start: Date.now(),
              end: Date.now(),
            },
          })
        } else {
          shouldResume = false
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        const summary = summaryText(
          (yield* session.messages({ sessionID: input.sessionID })).find((item) => item.info.id === msg.id) ?? {
            info: msg,
            parts: [],
          },
        )
        EventV2.run(SessionEvent.Compaction.Ended.Sync, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          text: summary ?? "",
          include: selected.tail_start_id,
        })
        yield* bus.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return shouldResume ? "continue" : "stop"
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
      resume?: boolean
      instructions?: string
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
        resume: input.resume ?? false,
        instructions: input.instructions?.trim() || undefined,
      })
      EventV2.run(SessionEvent.Compaction.Started.Sync, {
        sessionID: input.sessionID,
        timestamp: DateTime.makeUnsafe(Date.now()),
        reason: input.auto ? "auto" : "manual",
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Todo.defaultLayer),
  ),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  return runPromise((svc) => svc.isOverflow(input))
}

export async function prune(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.prune(input))
}

export const create = fn(
  z.object({
    sessionID: SessionID.zod,
    agent: z.string(),
    model: z.object({ providerID: ProviderID.zod, modelID: ModelID.zod }),
    auto: z.boolean(),
    overflow: z.boolean().optional(),
    resume: z.boolean().optional(),
    instructions: z.string().optional(),
  }),
  (input) => runPromise((svc) => svc.create(input)),
)

export * as SessionCompaction from "./compaction"
