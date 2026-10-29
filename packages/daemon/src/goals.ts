import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { GoalPort } from "@mendcode/engine-native"
import type { Clock, SessionEventDraft, Steering } from "@mendcode/kernel"
import {
  GOAL_INLINE_OBJECTIVE_CHARS,
  GOAL_TERMINAL_STATUSES,
  type Command,
  type ErrorCode,
  type Goal,
  type GoalBy,
  type GoalChange,
  type GoalId,
  type GoalStatus,
  type ItemId,
  type SessionEvent,
  type SessionId,
  type TurnId,
  type createIdFactory,
} from "@mendcode/protocol"
import type { Store, StoredGoal } from "@mendcode/store"
import type { GoalPromptKind, GoalPrompts } from "./goal-prompts"
import { isUsageLimitFailure, parseGoalMarker } from "./goals-signals"

type IdFactory = ReturnType<typeof createIdFactory>

export type GoalCommand = Extract<Command, { type: "goal.get" | "goal.set" | "goal.update" | "goal.clear" }>
export type GoalReply = { ok: true; result: Record<string, unknown> } | { ok: false; code: ErrorCode; message: string }

export type GoalsOptions = {
  store: Store
  clock: Clock
  ids: IdFactory
  /** The data directory: an objective too long to inline is saved under `<dir>/goals/`. */
  dir: string
  /** Appends a session event (the daemon's sink: redaction, store, broadcast). */
  emit(event: SessionEventDraft): void
  /** Starts a steering turn in the session; false when it could not take one right now (busy, queued messages, held). */
  steer(sessionId: SessionId, steering: Steering): Promise<boolean>
  prompts: GoalPrompts
  log(level: "info" | "warn" | "error", message: string): void
}

/** Consecutive goal turns with no output (no text, no tool call) after which continuation stops. */
export const MAX_EMPTY_GOAL_TURNS = 2

const LABELS: Record<GoalPromptKind, string> = {
  continuation: "goal · continuing",
  budget_limit: "goal · budget reached, wrapping up",
  objective_updated: "goal · objective updated",
}

/** The turn being followed in a session: what it did, for accounting and for deciding what comes next. */
type TurnWatch = {
  turnId: TurnId
  startedAt: number
  /** The goal whose usage this turn adds to (only a turn that started while the goal was active or wrapping up). */
  goalId?: GoalId
  /** The `meta.goal` tag of a goal steering turn; absent for a turn the user started. */
  steering?: string
  agentItems: Set<ItemId>
  lastText?: string
  output: boolean
}

type Runtime = {
  turn?: TurnWatch | undefined
  emptyStreak: number
  /** A steering is being handed to the session actor: nothing else starts one meanwhile. */
  steering: boolean
  /** The daemon restarted with this goal active: continue when a client opens the session. */
  resumeOnOpen: boolean
}

type End = { kind: "completed" } | { kind: "cancelled"; by: "user" | "promotion" } | { kind: "interrupted"; reason: string } | { kind: "failed"; code: string; message: string }

const isFinished = (status: GoalStatus) => GOAL_TERMINAL_STATUSES.includes(status)
const clip = (text: string, max = 500) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * Session goals (docs/goals.md): the objective a session keeps working on, turn after turn, until it is verifiably
 * complete, blocked, over budget, usage-limited or paused by the user.
 *
 * The daemon drives it. Every session event passes through `observe`, which counts tokens and time for the goal's turns
 * and, when a turn ends with the goal still active and the session free, asks the session actor to start a steering turn
 * (`steer`): the agent's next turn, told what the goal is by a hidden message. A queued user message always goes first
 * because the actor refuses a steering while anything is queued. The agent itself finishes a goal through the goal tools
 * (`port`) or, on engines without tools, a last line `GOAL_STATUS: complete`.
 */
export function createGoals(options: GoalsOptions) {
  const { store, clock, ids, prompts } = options
  const runtimes = new Map<SessionId, Runtime>()
  let disposed = false

  const runtime = (sessionId: SessionId): Runtime => {
    let entry = runtimes.get(sessionId)
    if (!entry) runtimes.set(sessionId, (entry = { emptyStreak: 0, steering: false, resumeOnOpen: false }))
    return entry
  }

  function publish(goal: Goal, change: GoalChange, by?: GoalBy, reason?: string) {
    options.emit({ type: "goal.changed", sessionId: goal.sessionId, change, goal, ...(by ? { by } : {}), ...(reason ? { reason: clip(reason) } : {}) })
  }

  /** Saves a status change and tells the clients. */
  function setStatus(stored: StoredGoal, status: GoalStatus, input: { by: GoalBy; note?: string | undefined; reason?: string | undefined }): Goal {
    const updated = store.goals.update(stored.goal.goalId, { status, stalled: null, note: input.note?.trim() ? clip(input.note.trim(), 1_000) : null })!
    publish(updated.goal, "status", input.by, input.reason ?? input.note)
    return updated.goal
  }

  /** Continuation stops although the goal stays active; the reason is shown until something resumes it. */
  function stall(stored: StoredGoal, reason: string) {
    const updated = store.goals.update(stored.goal.goalId, { stalled: clip(reason) })!
    publish(updated.goal, "stalled", "system", reason)
  }

  function clearStall(stored: StoredGoal) {
    if (!stored.goal.stalled) return stored
    const updated = store.goals.update(stored.goal.goalId, { stalled: null })!
    publish(updated.goal, "stalled", "system", "resumed")
    return updated
  }

  // ---- what to tell the agent next -------------------------------------------------------------------------------

  /**
   * Starts the session's next goal turn when the goal calls for one: the budget wrap-up once, a pending objective
   * update, or a plain continuation. `force`: the user asked for it (resume, a new goal), so a user cancel's hold does
   * not stop it. Returns whether a turn started; a refused one (session busy) is retried when the current turn ends.
   */
  async function next(sessionId: SessionId, { force }: { force: boolean }): Promise<boolean> {
    const state = runtime(sessionId)
    if (disposed || state.steering) return false
    const stored = store.goals.current(sessionId)
    if (!stored) return false
    const { goal } = stored
    let kind: GoalPromptKind | undefined
    if (goal.status === "budget_limited" && !stored.budgetNoticeSent) kind = "budget_limit"
    else if (goal.status === "active" && !goal.stalled) kind = stored.pendingSteer ?? "continuation"
    if (!kind) return false
    const directory = store.sessionInfo(sessionId)?.directory
    if (!directory) return false
    let text: string
    try {
      text = prompts.render(kind, { directory, goal })
    } catch (error) {
      options.log("error", error instanceof Error ? error.message : String(error))
      stall(stored, "the goal steering template is unavailable")
      return false
    }
    state.steering = true
    // Marked before the turn starts so nothing can send it twice; put back when the session refuses it.
    if (kind === "budget_limit") store.goals.update(goal.goalId, { budgetNoticeSent: true })
    else if (stored.pendingSteer) store.goals.update(goal.goalId, { pendingSteer: null })
    let started = false
    try {
      started = await options.steer(sessionId, { text, label: LABELS[kind], meta: { goal: kind }, ...(force ? { force: true } : {}) })
    } catch (error) {
      options.log("warn", `[GOALS]: could not start a goal turn: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      state.steering = false
    }
    if (!started && !disposed) {
      if (kind === "budget_limit") store.goals.update(goal.goalId, { budgetNoticeSent: false })
      else if (stored.pendingSteer) store.goals.update(goal.goalId, { pendingSteer: stored.pendingSteer })
    }
    return started
  }

  // ---- following the session's turns ------------------------------------------------------------------------------

  /** Adds the wall time of the turn that just ended to its goal and clears the running mark. */
  function closeAccounting(turn: TurnWatch, endedAt: number) {
    if (!turn.goalId) return
    if (!store.goals.addUsage(turn.goalId, { ms: Math.max(0, endedAt - turn.startedAt) })) return
    const cleared = store.goals.update(turn.goalId, { activeSince: null })
    // A goal replaced or cleared meanwhile still gets its time, but only the current one is news.
    if (cleared && store.goals.current(cleared.goal.sessionId)?.goal.goalId === cleared.goal.goalId) publish(cleared.goal, "progress")
  }

  function onTurnStarted(sessionId: SessionId, event: Extract<SessionEvent, { type: "turn.started" }>) {
    runtime(sessionId).turn = { turnId: event.turnId, startedAt: event.at, agentItems: new Set(), output: false }
  }

  function onItemStarted(sessionId: SessionId, event: Extract<SessionEvent, { type: "item.started" }>) {
    const turn = runtime(sessionId).turn
    if (!turn || turn.turnId !== event.turnId) return
    if (event.kind === "tool_call") turn.output = true
    if (event.kind === "agent_message") turn.agentItems.add(event.itemId)
    if (event.kind !== "user_message") return
    // The first item of a turn is the message that started it: a steering, a notice, a `!command` or the user's own.
    const steering = typeof event.meta?.goal === "string" ? event.meta.goal : undefined
    if (steering) turn.steering = steering
    let stored = store.goals.current(sessionId)
    if (!stored) return
    const byUser = !steering && event.meta?.notice !== true && event.meta?.shell !== true
    if (byUser) {
      // The user is back: whatever stopped continuation is over with.
      runtime(sessionId).emptyStreak = 0
      stored = clearStall(stored)
    }
    const { goal } = stored
    if (goal.status === "active" || (goal.status === "budget_limited" && steering === "budget_limit")) {
      turn.goalId = goal.goalId
      const running = store.goals.update(goal.goalId, { activeSince: turn.startedAt })!
      publish(running.goal, "progress")
    }
  }

  function onItemCompleted(sessionId: SessionId, event: Extract<SessionEvent, { type: "item.completed" }>) {
    const turn = runtime(sessionId).turn
    if (!turn || !turn.agentItems.has(event.itemId) || !event.text?.trim()) return
    turn.lastText = event.text
    turn.output = true
  }

  function onUsage(sessionId: SessionId, event: Extract<SessionEvent, { type: "usage.recorded" }>) {
    const turn = runtime(sessionId).turn
    if (!turn?.goalId || turn.turnId !== event.turnId) return
    const after = store.goals.addUsage(turn.goalId, { tokens: event.input + event.output })
    if (!after) return
    const { goal } = after
    // A goal replaced or cleared while its turn ran still counts the tokens, but only the current goal is news.
    if (store.goals.current(sessionId)?.goal.goalId !== goal.goalId) return
    if (goal.status === "active" && goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
      setStatus(after, "budget_limited", { by: "system", reason: `token budget reached (${goal.tokensUsed} of ${goal.tokenBudget} tokens)` })
      return
    }
    publish(goal, "progress")
  }

  function endOf(event: SessionEvent): End | undefined {
    switch (event.type) {
      case "turn.completed":
        return { kind: "completed" }
      case "turn.cancelled":
        return { kind: "cancelled", by: event.by }
      case "turn.interrupted":
        return { kind: "interrupted", reason: event.reason }
      case "turn.failed":
        return { kind: "failed", code: event.error.code, message: event.error.message }
      default:
        return undefined
    }
  }

  /** A turn ended: settle its accounting, then decide whether the goal goes on, stops with a reason, or is done. */
  function onTurnEnded(sessionId: SessionId, turnId: TurnId, at: number, end: End) {
    const state = runtime(sessionId)
    const turn = state.turn?.turnId === turnId ? state.turn : undefined
    state.turn = undefined
    if (turn) closeAccounting(turn, at)
    const stored = store.goals.current(sessionId)
    if (!stored) return
    // A message the user sent with "send now" is next: it will end a turn of its own and decide then.
    if (end.kind === "cancelled" && end.by === "promotion") return
    const goalTurn = turn?.steering !== undefined
    if (end.kind === "completed" && stored.goal.status === "active") {
      const marker = parseGoalMarker(turn?.lastText)
      if (marker) {
        setStatus(stored, marker.status, { by: "agent", note: marker.note, reason: marker.note ?? `the agent marked the goal ${marker.status}` })
        return
      }
    }
    if (end.kind === "completed" && goalTurn) state.emptyStreak = turn?.output ? 0 : state.emptyStreak + 1
    if (stored.goal.status !== "active") {
      // A budget wrap-up is owed once; every other status waits for the user.
      if (end.kind === "completed") void next(sessionId, { force: false })
      return
    }
    if (end.kind === "failed") {
      if (isUsageLimitFailure(end.code, end.message)) setStatus(stored, "usage_limited", { by: "system", reason: "the provider's usage limit was reached; resume with /goal resume once it resets" })
      else stall(stored, `the last turn failed: ${clip(end.message.replace(/^\[[A-Z]+\]:\s*/, ""), 200)}`)
      return
    }
    if (end.kind === "cancelled") return stall(stored, "the last turn was cancelled")
    if (end.kind === "interrupted") return stall(stored, `the last turn was interrupted (${end.reason})`)
    if (state.emptyStreak >= MAX_EMPTY_GOAL_TURNS) return stall(stored, `the agent produced no output in ${MAX_EMPTY_GOAL_TURNS} goal turns in a row`)
    void next(sessionId, { force: false })
  }

  function process(event: SessionEvent) {
    if (disposed) return
    try {
      const sessionId = event.sessionId
      switch (event.type) {
        case "turn.started":
          return onTurnStarted(sessionId, event)
        case "item.started":
          return onItemStarted(sessionId, event)
        case "item.completed":
          return onItemCompleted(sessionId, event)
        case "usage.recorded":
          return onUsage(sessionId, event)
        case "turn.completed":
        case "turn.cancelled":
        case "turn.interrupted":
        case "turn.failed": {
          const end = endOf(event)
          if (end) onTurnEnded(sessionId, event.turnId, event.at, end)
          return
        }
      }
    } catch (error) {
      options.log("error", `[GOALS]: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ---- creating and editing ----------------------------------------------------------------------------------------

  /** The objective as the agent is told it: inline, or a pointer to the file that holds a long one. */
  function storeObjective(goalId: GoalId, text: string): { objective: string; objectiveFile?: string } {
    if (text.length <= GOAL_INLINE_OBJECTIVE_CHARS) return { objective: text }
    const file = path.join(options.dir, "goals", `${goalId}.md`)
    mkdirSync(path.dirname(file), { recursive: true })
    options.store.writeStoredFile(file, Buffer.from(`${text}\n`))
    return { objective: `Read the goal objective file at ${file} before continuing.`, objectiveFile: file }
  }

  function create(input: { sessionId: SessionId; objective: string; tokenBudget?: number | undefined; replace: boolean; by: GoalBy }): { ok: true; goal: Goal; replaced?: Goal } | { ok: false; code: ErrorCode; message: string } {
    if (!store.hasSession(input.sessionId)) return { ok: false, code: "unknown_session", message: "[GOALS]: unknown session" }
    const objective = input.objective.trim()
    if (!objective) return { ok: false, code: "invalid_command", message: "[GOALS]: the objective is empty" }
    const existing = store.goals.current(input.sessionId)
    if (existing && !isFinished(existing.goal.status) && !input.replace)
      return { ok: false, code: "busy", message: `[GOALS]: this session already has an unfinished goal (${existing.goal.status}); replace it or finish it first` }
    const goalId = ids("goal")
    const saved = storeObjective(goalId, objective)
    const { created, replaced } = store.goals.insert({ goalId, sessionId: input.sessionId, ...saved, ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}) })
    runtime(input.sessionId).emptyStreak = 0
    publish(created.goal, "created", input.by, replaced ? "replaced the previous goal" : undefined)
    return { ok: true, goal: created.goal, ...(replaced ? { replaced: replaced.goal } : {}) }
  }

  /** The agent's side of a status change: complete from any unfinished status, blocked or paused only from active. */
  function agentUpdate(sessionId: SessionId, input: { status: "complete" | "blocked" | "paused"; note?: string | undefined }): { ok: true; goal: Goal } | { ok: false; message: string } {
    const stored = store.goals.current(sessionId)
    if (!stored) return { ok: false, message: "this session has no goal" }
    const { status } = stored.goal
    if (status === "complete") return { ok: false, message: "the goal is already complete" }
    if (input.status !== "complete" && status !== "active") return { ok: false, message: `the goal is ${status}; only an active goal can be marked ${input.status}` }
    return { ok: true, goal: setStatus(stored, input.status, { by: "agent", note: input.note }) }
  }

  /** What the goal tools of one session may do. */
  function port(sessionId: SessionId): GoalPort {
    return {
      get: () => store.goals.current(sessionId)?.goal,
      create: ({ objective, tokenBudget }) => {
        const made = create({ sessionId, objective, tokenBudget, replace: false, by: "agent" })
        return made.ok ? { ok: true, goal: made.goal } : { ok: false, message: made.message.replace(/^\[GOALS\]:\s*/, "") }
      },
      update: (input) => agentUpdate(sessionId, input),
    }
  }

  /**
   * The user's edits, applied in this order: objective, budget, status. Refusals are decided before anything is
   * written. A change that makes the goal workable again (resume, a raised budget, a new objective) starts its next turn.
   */
  function updateGoal(command: Extract<GoalCommand, { type: "goal.update" }>): GoalReply {
    const { sessionId } = command
    const initial = store.goals.current(sessionId)
    if (!initial) return { ok: false, code: "target_mismatch", message: "[GOALS]: this session has no goal" }
    const start = initial.goal.status
    if (start === "complete") return { ok: false, code: "invalid_command", message: "[GOALS]: the goal is complete; set a new one" }
    if (command.objective !== undefined && start === "budget_limited" && command.tokenBudget === undefined)
      return { ok: false, code: "invalid_command", message: "[GOALS]: the token budget is reached; raise it with /goal budget before editing the objective" }
    if (command.status === "paused" && isFinished(start)) return { ok: false, code: "invalid_command", message: `[GOALS]: the goal is ${start}` }
    if (command.status === "active" && start === "budget_limited" && command.tokenBudget === undefined)
      return { ok: false, code: "invalid_command", message: "[GOALS]: the token budget is reached; raise it with /goal budget <tokens|off> first" }
    const current = () => store.goals.current(sessionId)!
    let kick = false
    if (command.objective !== undefined) {
      const { goal } = current()
      const saved = storeObjective(goal.goalId, command.objective)
      if (!saved.objectiveFile && goal.objectiveFile) rmSync(goal.objectiveFile, { force: true })
      const edited = store.goals.update(goal.goalId, { objective: saved.objective, objectiveFile: saved.objectiveFile ?? null, pendingSteer: "objective_updated", stalled: null })!
      publish(edited.goal, "edited", "user")
      kick = true
    }
    if (command.tokenBudget !== undefined) {
      const budget = command.tokenBudget
      const changed = store.goals.update(current().goal.goalId, { tokenBudget: budget })!
      publish(changed.goal, "budget", "user")
      const over = budget !== null && changed.goal.tokensUsed >= budget
      if (changed.goal.status === "active" && over) setStatus(changed, "budget_limited", { by: "system", reason: `token budget reached (${changed.goal.tokensUsed} of ${budget} tokens)` })
      else if (changed.goal.status === "budget_limited" && !over) {
        // The user made room: the goal goes on, and a later limit gets its own wrap-up.
        store.goals.update(changed.goal.goalId, { budgetNoticeSent: false })
        setStatus(current(), "active", { by: "user", reason: "token budget raised" })
      }
      kick = true
    }
    if (command.status === "paused") {
      if (current().goal.status !== "paused") setStatus(current(), "paused", { by: "user" })
      kick = false
    } else if (command.status === "active") {
      if (current().goal.status !== "active") setStatus(current(), "active", { by: "user", reason: "resumed" })
      else clearStall(current())
      kick = true
    }
    if (command.status === "active" || command.objective !== undefined) runtime(sessionId).emptyStreak = 0
    // Paused, blocked or usage-limited goals stay as they are after an edit: `next` only continues an active one (or owes a wrap-up).
    if (kick) void next(sessionId, { force: true })
    return { ok: true, result: { goal: current().goal } }
  }

  /** The four goal commands. */
  function handle(command: GoalCommand): GoalReply {
    const { sessionId } = command
    if (!store.hasSession(sessionId)) return { ok: false, code: "unknown_session", message: "[GOALS]: unknown session" }
    switch (command.type) {
      case "goal.get": {
        const current = store.goals.current(sessionId)
        return { ok: true, result: { ...(current ? { goal: current.goal } : {}), ...(command.history ? { history: store.goals.history(sessionId) } : {}) } }
      }
      case "goal.set": {
        const made = create({ sessionId, objective: command.objective, tokenBudget: command.tokenBudget, replace: command.replace === true, by: "user" })
        if (!made.ok) return made
        void next(sessionId, { force: true })
        return { ok: true, result: { goal: made.goal, ...(made.replaced ? { replaced: made.replaced } : {}) } }
      }
      case "goal.update":
        return updateGoal(command)
      case "goal.clear": {
        const cleared = store.goals.clear(sessionId)
        if (!cleared) return { ok: true, result: { cleared: false } }
        if (cleared.goal.objectiveFile) rmSync(cleared.goal.objectiveFile, { force: true })
        const state = runtime(sessionId)
        state.emptyStreak = 0
        state.resumeOnOpen = false
        publish(cleared.goal, "cleared", "user")
        return { ok: true, result: { cleared: true } }
      }
    }
  }

  return {
    handle,
    port,
    /**
     * Every session event, as the store appended it. Processing is deferred one microtask: the events this writes
     * (`goal.changed`) must not be delivered to clients before the event that caused them.
     */
    observe(event: SessionEvent) {
      if (disposed || event.type === "goal.changed") return
      if (event.type !== "turn.started" && event.type !== "item.started" && event.type !== "item.completed" && event.type !== "usage.recorded" && !endOf(event)) return
      queueMicrotask(() => process(event))
    },
    /** A client opened the session: a goal that was active when the daemon stopped goes on now. */
    opened(sessionId: SessionId) {
      const state = runtimes.get(sessionId)
      if (!state?.resumeOnOpen) return
      state.resumeOnOpen = false
      void next(sessionId, { force: false })
    },
    /** The session was resumed after a pause (`session.control`): an active goal that was held back goes on now. */
    resumed(sessionId: SessionId) {
      void next(sessionId, { force: false })
    },
    /**
     * At startup, after crashed turns were closed: a goal turn that died with the previous daemon no longer runs, and
     * every active goal goes on when its session is next opened (nothing starts on its own at boot).
     */
    recover() {
      for (const stored of store.goals.withRunningTurn()) store.goals.update(stored.goal.goalId, { activeSince: null })
      for (const sessionId of store.goals.activeSessions()) runtime(sessionId).resumeOnOpen = true
    },
    /** The daemon is stopping: turns in flight are closed as interrupted, so their time is counted now and no more events are read. */
    dispose() {
      if (disposed) return
      for (const state of runtimes.values()) {
        if (state.turn) closeAccounting(state.turn, clock.now())
        state.turn = undefined
      }
      disposed = true
    },
    /** A session is being deleted: the files of its long objectives go with it. */
    forget(sessionId: SessionId) {
      for (const goal of store.goals.history(sessionId, 100)) if (goal.objectiveFile) rmSync(goal.objectiveFile, { force: true })
      runtimes.delete(sessionId)
    },
  }
}
export type Goals = ReturnType<typeof createGoals>
