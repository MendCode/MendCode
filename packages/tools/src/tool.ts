import type { z } from "zod"
import type { BackgroundPort } from "./background"
import type { InteractivePort } from "./interactive"
import type { MediaAttachment } from "./media"

/** Hard caps so one tool call can never bloat the event log or the model context (P11, FC-17). */
export const OUTPUT_LIMITS = { maxBytes: 50_000, maxLines: 2_000 } as const

export type ToolPermission = "read" | "write" | "execute"

/** A choice offered with a question; the user can still type their own answer. */
export type QuestionOption = { label: string; description?: string }
export type QuestionPrompt = { title: string; detail: string; options?: QuestionOption[]; multiple?: boolean; questions?: import("@mendcode/protocol").QuestionInfo[] }

export type ToolContext = {
  /** Decrypted application-owned files, without ever writing a plaintext temporary copy. */
  readStoredFile?: ((file: string) => Uint8Array | undefined) | undefined
  /** Absolute project root; relative paths resolve against it. */
  cwd: string
  /** Frozen by the engine before permission review; never persisted or sent to clients. */
  environment?: Readonly<NodeJS.ProcessEnv>
  shell?: string | undefined
  /** The user typed this call themselves (`!command`): it is theirs, so the agent-origin guard does not apply to it. */
  userInitiated?: boolean | undefined
  /** Settings `shellCommandPrefix` and `loginShell`: how the shell of the model's commands starts. */
  shellPolicy?: import("./shell-policy").ShellPolicy | undefined
  /** Domain rules for `webfetch` and `websearch` (settings `web`); absent means no rules. */
  web?: import("./web-policy").WebPolicy | undefined
  /** OS sandbox the agent's commands run under (`shell`, background tasks, `shell_session`); absent runs them unconfined. */
  sandbox?: import("./sandbox").SandboxPolicy | undefined
  outputLimits?: { maxBytes: number; maxLines: number }
  /** Aborted on turn cancel; long operations must stop promptly (I6). */
  signal: AbortSignal
  /** Instruction files already loaded in this conversation (read attaches nearby project policy once). */
  loadedInstructions?: Set<string>
  /** The instruction settings the system prompt uses (fallback names, root markers, includes), so `read` loads nearby files by the same rules. */
  instructions?: import("./instructions").InstructionOptions | undefined
  /** Live output for long-running tools (shell); the final result is still returned. */
  onOutput?(chunk: string): void
  /** Asks the user a question (free text, or options plus free text); resolves to the answer, or a refusal with its reason. */
  ask?(question: QuestionPrompt): Promise<{ answered: true; text: string; answers?: string[][] } | { answered: false; reason: string }>
  /** The session's background commands (`shell` with background, `shell_output`, `shell_kill`); absent where none can run. */
  taskStatus?(input: { task_id?: string | undefined; action?: "list" | "get" | "wait" | "cancel" | undefined; timeout_ms?: number | undefined }): Promise<string>
  background?: BackgroundPort
  /** The session's interactive processes on a pseudo-terminal (`shell_session`); absent where none can run. Never reachable from remote clients. */
  interactive?: InteractivePort
  /** Workflows of this session's daemon (`workflow_start`, `workflow_status`); absent where the host has none. */
  workflows?: WorkflowPort
  /** Other sessions of the same project (`sessions`, `tell`); absent where the host has none. */
  peers?: PeerPort
  /** Read, search, message, wait on and interrupt the project's other sessions (`threads`); absent where the host has none. */
  threads?: ThreadPort
  packages?: PackagePort
  sessionMeta?(input: import("@mendcode/protocol").SessionMetaInput): Promise<unknown>
  /** This project's loops (`loop`); absent where the host has none. */
  loops?: LoopPort
  /** This session's git worktree (`worktree`); absent where the host has none. */
  worktrees?: WorktreePort
  /** This session's pull request watches (`pr_watch`); absent where the host has none. */
  prWatch?: PrWatchPort
  /** Shared Changes selection and comments, owned by the daemon. */
  review?: ReviewPort
  recall?: SessionRecallPort
  aiConfig?: AIConfigPort
  /** Session-owned recent image bytes, resolved only when an edit explicitly requests them. */
  recentImages?(count: number): Promise<Array<{ mime: string; bytes: Uint8Array }>>
  computer?: import("./tools/computer").ComputerPort
  /** This chat session's private headless browser (`browser`); absent unless the daemon opted in. Never reachable from remote clients. */
  browser?: import("./browser").BrowserPort
  /** Daemon-owned PDF extraction and scratch clones. Absent for restricted/remote turns. */
  webfetchResources?: WebfetchResources
}

export type WebfetchResources = {
  pdf(bytes: Uint8Array, signal: AbortSignal, sandbox?: import("./sandbox").SandboxPolicy): Promise<string>
  clone(repository: string, signal: AbortSignal, sandbox?: import("./sandbox").SandboxPolicy): Promise<string>
}

export type SessionRecallPort = {
  search(input: import("@mendcode/protocol").SessionRecallSearchInput): import("@mendcode/protocol").SessionRecallPage
  read(input: import("@mendcode/protocol").SessionRecallReadInput): import("@mendcode/protocol").SessionRecallPage | import("@mendcode/protocol").SessionRecallMessage
  notes(input: import("@mendcode/protocol").SessionNotesInput): import("@mendcode/protocol").SessionNotesReport
  /** `auto_recall`: the earlier turns of this session that the latest compaction packed away and that best match `query`, newest context first. */
  relevant?(input: { query: string; limit: number; maxChars: number }): RecalledTurn[]
}

/** One packed-away turn, verbatim but bounded: the user's request and the assistant's answer, with when it happened. */
export type RecalledTurn = { turn: number; at: number; user: string; assistant: string; score: number }

/** What the `loop` tool asks for when it creates a loop; the host parses the trigger text and fills the rest from the template. */
export type LoopCreateInput = {
  name: string
  objective?: string | undefined
  template?: string | undefined
  /** "every 30m", "daily 09:00 Europe/Madrid", "adaptive 30m", "external" or "manual". */
  trigger?: string | undefined
  mode?: "goal" | "monitor" | "fixed" | undefined
  maxRuns?: number | undefined
  criteria?: string | undefined
  checks?: string[] | undefined
  /** Defaults to true for loops the agent creates: a run reports and never edits. */
  reportOnly?: boolean | undefined
  workspace?: "in-place" | "worktree" | undefined
  runNow?: boolean | undefined
  costBudget?: import("@mendcode/protocol").LoopCostBudget | undefined
  rubric?: import("@mendcode/protocol").LoopRubric | undefined
  approvalPolicy?: import("@mendcode/protocol").LoopApprovalPolicy | undefined
}

/**
 * What the loop tool may do for the session's project: create a loop (after approval), list the project's loops and pause
 * one. It cannot resume, stop, delete or accept: those stay with the user.
 */
export type LoopPort = {
  /** Problems (empty when the loop can be created) and, when valid, the approval text: schedule, budget, what a run may do. */
  preview(input: LoopCreateInput): Promise<{ problems: string[]; detail?: string }>
  create(input: LoopCreateInput): Promise<{ ok: true; loopId: string; text: string } | { ok: false; message: string }>
  /** A bounded listing of the project's loops. */
  list(): string
  pause(loopId: string): { ok: true; text: string } | { ok: false; message: string }
}

/** What a worktree move did: where the session works now and what to tell the model. */
export type WorktreeMove = { ok: true; text: string; directory: string } | { ok: false; message: string }

/**
 * What the `worktree` tool may do for its own session: create a git worktree under the daemon's data directory (never
 * inside the checkout) and move the session into it, or move it back to the project's checkout, optionally removing the
 * worktree. Only the session's own working directory changes; the user's checkout is never edited.
 */
export type WorktreePort = {
  /** Where the session works: the checkout, or the worktree it entered. */
  status(): string
  /** Problems (empty when the move can run) and, when valid, the approval text. */
  preview(input: { action: "enter" | "exit" | "handoff" | "close"; name?: string | undefined; branch?: string | undefined; base?: string | undefined; target?: string | undefined; remove?: boolean | undefined }): Promise<{ problems: string[]; detail?: string }>
  /** `branch` is the branch the model names (under the `worktreeBranch` setting's rules); `base` a ref to start from (a stacked change). */
  enter(input: { name?: string | undefined; branch?: string | undefined; base?: string | undefined }): Promise<WorktreeMove>
  exit(input: { remove?: boolean | undefined }): Promise<WorktreeMove>
  /** The project's worktrees (the daemon's workspaces) and which one this session is in; bounded text. */
  list?(): Promise<string>
  /** Moves the session into an existing worktree of the project (by name, branch, id or directory) instead of creating one. */
  handoff?(input: { target: string }): Promise<WorktreeMove>
  /** Removes a worktree when it is clean and merged and no session works in it; the session's own worktree is left first. */
  close?(input: { target?: string | undefined }): Promise<{ ok: true; text: string; directory?: string | undefined } | { ok: false; message: string }>
}

/**
 * What the `pr_watch` tool may do for its own session (docs/pr-watch.md): link a pull request to the session so the daemon
 * polls it through `gh` and wakes the session only on a change. Nothing here reads local files or runs a model.
 */
export type PrWatchPort = {
  /** Problems (empty when the watch can start) and, when valid, the approval text. */
  preview(input: { pr?: string | undefined }): Promise<{ problems: string[]; detail?: string }>
  watch(input: { pr?: string | undefined }): Promise<{ ok: true; text: string } | { ok: false; message: string }>
  unwatch(input: { pr?: string | undefined }): { ok: true; text: string } | { ok: false; message: string }
  list(): string
}

/** One other session of the same project, as `sessions` shows it: never its transcript. */
export type PeerSession = { sessionId: string; title: string; state: string; updatedAt: number }

/**
 * What the peer tools may do: list the project's other sessions and queue a plain-text message for one. The message
 * waits for the target's next free moment; the target's final answer comes back to this session as a notice.
 */
export type PeerPort = {
  list(limit?: number): PeerSession[]
  /** `mode`: auto and queue never interrupt; steer joins the target's running turn after its next tool result (queued where the engine cannot). `clientRequestId` makes a retry return the first answer. */
  tell(target: string, text: string, options?: { mode?: "auto" | "queue" | "steer"; clientRequestId?: string }): Promise<{ ok: true; waiting: boolean } | { ok: false; message: string }>
  /** A session's figures as text (this one for `self`): time per turn, day and hour, usage per model, tools, sub-agents, approval waits. Same project only. */
  stats?(target: string): { ok: true; output: string } | { ok: false; message: string }
}

export type ThreadResult = { ok: true; output: string } | { ok: false; message: string }

/**
 * What the `threads` tool may do with the project's other local sessions. Every method returns bounded, redacted text.
 * `granted` is true for a session the user named with `@thread` in this session: reading it needs no approval.
 */
export type ThreadPort = {
  granted(target: string): boolean
  /** True for a sub-agent session this session started (or one of theirs): reading its results needs no approval. */
  ownTask?(target: string): boolean
  list(limit?: number): ThreadResult
  read(input: { sessionId: string; limit?: number | undefined; before?: string | undefined }): ThreadResult | Promise<ThreadResult>
  search(input: { sessionId: string; query: string; limit?: number | undefined; before?: string | undefined }): ThreadResult | Promise<ThreadResult>
  message(input: { sessionId: string; text: string }): Promise<ThreadResult>
  wait(input: { sessionId: string; timeoutSeconds?: number | undefined; signal?: AbortSignal | undefined }): Promise<ThreadResult>
  interrupt(input: { sessionId: string }): Promise<ThreadResult>
  /** Brings what a fork of this session did since it branched into this session, as context for its next turn. Only a fork of this very session. */
  mergeBack(input: { sessionId: string }): ThreadResult
  /** Figures of a session (this one without an id): time per turn, day and hour, usage per model, tools, sub-agents, approvals. No message text. */
  stats(input: { sessionId?: string | undefined }): ThreadResult
}

/** Workflow actions stay scoped to this session's project and use normal tool approval. */
export type WorkflowPort = {
  /** Problems (empty when the plan can start) and, when valid, the approval text: tasks, every check command, applied permission. */
  preview(plan: unknown): Promise<{ problems: string[]; detail?: string }>
  start(plan: unknown): Promise<{ ok: true; workflowId: string; name: string; tasks: number } | { ok: false; message: string }>
  /** A bounded receipt of one run, or of this project's recent runs. */
  status(workflowId?: string): Promise<string>
  previewControl?(workflowId: string): Promise<string>
  /** A bounded, redacted page of one run's event or artifact ledger (same project only); `before` pages backwards. */
  ledger?(workflowId: string, kind: "events" | "artifacts", query?: { before?: number | undefined; limit?: number | undefined }): Promise<string>
  save?(plan: unknown, extra?: { definitionId?: string | undefined; name?: string | undefined; description?: string | undefined; source?: import("@mendcode/protocol").WorkflowDefinition["source"] | undefined }): Promise<{ ok: true; receipt: import("@mendcode/protocol").WorkflowRevisionReceipt } | { ok: false; message: string }>
  control?(workflowId: string, action: "pause" | "resume" | "stop" | "retry" | "delete", extra?: { taskId?: string | undefined; reason?: string | undefined }): Promise<{ ok: true; output: string } | { ok: false; message: string }>
}

export type ToolResult = {
  /** Text the model sees. Already truncated to OUTPUT_LIMITS; `truncated` says so. */
  output: string
  truncated: boolean
  /** Short human title for the collapsed tool card, e.g. "Read src/a.ts" or "ls -la". */
  title: string
  isError: boolean
  /**
   * Images the model should see (a screenshot…): at most 2 per result, each at most 5 MB (downscale first). The engine
   * stores the bytes as blobs and shows them to the model in a following user message; `output` stays the text answer.
   */
  images?: Array<{ mime: "image/png" | "image/jpeg"; bytes: Uint8Array }>
  /** Inline read results (images or PDF). The engine persists blob refs, never these bytes in history. */
  attachments?: MediaAttachment[]
  loadedInstructions?: string[]
  /** What the tool card shows when it differs from `output` (apply_patch's diff); the model never sees it. */
  display?: string
  /** Structured facts for renderers (paths touched, exit code, match count…). */
  meta?: Record<string, string | number | boolean>
  /** A renderSpec@1 tree for how clients draw this result (validated by the engine; dropped when invalid). */
  render?: unknown
  /** Native host's reserved tool_search receipt; retained history activates these schemas, never permissions. */
  discoveredTools?: string[]
}

/**
 * One tool = one module exporting this shape (modular by default: adding a tool is adding a file).
 * `permission` lets the engine ask for approval before `execute` runs; tools never prompt themselves.
 */
export type PackageRequest = {
  action: "list" | "info" | "search" | "install" | "enable" | "disable" | "switch-look" | "remove" | "new" | "check"
  name?: string | undefined
  key?: string | undefined
  sourceId?: string | undefined
  scope?: "user" | "project" | undefined
  query?: string | undefined
  replace?: boolean | undefined
}

export type PackagePort = {
  preview(input: PackageRequest): Promise<string>
  run(input: PackageRequest): Promise<Record<string, unknown>>
}

export interface Tool<Args extends z.ZodType = z.ZodType> {
  name: string
  description: string
  permission: ToolPermission
  /** After argument validation, a mixed read/write tool may narrow its permission for this call. */
  permissionFor?(args: z.infer<Args>, context?: { threads?: ThreadPort | undefined }): ToolPermission
  /** Requires the user's approval for this exact call, regardless of mode, allow rules or saved grants. */
  individualApprovalFor?(args: z.infer<Args>, context?: { threads?: ThreadPort | undefined }): boolean
  /** `always`, or `approvalFor` per call: the call asks, showing `preview`, in every permission mode and whatever the allow rules or saved grants say. */
  approval?: "always"
  approvalFor?(args: z.infer<Args>): boolean
  /** The lowest tier that offers this tool to the model (docs/tiers.md); absent means every tier. Ignored while no `tier` is set. */
  tier?: import("@mendcode/protocol/wire").Tier
  args: Args
  execute(args: z.infer<Args>, context: ToolContext): Promise<ToolResult>
  /**
   * Optional read-only preview of what `execute` would change, shown to the user inside the approval
   * request (unified-diff style text, bounded to about 200 lines / 16 KB). It must never write, never
   * throw, and return `undefined` when it cannot say (invalid args, missing file…): the normal error
   * path of `execute` then reports the problem after approval.
   */
  preview?(args: z.infer<Args>, context: ToolContext): Promise<string | undefined>
}

export function defineTool<Args extends z.ZodType>(tool: Tool<Args>): Tool<Args> {
  return tool
}

export type ReviewPort = { run(input: Record<string, unknown>): Promise<{ output: string; meta: Record<string, string | number | boolean> }> }

export type AIConfigToolInput = Exclude<import("@mendcode/protocol").AIConfigInput, { action: "apply" }> | Omit<Extract<import("@mendcode/protocol").AIConfigInput, { action: "apply" }>, "sessionId" | "confirm">
export type AIConfigPort = { run(input: AIConfigToolInput): import("@mendcode/protocol").AIConfigReport | Promise<import("@mendcode/protocol").AIConfigReport> }
