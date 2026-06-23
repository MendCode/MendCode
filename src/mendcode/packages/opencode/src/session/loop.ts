import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { and, Database, desc, eq } from "@/storage/db"
import { NotFoundError } from "@/storage/storage"
import { zod } from "@/util/effect-zod"
import { NonNegativeInt, withStatics } from "@/util/schema"
import { InstallationVersion } from "@mendcode/core/installation/version"
import { Slug } from "@mendcode/core/util/slug"
import { Context, Effect, Layer, Option, Schema, Types } from "effect"
import path from "path"
import { ulid } from "ulid"
import {
  BackgroundSessionTable,
  LoopEventTable,
  LoopRunTable,
  LoopThreadTable,
  LoopWorkflowTable,
  SessionTable,
  SessionStatusTable,
} from "./session.sql"
import { SessionID } from "./schema"
import * as BackgroundSession from "./background"
import type { ProjectID } from "@/project/schema"
import type { WorkspaceID } from "@/control-plane/schema"

export const LoopID = Schema.String.pipe(
  Schema.brand("LoopID"),
  withStatics((s) => ({
    make: (id?: string) => (id ?? `loop_${ulid().toLowerCase()}`) as Schema.Schema.Type<typeof s>,
    zod: zod(s),
  })),
)
export type LoopID = Schema.Schema.Type<typeof LoopID>

export const RunID = Schema.String.pipe(
  Schema.brand("LoopRunID"),
  withStatics((s) => ({
    make: (id?: string) => (id ?? `loop_run_${ulid().toLowerCase()}`) as Schema.Schema.Type<typeof s>,
    zod: zod(s),
  })),
)
export type RunID = Schema.Schema.Type<typeof RunID>

export const EventID = Schema.String.pipe(
  Schema.brand("LoopEventID"),
  withStatics((s) => ({
    make: (id?: string) => (id ?? `loop_event_${ulid().toLowerCase()}`) as Schema.Schema.Type<typeof s>,
    zod: zod(s),
  })),
)
export type EventID = Schema.Schema.Type<typeof EventID>

export const WorkflowState = Schema.Literals([
  "draft",
  "active",
  "sleeping",
  "working",
  "needs_input",
  "blocked",
  "paused",
  "completed",
  "failed",
  "stopped",
]).pipe(withStatics((s) => ({ zod: zod(s) })))
export type WorkflowState = Schema.Schema.Type<typeof WorkflowState>

export const RunState = Schema.Literals(["queued", "working", "needs_input", "blocked", "completed", "failed", "stopped"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type RunState = Schema.Schema.Type<typeof RunState>

export const Source = Schema.Literals(["converted-session", "objective", "template", "manual"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type Source = Schema.Schema.Type<typeof Source>

export const TriggerMode = Schema.Literals(["manual", "interval", "adaptive", "external-signal", "self-paced"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type TriggerMode = Schema.Schema.Type<typeof TriggerMode>

export const RunTrigger = Schema.Literals(["manual", "interval", "adaptive", "external-signal", "resume", "run-once"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type RunTrigger = Schema.Schema.Type<typeof RunTrigger>

export const EventLevel = Schema.Literals(["debug", "info", "warning", "error", "decision"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type EventLevel = Schema.Schema.Type<typeof EventLevel>

export const EventType = Schema.Literals([
  "created",
  "activated",
  "started",
  "completed",
  "wake",
  "signal",
  "phase",
  "session",
  "child",
  "gate",
  "budget",
  "action",
  "monitor",
  "paused",
  "resumed",
  "stopped",
  "failed",
]).pipe(withStatics((s) => ({ zod: zod(s) })))
export type EventType = Schema.Schema.Type<typeof EventType>

const Spec = Schema.Struct({
  trigger: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(TriggerMode),
      intervalMs: Schema.optional(NonNegativeInt),
    }),
  ),
  stopWhen: Schema.optional(Schema.Array(Schema.String)),
  gates: Schema.optional(Schema.Array(Schema.String)),
  model: Schema.optional(
    Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      variant: Schema.optional(Schema.String),
    }),
  ),
  agent: Schema.optional(Schema.String),
})
export type Spec = Types.DeepMutable<Schema.Schema.Type<typeof Spec>>

const Policy = Schema.Struct({
  maxTurns: Schema.optional(NonNegativeInt),
  maxRuntimeMs: Schema.optional(NonNegativeInt),
  maxChildren: Schema.optional(NonNegativeInt),
  maxDepth: Schema.optional(NonNegativeInt),
  requireApprovalFor: Schema.optional(Schema.Array(Schema.String)),
})
export type Policy = Types.DeepMutable<Schema.Schema.Type<typeof Policy>>

const Metrics = Schema.Struct({
  turns: Schema.optional(NonNegativeInt),
  children: Schema.optional(NonNegativeInt),
  failures: Schema.optional(NonNegativeInt),
  noProgress: Schema.optional(NonNegativeInt),
})
export type Metrics = Types.DeepMutable<Schema.Schema.Type<typeof Metrics>>

const Time = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  activated: Schema.optional(NonNegativeInt),
  archived: Schema.optional(NonNegativeInt),
})

export const Info = Schema.Struct({
  id: LoopID,
  projectID: Schema.String,
  workspaceID: Schema.optional(Schema.String),
  ownerSessionID: Schema.optional(SessionID),
  rootSessionID: Schema.optional(SessionID),
  name: Schema.String,
  objective: Schema.String,
  state: WorkflowState,
  source: Source,
  templateID: Schema.optional(Schema.String),
  phase: Schema.String,
  nextWakeup: Schema.optional(NonNegativeInt),
  spec: Spec,
  policy: Policy,
  metrics: Metrics,
  evaluatorReason: Schema.optional(Schema.String),
  time: Time,
})
  .annotate({ identifier: "LoopWorkflow" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const RunInfo = Schema.Struct({
  id: RunID,
  workflowID: LoopID,
  rootSessionID: Schema.optional(SessionID),
  state: RunState,
  trigger: RunTrigger,
  phase: Schema.String,
  nextWakeup: Schema.optional(NonNegativeInt),
  evaluatorReason: Schema.optional(Schema.String),
  budget: Schema.optional(Metrics),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
    started: Schema.optional(NonNegativeInt),
    ended: Schema.optional(NonNegativeInt),
  }),
})
  .annotate({ identifier: "LoopRun" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type RunInfo = Types.DeepMutable<Schema.Schema.Type<typeof RunInfo>>

export const JournalEvent = Schema.Struct({
  id: EventID,
  workflowID: LoopID,
  runID: Schema.optional(RunID),
  sessionID: Schema.optional(SessionID),
  sequence: NonNegativeInt,
  level: EventLevel,
  type: EventType,
  title: Schema.String,
  summary: Schema.String,
  data: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
  }),
})
  .annotate({ identifier: "LoopEvent" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type JournalEvent = Types.DeepMutable<Schema.Schema.Type<typeof JournalEvent>>

export const ThreadInfo = Schema.Struct({
  workflowID: LoopID,
  runID: Schema.optional(RunID),
  sessionID: SessionID,
  role: Schema.Literals(["root", "implementer", "reviewer", "verifier", "monitor", "research"]),
  purpose: Schema.String,
  state: Schema.Literals(["queued", "working", "needs_input", "completed", "failed", "stopped"]),
  parentSessionID: Schema.optional(SessionID),
  budget: Schema.optional(Metrics),
  worktree: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
  }),
})
  .annotate({ identifier: "LoopThread" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ThreadInfo = Types.DeepMutable<Schema.Schema.Type<typeof ThreadInfo>>

export const Snapshot = Schema.Struct({
  workflow: Info,
  runs: Schema.Array(RunInfo),
  threads: Schema.Array(ThreadInfo),
  events: Schema.Array(JournalEvent),
  rootSession: Schema.optional(Schema.Struct({
    id: SessionID,
    title: Schema.String,
    model: Schema.optional(Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      variant: Schema.optional(Schema.String),
    })),
  })),
})
  .annotate({ identifier: "LoopSnapshot" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Snapshot = Types.DeepMutable<Schema.Schema.Type<typeof Snapshot>>

export type CreateDraftInput = {
  name: string
  objective: string
  source?: Source
  ownerSessionID?: SessionID
  templateID?: string
  trigger?: { mode?: TriggerMode; intervalMs?: number }
  stopWhen?: string[]
  gates?: string[]
  model?: {
    providerID: string
    modelID: string
    variant?: string
  }
  agent?: string
  policy?: Policy
}

export type UpdateStateInput = {
  id: LoopID
  reason?: string
}

export type RunOnceInput = {
  id: LoopID
  reason?: string
}

export type DueInput = {
  now?: number
  limit?: number
}

export type StartRunInput = {
  id: LoopID
  trigger?: RunTrigger
  reason?: string
}

export type CompleteRunInput = {
  id: LoopID
  runID: RunID
  reason?: string
  nextWakeup?: number
}

export type FailRunInput = {
  id: LoopID
  runID: RunID
  error: string
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly due: (input?: DueInput) => Effect.Effect<Info[]>
  readonly get: (id: LoopID) => Effect.Effect<Info, InstanceType<typeof NotFoundError>>
  readonly snapshot: (id: LoopID, limit?: number) => Effect.Effect<Snapshot, InstanceType<typeof NotFoundError>>
  readonly events: (id: LoopID, limit?: number) => Effect.Effect<JournalEvent[]>
  readonly createDraft: (input: CreateDraftInput) => Effect.Effect<Info>
  readonly activate: (input: UpdateStateInput) => Effect.Effect<Info, InstanceType<typeof NotFoundError>>
  readonly startRun: (input: StartRunInput) => Effect.Effect<RunInfo, InstanceType<typeof NotFoundError>>
  readonly completeRun: (input: CompleteRunInput) => Effect.Effect<RunInfo, InstanceType<typeof NotFoundError>>
  readonly failRun: (input: FailRunInput) => Effect.Effect<RunInfo, InstanceType<typeof NotFoundError>>
  readonly pause: (input: UpdateStateInput) => Effect.Effect<Info, InstanceType<typeof NotFoundError>>
  readonly resume: (input: UpdateStateInput) => Effect.Effect<Info, InstanceType<typeof NotFoundError>>
  readonly stop: (input: UpdateStateInput) => Effect.Effect<Info, InstanceType<typeof NotFoundError>>
  readonly runOnce: (input: RunOnceInput) => Effect.Effect<RunInfo, InstanceType<typeof NotFoundError>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LoopWorkflow") {}

export const Event = {
  WorkflowUpdated: BusEvent.define("loop.workflow.updated", Schema.Struct({ workflowID: LoopID, info: Info })),
  RunUpdated: BusEvent.define("loop.run.updated", Schema.Struct({ workflowID: LoopID, run: RunInfo })),
  EventCreated: BusEvent.define("loop.event.created", Schema.Struct({ workflowID: LoopID, event: JournalEvent })),
  ThreadUpdated: BusEvent.define("loop.thread.updated", Schema.Struct({ workflowID: LoopID, thread: ThreadInfo })),
}

type WorkflowRow = typeof LoopWorkflowTable.$inferSelect
type RunRow = typeof LoopRunTable.$inferSelect
type EventRow = typeof LoopEventTable.$inferSelect
type ThreadRow = typeof LoopThreadTable.$inferSelect

const terminalWorkflowStates = new Set<WorkflowState>(["paused", "completed", "failed", "stopped"])
const terminalBackgroundStates = new Set<BackgroundSession.State>(["completed", "failed", "stopped"])

const riskyDefaults = [
  "push",
  "merge",
  "release",
  "version-bump",
  "external-send",
  "destructive-shell",
  "broad-refactor",
]

function defaultPolicy(input?: Policy): Policy {
  return {
    maxTurns: input?.maxTurns ?? 30,
    maxRuntimeMs: input?.maxRuntimeMs ?? 8 * 60 * 60 * 1000,
    maxChildren: input?.maxChildren ?? 3,
    maxDepth: input?.maxDepth ?? 1,
    requireApprovalFor: input?.requireApprovalFor ?? riskyDefaults,
  }
}

function nextWakeupFor(
  info: { trigger?: { mode?: TriggerMode; intervalMs?: number } },
  now = Date.now(),
  options?: { immediate?: boolean },
) {
  if (!info.trigger || info.trigger.mode === "manual") return undefined
  if (!info.trigger.intervalMs) return undefined
  if (options?.immediate) return now
  return now + info.trigger.intervalMs
}

function completionState(input: {
  metrics: Metrics
  policy: Policy
  nextWakeup?: number
}): { state: WorkflowState; phase: string; nextWakeup?: number; completed: boolean } {
  const maxTurns = input.policy.maxTurns
  const completed = typeof maxTurns === "number" && (input.metrics.turns ?? 0) >= maxTurns
  if (completed) return { state: "completed", phase: "completed", completed }
  if (input.nextWakeup) return { state: "sleeping", phase: "waiting", nextWakeup: input.nextWakeup, completed }
  return { state: "active", phase: "ready", completed }
}

function backgroundStateForWorkflow(state: WorkflowState): "queued" | "working" | "needs_input" | "completed" | "failed" | "stopped" {
  if (state === "working") return "working"
  if (state === "needs_input") return "needs_input"
  if (state === "completed") return "completed"
  if (state === "failed") return "failed"
  if (state === "stopped" || state === "paused") return "stopped"
  return "queued"
}

function workflowSummary(state: WorkflowState, phase: string) {
  return phase && phase !== state ? `Loop ${state}: ${phase}` : `Loop ${state}`
}

function threadStateForWorkflow(state: WorkflowState): ThreadInfo["state"] {
  if (state === "working") return "working"
  if (state === "needs_input") return "needs_input"
  if (state === "completed") return "completed"
  if (state === "failed") return "failed"
  if (state === "stopped" || state === "paused") return "stopped"
  return "queued"
}

function reachedTurnLimit(row: WorkflowRow) {
  const metrics = row.data.metrics
  const policy = row.data.policy
  return (
    !terminalWorkflowStates.has(row.state) &&
    typeof policy.maxTurns === "number" &&
    (metrics.turns ?? 0) >= policy.maxTurns
  )
}

function reconcileTerminalWorkflow(row: WorkflowRow): WorkflowRow {
  if (!reachedTurnLimit(row)) return row
  const now = Date.now()
  const turns = row.data.metrics.turns ?? 0
  const reason = `Loop completed after reaching its iteration limit (${turns}/${row.data.policy.maxTurns}).`
  return Database.transaction((db) => {
    db.update(LoopWorkflowTable)
      .set({
        state: "completed",
        phase: "completed",
        next_wakeup: null,
        time_updated: now,
        data: {
          ...row.data,
          evaluatorReason: row.data.evaluatorReason ?? reason,
        },
      })
      .where(eq(LoopWorkflowTable.id, row.id))
      .run()
    if (row.root_session_id) {
      const background = db
        .select()
        .from(BackgroundSessionTable)
        .where(eq(BackgroundSessionTable.session_id, row.root_session_id))
        .get()
      db.insert(BackgroundSessionTable)
        .values({
          session_id: row.root_session_id,
          time_created: background?.time_created ?? now,
          time_updated: now,
          data: {
            ...background?.data,
            state: "completed",
            summary: workflowSummary("completed", "completed"),
            pinned: background?.data.pinned ?? true,
          },
        })
        .onConflictDoUpdate({
          target: BackgroundSessionTable.session_id,
          set: {
            time_updated: now,
            data: {
              ...background?.data,
              state: "completed",
              summary: workflowSummary("completed", "completed"),
              pinned: background?.data.pinned ?? true,
            },
          },
        })
        .run()
      db.delete(SessionStatusTable).where(eq(SessionStatusTable.session_id, row.root_session_id)).run()
    }
    db.update(LoopThreadTable)
      .set({
        state: "completed",
        time_updated: now,
        data: { budget: row.data.metrics },
      })
      .where(eq(LoopThreadTable.workflow_id, row.id))
      .run()
    db.update(LoopRunTable)
      .set({
        state: "stopped",
        phase: "stopped",
        next_wakeup: null,
        time_updated: now,
        time_ended: now,
        data: {
          evaluatorReason: reason,
          budget: row.data.metrics,
        },
      })
      .where(and(eq(LoopRunTable.workflow_id, row.id), eq(LoopRunTable.state, "working")))
      .run()
    return db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, row.id)).get() ?? row
  })
}

function fromWorkflowRow(row: WorkflowRow): Info {
  const metrics = row.data.metrics
  const policy = row.data.policy
  return {
    id: LoopID.make(row.id),
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    ownerSessionID: row.owner_session_id ?? undefined,
    rootSessionID: row.root_session_id ?? undefined,
    name: row.name,
    objective: row.objective,
    state: row.state,
    source: row.source,
    templateID: row.template_id ?? undefined,
    phase: row.phase,
    nextWakeup: row.next_wakeup ?? undefined,
    spec: row.data.spec,
    policy,
    metrics,
    evaluatorReason: row.data.evaluatorReason,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      activated: row.time_activated ?? undefined,
      archived: row.time_archived ?? undefined,
    },
  }
}

function fromRunRow(row: RunRow): RunInfo {
  return {
    id: RunID.make(row.id),
    workflowID: LoopID.make(row.workflow_id),
    rootSessionID: row.root_session_id ?? undefined,
    state: row.state,
    trigger: row.trigger,
    phase: row.phase,
    nextWakeup: row.next_wakeup ?? undefined,
    evaluatorReason: row.data.evaluatorReason,
    budget: row.data.budget,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      started: row.time_started ?? undefined,
      ended: row.time_ended ?? undefined,
    },
  }
}

function reconcileRunAfterTerminalWorkflow(input: { workflow: Info; runID: RunID; reason: string }): RunRow | undefined {
  const now = Date.now()
  return Database.transaction((db) => {
    const current = db.select().from(LoopRunTable).where(eq(LoopRunTable.id, input.runID)).get()
    if (!current) return undefined
    if (current.state === "working" || current.state === "queued" || current.state === "blocked" || current.state === "needs_input") {
      db.update(LoopRunTable)
        .set({
          state: "stopped",
          phase: "stopped",
          next_wakeup: null,
          time_updated: now,
          time_ended: current.time_ended ?? now,
          data: {
            ...current.data,
            evaluatorReason: input.reason,
            budget: input.workflow.metrics,
          },
        })
        .where(eq(LoopRunTable.id, input.runID))
        .run()
    }
    return db.select().from(LoopRunTable).where(eq(LoopRunTable.id, input.runID)).get()
  })
}

function fromEventRow(row: EventRow): JournalEvent {
  return {
    id: EventID.make(row.id),
    workflowID: LoopID.make(row.workflow_id),
    runID: row.run_id ? RunID.make(row.run_id) : undefined,
    sessionID: row.session_id ?? undefined,
    sequence: row.sequence,
    level: row.level,
    type: row.type,
    title: row.title,
    summary: row.summary,
    data: row.data ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  }
}

function fromThreadRow(row: ThreadRow): ThreadInfo {
  return {
    workflowID: LoopID.make(row.workflow_id),
    runID: row.run_id ? RunID.make(row.run_id) : undefined,
    sessionID: row.session_id,
    role: row.role,
    purpose: row.purpose,
    state: row.state,
    parentSessionID: row.parent_session_id ?? undefined,
    budget: row.data?.budget,
    worktree: row.data?.worktree,
    branch: row.data?.branch,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  }
}

function notFound(id: string) {
  return new NotFoundError({ message: `Loop workflow not found: ${id}` })
}

function appendEvent(input: {
  workflowID: LoopID
  runID?: RunID
  sessionID?: SessionID
  level?: EventLevel
  type: EventType
  title: string
  summary: string
  data?: Record<string, unknown>
}): JournalEvent {
  return Database.transaction((db) => {
    const now = Date.now()
    const latest = db
      .select({ sequence: LoopEventTable.sequence })
      .from(LoopEventTable)
      .where(eq(LoopEventTable.workflow_id, input.workflowID))
      .orderBy(desc(LoopEventTable.sequence))
      .limit(1)
      .get()
    const row: EventRow = {
      id: EventID.make(),
      workflow_id: input.workflowID,
      run_id: input.runID ?? null,
      session_id: input.sessionID ?? null,
      sequence: (latest?.sequence ?? 0) + 1,
      level: input.level ?? "info",
      type: input.type,
      title: input.title,
      summary: input.summary,
      time_created: now,
      time_updated: now,
      data: input.data ?? null,
    }
    db.insert(LoopEventTable).values(row).run()
    return fromEventRow(row)
  })
}

function sessionPath(worktree: string, cwd: string) {
  return path.relative(path.resolve(worktree), cwd).replaceAll("\\", "/")
}

function createRootSession(input: {
  title: string
  projectID: ProjectID
  workspaceID?: WorkspaceID
  directory: string
  worktree: string
}) {
  const now = Date.now()
  const id = SessionID.descending()
  Database.use((db) =>
    db
      .insert(SessionTable)
      .values({
        id,
        project_id: input.projectID,
        workspace_id: input.workspaceID ?? null,
        parent_id: null,
        slug: Slug.create(),
        directory: input.directory,
        path: sessionPath(input.worktree, input.directory),
        title: input.title,
        version: InstallationVersion,
        share_url: null,
        summary_additions: null,
        summary_deletions: null,
        summary_files: null,
        summary_diffs: null,
        revert: null,
        permission: null,
        agent: null,
        model: null,
        time_created: now,
        time_updated: now,
        time_compacting: null,
        time_archived: null,
      })
      .run(),
  )
  return id
}

function registerBackground(input: {
  sessionID: SessionID
  state: "queued" | "working" | "needs_input" | "completed" | "failed" | "stopped"
  summary?: string
  error?: string
  pinned?: boolean
}) {
  const now = Date.now()
  const current = Database.use((db) =>
    db.select().from(BackgroundSessionTable).where(eq(BackgroundSessionTable.session_id, input.sessionID)).get(),
  )
  Database.use((db) =>
    db
      .insert(BackgroundSessionTable)
      .values({
        session_id: input.sessionID,
        time_created: current?.time_created ?? now,
        time_updated: now,
        data: {
          ...current?.data,
          state: input.state,
          summary: input.summary ?? current?.data.summary,
          error: input.error ?? current?.data.error,
          pinned: input.pinned ?? current?.data.pinned,
          writer: terminalBackgroundStates.has(input.state) ? undefined : current?.data.writer,
        },
      })
      .onConflictDoUpdate({
        target: BackgroundSessionTable.session_id,
        set: {
          time_updated: now,
          data: {
            ...current?.data,
            state: input.state,
            summary: input.summary ?? current?.data.summary,
            error: input.error ?? current?.data.error,
            pinned: input.pinned ?? current?.data.pinned,
            writer: terminalBackgroundStates.has(input.state) ? undefined : current?.data.writer,
          },
        },
      })
      .run(),
  )
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = Option.getOrUndefined(yield* Effect.serviceOption(Bus.Service))
    const background = Option.getOrUndefined(yield* Effect.serviceOption(BackgroundSession.Service))
    const publishWorkflow = (info: Info) => (bus ? bus.publish(Event.WorkflowUpdated, { workflowID: info.id, info }) : Effect.void)
    const publishRun = (run: RunInfo) => (bus ? bus.publish(Event.RunUpdated, { workflowID: run.workflowID, run }) : Effect.void)
    const publishEvent = (event: JournalEvent) =>
      bus ? bus.publish(Event.EventCreated, { workflowID: event.workflowID, event }) : Effect.void
    const publishThread = (thread: ThreadInfo) =>
      bus ? bus.publish(Event.ThreadUpdated, { workflowID: thread.workflowID, thread }) : Effect.void
    const publishBackgroundForWorkflow = (
      workflow: Info,
      override?: Partial<Pick<BackgroundSession.RegisterInput, "state" | "summary" | "error">>,
    ) => {
      if (!workflow.rootSessionID) return Effect.void
      const state = override?.state ?? backgroundStateForWorkflow(workflow.state)
      const summary = override?.summary ?? workflowSummary(workflow.state, workflow.phase)
      if (!background) {
        registerBackground({
          sessionID: workflow.rootSessionID,
          state,
          summary,
          error: override?.error,
          pinned: true,
        })
        return Effect.void
      }
      return background.setState({
        sessionID: workflow.rootSessionID,
        state,
        summary,
        error: override?.error,
        pinned: true,
      }).pipe(Effect.asVoid)
    }
    const hydrateWorkflow = Effect.fn("LoopWorkflow.hydrate")(function* (row: WorkflowRow) {
      const reconciled = reconcileTerminalWorkflow(row)
      const info = fromWorkflowRow(reconciled)
      if (reconciled !== row) yield* publishBackgroundForWorkflow(info)
      return info
    })

    const list = Effect.fn("LoopWorkflow.list")(function* () {
      const ctx = yield* InstanceState.context
      const rows = Database.use((db) =>
        db
          .select()
          .from(LoopWorkflowTable)
          .where(eq(LoopWorkflowTable.project_id, ctx.project.id))
          .orderBy(desc(LoopWorkflowTable.time_updated))
          .all()
      )
      return yield* Effect.forEach(rows, hydrateWorkflow)
    })

    const due = Effect.fn("LoopWorkflow.due")(function* (input?: DueInput) {
      const now = input?.now ?? Date.now()
      const limit = input?.limit ?? 10
      const items = yield* list()
      return items
        .filter((item) => {
          if (item.state !== "active" && item.state !== "sleeping") return false
          return !item.nextWakeup || item.nextWakeup <= now
        })
        .slice(0, limit)
    })

    const get = Effect.fn("LoopWorkflow.get")(function* (id: LoopID) {
      const row = Database.use((db) => db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, id)).get())
      if (!row) return yield* Effect.fail(notFound(id))
      return yield* hydrateWorkflow(row)
    })

    const events = Effect.fn("LoopWorkflow.events")(function* (id: LoopID, limit = 50) {
      const rows = Database.use((db) =>
        db
          .select()
          .from(LoopEventTable)
          .where(eq(LoopEventTable.workflow_id, id))
          .orderBy(desc(LoopEventTable.sequence))
          .limit(limit)
          .all(),
      )
      return rows.reverse().map(fromEventRow)
    })

    const snapshot = Effect.fn("LoopWorkflow.snapshot")(function* (id: LoopID, limit = 50) {
      const workflow = yield* get(id)
      const rootSession = workflow.rootSessionID
        ? Database.use((db) =>
            db
              .select({
                id: SessionTable.id,
                title: SessionTable.title,
                model: SessionTable.model,
              })
              .from(SessionTable)
              .where(eq(SessionTable.id, workflow.rootSessionID!))
              .get(),
          )
        : undefined
      const runs = Database.use((db) =>
        db
          .select()
          .from(LoopRunTable)
          .where(eq(LoopRunTable.workflow_id, id))
          .orderBy(desc(LoopRunTable.time_created))
          .limit(10)
          .all()
          .map(fromRunRow),
      )
      const threads = Database.use((db) =>
        db.select().from(LoopThreadTable).where(eq(LoopThreadTable.workflow_id, id)).all().map(fromThreadRow),
      )
      return {
        workflow,
        rootSession: rootSession
          ? {
              id: rootSession.id,
              title: rootSession.title,
              model: rootSession.model
                ? {
                    providerID: rootSession.model.providerID,
                    modelID: rootSession.model.id,
                    variant: rootSession.model.variant,
                  }
                : undefined,
            }
          : undefined,
        runs,
        threads,
        events: yield* events(id, limit),
      }
    })

    const createDraft = Effect.fn("LoopWorkflow.createDraft")(function* (input: CreateDraftInput) {
      const ctx = yield* InstanceState.context
      const now = Date.now()
      const policy = defaultPolicy(input.policy)
      const spec = {
        trigger: input.trigger,
        stopWhen: input.stopWhen,
        gates: input.gates,
        model: input.model,
        agent: input.agent,
      }
      const row: WorkflowRow = {
        id: LoopID.make(),
        project_id: ctx.project.id,
        workspace_id: null,
        owner_session_id: input.ownerSessionID ?? null,
        root_session_id: null,
        name: input.name,
        objective: input.objective,
        state: "draft",
        source: input.source ?? "objective",
        template_id: input.templateID ?? null,
        phase: "draft",
        next_wakeup: null,
        time_created: now,
        time_updated: now,
        time_activated: null,
        time_archived: null,
        data: {
          spec,
          policy,
          metrics: { turns: 0, children: 0, failures: 0, noProgress: 0 },
        },
      }
      Database.use((db) => db.insert(LoopWorkflowTable).values(row).run())
      const info = fromWorkflowRow(row)
      const event = appendEvent({
        workflowID: info.id,
        sessionID: input.ownerSessionID,
        type: "created",
        title: "Loop draft created",
        summary: info.objective,
      })
      yield* publishWorkflow(info)
      yield* publishEvent(event)
      return info
    })

    const upsertRootThread = Effect.fn("LoopWorkflow.upsertRootThread")(function* (workflow: Info, runID?: RunID) {
      if (!workflow.rootSessionID) return
      const now = Date.now()
      const row: ThreadRow = {
        workflow_id: workflow.id,
        run_id: runID ?? null,
        session_id: workflow.rootSessionID,
        role: "root",
        purpose: workflow.objective,
        state: threadStateForWorkflow(workflow.state),
        parent_session_id: workflow.ownerSessionID ?? null,
        time_created: now,
        time_updated: now,
        data: { budget: workflow.metrics },
      }
      Database.use((db) =>
        db
          .insert(LoopThreadTable)
          .values(row)
          .onConflictDoUpdate({
            target: [LoopThreadTable.workflow_id, LoopThreadTable.session_id],
            set: {
              run_id: row.run_id,
              purpose: row.purpose,
              state: row.state,
              time_updated: now,
              data: row.data,
            },
          })
          .run(),
      )
      yield* publishThread(fromThreadRow(row))
    })

    const activate = Effect.fn("LoopWorkflow.activate")(function* (input: UpdateStateInput) {
      const current = yield* get(input.id)
      const ctx = yield* InstanceState.context
      const rootSessionID =
        current.rootSessionID ??
        createRootSession({
          title: `Loop: ${current.name}`,
          projectID: ctx.project.id,
          workspaceID: current.workspaceID as WorkspaceID | undefined,
          directory: ctx.directory,
          worktree: ctx.worktree,
        })
      const now = Date.now()
      const nextWakeup = nextWakeupFor(current.spec, now, { immediate: true })
      const state: WorkflowState = nextWakeup ? "sleeping" : "active"
      const row = Database.transaction((db) => {
        db.update(LoopWorkflowTable)
          .set({
            root_session_id: rootSessionID,
            state,
            phase: nextWakeup ? "waiting" : "ready",
            next_wakeup: nextWakeup,
            time_updated: now,
            time_activated: current.time.activated ?? now,
            data: {
              spec: current.spec,
              policy: current.policy,
              metrics: current.metrics,
              evaluatorReason: input.reason ?? "Activated loop workflow.",
            },
          })
          .where(eq(LoopWorkflowTable.id, current.id))
          .run()
        return db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()!
      })
      const info = fromWorkflowRow(row)
      yield* publishBackgroundForWorkflow(info)
      const event = appendEvent({
        workflowID: info.id,
        sessionID: rootSessionID,
        type: "activated",
        title: "Loop activated",
        summary: input.reason ?? `Next phase: ${info.phase}`,
        data: { nextWakeup },
      })
      yield* upsertRootThread(info)
      yield* publishWorkflow(info)
      yield* publishEvent(event)
      return info
    })

    const setWorkflowState = Effect.fn("LoopWorkflow.setWorkflowState")(function* (
      input: UpdateStateInput & { state: WorkflowState; phase: string; type: EventType; title: string },
    ) {
      const current = yield* get(input.id)
      const now = Date.now()
      const row = Database.transaction((db) => {
        db.update(LoopWorkflowTable)
          .set({
            state: input.state,
            phase: input.phase,
            next_wakeup: null,
            time_updated: now,
            data: {
              spec: current.spec,
              policy: current.policy,
              metrics: current.metrics,
              evaluatorReason: input.reason,
            },
          })
          .where(eq(LoopWorkflowTable.id, current.id))
          .run()
        return db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()!
      })
      const info = fromWorkflowRow(row)
      yield* publishBackgroundForWorkflow(info)
      const event = appendEvent({
        workflowID: info.id,
        sessionID: info.rootSessionID,
        type: input.type,
        title: input.title,
        summary: input.reason ?? `Loop is ${info.state}.`,
      })
      yield* upsertRootThread(info)
      yield* publishWorkflow(info)
      yield* publishEvent(event)
      return info
    })

    const pause = (input: UpdateStateInput) =>
      setWorkflowState({ ...input, state: "paused", phase: "paused", type: "paused", title: "Loop paused" })

    const resume = Effect.fn("LoopWorkflow.resume")(function* (input: UpdateStateInput) {
      const current = yield* get(input.id)
      const nextWakeup = nextWakeupFor(current.spec)
      const state: WorkflowState = nextWakeup ? "sleeping" : "active"
      const now = Date.now()
      const row = Database.transaction((db) => {
        db.update(LoopWorkflowTable)
          .set({
            state,
            phase: nextWakeup ? "waiting" : "ready",
            next_wakeup: nextWakeup,
            time_updated: now,
            data: {
              spec: current.spec,
              policy: current.policy,
              metrics: current.metrics,
              evaluatorReason: input.reason ?? "Resumed loop workflow.",
            },
          })
          .where(eq(LoopWorkflowTable.id, current.id))
          .run()
        return db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()!
      })
      const info = fromWorkflowRow(row)
      yield* publishBackgroundForWorkflow(info)
      const event = appendEvent({
        workflowID: info.id,
        sessionID: info.rootSessionID,
        type: "resumed",
        title: "Loop resumed",
        summary: input.reason ?? `Next phase: ${info.phase}`,
        data: { nextWakeup },
      })
      yield* upsertRootThread(info)
      yield* publishWorkflow(info)
      yield* publishEvent(event)
      return info
    })

    const stop = (input: UpdateStateInput) =>
      setWorkflowState({ ...input, state: "stopped", phase: "stopped", type: "stopped", title: "Loop stopped" })

    const startRun = Effect.fn("LoopWorkflow.startRun")(function* (input: StartRunInput) {
      let current = yield* get(input.id)
      if (terminalWorkflowStates.has(current.state)) return yield* Effect.fail(notFound(current.id))
      if (!current.rootSessionID) current = yield* activate({ id: current.id, reason: input.reason ?? "Activated for loop run." })
      const now = Date.now()
      const runRow: RunRow = {
        id: RunID.make(),
        workflow_id: current.id,
        root_session_id: current.rootSessionID ?? null,
        state: "working",
        trigger: input.trigger ?? "adaptive",
        phase: "executing",
        next_wakeup: null,
        time_created: now,
        time_updated: now,
        time_started: now,
        time_ended: null,
        data: {
          evaluatorReason: input.reason ?? "Loop run started.",
          budget: current.metrics,
        },
      }
      const workflowRow = Database.transaction((db) => {
        db.insert(LoopRunTable).values(runRow).run()
        db.update(LoopWorkflowTable)
          .set({
            state: "working",
            phase: "executing",
            next_wakeup: null,
            time_updated: now,
            data: {
              spec: current.spec,
              policy: current.policy,
              metrics: current.metrics,
              evaluatorReason: runRow.data.evaluatorReason,
            },
          })
          .where(eq(LoopWorkflowTable.id, current.id))
          .run()
        return db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()!
      })
      const workflow = fromWorkflowRow(workflowRow)
      const run = fromRunRow(runRow)
      yield* publishBackgroundForWorkflow(workflow, {
        state: "working",
        summary: workflowSummary("working", workflow.phase),
      })
      const event = appendEvent({
        workflowID: workflow.id,
        runID: run.id,
        sessionID: workflow.rootSessionID,
        type: "started",
        title: "Loop run started",
        summary: input.reason ?? `Trigger: ${run.trigger}`,
      })
      yield* upsertRootThread(workflow, run.id)
      yield* publishRun(run)
      yield* publishWorkflow(workflow)
      yield* publishEvent(event)
      return run
    })

    const completeRun = Effect.fn("LoopWorkflow.completeRun")(function* (input: CompleteRunInput) {
      const current = yield* get(input.id)
      if (current.state === "completed" || current.state === "stopped" || current.state === "failed") {
        const row = reconcileRunAfterTerminalWorkflow({
          workflow: current,
          runID: input.runID,
          reason: "Ignored late loop run completion because the workflow is already terminal.",
        })
        if (!row) return yield* Effect.fail(notFound(input.runID))
        return fromRunRow(row)
      }
      const now = Date.now()
      const nextWakeup = input.nextWakeup ?? nextWakeupFor(current.spec, now)
      const metrics = { ...current.metrics, turns: (current.metrics.turns ?? 0) + 1 }
      const computedNext = completionState({ metrics, policy: current.policy, nextWakeup })
      const pauseAfterRun = current.state === "paused" && !computedNext.completed
      const next = pauseAfterRun
        ? { state: "paused" as const, phase: "paused", completed: false, nextWakeup: undefined }
        : computedNext
      const runRow = Database.transaction((db) => {
        db.update(LoopRunTable)
          .set({
            state: "completed",
            phase: "completed",
            next_wakeup: next.nextWakeup ?? null,
            time_updated: now,
            time_ended: now,
            data: {
              evaluatorReason: input.reason ?? "Loop run completed.",
              budget: metrics,
            },
          })
          .where(eq(LoopRunTable.id, input.runID))
          .run()
        db.update(LoopWorkflowTable)
          .set({
            state: next.state,
            phase: next.phase,
            next_wakeup: next.nextWakeup ?? null,
            time_updated: now,
            data: {
              spec: current.spec,
              policy: current.policy,
              metrics,
              evaluatorReason: input.reason,
            },
          })
          .where(eq(LoopWorkflowTable.id, current.id))
          .run()
        return db.select().from(LoopRunTable).where(eq(LoopRunTable.id, input.runID)).get()!
      })
      const workflow = yield* get(current.id)
      const run = fromRunRow(runRow)
      yield* publishBackgroundForWorkflow(workflow)
      const event = appendEvent({
        workflowID: workflow.id,
        runID: run.id,
        sessionID: workflow.rootSessionID,
        type: "completed",
        title: "Loop run completed",
        summary: next.completed
          ? "Loop completed after reaching its iteration limit."
          : pauseAfterRun
            ? "Loop paused after completing the current run."
            : (input.reason ?? `Next phase: ${workflow.phase}`),
        data: { nextWakeup: next.nextWakeup, completed: next.completed },
      })
      yield* upsertRootThread(workflow, run.id)
      yield* publishRun(run)
      yield* publishWorkflow(workflow)
      yield* publishEvent(event)
      return run
    })

    const failRun = Effect.fn("LoopWorkflow.failRun")(function* (input: FailRunInput) {
      const current = yield* get(input.id)
      if (current.state === "completed" || current.state === "stopped" || current.state === "failed") {
        const row = reconcileRunAfterTerminalWorkflow({
          workflow: current,
          runID: input.runID,
          reason: "Ignored late loop run failure because the workflow is already terminal.",
        })
        if (!row) return yield* Effect.fail(notFound(input.runID))
        return fromRunRow(row)
      }
      const now = Date.now()
      const metrics = { ...current.metrics, failures: (current.metrics.failures ?? 0) + 1 }
      const runRow = Database.transaction((db) => {
        db.update(LoopRunTable)
          .set({
            state: "failed",
            phase: "failed",
            time_updated: now,
            time_ended: now,
            data: {
              evaluatorReason: input.error,
              budget: metrics,
            },
          })
          .where(eq(LoopRunTable.id, input.runID))
          .run()
        db.update(LoopWorkflowTable)
          .set({
            state: "failed",
            phase: "failed",
            next_wakeup: null,
            time_updated: now,
            data: {
              spec: current.spec,
              policy: current.policy,
              metrics,
              evaluatorReason: input.error,
            },
          })
          .where(eq(LoopWorkflowTable.id, current.id))
          .run()
        return db.select().from(LoopRunTable).where(eq(LoopRunTable.id, input.runID)).get()!
      })
      const workflow = yield* get(current.id)
      const run = fromRunRow(runRow)
      yield* publishBackgroundForWorkflow(workflow, {
        state: "failed",
        summary: `Loop failed: ${workflow.phase}`,
        error: input.error,
      })
      const event = appendEvent({
        workflowID: workflow.id,
        runID: run.id,
        sessionID: workflow.rootSessionID,
        level: "error",
        type: "failed",
        title: "Loop run failed",
        summary: input.error,
      })
      yield* upsertRootThread(workflow, run.id)
      yield* publishRun(run)
      yield* publishWorkflow(workflow)
      yield* publishEvent(event)
      return run
    })

    const runOnce = Effect.fn("LoopWorkflow.runOnce")(function* (input: RunOnceInput) {
      let current = yield* get(input.id)
      if (terminalWorkflowStates.has(current.state)) return yield* Effect.fail(notFound(current.id))
      if (!current.rootSessionID) current = yield* activate({ id: current.id, reason: "Activated for run once." })
      const now = Date.now()
      const metrics = { ...current.metrics, turns: (current.metrics.turns ?? 0) + 1 }
      const nextWakeup = nextWakeupFor(current.spec, now)
      const next = completionState({ metrics, policy: current.policy, nextWakeup })
      const runRow: RunRow = {
        id: RunID.make(),
        workflow_id: current.id,
        root_session_id: current.rootSessionID ?? null,
        state: "completed",
        trigger: "run-once",
        phase: "monitor",
        next_wakeup: next.nextWakeup ?? null,
        time_created: now,
        time_updated: now,
        time_started: now,
        time_ended: now,
        data: {
          evaluatorReason: input.reason ?? "Recorded a manual loop iteration.",
          budget: metrics,
        },
      }
      const workflowRow = Database.transaction((db) => {
        db.insert(LoopRunTable).values(runRow).run()
        db.update(LoopWorkflowTable)
          .set({
            state: next.state,
            phase: next.phase,
            next_wakeup: runRow.next_wakeup,
            time_updated: now,
            data: {
              spec: current.spec,
              policy: current.policy,
              metrics: runRow.data.budget ?? current.metrics,
              evaluatorReason: runRow.data.evaluatorReason,
            },
          })
          .where(eq(LoopWorkflowTable.id, current.id))
          .run()
        return db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, current.id)).get()!
      })
      const workflow = fromWorkflowRow(workflowRow)
      const run = fromRunRow(runRow)
      yield* publishBackgroundForWorkflow(workflow)
      const wake = appendEvent({
        workflowID: workflow.id,
        runID: run.id,
        sessionID: workflow.rootSessionID,
        type: "wake",
        title: "Manual loop iteration",
        summary: input.reason ?? "Run-once completed as a monitorable loop checkpoint.",
        data: { nextWakeup: run.nextWakeup },
      })
      yield* upsertRootThread(workflow, run.id)
      yield* publishRun(run)
      yield* publishWorkflow(workflow)
      yield* publishEvent(wake)
      return run
    })

    return Service.of({
      list,
      due,
      get,
      snapshot,
      events,
      createDraft,
      activate,
      startRun,
      completeRun,
      failRun,
      pause,
      resume,
      stop,
      runOnce,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer,
)

export * as LoopWorkflow from "./loop"
