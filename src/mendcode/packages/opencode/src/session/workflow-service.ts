import { createHash } from "crypto"
import { Context, Effect, Layer, Schema } from "effect"

import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import { Database, and, desc, eq, max } from "@/storage/db"
import {
  WorkflowArtifactTable,
  WorkflowDefinitionTable,
  WorkflowEventTable,
  WorkflowGateTable,
  WorkflowPhaseTable,
  WorkflowRevisionTable,
  WorkflowRunTable,
  SessionTable,
  WorkflowTaskAttemptTable,
  WorkflowTaskDependencyTable,
  WorkflowTaskTable,
} from "./session.sql"
import {
  WorkflowArtifact,
  WorkflowArtifactID,
  WorkflowDefinition,
  WorkflowDefinitionID,
  WorkflowEventID,
  WorkflowGateID,
  WorkflowPhase,
  WorkflowPhaseID,
  WorkflowPhaseState,
  WorkflowRevisionID,
  WorkflowRun,
  WorkflowRunID,
  WorkflowRunState,
  WorkflowTask,
  WorkflowTaskAttemptID,
  WorkflowTaskID,
  WorkflowTaskKind,
  WorkflowTaskState,
  WorkflowPermissionMode,
  WorkflowSessionPermissionMode,
  WorkflowWorkspaceLease,
} from "./workflow"
import {
  assertValidWorkflowPlan,
  validateWorkflowPlan,
  WorkflowPlan,
  WorkflowPlanPreview,
  WorkflowRevision,
} from "./workflow-plan"
import type { WorkflowPlanValidationIssue } from "./workflow-plan"
import {
  type CompletionAuditReceipt,
  type CompletionAuditDecision,
  type CompletionGate,
  type CompletionProgress,
  compileCompletionCriteria,
  decideCompletionAudit,
  nextCompletionProgress,
} from "./completion-contract"

export class WorkflowNotFoundError extends Error {
  readonly _tag = "WorkflowNotFoundError"

  constructor(readonly id: string) {
    super(`Workflow run not found: ${id}`)
  }
}

export class WorkflowValidationError extends Error {
  readonly _tag = "WorkflowValidationError"

  constructor(readonly issues: readonly WorkflowPlanValidationIssue[]) {
    super(issues.map((entry) => `${entry.code}: ${entry.message}`).join("; "))
  }
}

export class WorkflowStateError extends Error {
  readonly _tag = "WorkflowStateError"

  constructor(
    readonly id: string,
    message: string,
  ) {
    super(message)
  }
}

export interface WorkflowPhaseSnapshot {
  readonly id: WorkflowPhaseID
  readonly ordinal: number
  readonly name: string
  readonly description?: string
  readonly state: WorkflowPhaseState
  readonly barrier: WorkflowPhase["barrier"]
  readonly counts: {
    readonly total: number
    readonly queued: number
    readonly working: number
    readonly completed: number
    readonly failed: number
    readonly blocked: number
  }
  readonly usage?: WorkflowUsageSnapshot
}

export interface WorkflowUsageSnapshot {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cost?: number
}

export type WorkflowTaskSnapshot = WorkflowTask & {
  readonly state: WorkflowTaskState
  readonly attempt: number
  readonly sessionID?: SessionID
  readonly startedAt?: number
  readonly completedAt?: number
  readonly blocker?: string
  readonly usage?: WorkflowUsageSnapshot
}

export interface WorkflowEventSnapshot {
  readonly id: WorkflowEventID
  readonly sequence: number
  readonly level: "debug" | "info" | "warning" | "error" | "decision"
  readonly type: string
  readonly title: string
  readonly summary: string
  readonly createdAt: number
  readonly data?: Record<string, unknown>
}

export interface WorkflowGateSnapshot {
  readonly id: WorkflowGateID
  readonly phaseID?: WorkflowPhaseID
  readonly taskID?: WorkflowTaskID
  readonly state: "pending" | "pass" | "fail" | "blocked" | "awaiting_approval" | "waived"
  readonly required: boolean
  readonly actor?: string
  readonly reason?: string
  readonly kind: "approval" | "completion"
}

export interface WorkflowSnapshot {
  readonly definition: WorkflowDefinition
  readonly revision: WorkflowRevision
  readonly run: WorkflowRun
  readonly preview: WorkflowPlanPreview
  readonly phases: readonly WorkflowPhaseSnapshot[]
  readonly tasks: readonly WorkflowTaskSnapshot[]
  readonly artifacts: readonly WorkflowArtifact[]
  readonly events: readonly WorkflowEventSnapshot[]
  readonly gates: readonly WorkflowGateSnapshot[]
  readonly usage?: WorkflowUsageSnapshot
}

export interface WorkflowSaveInput {
  readonly plan: WorkflowPlan
  readonly definitionID?: WorkflowDefinitionID
  readonly name?: string
  readonly description?: string
  readonly source?: WorkflowDefinition["source"]
  readonly ownerSessionID?: WorkflowDefinition["ownerSessionID"]
  readonly saved?: boolean
}

export interface WorkflowRevisionReceipt {
  readonly definitionID: WorkflowDefinitionID
  readonly revisionID: WorkflowRevisionID
  readonly revision: number
  readonly plan: WorkflowPlan
  readonly preview: WorkflowPlanPreview
}

export interface WorkflowStartInput {
  readonly plan?: WorkflowPlan
  readonly revisionID?: WorkflowRevisionID
  readonly definitionID?: WorkflowDefinitionID
  readonly name?: string
  readonly description?: string
  readonly source?: WorkflowDefinition["source"]
  readonly originSessionID?: WorkflowDefinition["ownerSessionID"]
  readonly loopID?: string
  readonly loopRunID?: string
  readonly overlapKey?: string
}

export interface WorkflowControlInput {
  readonly runID: WorkflowRunID
  readonly reason?: string
  readonly actor?: string
}

export interface WorkflowPermissionModeInput extends WorkflowControlInput {
  readonly mode?: WorkflowPermissionMode
  readonly sessionMode?: WorkflowSessionPermissionMode | null
}

export const WORKFLOW_PERMISSION_ABANDONED_REASON =
  "The runtime stopped before the pending permission was answered."

export interface WorkflowTaskSessionRecovery {
  readonly runID: WorkflowRunID
  readonly taskID: WorkflowTaskID
  readonly attemptID: WorkflowTaskAttemptID
  readonly attempt: number
  readonly backgroundGeneration?: number
  readonly runnerManaged?: boolean
}

export interface WorkflowTaskSessionResumeInput {
  readonly sessionID: SessionID
  readonly backgroundGeneration?: number
}

export interface WorkflowTaskSessionFinishInput {
  readonly sessionID: SessionID
  readonly backgroundGeneration?: number
  readonly state: Extract<WorkflowTaskState, "completed" | "failed">
  readonly summary?: string
  readonly error?: string
}

export type Notification = {
  eventID: WorkflowEventID
  taskID: SessionID
  parentSessionID: SessionID
  generation: number
  revision: number
  state: Extract<WorkflowRunState, "completed" | "failed" | "stopped">
  title: string
  summary: string
  background: true
  runID: WorkflowRunID
}

export const Event = {
  RunWake: BusEvent.define(
    "workflow.run.wake",
    Schema.Struct({
      runID: WorkflowRunID,
    }),
  ),
  Notification: BusEvent.define(
    "workflow.notification",
    Schema.Struct({
      eventID: WorkflowEventID,
      taskID: SessionID,
      parentSessionID: SessionID,
      generation: Schema.Number,
      revision: Schema.Number,
      state: Schema.Literals(["completed", "failed", "stopped"]),
      title: Schema.String,
      summary: Schema.String,
      background: Schema.Literal(true),
      runID: WorkflowRunID,
    }),
  ),
}

export interface WorkflowTaskRetryInput extends WorkflowControlInput {
  readonly taskID: WorkflowTaskID
}

export interface WorkflowPhaseRetryInput extends WorkflowControlInput {
  readonly phaseID: WorkflowPhaseID
}

export interface WorkflowCompletionAuditClaimInput {
  readonly runID: WorkflowRunID
  readonly holder: string
  readonly leaseMs: number
  readonly candidateFingerprint?: string
}

export interface WorkflowCompletionAuditApplyInput {
  readonly runID: WorkflowRunID
  readonly holder: string
  readonly receipt: CompletionAuditReceipt
  readonly gates: readonly CompletionGate[]
  readonly usage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly cost?: number
  }
}

export interface Interface {
  readonly preview: (plan: WorkflowPlan) => Effect.Effect<WorkflowPlanPreview, WorkflowValidationError>
  readonly save: (
    input: WorkflowSaveInput,
  ) => Effect.Effect<WorkflowRevisionReceipt, WorkflowValidationError | WorkflowNotFoundError>
  readonly start: (
    input: WorkflowStartInput,
  ) => Effect.Effect<WorkflowSnapshot, WorkflowValidationError | WorkflowNotFoundError>
  readonly list: (limit?: number) => Effect.Effect<readonly WorkflowSnapshot[]>
  readonly show: (runID: WorkflowRunID) => Effect.Effect<WorkflowSnapshot, WorkflowNotFoundError>
  readonly setWorkspaceLease: (input: {
    readonly runID: WorkflowRunID
    readonly workspaceLease: WorkflowWorkspaceLease
  }) => Effect.Effect<WorkflowSnapshot, WorkflowNotFoundError>
  readonly events: (
    runID: WorkflowRunID,
    limit?: number,
  ) => Effect.Effect<readonly WorkflowEventSnapshot[], WorkflowNotFoundError>
  readonly artifacts: (
    runID: WorkflowRunID,
    limit?: number,
  ) => Effect.Effect<readonly WorkflowArtifact[], WorkflowNotFoundError>
  readonly pause: (
    input: WorkflowControlInput,
  ) => Effect.Effect<WorkflowSnapshot, WorkflowNotFoundError | WorkflowStateError>
  readonly resume: (
    input: WorkflowControlInput,
  ) => Effect.Effect<WorkflowSnapshot, WorkflowNotFoundError | WorkflowStateError>
  readonly wake: (runID: WorkflowRunID) => Effect.Effect<void>
  readonly stop: (
    input: WorkflowControlInput,
  ) => Effect.Effect<WorkflowSnapshot, WorkflowNotFoundError | WorkflowStateError>
  readonly setPermissionMode: (
    input: WorkflowPermissionModeInput,
  ) => Effect.Effect<WorkflowSnapshot, WorkflowNotFoundError | WorkflowStateError>
  readonly resumeTaskSession: (
    input: WorkflowTaskSessionResumeInput,
  ) => Effect.Effect<WorkflowTaskSessionRecovery | undefined>
  readonly finishTaskSession: (input: WorkflowTaskSessionFinishInput) => Effect.Effect<void>
  readonly remove: (runID: WorkflowRunID) => Effect.Effect<boolean, WorkflowNotFoundError | WorkflowStateError>
  readonly retryTask: (
    input: WorkflowTaskRetryInput,
  ) => Effect.Effect<WorkflowSnapshot, WorkflowNotFoundError | WorkflowStateError>
  readonly retryPhase: (
    input: WorkflowPhaseRetryInput,
  ) => Effect.Effect<WorkflowSnapshot, WorkflowNotFoundError | WorkflowStateError>
  readonly pendingNotifications: (parentSessionID?: SessionID) => Effect.Effect<Notification[]>
  readonly acknowledgeNotifications: (eventIDs: readonly string[]) => Effect.Effect<void>
  readonly publishTerminalNotification: (runID: WorkflowRunID) => Effect.Effect<void>
  readonly claimCompletionAudit: (
    input: WorkflowCompletionAuditClaimInput,
  ) => Effect.Effect<CompletionProgress | undefined, WorkflowNotFoundError>
  readonly applyCompletionAudit: (
    input: WorkflowCompletionAuditApplyInput,
  ) => Effect.Effect<WorkflowSnapshot, WorkflowNotFoundError | WorkflowStateError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowService") {}

const terminalStates = new Set<WorkflowRunState>(["completed", "failed", "stopped"])
const retryableStates = new Set(["failed", "blocked", "needs_input", "stopped"])

const usageFromData = (data: Record<string, unknown> | null | undefined): WorkflowUsageSnapshot | undefined => {
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

const addUsage = (
  left: WorkflowUsageSnapshot | undefined,
  right: WorkflowUsageSnapshot | undefined,
): WorkflowUsageSnapshot | undefined => {
  if (!left && !right) return undefined
  return {
    inputTokens: (left?.inputTokens ?? 0) + (right?.inputTokens ?? 0),
    outputTokens: (left?.outputTokens ?? 0) + (right?.outputTokens ?? 0),
    cost: (left?.cost ?? 0) + (right?.cost ?? 0),
  }
}

const unresolvedGate = (snapshot: WorkflowSnapshot) =>
  snapshot.gates.find((gate) => gate.kind === "approval" && gate.required && gate.state !== "pass" && gate.state !== "waived")

export const workflowCompletionCriteria = (plan: WorkflowPlan) =>
  plan.completion?.criteria?.length
    ? plan.completion.criteria.map((criterion) => ({ id: criterion.id, description: criterion.description }))
    : compileCompletionCriteria(plan.completionCriteria)

export const workflowCompletionTransition = (input: {
  readonly plan: WorkflowPlan
  readonly current?: CompletionProgress
  readonly finalTaskComplete: boolean
  readonly allPhasesSatisfied: boolean
  readonly now: number
}) => {
  const workSatisfied = input.finalTaskComplete && input.allPhasesSatisfied
  if (!workSatisfied) return { terminal: false, completion: input.current }
  const confirmation = input.plan.completion?.confirmation ?? (input.plan.completion ? "next-run" : "same-run")
  const transition = nextCompletionProgress({
    confirmation,
    workSatisfied,
    current: input.current,
    sourceID: input.plan.finalTaskID,
    now: input.now,
  })
  return { terminal: transition.terminal, completion: transition.progress ?? input.current }
}

const planValidation = (plan: WorkflowPlan) => {
  const result = validateWorkflowPlan(plan)
  if (!result.valid || !result.preview) return Effect.fail(new WorkflowValidationError(result.issues))
  return Effect.succeed(result.preview)
}

const planHash = (plan: WorkflowPlan) => createHash("sha256").update(JSON.stringify(plan)).digest("hex")

const definitionFromRow = (row: typeof WorkflowDefinitionTable.$inferSelect): WorkflowDefinition => ({
  id: WorkflowDefinitionID.make(row.id),
  projectID: row.project_id,
  name: row.name,
  description: row.description,
  source: row.source,
  ...(row.owner_session_id ? { ownerSessionID: row.owner_session_id } : {}),
  ...(row.current_revision === null ? {} : { currentRevision: row.current_revision ?? undefined }),
  saved: row.saved,
  createdAt: row.time_created,
  updatedAt: row.time_updated,
})

const revisionFromRow = (row: typeof WorkflowRevisionTable.$inferSelect): WorkflowRevision => ({
  id: WorkflowRevisionID.make(row.id),
  definitionID: WorkflowDefinitionID.make(row.definition_id),
  revision: row.revision,
  plan: row.plan,
  planHash: row.plan_hash,
  immutable: row.immutable,
  createdAt: row.time_created,
})

const runFromRow = (row: typeof WorkflowRunTable.$inferSelect): WorkflowRun => ({
  id: WorkflowRunID.make(row.id),
  definitionID: WorkflowDefinitionID.make(row.definition_id),
  revisionID: WorkflowRevisionID.make(row.revision_id),
  revision: row.revision,
  ...(row.origin_session_id ? { originSessionID: row.origin_session_id } : {}),
  ...(row.root_session_id ? { rootSessionID: row.root_session_id } : {}),
  ...(row.loop_id ? { loopID: row.loop_id } : {}),
  ...(row.loop_run_id ? { loopRunID: row.loop_run_id } : {}),
  ...(row.data.workspaceLease ? { workspaceLease: row.data.workspaceLease } : {}),
  ...(row.data.permissionMode ? { permissionMode: row.data.permissionMode } : {}),
  ...(row.data.sessionPermissionMode ? { sessionPermissionMode: row.data.sessionPermissionMode } : {}),
  ...(row.data.completion ? { completion: row.data.completion } : {}),
  state: row.state,
  ...(row.current_phase_id ? { currentPhaseID: WorkflowPhaseID.make(row.current_phase_id) } : {}),
  createdAt: row.time_created,
  updatedAt: row.time_updated,
})

const phaseFromRow = (row: typeof WorkflowPhaseTable.$inferSelect): WorkflowPhaseSnapshot => ({
  id: WorkflowPhaseID.make(row.id),
  ordinal: row.ordinal,
  name: row.name,
  ...(row.description ? { description: row.description } : {}),
  state: row.state,
  barrier: row.barrier,
  counts: {
    total: row.task_count,
    queued: row.queued_count,
    working: row.working_count,
    completed: row.completed_count,
    failed: row.failed_count,
    blocked: row.blocked_count,
  },
  ...(usageFromData(row.data) ? { usage: usageFromData(row.data) } : {}),
})

const taskFromRow = (
  row: typeof WorkflowTaskTable.$inferSelect,
  attempt?: typeof WorkflowTaskAttemptTable.$inferSelect,
): WorkflowTaskSnapshot => ({
  id: WorkflowTaskID.make(row.id),
  phaseID: WorkflowPhaseID.make(row.phase_id),
  name: row.name,
  kind: row.kind,
  prompt: row.prompt,
  dependsOn: [...row.depends_on],
  ...(row.inputs ? { inputs: [...row.inputs] } : {}),
  output: row.output,
  ...(row.model ? { model: row.model } : {}),
  ...(row.agent_profile ? { agentProfile: row.agent_profile } : {}),
  ...(row.allowed_tools ? { allowedTools: [...row.allowed_tools] } : {}),
  ...(row.workspace ? { workspace: row.workspace } : {}),
  ...(row.permissions ? { permissions: row.permissions } : {}),
  ...(row.retry ? { retry: row.retry } : {}),
  ...(row.budget ? { budget: row.budget } : {}),
  ...(row.map ? { map: row.map } : {}),
  state: row.state,
  attempt: row.attempt,
  ...(attempt?.background_task_id ? { sessionID: SessionID.make(attempt.background_task_id) } : {}),
  ...(row.time_started === null ? {} : { startedAt: row.time_started ?? undefined }),
  ...(row.time_ended === null ? {} : { completedAt: row.time_ended ?? undefined }),
  ...(typeof row.data?.blocker === "string" ? { blocker: row.data.blocker } : {}),
  ...(usageFromData(row.data) ? { usage: usageFromData(row.data) } : {}),
})

const artifactFromRow = (row: typeof WorkflowArtifactTable.$inferSelect): WorkflowArtifact => ({
  id: WorkflowArtifactID.make(row.id),
  runID: WorkflowRunID.make(row.run_id),
  ...(row.task_id ? { taskID: WorkflowTaskID.make(row.task_id) } : {}),
  kind: row.kind,
  summary: row.summary,
  status: row.status,
  schemaValidated: row.schema_validated,
  outputRefs: [...row.output_refs],
  evidence: [...row.evidence],
  ...(row.session_id ? { sessionID: row.session_id } : {}),
  ...(row.attempt === null ? {} : { attempt: row.attempt ?? undefined }),
  createdAt: row.time_created,
})

const eventFromRow = (row: typeof WorkflowEventTable.$inferSelect): WorkflowEventSnapshot => ({
  id: WorkflowEventID.make(row.id),
  sequence: row.sequence,
  level: row.level,
  type: row.type,
  title: row.title,
  summary: row.summary,
  createdAt: row.time_created,
  ...(row.data ? { data: row.data } : {}),
})

const gateFromRow = (row: typeof WorkflowGateTable.$inferSelect): WorkflowGateSnapshot => ({
  id: WorkflowGateID.make(row.id),
  ...(row.phase_id ? { phaseID: WorkflowPhaseID.make(row.phase_id) } : {}),
  ...(row.task_id ? { taskID: WorkflowTaskID.make(row.task_id) } : {}),
  state: row.state,
  required: row.required,
  ...(row.actor ? { actor: row.actor } : {}),
  ...(row.reason ? { reason: row.reason } : {}),
  kind: row.data?.kind === "completion" ? "completion" : "approval",
})

const boundedLimit = (value: number | undefined, fallback = 100) =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.min(500, Math.floor(value)))

const snapshotFromRows = (input: {
  run: typeof WorkflowRunTable.$inferSelect
  definition: typeof WorkflowDefinitionTable.$inferSelect
  revision: typeof WorkflowRevisionTable.$inferSelect
  phases: readonly (typeof WorkflowPhaseTable.$inferSelect)[]
  tasks: readonly (typeof WorkflowTaskTable.$inferSelect)[]
  attempts: readonly (typeof WorkflowTaskAttemptTable.$inferSelect)[]
  artifacts: readonly (typeof WorkflowArtifactTable.$inferSelect)[]
  events: readonly (typeof WorkflowEventTable.$inferSelect)[]
  gates: readonly (typeof WorkflowGateTable.$inferSelect)[]
}): WorkflowSnapshot => {
  const attempts = new Map(input.attempts.map((attempt) => [attempt.task_id, attempt]))
  return {
    definition: definitionFromRow(input.definition),
    revision: revisionFromRow(input.revision),
    run: runFromRow(input.run),
    preview: assertValidWorkflowPlan(input.revision.plan),
    phases: input.phases.map(phaseFromRow),
    tasks: input.tasks.map((task) => taskFromRow(task, attempts.get(task.id))),
    artifacts: input.artifacts.map(artifactFromRow),
    events: input.events.map(eventFromRow),
    gates: input.gates.map(gateFromRow),
    ...(usageFromData(input.run.data) ? { usage: usageFromData(input.run.data) } : {}),
  }
}

const runSnapshot = (
  db: Parameters<typeof Database.use>[0] extends (db: infer D) => unknown ? D : never,
  runID: WorkflowRunID,
  projectID: string,
) => {
  const run = db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, runID)).get()
  if (!run) return
  const definition = db
    .select()
    .from(WorkflowDefinitionTable)
    .where(eq(WorkflowDefinitionTable.id, run.definition_id))
    .get()
  if (!definition || definition.project_id !== projectID) return
  const revision = db.select().from(WorkflowRevisionTable).where(eq(WorkflowRevisionTable.id, run.revision_id)).get()
  if (!revision) return
  return snapshotFromRows({
    run,
    definition,
    revision,
    phases: db
      .select()
      .from(WorkflowPhaseTable)
      .where(eq(WorkflowPhaseTable.run_id, run.id))
      .orderBy(WorkflowPhaseTable.ordinal)
      .all(),
    tasks: db
      .select()
      .from(WorkflowTaskTable)
      .where(eq(WorkflowTaskTable.run_id, run.id))
      .orderBy(WorkflowTaskTable.id)
      .all(),
    attempts: db
      .select()
      .from(WorkflowTaskAttemptTable)
      .where(eq(WorkflowTaskAttemptTable.run_id, run.id))
      .orderBy(WorkflowTaskAttemptTable.attempt)
      .all(),
    artifacts: db
      .select()
      .from(WorkflowArtifactTable)
      .where(eq(WorkflowArtifactTable.run_id, run.id))
      .orderBy(desc(WorkflowArtifactTable.sequence))
      .limit(500)
      .all(),
    events: db
      .select()
      .from(WorkflowEventTable)
      .where(eq(WorkflowEventTable.run_id, run.id))
      .orderBy(desc(WorkflowEventTable.sequence))
      .limit(500)
      .all(),
    gates: db.select().from(WorkflowGateTable).where(eq(WorkflowGateTable.run_id, run.id)).all(),
  })
}

const appendEvent = (
  db: Parameters<typeof Database.use>[0] extends (db: infer D) => unknown ? D : never,
  runID: WorkflowRunID,
  type: WorkflowEventSnapshot["type"],
  title: string,
  summary: string,
  data?: Record<string, unknown>,
) => {
  const sequence =
    (db
      .select({ value: max(WorkflowEventTable.sequence) })
      .from(WorkflowEventTable)
      .where(eq(WorkflowEventTable.run_id, runID))
      .get()?.value ?? 0) + 1
  db.insert(WorkflowEventTable)
    .values({
      id: WorkflowEventID.make(),
      run_id: runID,
      sequence,
      level: "info",
      type: type as never,
      title,
      summary,
      time_created: Date.now(),
      time_updated: Date.now(),
      data,
    })
    .run()
}

type WorkflowDB = Parameters<typeof Database.use>[0] extends (db: infer D) => unknown ? D : never

const workflowPhaseBarrierSatisfied = (
  phase: typeof WorkflowPhaseTable.$inferSelect,
  tasks: readonly (typeof WorkflowTaskTable.$inferSelect)[],
) => {
  const phaseTasks = tasks.filter((task) => task.phase_id === phase.id)
  const completed = phaseTasks.filter((task) => task.state === "completed").length
  if (phase.barrier.kind === "all") return phaseTasks.length > 0 && completed === phaseTasks.length
  if (phase.barrier.kind === "quorum") return completed >= phase.barrier.quorum
  if (phase.barrier.kind === "best-effort") {
    return phaseTasks.length > 0 && phaseTasks.every((task) =>
      ["completed", "failed", "blocked", "stopped"].includes(task.state),
    )
  }
  const expression = phase.barrier.expression.trim().toLowerCase()
  if (expression === "true" || expression === "all" || expression === "completed") {
    return phaseTasks.length > 0 && completed === phaseTasks.length
  }
  return false
}

export const reconcileWorkflowSessionState = (db: WorkflowDB, runID: WorkflowRunID, now: number) => {
  const phases = db.select().from(WorkflowPhaseTable).where(eq(WorkflowPhaseTable.run_id, runID)).orderBy(WorkflowPhaseTable.ordinal).all()
  const tasks = db.select().from(WorkflowTaskTable).where(eq(WorkflowTaskTable.run_id, runID)).all()
  const phaseStates = new Map<string, WorkflowPhaseState>()

  for (const phase of phases) {
    const phaseTasks = tasks.filter((task) => task.phase_id === phase.id)
    const counts = {
      total: phaseTasks.length,
      queued: phaseTasks.filter((task) => task.state === "queued").length,
      working: phaseTasks.filter((task) => task.state === "working").length,
      completed: phaseTasks.filter((task) => task.state === "completed").length,
      failed: phaseTasks.filter((task) => task.state === "failed").length,
      blocked: phaseTasks.filter((task) => task.state === "blocked" || task.state === "stopped").length,
    }
    const state: WorkflowPhaseState = workflowPhaseBarrierSatisfied(phase, tasks)
      ? "completed"
      : phaseTasks.some((task) => task.state === "needs_input")
        ? "needs_input"
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
        ...(state === "completed" || state === "failed" || state === "blocked" ? { time_ended: now } : { time_ended: null }),
        time_updated: now,
      })
      .where(and(eq(WorkflowPhaseTable.run_id, runID), eq(WorkflowPhaseTable.id, phase.id)))
      .run()
  }

  const run = db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, runID)).get()
  if (!run) return
  const revision = db.select().from(WorkflowRevisionTable).where(eq(WorkflowRevisionTable.id, run.revision_id)).get()
  const finalTask = revision
    ? tasks.find((task) => task.id === revision.plan.finalTaskID)
    : undefined
  const allPhasesSatisfied = phases.length > 0 && phases.every((phase) => workflowPhaseBarrierSatisfied(phase, tasks))
  const completion = revision
    ? workflowCompletionTransition({
        plan: revision.plan,
        current: run.data.completion,
        finalTaskComplete: finalTask?.state === "completed",
        allPhasesSatisfied,
        now,
      })
    : { terminal: false, completion: run.data.completion }
  const computedState: WorkflowRunState = completion.terminal
    ? "completed"
    : tasks.some((task) => task.state === "needs_input")
      ? "needs_input"
      : [...phaseStates.values()].some((state) => state === "failed")
        ? "failed"
        : [...phaseStates.values()].some((state) => state === "blocked")
          ? "blocked"
          : tasks.some((task) => task.state === "working")
            ? "working"
            : tasks.some((task) => task.state === "queued" || task.state === "pending")
              ? "queued"
              : finalTask?.state === "completed" && allPhasesSatisfied && completion.completion?.status === "candidate"
                ? "working"
              : run.state
  const nextState: WorkflowRunState = run.state === "stopped"
    ? "stopped"
    : run.state === "blocked"
      ? "blocked"
      : run.state === "paused" && !completion.terminal
        ? "paused"
        : computedState
  const currentPhase = phases.find((phase) => !["completed", "stopped"].includes(phaseStates.get(phase.id) ?? phase.state))
  db.update(WorkflowRunTable)
    .set({
      state: nextState,
      current_phase_id: currentPhase?.id ?? null,
      time_updated: now,
      data: { ...run.data, completion: completion.completion },
      ...(nextState === "completed" || nextState === "failed" ? { time_ended: now } : { time_ended: null }),
    })
    .where(eq(WorkflowRunTable.id, runID))
    .run()
  if (run.state !== nextState && (nextState === "completed" || nextState === "failed")) {
    const title = nextState === "completed" ? "Workflow completed" : "Workflow failed"
    appendEvent(db, runID, nextState === "completed" ? "workflow.run.completed" : "workflow.run.failed", title, title, {
      terminal: true,
      background: true,
      state: nextState,
    })
  }
  return { state: nextState, previousState: run.state }
}

type WorkflowTaskSessionMatch = {
  readonly attempt: typeof WorkflowTaskAttemptTable.$inferSelect
  readonly task: typeof WorkflowTaskTable.$inferSelect
  readonly run: typeof WorkflowRunTable.$inferSelect
  readonly definition: typeof WorkflowDefinitionTable.$inferSelect
}

const workflowTaskSession = (db: WorkflowDB, sessionID: SessionID, projectID: string): WorkflowTaskSessionMatch | undefined => {
  const attempts = db
    .select()
    .from(WorkflowTaskAttemptTable)
    .where(eq(WorkflowTaskAttemptTable.background_task_id, sessionID))
    .all()
    .toSorted((left, right) => right.attempt - left.attempt)

  for (const attempt of attempts) {
    const run = db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, attempt.run_id)).get()
    if (!run) continue
    const definition = db
      .select()
      .from(WorkflowDefinitionTable)
      .where(eq(WorkflowDefinitionTable.id, run.definition_id))
      .get()
    if (!definition || definition.project_id !== projectID) continue
    const task = db
      .select()
      .from(WorkflowTaskTable)
      .where(and(eq(WorkflowTaskTable.run_id, run.id), eq(WorkflowTaskTable.id, attempt.task_id)))
      .get()
    if (!task) continue
    return { attempt, task, run, definition }
  }
}

const notificationFromEvent = (
  db: Parameters<typeof Database.use>[0] extends (db: infer D) => unknown ? D : never,
  event: typeof WorkflowEventTable.$inferSelect,
): Notification | undefined => {
  const state = event.data?.state
  if (event.data?.terminal !== true || event.data.notificationAcknowledgedAt !== undefined) return
  if (state !== "completed" && state !== "failed" && state !== "stopped") return
  const run = db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, event.run_id)).get()
  if (!run?.origin_session_id) return
  const definition = db
    .select()
    .from(WorkflowDefinitionTable)
    .where(eq(WorkflowDefinitionTable.id, run.definition_id))
    .get()
  if (!definition) return
  return {
    eventID: event.id,
    taskID: run.root_session_id ?? run.origin_session_id,
    parentSessionID: run.origin_session_id,
    generation: 0,
    revision: event.sequence,
    state,
    title: definition.name,
    summary: event.summary,
    background: true,
    runID: run.id,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const preview = Effect.fn("WorkflowService.preview")(function* (plan: WorkflowPlan) {
      return yield* planValidation(plan)
    })

    const save = Effect.fn("WorkflowService.save")(function* (input: WorkflowSaveInput) {
      const preview = yield* planValidation(input.plan)
      const project = yield* InstanceState.context
      const now = Date.now()
      const definitionID = input.definitionID ?? WorkflowDefinitionID.make()
      const receipt = Database.transaction((db) => {
        const current = db
          .select()
          .from(WorkflowDefinitionTable)
          .where(eq(WorkflowDefinitionTable.id, definitionID))
          .get()
        if (current && current.project_id !== project.project.id) throw new WorkflowNotFoundError(definitionID)
        const revision = (current?.current_revision ?? 0) + 1
        const revisionID = WorkflowRevisionID.make()
        if (!current) {
          db.insert(WorkflowDefinitionTable)
            .values({
              id: definitionID,
              project_id: project.project.id,
              name: input.name ?? input.plan.name,
              description: input.description ?? input.plan.description,
              source: input.source ?? "manual",
              owner_session_id: input.ownerSessionID,
              current_revision: revision,
              saved: input.saved ?? true,
              time_created: now,
              time_updated: now,
            })
            .run()
        } else {
          db.update(WorkflowDefinitionTable)
            .set({
              name: input.name ?? current.name,
              description: input.description ?? current.description,
              current_revision: revision,
              saved: input.saved ?? current.saved,
              time_updated: now,
            })
            .where(eq(WorkflowDefinitionTable.id, definitionID))
            .run()
        }
        db.insert(WorkflowRevisionTable)
          .values({
            id: revisionID,
            definition_id: definitionID,
            revision,
            plan_hash: planHash(input.plan),
            plan: input.plan,
            immutable: true,
            time_created: now,
            time_updated: now,
          })
          .run()
        return { definitionID, revisionID, revision }
      })
      return { ...receipt, plan: input.plan, preview }
    })

    const show = Effect.fn("WorkflowService.show")(function* (runID: WorkflowRunID) {
      const project = yield* InstanceState.context
      const snapshot = Database.use((db) => runSnapshot(db, runID, project.project.id))
      if (!snapshot) return yield* Effect.fail(new WorkflowNotFoundError(runID))
      return snapshot
    })

    const setWorkspaceLease = Effect.fn("WorkflowService.setWorkspaceLease")(function* (input: {
      readonly runID: WorkflowRunID
      readonly workspaceLease: WorkflowWorkspaceLease
    }) {
      const current = yield* show(input.runID)
      const existing = current.run.workspaceLease
      if (
        existing?.id === input.workspaceLease.id &&
        existing.mode === input.workspaceLease.mode &&
        existing.path === input.workspaceLease.path &&
        existing.branch === input.workspaceLease.branch &&
        existing.state === input.workspaceLease.state &&
        existing.managed === input.workspaceLease.managed &&
        existing.createdAt === input.workspaceLease.createdAt &&
        existing.error === input.workspaceLease.error
      ) {
        return current
      }
      const now = Date.now()
      Database.transaction((db) => {
        const row = db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, input.runID)).get()
        if (!row) throw new WorkflowNotFoundError(input.runID)
        db.update(WorkflowRunTable)
          .set({
            time_updated: now,
            data: { ...row.data, workspaceLease: input.workspaceLease },
          })
          .where(eq(WorkflowRunTable.id, input.runID))
          .run()
        appendEvent(
          db,
          input.runID,
          "workflow.run.updated",
          "Workflow workspace updated",
          `Workflow workspace is ${input.workspaceLease.state}`,
          { workspaceLease: input.workspaceLease },
        )
      })
      return yield* show(current.run.id)
    })

    const start = Effect.fn("WorkflowService.start")(function* (input: WorkflowStartInput) {
      const project = yield* InstanceState.context
      let receipt: WorkflowRevisionReceipt
      if (input.revisionID || input.definitionID) {
        const saved = Database.use((db) => {
          const definition = input.definitionID
            ? db.select().from(WorkflowDefinitionTable).where(eq(WorkflowDefinitionTable.id, input.definitionID)).get()
            : undefined
          if (definition && definition.project_id !== project.project.id) return
          const revision = input.revisionID
            ? db.select().from(WorkflowRevisionTable).where(eq(WorkflowRevisionTable.id, input.revisionID)).get()
            : definition?.current_revision
              ? db
                  .select()
                  .from(WorkflowRevisionTable)
                  .where(
                    and(
                      eq(WorkflowRevisionTable.definition_id, definition.id),
                      eq(WorkflowRevisionTable.revision, definition.current_revision),
                    ),
                  )
                  .get()
              : undefined
          if (!revision) return
          const revisionDefinition =
            definition ??
            db
              .select()
              .from(WorkflowDefinitionTable)
              .where(eq(WorkflowDefinitionTable.id, revision.definition_id))
              .get()
          if (!revisionDefinition || revisionDefinition.project_id !== project.project.id) return
          return { revision, definition: revisionDefinition }
        })
        if (!saved) return yield* Effect.fail(new WorkflowNotFoundError(input.revisionID ?? input.definitionID!))
        const planPreview = yield* planValidation(saved.revision.plan)
        receipt = {
          definitionID: WorkflowDefinitionID.make(saved.definition.id),
          revisionID: WorkflowRevisionID.make(saved.revision.id),
          revision: saved.revision.revision,
          plan: saved.revision.plan,
          preview: planPreview,
        }
      } else {
        if (!input.plan)
          return yield* Effect.fail(
            new WorkflowValidationError([
              { code: "missing-reference", message: "start requires a plan or revisionID", path: ["plan"] },
            ]),
          )
        receipt = yield* save({
          plan: input.plan,
          name: input.name,
          description: input.description,
          source: input.source ?? "session-generated",
          ownerSessionID: input.originSessionID,
          saved: false,
        })
      }

      const overlapKey = input.overlapKey?.trim() || undefined
      if (overlapKey) {
        const existing = Database.use((db) =>
          db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.overlap_key, overlapKey)).get(),
        )
        if (existing) return yield* show(WorkflowRunID.make(existing.id))
      }

      const runID = WorkflowRunID.make()
      const now = Date.now()
      const runState: WorkflowRunState = receipt.plan.requiredGates.length ? "awaiting_approval" : "queued"
      Database.transaction((db) => {
        db.insert(WorkflowRunTable)
          .values({
            id: runID,
            definition_id: receipt.definitionID,
            revision_id: receipt.revisionID,
            revision: receipt.revision,
            origin_session_id: input.originSessionID,
            loop_id: input.loopID,
            loop_run_id: input.loopRunID,
            state: runState,
            overlap_key: overlapKey,
            time_created: now,
            time_updated: now,
            data: { counts: { phases: receipt.plan.phases.length, tasks: receipt.plan.tasks.length } },
          })
          .run()
        for (const phase of receipt.plan.phases) {
          db.insert(WorkflowPhaseTable)
            .values({
              run_id: runID,
              id: phase.id,
              ordinal: phase.ordinal,
              name: phase.name,
              description: phase.description,
              state: "pending",
              barrier: phase.barrier,
              task_count: phase.taskIDs.length,
              time_created: now,
              time_updated: now,
            })
            .run()
        }
        for (const task of receipt.plan.tasks) {
          db.insert(WorkflowTaskTable)
            .values({
              run_id: runID,
              id: task.id,
              phase_id: task.phaseID,
              name: task.name,
              kind: task.kind,
              prompt: task.prompt,
              state: "pending",
              depends_on: task.dependsOn,
              inputs: task.inputs,
              output: task.output,
              model: task.model,
              agent_profile: task.agentProfile,
              allowed_tools: task.allowedTools,
              workspace: task.workspace,
              permissions: task.permissions,
              retry: task.retry,
              budget: task.budget,
              map: task.map,
              time_created: now,
              time_updated: now,
            })
            .run()
          for (const dependency of task.dependsOn) {
            db.insert(WorkflowTaskDependencyTable)
              .values({ run_id: runID, task_id: task.id, depends_on_task_id: dependency })
              .run()
          }
        }
        for (const gate of receipt.plan.requiredGates) {
          db.insert(WorkflowGateTable)
            .values({
              run_id: runID,
              id: WorkflowGateID.make(),
              state: "pending",
              required: true,
              reason: gate,
              time_created: now,
              time_updated: now,
              data: { key: gate },
            })
            .run()
        }
        appendEvent(
          db,
          runID,
          "workflow.run.created",
          runState === "awaiting_approval" ? "Workflow awaiting approval" : "Workflow queued",
          `Workflow ${receipt.plan.name} ${runState === "awaiting_approval" ? "awaits approval" : "queued"}`,
          {
            actor: "workflow-service",
            overlapKey,
            requiredGates: receipt.plan.requiredGates,
          },
        )
      })
      return yield* show(runID)
    })

    const list = Effect.fn("WorkflowService.list")(function* (limit?: number) {
      const project = yield* InstanceState.context
      const rows = Database.use((db) =>
        db
          .select({ run: WorkflowRunTable, definition: WorkflowDefinitionTable, revision: WorkflowRevisionTable })
          .from(WorkflowRunTable)
          .innerJoin(WorkflowDefinitionTable, eq(WorkflowDefinitionTable.id, WorkflowRunTable.definition_id))
          .innerJoin(WorkflowRevisionTable, eq(WorkflowRevisionTable.id, WorkflowRunTable.revision_id))
          .where(eq(WorkflowDefinitionTable.project_id, project.project.id))
          .orderBy(desc(WorkflowRunTable.time_updated))
          .limit(boundedLimit(limit))
          .all(),
      )
      return rows.flatMap((row) => {
        const snapshot = Database.use((db) => runSnapshot(db, WorkflowRunID.make(row.run.id), project.project.id))
        return snapshot ? [snapshot] : []
      })
    })

    const pendingNotifications = Effect.fn("WorkflowService.pendingNotifications")(function* (
      parentSessionID?: SessionID,
    ) {
      const project = yield* InstanceState.context
      return Database.use((db) =>
        db
          .select()
          .from(WorkflowEventTable)
          .all()
          .flatMap((event) => {
            const notification = notificationFromEvent(db, event)
            if (!notification) return []
            if (parentSessionID !== undefined && notification.parentSessionID !== parentSessionID) return []
            const parent = db
              .select({ directory: SessionTable.directory })
              .from(SessionTable)
              .where(eq(SessionTable.id, notification.parentSessionID))
              .get()
            return parent?.directory === project.directory ? [notification] : []
          })
          .toSorted((left, right) => left.eventID.localeCompare(right.eventID)),
      )
    })

    const acknowledgeNotifications = Effect.fn("WorkflowService.acknowledgeNotifications")(
      (eventIDs: readonly string[]) =>
        Effect.sync(() => {
          if (eventIDs.length === 0) return
          const now = Date.now()
          Database.transaction((db) => {
            for (const eventID of new Set(eventIDs)) {
              const id = WorkflowEventID.make(eventID)
              const event = db.select().from(WorkflowEventTable).where(eq(WorkflowEventTable.id, id)).get()
              if (!event || event.data?.terminal !== true) continue
              db.update(WorkflowEventTable)
                .set({
                  data: { ...event.data, notificationAcknowledgedAt: now },
                  time_updated: now,
                })
                .where(eq(WorkflowEventTable.id, id))
                .run()
            }
          })
        }),
    )

    const publishTerminalNotification = Effect.fn("WorkflowService.publishTerminalNotification")(function* (
      runID: WorkflowRunID,
    ) {
      const result = Database.use(
        (db) =>
          db
            .select()
            .from(WorkflowEventTable)
            .where(eq(WorkflowEventTable.run_id, runID))
            .orderBy(desc(WorkflowEventTable.sequence))
            .all()
            .flatMap((event) => {
              const notification = notificationFromEvent(db, event)
              return notification ? [{ event, notification }] : []
            })[0],
      )
      if (!result) return
      yield* bus.publish(Event.Notification, result.notification, { id: result.event.id })
      const now = Date.now()
      Database.use((db) =>
        db
          .update(WorkflowEventTable)
          .set({
            data: { ...result.event.data, notificationDeliveredAt: now },
            time_updated: now,
          })
          .where(eq(WorkflowEventTable.id, result.event.id))
          .run(),
      )
    })

    const events = Effect.fn("WorkflowService.events")(function* (runID: WorkflowRunID, limit?: number) {
      const snapshot = yield* show(runID)
      return snapshot.events.slice(0, boundedLimit(limit))
    })

    const artifacts = Effect.fn("WorkflowService.artifacts")(function* (runID: WorkflowRunID, limit?: number) {
      const snapshot = yield* show(runID)
      return snapshot.artifacts.slice(0, boundedLimit(limit))
    })

    const claimCompletionAudit = Effect.fn("WorkflowService.claimCompletionAudit")(function* (
      input: WorkflowCompletionAuditClaimInput,
    ) {
      yield* show(input.runID)
      const now = Date.now()
      return Database.transaction((db) => {
        const run = db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, input.runID)).get()
        if (!run) throw new WorkflowNotFoundError(input.runID)
        const current = run.data.completion
        if (run.state !== "queued" && run.state !== "working") return
        if (!current || (current.status !== "candidate" && current.status !== "auditing")) return
        if (current.status === "auditing" && current.auditLease?.holder === input.holder) {
          const progress: CompletionProgress = {
            ...current,
            auditLease: { holder: input.holder, expiresAt: now + Math.max(5_000, input.leaseMs) },
            updatedAt: now,
          }
          db.update(WorkflowRunTable)
            .set({
              state: "working",
              time_ended: null,
              time_updated: now,
              data: { ...run.data, completion: progress, blocker: undefined, nextAction: "Run the fresh completion audit." },
            })
            .where(eq(WorkflowRunTable.id, input.runID))
            .run()
          return progress
        }
        if (current.status === "auditing" && (current.auditLease?.expiresAt ?? 0) > now) return
        const progress: CompletionProgress = {
          ...current,
          status: "auditing",
          auditAttempts: current.auditAttempts + 1,
          candidateFingerprint: current.candidateFingerprint ?? input.candidateFingerprint,
          auditLease: { holder: input.holder, expiresAt: now + Math.max(5_000, input.leaseMs) },
          updatedAt: now,
        }
        db.update(WorkflowRunTable)
          .set({
            state: "working",
            time_ended: null,
            time_updated: now,
            data: { ...run.data, completion: progress, blocker: undefined, nextAction: "Run the fresh completion audit." },
          })
          .where(eq(WorkflowRunTable.id, input.runID))
          .run()
        appendEvent(
          db,
          input.runID,
          "workflow.run.updated",
          "Completion audit claimed",
          `Completion candidate generation ${progress.generation} is being audited`,
          { generation: progress.generation, attempt: progress.auditAttempts },
        )
        return progress
      }, { behavior: "immediate" })
    })

    const applyCompletionAudit = Effect.fn("WorkflowService.applyCompletionAudit")(function* (
      input: WorkflowCompletionAuditApplyInput,
    ) {
      yield* show(input.runID)
      const result = Database.transaction((db) => {
        const run = db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, input.runID)).get()
        if (!run) throw new WorkflowNotFoundError(input.runID)
        const revision = db.select().from(WorkflowRevisionTable).where(eq(WorkflowRevisionTable.id, run.revision_id)).get()
        if (!revision) throw new WorkflowNotFoundError(run.revision_id)
        const progress = run.data.completion
        const now = Date.now()
        if (
          !progress ||
          progress.status !== "auditing" ||
          progress.auditLease?.holder !== input.holder ||
          (progress.auditLease.expiresAt ?? 0) <= now
        ) {
          throw new WorkflowStateError(input.runID, "Completion audit claim is stale or owned by another runner")
        }
        const criteria = workflowCompletionCriteria(revision.plan)
        const completionUsage = addUsage(run.data.completionUsage, input.usage)
        const totalUsage = addUsage(usageFromData(run.data), input.usage)
        const totalTokens = (totalUsage?.inputTokens ?? 0) + (totalUsage?.outputTokens ?? 0)
        const budget = revision.plan.budget
        const budgetGates: CompletionGate[] = []
        if (budget?.maxTokens !== undefined && totalTokens >= budget.maxTokens) {
          budgetGates.push({ id: "budget:tokens", status: "blocked", summary: `Workflow token budget exhausted during completion audit (${totalTokens}/${budget.maxTokens}).` })
        }
        if (budget?.maxCost !== undefined && (totalUsage?.cost ?? 0) >= budget.maxCost) {
          budgetGates.push({ id: "budget:cost", status: "blocked", summary: `Workflow cost budget exhausted during completion audit (${totalUsage?.cost ?? 0}/${budget.maxCost}).` })
        }
        if (budget?.maxRuntimeMs !== undefined && run.time_started !== null && now - run.time_started >= budget.maxRuntimeMs) {
          budgetGates.push({ id: "budget:runtime", status: "blocked", summary: `Workflow runtime budget exhausted during completion audit (${now - run.time_started}/${budget.maxRuntimeMs}ms).` })
        }
        const completionGates = [...input.gates, ...budgetGates]
        let decision: CompletionAuditDecision = decideCompletionAudit({
          progress,
          receipt: input.receipt,
          criteria,
          gates: completionGates,
          maxAuditAttempts: Math.max(1, revision.plan.completion?.maxAuditAttempts ?? 2),
        })
        const repairOwners = new Set<string>()
        if (decision.outcome === "retry-work") {
          const configuredOwners = new Map(
            (revision.plan.completion?.criteria ?? []).map((criterion) => [criterion.id, criterion.ownerTaskIDs ?? []]),
          )
          const failedCriteria = decision.failedCriteria.length
            ? decision.failedCriteria
            : [...configuredOwners.keys()]
          for (const criterionID of failedCriteria) {
            for (const owner of configuredOwners.get(criterionID) ?? []) repairOwners.add(owner)
          }
          if (repairOwners.size === 0) {
            decision = {
              outcome: "blocked",
              summary: `${decision.summary} No completion criterion declares a repair owner, so MendCode will not guess which workflow tasks to rerun.`,
            }
          }
        }
        const nextProgress: CompletionProgress = {
          ...progress,
          status: decision.outcome === "complete"
            ? "passed"
            : decision.outcome === "retry-work"
              ? "rejected"
              : decision.outcome === "retry-audit"
                ? "candidate"
                : "blocked",
          ...(decision.outcome === "retry-work" ? { failedCriteria: [...decision.failedCriteria] } : {}),
          receipt: input.receipt,
          auditLease: undefined,
          summary: decision.summary,
          updatedAt: now,
        }

        const gateRows = [
          ...completionGates.map((gate) => ({
            id: `completion-gate-${createHash("sha256").update(gate.id).digest("hex").slice(0, 16)}`,
            state: gate.status === "pass" || gate.status === "waived"
              ? "pass" as const
              : gate.status === "awaiting_approval"
                ? "awaiting_approval" as const
                : gate.status === "blocked"
                  ? "blocked" as const
                  : "fail" as const,
            reason: gate.summary ?? gate.id,
            key: gate.id,
          })),
          ...input.receipt.criteria.map((criterion) => ({
            id: `completion-${criterion.id}`,
            state: criterion.status === "pass"
              ? "pass" as const
              : criterion.status === "needs_human"
                ? "awaiting_approval" as const
                : criterion.status === "blocked" || criterion.status === "uncertain"
                  ? "blocked" as const
                  : "fail" as const,
            reason: criterion.summary,
            key: criterion.id,
          })),
        ]
        for (const gate of gateRows) {
          const id = WorkflowGateID.make(gate.id)
          const existing = db.select().from(WorkflowGateTable).where(and(eq(WorkflowGateTable.run_id, input.runID), eq(WorkflowGateTable.id, id))).get()
          if (existing) {
            db.update(WorkflowGateTable)
              .set({ state: gate.state, reason: gate.reason, time_updated: now, data: { ...existing.data, kind: "completion", key: gate.key, generation: progress.generation } })
              .where(and(eq(WorkflowGateTable.run_id, input.runID), eq(WorkflowGateTable.id, id)))
              .run()
          } else {
            db.insert(WorkflowGateTable).values({
              run_id: input.runID,
              id,
              state: gate.state,
              required: true,
              reason: gate.reason,
              time_created: now,
              time_updated: now,
              data: { kind: "completion", key: gate.key, generation: progress.generation },
            }).run()
          }
        }

        const sequence = (db.select({ value: max(WorkflowArtifactTable.sequence) }).from(WorkflowArtifactTable).where(eq(WorkflowArtifactTable.run_id, input.runID)).get()?.value ?? 0) + 1
        db.insert(WorkflowArtifactTable).values({
          id: WorkflowArtifactID.make(),
          run_id: input.runID,
          sequence,
          kind: "completion-audit",
          summary: decision.summary,
          status: decision.outcome === "complete" ? "valid" : "invalid",
          schema_validated: true,
          output_refs: [],
          evidence: input.receipt.criteria.flatMap((criterion) => criterion.evidence.map((evidence) => evidence.summary)),
          time_created: now,
          time_updated: now,
          data: { receipt: input.receipt, decision, gates: completionGates, usage: input.usage },
        }).run()

        if (decision.outcome === "retry-work") {
          const tasks = db.select().from(WorkflowTaskTable).where(eq(WorkflowTaskTable.run_id, input.runID)).all()
          const affected = new Set<string>(repairOwners)
          let expanded = true
          while (expanded) {
            expanded = false
            for (const task of tasks) {
              if (affected.has(task.id) || !task.depends_on.some((dependency) => affected.has(dependency))) continue
              affected.add(task.id)
              expanded = true
            }
          }
          for (const taskID of affected) {
            const task = tasks.find((candidate) => candidate.id === taskID)
            db.update(WorkflowTaskTable)
              .set({
                state: "pending",
                time_started: null,
                time_ended: null,
                time_updated: now,
                data: { ...task?.data, blocker: undefined, retryAt: undefined },
              })
              .where(and(eq(WorkflowTaskTable.run_id, input.runID), eq(WorkflowTaskTable.id, WorkflowTaskID.make(taskID))))
              .run()
            db.update(WorkflowArtifactTable)
              .set({ status: "invalid", time_updated: now })
              .where(and(eq(WorkflowArtifactTable.run_id, input.runID), eq(WorkflowArtifactTable.task_id, WorkflowTaskID.make(taskID))))
              .run()
          }
        }

        const nextState: WorkflowRunState = decision.outcome === "complete"
          ? "completed"
          : decision.outcome === "retry-work"
            ? "queued"
            : decision.outcome === "retry-audit"
              ? "working"
              : decision.outcome === "needs-input"
                ? "needs_input"
                : "blocked"
        db.update(WorkflowRunTable)
          .set({
            state: nextState,
            time_updated: now,
            time_ended: nextState === "completed" ? now : null,
            data: {
              ...run.data,
              completion: nextProgress,
              completionUsage,
              usage: totalUsage,
              blocker: nextState === "blocked" || nextState === "needs_input" ? decision.summary : undefined,
              nextAction: decision.outcome === "retry-work"
                ? "Rerun the tasks that own failed completion criteria and their descendants."
                : decision.outcome === "retry-audit"
                  ? "Retry the fresh completion audit."
                  : undefined,
            },
          })
          .where(eq(WorkflowRunTable.id, input.runID))
          .run()
        if (decision.outcome === "retry-work") reconcileWorkflowSessionState(db, input.runID, now)
        appendEvent(
          db,
          input.runID,
          decision.outcome === "complete" ? "workflow.run.completed" : "workflow.run.updated",
          decision.outcome === "complete" ? "Workflow completion verified" : "Workflow completion audit did not close the run",
          decision.summary,
          {
            terminal: decision.outcome === "complete",
            background: decision.outcome === "complete",
            state: nextState,
            outcome: decision.outcome,
            generation: progress.generation,
            failedCriteria: decision.outcome === "retry-work" ? decision.failedCriteria : [],
          },
        )
        return { nextState, decision }
      }, { behavior: "immediate" })
      if (result.nextState === "queued" || result.nextState === "working") {
        yield* bus.publish(Event.RunWake, { runID: input.runID })
      }
      if (result.nextState === "completed") {
        yield* publishTerminalNotification(input.runID).pipe(Effect.catchCause(() => Effect.void))
      }
      return yield* show(input.runID)
    })

    const updateState = Effect.fn("WorkflowService.updateState")(function* (
      input: WorkflowControlInput,
      state: WorkflowRunState,
    ) {
      const current = yield* show(input.runID)
      if (current.run.state === state) return current
      if (terminalStates.has(current.run.state))
        return yield* Effect.fail(
          new WorkflowStateError(input.runID, `Workflow is already terminal: ${current.run.state}`),
        )
      if (state === "queued" && current.run.state === "working") {
        yield* bus.publish(Event.RunWake, { runID: input.runID })
        return current
      }
      if (state === "queued") {
        const gate = unresolvedGate(current)
        if (gate)
          return yield* Effect.fail(
            new WorkflowStateError(input.runID, `Required gate is not satisfied: ${gate.reason ?? gate.id}`),
          )
      }
      const now = Date.now()
      Database.transaction((db) => {
        const persisted = db
          .select({ data: WorkflowRunTable.data })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, input.runID))
          .get()
        db.update(WorkflowRunTable)
          .set({
            state,
            time_updated: now,
            ...(state === "stopped" ? { time_ended: now } : {}),
            data: { ...persisted?.data, ...(input.reason ? { blocker: input.reason } : {}) },
          })
          .where(eq(WorkflowRunTable.id, input.runID))
          .run()
        const title =
          state === "paused" ? "Workflow paused" : state === "queued" ? "Workflow resumed" : "Workflow stopped"
        appendEvent(
          db,
          input.runID,
          state === "stopped" ? "workflow.run.stopped" : "workflow.run.updated",
          title,
          input.reason ?? title,
          {
            actor: input.actor ?? "user",
            reason: input.reason,
            ...(state === "stopped" ? { terminal: true, background: true, state } : {}),
          },
        )
      })
      if (state === "stopped") yield* publishTerminalNotification(input.runID)
      return yield* show(input.runID)
    })

    const pause = (input: WorkflowControlInput) => updateState(input, "paused")
    const resume = (input: WorkflowControlInput) => updateState(input, "queued")
    const wake = Effect.fn("WorkflowService.wake")((runID: WorkflowRunID) =>
      bus.publish(Event.RunWake, { runID }),
    )
    const stop = (input: WorkflowControlInput) => updateState(input, "stopped")

    const setPermissionMode = Effect.fn("WorkflowService.setPermissionMode")(function* (
      input: WorkflowPermissionModeInput,
    ) {
      const current = yield* show(input.runID)
      if (terminalStates.has(current.run.state)) {
        return yield* Effect.fail(
          new WorkflowStateError(input.runID, `Workflow is already terminal: ${current.run.state}`),
        )
      }
      if (input.mode === undefined && input.sessionMode === undefined) return current
      const unchanged =
        (input.mode === undefined || current.run.permissionMode === input.mode) &&
        (input.sessionMode === undefined ||
          (input.sessionMode === null
            ? current.run.sessionPermissionMode === undefined
            : current.run.sessionPermissionMode === input.sessionMode))
      if (unchanged) return current
      const now = Date.now()
      Database.transaction((db) => {
        const persisted = db
          .select({ data: WorkflowRunTable.data })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, input.runID))
          .get()
        const data = { ...persisted?.data }
        if (input.mode !== undefined) data.permissionMode = input.mode
        if (input.sessionMode === null) delete data.sessionPermissionMode
        if (input.sessionMode !== undefined && input.sessionMode !== null) {
          data.sessionPermissionMode = input.sessionMode
        }
        db.update(WorkflowRunTable)
          .set({ time_updated: now, data })
          .where(eq(WorkflowRunTable.id, input.runID))
          .run()
        const sessionMode = input.sessionMode === null ? "global default" : input.sessionMode
        appendEvent(
          db,
          input.runID,
          "workflow.run.updated",
          "Workflow permission settings changed",
          input.reason ?? `Workflow permission settings changed${sessionMode ? `: ${sessionMode}` : ""}`,
          {
            actor: input.actor ?? "user",
            ...(input.mode === undefined ? {} : { permissionMode: input.mode }),
            ...(input.sessionMode === undefined ? {} : { sessionPermissionMode: input.sessionMode }),
          },
        )
      })
      yield* bus.publish(Event.RunWake, { runID: input.runID })
      return yield* show(input.runID)
    })

    const resumeTaskSession = Effect.fn("WorkflowService.resumeTaskSession")(function* (
      input: WorkflowTaskSessionResumeInput,
    ) {
      const project = yield* InstanceState.context
      return Database.transaction((db) => {
        const match = workflowTaskSession(db, input.sessionID, project.project.id)
        if (!match) return

        const { attempt, task, run } = match
        const currentGeneration = attempt.background_generation ?? undefined
        if (attempt.state === "working") {
          if (input.backgroundGeneration === undefined || input.backgroundGeneration === currentGeneration) {
            return {
              runID: run.id,
              taskID: task.id,
              attemptID: attempt.id,
              attempt: attempt.attempt,
              ...(currentGeneration === undefined ? {} : { backgroundGeneration: currentGeneration }),
              runnerManaged: true,
            }
          }
          db.update(WorkflowTaskAttemptTable)
            .set({
              background_generation: input.backgroundGeneration,
              time_updated: Date.now(),
            })
            .where(eq(WorkflowTaskAttemptTable.id, attempt.id))
            .run()
          return {
            runID: run.id,
            taskID: task.id,
            attemptID: attempt.id,
            attempt: attempt.attempt,
            backgroundGeneration: input.backgroundGeneration,
          }
        }

        const permissionAbandoned =
          attempt.state === "failed" &&
          (attempt.reason === WORKFLOW_PERMISSION_ABANDONED_REASON ||
            task.data?.blocker === WORKFLOW_PERMISSION_ABANDONED_REASON)
        const recoverable = attempt.state === "needs_input" || permissionAbandoned
        if (!recoverable || (task.state !== "needs_input" && !permissionAbandoned) || run.state === "stopped") return

        const now = Date.now()
        const backgroundGeneration = input.backgroundGeneration ?? currentGeneration
        db.update(WorkflowTaskAttemptTable)
          .set({
            state: "working",
            ...(backgroundGeneration === undefined ? {} : { background_generation: backgroundGeneration }),
            failure_class: null,
            reason: null,
            time_completed: null,
            time_updated: now,
            data: {
              ...(attempt.data ?? {}),
              id: attempt.id,
              taskID: task.id,
              attempt: attempt.attempt,
              state: "working",
              ...(backgroundGeneration === undefined ? {} : { backgroundGeneration }),
            },
          })
          .where(eq(WorkflowTaskAttemptTable.id, attempt.id))
          .run()
        db.update(WorkflowTaskTable)
          .set({
            state: "working",
            time_started: task.time_started ?? now,
            time_ended: null,
            time_updated: now,
            data: { ...task.data, blocker: undefined },
          })
          .where(and(eq(WorkflowTaskTable.run_id, run.id), eq(WorkflowTaskTable.id, task.id)))
          .run()
        db.update(WorkflowRunTable)
          .set({
            state: "working",
            lease_holder: null,
            lease_acquired_at: null,
            lease_heartbeat_at: null,
            lease_expires_at: null,
            time_ended: null,
            time_updated: now,
            data: { ...run.data, blocker: undefined },
          })
          .where(eq(WorkflowRunTable.id, run.id))
          .run()
        appendEvent(
          db,
          run.id,
          "workflow.task.updated",
          "Workflow task resumed",
          `Task ${task.id} resumed from a permission interruption`,
          {
            taskID: task.id,
            attemptID: attempt.id,
            backgroundGeneration,
            reason: WORKFLOW_PERMISSION_ABANDONED_REASON,
          },
        )
        reconcileWorkflowSessionState(db, run.id, now)
        return {
          runID: run.id,
          taskID: task.id,
          attemptID: attempt.id,
          attempt: attempt.attempt,
          ...(backgroundGeneration === undefined ? {} : { backgroundGeneration }),
        }
      }, { behavior: "immediate" })
    })

    const finishTaskSession = Effect.fn("WorkflowService.finishTaskSession")(function* (
      input: WorkflowTaskSessionFinishInput,
    ) {
      const project = yield* InstanceState.context
      const terminalResult = Database.transaction((db) => {
        const match = workflowTaskSession(db, input.sessionID, project.project.id)
        if (!match) return

        const { attempt, task, run } = match
        if (run.state === "stopped" || (attempt.state !== "working" && attempt.state !== "needs_input")) return

        const now = Date.now()
        const summary = input.summary?.trim() || undefined
        const error = input.error?.trim() || undefined
        const reason = error ?? summary
        db.update(WorkflowTaskAttemptTable)
          .set({
            state: input.state,
            ...(input.backgroundGeneration === undefined
              ? {}
              : { background_generation: input.backgroundGeneration }),
            failure_class: input.state === "failed" ? "environment" : null,
            reason: reason ?? null,
            time_completed: now,
            time_updated: now,
            data: {
              ...(attempt.data ?? {}),
              id: attempt.id,
              taskID: task.id,
              attempt: attempt.attempt,
              state: input.state,
              ...(reason === undefined ? {} : { reason }),
            },
          })
          .where(eq(WorkflowTaskAttemptTable.id, attempt.id))
          .run()
        db.update(WorkflowTaskTable)
          .set({
            state: input.state,
            time_ended: now,
            time_updated: now,
            data: {
              ...task.data,
              ...(summary === undefined ? {} : { summary }),
              ...(input.state === "failed" && reason !== undefined ? { blocker: reason } : { blocker: undefined }),
            },
          })
          .where(and(eq(WorkflowTaskTable.run_id, run.id), eq(WorkflowTaskTable.id, task.id)))
          .run()
        appendEvent(
          db,
          run.id,
          "workflow.task.updated",
          "Workflow task finished",
          `Task ${task.id} finished as ${input.state}`,
          {
            taskID: task.id,
            attemptID: attempt.id,
            state: input.state,
            ...(reason === undefined ? {} : { reason }),
          },
        )
        return { runID: run.id, state: reconcileWorkflowSessionState(db, run.id, now)?.state }
      }, { behavior: "immediate" })
      if (terminalResult && (terminalResult.state === "queued" || terminalResult.state === "working")) {
        yield* bus.publish(Event.RunWake, { runID: terminalResult.runID })
      }
      if (terminalResult && (terminalResult.state === "completed" || terminalResult.state === "failed")) {
        yield* publishTerminalNotification(terminalResult.runID).pipe(Effect.catchCause(() => Effect.void))
      }
    })

    const remove = Effect.fn("WorkflowService.remove")(function* (runID: WorkflowRunID) {
      const current = yield* show(runID)
      if (!terminalStates.has(current.run.state)) {
        return yield* Effect.fail(new WorkflowStateError(runID, "Stop the workflow before deleting it"))
      }
      Database.use((db) => db.delete(WorkflowRunTable).where(eq(WorkflowRunTable.id, runID)).run())
      return true
    })

    const retryTask = Effect.fn("WorkflowService.retryTask")(function* (input: WorkflowTaskRetryInput) {
      const current = yield* show(input.runID)
      if (terminalStates.has(current.run.state) && current.run.state !== "failed")
        return yield* Effect.fail(new WorkflowStateError(input.runID, "Only failed workflows may retry a task"))
      const gate = unresolvedGate(current)
      if (gate)
        return yield* Effect.fail(
          new WorkflowStateError(input.runID, `Required gate is not satisfied: ${gate.reason ?? gate.id}`),
        )
      const task = current.tasks.find((candidate) => candidate.id === input.taskID)
      if (!task) return yield* Effect.fail(new WorkflowNotFoundError(input.taskID))
      if (!retryableStates.has(task.state)) {
        return yield* Effect.fail(
          new WorkflowStateError(
            input.taskID,
            `Task is ${task.state}; only failed, blocked, stopped, or input-waiting tasks may be retried`,
          ),
        )
      }
      const now = Date.now()
      Database.transaction((db) => {
        db.update(WorkflowTaskTable)
          .set({ state: "pending", time_updated: now, data: { blocker: undefined } })
          .where(and(eq(WorkflowTaskTable.run_id, input.runID), eq(WorkflowTaskTable.id, input.taskID)))
          .run()
        db.update(WorkflowRunTable)
          .set({ state: "queued", time_updated: now })
          .where(eq(WorkflowRunTable.id, input.runID))
          .run()
        appendEvent(
          db,
          input.runID,
          "workflow.task.updated",
          "Task retry queued",
          `Task ${input.taskID} queued for retry`,
          { actor: input.actor ?? "user", reason: input.reason },
        )
      })
      yield* bus.publish(Event.RunWake, { runID: input.runID })
      return yield* show(input.runID)
    })

    const retryPhase = Effect.fn("WorkflowService.retryPhase")(function* (input: WorkflowPhaseRetryInput) {
      const current = yield* show(input.runID)
      if (terminalStates.has(current.run.state) && current.run.state !== "failed")
        return yield* Effect.fail(new WorkflowStateError(input.runID, "Only failed workflows may retry a phase"))
      const gate = unresolvedGate(current)
      if (gate)
        return yield* Effect.fail(
          new WorkflowStateError(input.runID, `Required gate is not satisfied: ${gate.reason ?? gate.id}`),
        )
      const phase = current.phases.find((candidate) => candidate.id === input.phaseID)
      if (!phase) return yield* Effect.fail(new WorkflowNotFoundError(input.phaseID))
      if (!retryableStates.has(phase.state)) {
        return yield* Effect.fail(
          new WorkflowStateError(
            input.phaseID,
            `Phase is ${phase.state}; only failed, blocked, stopped, or input-waiting phases may be retried`,
          ),
        )
      }
      const now = Date.now()
      Database.transaction((db) => {
        db.update(WorkflowTaskTable)
          .set({ state: "pending", time_updated: now })
          .where(and(eq(WorkflowTaskTable.run_id, input.runID), eq(WorkflowTaskTable.phase_id, input.phaseID)))
          .run()
        db.update(WorkflowPhaseTable)
          .set({ state: "pending", time_updated: now })
          .where(and(eq(WorkflowPhaseTable.run_id, input.runID), eq(WorkflowPhaseTable.id, input.phaseID)))
          .run()
        db.update(WorkflowRunTable)
          .set({ state: "queued", time_updated: now })
          .where(eq(WorkflowRunTable.id, input.runID))
          .run()
        appendEvent(
          db,
          input.runID,
          "workflow.phase.updated",
          "Phase retry queued",
          `Phase ${input.phaseID} queued for retry`,
          { actor: input.actor ?? "user", reason: input.reason },
        )
      })
      yield* bus.publish(Event.RunWake, { runID: input.runID })
      return yield* show(input.runID)
    })

    return {
      preview,
      save,
      start,
      list,
      show,
      setWorkspaceLease,
      events,
      artifacts,
      claimCompletionAudit,
      applyCompletionAudit,
      pause,
      resume,
      wake,
      stop,
      setPermissionMode,
      resumeTaskSession,
      finishTaskSession,
      remove,
      retryTask,
      retryPhase,
      pendingNotifications,
      acknowledgeNotifications,
      publishTerminalNotification,
    }
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as WorkflowService from "./workflow-service"
