import { createHash } from "crypto"
import { Context, Effect, Layer } from "effect"

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

  constructor(readonly id: string, message: string) {
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

export interface WorkflowTaskRetryInput extends WorkflowControlInput {
  readonly taskID: WorkflowTaskID
}

export interface WorkflowPhaseRetryInput extends WorkflowControlInput {
  readonly phaseID: WorkflowPhaseID
}

export interface Interface {
  readonly preview: (plan: WorkflowPlan) => Effect.Effect<WorkflowPlanPreview, WorkflowValidationError>
  readonly save: (input: WorkflowSaveInput) => Effect.Effect<WorkflowRevisionReceipt, WorkflowValidationError | WorkflowNotFoundError>
  readonly start: (input: WorkflowStartInput) => Effect.Effect<WorkflowSnapshot, WorkflowValidationError | WorkflowNotFoundError>
  readonly list: (limit?: number) => Effect.Effect<readonly WorkflowSnapshot[]>
  readonly show: (runID: WorkflowRunID) => Effect.Effect<WorkflowSnapshot, WorkflowNotFoundError>
  readonly setWorkspaceLease: (input: {
    readonly runID: WorkflowRunID
    readonly workspaceLease: WorkflowWorkspaceLease
  }) => Effect.Effect<WorkflowSnapshot, WorkflowNotFoundError>
  readonly events: (runID: WorkflowRunID, limit?: number) => Effect.Effect<readonly WorkflowEventSnapshot[], WorkflowNotFoundError>
  readonly artifacts: (runID: WorkflowRunID, limit?: number) => Effect.Effect<readonly WorkflowArtifact[], WorkflowNotFoundError>
  readonly pause: (input: WorkflowControlInput) => Effect.Effect<WorkflowSnapshot, WorkflowNotFoundError | WorkflowStateError>
  readonly resume: (input: WorkflowControlInput) => Effect.Effect<WorkflowSnapshot, WorkflowNotFoundError | WorkflowStateError>
  readonly stop: (input: WorkflowControlInput) => Effect.Effect<WorkflowSnapshot, WorkflowNotFoundError | WorkflowStateError>
  readonly remove: (runID: WorkflowRunID) => Effect.Effect<boolean, WorkflowNotFoundError | WorkflowStateError>
  readonly retryTask: (input: WorkflowTaskRetryInput) => Effect.Effect<WorkflowSnapshot, WorkflowNotFoundError | WorkflowStateError>
  readonly retryPhase: (input: WorkflowPhaseRetryInput) => Effect.Effect<WorkflowSnapshot, WorkflowNotFoundError | WorkflowStateError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowService") {}

const terminalStates = new Set<WorkflowRunState>(["completed", "failed", "stopped"])

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

const unresolvedGate = (snapshot: WorkflowSnapshot) =>
  snapshot.gates.find((gate) => gate.required && gate.state !== "pass" && gate.state !== "waived")

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

const runSnapshot = (db: Parameters<typeof Database.use>[0] extends (db: infer D) => unknown ? D : never, runID: WorkflowRunID, projectID: string) => {
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
    phases: db.select().from(WorkflowPhaseTable).where(eq(WorkflowPhaseTable.run_id, run.id)).orderBy(WorkflowPhaseTable.ordinal).all(),
    tasks: db.select().from(WorkflowTaskTable).where(eq(WorkflowTaskTable.run_id, run.id)).orderBy(WorkflowTaskTable.id).all(),
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

const appendEvent = (db: Parameters<typeof Database.use>[0] extends (db: infer D) => unknown ? D : never, runID: WorkflowRunID, type: WorkflowEventSnapshot["type"], title: string, summary: string, data?: Record<string, unknown>) => {
  const sequence = (db.select({ value: max(WorkflowEventTable.sequence) }).from(WorkflowEventTable).where(eq(WorkflowEventTable.run_id, runID)).get()?.value ?? 0) + 1
  db.insert(WorkflowEventTable).values({
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
  }).run()
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const preview = Effect.fn("WorkflowService.preview")(function* (plan: WorkflowPlan) {
      return yield* planValidation(plan)
    })

    const save = Effect.fn("WorkflowService.save")(function* (input: WorkflowSaveInput) {
      const preview = yield* planValidation(input.plan)
      const project = yield* InstanceState.context
      const now = Date.now()
      const definitionID = input.definitionID ?? WorkflowDefinitionID.make()
      const receipt = Database.transaction((db) => {
        const current = db.select().from(WorkflowDefinitionTable).where(eq(WorkflowDefinitionTable.id, definitionID)).get()
        if (current && current.project_id !== project.project.id) throw new WorkflowNotFoundError(definitionID)
        const revision = (current?.current_revision ?? 0) + 1
        const revisionID = WorkflowRevisionID.make()
        if (!current) {
          db.insert(WorkflowDefinitionTable).values({
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
          }).run()
        } else {
          db.update(WorkflowDefinitionTable).set({
            name: input.name ?? current.name,
            description: input.description ?? current.description,
            current_revision: revision,
            saved: input.saved ?? current.saved,
            time_updated: now,
          }).where(eq(WorkflowDefinitionTable.id, definitionID)).run()
        }
        db.insert(WorkflowRevisionTable).values({
          id: revisionID,
          definition_id: definitionID,
          revision,
          plan_hash: planHash(input.plan),
          plan: input.plan,
          immutable: true,
          time_created: now,
          time_updated: now,
        }).run()
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
                  .where(and(eq(WorkflowRevisionTable.definition_id, definition.id), eq(WorkflowRevisionTable.revision, definition.current_revision)))
                  .get()
              : undefined
          if (!revision) return
          const revisionDefinition = definition ?? db.select().from(WorkflowDefinitionTable).where(eq(WorkflowDefinitionTable.id, revision.definition_id)).get()
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
        if (!input.plan) return yield* Effect.fail(new WorkflowValidationError([{ code: "missing-reference", message: "start requires a plan or revisionID", path: ["plan"] }]))
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
        const existing = Database.use((db) => db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.overlap_key, overlapKey)).get())
        if (existing) return yield* show(WorkflowRunID.make(existing.id))
      }

      const runID = WorkflowRunID.make()
      const now = Date.now()
      const runState: WorkflowRunState = receipt.plan.requiredGates.length ? "awaiting_approval" : "queued"
      Database.transaction((db) => {
        db.insert(WorkflowRunTable).values({
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
        }).run()
        for (const phase of receipt.plan.phases) {
          db.insert(WorkflowPhaseTable).values({
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
          }).run()
        }
        for (const task of receipt.plan.tasks) {
          db.insert(WorkflowTaskTable).values({
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
          }).run()
          for (const dependency of task.dependsOn) {
            db.insert(WorkflowTaskDependencyTable).values({ run_id: runID, task_id: task.id, depends_on_task_id: dependency }).run()
          }
        }
        for (const gate of receipt.plan.requiredGates) {
          db.insert(WorkflowGateTable).values({
            run_id: runID,
            id: WorkflowGateID.make(),
            state: "pending",
            required: true,
            reason: gate,
            time_created: now,
            time_updated: now,
            data: { key: gate },
          }).run()
        }
        appendEvent(db, runID, "workflow.run.created", runState === "awaiting_approval" ? "Workflow awaiting approval" : "Workflow queued", `Workflow ${receipt.plan.name} ${runState === "awaiting_approval" ? "awaits approval" : "queued"}`, {
          actor: "workflow-service",
          overlapKey,
          requiredGates: receipt.plan.requiredGates,
        })
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
          .all()
      )
      return rows.flatMap((row) => {
        const snapshot = Database.use((db) => runSnapshot(db, WorkflowRunID.make(row.run.id), project.project.id))
        return snapshot ? [snapshot] : []
      })
    })

    const events = Effect.fn("WorkflowService.events")(function* (runID: WorkflowRunID, limit?: number) {
      const snapshot = yield* show(runID)
      return snapshot.events.slice(0, boundedLimit(limit))
    })

    const artifacts = Effect.fn("WorkflowService.artifacts")(function* (runID: WorkflowRunID, limit?: number) {
      const snapshot = yield* show(runID)
      return snapshot.artifacts.slice(0, boundedLimit(limit))
    })

    const updateState = Effect.fn("WorkflowService.updateState")(function* (input: WorkflowControlInput, state: WorkflowRunState) {
      const current = yield* show(input.runID)
      if (current.run.state === state) return current
      if (terminalStates.has(current.run.state)) return yield* Effect.fail(new WorkflowStateError(input.runID, `Workflow is already terminal: ${current.run.state}`))
      if (state === "queued" && current.run.state === "working") return yield* Effect.fail(new WorkflowStateError(input.runID, "A working workflow must be paused before it can be resumed"))
      if (state === "queued") {
        const gate = unresolvedGate(current)
        if (gate) return yield* Effect.fail(new WorkflowStateError(input.runID, `Required gate is not satisfied: ${gate.reason ?? gate.id}`))
      }
      const now = Date.now()
      Database.transaction((db) => {
        const persisted = db.select({ data: WorkflowRunTable.data }).from(WorkflowRunTable).where(eq(WorkflowRunTable.id, input.runID)).get()
        db.update(WorkflowRunTable).set({
          state,
          time_updated: now,
          ...(state === "stopped" ? { time_ended: now } : {}),
          data: { ...persisted?.data, ...(input.reason ? { blocker: input.reason } : {}) },
        }).where(eq(WorkflowRunTable.id, input.runID)).run()
        const title = state === "paused" ? "Workflow paused" : state === "queued" ? "Workflow resumed" : "Workflow stopped"
        appendEvent(db, input.runID, `workflow.run.updated`, title, input.reason ?? title, { actor: input.actor ?? "user", reason: input.reason })
      })
      return yield* show(input.runID)
    })

    const pause = (input: WorkflowControlInput) => updateState(input, "paused")
    const resume = (input: WorkflowControlInput) => updateState(input, "queued")
    const stop = (input: WorkflowControlInput) => updateState(input, "stopped")

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
      if (terminalStates.has(current.run.state) && current.run.state !== "failed") return yield* Effect.fail(new WorkflowStateError(input.runID, "Only failed workflows may retry a task"))
      const gate = unresolvedGate(current)
      if (gate) return yield* Effect.fail(new WorkflowStateError(input.runID, `Required gate is not satisfied: ${gate.reason ?? gate.id}`))
      const task = current.tasks.find((candidate) => candidate.id === input.taskID)
      if (!task) return yield* Effect.fail(new WorkflowNotFoundError(input.taskID))
      const now = Date.now()
      Database.transaction((db) => {
        db.update(WorkflowTaskTable)
          .set({ state: "pending", time_updated: now, data: { blocker: undefined } })
          .where(and(eq(WorkflowTaskTable.run_id, input.runID), eq(WorkflowTaskTable.id, input.taskID)))
          .run()
        db.update(WorkflowRunTable).set({ state: "queued", time_updated: now }).where(eq(WorkflowRunTable.id, input.runID)).run()
        appendEvent(db, input.runID, "workflow.task.updated", "Task retry queued", `Task ${input.taskID} queued for retry`, { actor: input.actor ?? "user", reason: input.reason })
      })
      return yield* show(input.runID)
    })

    const retryPhase = Effect.fn("WorkflowService.retryPhase")(function* (input: WorkflowPhaseRetryInput) {
      const current = yield* show(input.runID)
      if (terminalStates.has(current.run.state) && current.run.state !== "failed") return yield* Effect.fail(new WorkflowStateError(input.runID, "Only failed workflows may retry a phase"))
      const gate = unresolvedGate(current)
      if (gate) return yield* Effect.fail(new WorkflowStateError(input.runID, `Required gate is not satisfied: ${gate.reason ?? gate.id}`))
      if (!current.phases.some((phase) => phase.id === input.phaseID)) return yield* Effect.fail(new WorkflowNotFoundError(input.phaseID))
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
        db.update(WorkflowRunTable).set({ state: "queued", time_updated: now }).where(eq(WorkflowRunTable.id, input.runID)).run()
        appendEvent(db, input.runID, "workflow.phase.updated", "Phase retry queued", `Phase ${input.phaseID} queued for retry`, { actor: input.actor ?? "user", reason: input.reason })
      })
      return yield* show(input.runID)
    })

    return { preview, save, start, list, show, setWorkspaceLease, events, artifacts, pause, resume, stop, remove, retryTask, retryPhase }
  }),
)

export const defaultLayer = layer

export * as WorkflowService from "./workflow-service"
