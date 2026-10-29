import type { BlobRef, PermissionMode, ReasoningEffort, SessionId, TurnId } from "@mendcode/protocol"
import { layoutAttachments } from "@mendcode/protocol/wire"
import { createHash, randomUUID } from "node:crypto"
import { environmentKey, processMcpTurn, realClock, type Clock, type EngineEnvironment, type EngineEvent, type EnginePort, type EngineResolution, type TimerHandle, type TurnInput, type TurnOutcome } from "@mendcode/kernel"
import {
  claudeArgs,
  claudePermissionMode,
  claudeQuota,
  claudeToolPermission,
  claudeToolTitle,
  controlRequest,
  controlResponse,
  changesMcpServers,
  createTurnMapper,
  MCP_RELOAD_NOTE,
  MAX_TEXT,
  resultOutcome,
  userMessage,
  type ClaudeMessage,
  type ClaudePermissionMode,
  type QuotaDraft,
} from "./protocol"
import { spawnClaude, type ClaudeTransport } from "./transport"

/** A session's `claude` process is stopped after this long without a turn; the next turn resumes it. */
export const DEFAULT_PROCESS_IDLE_MS = 10 * 60_000
/** Records of a turn Claude Code runs on its own that are kept until its notice is shown; a runaway one is cut there. */
const MAX_UNSOLICITED = 2_000
const CONTROL_TIMEOUT_MS = 30_000
/** Esc gives Claude Code this long to stop a turn on its own; then the turn ends here and what it still sends is dropped. */
export const CANCEL_GRACE_MS = 3_000
/** The longest the rest of a cancelled turn is waited for; a `result` that never came stops being waited for here. */
const DRAIN_LIMIT_MS = 60_000

/** `fast`: Claude Code's fast mode (`/fast` on a model that has it), fixed when the process starts like the effort. */
export type ClaudeModelChoice = { model?: string | undefined; effort?: ReasoningEffort | undefined; fast?: boolean | undefined }

type ActiveTurn = {
  input: TurnInput
  mapper: ReturnType<typeof createTurnMapper>
  waitingUser: boolean
  interrupted: boolean
  /** Messages the user sent while the turn ran, written to Claude Code and not yet taken in (`command_lifecycle` `started`). */
  steered: Set<string>
  /** A `taken` loop is running, so a second tool result does not start another. */
  steering?: boolean
  /** The turn's `result` came while a steered message still waited: Claude Code answers it next, in the same MendCode turn. */
  held?: TurnOutcome
  watchdog?: TimerHandle
  touch(): void
  finish(outcome: TurnOutcome): void
}

/** Ended turns per process whose background agents are still followed. */
const MAX_AGENT_TURNS = 8
/** The id of the `SubagentStart` hook MendCode registers at `initialize` (`subagentContext`). */
const SUBAGENT_HOOK = "mendcode-subagent-start"
/** The id of the `PostToolUse` hook MendCode registers at `initialize` (`oneTree`). */
const ONE_TREE_HOOK = "mendcode-one-tree"
/** The Claude Code tools One tree hears about: the shell, whose output names files, and the ones that write a file. */
const ONE_TREE_TOOLS = "Bash|Edit|Write|MultiEdit|NotebookEdit"

/** What a `PostToolUse` call wrote and printed, from Claude Code's hook input. */
export function oneTreeCall(input: unknown): { written: string[]; output: string; cwd?: string; agent?: string } {
  const hook = (input ?? {}) as { tool_name?: unknown; tool_input?: Record<string, unknown>; tool_response?: unknown; cwd?: unknown; agent_id?: unknown }
  const args = hook.tool_input ?? {}
  const file = typeof args.file_path === "string" ? args.file_path : typeof args.notebook_path === "string" ? args.notebook_path : undefined
  const written = hook.tool_name !== "Bash" && file ? [file] : []
  const response = hook.tool_response as { stdout?: unknown; stderr?: unknown } | string | undefined
  const output = typeof response === "string" ? response : hook.tool_name === "Bash" ? [response?.stdout, response?.stderr].filter((part) => typeof part === "string").join("\n") : ""
  // A call one of Claude Code's own sub-agents made carries its `agent_id`: each sub-agent is a writer of its own.
  return { written, output, ...(typeof hook.cwd === "string" ? { cwd: hook.cwd } : {}), ...(typeof hook.agent_id === "string" && hook.agent_id ? { agent: hook.agent_id.slice(0, 80) } : {}) }
}

type Connection = {
  sessionId: SessionId
  transport: ClaudeTransport
  model: ClaudeModelChoice
  permission: ClaudePermissionMode
  pending: Map<string, { resolve(value: any): void; reject(error: Error): void }>
  ready: Promise<void>
  turn?: ActiveTurn
  /** The turn changed Claude Code's MCP servers: the process ends with the turn (or once its background tasks end), and the next one starts with them. */
  reload?: boolean
  idle?: TimerHandle
  closed: boolean
  /** Background tasks Claude Code reports running (`background_tasks_changed`): while any runs, the process is kept. */
  background: number
  /** A turn ended here before Claude Code finished stopping it (`CANCEL_GRACE_MS`): its last records are dropped up to its `result`. */
  draining?: boolean
  /**
   * A turn Claude Code started on its own after a background task ended, with no MendCode turn open: its records wait here until the
   * notice the daemon was given for it becomes a turn, which then shows them instead of sending anything.
   */
  unsolicited?: { notice: string; records: ClaudeMessage[] }
  /**
   * A "send now" message handed to `turn`. Claude Code may stop that turn and answer the message as its next one, or take the message
   * into the turn and answer it there; either way it reports the message `started` (`command_lifecycle`), and from then on the records
   * belong to the message's own turn, so a turn still open at that point ends there.
   */
  handoff?: { uuid: string; turn: ActiveTurn }
  /** Claude Code reports what becomes of each message (`command_lifecycle`): only then is a message steered into a running turn. */
  lifecycle?: boolean
  /** `environmentKey` of the credentials the process started with. */
  envKey: string
  /** Ended turns whose background agents still run: their records go on to that turn's mapper, and from it to the daemon. */
  agentTurns: Array<ReturnType<typeof createTurnMapper>>
}

/** The uuid a turn's message carries into Claude Code, the same for the same turn in every process: an undo names it to `rewind_conversation`. */
export function messageUuid(turnId: string): string {
  const hex = createHash("sha256").update(turnId).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function sameModel(a: ClaudeModelChoice, b: ClaudeModelChoice) {
  return (a.model ?? "") === (b.model ?? "") && (a.effort ?? "") === (b.effort ?? "") && !a.fast === !b.fast
}

const ENGINE_FLAGGED_REASON = "Claude Code asks about this call even though the session is in full access."

function toolDetail(name: string, args: Record<string, any>, reason: unknown) {
  const body = name === "Bash" ? String(args.command ?? "") : name === "Write" ? `${String(args.file_path ?? "")}\n\n${String(args.content ?? "")}` : name === "Edit" ? `${String(args.file_path ?? "")}\n\n- ${String(args.old_string ?? "")}\n+ ${String(args.new_string ?? "")}` : JSON.stringify(args, null, 2)
  const why = typeof reason === "string" && reason ? `${reason.replace(/\x1b\[[0-9;]*m/g, "")}\n\n` : ""
  return `${why}${body}`.slice(0, MAX_TEXT)
}

/**
 * Engine backed by the user's own Claude Code (`claude`), driven through the stream-json protocol of the official
 * Agent SDK. Claude Code runs its own agent loop, tools, CLAUDE.md, skills and MCP with its own login; MendCode shows
 * the turn, answers tool permissions, questions and plan approval, and reads the subscription's rate limits.
 * No credentials are read or copied. One process per session stays up between turns and is resumed after a stop.
 */
export function createClaudeEngine(options: {
  bin?: string
  clock?: Clock
  /** Silence after which a turn is interrupted. Unset (the default) never cuts one: Claude Code times out and retries its own API
   *  calls, and a long think over images can be quiet for minutes, so the turn runs as long as it would in Claude Code itself. */
  idleMs?: number
  processIdleMs?: number
  /** Daemon-owned per-process flags, never saved to the user's configuration. */
  processArgs?: string[]
  waitingForMcp?: (() => boolean) | undefined
  cwdFor(sessionId: SessionId): string
  /** Flags for one session's process, the same every time it starts (the daemon's own MCP bridge). */
  sessionArgs?(sessionId: SessionId): string[]
  /**
   * The prefix of the tools the daemon serves this process itself. The daemon asks for their approval and draws their cards
   * when it runs them, so here they are allowed without a second question and get no second card.
   */
  ownTools?: string
  /** Text added after Claude Code's own system prompt for a project directory: what MendCode draws that Claude Code's terminal does not. */
  appendSystem?(cwd: string): string | undefined
  /**
   * What each of Claude Code's own sub-agents is told when it starts (its `SubagentStart` hook): they get a system prompt of
   * their own, without the main one's, so MendCode's tools (the code graph first) would otherwise go unused by them.
   */
  subagentContext?(sessionId: SessionId): Promise<string | undefined>
  /** One tree (docs/one-tree.md): told what each Bash or write call wrote and printed; a line it returns reaches the model as that call's context. */
  oneTree?(input: { sessionId: SessionId; cwd: string; written: string[]; output: string }): string | undefined
  /** The session's model, or the turn's own when `override` is given (a per-turn selection; the saved choice is untouched). */
  modelFor(sessionId: SessionId, override?: import("@mendcode/protocol").ModelChoice): ClaudeModelChoice
  /** Persistent session → Claude Code session id, so a restart resumes the conversation. */
  bindings?: { get(sessionId: SessionId): string | undefined; set(sessionId: SessionId, claudeSessionId: string): void }
  onQuota?(snapshot: QuotaDraft): void
  /** Read at each request: `false` lets a call Claude Code flags in `full` access through unattended (the `engineSafetyPrompts` setting). Unset asks. */
  safetyPrompts?(): boolean | undefined
  readBlob?(ref: BlobRef): Promise<Uint8Array>
  /** Variables added to the environment of each Claude Code process, read when one is started for a session on `model` (`claudeCacheEnv`, the sub-agent model). */
  env?(sessionId: SessionId, model: ClaudeModelChoice): Record<string, string> | undefined
  /** The session's `/env` credentials: in the process environment, and their names in the appended system prompt. */
  environment?(sessionId: SessionId): EngineEnvironment | undefined
  transportFactory?(input: { args: string[]; cwd: string; env?: Record<string, string> }): ClaudeTransport
  trace?: (direction: "in" | "out", line: string) => void
  /** Queue a notice in a session (a background task ended). Without it, what Claude Code does on its own between turns is not shown. */
  notify?(sessionId: SessionId, text: string): void
  /** The background tasks Claude Code has running for a session, each time that list changes. */
  /** Claude Code's background tasks changed; `stop` asks it to stop one of them (its `stop_task` control request). */
  onBackground?(sessionId: SessionId, tasks: Array<{ id: string; description: string; kind: string }>, stop: (taskId: string) => Promise<void>): void
  /** A session's Claude Code process ended, why, and how many background tasks it still had running (they end with it). */
  onClose?(sessionId: SessionId, reason: string, background: number): void
  /** What a background agent does after the turn that started it ended: items under that turn (the agent's thread). */
  onAgentEvent?(sessionId: SessionId, turnId: TurnId, event: EngineEvent): void
}): EnginePort & { stop(reason?: string): void; busy(): boolean } {
  const clock = options.clock ?? realClock
  const idleMs = options.idleMs
  const processIdleMs = options.processIdleMs ?? DEFAULT_PROCESS_IDLE_MS
  const connections = new Map<SessionId, Connection>()
  const isolatedEngines = new Set<ReturnType<typeof createClaudeEngine>>()
  /**
   * A bridged turn's own process (`externalMcp`) that still runs background agents when its turn ended, by session. It is kept, so
   * they finish instead of ending with the turn; the session's next turns run in it until none is left, then it stops.
   */
  const kept = new Map<SessionId, ReturnType<typeof createClaudeEngine>>()
  const inTurn = new Set<ReturnType<typeof createClaudeEngine>>()
  const settle = (sessionId: SessionId, isolated: ReturnType<typeof createClaudeEngine>) => {
    if (inTurn.has(isolated)) return
    if (isolated.busy()) { kept.set(sessionId, isolated); return }
    if (kept.get(sessionId) === isolated) kept.delete(sessionId)
    isolated.stop("its bridged turn ended")
    isolatedEngines.delete(isolated)
  }
  /** Undos waiting for the session's next process: the uuid of the message its conversation is cut before. */
  const pendingRewinds = new Map<SessionId, string>()
  /** The permission mode of each session's last turn, for a `/compact` that has to start the process again. */
  const modes = new Map<SessionId, PermissionMode>()
  /** A `/compact` sent to Claude Code, by its turn: what Claude Code reported of it (`compact_boundary`, then the summary it continues from). */
  const compactions = new Map<TurnId, { preTokens?: number; postTokens?: number; summary?: string; done?: true }>()
  let nextRequest = 1
  /** Whether processes are asked for the text of the model's thinking (`--thinking-display`); off once a `claude` that does not know the flag exited at start. */
  let thinkingDisplay = true
  /** A process started with the flag has answered, so a later exit is never put down to it. */
  let thinkingDisplayAccepted = false

  function write(connection: Connection, line: string) {
    options.trace?.("out", line)
    connection.transport.write(line)
  }

  function control(connection: Connection, request: Record<string, unknown>): Promise<any> {
    const requestId = `mend-${nextRequest++}`
    return new Promise((resolve, reject) => {
      const timer = clock.setTimer(CONTROL_TIMEOUT_MS, () => {
        connection.pending.delete(requestId)
        reject(new Error(`[CLAUDE]: no answer to ${String(request.subtype)}`))
      })
      connection.pending.set(requestId, {
        resolve: (value) => (timer.cancel(), resolve(value)),
        reject: (error) => (timer.cancel(), reject(error)),
      })
      write(connection, controlRequest(requestId, request))
    })
  }

  /**
   * Ends a session's process. Its background tasks end with it, so their list is emptied: a row for an agent that no longer runs is
   * never left behind. Why it ended is said (`onClose`), so a lost background agent can be traced to what stopped it.
   */
  function close(connection: Connection, reason: string) {
    if (connection.closed) return
    connection.closed = true
    connection.idle?.cancel()
    if (connections.get(connection.sessionId) === connection) connections.delete(connection.sessionId)
    connection.transport.close()
    const background = connection.background
    connection.background = 0
    options.onClose?.(connection.sessionId, reason, background)
    if (background) options.onBackground?.(connection.sessionId, [], async () => { throw new Error("[CLAUDE]: the Claude Code process has ended") })
  }

  async function answerPermission(connection: Connection, message: ClaudeMessage) {
    const request = message.request ?? {}
    const name = String(request.tool_name ?? "tool")
    const args: Record<string, any> = request.input && typeof request.input === "object" ? request.input : {}
    const turn = connection.turn
    const allow = (updatedInput: Record<string, unknown> = args, extra: Record<string, unknown> = {}) => ({ behavior: "allow", updatedInput, ...extra })
    const deny = (reason: string) => ({ behavior: "deny", message: reason })
    const decide = async (): Promise<Record<string, unknown>> => {
      if (!turn) return deny("No MendCode turn is running.")
      const ask = async (request: Parameters<TurnInput["ask"]>[0]): Promise<EngineResolution> => {
        turn.waitingUser = true
        turn.watchdog?.cancel()
        try {
          return await turn.input.ask(request)
        } finally {
          turn.waitingUser = false
          turn.touch()
        }
      }
      if (name === "AskUserQuestion") {
        // A batch holds at most 32 questions (the protocol's limit); Claude Code asks four at most.
        const questions: any[] = Array.isArray(args.questions) ? args.questions.filter((entry: unknown) => entry && typeof entry === "object").slice(0, 32) : []
        if (!questions.length) return deny("The question was empty.")
        const options = (question: any) => (Array.isArray(question.options) ? question.options : []).slice(0, 9).map((option: any) => ({ label: String(option?.label ?? "").slice(0, 120) || "(empty)", ...(option?.description ? { description: String(option.description).slice(0, 300) } : {}) }))
        // One question keeps the plain single form every client knows; several go as one batch, answered together (Claude asks up to four).
        const answer = questions.length === 1
          ? await ask({ kind: "question", title: String(questions[0].header ?? "Question").slice(0, 80), detail: String(questions[0].question ?? ""), options: options(questions[0]), multiple: questions[0].multiSelect === true })
          : await ask({ kind: "question", title: `Asked ${questions.length} questions`, detail: "", questions: questions.map((question) => ({ header: String(question.header ?? "Question").slice(0, 30) || "Question", question: String(question.question ?? "").slice(0, 500) || "Question", options: options(question), ...(question.multiSelect === true ? { multiple: true } : {}) })) })
        if (answer.kind !== "answer") return deny("The user did not answer.")
        // Claude Code reads one string per question text; a multiple choice is its labels joined with ", ". Unanswered questions are left out.
        if (questions.length === 1) return allow({ ...args, answers: { [String(questions[0].question)]: answer.text } })
        const answers = Object.fromEntries(questions.flatMap((question, index) => {
          const text = (answer.answers?.[index] ?? []).join(", ")
          return text ? [[String(question.question), text]] : []
        }))
        return allow({ ...args, answers })
      }
      if (name === "ExitPlanMode") {
        const answer = await ask({ kind: "approval", title: "Plan ready", detail: String(args.plan ?? "").slice(0, MAX_TEXT), tool: name, permission: "write" })
        if (answer.kind !== "approve") return deny(answer.kind === "deny" && answer.reason ? `The user wants changes to the plan: ${answer.reason}` : "The user did not approve the plan.")
        turn.input.setPermissionMode("ask")
        connection.permission = "default"
        return allow()
      }
      if (options.ownTools && name.startsWith(options.ownTools)) return allow()
      const mode: PermissionMode = turn.input.permissionMode()
      const permission = claudeToolPermission(name)
      // Claude Code in bypass mode sends no request for ordinary tools: one that arrives is its own safety check (a dangerous `rm`, a protected path).
      // Full access is the user's choice to run unattended, so it is allowed; `engineSafetyPrompts: true` shows it as an approval instead.
      const flagged = mode === "full" && connection.permission === "bypassPermissions" && options.safetyPrompts?.() === true
      if (!flagged && (mode === "full" || (mode === "edits" && permission === "write"))) return allow()
      if (mode === "plan" && permission !== "read") return deny("Plan mode: only reading is allowed until the plan is approved.")
      // `description` is Claude's short label (often just the file name); only `decision_reason` says why it asks.
      const reason = flagged && !(typeof request.decision_reason === "string" && request.decision_reason.trim()) ? ENGINE_FLAGGED_REASON : request.decision_reason
      const answer = await ask({ kind: "approval", title: String(request.title ?? claudeToolTitle(name, args)).slice(0, 200), detail: toolDetail(name, args, reason), tool: name, permission, ...(flagged ? { engineFlagged: true as const } : {}) })
      if (answer.kind === "approve") {
        // Only one call: the rules Claude suggests for "always" never apply to a call its own safety check flagged.
        if (flagged) return allow()
        // Mode suggestions (setMode acceptEdits) would move Claude away from MendCode's mode, so only rules are kept.
        const suggestions = Array.isArray(request.permission_suggestions) ? request.permission_suggestions.filter((rule: any) => rule?.type === "addRules") : []
        // "Always" in MendCode means this session: Claude's suggested rules are kept in memory, never written to settings.
        return answer.scope === "session" && suggestions.length ? allow(args, { updatedPermissions: suggestions.map((rule: any) => ({ ...rule, destination: "session" })) }) : allow()
      }
      return deny(answer.kind === "deny" && answer.reason ? answer.reason : "The user denied this.")
    }
    const response = await decide().catch((error: Error) => deny(error.message))
    if (!connection.closed) write(connection, controlResponse(String(message.request_id), response))
  }

  /** A hook registered at `initialize`; every callback is answered, an empty one when there is nothing to add, so Claude Code never waits. */
  async function answerHook(connection: Connection, message: ClaudeMessage) {
    if (message.request?.callback_id === ONE_TREE_HOOK) {
      let line: string | undefined
      try {
        const call = oneTreeCall(message.request?.input)
        line = options.oneTree?.({ sessionId: call.agent ? `${connection.sessionId}#${call.agent}` as SessionId : connection.sessionId, cwd: call.cwd ?? options.cwdFor(connection.sessionId), written: call.written, output: call.output })
      } catch { line = undefined }
      if (!connection.closed) write(connection, controlResponse(String(message.request_id), line ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: line } } : {}))
      return
    }
    const context = message.request?.callback_id === SUBAGENT_HOOK ? await options.subagentContext?.(connection.sessionId).catch(() => undefined) : undefined
    if (!connection.closed) write(connection, controlResponse(String(message.request_id), context ? { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: context } } : {}))
  }

  function onMessage(connection: Connection, message: ClaudeMessage) {
    if (message.type === "control_response") {
      const response = message.response ?? {}
      const pending = connection.pending.get(String(response.request_id))
      if (!pending) return
      connection.pending.delete(String(response.request_id))
      if (response.subtype === "error") pending.reject(new Error(`[CLAUDE]: ${String(response.error ?? "control request failed")}`))
      else pending.resolve(response.response)
      return
    }
    if (message.type === "control_request") {
      if (message.request?.subtype === "can_use_tool") void answerPermission(connection, message)
      else if (message.request?.subtype === "hook_callback") void answerHook(connection, message)
      else write(connection, JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: `unsupported: ${String(message.request?.subtype)}` } }))
      return
    }
    if (message.type === "control_cancel_request") return
    if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
      options.bindings?.set(connection.sessionId, message.session_id)
      return
    }
    if (message.type === "command_lifecycle") {
      connection.lifecycle = true
      const steered = connection.turn
      if (steered && typeof message.command_uuid === "string" && steered.steered.has(message.command_uuid) && message.state !== "queued") {
        steered.steered.delete(message.command_uuid)
        if (message.state === "started") delete steered.held
        else if (steered.held && !steered.steered.size) {
          // Claude Code dropped the last message the turn's result waited on: the turn ends with that result after all.
          steered.mapper.finish(steered.held.status === "ok" ? (steered.interrupted ? "interrupted" : "ok") : "error")
          steered.finish(steered.held)
        }
      }
      const handoff = connection.handoff
      if (handoff && message.command_uuid === handoff.uuid && message.state === "started") {
        delete connection.handoff
        if (connection.turn === handoff.turn) {
          handoff.turn.mapper.finish("ok")
          handoff.turn.finish({ status: "ok" })
        }
      }
      return
    }
    if (message.type === "rate_limit_event") {
      const quota = claudeQuota(message.rate_limit_info, clock.now())
      if (quota) options.onQuota?.(quota)
      return
    }
    if (message.type === "system" && message.subtype === "background_tasks_changed" && Array.isArray(message.tasks)) {
      const tasks = (message.tasks as Array<Record<string, unknown>>).filter((task) => task && typeof task.task_id === "string")
        .map((task) => ({ id: String(task.task_id), description: String(task.description ?? "").slice(0, 200), kind: String(task.task_type ?? "") }))
      connection.background = tasks.length
      if (tasks.length) connection.idle?.cancel()
      // An MCP change waited for the background tasks; with none left and no turn open, the process restarts now.
      else if (!connection.turn && connection.reload) { close(connection, "MCP servers changed"); return }
      else if (!connection.turn) keepIdle(connection)
      options.onBackground?.(connection.sessionId, tasks, async (taskId) => {
        if (connection.closed) throw new Error("[CLAUDE]: the Claude Code process has ended")
        await control(connection, { subtype: "stop_task", task_id: taskId })
      })
      return
    }
    // A background agent of an ended turn: its records go to that turn; Claude Code's notice that it ended is also read below.
    const owner = connection.agentTurns.find((mapper) => mapper.owns(message))
    if (owner) {
      owner.accept(message)
      if (!owner.hasBackgroundAgents()) connection.agentTurns = connection.agentTurns.filter((mapper) => mapper !== owner)
      if (message.parent_tool_use_id) return
    }
    // The rest of a turn already ended by esc: nothing of it belongs to the next one.
    if (connection.draining) {
      if (message.type === "result") connection.draining = false
      return
    }
    const turn = connection.turn
    if (!turn) return void between(connection, message)
    const compaction = compactions.get(turn.input.turnId)
    if (compaction && message.type === "system" && message.subtype === "compact_boundary") {
      const facts = message.compact_metadata ?? {}
      compaction.done = true
      if (typeof facts.pre_tokens === "number") compaction.preTokens = facts.pre_tokens
      if (typeof facts.post_tokens === "number") compaction.postTokens = facts.post_tokens
    } else if (compaction?.done && compaction.summary === undefined && message.type === "user" && message.isSynthetic && typeof message.message?.content === "string") compaction.summary = message.message.content
    accept(turn, message)
    // A tool result of the turn itself is where Claude Code can take a message in: queued ones go to it now, as it does with a
    // message typed while it works (it reads them after the running step's tool results, or answers them right after this turn).
    if (message.type === "user" && !message.parent_tool_use_id && Array.isArray(message.message?.content) && message.message.content.some((part: { type?: string }) => part?.type === "tool_result")) void steerQueued(connection, turn)
  }

  /** Writes what the user queued while the turn runs to Claude Code, which takes it into the turn the way it takes a typed message. */
  async function steerQueued(connection: Connection, turn: ActiveTurn) {
    const take = turn.input.takeQueued
    if (turn.steering || !take || !connection.lifecycle) return
    turn.steering = true
    try {
      for (let count = 0; count < 64 && !turn.interrupted && connection.turn === turn && !connection.closed; count++) {
        const queued = await take()
        if (!queued) break
        const uuid = randomUUID()
        turn.steered.add(uuid)
        write(connection, userMessage(await content({ ...turn.input, ...queued }), uuid))
      }
    } catch {
      // A message that could not be read stays where the actor put it; the turn goes on.
    } finally {
      turn.steering = false
    }
  }

  function accept(turn: ActiveTurn, message: ClaudeMessage, final = true) {
    turn.touch()
    const result = turn.mapper.accept(message)
    if (result && final) {
      const outcome = resultOutcome(result)
      // Claude Code still holds a message steered into this turn: it answers that next, and the turn ends with that answer.
      if (turn.steered.size && !turn.interrupted && outcome.status === "ok") return void (turn.held = outcome)
      turn.mapper.finish(outcome.status === "ok" ? (turn.interrupted ? "interrupted" : "ok") : "error")
      turn.finish(outcome)
    }
  }

  /**
   * A record with no MendCode turn open. When a background task ends, Claude Code tells the model and answers on its own: the daemon
   * gets a notice for it, and that turn's records are kept until the notice runs (`runTurn` shows them then). Anything else is dropped.
   */
  function between(connection: Connection, message: ClaudeMessage) {
    if (message.type === "system" && message.subtype === "task_notification") {
      if (!options.notify || connection.unsolicited) return
      const summary = typeof message.summary === "string" && message.summary.trim() ? message.summary.trim() : `Background task ${String(message.task_id ?? "")} ended (${String(message.status ?? "unknown")})`
      const notice = `${summary.slice(0, 500)}${typeof message.output_file === "string" ? `\nOutput: ${message.output_file.slice(0, 500)}` : ""}`
      connection.unsolicited = { notice, records: [] }
      connection.idle?.cancel()
      options.notify(connection.sessionId, notice)
      return
    }
    if (!connection.unsolicited || message.type === "system" && message.subtype === "init") return
    // Past the cap only its end is kept: the turn that adopts the records must still see Claude Code's `result`, or it waits for ever.
    if (connection.unsolicited.records.length < MAX_UNSOLICITED || message.type === "result") connection.unsolicited.records.push(message)
  }

  function keepIdle(connection: Connection) {
    connection.idle?.cancel()
    if (!connection.closed && connection.background === 0 && !connection.unsolicited) connection.idle = clock.setTimer(processIdleMs, () => close(connection, "idle"))
  }

  function open(sessionId: SessionId, model: ClaudeModelChoice, permission: PermissionMode, withThinkingDisplay: boolean): Connection {
    const cwd = options.cwdFor(sessionId)
    const environment = options.environment?.(sessionId)
    const args = [...claudeArgs({ ...model, permission, resume: options.bindings?.get(sessionId), thinkingDisplay: withThinkingDisplay, appendSystem: [options.appendSystem?.(cwd), MCP_RELOAD_NOTE, environment?.note].filter(Boolean).join("\n\n") }), ...(options.sessionArgs?.(sessionId) ?? []), ...(options.processArgs ?? [])]
    const extra = { ...options.env?.(sessionId, model), ...environment?.values }
    const env = Object.keys(extra).length ? { env: extra } : {}
    const transport = options.transportFactory?.({ args, cwd, ...env }) ?? spawnClaude({ bin: options.bin ?? "claude", args, cwd, ...env })
    const connection: Connection = { sessionId, transport, model, permission: claudePermissionMode(permission), pending: new Map(), ready: Promise.resolve(), closed: false, background: 0, agentTurns: [], envKey: environmentKey(environment) }
    connections.set(sessionId, connection)
    void (async () => {
      try {
        for await (const line of transport.lines) {
          options.trace?.("in", line)
          let message: ClaudeMessage
          try {
            message = JSON.parse(line)
          } catch {
            continue
          }
          onMessage(connection, message)
        }
      } catch {
        // The process went away; handled below.
      }
      const tail = transport.stderrTail()
      for (const pending of connection.pending.values()) pending.reject(new Error(`[CLAUDE]: process exited${tail ? `: ${tail}` : ""}`))
      connection.pending.clear()
      connection.turn?.mapper.finish("error")
      connection.turn?.finish({ status: "error", code: "claude_exited", message: `[CLAUDE]: claude exited during the turn${tail ? `: ${tail.slice(-1_000)}` : ""}` })
      close(connection, `process exited${tail ? `: ${tail.slice(-200)}` : ""}`)
    })()
    const hooks = { ...(options.subagentContext ? { SubagentStart: [{ hookCallbackIds: [SUBAGENT_HOOK] }] } : {}), ...(options.oneTree ? { PostToolUse: [{ matcher: ONE_TREE_TOOLS, hookCallbackIds: [ONE_TREE_HOOK] }] } : {}) }
    connection.ready = control(connection, { subtype: "initialize", ...(Object.keys(hooks).length ? { hooks } : {}) }).then(() => undefined)
    return connection
  }

  async function connectionFor(input: TurnInput): Promise<Connection> {
    const model = options.modelFor(input.sessionId, input.selection?.model)
    const mode = input.permissionMode()
    let connection = connections.get(input.sessionId)
    // Effort is fixed when Claude Code starts, so a new model or effort restarts the process and resumes the session.
    // New `/env` credentials restart it too, unless a background agent would be lost: they wait for the next start.
    // An MCP change that waited for background tasks is made before a turn once none runs.
    if (connection && (!sameModel(connection.model, model) || (connection.background === 0 && (connection.reload || connection.envKey !== environmentKey(options.environment?.(input.sessionId)))))) {
      close(connection, !sameModel(connection.model, model) ? `model, effort or fast changed (${connection.model.model ?? "default"}/${connection.model.effort ?? "default"}${connection.model.fast ? "/fast" : ""} → ${model.model ?? "default"}/${model.effort ?? "default"}${model.fast ? "/fast" : ""})` : connection.reload ? "MCP servers changed" : "credentials changed")
      connection = undefined
    }
    connection ??= open(input.sessionId, model, mode, thinkingDisplay)
    connection.idle?.cancel()
    try {
      await connection.ready
      thinkingDisplayAccepted ||= thinkingDisplay
    } catch (error) {
      // A `claude` that does not know `--thinking-display` exits at start: it is started once more without the flag, and stays without it.
      if (!thinkingDisplay || thinkingDisplayAccepted || !/process exited/.test(error instanceof Error ? error.message : "")) throw error
      close(connection, "restarted without --thinking-display")
      connection = open(input.sessionId, model, mode, false)
      await connection.ready
      thinkingDisplay = false
    }
    // An undo made while no process ran: the resumed conversation is cut before anything new reaches it.
    const cut = pendingRewinds.get(input.sessionId)
    if (cut) {
      // A prompt sent on an uncut conversation would answer what was undone: when Claude Code does not confirm the cut, this message
      // is not sent and the user is told. The undo is asked once; sending again continues on the conversation as Claude Code has it.
      pendingRewinds.delete(input.sessionId)
      const response = await control(connection, { subtype: "rewind_conversation", target_message_uuid: cut, interrupt_if_running: true }).catch(() => undefined)
      if (response?.rewound !== true) {
        keepIdle(connection)
        throw new Error("[CLAUDE]: Claude Code did not apply the earlier undo, so this message was not sent; send it again to continue on the conversation as Claude Code has it")
      }
    }
    const wanted = claudePermissionMode(mode)
    if (connection.permission !== wanted) {
      await control(connection, { subtype: "set_permission_mode", mode: wanted })
      connection.permission = wanted
    }
    return connection
  }

  async function content(input: TurnInput): Promise<Array<Record<string, unknown>>> {
    const block = async (ref: TurnInput["attachments"][number]): Promise<Record<string, unknown>> => {
      if (ref.mime.startsWith("image/") && options.readBlob) {
        const bytes = await options.readBlob(ref).catch(() => undefined)
        if (bytes) return { type: "image", source: { type: "base64", media_type: ref.mime, data: Buffer.from(bytes).toString("base64") } }
      }
      return { type: "text", text: `[attachment ${ref.name ?? ref.sha256.slice(0, 12)} · ${ref.mime} · not sent]` }
    }
    // Inline attachment tokens: the content blocks follow the sentence, each attachment right after its token.
    const layout = layoutAttachments(input.text, input.attachments)
    if (layout) return Promise.all(layout.map((part) => ("text" in part ? { type: "text", text: part.text } : block(input.attachments[part.ref]!))))
    const parts: Array<Record<string, unknown>> = []
    for (const ref of input.attachments) parts.push(await block(ref))
    parts.push({ type: "text", text: input.text })
    return parts
  }

  const port: EnginePort & { stop(reason?: string): void; busy(): boolean } = {
    async runTurn(input) {
      modes.set(input.sessionId, input.permissionMode())
      // A process of this session without the bridge that still runs background agents keeps the turn, so they are not ended for it.
      const plain = connections.get(input.sessionId)
      const plainBusy = plain !== undefined && !plain.closed && (plain.background > 0 || plain.unsolicited !== undefined)
      if (input.externalMcp && !plainBusy) {
        if (plain) close(plain, "a turn with its own MCP servers")
        // Background agents of an earlier bridged turn still run in its process: this turn joins them there, so they live on. That
        // process's bridge was the earlier turn's, so its thread tools answer that the bridge is gone until a new process starts.
        const running = kept.get(input.sessionId)
        if (running?.busy()) {
          inTurn.add(running)
          try { return await running.runTurn({ ...input, externalMcp: undefined }) }
          finally { inTurn.delete(running); settle(input.sessionId, running) }
        }
        if (running) settle(input.sessionId, running)
        const mcp = input.externalMcp
        const { trace: _trace, ...processOptions } = options
        const sessionId = input.sessionId
        // Its background agents ending is when a process kept for them stops.
        const isolated: ReturnType<typeof createClaudeEngine> = createClaudeEngine({ ...processOptions, processArgs: mcp.args, waitingForMcp: () => mcp.waiting?.() === true || options.waitingForMcp?.() === true, cwdFor: () => mcp.cwd,
          onBackground: (id, tasks, stop) => { options.onBackground?.(id, tasks, stop); if (!tasks.length) queueMicrotask(() => settle(sessionId, isolated)) } })
        isolatedEngines.add(isolated)
        inTurn.add(isolated)
        const turn = processMcpTurn(input)
        // The process lives for the bridge lease, and on while the background agents it started run. Saved bindings resume the same conversation next turn.
        try { return await isolated.runTurn(turn) }
        finally { turn.flushProcessMcp(); inTurn.delete(isolated); settle(sessionId, isolated) }
      }
      let connection: Connection
      try {
        connection = await connectionFor(input)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const missing = /ENOENT|not found|No such file/i.test(message)
        return missing
          ? { status: "error", code: "claude_missing", message: "[CLAUDE]: `claude` was not found. Install Claude Code and run `claude auth login`." }
          : { status: "error", code: "claude_start", message: message.startsWith("[CLAUDE]") ? message : `[CLAUDE]: ${message}` }
      }
      const body = await content(input)
      // A cancel while the process started or the attachments were read: its abort event is gone, so nothing may be sent now.
      if (input.signal.aborted) {
        keepIdle(connection)
        return { status: "ok" }
      }
      return new Promise<TurnOutcome>((resolve) => {
        let settled = false
        // The turn's events; once it ended, a background agent it started reports to the daemon under the same turn.
        let sink: (event: EngineEvent) => void = input.emit
        const turn: ActiveTurn = {
          input,
          mapper: createTurnMapper({ newItemId: input.newItemId, emit: (event) => sink(event), model: connection.model.model ?? "claude", ownTools: options.ownTools, onTool: (name, args) => { if (changesMcpServers(name, args)) connection.reload = true } }),
          waitingUser: false,
          interrupted: false,
          steered: new Set(),
          touch() {
            turn.watchdog?.cancel()
            if (settled || turn.waitingUser || idleMs === undefined) return
            turn.watchdog = clock.setTimer(idleMs, () => {
              if (options.waitingForMcp?.()) { turn.touch(); return }
              void control(connection, { subtype: "interrupt" }).catch(() => {})
              turn.mapper.finish("interrupted")
              turn.finish({ status: "error", code: "stream_idle", message: `[CLAUDE]: no activity for ${Math.round(idleMs / 1000)} s; turn interrupted` })
            })
          },
          finish(outcome) {
            if (settled) return
            settled = true
            turn.watchdog?.cancel()
            if (connection.turn === turn) delete connection.turn
            if (turn.mapper.hasBackgroundAgents() && options.onAgentEvent) {
              sink = (event) => options.onAgentEvent?.(connection.sessionId, input.turnId, event)
              connection.agentTurns = [...connection.agentTurns, turn.mapper].slice(-MAX_AGENT_TURNS)
            }
            // New MCP servers need a restart; it waits while a background task runs, as it would end with the process.
            if (connection.reload && connection.background === 0) close(connection, "MCP servers changed")
            else keepIdle(connection)
            resolve(outcome)
          },
        }
        connection.turn = turn
        turn.touch()
        // The notice of a turn Claude Code already started on its own: that turn is shown (what it has said so far, then the rest live) and nothing is sent.
        const pending = connection.unsolicited
        delete connection.unsolicited
        const adopted = pending && input.text.trim() === pending.notice.trim() ? pending : undefined
        if (adopted) {
          const results = adopted.records.filter((record) => record.type === "result").length
          let seen = 0
          for (const record of adopted.records) {
            if (record.type === "result") seen++
            // Several ends of their own while nobody watched read as one turn: only the last result in the buffer closes it.
            accept(turn, record, seen === results && record === adopted.records.at(-1))
          }
        }
        input.signal.addEventListener(
          "abort",
          () => {
            turn.interrupted = true
            const stopNow = () => {
              if (settled) return
              turn.mapper.finish("interrupted")
              turn.finish({ status: "ok" })
            }
            // Claude Code stops when its running tool or stream lets it; the user is not kept waiting on that.
            const grace = clock.setTimer(CANCEL_GRACE_MS, () => {
              if (settled) return
              connection.draining = true
              // A `result` that never comes must not swallow the next turns.
              clock.setTimer(DRAIN_LIMIT_MS, () => { connection.draining = false })
              stopNow()
            })
            void control(connection, { subtype: "interrupt" }).catch(() => { grace.cancel(); stopNow() })
          },
          { once: true },
        )
        if (!adopted) write(connection, userMessage(body, messageUuid(input.turnId)))
        // "Send now": the message goes into this turn as Claude Code's own send-now does (`interrupt` with `send_now`), which ends the
        // step at hand without stopping the background agents a plain interrupt stops. Claude Code closes this turn and answers the
        // message as its next one; those records wait as an unsolicited turn whose notice is the message, and its MendCode turn adopts them.
        input.onSendNow?.((message) => {
          if (settled || turn.interrupted || connection.turn !== turn || connection.unsolicited || connection.closed) return false
          const uuid = randomUUID()
          connection.unsolicited = { notice: message.text, records: [] }
          connection.handoff = { uuid, turn }
          void content({ ...input, ...message })
            .then((parts) => {
              write(connection, userMessage(parts, uuid))
              return control(connection, { subtype: "interrupt", send_now: true, for_user_message_uuids: [uuid] })
            })
            .catch(() => {
              if (connection.unsolicited?.notice === message.text) delete connection.unsolicited
              if (connection.handoff?.uuid === uuid) delete connection.handoff
            })
          return true
        })
      })
    },
    async rewind({ sessionId, turnId }) {
      const target = messageUuid(turnId)
      const connection = connections.get(sessionId)
      if (!connection || connection.closed) {
        if (!options.bindings?.get(sessionId)) return false
        pendingRewinds.set(sessionId, target)
        return true
      }
      const response = await control(connection, { subtype: "rewind_conversation", target_message_uuid: target, interrupt_if_running: true }).catch(() => undefined)
      return response?.rewound === true
    },
    // Claude Code compacts its own context when it fills up (`claude_compact` sets where).
    needsCompaction: () => false,
    /**
     * `/compact` is Claude Code's own: the command goes to its process as a message, as typed in its terminal, and it reports the
     * compaction (`compact_boundary`) and the summary it continues from. A compaction while idle is left to it.
     */
    async compact(input) {
      if (input.idle) return { status: "ok" }
      if (!connections.get(input.sessionId) && !options.bindings?.get(input.sessionId)) return { status: "ok", note: "Nothing to compact: Claude Code has no conversation for this session yet." }
      const record: { preTokens?: number; postTokens?: number; summary?: string; done?: true } = {}
      compactions.set(input.turnId, record)
      const mode = modes.get(input.sessionId) ?? "ask"
      const outcome = await port.runTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        text: `/compact${input.instructions?.trim() ? ` ${input.instructions.trim()}` : ""}`,
        attachments: [],
        ...(input.selection ? { selection: input.selection } : {}),
        signal: input.signal,
        newItemId: input.newItemId,
        emit: input.emit,
        ask: async () => ({ kind: "deny", reason: "A compaction runs no tools" }),
        permissionMode: () => mode,
        setPermissionMode: () => {},
      }).finally(() => compactions.delete(input.turnId))
      if (outcome.status !== "ok" || input.signal.aborted) return outcome
      if (!record.done) return { status: "ok", note: "Claude Code did not compact: it reported no compaction for /compact." }
      const tokens = record.preTokens !== undefined && record.postTokens !== undefined ? `Claude Code compacted its context: ~${record.preTokens} → ~${record.postTokens} tokens.` : "Claude Code compacted its context."
      const itemId = input.newItemId()
      input.emit({ type: "item.started", itemId, kind: "compaction", meta: { compactionMethod: "Claude Code" } })
      input.emit({ type: "item.completed", itemId, status: "ok", text: (record.summary ?? tokens).slice(0, MAX_TEXT) })
      return { status: "ok", compacted: true }
    },
    /** Whether a process still runs background tasks, or holds Claude Code's own answer to one that ended. */
    busy() {
      return [...connections.values()].some((connection) => !connection.closed && (connection.background > 0 || connection.unsolicited !== undefined)) || [...isolatedEngines].some((isolated) => isolated.busy())
    },
    /** Ends every process; `reason` is what `onClose` reports (a bridged turn's own process ends with its turn). */
    stop(reason = "engine stopped") {
      for (const isolated of isolatedEngines) isolated.stop(reason)
      isolatedEngines.clear()
      kept.clear()
      for (const connection of [...connections.values()]) close(connection, reason)
    },
  }
  return port
}
