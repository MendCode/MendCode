import { Context, Effect, Layer } from "effect"

import { and, Database, eq, max } from "@/storage/db"
import {
  WorkflowArtifactTable,
  WorkflowEventTable,
  WorkflowPhaseTable,
  WorkflowRevisionTable,
  WorkflowRunTable,
  WorkflowTaskAttemptTable,
  WorkflowTaskTable,
} from "./session.sql"
import {
  WorkflowArtifactID,
  WorkflowEventID,
  WorkflowPhaseID,
  WorkflowRunID,
  WorkflowTaskAttemptID,
  WorkflowTaskID,
  type WorkflowBarrier,
  type WorkflowPhaseState,
  type WorkflowRunState,
  type WorkflowTask,
  type WorkflowTaskState,
} from "./workflow"
import { isTransientWorkflowError } from "./workflow"
import { SessionID } from "./schema"
import { Service as WorkflowService, WorkflowNotFoundError, WorkflowStateError } from "./workflow-service"

export interface SchedulerPhaseNode {
  readonly id: string
  readonly ordinal: number
  readonly taskIDs: readonly string[]
  readonly barrier: WorkflowBarrier
  readonly state: WorkflowPhaseState
}

export interface SchedulerTaskNode {
  readonly id: string
  readonly phaseID: string
  readonly dependsOn: readonly string[]
  readonly state: WorkflowTaskState
  readonly readyAt?: number
}

const terminalTaskStates = new Set<WorkflowTaskState>(["completed", "failed", "blocked", "stopped"])
const successfulTaskStates = new Set<WorkflowTaskState>(["completed"])

type Usage = {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cost?: number
}

const usageFromData = (data: Record<string, unknown> | null | undefined): Usage | undefined => {
  const value = data?.usage
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const usage = value as Record<string, unknown>
  const inputTokens = typeof usage.inputTokens === "number" ? usage.inputTokens : undefined
  const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens : undefined
  const cost = typeof usage.cost === "number" ? usage.cost : undefined
  if (inputTokens === undefined && outputTokens === undefined && cost === undefined) return
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cost === undefined ? {} : { cost }),
  }
}

const addUsage = (left: Usage | undefined, right: Usage | undefined): Usage | undefined => {
  if (!left && !right) return undefined
  return {
    inputTokens: (left?.inputTokens ?? 0) + (right?.inputTokens ?? 0),
    outputTokens: (left?.outputTokens ?? 0) + (right?.outputTokens ?? 0),
    cost: (left?.cost ?? 0) + (right?.cost ?? 0),
  }
}

export const isTaskTerminal = (state: WorkflowTaskState) => terminalTaskStates.has(state)

export const barrierSatisfied = (phase: SchedulerPhaseNode, tasks: ReadonlyMap<string, SchedulerTaskNode>) => {
  const phaseTasks = phase.taskIDs.map((taskID) => tasks.get(taskID)).filter((task): task is SchedulerTaskNode => Boolean(task))
  const completed = phaseTasks.filter((task) => successfulTaskStates.has(task.state)).length
  if (phase.barrier.kind === "all") return phaseTasks.length > 0 && completed === phaseTasks.length
  if (phase.barrier.kind === "quorum") return completed >= phase.barrier.quorum
  if (phase.barrier.kind === "best-effort") return phaseTasks.length > 0 && phaseTasks.every((task) => isTaskTerminal(task.state))
  const expression = phase.barrier.expression.trim().toLowerCase()
  if (expression === "true" || expression === "all" || expression === "completed") {
    return phaseTasks.length > 0 && completed === phaseTasks.length
  }
  return false
}

export const phaseReady = (phase: SchedulerPhaseNode, phases: readonly SchedulerPhaseNode[], tasks: ReadonlyMap<string, SchedulerTaskNode>) =>
  phases
    .filter((candidate) => candidate.ordinal < phase.ordinal)
    .every((previous) => barrierSatisfied(previous, tasks))

export const readyTaskIDs = (input: {
  readonly phases: readonly SchedulerPhaseNode[]
  readonly tasks: readonly SchedulerTaskNode[]
  readonly maxConcurrency: number
}) => {
  const tasks = new Map(input.tasks.map((task) => [task.id, task]))
  const phases = [...input.phases].toSorted((a, b) => a.ordinal - b.ordinal)
  const active = input.tasks.filter((task) => task.state === "queued" || task.state === "working").length
  const slots = Math.max(0, Math.floor(input.maxConcurrency) - active)
  if (slots === 0) return [] as string[]
  const now = Date.now()
  const ready: string[] = []
  for (const phase of phases) {
    if (ready.length >= slots || !phaseReady(phase, phases, tasks)) break
    if (phase.state === "blocked" || phase.state === "paused" || phase.state === "stopped" || phase.state === "failed") continue
    for (const taskID of phase.taskIDs) {
      if (ready.length >= slots) break
      const task = tasks.get(taskID)
      if (!task || task.state !== "pending") continue
      if (task.readyAt !== undefined && task.readyAt > now) continue
      if (!task.dependsOn.every((dependencyID) => tasks.get(dependencyID)?.state === "completed")) continue
      ready.push(task.id)
    }
  }
  return ready
}

export interface WorkflowTaskClaim {
  readonly runID: WorkflowRunID
  readonly taskID: WorkflowTaskID
  readonly phaseID: WorkflowPhaseID
  readonly attemptID: WorkflowTaskAttemptID
  readonly attempt: number
  readonly task: WorkflowTask
  readonly rootSessionID?: string
  readonly maxChildren?: number
  readonly maxDepth?: number
}

export interface SchedulerTick {
  readonly runID: WorkflowRunID
  readonly state: WorkflowRunState
  readonly claimed: readonly WorkflowTaskClaim[]
  readonly nextWakeAt?: number
}

export interface TaskResultInput {
  readonly runID: WorkflowRunID
  readonly taskID: WorkflowTaskID
  readonly attemptID: WorkflowTaskAttemptID
  readonly attempt: number
  readonly state: Extract<WorkflowTaskState, "completed" | "failed" | "blocked" | "needs_input" | "stopped">
  readonly summary?: string
  readonly error?: string
  readonly failureClass?: string
  readonly backgroundTaskID?: string
  readonly backgroundGeneration?: number
  readonly usage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly cost?: number
  }
  readonly outputRefs?: readonly string[]
  readonly evidence?: readonly string[]
}

export interface Interface {
  readonly tick: (runID: WorkflowRunID) => Effect.Effect<SchedulerTick, WorkflowNotFoundError>
  readonly markStarted: (input: {
    readonly runID: WorkflowRunID
    readonly taskID: WorkflowTaskID
    readonly attemptID: WorkflowTaskAttemptID
    readonly backgroundTaskID: string
    readonly backgroundGeneration: number
  }) => Effect.Effect<void, WorkflowNotFoundError | WorkflowStateError>
  readonly finish: (input: TaskResultInput) => Effect.Effect<void, WorkflowNotFoundError | WorkflowStateError>
  readonly finishSession: (input: {
    readonly sessionID: SessionID
    readonly backgroundGeneration?: number
    readonly state: TaskResultInput["state"]
    readonly summary?: string
    readonly error?: string
    readonly failureClass?: string
    readonly usage?: TaskResultInput["usage"]
    readonly evidence?: readonly string[]
  }) => Effect.Effect<void, WorkflowNotFoundError | WorkflowStateError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowScheduler") {}

const runtimeID = `workflow-scheduler:${process.pid}:${crypto.randomUUID()}`
const RUN_LEASE_MS = 30_000

type DB = Parameters<typeof Database.use>[0] extends (db: infer D) => unknown ? D : never

const appendEvent = (db: DB, runID: WorkflowRunID, type: string, title: string, summary: string, data?: Record<string, unknown>) => {
  const sequence = (db.select({ value: max(WorkflowEventTable.sequence) }).from(WorkflowEventTable).where(eq(WorkflowEventTable.run_id, runID)).get()?.value ?? 0) + 1
  db.insert(WorkflowEventTable).values({
    id: WorkflowEventID.make(),
    run_id: runID,
    sequence,
    level: type.endsWith("failed") ? "error" : "info",
    type: type as never,
    title,
    summary,
    time_created: Date.now(),
    time_updated: Date.now(),
    data,
  }).run()
}

const budgetBlocker = (input: {
  readonly run: typeof WorkflowRunTable.$inferSelect
  readonly plan: (typeof WorkflowRevisionTable.$inferSelect)["plan"]
  readonly tasks: readonly (typeof WorkflowTaskTable.$inferSelect)[]
  readonly attempts: readonly (typeof WorkflowTaskAttemptTable.$inferSelect)[]
  readonly now: number
}) => {
  const budget = input.plan.budget
  if (!budget) return
  const usage = input.tasks.reduce<Usage | undefined>((total, task) => addUsage(total, usageFromData(task.data)), undefined)
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
  if (budget.maxTokens !== undefined && tokens >= budget.maxTokens) return `Workflow token budget exhausted (${tokens}/${budget.maxTokens})`
  if (budget.maxCost !== undefined && (usage?.cost ?? 0) >= budget.maxCost) return `Workflow cost budget exhausted (${usage?.cost ?? 0}/${budget.maxCost})`
  if (budget.maxTurns !== undefined && input.attempts.length >= budget.maxTurns) return `Workflow turn budget exhausted (${input.attempts.length}/${budget.maxTurns})`
  if (budget.maxRuntimeMs !== undefined && input.run.time_started !== null && input.now - input.run.time_started >= budget.maxRuntimeMs) {
    return `Workflow runtime budget exhausted (${input.now - input.run.time_started}/${budget.maxRuntimeMs}ms)`
  }
  return
}

const phaseBarrierSatisfied = (phase: typeof WorkflowPhaseTable.$inferSelect, tasks: readonly (typeof WorkflowTaskTable.$inferSelect)[]) =>
  barrierSatisfied(
    {
      id: phase.id,
      ordinal: phase.ordinal,
      taskIDs: tasks.filter((task) => task.phase_id === phase.id).map((task) => task.id),
      barrier: phase.barrier,
      state: phase.state,
    },
    new Map(tasks.map((task) => [task.id, { id: task.id, phaseID: task.phase_id, dependsOn: task.depends_on, state: task.state }])),
  )

const reconcile = (db: DB, runID: WorkflowRunID, now: number) => {
  const phases = db.select().from(WorkflowPhaseTable).where(eq(WorkflowPhaseTable.run_id, runID)).orderBy(WorkflowPhaseTable.ordinal).all()
     const tasks = db.select().from(WorkflowTaskTable).where(eq(WorkflowTaskTable.run_id, runID)).all()
  const taskByID = new Map(tasks.map((task) => [task.id, task]))

  for (const task of tasks) {
    if (task.state !== "pending") continue
    const dependency = task.depends_on.map((id) => taskByID.get(id)).find((candidate) => candidate && ["failed", "blocked", "stopped"].includes(candidate.state))
    if (!dependency) continue
    db.update(WorkflowTaskTable)
      .set({
        state: "blocked",
        time_ended: now,
        time_updated: now,
        data: { ...task.data, blocker: `Dependency ${dependency.id} ended in ${dependency.state}` },
      })
      .where(and(eq(WorkflowTaskTable.run_id, runID), eq(WorkflowTaskTable.id, task.id)))
      .run()
    appendEvent(db, runID, "workflow.task.updated", "Task blocked", `Task ${task.id} is blocked by ${dependency.id}`, {
      taskID: task.id,
      dependencyID: dependency.id,
    })
  }

  const refreshedTasks = db.select().from(WorkflowTaskTable).where(eq(WorkflowTaskTable.run_id, runID)).all()
  const refreshedByID = new Map(refreshedTasks.map((task) => [task.id, task]))
  const phaseStates = new Map<string, WorkflowPhaseState>()
  for (const phase of phases) {
    const phaseTasks = refreshedTasks.filter((task) => task.phase_id === phase.id)
    const counts = {
      total: phaseTasks.length,
      queued: phaseTasks.filter((task) => task.state === "queued").length,
      working: phaseTasks.filter((task) => task.state === "working").length,
      completed: phaseTasks.filter((task) => task.state === "completed").length,
      failed: phaseTasks.filter((task) => task.state === "failed").length,
      blocked: phaseTasks.filter((task) => task.state === "blocked" || task.state === "stopped").length,
    }
    const barrier = phaseBarrierSatisfied(phase, refreshedTasks)
    const phaseUsage = phaseTasks.reduce<Usage | undefined>((total, task) => addUsage(total, usageFromData(task.data)), undefined)
    const state: WorkflowPhaseState = barrier
      ? "completed"
      : counts.failed > 0
        ? "failed"
        : counts.blocked > 0 && counts.queued === 0 && counts.working === 0
          ? "blocked"
          : counts.working > 0
            ? "working"
            : counts.queued > 0
              ? "queued"
              : "pending"
    phaseStates.set(phase.id, state)
    db.update(WorkflowPhaseTable)
      .set({
        state,
        task_count: counts.total,
        queued_count: counts.queued,
        working_count: counts.working,
        completed_count: counts.completed,
        failed_count: counts.failed,
        blocked_count: counts.blocked,
        ...(state === "working" && phase.time_started === null ? { time_started: now } : {}),
        ...(state === "completed" || state === "failed" || state === "blocked" ? { time_ended: now } : {}),
        ...(phaseUsage === undefined ? {} : { data: { ...phase.data, usage: phaseUsage } }),
        time_updated: now,
      })
      .where(and(eq(WorkflowPhaseTable.run_id, runID), eq(WorkflowPhaseTable.id, phase.id)))
      .run()
  }

  const run = db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, runID)).get()
  if (!run) return
  const revision = db.select().from(WorkflowRevisionTable).where(eq(WorkflowRevisionTable.id, run.revision_id)).get()
  const finalTaskID = revision
    ? db.select().from(WorkflowTaskTable).where(and(eq(WorkflowTaskTable.run_id, runID), eq(WorkflowTaskTable.id, revision.plan.finalTaskID))).get()
    : undefined
  const hasWorking = refreshedTasks.some((task) => task.state === "working" || task.state === "queued")
  const hasInput = refreshedTasks.some((task) => task.state === "needs_input")
  const hasFailure = [...phaseStates.values()].some((state) => state === "failed")
  const hasBlocked = [...phaseStates.values()].some((state) => state === "blocked")
  const allPhasesSatisfied = phases.every((phase) => phaseBarrierSatisfied(phase, refreshedTasks))
  const computedState: WorkflowRunState = finalTaskID?.state === "completed" && allPhasesSatisfied
    ? "completed"
    : hasInput
      ? "needs_input"
      : hasFailure
        ? "failed"
        : hasBlocked
          ? "blocked"
          : hasWorking
            ? "working"
            : "queued"
  const state: WorkflowRunState = run.state === "stopped"
    ? "stopped"
    : run.state === "blocked"
      ? "blocked"
      : run.state === "paused" && (hasWorking || !allPhasesSatisfied)
        ? "paused"
        : computedState
  const currentPhase = phases.find((phase) => !["completed", "stopped"].includes(phaseStates.get(phase.id) ?? phase.state))
  const runUsage = refreshedTasks.reduce<Usage | undefined>((total, task) => addUsage(total, usageFromData(task.data)), undefined)
  db.update(WorkflowRunTable)
    .set({
      state,
      current_phase_id: currentPhase?.id ?? null,
      time_updated: now,
      ...(runUsage === undefined ? {} : { data: { ...run.data, usage: runUsage } }),
      ...(state === "working" && run.time_started === null ? { time_started: now } : {}),
      ...(state === "completed" || state === "failed" ? { time_ended: now } : {}),
    })
    .where(eq(WorkflowRunTable.id, runID))
    .run()
  if (run.state !== state && (state === "completed" || state === "failed")) {
    const title = state === "completed" ? "Workflow completed" : "Workflow failed"
    appendEvent(db, runID, state === "completed" ? "workflow.run.completed" : "workflow.run.failed", title, title, {
      terminal: true,
      background: true,
      state,
    })
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const workflow = yield* WorkflowService

    const tick = Effect.fn("WorkflowScheduler.tick")(function* (runID: WorkflowRunID) {
      const current = yield* workflow.show(runID)
      const now = Date.now()
      const result = Database.transaction((db): SchedulerTick => {
        const run = db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, runID)).get()
        if (!run) throw new WorkflowNotFoundError(runID)
        if (["awaiting_approval", "paused", "needs_input", "blocked", "completed", "failed", "stopped"].includes(run.state)) {
          return { runID, state: run.state, claimed: [] }
        }
        if (run.lease_holder && run.lease_holder !== runtimeID && (run.lease_expires_at ?? 0) > now) {
          return { runID, state: run.state, claimed: [], nextWakeAt: run.lease_expires_at ?? undefined }
        }

        reconcile(db, runID, now)
        const refreshedRun = db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, runID)).get() ?? run
        if (["blocked", "completed", "failed", "stopped", "needs_input"].includes(refreshedRun.state)) {
          return { runID, state: refreshedRun.state, claimed: [] }
        }
        const phases = db.select().from(WorkflowPhaseTable).where(eq(WorkflowPhaseTable.run_id, runID)).all()
        const tasks = db.select().from(WorkflowTaskTable).where(eq(WorkflowTaskTable.run_id, runID)).all()
        const attempts = db.select().from(WorkflowTaskAttemptTable).where(eq(WorkflowTaskAttemptTable.run_id, runID)).all()
        const blocker = budgetBlocker({ run: refreshedRun, plan: current.revision.plan, tasks, attempts, now })
        if (blocker) {
          db.update(WorkflowRunTable)
            .set({ state: "blocked", time_updated: now, data: { ...refreshedRun.data, blocker } })
            .where(eq(WorkflowRunTable.id, runID))
            .run()
          appendEvent(db, runID, "workflow.run.updated", "Workflow budget exhausted", blocker, { blocker })
          return { runID, state: "blocked", claimed: [] }
        }
        const taskByID = new Map(current.tasks.map((task) => [task.id, task]))
        const ready = readyTaskIDs({
          phases: phases.map((phase) => ({ id: phase.id, ordinal: phase.ordinal, taskIDs: tasks.filter((task) => task.phase_id === phase.id).map((task) => task.id), barrier: phase.barrier, state: phase.state })),
           tasks: tasks.map((task) => ({
             id: task.id,
             phaseID: task.phase_id,
             dependsOn: task.depends_on,
             state: task.state,
             ...(typeof task.data?.retryAt === "number" ? { readyAt: task.data.retryAt } : {}),
           })),
           maxConcurrency: current.preview.maxConcurrency,
         })
        const claims: WorkflowTaskClaim[] = []
        for (const taskID of ready) {
          const task = tasks.find((candidate) => candidate.id === taskID)
          const typedTaskID = WorkflowTaskID.make(taskID)
          const contract = taskByID.get(typedTaskID)
          if (!task || !contract) continue
          const attempt = task.attempt + 1
          const attemptID = WorkflowTaskAttemptID.make()
          db.update(WorkflowTaskTable)
            .set({ state: "queued", attempt, time_updated: now, data: { ...task.data, blocker: undefined } })
             .where(and(eq(WorkflowTaskTable.run_id, runID), eq(WorkflowTaskTable.id, typedTaskID), eq(WorkflowTaskTable.attempt, task.attempt)))
             .run()
           const attemptData = {
             id: attemptID,
             taskID: typedTaskID,
             attempt,
             state: "queued" as const,
           }
           db.insert(WorkflowTaskAttemptTable).values({
             id: attemptID,
             run_id: runID,
             task_id: typedTaskID,
             attempt,
             state: "queued",
             time_created: now,
             time_updated: now,
             data: attemptData,
           }).run()
          appendEvent(db, runID, "workflow.task.updated", "Task queued", `Task ${taskID} queued for attempt ${attempt}`, {
            taskID,
            attempt,
            attemptID,
          })
          claims.push({
            runID,
            taskID: WorkflowTaskID.make(taskID),
            phaseID: WorkflowPhaseID.make(task.phase_id),
            attemptID,
            attempt,
            task: contract,
            ...(refreshedRun.root_session_id ? { rootSessionID: refreshedRun.root_session_id } : {}),
             ...(task.budget?.maxChildren ?? current.revision.plan.budget?.maxChildren) === undefined
               ? {}
               : { maxChildren: task.budget?.maxChildren ?? current.revision.plan.budget?.maxChildren },
              ...(task.budget?.maxDepth ?? current.revision.plan.budget?.maxDepth) === undefined
                ? {}
                : { maxDepth: task.budget?.maxDepth ?? current.revision.plan.budget?.maxDepth },
          })
        }
        db.update(WorkflowRunTable)
          .set({
            state: claims.length > 0 || refreshedRun.state === "working" ? "working" : refreshedRun.state,
            lease_holder: runtimeID,
            lease_acquired_at: refreshedRun.lease_acquired_at ?? now,
            lease_heartbeat_at: now,
            lease_expires_at: now + RUN_LEASE_MS,
            time_started: refreshedRun.time_started ?? now,
            time_updated: now,
          })
          .where(eq(WorkflowRunTable.id, runID))
          .run()
         const nextWakeAt = tasks
           .filter((task) => task.state === "pending")
           .map((task) => (typeof task.data?.retryAt === "number" ? task.data.retryAt : undefined))
           .filter((value): value is number => value !== undefined && value > now)
           .toSorted((a, b) => a - b)[0]
         return {
           runID,
           state: claims.length > 0 ? "working" : refreshedRun.state,
           claimed: claims,
           ...(nextWakeAt === undefined ? {} : { nextWakeAt }),
         }
      }, { behavior: "immediate" })
      return result
    })

    const markStarted = Effect.fn("WorkflowScheduler.markStarted")(function* (input: {
      readonly runID: WorkflowRunID
      readonly taskID: WorkflowTaskID
      readonly attemptID: WorkflowTaskAttemptID
      readonly backgroundTaskID: string
      readonly backgroundGeneration: number
    }) {
      const current = yield* workflow.show(input.runID)
      const now = Date.now()
      const changed = Database.transaction((db) => {
        const task = db.select().from(WorkflowTaskTable).where(and(eq(WorkflowTaskTable.run_id, input.runID), eq(WorkflowTaskTable.id, input.taskID))).get()
        const attempt = db.select().from(WorkflowTaskAttemptTable).where(eq(WorkflowTaskAttemptTable.id, input.attemptID)).get()
        if (!task || !attempt) throw new WorkflowStateError(input.runID, `Task attempt ${input.attemptID} no longer exists`)
        if (attempt.state !== "queued") return false
        db.update(WorkflowTaskTable).set({ state: "working", time_started: task.time_started ?? now, time_updated: now }).where(eq(WorkflowTaskTable.id, input.taskID)).run()
        db.update(WorkflowTaskAttemptTable).set({
          state: "working",
          background_task_id: SessionID.make(input.backgroundTaskID),
          background_generation: input.backgroundGeneration,
          time_started: attempt.time_started ?? now,
          time_updated: now,
          data: {
            ...(attempt.data ?? {}),
            id: attempt.id,
            taskID: task.id,
            attempt: attempt.attempt,
            backgroundTaskID: input.backgroundTaskID,
            backgroundGeneration: input.backgroundGeneration,
            state: "working" as const,
          },
        }).where(eq(WorkflowTaskAttemptTable.id, input.attemptID)).run()
        appendEvent(db, input.runID, "workflow.task.updated", "Task started", `Task ${input.taskID} started`, {
          taskID: input.taskID,
          attemptID: input.attemptID,
          backgroundTaskID: input.backgroundTaskID,
          backgroundGeneration: input.backgroundGeneration,
        })
        return true
      }, { behavior: "immediate" })
      if (changed) return
      if (!current.tasks.some((task) => task.id === input.taskID)) throw new WorkflowNotFoundError(input.taskID)
    })

    const finish = Effect.fn("WorkflowScheduler.finish")(function* (input: TaskResultInput) {
      const current = yield* workflow.show(input.runID)
      const now = Date.now()
      Database.transaction((db) => {
        const task = db.select().from(WorkflowTaskTable).where(and(eq(WorkflowTaskTable.run_id, input.runID), eq(WorkflowTaskTable.id, input.taskID))).get()
        const attempt = db.select().from(WorkflowTaskAttemptTable).where(eq(WorkflowTaskAttemptTable.id, input.attemptID)).get()
        const run = db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, input.runID)).get()
        if (!task || !attempt) throw new WorkflowStateError(input.runID, `Task attempt ${input.attemptID} no longer exists`)
        if (!run) throw new WorkflowNotFoundError(input.runID)
        if (attempt.attempt !== input.attempt) throw new WorkflowStateError(input.runID, `Task ${input.taskID} attempt is stale`)
        if (isTaskTerminal(attempt.state)) return
         const taskUsage = addUsage(usageFromData(task.data), input.usage)
         const taskTokens = (taskUsage?.inputTokens ?? 0) + (taskUsage?.outputTokens ?? 0)
         const taskBudget = task.budget
         const budgetError = taskBudget?.maxTokens !== undefined && taskTokens > taskBudget.maxTokens
           ? `Task token budget exhausted (${taskTokens}/${taskBudget.maxTokens})`
           : taskBudget?.maxCost !== undefined && (taskUsage?.cost ?? 0) > taskBudget.maxCost
             ? `Task cost budget exhausted (${taskUsage?.cost ?? 0}/${taskBudget.maxCost})`
             : taskBudget?.maxTurns !== undefined && input.attempt > taskBudget.maxTurns
               ? `Task turn budget exhausted (${input.attempt}/${taskBudget.maxTurns})`
               : taskBudget?.maxRuntimeMs !== undefined && attempt.time_started !== null && now - attempt.time_started > taskBudget.maxRuntimeMs
                 ? `Task runtime budget exhausted (${now - attempt.time_started}/${taskBudget.maxRuntimeMs}ms)`
                 : undefined
         const finalState = budgetError ? "blocked" as const : input.state
         const finalFailureClass = budgetError ? "budget" : input.failureClass
         const finalError = budgetError ?? input.error
         const defaultTransientRetry =
           task.retry?.maxAttempts === undefined &&
           task.retry?.retryOn === undefined &&
           input.state === "failed" &&
           input.failureClass === "transient" &&
           isTransientWorkflowError(input.error ?? input.summary)
         const retryOn = task.retry?.retryOn
         const maxAttempts = task.retry?.maxAttempts ?? (defaultTransientRetry ? 3 : undefined)
         const retryable =
           !budgetError &&
           input.state === "failed" &&
           input.failureClass !== undefined &&
           maxAttempts !== undefined &&
           input.attempt < maxAttempts &&
           (retryOn
             ? retryOn.some((failureClass) => failureClass === input.failureClass)
             : input.failureClass === "transient" || input.failureClass === "environment")
         const retryAt = retryable ? now + Math.max(0, task.retry?.backoffMs ?? (defaultTransientRetry ? 1_000 : 0)) : undefined
         const taskState = retryable ? "pending" as const : finalState
         const data = {
            ...task.data,
            ...(input.summary === undefined ? {} : { summary: input.summary }),
            ...(finalError === undefined ? {} : { blocker: finalError }),
            ...(taskUsage === undefined ? {} : { usage: taskUsage }),
            ...(input.outputRefs === undefined ? {} : { outputRefs: [...input.outputRefs] }),
            ...(input.evidence === undefined ? {} : { evidence: [...input.evidence] }),
            ...(retryAt === undefined ? { retryAt: undefined } : { retryAt }),
          }
          db.update(WorkflowTaskTable).set({ state: taskState, time_started: retryable ? null : undefined, time_ended: retryable ? null : now, time_updated: now, data }).where(eq(WorkflowTaskTable.id, input.taskID)).run()
         db.update(WorkflowTaskAttemptTable).set({
           state: finalState,
           failure_class: finalFailureClass,
           reason: finalError ?? input.summary,
           time_completed: now,
           time_updated: now,
           data: {
            ...(attempt.data ?? {}),
            id: attempt.id,
            taskID: task.id,
            attempt: attempt.attempt,
             state: finalState,
             ...(finalError ?? input.summary ? { reason: finalError ?? input.summary } : {}),
           },
         }).where(eq(WorkflowTaskAttemptTable.id, input.attemptID)).run()
          if (input.summary || input.outputRefs?.length || input.evidence?.length) {
          const sequence = (db.select({ value: max(WorkflowArtifactTable.sequence) }).from(WorkflowArtifactTable).where(eq(WorkflowArtifactTable.run_id, input.runID)).get()?.value ?? 0) + 1
          db.insert(WorkflowArtifactTable).values({
            id: WorkflowArtifactID.make(),
            run_id: input.runID,
            task_id: input.taskID,
            attempt_id: input.attemptID,
            sequence,
            kind: task.output.kind === "artifact" ? task.output.artifactKind ?? "workflow-output" : "workflow-output",
             summary: input.summary ?? finalError ?? `Task ${input.taskID} finished`,
             status: finalState === "completed" ? "valid" : "invalid",
             schema_validated: finalState === "completed",
            output_refs: [...(input.outputRefs ?? [])],
            evidence: [...(input.evidence ?? [])],
            attempt: input.attempt,
            time_created: now,
            time_updated: now,
             data: taskUsage === undefined ? undefined : { usage: taskUsage },
          }).run()
          appendEvent(db, input.runID, "workflow.artifact.created", "Task artifact recorded", `Task ${input.taskID} produced a bounded artifact`, {
            taskID: input.taskID,
            attempt: input.attempt,
          })
        }
          appendEvent(db, input.runID, retryable ? "workflow.task.updated" : finalState === "failed" ? "workflow.run.failed" : "workflow.task.updated", retryable ? "Task retry queued" : "Task finished", retryable ? `Task ${input.taskID} queued for retry` : `Task ${input.taskID} finished as ${finalState}`, {
            taskID: input.taskID,
            attempt: input.attempt,
            state: finalState,
            failureClass: finalFailureClass,
           ...(retryAt === undefined ? {} : { retryAt }),
         })
        reconcile(db, input.runID, now)
      }, { behavior: "immediate" })
      yield* workflow.publishTerminalNotification(input.runID)
      if (!current.tasks.some((task) => task.id === input.taskID)) throw new WorkflowNotFoundError(input.taskID)
    })

    const finishSession = Effect.fn("WorkflowScheduler.finishSession")(function* (input: {
      readonly sessionID: SessionID
      readonly backgroundGeneration?: number
      readonly state: TaskResultInput["state"]
      readonly summary?: string
      readonly error?: string
      readonly failureClass?: string
      readonly usage?: TaskResultInput["usage"]
      readonly evidence?: readonly string[]
    }) {
      const attempt = Database.use((db) =>
        db
          .select()
          .from(WorkflowTaskAttemptTable)
          .where(eq(WorkflowTaskAttemptTable.background_task_id, input.sessionID))
          .all()
          .filter(
            (candidate) =>
              input.backgroundGeneration === undefined ||
              candidate.background_generation === input.backgroundGeneration,
          )
          .toSorted((left, right) => right.attempt - left.attempt)[0],
      )
      if (!attempt) return
      yield* finish({
        runID: attempt.run_id,
        taskID: attempt.task_id,
        attemptID: attempt.id,
        attempt: attempt.attempt,
        state: input.state,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.error === undefined ? {} : { error: input.error }),
        ...(input.failureClass === undefined ? {} : { failureClass: input.failureClass }),
        ...(input.usage === undefined ? {} : { usage: input.usage }),
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
        backgroundTaskID: input.sessionID,
        ...(input.backgroundGeneration === undefined
          ? {}
          : { backgroundGeneration: input.backgroundGeneration }),
      })
    })

    return Service.of({ tick, markStarted, finish, finishSession })
  }),
)

export const defaultLayer = layer

export * as WorkflowScheduler from "./workflow-scheduler"
