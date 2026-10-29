import { estimateTokens, usageContext } from "@mendcode/protocol/wire"
import { explicitMemoryConsent, memoryWrite, restatesRequest } from "./memory-consent"
import { condenseCommandOutput, limitToolOutput, pruneToolOutputs as pruneHistoryToolOutputs, redactedToolStream, withReportedSavings } from "./tool-output"
import { recentImageReferences } from "./image-references"
import { CONTINUITY_TOOLS, continuityResult } from "./continuity"
import { declaredRoots, expandedShellPatterns, externalPatterns, matchingRule, nestedShellPatterns, permissionMatch, permissionName, permissionPatterns, policyRules, projectRulesOf, splitDeclared, toolDisabled, withoutBlindAllow } from "./permission-rules"
import { workflowToolAsks, workflowToolDenied } from "./workflow-policy"
import { createHash } from "node:crypto"
import { compactionThreshold, historyTokens, prunable, pruneDue, pruneToolOutputs, splitCompaction } from "./compaction-policy"
import { AUTO_RECALL_CHARS, AUTO_RECALL_PREFIX, AUTO_RECALL_TURNS, notInHistory, packedAway, recalledText } from "./auto-recall"
import { contextFiles } from "./context-files"
import { toolOwner } from "./context-rent"
import { checkpointContext, checkpointOf, compactionDeadline, fingerprint, NativeCompactionError, portableHistory, type CompactionCheckpoint } from "./compaction-checkpoint"
import { acceptSummary, RESUME_GUIDANCE, summaryBody } from "./compaction-summary"
import { assistantPhaseContext, buildCompactionPrompt, compactionTriggerContext, engineAnchor, imageAttachmentContext, languageContinuityContext, latestUserRequestContext, localRescueSummary, preservedTailSnapshotContext, recentOperationalContext, renderTranscript, resumeImageRefs, subagentTaskContext, todoContext, transcriptReferenceContext } from "./compaction-context"
import type { CompactionConfig } from "@mendcode/protocol"
import { ReasoningError, type ReasoningPort } from "./reasoning"
import { requestEstimates } from "./request-profile"
import type { EngineEvent, EnginePort, EngineResolution, TurnInput, TurnOutcome, TaskPort } from "@mendcode/kernel"
import { attachmentOrder, inlineTexts, layoutAttachments, pastedText, DEFAULT_COMPACT_AT_TOKENS, EARLY_TOOL_CHARS, INPUT_PROGRESS_CHARS, partialToolArgs, toolInputProgress, normalizeRenderSpec, parseRenderSpec, redactSecrets, type BlobRef, type ContextMessage, type ContextReport, type ContextSection, type ItemId, type ModelChoice, type ModelRole, type PermissionMode, type Settings, type PromptCacheMode, type SessionId } from "@mendcode/protocol"
import { applyShellEnvironment, defaultShell, type ShellEnvironmentPolicy, type ShellPolicy, type WebPolicy } from "@mendcode/tools"
import type { BackgroundPort, InteractivePort, LoopPort, PeerPort, ThreadPort, ReviewPort, RecalledTurn, SessionRecallPort, QuestionPrompt, Tool, ToolResult, WorkflowPort, WorktreePort, ComputerPort } from "@mendcode/tools"
import { cacheHash, cacheProject, passiveCache, selectCache } from "./cache-policy"
import { z } from "zod"
import { agentAllows, agentSection, capPermission, LIST_AGENTS, subagentCatalog, subagentListing, subagentName, type AgentPort, type AgentProfile } from "./agents"
import { PLAN_EXIT_TOOL, PLAN_REVIEW_TOOL, PLAN_TOOL_NAMES, planPhase, safePlanArgs } from "./plan-tools"
import { continuationStream } from "./continuation"
import { pairToolCalls } from "./history"
import { GOAL_TOOL_NAMES, GOAL_TOOLS, runGoalTool, type GoalPort } from "./goal-tools"
import { createGrantStore, type GrantStore } from "./grants"
import { authorityContext, freezeAction, type AuthorityAnchor } from "./permission-context"
import type { PermissionProvenance, PermissionReview } from "@mendcode/protocol"
import type { PermissionReviewer } from "./permission-reviewer"
import { classifySmart } from "./smart-permissions"
import type { EngineHooks } from "./hooks"
import { resolveMentions } from "./mentions"
import { orientationBlock } from "./orientation"
import { backoffMs, systemClocks, waitToRetry, watchForWake, type Clocks } from "./network-wait"
import { RetryableProviderError, type HostedTool, type ModelMessage, type ModelProvider, type ModelRequest, type ModelUsage, type ReasoningState, type RequestImage, type ToolCall, type ToolSpec } from "./provider"
import { maskResult, resolveToolArgs, SECRETS_TOOL, secretsNote, secretsResult, type SecretsPort, type SecretStream } from "./secrets"
import { SESSION_RECALL_TOOLS, SESSION_RECALL_TOOL_NAMES, sessionRecallPermission } from "./session-recall-tools"
import { runSnip, SNIP_TOOL } from "./snip"
import type { CompoundCall } from "./compound-budget"
import { hostable } from "./host-tools"
import { activeToolNames, createToolSearch, impliedTools, isPrimaryIn, PLAN_TOOLS, searchTools, TOOL_SEARCH_NAME, withoutDiscovered, type CatalogMode } from "./tool-discovery"
import { compactToolSchema } from "./tool-schema"
import { CODE_TOOL } from "./code-mode"
import { CodeError } from "./code-parser"
import { createIdFactory, tierIncludes, featureOn } from "@mendcode/protocol/wire"
import { executeCode } from "./code-runtime"
import { bindComputerAuthority } from "./computer-authority"
import { DEFAULT_STRUCTURED_RETRIES, STRUCTURED_NOTE, STRUCTURED_NUDGE, STRUCTURED_TOOL, structuredTool } from "./structured-output"

/** Conversation persistence per session; the daemon backs it with the store, tests with memory. */
export interface HistoryPort {
  load(sessionId: SessionId): Promise<ModelMessage[] | undefined>
  /** Appends: `messages` extends what was loaded or saved before. */
  save(sessionId: SessionId, messages: ModelMessage[]): Promise<void>
  /** Replaces the whole history (compaction). */
  replace(sessionId: SessionId, messages: ModelMessage[]): Promise<void>
}

export function memoryHistory(): HistoryPort {
  const sessions = new Map<SessionId, ModelMessage[]>()
  const store = async (sessionId: SessionId, messages: ModelMessage[]) => void sessions.set(sessionId, messages.map((m) => structuredClone(m)))
  return {
    load: async (sessionId) => sessions.get(sessionId)?.map((m) => structuredClone(m)),
    save: store,
    replace: store,
  }
}

/** One named piece of the system prompt, so `/context` can size each source. Empty parts are dropped when joined. */
export type SystemPart = { id: string; label: string; text: string; count?: number }

export const joinSystemParts = (parts: SystemPart[]) => parts.map((part) => part.text).filter(Boolean).join("\n\n")

/** What a system prompt may depend on besides the project: which session asks and what the user just said (memory relevance). */
export type SystemContext = { sessionId: SessionId; prompt: string }

/** The user's latest message text, empty when there is none (a turn always starts with one). */
function lastPrompt(messages: readonly ModelMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role === "user") return message.content
  }
  return ""
}

const CONTEXT_PREVIEW_CHARS = 60
const CONTEXT_LARGEST = 5

function messageChars(message: ModelMessage) {
  if (message.role === "user") return message.content.length
  if (message.role === "tool") return message.name.length + message.output.length
  return message.content.length + message.toolCalls.reduce((sum, call) => sum + call.name.length + JSON.stringify(call.args ?? {}).length, 0)
}

function messagePreview(message: ModelMessage) {
  const text = message.role === "tool" ? `${message.name}: ${message.output}` : message.role === "assistant" && !message.content.trim() ? `→ ${message.toolCalls.map((call) => call.name).join(", ")}` : message.content
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > CONTEXT_PREVIEW_CHARS ? `${flat.slice(0, CONTEXT_PREVIEW_CHARS - 1)}…` : flat
}

/** Ends the prompt of a compaction that carries the session's tools only to repeat the cached prefix. */
const SHARED_COMPACTION_NOTE = "Do not call any tool: reply with the summary text only."
/** The size of a summary when `compaction.max_summary_tokens` is unset: the incremental cap, and the output room a shared request must leave. */
const DEFAULT_SUMMARY_TOKENS = 4096
/** What one main call sent ahead of its messages and whether it pruned them: what a later request repeats to share the provider's cached prefix. */
type SharedPrefix = {
  system: string; tools: ToolSpec[]; hostedTools: HostedTool[]; choice: ModelChoice | undefined; effort: ModelRequest["effort"]; parameters: ModelRequest["parameters"]; pruned: boolean
  /** How many history messages the call sent, and their hash as they stood in memory then (`historyDigest`). */
  sent: number; digest: string
  /** The start of the call's turn (`TurnStart`): what that turn changed in memory only. */
  turn: TurnStart | undefined
  /** The provider's count for the call: its whole request plus its reply. */
  contextTokens?: number
  /** The prompt cache the call was keyed to, so a forked child's calls reach the same cached prefix. */
  cache: { mode: ModelRequest["cacheMode"]; key: string | undefined; forBody: ModelRequest["cacheKeyForBody"] }
}
/** What a forked child repeats of its parent's latest main call ahead of the messages (`forkStart`). */
type ForkPrefix = Pick<SharedPrefix, "system" | "tools" | "hostedTools" | "choice" | "effort" | "parameters" | "cache">
type ForkStart = { prefix: ForkPrefix; messages: ModelMessage[] }
/** A turn's start: the history length once its user message was appended, and whether old tool outputs were pruned in place then. */
type TurnStart = { start: number; pruned: boolean }
const historyDigest = (messages: readonly ModelMessage[]) => {
  const hash = createHash("sha256")
  for (const message of messages) hash.update(JSON.stringify(message)).update("\n")
  return hash.digest("hex")
}
/**
 * A stored history as the last main call had it in memory, or undefined when it no longer starts with what that call sent (a message
 * was edited, snipped or removed since). Two edits made at a turn's start never reach an append-only store, so they are repeated here
 * on copies: the signed reasoning dropped from earlier assistant messages (`appendUser`) and the old tool outputs pruned in place (`runTurn`).
 */
function asLastSent(messages: ModelMessage[], last: SharedPrefix): ModelMessage[] | undefined {
  if (messages.length < last.sent) return undefined
  const turn = last.turn
  const replayed = !turn ? messages : messages.map((message, index): ModelMessage => {
    if (index >= turn.start) return message
    if (message.role === "tool") return turn.pruned ? { ...message } : message
    if (message.role !== "assistant" || message.reasoning === undefined) return message
    const { reasoning: _reasoning, ...rest } = message
    return rest
  })
  if (turn?.pruned) pruneHistoryToolOutputs(replayed.slice(0, turn.start))
  return historyDigest(replayed.slice(0, last.sent)) === last.digest ? replayed : undefined
}
type CallInput = Pick<TurnInput, "sessionId" | "signal" | "newItemId" | "emit" | "selection" | "workflow" | "turnOptions"> & Partial<Pick<TurnInput, "ask" | "turnId" | "text">>

const SUMMARY_PREFIX = "Summary of the conversation so far (earlier messages were compacted):"
/** A conservative default below common 200k-token context windows; set per model in config. */
export { DEFAULT_COMPACT_AT_TOKENS }
/**
 * Model calls one turn (and one sub-agent) may make before it is told to wrap up. A real coding task takes well over a hundred;
 * these only stop a turn that would never end, which the repeated-call guard and the user's interrupt usually catch first.
 */
const DEFAULT_MAX_STEPS = 400
/**
 * How long one compaction request may take. A summary of a window near its limit is a long call (hundreds of thousands of tokens
 * read, a few thousand written, with reasoning): one minute was not enough for it. A stream that stops sending ends sooner on its own limit.
 */
const DEFAULT_COMPACTION_TIMEOUT_MS = 300_000
const DEFAULT_TASK_STEPS = 150
/** The tool a user's `!command` runs through. */
const SHELL_TOOL = "shell"
/** Inline shell of a custom command: each command's deadline and the size of what may enter the prompt. */
const INLINE_SHELL_TIMEOUT_MS = 30_000
/** Provider failures in a row, in steps that used a hosted tool, before the step goes on without that tool. */
const HOSTED_FAILURE_LIMIT = 2
const hostedLabel = (tool: HostedTool) => (tool === "web_search" ? "web search" : "image generation")
/** What the model is told once a hosted tool was taken out of the step. */
const hostedOffNote = (tools: readonly HostedTool[]) => `The provider's ${tools.map(hostedLabel).join(" and ")} is failing right now and is off for this step. Do not wait for it: answer with what you have, say that it failed, and use another tool if one can do the job.`
const INLINE_SHELL_MAX_CHARS = 32_000
/** Tools a sub-agent never gets: it cannot talk to the user or propose memories on its own. */
const MAIN_AGENT_ONLY = new Set(["sidebar", "question", "remember", "loop", "worktree", "threads", "packages", "pr_watch", "session_meta"])

/** What `permit` answers: the kernel's resolutions, plus a refusal that came from the permission reviewer rather than the user. */
type PermitResult = (EngineResolution | { kind: "deny"; reason: string; by: "reviewer" | "rule" }) & { permissionSource?: PermissionReview["source"] }

type ProjectTool = Tool & { jsonSchema?: Record<string, unknown>; override?: boolean }

/**
 * `main`: the user-facing agent (may submit plans); `allowTask`: may delegate to sub-agents. `agent` is the custom agent
 * this loop runs as (its prompt, model and permission cap apply to every call of the loop); `subagents` are the ones
 * `task` may name; `extras` are the turn's project tools before any agent filtered them (a sub-agent starts from those).
 */
/** Narrowing limits a scripted run sets on a session; see `session.run.configure`. */
export type RunLimits = { maxSteps?: number; tools?: readonly string[]; excludeTools?: readonly string[]; offline?: boolean; addDirs?: readonly string[]; activeTools?: readonly string[] }
/** Tools that reach the network on their own; `--offline` removes them. */
const OFFLINE_TOOLS = new Set(["webfetch", "websearch", "image_gen", "session_meta"])

type Toolset = { tools: Map<string, Tool>; specs: ToolSpec[]; main: boolean; allowTask: boolean; agent?: AgentProfile; subagents?: Map<string, AgentProfile>; extras?: ProjectTool[]; codeCatalog?: Toolset; codeActive?: Set<string> }

/** Handled by the engine itself (it needs the loop), offered only when `subagents` is on. */
/** Plan mode: the agent submits a plan; approval leaves plan mode and the agent implements it. */
export const PLAN_TOOL = {
  name: "plan_submit",
  description:
    "Only in plan mode: submit your implementation plan (markdown: goal, steps with files, risks, how you will verify) for the user's review. If approved, plan mode ends and you implement it in the same turn. If the user sends feedback, revise and submit again.",
  args: z.object({ plan: z.string().min(1).max(30_000).describe("The plan in markdown") }),
}

export const TASK_TOOL = {
  name: "task",
  description:
    "Delegate a self-contained subtask to a sub-agent with fresh context and the same tools (not main-agent controls or question): independent research or focused changes that would flood your context. Give a complete prompt; it cannot see this conversation. task_id continues a saved child with its history, and model moves it to another model. background returns at once; task_status inspects or waits.",
  args: z.object({
    description: z.string().min(1).max(80).describe("3-8 word label shown to the user"),
    prompt: z.string().min(1).max(20_000).describe("Full instructions and context for the sub-agent, including what to return"),
    task_id: z.string().optional(),
    background: z.boolean().optional(),
    model: z.string().min(1).max(200).optional(),
    engine: z.string().regex(/^(native|claude|codex|pi|acp:[a-zA-Z0-9_-]+)$/).optional().describe("Full tier: run the child on this configured engine; model must belong to it. Claude models (Opus, Sonnet, Haiku) on the user's Claude login run with engine \"claude\"; prefer that over another provider's copy of the same model"),
    variant: z.string().min(1).max(80).optional(),
    subagent_type: z.string().min(1).max(64).optional(),
    agent: z.string().min(1).max(64).optional().describe("Name of a custom sub-agent to run as (see the list in this tool's description); omit for a general one"),
    isolation: z.literal("worktree").optional().describe("Child works in a new git worktree of HEAD; result names its branch (never merged)"),
    fork: z.boolean().optional().describe("true: the child starts from this conversation (your model; cached, so cheap to start) and the prompt needs only the task; your main-agent tools fail there. Omit for independent work"),
  }),
}
/** `isolation` and `fork` are offered only where their features are on (`task_worktree`, `task_fork`): elsewhere their schema would cost every request. */
const TASK_TOOL_SHARED = { ...TASK_TOOL, args: TASK_TOOL.args.omit({ isolation: true, fork: true }) }
/** Starts a forked child's first message: what the inherited conversation is, and that the task below is its own. */
const FORK_NOTE = "You are now a sub-agent forked from the conversation above, which is your parent's context: its instructions, tasks and approvals belong to the parent. Tools only the main agent has fail here. Do only the task below and end with your result for the parent.\n\nTask:\n"
const MAX_ITEM_TEXT = 60_000
const LIVE_OUTPUT_CAP = 32_000
const REASONING_AUTO_TOOL = {
  name: "reasoning_auto",
  description: "Request one supported reasoning increase up to high for this turn after verification_failed or a technical_block. Supply concrete evidence. Not for network failures, permission requests, pending questions or routine work. Manual effort wins; never changes model or provider.",
  args: z.strictObject({ reason: z.enum(["verification_failed", "technical_block"]), evidence: z.string().trim().min(1).max(1000) }),
}
const TITLE_ARG_KEYS = ["command", "path", "pattern", "url", "query", "description", "question", "name"] as const
/** Tools whose card reads better with another argument than the first of TITLE_ARG_KEYS. */
/** An image call's card names what is being drawn, as v1's did. */
const TITLE_ARG_OVERRIDES: Readonly<Record<string, string>> = { tool_define: "name", image_gen: "prompt" }

/** `read()`, or `fallback` when it throws: a broken optional source never stops a turn. */
function settle<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

function clip(text: string) {
  return text.length > MAX_ITEM_TEXT ? text.slice(0, MAX_ITEM_TEXT) : text
}

/**
 * A call whose card opened while the model was still writing its input (`tool_input`): the card says how much is written, so a
 * long write reads as writing and not as a stall. `whole` once its `tool_call` arrived; the call's run then takes the card over.
 */
type EarlyCard = { name: string; json: string; told: number; itemId?: ItemId; title?: string; whole?: boolean }

/** Plan tools, secrets and sub-agents keep their card until the input is whole: what a partial input would show is not theirs to show. */
const LATE_CARD_TOOLS = new Set<string>([...PLAN_TOOL_NAMES, SECRETS_TOOL.name, TASK_TOOL.name])

/** "shell: bun test" / "read: src/a.ts" — the collapsed card title before the tool reports its own. */
export function callTitle(call: ToolCall) {
  const args = (call.args ?? {}) as Record<string, unknown>
  if (call.name === "lsp" && typeof args.operation === "string") {
    const detail = args.operation === "workspaceSymbol" ? args.query ?? "" : args.operation === "documentSymbol" ? args.filePath ?? "" : `${args.filePath ?? ""}:${args.line ?? ""}:${args.character ?? ""}`
    return `lsp: ${args.operation}${detail ? ` ${detail}` : ""}`.slice(0, 200)
  }
  if (call.name === "shell_session" && typeof args.action === "string") {
    const target = typeof args.command === "string" ? args.command : typeof args.id === "string" ? args.id : ""
    return `shell_session: ${args.action}${target ? ` ${target.split("\n")[0]!.slice(0, 160)}` : ""}`
  }
  if (call.name === "sleep" && typeof args.ms === "number") return `sleep: ${args.ms >= 1_000 ? `${Math.round(args.ms / 100) / 10}s` : `${args.ms}ms`}${typeof args.reason === "string" && args.reason ? ` · ${args.reason.slice(0, 60)}` : ""}`
  const preferred = TITLE_ARG_OVERRIDES[call.name]
  const key = preferred && typeof args[preferred] === "string" ? preferred : TITLE_ARG_KEYS.find((k) => typeof args[k] === "string")
  const detail = key ? String(args[key]).split("\n")[0]!.slice(0, 160) : ""
  return detail ? `${call.name}: ${detail}` : call.name
}

/** `mcp__<server>__<tool>` → { server, tool }. */
function mcpParts(name: string) {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  return match ? { server: match[1]!, tool: match[2]! } : undefined
}

const MAX_TOOL_IMAGES = 2
const MAX_TOOL_IMAGE_BYTES = 5 * 1024 * 1024

/** Tools that change project files. When one fails, the calls after it in the same model response are not run. */
const FILE_WRITE_TOOLS = new Set(["edit", "write", "apply_patch", "notebook_edit"])

/** Files a successful write tool touched, from its arguments (apply_patch reports only a count in its meta). */
function writtenPaths(tool: string, args: unknown): string[] {
  const record = (args ?? {}) as Record<string, unknown>
  if ((tool === "edit" || tool === "write") && typeof record.path === "string") return [record.path]
  if (tool !== "apply_patch" || typeof record.patch !== "string") return []
  const found: string[] = []
  for (const line of record.patch.split("\n")) {
    const match = /^\*\*\* (Add File|Update File|Move to): (.+)$/.exec(line)
    if (!match) continue
    if (match[1] === "Move to") found.pop()
    found.push(match[2]!.trim())
  }
  return [...new Set(found)]
}

function approvalTitle(tool: Tool) {
  if (["memory", "memory_graph", "remember"].includes(tool.name)) return "Save to memory?"
  const mcp = mcpParts(tool.name)
  if (mcp) return `Use ${mcp.server} tool`
  if (tool.name.startsWith("custom__")) return `Run custom tool ${tool.name.slice("custom__".length)}`
  if (tool.name === "loop") return "Manage loops"
  if (tool.name === "worktree") return "Use a git worktree"
  if (tool.name === "shell_session") return "Run interactive command"
  if (tool.name === "browser") return "Use browser"
  if (tool.name === "threads") return "Read another session"
  return tool.permission === "execute" ? "Run command" : "Edit files"
}

/** What the user approves for a browser step: the page it loads, or the element and text it acts on. */
function browserDetail(args: Record<string, unknown>) {
  const clip = (value: unknown, max: number) => (typeof value === "string" ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : "")
  if (args.action === "navigate") return `browser (headless, own profile) open ${clip(args.url, 300)}`
  if (args.action === "type") return `browser type into element ${String(args.ref)}${args.submit ? " and press Enter" : ""}: ${JSON.stringify(clip(args.text, 120))}`
  if (args.action === "click") return `browser click element ${String(args.ref)} of the open page`
  if (args.action === "press") return `browser press ${clip(args.key, 20)} on the open page`
  return `browser ${String(args.action)}`
}

function approvalDetail(call: ToolCall) {
  const args = (call.args ?? {}) as Record<string, unknown>
  if (["memory", "memory_graph", "remember"].includes(call.name)) return `${typeof args.text === "string" ? args.text : `Memory ${args.action ?? "write"}`}\n[${args.scope === "user" || args.scope === "global" ? "user" : "project"}] [${args.category ?? (args.categoryIDs as string[] | undefined)?.[0] ?? "general"}]`
  const mcp = mcpParts(call.name)
  if (mcp) return `${mcp.tool} ${JSON.stringify(call.args ?? {})}`.slice(0, 500)
  if (call.name.startsWith("custom__")) return JSON.stringify(call.args ?? {}).slice(0, 500)
  if (call.name === "loop" && typeof args.action === "string") return `loop ${args.action}`
  if (call.name === "worktree" && typeof args.action === "string") return `worktree ${args.action}${typeof args.name === "string" ? ` ${args.name.slice(0, 60)}` : ""}${args.remove === true ? " (remove)" : ""}`
  if (call.name === "shell_session" && typeof args.command === "string") return `interactive (PTY, stays open for input): ${args.command}`
  if (call.name === "browser" && typeof args.action === "string") return browserDetail(args)
  if (call.name === "notebook_edit" && typeof args.path === "string") return `${args.action ?? "edit"} cell in ${args.path}`
  if (typeof args.command === "string") return args.command
  if (typeof args.path === "string") return args.path
  if (call.name === "glob" && Array.isArray(args.patterns)) return [args.pattern, ...args.patterns].filter((value): value is string => typeof value === "string").join(", ").slice(0, 500)
  if (call.name === "read" && Array.isArray(args.paths)) return args.paths.map((entry) => (entry as { path?: unknown } | null)?.path).filter((value): value is string => typeof value === "string").join(", ").slice(0, 500)
  return JSON.stringify(call.args).slice(0, 500)
}

function defaultSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    // Each wait removes its own listener: a long outage retries on one turn signal many times.
    const done = () => (clearTimeout(timer), signal.removeEventListener("abort", done), resolve())
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

/**
 * MendCode's own agent loop: model call → tool calls → results → model call, until the model stops.
 * Read tools run directly; write/execute tools ask through the kernel (approval once or for the session).
 * History is saved after every step, so a crash or cancel never loses completed work.
 */
export function createNativeEngine(options: {
  provider: ModelProvider
  tools: Tool[]
  history: HistoryPort
  /** Project root of a session; one daemon serves sessions from many projects. */
  cwdFor(sessionId: SessionId): string
  /** The instruction settings of the system prompt (fallback names, root markers, includes); `read` and `@file` mentions load nearby instructions by the same rules. */
  instructions?: import("@mendcode/tools").InstructionOptions
  /** System prompt for a session's project root; `context` says which session asks and what the user just said. */
  system(cwd: string, context?: SystemContext): string
  /** The same prompt as `system`, split into named parts (only for `/context`; must join to `system`'s result). */
  systemParts?(cwd: string, context?: SystemContext): SystemPart[]
  /** Shell program for a session's commands (its project may override the global setting); the platform default when absent. */
  shell?(sessionId?: SessionId): string | undefined
  /** Settings that shape the model's shell commands: the environment they inherit, and the prefix and login flag of the shell. */
  shellSettings?(): { environment?: ShellEnvironmentPolicy | undefined; policy?: ShellPolicy | undefined; /** The daemon's data directory: a shell command that runs `mendcode` addresses this one (`MENDCODE_V2_DIR`), whatever `--dir` the daemon started with. */ dataDir?: string | undefined }
  /** Domain rules for `webfetch` and `websearch`. */
  web?(): WebPolicy | undefined
  /** Permission rules of one session (REST `permission`), appended after settings and agent rules. */
  sessionRules?(sessionId: SessionId): readonly import("@mendcode/protocol").PermissionRule[]
  /** The OS sandbox policy the model's shell commands of this session run under; absent or undefined runs them unconfined. */
  sandbox?(input: { sessionId: SessionId; cwd: string }): import("@mendcode/tools").SandboxPolicy | undefined
  toolOutput?(): Settings["tool_output"]
  saveToolOutput?(text: string, complete: boolean): Promise<{ path: string; complete: boolean }>
  pruneToolOutputs?(): boolean
  maxSteps?: number
  /** Scripted-run limits of a session (`--tools`, `--offline`, `--max-turns`); they only narrow what the loop may do. */
  runLimits?(sessionId: SessionId): RunLimits | undefined
  /** Tool patterns a project directory does not offer (the code graph's tools in a folder it does not index); unlike run limits they keep sub-agents. */
  hiddenTools?(directory: string): readonly string[]
  /** Most retries of one model call; without it network and transient failures are retried until the user cancels. */
  retries?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Sent after a partial answer the connection cut (prompts/continuation.md); without it such an answer ends the turn with an error. */
  continuationPrompt?: string
  /** Clocks that tell a wake from sleep apart from an ordinary wait. */
  clocks?: Clocks
  /** Calls `onWake` when the machine wakes from sleep; returns the function that stops watching. Defaults to clock divergence. */
  watchWake?: (onWake: () => void) => () => void
  /** Compact after a turn whose last model call used at least this many context tokens; a function is asked per session and model (a per-model setting). */
  compactAtTokens?: number | ((sessionId: SessionId, model: string | undefined) => number | undefined)
  compaction?(): CompactionConfig | undefined
  /** Saves a session's full transcript (the engine redacts secrets first) before a portable compaction and returns the local path the summary points to; absent or undefined = no transcript reference. */
  transcript?(input: { sessionId: SessionId; generation: number; markdown: string }): Promise<string | undefined>
  contextWindowFor?(sessionId: SessionId): number | undefined
  /** The user's own window for a session on a model (`/context-window`, else the model's `modelContext`): it wins over the model's, and over the provider's input limit. */
  contextWindowOverrideFor?(sessionId: SessionId, model: string | undefined): number | undefined
  /** Bytes of an attached blob (the daemon reads its content-addressed store). */
  readBlob?(ref: BlobRef): Promise<Uint8Array>
  readStoredFile?(file: string): Uint8Array | undefined
  /**
   * Stores image bytes a tool returned and registers them with the session (so blob cleaning keeps them). History keeps
   * only the resulting ref. Without it, tool images are dropped and the model is told so.
   */
  storeBlob?(bytes: Uint8Array, mime: string, sessionId: SessionId): Promise<BlobRef>
  /** Session-scoped jobs and asynchronous questions, enabled separately by experimental flags. */
  continuity?: import("@mendcode/kernel").ContinuityForSession
  /** A session's background shell tasks; without it `shell` cannot run in the background. */
  background?(sessionId: SessionId): BackgroundPort
  /** A session's interactive processes (`shell_session`); without it that tool reports it is unavailable. */
  interactive?(sessionId: SessionId): InteractivePort
  /** Workflows started from this session (the workflow tools); without it they report they are unavailable. */
  workflows?(sessionId: SessionId): WorkflowPort
  /** The project's other sessions (the peer tools); without it they report they are unavailable. */
  peers?(sessionId: SessionId): PeerPort
  /** The `threads` tool's port (read, search, message, wait on, interrupt the project's other sessions); offered to the main agent while `experimental.thread_tools` is on. */
  threads?(sessionId: SessionId): ThreadPort
  packages?(sessionId: SessionId): import("@mendcode/tools").PackagePort
  sessionMeta?(sessionId: SessionId): NonNullable<import("@mendcode/tools").ToolContext["sessionMeta"]>
  recall?(sessionId: SessionId): SessionRecallPort
  computer?(sessionId: SessionId): ComputerPort
  /** A session's private headless browser (the `browser` tool); without it that tool reports it is unavailable. */
  browser?(sessionId: SessionId): import("@mendcode/tools").BrowserPort
  /** Loops of this session's project (the `loop` tool); without it the tool reports it is unavailable. */
  review?(sessionId: SessionId): ReviewPort
  aiConfig?(sessionId: SessionId): import("@mendcode/tools").AIConfigPort
  loops?(sessionId: SessionId): LoopPort
  /** The session's git worktree (the `worktree` tool, offered to the main agent while `experimental.worktree_tool` is on); without it the tool reports it is unavailable. */
  worktrees?(sessionId: SessionId): WorktreePort
  /** The session's pull request watches (the `pr_watch` tool, offered to the main agent while `experimental.pr_watch` is on); without it the tool does not exist. */
  prWatch?(sessionId: SessionId): import("@mendcode/tools").PrWatchPort
  /** The session's goal (the `get_goal`, `create_goal` and `update_goal` tools, offered to the main agent only); without it the tools do not exist and a goal can only end by the user or by the text marker. */
  goals?(sessionId: SessionId): GoalPort
  /** Where "approve for this session" grants live; shared with the daemon so it can list and revoke them. Defaults to a private store. */
  grants?: GrantStore
  /** Original user anchors from the daemon's turn projection; no expanded files or synthetic notices. */
  authorityAnchors?(sessionId: SessionId): readonly AuthorityAnchor[]
  /** `smart` mode: classifies approvals the rules cannot settle. Off (absent, or its model role unset) by default. */
  permissionReviewer?: PermissionReviewer
  /** `smart` mode: extra allow-listed command prefixes (the `permissionAllow` setting), read at each call. */
  permissionAllow?(): readonly string[] | undefined
  /** `smart` mode: the `smartSandboxTrust` setting (read at each call). With the OS sandbox on and its network off, commands smart mode merely does not know run without asking. Off by default. */
  smartSandboxTrust?(): boolean | undefined
  /** Granular rules and native loop policies, read before each tool call. */
  permissionPolicy?(): Pick<Settings, "permission" | "tools" | "experimental" | "additionalDirectories" | "tier" | "features" | "memoryEnabled" | "memoryRequireApproval" | "subagentCatalog">
  memoryAlways?(): void
  memorySettings?(sessionId: SessionId): Pick<Settings, "memoryEnabled" | "memoryRequireApproval">
  trace?: import("@mendcode/protocol").TracePort
  /** The model for a session's next call in a role; the provider's own model when absent. Read per call, so `/model` applies mid-turn. */
  modelFor?(sessionId: SessionId, role: ModelRole): ModelChoice | undefined
  reasoning?: ReasoningPort
  beforeModel?(input: { model: string; signal: AbortSignal; ask?: TurnInput["ask"] }): Promise<void>
  onMissingUsage?(): void
  /** Custom agents (`agents/*.md`): the session's primary agent and the sub-agents `task` can name. Absent = only the built-in behaviour. */
  agents?: AgentPort
  plans?: { latest(sessionId: SessionId): import("@mendcode/protocol").PlanReview | undefined }
  /** Makes a choice an agent asked for usable (an effort the model does not support falls back to its default); used as is when absent. */
  agentModel?(choice: ModelChoice): ModelChoice
  /** The `promptCache` setting, read at each model call; `legacy` when absent (docs/prompt-cache.md). */
  promptCache?(): PromptCacheMode | undefined
  cacheConfig?(sessionId: SessionId): import("@mendcode/protocol").CacheConfig | undefined
  /**
   * The cache lifetime this call asks its provider for (`promptCacheTtl`, `wait_cache`; docs/prompt-cache.md), asked once per request
   * just before it is sent. Undefined for a provider that takes no lifetime; only the Anthropic adapter reads the answer.
   */
  cacheTtl?(input: { sessionId: SessionId; role: ModelRole; provider: string }): import("@mendcode/protocol/wire").CacheTtl | undefined
  /** Where a stored blob lives on disk; shown on image_generation cards so the user can open the image. */
  blobPath?(ref: BlobRef): string
  /** Instruction appended as the last user message when asking the model for a summary (prompts/compaction.md); a function can vary it per project root. */
  compactionPrompt: string | ((cwd: string) => string)
  /** Offers the `task` tool (sub-agents). */
  tasks?: TaskPort
  subagents?: boolean
  /**
   * Per-project tools discovered at turn start (MCP servers). `jsonSchema`, when present, is sent to
   * the model instead of the zod schema. Failures must resolve to [] — a broken server never blocks a turn.
   * `override` replaces the built-in tool of the same name for this turn (extension tools); without it a built-in wins.
   * `scope.host`: the tools lent to another harness (`hostTools`, `hostCall`), which lacks what a native request gets from its provider.
   */
  projectTools?(cwd: string, sessionId: SessionId, scope?: { host: true }): Promise<Array<Tool & { jsonSchema?: Record<string, unknown>; override?: boolean }>>
  maxTaskSteps?: number
  /**
   * After a successful edit/write/apply_patch, text appended to the tool output the model sees (e.g. language-server
   * errors of the written files). Must be quick and never required: failures resolve to undefined.
   */
  afterWrite?(input: { cwd: string; paths: string[]; signal?: AbortSignal; sessionId?: SessionId }): Promise<string | undefined>
  /**
   * What `afterWrite` learned after it returned (language-server errors that arrived late). Asked after every tool call of the
   * session and appended to that call's output; the implementation hands each note out once.
   */
  lateWriteNotes?(sessionId: SessionId): string | undefined
  /**
   * One tree (docs/one-tree.md): told what each call wrote, and given its output; returns a line to append when the result
   * names files another session is changing in the same checkout. Synchronous and in memory.
   */
  oneTree?(input: { sessionId: SessionId; cwd: string; written: string[]; output: string }): string | undefined
  /** Provider-side tools (web search) offered on answer calls, read per call so a setting applies to the next one. */
  hostedTools?(): HostedTool[]
  /** Opt-in interception points (daemon extensions): tool calls, system prompt, context, request body, compaction. Absent = none, no cost. */
  hooks?: EngineHooks
  /**
   * Keeps pasted secrets away from the model: it sees `‹secret:N›` markers only, a built-in tool's shell command and
   * written content get the value back just before it runs (after approval), and every tool output is masked again.
   */
  secrets?: SecretsPort
  compound?(sessionId: SessionId): CompoundCall | undefined
  /**
   * Inline shell of a custom command (`!`cmd``): the commands the daemon holds for the markers in a prompt's text. The engine runs each
   * as an ordinary `shell` tool call of the turn (permission mode, allow and deny rules, approval card, sandbox, hooks) and swaps the
   * marker for its output before the message is built. Absent: markers stay plain text.
   */
  inlineShell?(text: string): Array<{ marker: string; command: string }>
}): EnginePort {
  const hooks = options.hooks
  const secrets = options.secrets
  const compactionPromptFor = (cwd: string) => (typeof options.compactionPrompt === "function" ? options.compactionPrompt(cwd) : options.compactionPrompt)
  /** Sessions whose compaction was asked for by `needsCompaction` (the actor compacts right after), so `compact` can tell auto from manual. */
  const autoCompaction = new Set<SessionId>()
  const toSpec = (tool: { name: string; description: string; args: z.ZodType }): ToolSpec => ({ name: tool.name, description: tool.description, parameters: compactToolSchema(z.toJSONSchema(tool.args) as Record<string, unknown>) })
  const tools = [...options.tools, ...(options.recall ? SESSION_RECALL_TOOLS.filter((tool) => !options.tools.some((existing) => existing.name === tool.name)) : [])]
  const subagentTools = tools.filter((tool) => !MAIN_AGENT_ONLY.has(tool.name))
  const secretsSpecs = secrets ? [toSpec(SECRETS_TOOL)] : []
  // `snip` (experimental.snip) is listed here and kept or dropped per turn by `withPolicy`.
  const snipSpecs = [toSpec(SNIP_TOOL)]
  const subagentToolset: Toolset = { tools: new Map(subagentTools.map((tool) => [tool.name, tool])), specs: [...subagentTools.map(toSpec), ...secretsSpecs, ...snipSpecs], main: false, allowTask: false }
  const mainToolset: Toolset = {
    tools: new Map(tools.map((tool) => [tool.name, tool])),
    specs: [...tools.map(toSpec), ...secretsSpecs, ...snipSpecs, toSpec(PLAN_TOOL), ...(options.subagents ? [toSpec(TASK_TOOL_SHARED)] : []), ...(options.goals ? GOAL_TOOLS.map(toSpec) : []), toSpec(PLAN_REVIEW_TOOL), toSpec(PLAN_EXIT_TOOL), ...(options.continuity ? CONTINUITY_TOOLS.map(toSpec) : []), ...(options.reasoning ? [toSpec(REASONING_AUTO_TOOL)] : [])],
    main: true,
    allowTask: options.subagents === true,
  }
  const specs = mainToolset.specs
  const latestPlans = new Map<SessionId, import("@mendcode/protocol").PlanReview>()

  /** Adds project tools to a base toolset for one turn; built-in names win on collision unless the tool says `override`. */
  function withProjectTools(base: Toolset, extra: ProjectTool[]): Toolset {
    extra = extra.filter((tool) => tool.name !== CODE_TOOL.name)
    const specOf = (tool: ProjectTool): ToolSpec => ({ name: tool.name, description: tool.description, parameters: tool.jsonSchema ?? toSpec(tool).parameters })
    const replacing = new Map(extra.filter((tool) => tool.override && base.tools.has(tool.name)).map((tool) => [tool.name, tool] as const))
    const added = extra.filter((tool) => !base.tools.has(tool.name))
    if (added.length === 0 && replacing.size === 0) return base
    return {
      ...base,
      tools: new Map([...base.tools, ...replacing, ...added.map((tool) => [tool.name, tool] as const)]),
      specs: [...base.specs.map((spec) => (replacing.has(spec.name) ? specOf(replacing.get(spec.name)!) : spec)), ...added.map(specOf)],
    }
  }
  /** Narrows a toolset to what an agent may use, and makes the agent the one the loop runs as. `plan_submit` and the secrets tool stay: plan mode and pasted secrets need them whatever the agent lists. */
  function withAgent(base: Toolset, agent: AgentProfile | undefined): Toolset {
    if (!agent) return base
    if (!agent.tools && !agent.deny) return { ...base, agent }
    const allowed = (name: string) => PLAN_TOOL_NAMES.has(name) || name === SECRETS_TOOL.name || GOAL_TOOL_NAMES.has(name) || agentAllows(agent, name)
    return { ...base, agent, tools: new Map([...base.tools].filter(([name]) => allowed(name))), specs: base.specs.filter((spec) => allowed(spec.name)), allowTask: base.allowTask && allowed(TASK_TOOL.name) }
  }

  /** A scripted run can only narrow: the allow-list intersects what the agent and rules allow, and sub-agents (whose tools it cannot bound) are off. */
  function withoutHidden(base: Toolset, directory: string): Toolset {
    const hidden = options.hiddenTools?.(directory) ?? []
    if (!hidden.length) return base
    const shown = (name: string) => !hidden.some((pattern) => permissionMatch(name, pattern))
    return { ...base, tools: new Map([...base.tools].filter(([name]) => shown(name))), specs: base.specs.filter((spec) => shown(spec.name)) }
  }

  function withRunLimits(base: Toolset, limits: RunLimits | undefined): Toolset {
    const scripted = limits !== undefined && (limits.tools !== undefined || !!limits.excludeTools?.length || !!limits.offline)
    if (!limits || !scripted && limits.activeTools === undefined) return base
    // An extension's `setActiveTools` only narrows what the rest already offers; a scripted run's limits also keep `task` out.
    const active = (name: string) => !limits.activeTools || limits.activeTools.some((pattern) => permissionMatch(name, pattern))
    const allowed = (name: string) => !(scripted && name === TASK_TOOL.name) && active(name) && (!limits.tools || limits.tools.some((pattern) => permissionMatch(name, pattern))) && !limits.excludeTools?.some((pattern) => permissionMatch(name, pattern)) && !(limits.offline && OFFLINE_TOOLS.has(name))
    return { ...base, tools: new Map([...base.tools].filter(([name]) => allowed(name))), specs: base.specs.filter((spec) => allowed(spec.name)), allowTask: base.allowTask && !scripted && active(TASK_TOOL.name) }
  }

  const policy = () => options.permissionPolicy?.() ?? {}
  const memoryConsentTurns = new Set<string>()
  const rulesFor = (toolset: Toolset, sessionId?: SessionId) => policyRules(policy(), toolset.agent?.permissionRules, sessionId ? options.sessionRules?.(sessionId) : undefined, sessionId ? projectRulesOf(policy(), options.cwdFor(sessionId)) : undefined)
  function withPolicy(base: Toolset): Toolset {
    const rules = rulesFor(base)
    const primaryOnly = policy().experimental?.primary_tools ?? []
    const allowed = (name: string) => (name !== "session_meta" || !!options.sessionMeta && featureOn(policy(), "session_meta")) && (name !== SNIP_TOOL.name || policy().experimental?.snip === true) && (name !== "worktree" || policy().experimental?.worktree_tool === true) && (name !== "pr_watch" || !!options.prWatch && policy().experimental?.pr_watch === true) && (name !== "threads" || !!options.threads && policy().experimental?.thread_tools === true) && (!SESSION_RECALL_TOOL_NAMES.has(name) || !!options.recall && policy().experimental?.session_recall === true) && (!name.startsWith("tool_") || !CONTINUITY_TOOLS.some((tool) => tool.name === name) || policy().experimental?.async_tools === true) && (!name.startsWith("question_") || !CONTINUITY_TOOLS.some((tool) => tool.name === name) || policy().experimental?.async_questions === true) && !toolDisabled(name, rules) && (base.main || !primaryOnly.some((pattern) => permissionMatch(name, pattern)))
    // A tool that declares a tier (`Tool.tier`, docs/tiers.md) is offered only when the user's tier includes it.
    const tier = policy().tier
    const inTier = (name: string) => name === "session_meta" ? featureOn(policy(), "session_meta") : tier === undefined || tierIncludes(tier, base.tools.get(name)?.tier ?? "minimalist")
    const offered = (name: string) => allowed(name) && inTier(name) && (name !== "packages" || !!options.packages && featureOn(policy(), "package_tools"))
    return { ...base, tools: new Map([...base.tools].filter(([name]) => offered(name))), specs: base.specs.filter((spec) => offered(spec.name)), allowTask: base.allowTask && offered(TASK_TOOL.name) }
  }

  function withDiscovery(base: Toolset, messages: readonly ModelMessage[], plan = false): Toolset {
    // Retain recent conversation during compaction, but renew discovery after its retained turns.
    const checkpoint = checkpointOf(messages)
    let discoveryStart = 0
    if (checkpoint) {
      discoveryStart = messages.length
      let retainedTurns = checkpoint.tailTurns
      for (let i = 1; i < messages.length; i++) {
        const message = messages[i]!
        if (message.role !== "user" || message.content.startsWith(SUMMARY_PREFIX)) continue
        if (retainedTurns-- === 0) { discoveryStart = i; break }
      }
    }
    const primary = catalogPrimary()
    const active = activeToolNames(messages.slice(discoveryStart), primary)
    // Auxiliary tools the conversation calls for are listed without a search (`impliedTools`), after the ones already found.
    for (const name of impliedTools(messages.slice(discoveryStart), plan)) if (!primary(name)) active.add(name)
    const codeAllowed = policy().experimental?.code_mode === true && (!base.agent || agentAllows(base.agent, CODE_TOOL.name))
    const eligible = withPolicy(codeAllowed ? { ...base, specs: [...base.specs.filter((spec) => spec.name !== CODE_TOOL.name), toSpec(CODE_TOOL)], codeCatalog: base, codeActive: active } : base)
    const discovery = discoveryOn()
    const planDeferred = planToolsDeferred()
    const deferred = (name: string) => name === "packages" || discovery && !primary(name) || planDeferred && PLAN_TOOLS.has(name)
    if (!eligible.specs.some((spec) => deferred(spec.name))) return eligible
    // Without permission to search, keep the allowed catalog usable directly.
    if (toolDisabled(TOOL_SEARCH_NAME, rulesFor(base)) || base.agent && !agentAllows(base.agent, TOOL_SEARCH_NAME)
      || !base.main && policy().experimental?.primary_tools?.some((pattern) => permissionMatch(TOOL_SEARCH_NAME, pattern))) return { ...eligible, specs: eligible.specs.filter((spec) => spec.name !== "packages") }
    const search = createToolSearch(() => withPolicy(base).specs, active, primary)
    // Append-only: the always-listed tools keep the order of the catalogue, then `tool_search`, then the discovered tools in the order they were
    // discovered, so finding a tool leaves every earlier byte of the tool list as it was. It is still not free: providers put the tool list before
    // the system prompt and the conversation, so the call after a find re-reads all of those once (test/cache-discovery.test.ts). The Responses
    // adapter avoids that on the ChatGPT backend: it takes the tools after `tool_search` out of the list and defines each in the result of the
    // search that found it (`searchLoads`, openai-responses.ts), which is why the found tools must stay last and in discovery order here.
    const listed = eligible.specs.filter((spec) => spec.name !== search.name && !deferred(spec.name))
    const discovered = [...active].flatMap((name) => eligible.specs.filter((spec) => spec.name === name && spec.name !== search.name && deferred(name)))
    return {
      ...eligible,
      tools: new Map([...eligible.tools, [search.name, search]]),
      specs: [...listed, toSpec(search), ...discovered],
    }
  }

  /** The catalogue's cut (docs/tool-discovery.md): the lean core and the plan tools are features of the tier, `tool_discovery: false` keeps the whole catalogue. */
  function catalogMode(): CatalogMode {
    const settings = policy()
    return { lean: settings.experimental?.tool_discovery !== false && featureOn(settings, "lean_tools"), planTools: featureOn(settings, "plan_tools"), aux: featureOn(settings, "aux_tools"), find: featureOn(settings, "find_tools"), ui: featureOn(settings, "ui_tool") }
  }
  const catalogPrimary = () => { const mode = catalogMode(); return (name: string) => isPrimaryIn(name, mode) }
  /** Everything outside the primary set is deferred when asked for (`tool_discovery`) or by the lean catalogue; an explicit false wins. */
  function discoveryOn() {
    const settings = policy()
    if (settings.experimental?.tool_discovery === false) return false
    return settings.experimental?.tool_discovery === true || catalogMode().lean
  }
  /** The plan tools alone go behind `tool_search` when their feature is off, whatever else is listed. */
  const planToolsDeferred = () => policy().experimental?.tool_discovery !== false && !catalogMode().planTools

  /** Names the first sub-agents in the `task` tool's description (`subagentCatalog` of them) and lets `task` run every one. */
  function withSubagents(base: Toolset, subagents: readonly AgentProfile[]): Toolset {
    const worktree = featureOn(policy(), "task_worktree"), fork = featureOn(policy(), "task_fork")
    if (!base.allowTask || subagents.length === 0 && !fork) return base
    const description = subagents.length ? `${TASK_TOOL.description}\n\n${subagentCatalog(subagents, policy().subagentCatalog)}` : undefined
    const parameters = worktree || fork ? toSpec({ ...TASK_TOOL, args: TASK_TOOL.args.omit({ ...(worktree ? {} : { isolation: true as const }), ...(fork ? {} : { fork: true as const }) }) }).parameters : undefined
    return {
      ...base,
      ...(subagents.length ? { subagents: new Map(subagents.map((agent) => [agent.name, agent] as const)) } : {}),
      specs: base.specs.map((spec) => (spec.name === TASK_TOOL.name ? { ...spec, ...(description ? { description } : {}), ...(parameters ? { parameters } : {}) } : spec)),
    }
  }

  /** The permission mode a loop runs in: the session's, lowered to its agent's cap. */
  const modeOf = (input: Pick<TurnInput, "permissionMode">, toolset: Toolset): PermissionMode => capPermission(input.permissionMode(), toolset.agent?.permission)

  /** The model of a call: the agent's own (over the session's) when it names one or an effort. */
  function choiceFor(choice: ModelChoice | undefined, agent: AgentProfile | undefined): ModelChoice | undefined {
    if (!agent) return choice
    const model = agent.model ?? choice?.model ?? options.provider.model
    const effort = agent.effort ?? (agent.model ? undefined : choice?.effort)
    const asked: ModelChoice = { ...(agent.model ? { model } : choice ?? { model }), ...(effort ? { effort } : {}), ...(agent.model && agent.variant ? { variant: agent.variant } : {}) }
    const resolved = options.agentModel ? options.agentModel(asked) : asked
    const parameters = { ...resolved.parameters, ...agent.options, ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}), ...(agent.top_p !== undefined ? { top_p: agent.top_p } : {}) }
    return { ...resolved, ...(Object.keys(parameters).length ? { parameters } : {}) }
  }

  const providerTurnSignals = new WeakMap<AbortSignal, AbortSignal>()
  /** Tool specs sent on each session's last turn, including project (MCP) tools discovered then. */
  const lastSpecs = new Map<SessionId, ToolSpec[]>()
  /** The custom agent each session's last turn ran as, for `/context`. */
  const lastAgent = new Map<SessionId, AgentProfile | undefined>()
  const lastSubagents = new Map<SessionId, AgentProfile[]>()
  /**
   * What each session's last main call sent ahead of its messages, and how it pruned them: everything a later request must repeat to
   * start with the same bytes (the provider's cached prefix). A portable compaction is built from it when it can be (`compact`).
   */
  const lastMain = new Map<SessionId, SharedPrefix>()
  /** Early cards of whole calls waiting for their run, by session and call id (`EarlyCard`). */
  const earlyCards = new Map<string, EarlyCard>()
  const earlyKey = (sessionId: SessionId, callId: string) => `${sessionId}\n${callId}`
  function takeEarlyCard(sessionId: SessionId, callId: string) {
    const card = earlyCards.get(earlyKey(sessionId, callId))
    earlyCards.delete(earlyKey(sessionId, callId))
    return card?.itemId ? (card as EarlyCard & { itemId: ItemId }) : undefined
  }
  /** Each forked child session's inherited prefix, kept for its later turns until it compacts (memory only: after a restart it runs as its own). */
  const forkPrefixes = new Map<SessionId, ForkPrefix>()
  /**
   * A fork's start (`task` with `fork: true`): the parent's latest main call (its system prompt, tools, model, effort and cache key) and the
   * history it sent, pruned as it was sent, so the child's first request begins with the same bytes and reads the provider's cache. Refused,
   * with the reason, when that call is not on record (a daemon restart, plan mode, a compound session), the history no longer starts with
   * what it sent, or another model is asked for: a cache is read only by the same model.
   */
  async function forkStart(parentId: SessionId, model?: string): Promise<ForkStart | { refused: string }> {
    const last = options.compound?.(parentId) ? undefined : lastMain.get(parentId)
    if (!last) return { refused: "no main request of the parent is on record" }
    if (model && model !== (last.choice?.model ?? options.provider.model)) return { refused: "another model cannot read the parent's cache" }
    const sent = asLastSent((await options.history.load(parentId)) ?? [], last)
    if (!sent) return { refused: "the parent's history changed since its last request" }
    const { system, tools, hostedTools, choice, effort, parameters, cache } = last
    return { prefix: { system, tools, hostedTools, choice, effort, parameters, cache }, messages: pruneToolOutputs(sent.slice(0, last.sent), last.pruned).messages }
  }
  const forkPrompt = (prompt: string, agent: AgentProfile | undefined) => {
    const role = agent ? agentSection(agent) : ""
    return `${FORK_NOTE}${role ? `${role}\n\n` : ""}${prompt}`
  }
  const turnStarts = new Map<SessionId, TurnStart>()
  /** The cache lineage of each session's latest main call, so its sub-agents' calls follow the same generation. */
  const lineages = new Map<SessionId, string>()
  /**
   * The provider's prompt cache key for a call. `off`: none. `legacy`: the session (a sub-agent's calls, which have a
   * different prefix, get their own). `smart`: the lineage, the session plus its compaction generation: a compaction
   * replaces the history with a summary message, and that message's hash names the generation, so the key survives a
   * restart and changes exactly when the prefix does.
   */
  function cacheKeyFor(input: { mode: PromptCacheMode; sessionId: SessionId; role: ModelRole; messages: readonly ModelMessage[] }): string | undefined {
    const { mode, sessionId } = input
    if (mode === "off") return undefined
    if (input.role === "subagent") return `${mode === "smart" ? (lineages.get(sessionId) ?? sessionId) : sessionId}/subagent`
    if (mode === "legacy") return sessionId
    const first = input.messages[0]
    const key = first?.role === "user" && first.content.startsWith(SUMMARY_PREFIX) ? `${sessionId}~${createHash("sha256").update(`${first.content}:${first.compaction?.generation ?? 0}`).digest("hex").slice(0, 8)}` : sessionId
    lineages.set(sessionId, key)
    return key
  }
  const sleep = options.sleep ?? defaultSleep
  const clocks = options.clocks ?? systemClocks
  // Only a real sleep (the wall clock ran ahead) drops a live stream; a blocked event loop alone does not.
  const watchWake = options.watchWake ?? ((onWake: () => void) => watchForWake({ clocks, onWake: (kind) => kind === "divergence" && onWake() }))
  const grants = options.grants ?? createGrantStore()
  /** Context size of each session's last model call (input + cached + output tokens). */
  const contextTokens = new Map<SessionId, number>()
  /** Read at each check so a settings change applies to the next turn. */
  const compactionConfig = () => options.compaction?.() ?? {}
  const limitsFor = (sessionId: SessionId) => {
    const choice = choiceFor(options.modelFor?.(sessionId, "main"), lastAgent.get(sessionId))
    const override = options.contextWindowOverrideFor?.(sessionId, choice?.model)
    if (override) {
      const { contextWindow: _window, inputLimit: _input, ...rest } = options.provider.compactionLimits?.(choice?.model) ?? {}
      return { ...rest, contextWindow: override }
    }
    const window = options.contextWindowFor?.(sessionId)
    return { ...(window ? { contextWindow: window } : {}), ...options.provider.compactionLimits?.(choice?.model) }
  }
  const compactAt = (sessionId: SessionId) => compactionThreshold(compactionConfig(), limitsFor(sessionId), typeof options.compactAtTokens === "function" ? options.compactAtTokens(sessionId, choiceFor(options.modelFor?.(sessionId, "main"), lastAgent.get(sessionId))?.model) : options.compactAtTokens)
  /** Tokens of old tool output each session's last request left out, so the size `pruneNow` compares does not fall because of the prune itself. */
  const prunedTokens = new Map<SessionId, number>()
  /**
   * Whether old tool outputs are pruned now (`pruneDue`, compaction-policy.ts): the `prune` setting allows it and the context is close to
   * the compaction threshold. Far from it a prune only costs: the provider re-reads, uncached, everything after the first pruned result.
   */
  const pruneNow = (sessionId: SessionId, messages: readonly ModelMessage[]) =>
    compactionConfig().prune !== false && prunable(messages) && pruneDue((contextTokens.get(sessionId) ?? historyTokens(messages)) + (prunedTokens.get(sessionId) ?? 0), compactAt(sessionId))

  /** Resolves attachment refs to bytes for the request only; a missing blob degrades to a text note. */
  async function withImages(messages: ModelMessage[]): Promise<ModelMessage[]> {
    if (!messages.some((m) => m.role === "user" && m.attachments?.length)) return messages
    return Promise.all(
      messages.map(async (message) => {
        if (message.role !== "user" || !message.attachments?.length) return message
        const images: RequestImage[] = []
        const documents: import("./provider").RequestDocument[] = []
        let missing = 0
        const texts: number[] = []
        // Attachments that have a token in the text go in the order the tokens stand; the rest keep their order (all of them, for a message without tokens).
        const slots = new Map<number, import("./provider").RequestPart>()
        for (const at of attachmentOrder(message.content, message.attachments)) {
          const ref = message.attachments[at]!
          const bytes = await options.readBlob?.(ref).catch(() => undefined)
          if (bytes && ref.mime === "application/pdf") slots.set(at, { document: documents.push({ mime: "application/pdf", base64: Buffer.from(bytes).toString("base64"), name: ref.name ?? "document.pdf" }) - 1 })
          else if (bytes && ref.mime.startsWith("image/")) slots.set(at, { image: images.push({ mime: ref.mime, base64: Buffer.from(bytes).toString("base64") }) - 1 })
          // A long paste the prompt kept as its label: the text itself goes where the label stands.
          else if (bytes && ref.mime === "text/plain") texts.push(at), slots.set(at, { text: pastedText(bytes) })
          else missing++
        }
        const note = missing ? `\n\n[${missing} attachment(s) no longer available]` : ""
        const placed = layoutAttachments(message.content, message.attachments)
        const layout = placed ? [...placed.flatMap((part) => ("text" in part ? [part] : slots.has(part.ref) ? [slots.get(part.ref)!] : [])), ...(note ? [{ text: note }] : [])] : undefined
        // An adapter that reads `content` alone (no `layout`) still gets each pasted text, where its label stands.
        const pasted = new Map(texts.map((at) => [at, (slots.get(at) as { text: string }).text]))
        const content = inlineTexts(message.content, message.attachments, pasted).text
        return { ...message, content: content + note, images, ...(documents.length ? { documents } : {}), ...(layout ? { layout } : {}) }
      }),
    )
  }

  /** Blob refs for the images a tool result carries (at most 2, each within 5 MB); none when storing is not configured. */
  async function storeToolImages(sessionId: SessionId, images: ReadonlyArray<{ mime: string; bytes: Uint8Array; name?: string }> | undefined): Promise<BlobRef[]> {
    if (!images?.length || !options.storeBlob) return []
    const stored = await Promise.all(images.slice(0, MAX_TOOL_IMAGES).filter((image) => image.bytes.byteLength <= MAX_TOOL_IMAGE_BYTES).map(async (image) => {
      const ref = await options.storeBlob!(image.bytes, image.mime, sessionId).catch(() => undefined)
      return ref ? { ...ref, ...(image.name ? { name: image.name } : {}) } : undefined
    }))
    return stored.filter((ref): ref is BlobRef => ref !== undefined)
  }

  /**
   * The context after a call is what the clients show (`usageContext`): the prompt plus the answer. `reasoning` is not added:
   * every adapter reports it as a part of `output` (OpenAI's `output_tokens` and Chat Completions' `completion_tokens`
   * include it, Gemini's thoughts are added into `output` by the adapter, Anthropic reports none apart), so adding it counted
   * thinking twice and compacted early.
   */
  function recordContext(sessionId: SessionId, usage: ModelUsage) {
    contextTokens.set(sessionId, usageContext({ provider: "native", ...usage })!)
  }

  /**
   * One model call with retries; text streams into an item of `textKind` (an answer or a compaction
   * summary). `callTools` defaults to the full tool set; a sub-agent passes its reduced set.
   *
   * Network and transient failures are retried with backoff until the user cancels; a wake from sleep or a host that
   * answers again cuts the wait short. An answer cut after some text is continued in the same item (the partial goes
   * back as history with the continuation prompt, and whatever the model repeats of it is trimmed).
   */
  async function callModel(input: CallInput, messages: ModelMessage[], textKind: "agent_message" | "compaction" = "agent_message", callTools: ToolSpec[] = textKind === "agent_message" ? specs : [], role: ModelRole = textKind === "compaction" ? "compaction" : "main", agent?: AgentProfile, compact?: { maxOutputTokens?: number; meta: Record<string, string | number | boolean>; cacheMessages?: readonly ModelMessage[]; /** Repeat the last main call's request (`messages` is then the history alone) and append `prompt` as one more user message. */ share?: { prompt: string; last: SharedPrefix }; /** A forked child's call: the parent's system prompt, tools, model, effort and cache key ahead of the child's own history. */ fork?: ForkPrefix }, final = false) {
    // A sub-agent's context is its own; the session's context size comes from its main calls only.
    const trackContext = role !== "subagent"
    const share = compact?.share
    const fork = compact?.fork
    // The final, text-only step of a fork sends no tools, like any other.
    if (fork && callTools.length) callTools = fork.tools
    const override = textKind === "agent_message" ? role === "subagent" && options.tasks ? options.modelFor?.(input.sessionId, role) : input.selection?.model : textKind === "compaction" ? input.selection?.model : undefined
    const compound = options.compound?.(input.sessionId)
    const selected = override ?? options.modelFor?.(input.sessionId, role)
    const profile = (override || options.tasks?.isChild(input.sessionId)) && agent ? (({ model: _model, variant: _variant, effort: _effort, ...rest }) => rest)(agent) : agent
    const choice = share ? share.last.choice : fork ? fork.choice : compound?.choice ?? input.workflow?.execution.model ?? choiceFor(selected, profile)
    callTools = callTools.filter((tool) => !workflowToolDenied(input.workflow?.execution, tool.name))
    /** Answer text already shown when the connection dropped; the next attempt continues it in the same item. */
    let carried: { itemId: ItemId; text: string } | undefined
    /**
     * A retry re-sends the whole request, so the model repeats the same provider-side search. When the provider fails twice in a row in a
     * step that used a hosted tool, the next attempts go without that tool and say so, instead of repeating the search for ever.
     */
    const hostedFailures = new Map<HostedTool, number>()
    const hostedOff = new Set<HostedTool>()
    /** A provider deadline (`RetryableProviderError.immediate`) skips the backoff once per call; if it fires again the usual waits apply. */
    let retriedAtOnce = false
    for (let attempt = 0; ; attempt++) {
      const exhausted = input.workflow?.beforeCall()
      if (exhausted) throw new Error(`workflow budget: ${exhausted}`)
      const span = options.trace?.start("session.llm", { sessionId: input.sessionId, ...(input.turnId ? { turnId: input.turnId } : {}), role, attempt })
      let traceStatus: "ok" | "error" | "cancelled" = "ok"
      const traceUsage: import("@mendcode/protocol").TraceMetadata = {}
      const step = { text: carried?.text ?? "", toolCalls: [] as ToolCall[], textItem: carried?.itemId, reasoningItem: undefined as ItemId | undefined, emitted: carried !== undefined, images: [] as BlobRef[], reasoning: undefined as ReasoningState | undefined, cards: new Map<string, EarlyCard>() }
      /** True once the step leaves with its calls: their early cards are the tool loop's to finish. */
      let handedOver = false
      /** Hosted tool calls still running, by the provider's id; any left open when the call ends are closed as cancelled. */
      const hosted = new Map<string, ItemId>()
      const hostedUsed = new Set<HostedTool>()
      const continuation =carried ? continuationStream(carried.text) : undefined
      // Each attempt has its own signal, so a wake from sleep can drop a stream whose connection died silently.
      const call = new AbortController()
      const abortCall = () => call.abort()
      input.signal.addEventListener("abort", abortCall, { once: true })
      let woke = false
      const stopWatching = watchWake(() => {
        woke = true
        call.abort()
      })
      let keepText = false
      const recordedUsage: Array<() => void> = []
      let providerStarted = false
      let usageReported = false
      /** This attempt's entry in `lastMain`, when it is a main call. */
      let recorded: SharedPrefix | undefined
      const showText = (delta: string) => {
        if (!delta) return
        if (!step.textItem) {
          step.textItem = input.newItemId()
          input.emit({ type: "item.started", itemId: step.textItem, kind: textKind, ...(textKind === "agent_message" ? { meta: { historyIndex: messages.length } } : compact ? { meta: compact.meta } : {}) })
        }
        step.text += delta
        input.emit({ type: "item.delta", itemId: step.textItem, text: delta })
      }
      try {
        const continued: ModelMessage[] = carried ? [{ role: "assistant", content: carried.text, toolCalls: [] }, { role: "user", content: options.continuationPrompt! }] : []
        // A shared request projects and prunes the history alone, exactly as the last main call did; its own prompt is appended after.
        const resumed: ModelMessage[] = share || !carried ? messages : [...messages, ...continued]
        const cwd = options.cwdFor(input.sessionId)
        // The role hooks see: a shared request must come out of them as the main call's did.
        const hookRole: ModelRole = share || fork ? "main" : role
        let system = share ? share.last.system : fork ? fork.system : options.system(cwd, { sessionId: input.sessionId, prompt: lastPrompt(messages) })
        if (!share && !fork) {
          const agentText = agent ? agentSection(agent) : ""
          if (agentText) system = `${system}\n\n${agentText}`
          const known = secrets?.list(input.sessionId) ?? []
          if (known.length) system = `${system}\n\n${secretsNote(known)}`
          if (input.turnOptions?.format && role !== "subagent" && textKind === "agent_message") system = `${system}\n\n${STRUCTURED_NOTE}`
          if (compound?.critic) { system = "Review only the immutable candidate supplied by the host. Return strict JSON. No tools."; callTools = [] }
          if (!compound && hooks?.has("prompt.system", cwd)) system = (await hooks.system?.({ sessionId: input.sessionId, cwd, role, system })) ?? system
        }
        const projection = await checkpointContext(options.provider, { system, messages: resumed, tools: callTools, model: choice?.model, parameters: choice?.parameters, effort: choice?.effort })
        // A fork's inherited messages were pruned as the parent sent them (`forkStart`); a prune counted from the child's end would change them.
        const pruneEnabled = share ? share.last.pruned : fork ? false : pruneNow(input.sessionId, projection.messages)
        const pruned = pruneToolOutputs(projection.messages, pruneEnabled)
        if (trackContext) prunedTokens.set(input.sessionId, pruned.tokens)
        let outgoing = pruned.messages
        // Hooks see a copy of the messages (history stays the engine's) and only cost an await when a handler exists.
        if (!compound && hooks?.has("context", cwd)) outgoing = (await hooks.context?.({ sessionId: input.sessionId, cwd, role: hookRole, messages: structuredClone(outgoing) })) ?? outgoing
        if (share) outgoing = [...outgoing, { role: "user", content: share.prompt }, ...continued]
        const request = await withImages(outgoing)
        const provider = options.provider.idFor?.(choice?.model) ?? options.provider.id
        const model = choice?.model ?? options.provider.model
        const modelRef = { sessionId: input.sessionId, cwd, provider, model, role: hookRole }
        const shaped = !compound && hooks?.has("chat.params", cwd) ? await hooks.parameters?.({ ...modelRef, parameters: structuredClone(choice?.parameters ?? {}) }) : undefined
        const transport = !compound && hooks?.has("chat.headers", cwd) ? await hooks.headers?.(modelRef) : undefined
        const parameters = shaped?.parameters as NonNullable<ModelChoice["parameters"]> | undefined
        const requestTools = !compound && hooks?.has("tool.definition", cwd) ? await Promise.all(callTools.map(async (tool) => ({ ...tool, ...await hooks.definition?.({ sessionId: input.sessionId, cwd, tool: tool.name, description: tool.description, parameters: structuredClone(tool.parameters) }) }))) : callTools
        const config = options.cacheConfig?.(input.sessionId)
        const selection = selectCache({ config, directory: cwd, session: input.sessionId, provider: options.provider.idFor?.(choice?.model) ?? options.provider.id, model: choice?.model ?? options.provider.model })
        let cacheMode = selection.mode === "legacy" ? options.promptCache?.() ?? "legacy" : selection.mode
        let cacheKey = cacheKeyFor({ mode: cacheMode, sessionId: input.sessionId, role: hookRole, messages: compact?.cacheMessages ?? messages })
        let cacheKeyForBody: ModelRequest["cacheKeyForBody"]
        if (config && cacheMode === "smart") {
          const binding = await options.provider.cacheBinding?.(choice?.model)
          const passive = passiveCache(binding)
          if (passive === "none") { cacheKey = undefined; cacheMode = "legacy" }
          else if (passive === "session") cacheKey = cacheKeyFor({ mode: "legacy", sessionId: input.sessionId, role: hookRole, messages })
          else {
            const first = (compact?.cacheMessages ?? messages)[0]
            const generation = first?.role === "user" && first.content.startsWith(SUMMARY_PREFIX) ? cacheHash([first.content, first.compaction?.generation]) : null
            // Partition by the actual binding and resolved prefix, never by a raw project path or credential.
            const partition = { binding, project: cacheProject(cwd), session: selection.scope === "session" ? input.sessionId : null, role: hookRole, generation, revision: 1 }
            // Tools found with `tool_search` are appended after it, so the key names the list up to `tool_search`: finding a tool must not move the request to another cache route.
            // The route is all this keeps: the longer tool list still ends the shared prefix, so that one call is read uncached and the next ones hit again
            // (except where the adapter loads found tools through the conversation and the list never grows: docs/tool-discovery.md).
            cacheKey = `mc:${cacheHash({ ...partition, system, tools: withoutDiscovered(requestTools), parameters: parameters ?? choice?.parameters, effort: choice?.effort })}`
            cacheKeyForBody = (body) => {
              const { input: _input, messages: _messages, prompt_cache_key: _key, tools: bodyTools, ...rest } = body
              const prefix = Array.isArray(bodyTools) ? { ...rest, tools: withoutDiscovered(bodyTools) } : rest
              const systemMessages = Array.isArray(body.messages) ? body.messages.filter((message) => message?.role === "system" || message?.role === "developer") : []
              return `mc:${cacheHash({ ...partition, prefix, systemMessages })}`
            }
          }
        }
        // A fork is routed to its parent's cache: the provider finds the prefix only under the key it was written with. A cache turned off since stays off.
        if (fork && cacheMode !== "off") { cacheMode = fork.cache.mode ?? cacheMode; cacheKey = fork.cache.key; cacheKeyForBody = fork.cache.forBody }
        const hostedRules = policyRules(policy(), agent?.permissionRules, options.sessionRules?.(input.sessionId), projectRulesOf(policy(), options.cwdFor(input.sessionId)))
        const primaryOnly = policy().experimental?.primary_tools ?? []
        /** A provider-side tool runs with no approval card, so this call's own rules decide whether it is offered at all. */
        const hostedAllowed = (name: HostedTool) => {
          const rule = matchingRule(permissionName(name), "*", hostedRules)
          return !hostedOff.has(name) && rule?.action !== "deny" && rule?.action !== "ask" && (!agent || agentAllows(agent, name)) && !workflowToolDenied(input.workflow?.execution, name, "execute") && !workflowToolAsks(input.workflow?.execution, name, "execute") && (role !== "subagent" || !primaryOnly.some((pattern) => permissionMatch(name, pattern)))
        }
        // A fork keeps its parent's hosted tools for the shared prefix, less those its own rules refuse (the prefix then differs there).
        const hostedTools = share ? share.last.hostedTools : fork ? callTools.length ? fork.hostedTools.filter(hostedAllowed) : [] : !compound && textKind === "agent_message" && !final ? (options.hostedTools?.() ?? []).filter(hostedAllowed) : []
        if (hostedOff.size) system = `${system}\n\n${hostedOffNote([...hostedOff])}`
        const transformBody =!compound && hooks?.has("request.before", cwd) && hooks.requestBody ? (body: Record<string, unknown>) => hooks.requestBody!({ sessionId: input.sessionId, cwd, provider: options.provider.idFor?.(choice?.model) ?? options.provider.id, model: choice?.model ?? options.provider.model, body }) : undefined
        const estimatedTokens = requestEstimates(system, (options.systemParts?.(cwd, { sessionId: input.sessionId, prompt: lastPrompt(messages) }) ?? []).filter((part) => part.id === "memory").map((part) => part.text), outgoing, [...callTools, ...hostedTools])
        const startedAt = Date.now()
        let firstTokenMs: number | null = null
        await options.beforeModel?.({ model: choice?.model ?? options.provider.model, signal: input.signal, ...(input.ask ? { ask: input.ask } : {}) })
        const reasoning = options.reasoning && input.turnId && (role === "main" || role === "plan") && !options.tasks?.isChild(input.sessionId)
          ? await options.reasoning.prepare({ sessionId: input.sessionId, turnId: input.turnId, generationId: `${input.turnId}:${role}:${messages.length}:${attempt}`, role, choice: choice ?? { model: options.provider.model }, messages, signal: call.signal, manual: !!(override?.effort || override?.variant || override?.parameters || agent?.effort || agent?.model), ...(input.text === undefined ? {} : { publicGoal: input.text }) })
          : undefined
        reasoning?.dispatch()
        providerStarted = true
        const maxOutputTokens = compact?.maxOutputTokens ?? shaped?.maxOutputTokens
        const modelRequest: ModelRequest = { system, messages: request, tools: requestTools, ...(role === "subagent" || options.tasks?.isChild(input.sessionId) || textKind !== "agent_message" || carried ? { initiator: "agent" as const } : {}), ...(projection.nativeContext ? { nativeContext: projection.nativeContext } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}), ...(hostedTools.length ? { hostedTools } : {}), ...(choice ? { model: choice.model, effort: choice.effort, parameters: choice.parameters, ...(choice.fast !== undefined ? { fast: choice.fast } : {}) } : {}), ...(reasoning ? { effort: reasoning.effort } : {}), ...(parameters ? { parameters } : {}), ...transport, ...(transformBody ? { transformBody } : {}), ...(cacheKey ? { cacheKey } : {}), ...(cacheKeyForBody ? { cacheKeyForBody } : {}), cacheMode, signal: call.signal }
        const cacheTtl = cacheMode === "off" ? undefined : options.cacheTtl?.({ sessionId: input.sessionId, role: hookRole, provider })
        if (cacheTtl) modelRequest.cacheTtl = cacheTtl
        const repeated = share?.last ?? fork
        if (repeated) { modelRequest.effort = repeated.effort; modelRequest.parameters = repeated.parameters }
        if (role === "main" && textKind === "agent_message" && !compound) lastMain.set(input.sessionId, recorded = { system, tools: callTools, hostedTools, choice, effort: modelRequest.effort, parameters: modelRequest.parameters, pruned: pruneEnabled, sent: messages.length, digest: historyDigest(messages), turn: turnStarts.get(input.sessionId), cache: { mode: cacheMode, key: cacheKey, forBody: cacheKeyForBody } })
        // A plan-mode call is the session's latest request but not one a compaction can repeat (its own model and tools): nothing is on record after it.
        else if (role === "plan" && textKind === "agent_message") lastMain.delete(input.sessionId)
        modelRequest.turnSignal = providerTurnSignals.get(input.signal) ?? input.signal
        modelRequest.conversationId = input.sessionId
        const stream = compound ? compound.budget.stream(options.provider, modelRequest, compound) : options.provider.stream(modelRequest)
        for await (const event of stream) {
          if (call.signal.aborted) break
          if (firstTokenMs === null && (event.type === "tool_call" || (event.type === "text" || event.type === "reasoning") && event.delta)) firstTokenMs = Math.max(0, Date.now() - startedAt)
          if (firstTokenMs !== null) traceUsage.firstTokenMs = firstTokenMs
          if (event.type === "text" && event.delta) {
            step.emitted = true
            showText(continuation ? continuation.push(event.delta) : event.delta)
          } else if (event.type === "reasoning" && event.delta) {
            step.emitted = true
            if (!step.reasoningItem) {
              step.reasoningItem = input.newItemId()
              input.emit({ type: "item.started", itemId: step.reasoningItem, kind: "reasoning" })
            }
            input.emit({ type: "item.delta", itemId: step.reasoningItem, text: event.delta })
          } else if (event.type === "tool_input") {
            if (textKind !== "agent_message" || LATE_CARD_TOOLS.has(event.name)) continue
            const card = step.cards.get(event.callId) ?? { name: event.name, json: "", told: 0 }
            step.cards.set(event.callId, card)
            card.json += event.delta
            if (!card.itemId && card.json.length >= EARLY_TOOL_CHARS) {
              if (continuation) showText(continuation.flush())
              card.itemId = input.newItemId()
              card.title = callTitle({ callId: event.callId, name: event.name, args: partialToolArgs(card.json) }).slice(0, 200)
              input.emit({ type: "item.started", itemId: card.itemId, kind: "tool_call", meta: { tool: card.title } })
            }
            if (card.itemId && card.json.length - card.told >= INPUT_PROGRESS_CHARS) {
              card.told = card.json.length
              input.emit({ type: "item.delta", itemId: card.itemId, text: "", input: toolInputProgress(card.json) })
            }
          } else if (event.type === "tool_call") {
            if (continuation) showText(continuation.flush())
            const card = step.cards.get(event.call.callId)
            if (card?.itemId) {
              card.whole = true
              input.emit({ type: "item.delta", itemId: card.itemId, text: "", input: { ...toolInputProgress(card.json), done: true } })
            }
            step.toolCalls.push(PLAN_TOOL_NAMES.has(event.call.name) ? { ...event.call, args: safePlanArgs(event.call.args, (text) => secrets ? secrets.mask(input.sessionId, text) : text) } : event.call)
          } else if (event.type === "hosted_tool") {
            step.emitted = true
            hostedUsed.add(event.tool)
            let itemId = hosted.get(event.id)
            if (!itemId) {
              itemId = input.newItemId()
              hosted.set(event.id, itemId)
              input.emit({ type: "item.started", itemId, kind: "tool_call", meta: { tool: event.tool } })
            }
            if (event.status !== "started") {
              hosted.delete(event.id)
              const refs = event.image ? await storeToolImages(input.sessionId, [{ mime: event.image.mime, bytes: Buffer.from(event.image.base64, "base64") }]) : []
              step.images.push(...refs)
              const where = refs[0] && options.blobPath ? `\n${options.blobPath(refs[0])}` : ""
              input.emit({ type: "item.completed", itemId, status: event.status === "failed" || (event.image && !refs.length) ? "error" : "ok", text: clip(`${event.detail ?? ""}${where}`.trim()), ...(refs.length ? { attachments: refs } : {}) })
            }
          } else if (event.type === "usage") {
            usageReported = true
            Object.assign(traceUsage, { inputTokens: event.usage.input, outputTokens: event.usage.output, cacheReadTokens: event.usage.cacheRead, cacheWriteTokens: event.usage.cacheWrite })
            if (trackContext) recordContext(input.sessionId, event.usage)
            if (recorded) recorded.contextTokens = usageContext({ provider: "native", ...event.usage })!
            recordedUsage.splice(0, recordedUsage.length, () => input.emit({ type: "usage", provider: options.provider.idFor?.(choice?.model) ?? options.provider.id, model: choice?.model ?? options.provider.model, ...event.usage, ...(role === "main" ? { compactAt: compactAt(input.sessionId) } : {}), profile: { estimatedTokens, firstTokenMs, durationMs: Math.max(0, Date.now() - startedAt), toolCount: callTools.length + hostedTools.length, imageCount: request.reduce((sum, message) => sum + (message.role === "user" ? message.images?.length ?? 0 : 0), 0) } }))
          } else if (event.type === "reasoning_state") {
            step.reasoning = event.state
          }
        }
        if (woke && !input.signal.aborted) throw new RetryableProviderError("[PROVIDER]: connection lost while the computer slept", undefined, "network")
        if (continuation && !input.signal.aborted) showText(continuation.flush())
        if (step.textItem && !input.signal.aborted && hooks?.has("text.complete", cwd)) step.text = (await hooks.textComplete?.({ sessionId: input.sessionId, cwd, itemId: step.textItem, text: step.text })) ?? step.text
        handedOver = true
        return step
      } catch (error) {
        traceStatus = "error"
        for (const emitUsage of recordedUsage.splice(0)) emitUsage()
        const failure = woke && !input.signal.aborted && !(error instanceof RetryableProviderError) ? new RetryableProviderError("[PROVIDER]: connection lost while the computer slept", undefined, "network") : error
        if (!(failure instanceof RetryableProviderError) || input.signal.aborted || (options.retries !== undefined && attempt >= options.retries)) throw failure
        // A tool call that arrived whole runs; the rest of the lost stream is not needed for it.
        if (step.toolCalls.length) {
          handedOver = true
          return step
        }
        if (step.text) {
          // Without a continuation prompt a half-streamed answer is surfaced, not duplicated.
          if (!options.continuationPrompt) throw failure
          if (continuation) showText(continuation.flush())
          carried = { itemId: step.textItem!, text: step.text }
          keepText = true
        }
        const dropped: HostedTool[] = []
        if (failure.kind !== "network") {
          for (const tool of hostedUsed) {
            const failures = (hostedFailures.get(tool) ?? 0) + 1
            hostedFailures.set(tool, failures)
            if (failures >= HOSTED_FAILURE_LIMIT && !hostedOff.has(tool)) { hostedOff.add(tool); dropped.push(tool) }
          }
        }
        // The retry after the limit starts at once: it is a different request, not the same one again.
        const atOnce = failure.immediate && !retriedAtOnce
        retriedAtOnce ||= failure.immediate
        const delayMs = dropped.length || atOnce ? 0 : Math.max(failure.retryAfterMs ?? 0, backoffMs(attempt))
        // Said out loud so the UI shows the wait instead of looking stuck.
        input.emit({ type: "retrying", attempt: attempt + 1, delayMs, message: dropped.length ? `${dropped.map(hostedLabel).join(", ")} failed at the provider ${HOSTED_FAILURE_LIMIT} times; continuing without it` : failure.message.replace(/^\[PROVIDER\]:\s*/, ""), ...(failure.kind === "network" && !failure.immediate ? { offline: true } : {}) })
        const outcome = await waitToRetry({ delayMs, kind: failure.kind, signal: input.signal, sleep, clocks, ...(options.provider.probe ? { probe: () => options.provider.probe!(choice?.model) } : {}) })
        if (outcome === "cancelled") {
          keepText = false
          return step
        }
        continue
      } finally {
        if (providerStarted && !usageReported) options.onMissingUsage?.()
        span?.end(input.signal.aborted ? "cancelled" : traceStatus, traceUsage)
        for (const emitUsage of recordedUsage) emitUsage()
        stopWatching()
        input.signal.removeEventListener("abort", abortCall)
        for (const itemId of hosted.values()) input.emit({ type: "item.completed", itemId, status: "cancelled" })
        // A card whose input never became whole (the stream stopped or the request failed) has no call to run.
        for (const card of step.cards.values()) {
          if (!card.itemId || (handedOver && card.whole)) continue
          input.emit({ type: "item.completed", itemId: card.itemId, status: input.signal.aborted ? "cancelled" : "error", text: input.signal.aborted ? "" : "the stream stopped before this call's input was whole; it did not run" })
        }
        if (step.reasoningItem) input.emit({ type: "item.completed", itemId: step.reasoningItem, status: input.signal.aborted ? "cancelled" : "ok" })
        if (step.textItem && !keepText) input.emit({ type: "item.completed", itemId: step.textItem, status: input.signal.aborted ? "cancelled" : "ok", text: clip(step.text) })
      }
    }
  }

  /** `PermissionRequest` shell hooks run right before the user would be asked; one that blocks refuses the call without a prompt. */
  async function askRefusal(input: TurnInput, tool: Tool, call: ToolCall, detail: string): Promise<Extract<PermitResult, { kind: "deny" }> | undefined> {
    const cwd = options.cwdFor(input.sessionId)
    if (!hooks?.has("permission.request", cwd) || !hooks.permissionRequest) return undefined
    const refused = await hooks.permissionRequest({ sessionId: input.sessionId, cwd, tool: tool.name, args: structuredClone(call.args as Record<string, unknown>), detail })
    return refused ? { kind: "deny", by: "rule", reason: `blocked by a PermissionRequest hook: ${refused.deny}` } : undefined
  }

  async function ruleGate(input: TurnInput, tool: Tool, call: ToolCall, itemId: ItemId, toolset: Toolset, permission: string, patterns: string[], fallbackAsk = false, obeyMode = true, provenance?: PermissionProvenance, onAsk?: () => void): Promise<PermitResult | undefined> {
    const rules = rulesFor(toolset, input.sessionId)
    const expanded = permission === "bash" ? expandedShellPatterns(tool.name, call.args) : new Set<string>()
    const matches = patterns.map((pattern) => ({ pattern, rule: withoutBlindAllow(matchingRule(permission, pattern, rules), expanded.has(pattern)) }))
    const denied = matches.find((match) => match.rule?.action === "deny")
    if (denied) return { kind: "deny", by: "rule", reason: `${permission} ${denied.pattern} (${denied.rule!.pattern})` }
    // A session grant is a saved pattern: for a command that only exists after expansion it counts only when it is that exact text.
    const granted = (pattern: string) => expanded.has(pattern) ? grants.list(input.sessionId).some((grant) => grant.rulePermission === permission && grant.pattern === pattern) : grants.has(input.sessionId, tool.name, pattern, permission)
    const pending = matches.filter(({ pattern, rule }) => (rule?.action === "ask" || (!rule && fallbackAsk)) && !granted(pattern))
    if ((obeyMode && modeOf(input, toolset) === "full") || (pending.length === 0 && matches.every(({ rule }) => rule?.action === "allow"))) return { kind: "approve", scope: "once" }
    if (!pending.length) return matches.some(({ rule }) => rule?.action === "ask") ? { kind: "approve", scope: "session", permissionSource: "grant" } : undefined
    // Full mode never waits on the user (a sub-agent's prompt can sit unseen for hours): the repeated call is refused and the model adapts.
    if (!obeyMode && modeOf(input, toolset) === "full") return { kind: "deny", by: "rule", reason: `${call.name} ran 3 times in a row with the same arguments; if you are waiting on something, wait longer or check another way, otherwise change approach` }
    onAsk?.()
    const hookRefusal = await askRefusal(input, tool, call, approvalDetail(call))
    if (hookRefusal) return hookRefusal
    const answer = await input.ask({ kind: "approval", title: permission === "external_directory" ? "external directory access" : permission === "doom_loop" ? "repeated tool action" : permission, detail: `${permission}: ${pending.map(({ pattern }) => pattern).join(", ")}\n\n${approvalDetail(call)}`, itemId, tool: tool.name, permission: tool.permission, permissionContext: { name: permission, patterns: pending.map(({ pattern }) => pattern), always: pending.map(({ pattern }) => pattern) } })
    if (input.signal.aborted) return { kind: "abandoned" }
    if (answer.kind === "approve" && answer.scope === "session") for (const { pattern } of pending) grants.add(input.sessionId, tool.name, tool.permission, pattern, permission, provenance)
    return { ...answer, permissionSource: "manual" }
  }

  /**
   * Whether a tool call runs, asks or is refused. `smart` mode settles low-risk calls by rule (src/smart-permissions.ts),
   * lets an optional reviewer model clear or refuse the rest, and asks the user about what is left; a session grant
   * never covers a high-risk call in `smart` mode.
   */
  async function permit(input: TurnInput, tool: Tool, call: ToolCall, itemId: ItemId, toolset: Toolset, frozen: ReturnType<typeof freezeAction>, explicitApproval = false): Promise<PermitResult> {
    const parsedPermission = tool.args.safeParse(call.args)
    const permissionContext = { threads: options.threads?.(input.sessionId) }
    if (parsedPermission.success && tool.permissionFor) tool = { ...tool, permission: tool.permissionFor(parsedPermission.data, permissionContext) }
    tool = sessionRecallPermission(tool, call.args)
    const mode = modeOf(input, toolset)
    const cwd = options.cwdFor(input.sessionId)
    const context = authorityContext(input, options.authorityAnchors?.(input.sessionId))
    const authority = { ...context, userText: secrets ? secrets.mask(input.sessionId, context.userText) : context.userText }
    const { userText, ...evidence } = authority
    const provenance: PermissionProvenance = { turnId: input.turnId, authority: evidence, action: frozen.action }
    const startedAt = Date.now()
    const reviewId = `review:${itemId}:${frozen.action.fingerprint.slice(0, 16)}`
    const record = (status: PermissionReview["status"], source: PermissionReview["source"], reason: string) => {
      if (mode === "smart") grants.review({ reviewId, sessionId: input.sessionId, tool: tool.name, status, source, reason: (secrets ? secrets.mask(input.sessionId, reason) : reason).slice(0, 300), createdAt: startedAt, updatedAt: Date.now(), provenance })
    }
    const settle = (answer: PermitResult, source: PermissionReview["source"], reason: string): PermitResult => {
      record(answer.kind === "approve" ? "allowed" : answer.kind === "abandoned" ? "cancelled" : "denied", source, reason)
      return answer
    }
    record("reviewing", "deterministic", "Checking permission rules")
    const patterns = permissionPatterns(tool.name, call.args, cwd)
    // What `bash -c '…'`, `eval`, `xargs` and `$(…)` run also meets the deny and ask rules (never an allow rule: that does not vouch for what a wrapper runs).
    const nested = nestedShellPatterns(tool.name, call.args).filter((pattern) => ["deny", "ask"].includes(matchingRule(permissionName(tool.name), pattern, rulesFor(toolset, input.sessionId))?.action ?? ""))
    const rulePatterns = nested.length ? [...patterns, ...nested] : patterns
    const denied = rulePatterns.some((pattern) => matchingRule(permissionName(tool.name), pattern, rulesFor(toolset, input.sessionId))?.action === "deny")
    if (denied) return settle({ kind: "deny", by: "rule", reason: `permission rule denies ${tool.name}` }, "deterministic", "Permission rule denies the action")
    if (mode === "plan" && tool.permission !== "read") return { kind: "deny", by: "rule", reason: "plan mode is read-only; investigate, then propose the plan with plan_submit" }
    const pluginPermission = hooks?.has("permission.ask", cwd) ? await hooks.permission?.({ sessionId: input.sessionId, cwd, tool: tool.name, args: structuredClone(call.args as Record<string, unknown>) }) : undefined
    if (pluginPermission?.status === "deny") return { kind: "deny", by: "rule", reason: "plugin permission hook denied the action" }
    const previewOf = (data: unknown) => tool.preview!(data as never, { cwd, signal: input.signal, ...(options.packages ? { packages: options.packages(input.sessionId) } : {}), ...(options.workflows ? { workflows: options.workflows(input.sessionId) } : {}), ...(options.loops ? { loops: options.loops(input.sessionId) } : {}), ...(options.worktrees ? { worktrees: options.worktrees(input.sessionId) } : {}), ...(options.prWatch ? { prWatch: options.prWatch(input.sessionId) } : {}), ...(options.aiConfig ? { aiConfig: options.aiConfig(input.sessionId) } : {}) }).catch(() => undefined)
    // `approval: "always"`: the user sees exactly what will run, in every mode and whatever the allow rules or grants say (a tool that runs code the model wrote).
    const always = tool.approval === "always" || parsedPermission.success && tool.approvalFor?.(parsedPermission.data) === true
    // Reading another session asks once per call, except in full access (the user chose to run unattended) or when the user's own
    // message names that session's id: either is consent to read it.
    const named = parsedPermission.success && typeof (parsedPermission.data as { sessionId?: unknown }).sessionId === "string" && userText.includes((parsedPermission.data as { sessionId: string }).sessionId)
    const individual = !always && mode !== "full" && !named && parsedPermission.success && tool.individualApprovalFor?.(parsedPermission.data, permissionContext) === true
    if (always || individual) {
      const shown = always && parsedPermission.success && tool.preview ? await previewOf(parsedPermission.data) : undefined
      const detail = always ? (shown ? `${approvalDetail(call)}\n\n${shown}` : approvalDetail(call)) : `This call reads another session. Attach it with @thread or approve this operation.\n\n${approvalDetail(call)}`
      const refusal = await askRefusal(input, tool, call, detail)
      if (refusal) return settle(refusal, "deterministic", refusal.reason ?? "Blocked by a PermissionRequest hook")
      record("waiting_manual", "manual", "Individual approval required")
      const answer = await input.ask({ kind: "approval", title: approvalTitle(tool), detail, itemId, tool: tool.name, permission: tool.permission, permissionContext: { name: permissionName(tool.name), patterns, always: [] } })
      if (input.signal.aborted) return settle({ kind: "abandoned" }, "manual", "Approval cancelled")
      if (!withPolicy(toolset).specs.some((spec) => spec.name === tool.name)) return settle({ kind: "deny", by: "rule", reason: `tool unavailable: ${tool.name}` }, "deterministic", "Tool disabled during approval")
      if (rulePatterns.some((pattern) => matchingRule(permissionName(tool.name), pattern, rulesFor(toolset, input.sessionId))?.action === "deny")) return settle({ kind: "deny", by: "rule", reason: `permission rule denies ${tool.name}` }, "deterministic", "Permission changed during approval")
      // A session-scoped answer must not become consent to read other sessions or later pages.
      return settle(answer.kind === "approve" ? { kind: "approve", scope: "once" } : answer, "manual", "Individual user decision")
    }
    if (tool.name === "image_gen") {
      const refs = (call.args as { referenced_image_paths?: unknown })?.referenced_image_paths
      if (Array.isArray(refs)) {
        const reads = refs.filter((file): file is string => typeof file === "string").flatMap((file) => permissionPatterns("read", { path: file }, cwd))
        const readGate = reads.length ? await ruleGate(input, tool, call, itemId, toolset, "read", reads, false, true, provenance) : undefined
        if (readGate && readGate.kind !== "approve") return settle(readGate, "deterministic", "Image reference read refused")
      }
    }
    const extraRoots = declaredRoots(policy().additionalDirectories, options.runLimits?.(input.sessionId)?.addDirs)
    const allowCommands = options.permissionAllow?.()
    // `smartSandboxTrust` (off by default): a shell command inside an enforced OS sandbox with no network is contained, so smart mode does not ask about a command it merely does not know.
    const sandboxed = mode === "smart" && (tool.name === "shell" || tool.name === "shell_session") && options.smartSandboxTrust?.() === true && options.sandbox?.({ sessionId: input.sessionId, cwd })?.network === false
    const smart = mode === "smart" ? classifySmart({ tool, args: call.args, cwd, ...(extraRoots.length ? { extraRoots } : {}), ...(allowCommands ? { allowCommands } : {}), ...(sandboxed ? { sandboxed } : {}) }) : undefined
    // What nobody should approve by reflex (`rm -rf ~`, `mkfs`) is refused before any prompt, including the external-directory one.
    if (smart?.decision === "deny" && !explicitApproval) return settle({ kind: "deny", by: "rule", reason: `smart mode never runs this: ${smart.reason}` }, "deterministic", smart.reason)
    const { external: outside, declared } = splitDeclared(externalPatterns(tool.name, call.args, cwd), extraRoots)
    const declaredDenied = declared.find((pattern) => matchingRule("external_directory", pattern, rulesFor(toolset, input.sessionId))?.action === "deny")
    if (declaredDenied) return settle({ kind: "deny", by: "rule", reason: `external_directory ${declaredDenied}` }, "deterministic", "External directory rule denies the declared directory")
    if (outside.length) {
      record("waiting_manual", "manual", "External directory permission")
      const boundary = await ruleGate(input, tool, call, itemId, toolset, "external_directory", outside, true, true, provenance)
      if (boundary && boundary.kind !== "approve") return settle(boundary, "manual", boundary.kind === "deny" ? boundary.reason ?? "External directory refused" : "Approval abandoned")
    }
    if (workflowToolAsks(input.workflow?.execution, tool.name, tool.permission)) return input.ask({ kind: "approval", title: approvalTitle(tool), detail: `Workflow policy requires approval.\n${approvalDetail(call)}`, itemId, tool: tool.name, permission: tool.permission, permissionContext: { name: permissionName(tool.name), patterns, always: patterns } })
    if (memoryWrite(tool.name, call.args)) {
      const memory = options.memorySettings?.(input.sessionId) ?? policy()
      if (memory.memoryEnabled === false) return { kind: "deny", by: "rule", reason: "Memory disabled" }
      const args = call.args as { action?: string; text?: string; id?: string }
      const original = input.authority?.synthetic ? "" : input.authority?.text ?? input.text
      const single = toolset.main && mode === "ask" && !args.id && !memoryConsentTurns.has(input.turnId) && ["add", "upsert_fact", "propose", undefined].includes(args.action) && !!args.text && explicitMemoryConsent(original, args.text)
      if (single) {
        memoryConsentTurns.add(input.turnId)
        if (memoryConsentTurns.size > 200) memoryConsentTurns.delete(memoryConsentTurns.values().next().value!)
      }
      // With approval off a save is silent, except when it only restates this request: that is the task, not a durable fact, so it is asked about.
      const restates = !single && memory.memoryRequireApproval === false && toolset.main && !args.id && ["add", "upsert_fact", "propose", undefined].includes(args.action) && !!args.text && restatesRequest(original, args.text)
      if (single || memory.memoryRequireApproval === false && !restates) return { kind: "approve", scope: "once" }
      const detail = restates ? `${approvalDetail(call)}\nRestates this request` : approvalDetail(call)
      const refusal = await askRefusal(input, tool, call, detail)
      if (refusal) return refusal
      const answer = await input.ask({ kind: "approval", title: "Save to memory?", detail, itemId, tool: tool.name, permission: "write" })
      if (input.signal.aborted) return { kind: "abandoned" }
      if ((options.memorySettings?.(input.sessionId) ?? policy()).memoryEnabled === false) return { kind: "deny", by: "rule", reason: "Memory disabled during approval" }
      if (rulePatterns.some((pattern) => matchingRule(permissionName(tool.name), pattern, rulesFor(toolset, input.sessionId))?.action === "deny")) return { kind: "deny", by: "rule", reason: "Memory permission changed during approval" }
      return answer
    }
    const granular = await ruleGate(input, tool, call, itemId, toolset, permissionName(tool.name), rulePatterns, false, true, provenance, () => record("waiting_manual", "manual", "Waiting for tool/path approval"))
    if (granular) return settle(granular, granular.permissionSource ?? "deterministic", granular.kind === "deny" ? granular.reason ?? "Tool/path permission refused" : "Tool/path permission")
    if (explicitApproval) return settle({ kind: "approve", scope: "once" }, "manual", "Explicit debug tool command")
    if (pluginPermission?.status === "allow") return { kind: "approve", scope: "once" }
    if (tool.permission === "read") return settle({ kind: "approve", scope: "once" }, "deterministic", "Read tool")
    if (mode === "full" || (mode === "edits" && tool.permission === "write")) return { kind: "approve", scope: "once" }
    if (smart?.decision === "allow") return settle({ kind: "approve", scope: "once" }, "deterministic", smart.reason)
    const granted = smart ? authority.complete && frozen.action.complete && grants.hasExact(input.sessionId, tool.name, provenance) : grants.has(input.sessionId, tool.name)
    if (granted && smart?.risk !== "high") return settle({ kind: "approve", scope: "session" }, "grant", "Exact causal action grant")
    // `/approve`: the user cleared one retry of a call the reviewer refused; it runs once, without the reviewer or a prompt.
    if (grants.takeRetry(input.sessionId, frozen.action.fingerprint)) return settle({ kind: "approve", scope: "once" }, "manual", "Retry approved by the user after a reviewer denial")
    const parsed = tool.args.safeParse(call.args)
    const preview = parsed.success && tool.preview ? await previewOf(parsed.data) : undefined
    let detail = preview ? `${approvalDetail(call)}\n\n${preview}` : approvalDetail(call)
    if (smart) {
      const reviewer = options.permissionReviewer?.enabled(input.sessionId) ? options.permissionReviewer : undefined
      if (reviewer) record("reviewing", "model", "Reviewing causal user authority and execution identity")
      const review = reviewer ? await reviewer.review({ sessionId: input.sessionId, tool: tool.name, permission: tool.permission, detail, cwd, rule: smart, signal: input.signal, authority, action: frozen.action }) : undefined
      if (input.signal.aborted) return settle({ kind: "abandoned" }, "model", "Review cancelled")
      if (review?.verdict === "deny") {
        const masked = (text: string) => (secrets ? secrets.mask(input.sessionId, text) : text)
        grants.noteDenial(input.sessionId, { fingerprint: frozen.action.fingerprint, tool: tool.name, summary: masked(detail.split("\n", 1)[0] ?? "").slice(0, 200), reason: masked(review.reason || "judged unsafe").slice(0, 300) })
        return settle({ kind: "deny", reason: `${review.reason || "judged unsafe"}`, by: "reviewer" }, "model", review.reason)
      }
      // A rule-flagged (high risk) call always reaches the user: the reviewer can refuse it but never clear it.
      if (review?.verdict === "allow" && smart.risk === "uncertain" && authority.complete && frozen.action.complete) return settle({ kind: "approve", scope: "once" }, "model", review.reason)
      const why = !authority.complete ? "causal user authority missing or incomplete" : !frozen.action.complete && smart.risk === "uncertain" ? "execution identity incomplete" : smart.reason
      detail += `\n\nWhy it asks: ${why} (${smart.rule})`
      if (review) detail += `\nReviewer: ${review.verdict}${review.reason ? ` — ${review.reason}` : ""}${review.verdict === "allow" ? " (this kind of call always asks)" : ""}`
    }
    // The tool call's item and kind let clients tie the prompt to its card (icon, "Allow … ?", waiting tint).
    const hookRefusal = await askRefusal(input, tool, call, detail)
    if (hookRefusal) return settle(hookRefusal, "deterministic", hookRefusal.reason ?? "Blocked by a PermissionRequest hook")
    record("waiting_manual", "manual", "Waiting for user approval")
    const answer = await input.ask({ kind: "approval", title: approvalTitle(tool), detail, itemId, tool: tool.name, permission: tool.permission, permissionContext: { name: permissionName(tool.name), patterns, always: patterns } })
    if (input.signal.aborted) return settle({ kind: "abandoned" }, "manual", "Approval cancelled")
    if (answer.kind === "approve" && answer.scope === "session") grants.add(input.sessionId, tool.name, tool.permission, undefined, undefined, provenance)
    return settle(answer, "manual", answer.kind === "deny" ? answer.reason ?? "User denied" : answer.kind === "approve" ? "User approved" : "Approval abandoned")
  }

  /** `userInitiated`: the user typed the call themselves (`!command`), so it runs without an approval prompt. */
  async function runCall(input: TurnInput, call: ToolCall, toolset: Toolset, userInitiated = false, loadedInstructions?: Set<string>, repeated = false, explicitApproval = false, parentItemId?: ItemId, messages: ModelMessage[] = []): Promise<{ result: ToolResult; stop: boolean }> {
    const early = parentItemId ? undefined : takeEarlyCard(input.sessionId, call.callId)
    const itemId = early?.itemId ?? input.newItemId()
    const title = callTitle(call).slice(0, 200)
    if (!early) input.emit({ type: "item.started", itemId, kind: "tool_call", meta: { tool: title, ...(parentItemId ? { parentItemId } : {}), ...(call.callId.startsWith("graph_orientation_") ? { injected: true } : {}) } })
    /** A card opened from part of the input is named again at its end when the whole input names it differently. */
    let retitle = early && early.title !== title ? { tool: title, retitled: true } : undefined
    const maskText = (text: string) => (secrets ? secrets.mask(input.sessionId, text) : text)
    let args: unknown = call.args
    // Live output is for watching progress; every delta is persisted, so it stops at a cap (P11).
    // The completed item carries the bounded head+tail result either way.
    let streamed = 0
    /** Masks live output whose chunks can cut a secret in two; absent (no cost) when the session has no secrets. */
    const liveMask: SecretStream | undefined = secrets?.stream(input.sessionId)
    const liveRedaction = redactedToolStream(LIVE_OUTPUT_CAP)
    const emitLive = (text: string) => {
      if (!text || streamed >= LIVE_OUTPUT_CAP) return
      const room = LIVE_OUTPUT_CAP - streamed
      streamed += text.length
      input.emit({ type: "item.delta", itemId, text: text.length > room ? `${text.slice(0, room)}\n… live output paused; full result when done\n` : text })
    }
    /** `display` is what the card keeps when it differs from what the model is told (a plan stays visible). */
    const finish = async (raw: ToolResult, stop = false, shown?: string) => {
      const display = shown ?? (raw.display !== undefined && !raw.isError ? redactSecrets(raw.display).text : undefined)
      // Whatever a tool printed, a secret of this session only ever leaves here as its marker.
      const masked = withReportedSavings({ result: maskResult(raw, (text) => redactSecrets(maskText(text)).text), tool: call.name })
      // Command output filters (tool_output.filters): the full text is saved first and the result starts with its path.
      const condensed = await condenseCommandOutput({ result: masked, tool: call.name, args, limits: options.toolOutput?.(), save: options.saveToolOutput })
      const safe = condensed ?? masked
      let result = limitToolOutput(safe, options.toolOutput?.())
      if (condensed && result.output !== safe.output) result = { ...result, output: `${result.output}\n[Output truncated; the full unfiltered output is at the path above.]` }
      else if (result.output !== safe.output && options.saveToolOutput) {
        const saved = await options.saveToolOutput(safe.output, !safe.truncated).catch(() => undefined)
        if (saved) result = { ...result, output: `${result.output}\n\n[${saved.complete ? "Full output" : "Output excerpt"} saved to: ${saved.path}. Use read with offset/limit or grep.]`, meta: { ...result.meta, outputPath: saved.path, outputComplete: saved.complete } }
        else result = { ...result, output: `${result.output}\n[Output truncated; saving the excerpt failed.]` }
      } else if (result.output !== safe.output && options.storeBlob && options.blobPath) {
        const bytes = Buffer.from(safe.output)
        const cap = 8 * 1024 * 1024
        const saved = bytes.length <= cap ? bytes : Buffer.concat([bytes.subarray(0, cap / 2 - 100), Buffer.from("\n[Output excerpt capped for disk safety]\n"), bytes.subarray(bytes.length - cap / 2 + 100)])
        const ref = await options.storeBlob(saved, "text/plain", input.sessionId).catch(() => undefined)
        if (ref) {
          const outputPath = options.blobPath(ref)
          result = { ...result, output: `${result.output}\n\n[${safe.truncated || bytes.length > cap ? "Output excerpt" : "Full output"} saved to: ${outputPath}. Use read with offset/limit or grep.]`, meta: { ...result.meta, outputPath, outputComplete: !safe.truncated && bytes.length <= cap } }
        }
      }
      if (result.output !== safe.output && !options.saveToolOutput && !options.storeBlob) result = { ...result, output: `${result.output}\n[Output truncated.]` }
      if (liveMask) emitLive(liveRedaction.push(liveMask.flush()))
      emitLive(liveRedaction.flush())
      // A tool's render spec reaches clients only when it validates within RENDER_LIMITS; otherwise the text shows.
      const render = result.render !== undefined ? parseRenderSpec(normalizeRenderSpec(result.render)) : undefined
      // A generated picture is the card's own, as the hosted image tool's is: the terminal shows it in the card, also for a Claude Code session.
      const pictures = call.name === "image_gen" && !result.isError ? await storeToolImages(input.sessionId, [...(result.images ?? []), ...(result.attachments ?? [])]) : []
      // An item's meta holds at most 16 facts: the tool's own come first.
      if (retitle && Object.keys(result.meta ?? {}).length > 13) retitle = undefined
      input.emit({
        type: "item.completed",
        itemId,
        ...(pictures.length ? { attachments: pictures } : {}),
        status: input.signal.aborted ? "cancelled" : result.isError ? "error" : "ok",
        text: clip(display === undefined ? typeof result.meta?.memorySavedText === "string" ? result.meta.memorySavedText : result.output : maskText(display)),
        toolInput: redactSecrets(maskText(JSON.stringify(args) ?? "null")).text.slice(0, 4000),
        ...(render?.ok ? { render: render.spec } : {}),
        ...(parentItemId || retitle || result.meta && Object.keys(result.meta).length ? { meta: { ...result.meta, ...(parentItemId ? { parentItemId } : {}), ...retitle } } : {}),
      })
      return { result, stop }
    }
    const special = PLAN_TOOL_NAMES.has(call.name) || call.name === TASK_TOOL.name || call.name === SECRETS_TOOL.name || GOAL_TOOL_NAMES.has(call.name) || call.name === CODE_TOOL.name
    const workflowDenial = workflowToolDenied(input.workflow?.execution, call.name, toolset.tools.get(call.name)?.permission)
    if (workflowDenial) return finish({ output: workflowDenial, truncated: false, title: call.name, isError: true })
    if (special && workflowToolAsks(input.workflow?.execution, call.name, "execute")) {
      const patterns = permissionPatterns(call.name, call.args, options.cwdFor(input.sessionId))
      const approval = await input.ask({ kind: "approval", title: "Workflow action", detail: approvalDetail(call), itemId, tool: call.name, permission: "execute", permissionContext: { name: permissionName(call.name), patterns, always: patterns } })
      if (approval.kind !== "approve") return finish({ output: "workflow action denied", truncated: false, title: call.name, isError: true })
    }
    if (!userInitiated && !withPolicy(toolset).specs.some((spec) => spec.name === call.name)) return finish({ output: `unknown tool: ${call.name}`, truncated: false, title: call.name, isError: true })
    let asyncJob: { id: string; tool: "read" | "grep" | "glob" | "webfetch" } | undefined
    const continuityTool = CONTINUITY_TOOLS.find((tool) => tool.name === call.name)
    if (continuityTool && options.continuity) {
      const parsed = continuityTool.args.safeParse(call.args)
      if (!parsed.success) return finish({ output: `invalid arguments for ${call.name}: ${z.prettifyError(parsed.error)}`, truncated: false, title: call.name, isError: true })
      const port = options.continuity(input.sessionId)
      const id = `${call.name === "tool_start" ? "job" : "question"}_${createHash("sha256").update(`${input.sessionId}:${input.turnId}:${call.callId}`).digest("hex")}`
      try {
        const data = parsed.data as Record<string, unknown>
        if (call.name === "tool_start") {
          const name = data.tool as "read" | "grep" | "glob" | "webfetch"
          const original = options.tools.find((tool) => tool.name === name)
          if (!original || toolset.tools.get(name) !== original || !withPolicy(toolset).specs.some((spec) => spec.name === name)) return finish({ output: "Tool unavailable for async execution", truncated: false, title: call.name, isError: true })
          asyncJob = { id, tool: name }
          call = { ...call, name, args: data.arguments }
          args = data.arguments
        } else if (call.name === "question_start") {
          const record = port.question({ id, turnId: input.turnId, questions: data.questions as import("@mendcode/protocol").QuestionInfo[] })
          return finish(continuityResult({ question_id: record.id, status: record.status }))
        } else if (call.name === "question_status") {
          const record = port.get(data.question_id as string)
          if (record.kind !== "question") throw new Error("Unknown question in this session")
          return finish(continuityResult(record))
        } else if (call.name === "tool_wait") {
          return finish(continuityResult((await port.wait(data.job_ids as string[], data.timeout_ms as number ?? 10000, input.signal)).map((record) => ({ job_id: record.id, status: record.status }))))
        } else {
          const record = port.get(data.job_id as string, data.offset as number | undefined, data.limit as number | undefined)
          if (record.kind !== "job") throw new Error("Unknown job in this session")
          if (call.name === "tool_cancel") return finish(continuityResult(port.cancel(record.id)))
          return finish(continuityResult({ job_id: record.id, status: record.status, tool: record.tool, error: record.error, output: record.output, next_offset: record.nextOffset, attachment_notice: record.attachmentNotice }))
        }
      } catch (error) { return finish({ output: error instanceof Error ? error.message : "Continuity operation failed", truncated: false, title: call.name, isError: true }) }
    }
    const stub = { name: call.name, permission: "read" as const } as Tool
    if (!userInitiated) {
      const checks = [
        ...(special ? [{ permission: permissionName(call.name), patterns: permissionPatterns(call.name, call.args, options.cwdFor(input.sessionId)), repeated: false }] : []),
        ...(repeated ? [{ permission: "doom_loop", patterns: [call.name], repeated: true }] : []),
      ]
      for (const check of checks) {
        const gate = await ruleGate(input, stub, call, itemId, toolset, check.permission, check.patterns, check.repeated, !check.repeated)
        if (gate && gate.kind !== "approve") return finish({ output: `denied: ${gate.kind === "deny" ? gate.reason ?? "permission rejected" : "approval abandoned"}`, truncated: false, title: call.name, isError: true }, gate.kind === "abandoned" || !("by" in gate) && policy().experimental?.continue_loop_on_deny !== true)
      }
    }
    if (call.name === CODE_TOOL.name) {
      if (parentItemId || policy().experimental?.code_mode !== true || !toolset.codeCatalog) return finish({ output: "Code Mode is disabled", truncated: false, title: "code", isError: true })
      const parsed = CODE_TOOL.args.safeParse(call.args)
      if (!parsed.success) return finish({ output: `invalid arguments for code: ${z.prettifyError(parsed.error)}`, truncated: false, title: "code", isError: true })
      const catalog = toolset.codeCatalog
      const eligible = () => withPolicy(catalog)
      const discovered = new Set(toolset.codeActive)
      let stopped = false
      let previousNested = "", nestedRepeats = 0, sequence = 0
      const nestedInstructions: string[] = []
      const value = await executeCode({
        code: parsed.data.code, signal: input.signal,
        names: eligible().specs.map((spec) => spec.name).filter((name) => name !== CODE_TOOL.name),
        search: (query, limit) => {
          if (policy().experimental?.code_mode !== true || toolDisabled(TOOL_SEARCH_NAME, rulesFor(catalog)) || catalog.agent && !agentAllows(catalog.agent, TOOL_SEARCH_NAME)
            || !catalog.main && policy().experimental?.primary_tools?.some((pattern) => permissionMatch(TOOL_SEARCH_NAME, pattern))) throw new CodeError("ToolFailure", "Tool search is disabled")
          const primary = catalogPrimary()
          const result = searchTools(eligible().specs, query, limit, discovered, primary)
          for (const entry of result.tools) if (!primary(entry.name)) discovered.add(entry.name)
          return result
        },
        invoke: async (name, args, signal) => {
          signal.throwIfAborted()
          if (stopped || policy().experimental?.code_mode !== true) throw new CodeError("ToolFailure", "Code Mode stopped")
          const nested: TurnInput = { ...input, signal, ask: (request) => input.ask({ ...request, signal }) }
          const signature = JSON.stringify([name, args])
          nestedRepeats = signature === previousNested ? nestedRepeats + 1 : 1
          previousNested = signature
          const { result, stop } = await runCall(nested, { name, args, callId: `${call.callId}:${++sequence}` }, eligible(), false, loadedInstructions, nestedRepeats >= 3, false, itemId, messages)
          stopped ||= stop
          nestedInstructions.push(...result.loadedInstructions ?? [])
          if (result.isError) throw new CodeError(result.output.startsWith("invalid arguments") ? "InvalidToolInput" : result.output.startsWith("unknown tool:") ? "UnknownTool" : "ToolFailure", result.output)
          return { output: result.output, title: result.title, truncated: result.truncated, ...(result.meta ? { meta: result.meta } : {}) }
        },
      })
      return finish({ output: JSON.stringify(value), title: "Code Mode", isError: !value.ok, truncated: value.truncated === true, meta: { toolCalls: value.toolCalls.length }, ...(discovered.size ? { discoveredTools: [...discovered] } : {}), ...(nestedInstructions.length ? { loadedInstructions: nestedInstructions } : {}) }, stopped)
    }
    if (call.name === REASONING_AUTO_TOOL.name && toolset.main && options.reasoning) {
      const parsed = REASONING_AUTO_TOOL.args.safeParse(call.args)
      const result = parsed.success ? options.reasoning.requestIncrease(input.sessionId, parsed.data.reason, parsed.data.evidence) : { status: "unchanged", reason: "Concrete verification or technical evidence required" }
      return finish({ output: JSON.stringify(result), truncated: false, title: "Reasoning Auto", isError: !parsed.success })
    }
    if (PLAN_TOOL_NAMES.has(call.name) && toolset.main) {
      if (call.name === "plan_exit") {
        const args = PLAN_EXIT_TOOL.args.safeParse(call.args)
        const latest = options.plans?.latest(input.sessionId) ?? latestPlans.get(input.sessionId)
        if (!args.success || !latest) return finish({ output: "No reviewed plan is available. Submit the complete plan with plan_review first.", truncated: false, title: "plan", isError: true })
        const result = await reviewPlan(input, latest.markdown, itemId, toolset, latest.title, latest.phase)
        return finish(result, false, latestPlans.get(input.sessionId)?.markdown ?? latest.markdown)
      }
      const parsedPlan = call.name === PLAN_TOOL.name ? PLAN_TOOL.args.safeParse(call.args) : PLAN_REVIEW_TOOL.args.safeParse(call.args)
      if (!parsedPlan.success) return finish({ output: `invalid arguments for ${call.name}: ${z.prettifyError(parsedPlan.error)}`, truncated: false, title: "plan", isError: true })
      if (call.name === PLAN_TOOL.name && modeOf(input, toolset) !== "plan") return finish({ output: "not in plan mode; just do the work", truncated: false, title: "plan", isError: true })
      const data = parsedPlan.data
      const plan = "plan" in data ? data.plan : data.markdown
      const result = await reviewPlan(input, plan, itemId, toolset, "title" in data ? data.title : undefined, "phase" in data ? data.phase : undefined)
      const reviewed = latestPlans.get(input.sessionId)?.markdown ?? plan.trim()
      args = "plan" in data ? { ...data, plan: reviewed } : { ...data, markdown: reviewed }
      call.args = args
      return finish(result, false, reviewed)
    }
    if (call.name === TASK_TOOL.name && toolset.allowTask) {
      const args = TASK_TOOL.args.safeParse(call.args)
      if (!args.success) return finish({ output: `invalid arguments for task: ${z.prettifyError(args.error)}`, truncated: false, title: "task", isError: true })
      if (input.workflow && !args.data.task_id && !input.workflow.reserveChild()) return finish({ output: "workflow child budget exhausted", truncated: false, title: "task", isError: true })
      return finish(await runTask(input, args.data, itemId, toolset))
    }
    if (call.name === SECRETS_TOOL.name && secrets) return finish(secretsResult(secrets.list(input.sessionId)))
    if (call.name === SNIP_TOOL.name) {
      const args = SNIP_TOOL.args.safeParse(call.args)
      if (!args.success) return finish({ output: `invalid arguments for snip: ${z.prettifyError(args.error)}`, truncated: false, title: "snip", isError: true })
      return finish(runSnip({ messages, args: args.data, describe: (entry) => callTitle({ ...entry, callId: "" }) }))
    }
    if (GOAL_TOOL_NAMES.has(call.name) && options.goals && toolset.main) {
      const spec = GOAL_TOOLS.find((tool) => tool.name === call.name)!
      const args = spec.args.safeParse(call.args)
      if (!args.success) return finish({ output: `invalid arguments for ${call.name}: ${z.prettifyError(args.error)}`, truncated: false, title: call.name, isError: true })
      return finish(runGoalTool(options.goals(input.sessionId), call.name, args.data))
    }
    const tool = toolset.tools.get(call.name)
    if (!tool) return finish({ output: `unknown tool: ${call.name}`, truncated: false, title: call.name, isError: true })
    const parsed = tool.args.safeParse(call.args)
    if (!parsed.success) return finish({ output: `invalid arguments for ${call.name}: ${z.prettifyError(parsed.error)}`, truncated: false, title: call.name, isError: true })
    const bindArgs = (args: unknown) => secrets && options.tools.includes(tool) && !memoryWrite(call.name, args) ? resolveToolArgs({ tool: call.name, args, resolve: (text) => secrets.resolve(input.sessionId, text) }) : args
    let boundArgs = bindArgs(parsed.data)
    const shellEnvironment = (call.name === "shell" || call.name === "shell_session") && hooks?.has("shell.env", options.cwdFor(input.sessionId)) ? await hooks.environment?.({ sessionId: input.sessionId, cwd: options.cwdFor(input.sessionId) }) : undefined
    const executionShell = options.shell?.(input.sessionId) ?? defaultShell()
    // Scripts a shell call starts can tell which session, model and project they belong to.
    const sessionEnvironment = call.name === "shell" ? { MENDCODE_SESSION_ID: input.sessionId, MENDCODE_MODEL: choiceFor(options.modelFor?.(input.sessionId, "main"), toolset.agent)?.model ?? options.provider.model, MENDCODE_PROJECT_DIR: options.cwdFor(input.sessionId) } : undefined
    // The environment policy shapes what shell commands inherit; hooks and the session variables are added on top of it.
    const shellSettings = call.name === "shell" || call.name === "shell_session" ? options.shellSettings?.() : undefined
    const inherited = shellSettings?.environment ? applyShellEnvironment(process.env, shellSettings.environment) : process.env
    // A `mendcode` the model runs (`mendcode docs`, `mendcode status`) reads the data directory of the daemon it runs under, not the default one.
    const dataEnvironment = shellSettings?.dataDir ? { MENDCODE_V2_DIR: shellSettings.dataDir } : undefined
    const credentials = options.tools.includes(tool) && (call.name === "shell" || call.name === "shell_session") ? secrets?.environment?.(input.sessionId) : undefined
    let frozen = freezeAction(call.name, boundArgs, options.cwdFor(input.sessionId), sessionEnvironment || shellEnvironment || credentials || dataEnvironment ? { ...inherited, ...dataEnvironment, ...sessionEnvironment, ...shellEnvironment, ...credentials } : inherited, executionShell)
    const shellPolicy = shellSettings?.policy?.prefix || shellSettings?.policy?.login ? shellSettings.policy : undefined
    const webPolicy = call.name === "webfetch" || call.name === "websearch" ? options.web?.() : undefined
    const answer: PermitResult = userInitiated ? { kind: "approve", scope: "once" } : await permit(input, tool, call, itemId, toolset, frozen, explicitApproval)
    if (answer.kind === "abandoned") return finish({ output: "approval abandoned", truncated: false, title: call.name, isError: true }, true)
    if (answer.kind !== "approve") {
      const reason = answer.kind === "deny" && answer.reason ? `: ${answer.reason}` : ""
      return finish({ output: `denied by ${"by" in answer ? answer.by === "rule" ? "permission rule" : "the permission reviewer" : "user"}${reason}`, truncated: false, title: call.name, isError: true }, !("by" in answer) && policy().experimental?.continue_loop_on_deny !== true)
    }
    if (memoryWrite(call.name, call.args) && answer.memoryAlways) options.memoryAlways?.()
    const onOutput = (chunk: string) => emitLive(liveRedaction.push(liveMask ? liveMask.push(chunk) : chunk))
    let questionDeclined = false
    const ask = async (question: QuestionPrompt) => {
      const answer = await input.ask({ kind: "question", ...question })
      if (answer.kind === "answer") return { answered: true as const, text: answer.text, ...(answer.answers ? { answers: answer.answers } : {}) }
      // Batch refusals are tool results for the model; legacy single questions retain the deny policy.
      questionDeclined ||= !question.questions?.length || answer.kind === "abandoned"
      return { answered: false as const, reason: answer.kind === "deny" ? (answer.reason ?? "the user declined to answer") : "the question was abandoned" }
    }
    const cwd = options.cwdFor(input.sessionId)
    // The OS sandbox confines what the model runs; a command the user typed themselves (`!command`) is theirs.
    const sandbox = !userInitiated && (call.name === "shell" || call.name === "shell_session") ? options.sandbox?.({ sessionId: input.sessionId, cwd }) : undefined
    const hookRef ={ sessionId: input.sessionId, cwd, turnId: input.turnId, tool: call.name, callId: call.callId, itemId }
    args = parsed.data
    if (memoryWrite(call.name, call.args) && answer.memoryText !== undefined) {
      const edited = tool.args.safeParse({ ...(args as Record<string, unknown>), text: answer.memoryText })
      if (!edited.success) return finish({ output: "Invalid memory text", title: call.name, truncated: false, isError: true })
      args = edited.data
      boundArgs = bindArgs(args)
      frozen = freezeAction(call.name, boundArgs, cwd, frozen.environment, executionShell)
    }
    if (!options.compound?.(input.sessionId) && hooks?.has("tool.before", cwd) && hooks.toolBefore) {
      const verdict = await hooks.toolBefore({ ...hookRef, args: structuredClone((args ?? {}) as Record<string, unknown>) })
      if (verdict?.block !== undefined) return finish({ output: verdict.block || "blocked by an extension", truncated: false, title: call.name, isError: true })
      if (verdict?.args) {
        const rewritten = tool.args.safeParse(verdict.args)
        if (!rewritten.success) return finish({ output: `an extension rewrote the arguments of ${call.name} into something invalid: ${z.prettifyError(rewritten.error)}`, truncated: false, title: call.name, isError: true })
        args = rewritten.data
        boundArgs = bindArgs(args)
        frozen = freezeAction(call.name, boundArgs, cwd, frozen.environment, executionShell)
        if (!userInitiated) {
          const rewrittenAnswer = await permit(input, tool, { ...call, args }, itemId, toolset, frozen, explicitApproval)
          if (rewrittenAnswer.kind !== "approve") return finish({ output: "rewritten call denied", truncated: false, title: call.name, isError: true }, rewrittenAnswer.kind === "abandoned" || !("by" in rewrittenAnswer) && policy().experimental?.continue_loop_on_deny !== true)
        }
      }
    }
    // After approval and the hooks (which saw markers): a built-in tool gets the real value for its marker, nothing else does.
    const shownArgs = args
    const runArgs = boundArgs
    const storedFiles = options.tools.includes(tool) && call.name === "read" && options.readStoredFile ? { readStoredFile: options.readStoredFile } : {}
    if (input.signal.aborted || !frozen.unchanged()) {
      if (modeOf(input, toolset) === "smart") {
        const { userText, ...authority } = authorityContext(input, options.authorityAnchors?.(input.sessionId))
        const at = Date.now()
        grants.review({ reviewId: `review:${itemId}:${frozen.action.fingerprint.slice(0, 16)}`, sessionId: input.sessionId, tool: tool.name, status: input.signal.aborted ? "cancelled" : "denied", source: "deterministic", reason: input.signal.aborted ? "Execution cancelled" : "Execution identity changed after approval", createdAt: at, updatedAt: at, provenance: { turnId: input.turnId, authority, action: frozen.action } })
      }
      return finish({ output: input.signal.aborted ? "cancelled" : "execution identity changed after approval; retry for a new review", truncated: false, title: call.name, isError: true }, input.signal.aborted)
    }
    if (asyncJob && options.continuity) {
      try {
        const record = options.continuity(input.sessionId).start({ ...asyncJob, turnId: input.turnId }, input.signal, async (signal) => {
          if (signal.aborted || !frozen.unchanged()) throw new Error("Execution cancelled or identity changed after approval")
          let result = await tool.execute(runArgs, { ...storedFiles, cwd, shell: executionShell, ...(userInitiated ? { userInitiated: true } : {}),...(shellPolicy ? { shellPolicy } : {}), ...(webPolicy ? { web: webPolicy } : {}), ...(sandbox ? { sandbox } : {}), environment: frozen.environment, signal, outputLimits: { maxBytes: options.toolOutput?.()?.max_bytes ?? 51200, maxLines: options.toolOutput?.()?.max_lines ?? 2000 }, ...(loadedInstructions ? { loadedInstructions: new Set(loadedInstructions) } : {}), ...(options.instructions ? { instructions: options.instructions } : {}) })
          if (secrets) result = maskResult(result, maskText)
          if (hooks?.has("tool.after", cwd) && hooks.toolAfter && !signal.aborted) {
            const changed = await hooks.toolAfter({ ...hookRef, args: structuredClone((shownArgs ?? {}) as Record<string, unknown>), output: result.output, isError: result.isError })
            if (changed) result = { ...result, ...(changed.output !== undefined ? { output: changed.output } : {}), ...(changed.isError !== undefined ? { isError: changed.isError } : {}) }
          }
          return secrets ? maskResult(result, maskText) : result
        })
        return finish(continuityResult({ job_id: record.id, status: record.status }))
      } catch (error) { return finish({ output: error instanceof Error ? error.message : "Async job failed", truncated: false, title: call.name, isError: true }) }
    }
    let result: ToolResult
    try {
      result = await tool.execute(runArgs, { ...storedFiles, cwd, shell: executionShell, ...(userInitiated ? { userInitiated: true } : {}),...(shellPolicy ? { shellPolicy } : {}), ...(webPolicy ? { web: webPolicy } : {}), ...(sandbox ? { sandbox } : {}), environment: frozen.environment, signal: input.signal, outputLimits: { maxBytes: options.toolOutput?.()?.max_bytes ?? 51200, maxLines: options.toolOutput?.()?.max_lines ?? 2000 }, onOutput, ask, ...(loadedInstructions ? { loadedInstructions } : {}), ...(options.instructions ? { instructions: options.instructions } : {}),...(options.tasks ? { taskStatus: (args) => options.tasks!.status(input.sessionId, args, input.signal) } : {}), ...(options.background ? { background: options.background(input.sessionId) } : {}), ...(options.interactive ? { interactive: options.interactive(input.sessionId) } : {}),...(options.workflows ? { workflows: options.workflows(input.sessionId) } : {}), ...(options.peers ? { peers: options.peers(input.sessionId) } : {}), ...(options.sessionMeta ? { sessionMeta: options.sessionMeta(input.sessionId) } : {}), ...(options.threads ? { threads: options.threads(input.sessionId) } : {}), ...(options.packages ? { packages: options.packages(input.sessionId) } : {}), ...(options.review ? { review: options.review(input.sessionId) } : {}), ...(options.loops ? { loops: options.loops(input.sessionId) } : {}), ...(options.worktrees ? { worktrees: options.worktrees(input.sessionId) } : {}), ...(options.prWatch ? { prWatch: options.prWatch(input.sessionId) } : {}), ...(options.recall ? { recall: options.recall(input.sessionId) } : {}), ...(options.computer ? { computer: bindComputerAuthority(options.computer(input.sessionId), input, toolset.main, itemId, () => modeOf(input, toolset)) } : {}), ...(options.aiConfig ? { aiConfig: options.aiConfig(input.sessionId) } : {}), ...(options.browser && call.name === "browser" ? { browser: options.browser(input.sessionId) } : {}), ...(call.name === "image_gen" ? { recentImages: (count: number) => recentImageReferences(messages, count, options.readBlob) } : {}) })
    } catch (error) {
      if (!parentItemId) throw error
      return finish({ output: input.signal.aborted ? "cancelled" : error instanceof Error ? error.message : String(error), title: call.name, isError: true, truncated: false }, input.signal.aborted)
    }
    const paths = !result.isError && options.afterWrite && !input.signal.aborted ? writtenPaths(call.name, shownArgs) : []
    const extra = paths.length ? await options.afterWrite!({ cwd, paths, signal: input.signal, sessionId: input.sessionId }).catch(() => undefined) : undefined
    // Errors a language server reported after an earlier write's result reach the model with the next result, whatever the tool.
    let late: string | undefined
    try { late = input.signal.aborted ? undefined : options.lateWriteNotes?.(input.sessionId) } catch { late = undefined }
    let shared: string | undefined
    try { shared = input.signal.aborted ? undefined : options.oneTree?.({ sessionId: input.sessionId, cwd, written: result.isError ? [] : writtenPaths(call.name, shownArgs), output: result.output }) } catch { shared = undefined }
    if (extra || late || shared) {
      const notes = (extra ?? "") + (late ?? "") + (shared ? `\n${shared}` : "")
      result = { ...result, output: result.output + notes, ...(result.display !== undefined ? { display: result.display + notes } : {}) }
    }
    // Extensions see markers in the arguments and masked output, like the model.
    if (secrets) result = maskResult(result, maskText)
    if (!options.compound?.(input.sessionId) && hooks?.has("tool.after", cwd) && hooks.toolAfter && !input.signal.aborted) {
      const changed = await hooks.toolAfter({ ...hookRef, args: structuredClone((shownArgs ?? {}) as Record<string, unknown>), output: result.output, isError: result.isError, title: result.title, ...(result.meta ? { meta: result.meta } : {}) })
      if (changed) result = { ...result, ...(changed.output !== undefined ? { output: changed.output } : {}), ...(changed.isError !== undefined ? { isError: changed.isError } : {}), ...(changed.title !== undefined ? { title: changed.title } : {}), ...(changed.meta ? { meta: changed.meta } : {}) }
    }
    return finish(result, questionDeclined && policy().experimental?.continue_loop_on_deny !== true)
  }

  /**
   * Runs the inline shell commands of a custom command as `shell` calls of this turn, through the same permission decision, approval and
   * sandbox as the model's own, and returns the text with their output in place of the markers. A refused, failed or oversized command fails the turn.
   */
  async function resolveInlineShell(input: TurnInput, messages: ModelMessage[]): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
    const held = options.inlineShell?.(input.text) ?? []
    if (!held.length) return { ok: true, text: input.text }
    const child = options.tasks?.isChild(input.sessionId) === true || input.workflow !== undefined
    const limits = options.runLimits?.(input.sessionId)
    const excluded = input.turnOptions?.excludeTools ?? []
    const agent = settle(() => options.agents?.primary(input.sessionId, input.selection?.agent), undefined)
    const toolset = withRunLimits(withPolicy(withAgent(child ? subagentToolset : mainToolset, agent)), excluded.length ? { ...limits, excludeTools: [...(limits?.excludeTools ?? []), ...excluded] } : limits)
    if (!toolset.tools.has(SHELL_TOOL)) return { ok: false, message: "[ENGINE]: inline shell needs the shell tool, which is not available here" }
    await hooks?.prepare?.({ sessionId: input.sessionId, cwd: options.cwdFor(input.sessionId) })
    let text = input.text
    for (const [index, entry] of held.entries()) {
      const call: ToolCall = { callId: `command-shell-${input.turnId}-${index}`, name: SHELL_TOOL, args: { command: entry.command, timeoutMs: INLINE_SHELL_TIMEOUT_MS } }
      const { result } = await runCall(input, call, toolset, false, undefined, false, false, undefined, messages)
      if (input.signal.aborted) return { ok: false, message: "[ENGINE]: cancelled" }
      if (result.isError) return { ok: false, message: `[ENGINE]: inline shell failed: ${result.output.slice(0, 1000)}` }
      if (result.truncated || result.output.length > INLINE_SHELL_MAX_CHARS) return { ok: false, message: "[ENGINE]: inline shell output exceeds its limits" }
      text = text.replace(entry.marker, () => result.output)
    }
    if (text.length > INLINE_SHELL_MAX_CHARS) return { ok: false, message: "[ENGINE]: expanded command exceeds 32000 characters" }
    return { ok: true, text }
  }

  async function appendUser(input: TurnInput, messages: ModelMessage[], newTurn = true) {
    const claims = new Set(messages.flatMap((message) => message.role !== "assistant" ? message.loadedInstructions ?? [] : []))
    const mentioned = options.compound?.(input.sessionId)?.critic ? { text: input.text, attachments: [], loadedInstructions: [] } : await resolveMentions(input.text, options.cwdFor(input.sessionId), input.signal, claims, options.instructions)
    const mentionRefs: BlobRef[] = []
    for (const attachment of mentioned.attachments) {
      const ref = await options.storeBlob?.(attachment.bytes, attachment.mime, input.sessionId).catch(() => undefined)
      if (ref) mentionRefs.push({ ...ref, ...(attachment.name ? { name: attachment.name } : {}) })
    }
    const note = mentioned.attachments.length > mentionRefs.length ? "\n[mentioned media not attached: blob storage unavailable]" : ""
    // The first message of a main session carries the orientation block (feature `orientation`); it is built once and lives in the history, so it is never re-sent as new text.
    const orientation = newTurn && !messages.some((message) => message.role === "user") && featureOn(policy(), "orientation") && !input.workflow && options.tasks?.isChild(input.sessionId) !== true && !options.compound?.(input.sessionId)?.critic
      ? `${orientationBlock({ cwd: options.cwdFor(input.sessionId), ...(options.instructions ? { instructions: options.instructions } : {}) })}\n\n`
      : ""
    const content = secrets ? secrets.mask(input.sessionId, orientation + mentioned.text + note) : orientation + mentioned.text + note
    // A new user turn ends the tool loop that needed the earlier reasoning replayed; keeping it would only grow the history.
    if (newTurn) for (const message of messages) if (message.role === "assistant") delete message.reasoning
    const attachments = [...input.attachments, ...mentionRefs]
    messages.push({ role: "user", content, ...(attachments.length ? { attachments } : {}), ...(mentioned.loadedInstructions?.length ? { loadedInstructions: mentioned.loadedInstructions } : {}) })
  }

  /**
   * `auto_recall`: after a compaction, the packed-away turns that match the new request come back verbatim as a session_search
   * result right after it. Appended, never edited in place, so the cached prefix stays valid; nothing when the port has none.
   */
  function recallPackedTurns(input: TurnInput, messages: ModelMessage[]) {
    if (!options.recall || !packedAway(messages)) return
    const port = options.recall(input.sessionId)
    if (!port.relevant) return
    let turns: RecalledTurn[]
    try { turns = notInHistory(port.relevant({ query: input.text, limit: AUTO_RECALL_TURNS, maxChars: AUTO_RECALL_CHARS }), messages) }
    catch { return }
    if (!turns.length) return
    const text = recalledText(turns, Date.now())
    const output = secrets ? secrets.mask(input.sessionId, text) : text
    const callId = `${AUTO_RECALL_PREFIX}${input.turnId}`
    const itemId = input.newItemId()
    input.emit({ type: "item.started", itemId, kind: "tool_call", meta: { tool: `Recalled ${turns.length} earlier ${turns.length === 1 ? "turn" : "turns"}`, injected: true } })
    input.emit({ type: "item.completed", itemId, status: "ok", text: clip(output) })
    messages.push({ role: "assistant", content: "", toolCalls: [{ callId, name: "session_search", args: { query: input.text.slice(0, 2000) } }] }, { role: "tool", callId, name: "session_search", output, isError: false })
  }

  /**
   * Model ↔ tools until the model stops. Shared by turns and sub-agent tasks; `persist` saves the
   * history after every step (turns) and is absent for tasks, whose history lives only in the call.
   */
  async function runLoop(input: TurnInput, messages: ModelMessage[], toolset: Toolset, loop: { maxSteps: number; cap?: number; persist?: () => Promise<void>; trackContext: boolean; structured?: { retries: number }; fork?: ForkPrefix | undefined }) {
    let answer = ""
    /** With a required answer format: model steps that ended without a valid `StructuredOutput` call. */
    let structuredFailures = 0
    const structuredExhausted = (): { outcome: TurnOutcome; answer: string } => ({ outcome: { status: "error", code: "structured_output", message: `[ENGINE]: the model did not return output matching the required format after ${structuredFailures} attempts` }, answer })
    const loadedInstructions = new Set(messages.flatMap((message) => message.role !== "assistant" ? message.loadedInstructions ?? [] : []))
    // Off until the user switches it on (`/tier graph_context on`): the model calls the graph tools when it needs them; a code map before every first answer indexed whatever directory the session was in.
    const graphEnabled = () => toolset.main && featureOn(policy(), "graph_context") && featureOn(policy(), "codegraph")
    const graphNote = async (name: "graph_map" | "graph_impact", args: Record<string, unknown>, callId: string) => {
      // Use the same permission, tool-policy and agent gates as an agent-called lookup.
      if (!graphEnabled() || !toolset.tools.has(name) || input.signal.aborted) return false
      const call = { name, args, callId }
      const { result, stop } = await runCall(input, call, toolset, false, loadedInstructions, false, false, undefined, messages)
      messages.push({ role: "assistant", content: "", toolCalls: [call] }, { role: "tool", callId, name, output: result.output, isError: result.isError })
      await loop.persist?.()
      return stop
    }
    const orientationId = `graph_orientation_${createHash("sha1").update(options.cwdFor(input.sessionId)).digest("hex").slice(0, 16)}`
    if (!messages.some((message) => message.role === "assistant" && message.toolCalls.some((call) => call.callId === orientationId)) && await graphNote("graph_map", { depth: 1 }, orientationId)) return { outcome: { status: "ok" } as TurnOutcome, answer }
    let previous = ""
    let repeats = 0
    const maxSteps = Math.min(toolset.agent?.steps ?? loop.maxSteps, loop.cap ?? Infinity)
    /**
     * Appends the prompts the session lets join this turn (in order) once the history is persisted, while a model step is
     * left for them. `joined` tells the loop to make another model call; `error` is a joined prompt's failed inline shell.
     */
    const joinQueued = async (step: number, userOnly = false): Promise<{ joined: boolean; error?: string }> => {
      const takeQueued = input.takeQueued
      if (!loop.persist || !takeQueued || step + 1 >= loop.maxSteps || step + 1 >= maxSteps) return { joined: false }
      let any = false
      for (let joined = 0; joined < 256 && !input.signal.aborted; joined++) {
        const queued = await takeQueued(userOnly ? { userOnly } : undefined)
        if (!queued) break
        if (!queued.authority) {
          // A notice about this session's own background work: the model reads it as it is (no mentions, no inline shell), and the
          // turn keeps the message and the authority it is working under.
          messages.push({ role: "user", content: secrets ? secrets.mask(input.sessionId, queued.text) : queued.text, ...(queued.attachments.length ? { attachments: queued.attachments } : {}) })
          await loop.persist()
          previous = ""
          repeats = 0
          any = true
          continue
        }
        input = { ...input, ...queued }
        const inline = await resolveInlineShell(input, messages)
        if (!inline.ok) return { joined: any, error: inline.message }
        if (inline.text !== input.text) input = { ...input, text: inline.text }
        await appendUser(input, messages, false)
        for (const message of messages) if (message.role !== "assistant") for (const claim of message.loadedInstructions ?? []) loadedInstructions.add(claim)
        await loop.persist()
        previous = ""
        repeats = 0
        any = true
      }
      return { joined: any }
    }
    for (let step = 0; step < maxSteps; step++) {
      // The last step of the engine's own limit (or the agent's) is a text-only summary of the work and what remains, so the turn never
      // ends on a bare error; a cap the caller set (`--max-turns`) stops the turn as it is.
      const final = !(loop.cap !== undefined && maxSteps === loop.cap) && step === maxSteps - 1
      if (final) messages.push({ role: "user", content: "The agent step limit is reached. Summarize the work and what remains. Reply with text only; do not call tools." })
      const available = withDiscovery(toolset, messages, input.permissionMode() === "plan")
      if (loop.trackContext) lastSpecs.set(input.sessionId, final ? [] : available.specs)
      let reply: Awaited<ReturnType<typeof callModel>>
      try {
        reply = await callModel(input, messages, "agent_message", final ? [] : available.specs, !toolset.main ? "subagent" : modeOf(input, toolset) === "plan" ? "plan" : "main", toolset.agent, loop.fork ? { meta: {}, fork: loop.fork } : undefined, final)
      } catch (error) {
        if (input.signal.aborted) return { outcome: { status: "ok" } as TurnOutcome, answer }
        return { outcome: { status: "error", code: error instanceof ReasoningError ? `reasoning_${error.code}` : "provider_error", message: `[ENGINE]: ${error instanceof Error ? error.message : String(error)}` } as TurnOutcome, answer }
      }
      for (const [callId, card] of reply.cards) if (card.whole) earlyCards.set(earlyKey(input.sessionId, callId), card)
      /** A call that ends here without a run still closes the card it opened early. */
      const closeEarly = (call: ToolCall, status: "cancelled" | "error", text: string) => {
        const card = takeEarlyCard(input.sessionId, call.callId)
        if (card) input.emit({ type: "item.completed", itemId: card.itemId, status, text })
      }
      if (reply.text.trim()) {
        answer = reply.text
        previous = ""
        repeats = 0
      }
      messages.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls, ...(reply.reasoning ? { reasoning: reply.reasoning } : {}) })
      await loop.persist?.()
      // A generated image is a file the model can use: without its path the model sees the picture and cannot save it anywhere.
      const toolImageNote = (tool: string, refs: BlobRef[]) => {
        const files = tool === "image_generation" && options.blobPath ? refs.map((ref) => `${options.blobPath!(ref)} (${ref.mime})`) : []
        return files.length ? `[image from ${tool} call]\nSaved by MendCode as ${files.length === 1 ? "this file" : "these files"}, named by content, without an extension:\n${files.join("\n")}\nTo put it where the user asks, copy the file with the shell and give the copy the right extension. Do not move, rename or edit the original.` : `[image from ${tool} call]`
      }
      // Generated images join the history after the step's tool outputs, as refs only.
      const toolImages: Array<{ tool: string; refs: BlobRef[] }> = reply.images.length ? [{ tool: "image_generation", refs: reply.images }] : []
      if (loop.structured && !input.signal.aborted && reply.toolCalls.length === 0) {
        // A plain-text answer where a structured one is required: ask again until the retries are used up.
        structuredFailures++
        if (structuredFailures > loop.structured.retries) return structuredExhausted()
        messages.push({ role: "user", content: STRUCTURED_NUDGE })
        await loop.persist?.()
        continue
      }
      if (input.signal.aborted || reply.toolCalls.length === 0) {
        for (const call of reply.toolCalls) closeEarly(call, "cancelled", "")
        for (const { tool, refs } of toolImages) messages.push({ role: "user", content: toolImageNote(tool, refs), attachments: refs })
        if (toolImages.length) await loop.persist?.()
        // A prompt that joins the running turn (steered, or the after-tools policy) and arrived during this answer gets one more model call here instead of a new turn.
        if (!input.signal.aborted && !final) {
          const { joined, error } = await joinQueued(step, true)
          if (error !== undefined) return { outcome: { status: "error", code: "inline_shell", message: error } as TurnOutcome, answer }
          if (joined) continue
        }
        return { outcome: { status: "ok" } as TurnOutcome, answer }
      }
      let structuredCall: "ok" | "failed" | undefined
      const editedPaths = new Set<string>()
      // The calls of one response run one at a time, in the order the model emitted them.
      let failedWrite: string | undefined
      for (const call of reply.toolCalls) {
        if (failedWrite && !input.signal.aborted) {
          // The model wrote the rest of this response for files as that edit would have left them: running it would only mislead.
          const output = `skipped: the earlier ${failedWrite} call of this response failed, so this call did not run. Fix that edit first, then send this call again.`
          const early = takeEarlyCard(input.sessionId, call.callId)
          const itemId = early?.itemId ?? input.newItemId()
          if (!early) input.emit({ type: "item.started", itemId, kind: "tool_call", meta: { tool: callTitle(call).slice(0, 200) } })
          input.emit({ type: "item.completed", itemId, status: "error", text: output })
          messages.push({ role: "tool", callId: call.callId, name: call.name, output, isError: true })
          continue
        }
        const signature = JSON.stringify([call.name, call.args])
        repeats = signature === previous ? repeats + 1 : 1
        previous = signature
        // Every call gets a result so the history stays valid for the next model request.
        const { result, stop } = input.signal.aborted
          ? { result: { output: "cancelled", truncated: false, title: call.name, isError: true }, stop: true }
          : final ? { result: { output: "agent step limit reached; tools are disabled", truncated: false, title: call.name, isError: true }, stop: false } : await runCall(input, call, PLAN_TOOL_NAMES.has(call.name) ? toolset : available, false, loadedInstructions, repeats >= 3, false, undefined, messages)
        closeEarly(call, input.signal.aborted ? "cancelled" : "error", result.output)
        if (!final && result.isError && FILE_WRITE_TOOLS.has(call.name)) failedWrite = call.name
        if (loop.structured && call.name === STRUCTURED_TOOL && !stop) structuredCall = result.isError ? structuredCall ?? "failed" : "ok"
        if (!result.isError && (call.name === "edit" || call.name === "write")) {
          const path = (call.args as { path?: unknown })?.path
          if (typeof path === "string" && editedPaths.size < 12) editedPaths.add(path)
        }
        // Identical captures reuse an image only while its blob is still visible in this model context.
        const priorCapture = call.name === "computer_capture" && typeof result.meta?.sha256 === "string" ? [...messages.flatMap((message) => message.role === "user" ? message.attachments ?? [] : []), ...toolImages.flatMap((image) => image.refs)].find((ref) => ref.sha256 === result.meta!.sha256 && ref.mime.startsWith("image/")) : undefined
        const visibleCapture = priorCapture && options.readBlob ? await options.readBlob(priorCapture).then((bytes) => bytes.byteLength > 0).catch(() => false) : false
        const media = [...(visibleCapture ? [] : result.images ?? []), ...(result.attachments ?? [])]
        const refs = await storeToolImages(input.sessionId, media)
        const missingMedia = media.length > refs.length
        messages.push({ role: "tool", callId: call.callId, name: call.name, output: missingMedia ? `${result.output}\n[${result.attachments?.length ? "attachment" : "image"} not shown: ${!options.storeBlob ? "no blob store" : "blob storage failed or media limit reached"}]` : result.output, isError: result.isError, ...(result.loadedInstructions?.length ? { loadedInstructions: result.loadedInstructions } : {}), ...((call.name === TOOL_SEARCH_NAME || call.name === CODE_TOOL.name) && !result.isError && result.discoveredTools ? { discoveredTools: result.discoveredTools } : {}) })
        // Restoring a missing capture blob also restores its existing context ref.
        if (refs.length && !refs.some((ref) => ref.sha256 === priorCapture?.sha256)) toolImages.push({ tool: call.name, refs })
        if (stop) {
          for (const rest of reply.toolCalls.slice(reply.toolCalls.indexOf(call) + 1))
            messages.push({ role: "tool", callId: rest.callId, name: rest.name, output: "cancelled", isError: true })
          await loop.persist?.()
          return { outcome: { status: "ok" } as TurnOutcome, answer }
        }
      }
      for (const path of editedPaths) if (await graphNote("graph_impact", { path }, `graph_impact_${createHash("sha1").update(`${input.turnId}:${step}:${path}`).digest("hex").slice(0, 24)}`)) return { outcome: { status: "ok" } as TurnOutcome, answer }
      // Images follow every tool output of the step as user messages; only their refs are kept in history.
      for (const { tool, refs } of toolImages) messages.push({ role: "user", content: toolImageNote(tool, refs), attachments: refs })
      await loop.persist?.()
      if (input.signal.aborted) return { outcome: { status: "ok" } as TurnOutcome, answer }
      if (loop.structured) {
        // A valid `StructuredOutput` call is the answer and ends the turn; an invalid one (or other calls only) costs a retry.
        if (structuredCall === "ok") return { outcome: { status: "ok" } as TurnOutcome, answer }
        if (structuredCall === "failed" && ++structuredFailures > loop.structured.retries) return structuredExhausted()
      }
      // Only the foreground loop consumes prompts, after the whole tool iteration is safely in history.
      const { error } = await joinQueued(step)
      if (error !== undefined) return { outcome: { status: "error", code: "inline_shell", message: error } as TurnOutcome, answer }
    }
    if (toolset.agent?.steps !== undefined) return { outcome: { status: "ok" } as TurnOutcome, answer }
    return { outcome: { status: "error", code: "max_steps", message: `[ENGINE]: stopped after ${maxSteps} model steps` } as TurnOutcome, answer }
  }

  /**
   * Shows the plan in the tool card and asks for approval. Approve → leave plan mode (back to "ask",
   * so edits still need approval) and implement; deny with text → that text is the revision feedback.
   */
  async function reviewPlan(input: TurnInput, plan: string, itemId: ItemId, toolset: Toolset, title?: string, requestedPhase?: import("@mendcode/protocol").PlanReview["phase"]): Promise<ToolResult> {
    if (modeOf(input, toolset) !== "plan") input.setPermissionMode("plan")
    const destination = options.agents?.planExit?.(input.sessionId)?.name ?? "build"
    const review: import("@mendcode/protocol").PlanReview = { markdown: redactSecrets(secrets ? secrets.mask(input.sessionId, plan.trim()) : plan.trim()).text, ...(title ? { title: redactSecrets(secrets ? secrets.mask(input.sessionId, title) : title).text } : {}), phase: planPhase(plan, input.text, requestedPhase), destination }
    latestPlans.set(input.sessionId, review)
    input.emit({ type: "item.delta", itemId, text: review.markdown })
    const answer = await input.ask({ kind: "approval", title: "Review plan", detail: "", itemId, tool: "plan_review", planReview: review })
    const reply = answer.kind === "plan_review" ? answer : answer.kind === "approve" ? { action: "apply" as const } : answer.kind === "deny" ? { action: "reject" as const, reason: answer.reason } : { action: "close" as const }
    const markdown = "markdown" in reply && reply.markdown ? reply.markdown : review.markdown
    latestPlans.set(input.sessionId, { ...review, markdown })
    const comments = "comments" in reply && reply.comments ? `\nUser implementation comments:\n${reply.comments}` : ""
    if (reply.action === "apply") {
      if (planPhase(markdown, input.text, review.phase) === "plan") return { output: "This packet permits planning only. Acceptance does not authorize implementation; stay read-only.", truncated: false, title: "plan only", isError: true }
      const requested = "destination" in reply && reply.destination ? reply.destination : destination
      const target = options.agents?.planExit?.(input.sessionId, requested) ?? { name: "build" }
      if (target.name !== requested) return { output: "The destination is no longer available or trusted. Ask the user to select a destination again.", truncated: false, title: "plan destination", isError: true }
      if (toolset.agent?.permission === "plan" && toolset.agent.name !== "plan") return { output: "Plan approved, but this agent is read-only: it cannot implement. Give the user the approved plan as your answer.", truncated: false, title: "plan approved", isError: false }
      options.agents?.select?.(input.sessionId, target.name)
      Object.assign(toolset, withAgent(withSubagents(withProjectTools(mainToolset, toolset.extras ?? []), [...(toolset.subagents?.values() ?? [])]), target.profile), { agent: target.profile })
      lastAgent.set(input.sessionId, target.profile)
      lastSpecs.set(input.sessionId, toolset.specs)
      input.setPermissionMode("ask")
      return { output: `Plan approved. Switched to ${target.name}; implement this approved Markdown and verify it:\n\n${markdown}${comments}`, truncated: false, title: "plan approved", isError: false, meta: { planExitAgent: target.name, phase: review.phase } }
    }
    if (reply.action === "accept") return { output: `Plan accepted. Acceptance does not authorize implementation. Stay read-only and return the approved plan.\n\n${markdown}${comments}`, truncated: false, title: "plan accepted", isError: false }
    if (reply.action === "edit") return { output: `The user edited the plan. Treat this Markdown as the source of truth; stay read-only.\n\n${markdown}${comments}`, truncated: false, title: "plan edited", isError: false }
    if (reply.action === "close") return { output: "Plan review closed without authorization. Ask what the user wants to change before proceeding.", truncated: false, title: "plan closed", isError: false }
    const feedback = "reason" in reply ? reply.reason : undefined
    return { output: feedback ? `Plan not approved. Feedback: ${feedback}\nRevise the plan and submit it again.` : "Plan rejected. Ask what the user wants instead.", truncated: false, title: "plan: changes requested", isError: true }
  }

  /**
   * A sub-agent: a fresh conversation with the same tools except `task` (no recursion) and `question`
   * (only the main agent talks to the user). Its tool steps stream into the task card; approvals go
   * through the parent session; only its final answer returns to the parent model.
   */
  async function runTask(input: TurnInput, args: z.infer<typeof TASK_TOOL.args>, taskItem: ItemId, parent: Toolset): Promise<ToolResult> {
    const title = `task: ${args.description}`
    // The description names only the first agents (`subagentCatalog`); the rest are listed here, and an unknown name says what there is.
    const named = subagentName(args.agent ?? args.subagent_type, parent.subagents)
    const known = [...(parent.subagents?.values() ?? [])]
    if (named === LIST_AGENTS) return { output: subagentListing(known), title: "task: agents", truncated: false, isError: false }
    if (named && parent.subagents && !parent.subagents.has(named)) {
      const names = known.map((agent) => agent.name)
      return { output: `unknown agent "${named}"; available: ${names.slice(0, 40).join(", ")}${names.length > 40 ? ` (+${names.length - 40}: agent "${LIST_AGENTS}")` : ""}`, truncated: false, title, isError: true }
    }
    if (args.isolation && (!options.tasks || !featureOn(policy(), "task_worktree"))) return { output: "isolation: \"worktree\" needs the full tier (task_worktree) and the daemon task registry", truncated: false, title, isError: true }
    if (args.fork && !featureOn(policy(), "task_fork")) return { output: "fork needs the task_fork feature (/tier task_fork on)", truncated: false, title, isError: true }
    // A fork that cannot share the parent's prefix runs fresh, and the answer says so: its prompt may lean on context it did not get.
    const notForked = args.task_id ? "a resumed task keeps its own context" : args.isolation ? "a worktree child works elsewhere" : args.engine && args.engine !== "native" ? "another engine cannot read this cache" : args.variant ? "a variant changes the request" : undefined
    const forked = args.fork ? notForked ? { refused: notForked } : await forkStart(input.sessionId, args.model) : undefined
    const forkLine = !forked ? "" : "refused" in forked ? `context: fresh (fork unavailable: ${forked.refused})\n` : "context: forked\n"
    const fork = forked && !("refused" in forked) ? forked : undefined
    if (options.tasks) {
      try {
        const { subagent_type: _type, agent: _agent, task_id, fork: _fork, ...rest } = args
        // The child's own session runs on the parent's model, which the fork's calls use whatever the sub-agent role says.
        const forkInput = fork ? { fork: true, ...(!rest.model && fork.prefix.choice ? { model: fork.prefix.choice.model } : {}) } : {}
        const task = await options.tasks.run(input.sessionId, { ...rest, ...forkInput, ...(args.task_id ? { task_id: args.task_id as SessionId } : {}), ...(named ? { agent: named } : {}) }, input.signal)
        return { output: `task_id: ${task.taskId}\nstate: ${task.state}\n${forkLine}${task.result}`, title, truncated: false, isError: ["failed", "cancelled", "interrupted"].includes(task.state), meta: { taskId: task.taskId, state: task.state } }
      } catch (error) { return { output: String(error), title, truncated: false, isError: true } }
    }
    if (args.engine && args.engine !== "native") return { output: "cross-engine delegation needs the daemon task registry", title, truncated: false, isError: true }
    const startedAt = Date.now()
    const childItems = new Map<ItemId, string>()
    const profile = named ? parent.subagents?.get(named) : undefined
    if (named && !profile) return { output: `unknown agent "${named}"; there are no custom sub-agents here (omit agent for a general one)`, truncated: false, title, isError: true }
    const child: TurnInput = {
      ...input,
      // A sub-agent never runs with more permission than the loop that called it.
      permissionMode: () => modeOf(input, parent),
      emit(event) {
        if (event.type === "usage") return input.emit(event)
        if (event.type === "item.started" && event.kind === "tool_call") {
          const step = String(event.meta?.tool ?? "tool")
          childItems.set(event.itemId, step)
          input.emit({ type: "item.delta", itemId: taskItem, text: `◆ ${step}\n` })
        } else if (event.type === "item.completed" && childItems.has(event.itemId) && event.status !== "ok")
          input.emit({ type: "item.delta", itemId: taskItem, text: `  ✗ ${event.status}\n` })
      },
    }
    const messages: ModelMessage[] = fork ? [...fork.messages, { role: "user", content: forkPrompt(args.prompt, profile) }] : [{ role: "user", content: args.prompt }]
    // The sub-agent gets the same project (MCP) tools the parent had this turn.
    const { outcome, answer } = await runLoop(child, messages, withPolicy(withAgent(withProjectTools(subagentToolset, parent.extras ?? []), profile)), { maxSteps: options.maxTaskSteps ?? DEFAULT_TASK_STEPS, trackContext: false, fork: fork?.prefix })
    // For the card's summary line (v1: `└ 7 toolcalls · 1m 5s`).
    const meta = { toolCalls: childItems.size, durationMs: Date.now() - startedAt }
    if (outcome.status === "error") return { output: `${forkLine}task failed (${outcome.code}): ${outcome.message}${answer ? `\n\nLast answer:\n${answer}` : ""}`, truncated: false, title, isError: true, meta }
    if (input.signal.aborted) return { output: "task cancelled", truncated: false, title, isError: true, meta }
    return { output: `${forkLine}${answer || "(the task finished without an answer)"}`, truncated: false, title, isError: !answer, meta }
  }

  /** What a session's main agent is offered, as a turn would build it. */
  async function hostToolset(sessionId: SessionId, directory: string): Promise<Toolset> {
    const extra = options.projectTools ? await options.projectTools(directory, sessionId, { host: true }).catch(() => []) : []
    const agent = settle(() => options.agents?.primary(sessionId), undefined)
    const subagents = settle(() => options.agents?.subagents(directory) ?? [], [])
    return withoutHidden(withRunLimits(withPolicy(withAgent(withSubagents({ ...withProjectTools(mainToolset, extra), extras: extra }, subagents), agent)), options.runLimits?.(sessionId)), directory)
  }
  let hostCalls = 0

  return {
    forget(sessionId) {
      // A deleted session's prompts, schemas and profiles go with it; a fork of it keeps its own copy (`forkPrefixes` of the fork).
      for (const map of [latestPlans, lastSpecs, lastAgent, lastSubagents, lastMain, forkPrefixes, turnStarts, lineages, contextTokens, prunedTokens] as Array<Map<SessionId, unknown>>) map.delete(sessionId)
      for (const key of [...earlyCards.keys()]) if (key.startsWith(`${sessionId}\n`)) earlyCards.delete(key)
    },
    async hostTools({ directory, sessionId }) {
      const toolset = await hostToolset(sessionId, directory)
      return toolset.specs.filter((spec) => hostable(spec.name)).map((spec) => ({ name: spec.name, description: spec.description, parameters: spec.parameters }))
    },
    async hostCall({ turn, name, args }) {
      const toolset = await hostToolset(turn.sessionId, options.cwdFor(turn.sessionId))
      if (!hostable(name) || !toolset.tools.has(name)) return { output: `Tool ${name} is not available in this session`, isError: true }
      // The turn's own attachments are the "recent images" an image edit can take; the other harness keeps the rest of the history.
      const history: ModelMessage[] = turn.attachments.length ? [{ role: "user", content: turn.text, attachments: turn.attachments }] : []
      const { result } = await runCall(turn, { callId: `host-${turn.turnId}-${++hostCalls}`, name, args }, toolset, false, undefined, false, false, undefined, history)
      return { output: result.output, isError: result.isError, ...(result.images?.length ? { images: result.images } : {}) }
    },
    async catalogTools({ directory }) {
      const sessionId = createIdFactory()("session")
      const extra = options.projectTools ? await options.projectTools(directory, sessionId) : []
      const base = withPolicy(withSubagents(withProjectTools(mainToolset, extra), options.agents?.subagents(directory) ?? []))
      return base.specs.map((spec) => ({ id: spec.name, description: spec.description, parameters: spec.parameters }))
    },
    async debugAgent({ directory, sessionId, agent, run }) {
      await hooks?.prepare?.({ sessionId, cwd: directory })
      const extra = options.projectTools ? await options.projectTools(directory, sessionId) : []
      const base = withProjectTools(agent.mode === "subagent" ? subagentToolset : mainToolset, extra)
      const profile: AgentProfile = { name: agent.name, description: agent.description, mode: agent.mode, prompt: agent.prompt,
        ...(agent.model ? { model: agent.model } : {}), ...(agent.effort ? { effort: agent.effort } : {}),
        ...(agent.tools ? { tools: agent.tools } : {}), ...(agent.deny ? { deny: agent.deny } : {}),
        ...(agent.permission ? { permission: agent.permission } : {}), ...(agent.permissionRules ? { permissionRules: agent.permissionRules } : {}) }
      const toolset = withPolicy(withAgent(withSubagents(base, options.agents?.subagents(directory) ?? []), profile))
      const tools = Object.fromEntries(base.specs.map((spec) => [spec.name, toolset.specs.some((allowed) => allowed.name === spec.name) && !(agent.permission === "plan" && base.tools.get(spec.name)?.permission !== "read")]))
      if (!run) return { tools }
      if (!tools[run.tool]) throw new Error(`Tool ${run.tool} is disabled or unavailable for agent ${agent.name}`)
      const executed = await runCall(run.turn, { callId: `debug-${run.turn.turnId}`, name: run.tool, args: run.params }, toolset, false, undefined, false, true)
      const { output, truncated, title, isError } = executed.result
      return { tools, result: { output, truncated, title, isError } }
    },
    async runTurn(input): Promise<TurnOutcome> {
      const compound = options.compound?.(input.sessionId)
      if (compound) input = { ...input, signal: AbortSignal.any([input.signal, compound.budget.signal]) }
      autoCompaction.delete(input.sessionId)
      if (!compound) await hooks?.prepare?.({ sessionId: input.sessionId, cwd: options.cwdFor(input.sessionId) })
      const messages = (await options.history.load(input.sessionId)) ?? []
      // A custom command's inline shell runs here, as tool calls of this turn, before the message exists.
      const inline = await resolveInlineShell(input, messages)
      if (!inline.ok) return { status: "error", code: "inline_shell", message: inline.message }
      if (inline.text !== input.text) input = { ...input, text: inline.text }
      // A child launched with `fork: true` starts from its parent's last request, when that is still on record and it works in the same place.
      const forkParent = messages.length === 0 ? options.tasks?.forkOf?.(input.sessionId) : undefined
      const forked = forkParent && options.cwdFor(forkParent) === options.cwdFor(input.sessionId) ? await forkStart(forkParent) : undefined
      if (forked && !("refused" in forked)) {
        forkPrefixes.set(input.sessionId, forked.prefix)
        input = { ...input, text: forkPrompt(input.text, settle(() => options.agents?.primary(input.sessionId, input.selection?.agent), undefined)) }
      }
      const inherited = forked && !("refused" in forked) ? forked.messages : []
      // An @file mention pastes the file into the message: a secret in it is a marker before the model or the history see it.
      // The inherited messages go in front of it afterwards, untouched: dropping their signed reasoning (as a new turn does) would change the prefix.
      await appendUser(input, messages)
      if (inherited.length) messages.unshift(...inherited)
      if (!compound && !input.turnOptions?.noReply && options.tasks?.isChild(input.sessionId) !== true) recallPackedTurns(input, messages)
      const prunedInPlace = !inherited.length && options.pruneToolOutputs?.() !== false && pruneNow(input.sessionId, messages)
      if (prunedInPlace) pruneHistoryToolOutputs(messages)
      turnStarts.set(input.sessionId, { start: messages.length, pruned: prunedInPlace })
      await options.history.save(input.sessionId, messages)
      // `noReply`: the message is in the transcript and the history; the model is not called.
      if (input.turnOptions?.noReply) return { status: "ok" }
      const extra = !compound && options.projectTools ? await options.projectTools(options.cwdFor(input.sessionId), input.sessionId).catch(() => []) : []
      const cwd = options.cwdFor(input.sessionId)
      // A broken agent file never blocks a turn: without agents the session runs as the default one.
      const agent = settle(() => options.agents?.primary(input.sessionId, input.selection?.agent), undefined)
      const subagents = settle(() => options.agents?.subagents(cwd) ?? [], [])
      const child = options.tasks?.isChild(input.sessionId) === true || input.workflow !== undefined
      const base = child ? { ...subagentToolset, specs: [...subagentToolset.specs, ...(options.subagents ? [toSpec(TASK_TOOL_SHARED)] : [])], allowTask: options.subagents === true } : mainToolset
      const limits = options.runLimits?.(input.sessionId)
      // A prompt's own tool exclusions stack on the session's limits: they only remove tools (and sub-agents, whose tools they cannot bound).
      const turnExcluded = input.turnOptions?.excludeTools ?? []
      const turnLimits: RunLimits | undefined = turnExcluded.length ? { ...limits, excludeTools: [...(limits?.excludeTools ?? []), ...turnExcluded] } : limits
      let toolset = withoutHidden(withRunLimits(withPolicy(withAgent(withSubagents({ ...withProjectTools(base, extra), extras: extra }, subagents), agent)), turnLimits), cwd)
      // A required answer format adds the finishing tool after every narrowing, so it can neither be removed nor reach sub-agents.
      const structured = !child && input.turnOptions?.format ? structuredTool(input.turnOptions.format.schema) : undefined
      if (input.turnOptions?.format && !structured) return { status: "error", code: "structured_output", message: "[ENGINE]: the required output format is not a usable JSON Schema" }
      if (structured) toolset = withProjectTools(toolset, [structured])
      if (compound) {
        const allowed = new Set(compound.critic ? [] : ["read", "write", "edit", "apply_patch", "glob", "grep", "shell", "list"])
        toolset.tools = new Map([...toolset.tools].filter(([name]) => allowed.has(name)))
        toolset.specs = toolset.specs.filter((spec) => allowed.has(spec.name))
        toolset.allowTask = false
      }
      lastSpecs.set(input.sessionId, toolset.specs)
      lastAgent.set(input.sessionId, agent)
      lastSubagents.set(input.sessionId, toolset.allowTask ? subagents : [])
      const providerTurn = new AbortController()
      const abortProvider = () => providerTurn.abort()
      input.signal.addEventListener("abort", abortProvider, { once: true })
      if (input.signal.aborted) abortProvider()
      providerTurnSignals.set(input.signal, providerTurn.signal)
      try {
        const { outcome } = await runLoop(input, messages, toolset, {
          maxSteps: child ? options.maxTaskSteps ?? DEFAULT_TASK_STEPS : options.maxSteps ?? DEFAULT_MAX_STEPS,
          ...(limits?.maxSteps ? { cap: limits.maxSteps } : {}),
          persist: () => options.history.save(input.sessionId, messages),
          trackContext: true,
          fork: forkPrefixes.get(input.sessionId),
          ...(structured ? { structured: { retries: input.turnOptions!.format!.retries ?? DEFAULT_STRUCTURED_RETRIES } } : {}),
        })
        return outcome
      } finally {
        input.signal.removeEventListener("abort", abortProvider)
        providerTurnSignals.delete(input.signal)
        providerTurn.abort()
        if (!child) options.reasoning?.release(input.sessionId)
      }
    },
    /**
     * `!command`: runs the user's own command with the shell tool (no model call, no approval) and records it
     * in the history so the next answer can use its output; `!!command` (`localShell`) leaves the history alone.
     */
    async runShell(input): Promise<TurnOutcome> {
      if (!mainToolset.tools.has(SHELL_TOOL)) return { status: "error", code: "no_shell", message: "[ENGINE]: this engine has no shell tool" }
      await hooks?.prepare?.({ sessionId: input.sessionId, cwd: options.cwdFor(input.sessionId) })
      const call: ToolCall = { callId: `user-shell-${input.turnId}`, name: SHELL_TOOL, args: { command: input.text } }
      const { result } = await runCall(input, call, mainToolset, true)
      // `!!command`: shown in the transcript, never added to what the model reads.
      if (input.localShell) return { status: "ok" }
      const messages = (await options.history.load(input.sessionId)) ?? []
      const status = input.signal.aborted ? " (cancelled)" : result.isError ? " (failed)" : ""
      messages.push({ role: "user", content: `I ran a shell command myself${status}:\n$ ${input.text}\n\`\`\`\n${result.output}\n\`\`\`` })
      await options.history.save(input.sessionId, messages)
      return { status: "ok" }
    },
    async contextReport(sessionId): Promise<ContextReport> {
      let messages = (await options.history.load(sessionId)) ?? []
      const cwd = options.cwdFor(sessionId)
      const section = (id: string, label: string, chars: number, count?: number): ContextSection => ({ id, label, chars, tokens: estimateTokens(chars), ...(count === undefined ? {} : { count }) })
      const context = { sessionId, prompt: lastPrompt(messages) }
      const agent = lastAgent.has(sessionId) ? lastAgent.get(sessionId) : options.agents?.primary(sessionId)
      const agentText = agent ? agentSection(agent) : ""
      const parts = options.systemParts?.(cwd, context) ?? [{ id: "system", label: "system prompt", text: options.system(cwd, context) }]
      const system = [...parts, ...(agentText ? [{ id: "agent", label: `agent ${agent!.name}`, text: agentText, count: 1 }] : [])].map((part) => section(`system:${part.id}`, `system · ${part.label}`, part.text.length, part.count))
      const subagents = lastSubagents.get(sessionId) ?? options.agents?.subagents(cwd) ?? []
      const toolSpecs = lastSpecs.get(sessionId) ?? withDiscovery(withAgent(withSubagents(withProjectTools(mainToolset, await options.projectTools?.(cwd, sessionId) ?? []), subagents), agent), messages).specs
      const choice = choiceFor(options.modelFor?.(sessionId, "main"), agent)
      let requestSystem = options.system(cwd, context)
      if (agentText) requestSystem += `\n\n${agentText}`
      const known = secrets?.list(sessionId) ?? []
      if (known.length) requestSystem += `\n\n${secretsNote(known)}`
      const projection = await checkpointContext(options.provider, { system: requestSystem, messages, tools: toolSpecs, model: choice?.model, parameters: choice?.parameters, effort: choice?.effort }).catch(() => ({ messages: pairToolCalls(portableHistory(messages)) }))
      messages = pruneToolOutputs(projection.messages, pruneNow(sessionId, projection.messages)).messages
      const byRole = { user: { chars: 0, count: 0 }, assistant: { chars: 0, count: 0 }, tool: { chars: 0, count: 0 } }
      let images = 0
      const sized: ContextMessage[] = []
      for (const message of messages) {
        const chars = messageChars(message)
        byRole[message.role].chars += chars
        byRole[message.role].count++
        if (message.role === "user") images += message.attachments?.length ?? 0
        sized.push({ role: message.role, chars, tokens: estimateTokens(chars), preview: messagePreview(message) })
      }
      const sections = [
        ...system,
        section("tools", "tools", JSON.stringify(toolSpecs).length, toolSpecs.length),
        section("history:user", "history · user", byRole.user.chars, byRole.user.count),
        section("history:assistant", "history · assistant", byRole.assistant.chars, byRole.assistant.count),
        section("history:tool", "history · tool results", byRole.tool.chars, byRole.tool.count),
      ]
      const measured = contextTokens.get(sessionId)
      const mcpTools = toolSpecs.filter((spec) => spec.name.startsWith("mcp__")).map((spec) => section(spec.name, spec.name, JSON.stringify(spec).length, 1))
      const categoryIds = ["system", "tools", "mcp", "agents", "memory", "skills", "messages"]
      const categories = categoryIds.map((id) => section(id, id, 0))
      const byCategory = new Map(categories.map((entry) => [entry.id, entry]))
      for (const entry of sections) {
        const id = entry.id.startsWith("history:") ? "messages" : entry.id === "tools" ? "tools" : entry.id === "system:skills" ? "skills" : entry.id === "system:memory" ? "memory" : entry.id === "system:agent" ? "agents" : "system"
        const target = byCategory.get(id)!
        target.chars += entry.chars
        target.tokens += entry.tokens
        if (entry.count !== undefined) target.count = (target.count ?? 0) + entry.count
      }
      // MCP schemas and the custom-agent catalog live inside tools: move, never double-count them.
      const toolsCategory = byCategory.get("tools")!
      const moveTools = (id: string, chars: number, tokens: number, count: number) => {
        const target = byCategory.get(id)!
        const moved = Math.min(tokens, toolsCategory.tokens)
        target.chars += chars
        target.tokens += moved
        target.count = (target.count ?? 0) + count
        toolsCategory.chars = Math.max(0, toolsCategory.chars - chars)
        toolsCategory.tokens -= moved
      }
      moveTools("mcp", mcpTools.reduce((sum, entry) => sum + entry.chars, 0), mcpTools.reduce((sum, entry) => sum + entry.tokens, 0), mcpTools.length)
      toolsCategory.count = toolSpecs.length - mcpTools.length
      const taskSpec = toolSpecs.find((spec) => spec.name === TASK_TOOL.name)
      if (taskSpec && subagents.length && taskSpec.description !== TASK_TOOL.description) {
        const chars = JSON.stringify(taskSpec.description).length - JSON.stringify(TASK_TOOL.description).length
        moveTools("agents", chars, estimateTokens(chars), subagents.length)
      }
      const readCalls = new Map(messages.flatMap((message) => message.role === "assistant" ? message.toolCalls : []).filter((call) => call.name === "read").map((call) => [call.callId, (call.args as { path?: unknown })?.path]))
      const reads = new Map<string, { path: string; count: number; tokens: number }>()
      for (const message of messages) if (message.role === "tool" && !message.isError) {
        const file = readCalls.get(message.callId)
        if (typeof file !== "string") continue
        const entry = reads.get(file) ?? { path: file, count: 0, tokens: 0 }
        entry.count++
        entry.tokens += estimateTokens(messageChars(message))
        reads.set(file, entry)
      }
      for (const entry of categories) if (entry.chars === 0 && entry.count === undefined) entry.count = 0
      // Context rent: what each tool's schema costs every request against the calls still in the history.
      const uses = new Map<string, number>()
      for (const message of messages) if (message.role === "assistant") for (const call of message.toolCalls) uses.set(call.name, (uses.get(call.name) ?? 0) + 1)
      const rent = toolSpecs.map((spec) => ({ tool: spec.name.slice(0, 200), owner: toolOwner(spec.name), tokens: estimateTokens(JSON.stringify(spec).length), uses: uses.get(spec.name) ?? 0 })).sort((a, b) => b.tokens - a.tokens || a.tool.localeCompare(b.tool)).slice(0, 200)
      return {
        model: choice?.model ?? options.provider.model,
        sessionId,
        categories,
        mcpTools,
        rent,
        repeatedReads: [...reads.values()].filter((entry) => entry.count > 1).sort((a, b) => b.tokens - a.tokens).slice(0, 5),
        files: contextFiles({ messages, tokensOf: (message) => estimateTokens(messageChars(message)) }),
        sections,
        largest: sized.sort((a, b) => b.chars - a.chars).slice(0, CONTEXT_LARGEST),
        images,
        estimatedTokens: sections.reduce((sum, entry) => sum + entry.tokens, 0),
        ...(measured === undefined ? {} : { measuredTokens: measured }),
        compactAtTokens: compactAt(sessionId),
      }
    },
    needsCompaction: (sessionId) => {
      if (options.compound?.(sessionId)) return false
      const needed = compactionConfig().auto !== false && (contextTokens.get(sessionId) ?? 0) >= compactAt(sessionId)
      if (needed) autoCompaction.add(sessionId)
      return needed
    },
    /**
     * Installs a portable summary or a bound native checkpoint plus recent tail. On cancel,
     * failure, stale history or an empty summary, nothing is replaced.
     * A `compact.before` hook may cancel it or supply the summary (no model call).
     */
    async compact(input): Promise<TurnOutcome> {
      options.reasoning?.invalidate(input.sessionId)
      const reason = autoCompaction.delete(input.sessionId) || input.idle ? "auto" : "manual"
      // A portable summary is read from the provider's prompt cache when its request repeats the last main call's (`callModel`, `share`).
      // A compaction while idle pays only then: when it cannot (no such call on record after a daemon restart, a compound session, ...) it is
      // skipped, never run at the full input price. A manual or automatic one keeps its own smaller request instead (`sharedOff` says why).
      const last = options.compound?.(input.sessionId) ? undefined : lastMain.get(input.sessionId)
      if (input.idle && (!last || compactionConfig().strategy === "native")) return { status: "ok" }
      const cwd = options.cwdFor(input.sessionId)
      await hooks?.prepare?.({ sessionId: input.sessionId, cwd })
      const messages = (await options.history.load(input.sessionId)) ?? []
      if (messages.length === 0) return { status: "ok", empty: true, note: "Nothing to compact: this model has not run a turn of this session yet." }
      const config = compactionConfig()
      // The summariser is the main call's model unless the user gave the `compaction` role its own (or picked a model for this `/compact`):
      // that is a choice of another summariser, and its request stays as it was. A compaction while idle always runs on the main call's model.
      const ownModel = (sent: SharedPrefix) => {
        const summariser = input.selection?.model ?? options.modelFor?.(input.sessionId, "compaction")
        return (summariser?.model ?? options.provider.model) !== (sent.choice?.model ?? options.provider.model) || !input.selection?.model && fingerprint(summariser) !== fingerprint(options.modelFor?.(input.sessionId, "main"))
      }
      const sentHistory = last && asLastSent(messages, last)
      let sharedOff: "no-call" | "native-strategy" | "other-model" | "history-changed" | "too-large" | "tool-call" | "empty" | "tool-call-cosplay" | "error" | undefined = !last ? "no-call" : config.strategy === "native" ? "native-strategy" : !input.idle && ownModel(last) ? "other-model" : !sentHistory ? "history-changed" : undefined
      if (input.idle && sharedOff) return { status: "ok" }
      const original = fingerprint(messages)
      const previous = checkpointOf(messages)
      const limits = limitsFor(input.sessionId)
      let selected = splitCompaction(messages, config, limits)
      const method = config.portable_mode ?? "legacy"
      const meta = { compactionMethod: method as string, tailTurns: selected.tailTurns, tailTokens: historyTokens(selected.tail) }
      let summary = ""
      if (hooks?.has("compact.before", cwd) && hooks.compactBefore) {
        const tokens = contextTokens.get(input.sessionId) ?? estimateTokens(messages.reduce((sum, message) => sum + messageChars(message), 0))
        const verdict = await hooks.compactBefore({ sessionId: input.sessionId, cwd, reason, tokens })
        if (verdict?.cancel) return { status: "ok" }
        summary = verdict?.summary?.trim() ?? ""
        if (summary) {
          // A supplied summary needs no model call; it still shows as the compaction's card.
          const itemId = input.newItemId()
          input.emit({ type: "item.started", itemId, kind: "compaction", meta })
          input.emit({ type: "item.completed", itemId, status: "ok", text: clip(summary) })
        }
      }
      let checkpoint: CompactionCheckpoint = { version: 1, generation: (previous?.generation ?? 0) + 1, method, tailTurns: selected.tailTurns }
      let nativeItemId: ItemId | undefined
      try {
        const tailored = reason === "manual" && (!!input.instructions || !!input.selection?.model)
        // Whether the native compaction endpoint reads the prompt cache is not known, so a compaction while idle always writes a portable summary (and is not run at all under `strategy: native`).
        const wantsNative = !summary && !tailored && !input.idle && (config.strategy === "native" || config.strategy === "auto")
        const active = wantsNative ? choiceFor(options.modelFor?.(input.sessionId, "main"), lastAgent.get(input.sessionId)) : undefined
        const compactChoice = wantsNative ? options.modelFor?.(input.sessionId, "compaction") : undefined
        const roleMatches = !compactChoice || compactChoice.model === (active?.model ?? options.provider.model) && compactChoice.effort === active?.effort && fingerprint(compactChoice.parameters) === fingerprint(active?.parameters)
        const binding = wantsNative && roleMatches ? await compactionDeadline(input.signal, config.timeout_ms ?? DEFAULT_COMPACTION_TIMEOUT_MS, async () => options.provider.nativeBinding?.(active?.model)) : undefined
        if (wantsNative && (!binding || !roleMatches || !options.provider.compact) && config.strategy === "native") throw new NativeCompactionError("unsupported", roleMatches ? "Native compaction is unavailable for this transport" : "Native compaction requires the active model; the compaction role differs")
        if (wantsNative && binding && options.provider.compact) {
          const tools = lastSpecs.get(input.sessionId) ?? withDiscovery(mainToolset, []).specs
          let system = options.system(cwd, { sessionId: input.sessionId, prompt: lastPrompt(messages) })
          const agent = lastAgent.get(input.sessionId)
          if (agent) system += `\n\n${agentSection(agent)}`
          const known = secrets?.list(input.sessionId) ?? []
          if (known.length) system += `\n\n${secretsNote(known)}`
          if (hooks?.has("prompt.system", cwd)) system = (await hooks.system?.({ sessionId: input.sessionId, cwd, role: "main", system })) ?? system
          const head = selected.head.length ? selected.head : messages
          const request = { system, messages: head, tools, ...(active ? { model: active.model, effort: active.effort, parameters: active.parameters } : {}) }
          const contract = fingerprint({ system, tools, model: active?.model ?? options.provider.model, parameters: active?.parameters, effort: active?.effort })
          nativeItemId = input.newItemId()
          input.emit({ type: "item.started", itemId: nativeItemId, kind: "compaction", meta: { ...meta, compactionMethod: "native" } })
          try {
            const result = await compactionDeadline(input.signal, config.timeout_ms ?? DEFAULT_COMPACTION_TIMEOUT_MS, async (signal) => {
              const projection = await checkpointContext(options.provider, request)
              return options.provider.compact!({ ...request, ...projection, messages: await withImages(projection.messages), signal })
            })
            if (!Array.isArray(result.output) || !result.output.length || result.output.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new NativeCompactionError("malformed", "Native checkpoint is malformed")
            if (Buffer.byteLength(JSON.stringify(result.output)) > 4 * 1024 * 1024) throw new NativeCompactionError("oversized", "Native checkpoint exceeds 4 MiB")
            const current = choiceFor(options.modelFor?.(input.sessionId, "main"), lastAgent.get(input.sessionId))
            if (fingerprint(current) !== fingerprint(active)) throw new NativeCompactionError("stale", "Active model changed")
            const currentBinding = await compactionDeadline(input.signal, config.timeout_ms ?? DEFAULT_COMPACTION_TIMEOUT_MS, async () => options.provider.nativeBinding?.(active?.model))
            if (binding !== currentBinding) throw new NativeCompactionError("stale", "Native binding changed")
            // If the entire history fitted in the tail, it was compacted in full: never replay it twice.
            if (!selected.head.length) {
              selected = { head: messages, tail: [], tailTurns: 0 }
              Object.assign(meta, { tailTurns: 0, tailTokens: 0 })
            }
            checkpoint = { ...checkpoint, method: "native", native: { binding, fingerprint: contract, output: result.output, source: portableHistory(head), ...(result.requestId ? { requestId: result.requestId } : {}) }, ...(previous?.native ? { previous: { binding: previous.native.binding, fingerprint: previous.native.fingerprint, output: previous.native.output } } : {}) }
            checkpoint.tailTurns = selected.tailTurns
            summary = "Native context checkpoint installed"
            meta.compactionMethod = "native"
            if (result.usage) {
              input.emit({ type: "usage", ...result.usage, provider: options.provider.idFor?.(active?.model) ?? options.provider.id, model: active?.model ?? options.provider.model })
            }
          } catch (error) {
            const fallback = error instanceof NativeCompactionError && config.on_native_error === "portable" && !["cancelled", "stale", "unsupported"].includes(error.kind) && error.status !== 401 && error.status !== 403
            if (!fallback) throw error
            input.emit({ type: "item.completed", itemId: nativeItemId, status: "error", text: "Native compaction failed" })
            nativeItemId = undefined
            Object.assign(meta, { fallbackReason: error.kind })
          }
        }
        const portable = portableHistory(messages)
        if (!summary) {
          // The retained tail supplies intent/evidence but remains verbatim after installation.
          const source = pruneToolOutputs(portableHistory(method === "incremental" && selected.head.length ? selected.head : messages), config.prune !== false).messages
          const priorSummary = !previous?.native && messages[0]?.role === "user" && messages[0].content.startsWith(SUMMARY_PREFIX) ? summaryBody(messages[0].content) : undefined
          const transcriptPath = await options.transcript?.({ sessionId: input.sessionId, generation: checkpoint.generation, markdown: redactSecrets(renderTranscript(portable, { sessionId: input.sessionId, generation: checkpoint.generation })).text }).catch(() => undefined)
          const context = [
            ...latestUserRequestContext(portable),
            ...languageContinuityContext(portable),
            ...imageAttachmentContext(portable),
            ...assistantPhaseContext(portable),
            ...preservedTailSnapshotContext(selected.tail),
            ...transcriptReferenceContext(transcriptPath),
            ...compactionTriggerContext({ reason, messages: portable }),
            ...todoContext(portable),
            ...recentOperationalContext(portable),
            ...subagentTaskContext(portable),
          ]
          let prompt = buildCompactionPrompt({ base: compactionPromptFor(cwd), hasPreviousSummary: priorSummary !== undefined, instructions: input.instructions, context })
          const summaryTokens = config.max_summary_tokens ?? DEFAULT_SUMMARY_TOKENS
          if (method === "incremental") prompt += `\n\nUpdate the previous accepted summary with newly uncovered turns. Preserve user intent, corrections, constraints, unfinished work, tool outcomes and transcript references. Keep the summary within ${summaryTokens} tokens.`
          if (hooks?.has("compact.prompt", cwd)) prompt = (await hooks.compactPrompt?.({ sessionId: input.sessionId, cwd, prompt })) ?? prompt
          const ceiling = limits.inputLimit ?? limits.contextWindow
          const rescue = (why: string) => localRescueSummary({ previousSummary: priorSummary, context, reason: why })
          const sharedPrompt = `${prompt}\n\n${SHARED_COMPACTION_NOTE}`
          if (!sharedOff && ceiling) {
            // The shared request is the last call's whole request and reply (the provider's own count when it gave one), whatever the history
            // gained since, and the prompt; a window that also holds the output needs room for the summary. Near the window it cannot be sent.
            const repeated = last!.contextTokens !== undefined ? last!.contextTokens + historyTokens(messages.slice(last!.sent + 1)) : requestEstimates(last!.system, [], sentHistory!, [...last!.tools, ...last!.hostedTools]).total
            if (repeated + estimateTokens(sharedPrompt.length) + (limits.inputLimit ? 0 : summaryTokens) > ceiling) sharedOff = "too-large"
          }
          if (input.idle && sharedOff) return { status: "ok" }
          /** One summary call: the last main call's request with the prompt appended (`share`), or the compaction's own (no tools, pruned history). */
          const summarize = (share: boolean, emit: (event: EngineEvent) => void, itemMeta: Record<string, string | number | boolean>) => compactionDeadline(input.signal, config.timeout_ms ?? DEFAULT_COMPACTION_TIMEOUT_MS, (signal) =>
            callModel({ ...input, signal, emit: (event) => { if (!signal.aborted) emit(event) } }, share ? sentHistory! : [...source, { role: "user", content: prompt }], "compaction", share ? last!.tools : [], "compaction", undefined, { meta: itemMeta, cacheMessages: messages, ...(method === "incremental" || config.max_summary_tokens ? { maxOutputTokens: summaryTokens } : {}), ...(share ? { share: { prompt: sharedPrompt, last: last! } } : {}) }))
          // A summary the model did not finish in time is written here from the evidence instead: a compaction the context needs never
          // ends with the window still over its limit. `card`: the request's own card, closed as an error first.
          const late = (error: unknown) => error instanceof NativeCompactionError && error.kind === "timeout" && !input.idle && !input.signal.aborted
          const rescueLate = (card: ItemId | undefined) => {
            if (card) input.emit({ type: "item.completed", itemId: card, status: "error", text: "The summary was not written within the time limit" })
            const text = rescue("the model did not finish the summary within the time limit")
            const itemId = input.newItemId()
            input.emit({ type: "item.started", itemId, kind: "compaction", meta: { ...meta, summaryFallback: "rescue" } })
            input.emit({ type: "item.completed", itemId, status: "ok", text: clip(text) })
            return text
          }
          if (!sharedOff) {
            // The tools are in the request only to keep the prefix. A reply that calls one, or that is no summary, is not installed: its card
            // closes as an error and the compaction's own request is sent once (a compaction while idle installs nothing instead).
            let card: ItemId | undefined
            let closed: Extract<EngineEvent, { type: "item.completed" }> | undefined
            const emit = (event: EngineEvent) => {
              if (event.type === "item.started" && event.kind === "compaction") card = event.itemId
              if (event.type === "item.completed" && event.itemId === card) closed = event
              else input.emit(event)
            }
            try {
              const reply = await summarize(true, emit, { ...meta, cachedPrefix: true })
              const accepted = reply.toolCalls.length ? { rejected: "tool-call" as const } : acceptSummary(reply.text)
              if (!("rejected" in accepted)) summary = accepted.text
              else if (input.idle) summary = accepted.rejected === "tool-call-cosplay" ? rescue("the summarizer printed tool calls instead of a summary") : ""
              else sharedOff = accepted.rejected
            } catch (error) {
              // A cancellation ends the compaction and the deadline is answered with the local summary; any other failure (the provider refused the larger request) leaves the smaller one to try.
              if (late(error)) summary = rescueLate(closed ? undefined : card)
              else if (input.idle || input.signal.aborted || error instanceof NativeCompactionError) throw error
              else sharedOff = "error"
            } finally {
              if (closed) input.emit(sharedOff && !input.signal.aborted ? { ...closed, status: "error", text: "The summary request was not answered with a summary" } : closed)
            }
            if (input.idle && !summary) return { status: "ok" }
          }
          const promptTokens = historyTokens(source) + estimateTokens(prompt.length)
          if (summary) {
            // The shared request wrote it.
          } else if (ceiling && promptTokens > ceiling) {
            // Sending an oversized request would only fail: write the summary locally from the evidence instead.
            summary = rescue(`the summarization prompt (about ${promptTokens} tokens) exceeds the model's ${ceiling}-token input window`)
            const itemId = input.newItemId()
            input.emit({ type: "item.started", itemId, kind: "compaction", meta: { ...meta, summaryFallback: "rescue" } })
            input.emit({ type: "item.completed", itemId, status: "ok", text: clip(summary) })
          } else {
            const reported = sharedOff === "no-call" || sharedOff === "native-strategy" || sharedOff === "other-model" ? undefined : sharedOff
            let card: ItemId | undefined
            const emit = (event: EngineEvent) => {
              if (event.type === "item.started" && event.kind === "compaction") card = event.itemId
              if (event.type === "item.completed" && event.itemId === card) card = undefined
              input.emit(event)
            }
            try {
              const reply = await summarize(false, emit, reported ? { ...meta, cachedPrefixOff: reported } : meta)
              const accepted = acceptSummary(reply.text)
              summary = "rejected" in accepted ? (accepted.rejected === "tool-call-cosplay" ? rescue("the summarizer printed tool calls instead of a summary") : "") : accepted.text
            } catch (error) {
              if (!late(error)) throw error
              summary = rescueLate(card)
            }
          }
        }
        if (input.signal.aborted || !summary) return { status: "ok" }
        if (fingerprint((await options.history.load(input.sessionId)) ?? []) !== original) throw new NativeCompactionError("stale", "History changed during compaction")
        const native = checkpoint.method === "native"
        const retained = portable.length - selected.tail.length
        const resumeImages = native ? [] : resumeImageRefs(portable.slice(0, Math.max(0, retained)), selected.tail)
        const content = native ? summary : [summary, engineAnchor({ messages: portable, tail: selected.tail }), RESUME_GUIDANCE].filter(Boolean).join("\n\n")
        checkpoint.tailMessages = selected.tail.length
        await options.history.replace(input.sessionId, [{ role: "user", content: `${SUMMARY_PREFIX}\n\n${content}`, compaction: checkpoint, ...(resumeImages.length ? { attachments: resumeImages } : {}) }, ...selected.tail])
        if (nativeItemId) input.emit({ type: "item.completed", itemId: nativeItemId, status: "ok", text: summary, meta })
      } catch (error) {
        if (nativeItemId) input.emit({ type: "item.completed", itemId: nativeItemId, status: input.signal.aborted ? "cancelled" : "error", text: input.signal.aborted ? "Compaction cancelled" : "Native compaction failed" })
        // Nobody asked for a compaction while idle: a failed one leaves the session as it was, not in an error state.
        if (input.signal.aborted || input.idle) return { status: "ok" }
        return { status: "error", code: "compaction_failed", message: `[ENGINE]: ${error instanceof Error ? error.message : String(error)}` }
      }
      contextTokens.delete(input.sessionId)
      prunedTokens.delete(input.sessionId)
      // The history is another one now: the request on record cannot be repeated on it, and a fork's inherited prefix is gone.
      lastMain.delete(input.sessionId)
      forkPrefixes.delete(input.sessionId)
      if (hooks?.has("compact.after", cwd)) await hooks.compactAfter?.({ sessionId: input.sessionId, cwd, summary, reason })
      const continueAfterCompact = hooks?.has("compact.continue", cwd) ? await hooks.compactContinue?.({ sessionId: input.sessionId, cwd }) : undefined
      return { status: "ok", compacted: true, ...(continueAfterCompact === false ? { continueAfterCompact: false } : {}) }
    },
  }
}
