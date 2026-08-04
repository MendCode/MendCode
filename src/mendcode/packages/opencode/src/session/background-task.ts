import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { Database, and, eq } from "@/storage/db"
import { NonNegativeInt, withStatics } from "@/util/schema"
import { zod } from "@/util/effect-zod"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { MessageID, SessionID } from "./schema"
import {
  BackgroundTaskEventTable,
  BackgroundTaskRunTable,
  BackgroundTaskTable,
  type BackgroundTaskControlIntent,
  type BackgroundTaskResultData,
  type BackgroundTaskState,
} from "./background-task.sql"
import { SessionTable } from "./session.sql"

export const State = Schema.Literals([
  "queued",
  "running",
  "needs_input",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]).pipe(withStatics((schema) => ({ zod: zod(schema) })))
export type State = Schema.Schema.Type<typeof State>

export const ControlIntent = Schema.Literals(["none", "pause_after_turn", "cancel"])
export type ControlIntent = Schema.Schema.Type<typeof ControlIntent>

const Model = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optional(Schema.String),
})

const Result = Schema.Struct({
  summary: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  changedFiles: Schema.Array(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
  transcriptSessionID: SessionID,
})
export type Result = Schema.Schema.Type<typeof Result>

export const Snapshot = Schema.Struct({
  taskID: SessionID,
  parentSessionID: SessionID,
  rootSessionID: SessionID,
  depth: NonNegativeInt,
  generation: NonNegativeInt,
  revision: NonNegativeInt,
  state: State,
  controlIntent: ControlIntent,
  title: Schema.String,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Model),
  result: Schema.optional(Result),
  ownerRuntimeID: Schema.optional(Schema.String),
  leaseExpiresAt: Schema.optional(NonNegativeInt),
  time: Schema.Struct({
    created: NonNegativeInt,
    queued: NonNegativeInt,
    started: Schema.optional(NonNegativeInt),
    updated: NonNegativeInt,
    finished: Schema.optional(NonNegativeInt),
  }),
})
  .annotate({ identifier: "BackgroundTaskSnapshot" })
  .pipe(withStatics((schema) => ({ zod: zod(schema) })))
export type Snapshot = Schema.Schema.Type<typeof Snapshot>

export type Notification = {
  eventID: string
  taskID: SessionID
  parentSessionID: SessionID
  generation: number
  revision: number
  state: State
  title: string
  summary?: string
  error?: string
  background?: boolean
}

export const Event = {
  Updated: BusEvent.define(
    "background_task.updated",
    Schema.Struct({
      snapshot: Snapshot,
    }),
  ),
  Notification: BusEvent.define(
    "background_task.notification",
    Schema.Struct({
      eventID: Schema.String,
      taskID: SessionID,
      parentSessionID: SessionID,
      generation: NonNegativeInt,
      revision: NonNegativeInt,
      state: State,
      title: Schema.String,
      summary: Schema.optional(Schema.String),
      error: Schema.optional(Schema.String),
      background: Schema.optional(Schema.Boolean),
    }),
  ),
  OwnerWake: BusEvent.define(
    "background_task.owner_wake",
    Schema.Struct({
      wakeID: Schema.String,
      parentSessionID: SessionID,
      taskIDs: Schema.Array(SessionID),
      taskTitles: Schema.Array(Schema.String),
    }),
  ),
}

export type StartInput = {
  taskID: SessionID
  parentSessionID: SessionID
  rootSessionID?: SessionID
  depth?: number
  limits?: {
    maxChildren?: number
    maxDescendants?: number
  }
  /** Start atomically as running so observers never see a stuck queued task. */
  startRunning?: boolean
  originMessageID?: MessageID
  originCallID?: string
  title: string
  agent?: string
  model?: {
    providerID: string
    modelID: string
    variant?: string
  }
}

export type FinishInput = {
  taskID: SessionID
  generation: number
  state: Extract<State, "completed" | "failed" | "cancelled" | "interrupted">
  background?: boolean
  result?: Partial<Omit<Result, "transcriptSessionID">> & { transcriptSessionID?: SessionID }
}

export type RunValue = {
  state: BackgroundTaskState
  control_intent: BackgroundTaskControlIntent
  revision: number
  owner_runtime_id: string | null
  lease_expires_at: number | null
  result: BackgroundTaskResultData | null
  time_started: number | null
  time_finished: number | null
  time_updated: number
}

export type RunAction =
  | { type: "mark_running"; ownerRuntimeID: string; leaseExpiresAt: number }
  | { type: "request_cancel" }
  | {
      type: "finish"
      state: Extract<BackgroundTaskState, "completed" | "failed" | "cancelled" | "interrupted">
      background?: boolean
      result: BackgroundTaskResultData
    }

export type ReducedRun = {
  value: RunValue
  changed: boolean
  stateChanged: boolean
}

const terminalStates = new Set<BackgroundTaskState>(["paused", "completed", "failed", "cancelled", "interrupted"])
const activeStates = new Set<BackgroundTaskState>(["queued", "running", "needs_input"])
const RESULT_MAX_CHARS = 24_000
const RESULT_MAX_FILES = 200
const OWNER_LEASE_MS = 6 * 60 * 60 * 1000
const runtimeID = `${process.pid}:${crypto.randomUUID()}`

function ownerRuntimeIsAlive(ownerRuntimeID: string | null) {
  if (ownerRuntimeID === runtimeID) return true
  if (!ownerRuntimeID) return false
  const pid = Number(ownerRuntimeID.split(":", 1)[0])
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function isTerminal(state: State): boolean {
  return terminalStates.has(state)
}

export function reduceRun(current: RunValue, action: RunAction, now = Date.now()): ReducedRun {
  if (terminalStates.has(current.state)) return { value: current, changed: false, stateChanged: false }

  if (action.type === "request_cancel") {
    if (current.control_intent === "cancel") return { value: current, changed: false, stateChanged: false }
    return {
      changed: true,
      stateChanged: false,
      value: {
        ...current,
        control_intent: "cancel",
        revision: current.revision + 1,
        time_updated: now,
      },
    }
  }

  if (action.type === "mark_running") {
    if (!new Set<BackgroundTaskState>(["queued", "needs_input", "running"]).has(current.state)) {
      throw new Error(`Cannot mark background task ${current.state} as running`)
    }
    if (
      current.state === "running" &&
      current.owner_runtime_id === action.ownerRuntimeID &&
      current.lease_expires_at === action.leaseExpiresAt
    ) {
      return { value: current, changed: false, stateChanged: false }
    }
    return {
      changed: true,
      stateChanged: current.state !== "running",
      value: {
        ...current,
        state: "running",
        revision: current.revision + 1,
        owner_runtime_id: action.ownerRuntimeID,
        lease_expires_at: action.leaseExpiresAt,
        time_started: current.time_started ?? now,
        time_updated: now,
      },
    }
  }

  const allowed =
    current.state === "queued"
      ? new Set<BackgroundTaskState>(["failed", "cancelled", "interrupted"])
      : new Set<BackgroundTaskState>(["completed", "failed", "cancelled", "interrupted"])
  if (!allowed.has(action.state)) throw new Error(`Cannot finish background task ${current.state} as ${action.state}`)
  return {
    changed: true,
    stateChanged: true,
    value: {
      ...current,
      state: action.state,
      revision: current.revision + 1,
      result: action.result,
      owner_runtime_id: null,
      lease_expires_at: null,
      time_finished: now,
      time_updated: now,
    },
  }
}

type TaskRow = typeof BackgroundTaskTable.$inferSelect
type RunRow = typeof BackgroundTaskRunTable.$inferSelect
type WaiterState = Map<string, Set<Deferred.Deferred<Snapshot>>>

function fromRows(task: TaskRow, run: RunRow): Snapshot {
  return {
    taskID: task.task_id,
    parentSessionID: task.parent_session_id,
    rootSessionID: task.root_session_id ?? task.parent_session_id,
    depth: Math.max(0, task.depth ?? 1),
    generation: run.generation,
    revision: run.revision,
    state: run.state,
    controlIntent: run.control_intent,
    title: task.title,
    agent: task.agent ?? undefined,
    model: task.model ?? undefined,
    result: run.result
      ? {
          summary: run.result.summary,
          error: run.result.error,
          changedFiles: run.result.changedFiles,
          truncated: run.result.truncated,
          transcriptSessionID: run.result.transcriptSessionID,
        }
      : undefined,
    ownerRuntimeID: run.owner_runtime_id ?? undefined,
    leaseExpiresAt: run.lease_expires_at ?? undefined,
    time: {
      created: task.time_created,
      queued: run.time_queued,
      started: run.time_started ?? undefined,
      updated: run.time_updated,
      finished: run.time_finished ?? undefined,
    },
  }
}

function boundResult(input: FinishInput): BackgroundTaskResultData {
  const summary = input.result?.summary?.trim()
  const error = input.result?.error?.trim()
  const boundedSummary = summary && summary.length > RESULT_MAX_CHARS ? summary.slice(0, RESULT_MAX_CHARS) : summary
  const boundedError = error && error.length > RESULT_MAX_CHARS ? error.slice(0, RESULT_MAX_CHARS) : error
  return {
    summary: boundedSummary,
    error: boundedError,
    changedFiles: Array.from(new Set(input.result?.changedFiles ?? [])).slice(0, RESULT_MAX_FILES),
    truncated:
      input.result?.truncated === true ||
      (summary !== undefined && boundedSummary !== summary) ||
      (error !== undefined && boundedError !== error) ||
      (input.result?.changedFiles?.length ?? 0) > RESULT_MAX_FILES,
    transcriptSessionID: input.result?.transcriptSessionID ?? input.taskID,
  }
}

function key(taskID: SessionID, generation: number) {
  return `${taskID}:${generation}`
}

export function listSnapshots(parentSessionID: SessionID) {
  return Database.use((db) =>
    db
      .select()
      .from(BackgroundTaskTable)
      .where(eq(BackgroundTaskTable.parent_session_id, parentSessionID))
      .all()
      .flatMap((task) => {
        const run = db
          .select()
          .from(BackgroundTaskRunTable)
          .where(
            and(
              eq(BackgroundTaskRunTable.task_id, task.task_id),
              eq(BackgroundTaskRunTable.generation, task.current_generation),
            ),
          )
          .get()
        return run ? [fromRows(task, run)] : []
      })
      .toSorted((a, b) => b.time.updated - a.time.updated || b.taskID.localeCompare(a.taskID)),
  )
}

export function hasActiveTasks() {
  return Database.use((db) =>
    db
      .select({ state: BackgroundTaskRunTable.state })
      .from(BackgroundTaskRunTable)
      .all()
      .some((run) => activeStates.has(run.state)),
  )
}

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<Snapshot>
  readonly markRunning: (input: { taskID: SessionID; generation: number }) => Effect.Effect<Snapshot>
  readonly reclaimExpired: (input?: { now?: number }) => Effect.Effect<Snapshot[]>
  readonly finish: (input: FinishInput) => Effect.Effect<Snapshot>
  readonly requestCancel: (input: { taskID: SessionID; generation?: number }) => Effect.Effect<Snapshot | undefined>
  readonly get: (taskID: SessionID, generation?: number) => Effect.Effect<Snapshot | undefined>
  readonly list: (parentSessionID: SessionID) => Effect.Effect<Snapshot[]>
  readonly pendingNotifications: (parentSessionID?: SessionID) => Effect.Effect<Notification[]>
  readonly acknowledgeNotifications: (eventIDs: readonly string[]) => Effect.Effect<void>
  readonly dismissNotifications: (parentSessionID: SessionID) => Effect.Effect<void>
  readonly wait: (input: {
    taskID: SessionID
    generation?: number
    timeoutMs?: number
  }) => Effect.Effect<{ snapshot: Snapshot; timedOut: boolean } | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BackgroundTask") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const waiters = yield* InstanceState.make(
      Effect.fn("BackgroundTask.waiters")(() => Effect.succeed(new Map<string, Set<Deferred.Deferred<Snapshot>>>())),
    )

    const get = Effect.fn("BackgroundTask.get")(function* (taskID: SessionID, generation?: number) {
      return Database.use((db) => {
        const task = db.select().from(BackgroundTaskTable).where(eq(BackgroundTaskTable.task_id, taskID)).get()
        if (!task) return undefined
        const target = generation ?? task.current_generation
        const run = db
          .select()
          .from(BackgroundTaskRunTable)
          .where(and(eq(BackgroundTaskRunTable.task_id, taskID), eq(BackgroundTaskRunTable.generation, target)))
          .get()
        return run ? fromRows(task, run) : undefined
      })
    })

    const publish = Effect.fn("BackgroundTask.publish")(function* (input: {
      snapshot: Snapshot
      event?: typeof BackgroundTaskEventTable.$inferSelect
    }) {
      yield* bus.publish(Event.Updated, { snapshot: input.snapshot })
      if (input.event) {
        yield* bus.publish(
          Event.Notification,
          {
            eventID: input.event.id,
            taskID: input.snapshot.taskID,
            parentSessionID: input.snapshot.parentSessionID,
            generation: input.snapshot.generation,
            revision: input.snapshot.revision,
            state: input.snapshot.state,
            title: input.snapshot.title,
            summary: input.snapshot.result?.summary,
            error: input.snapshot.result?.error,
            ...(input.event.payload?.background !== undefined ? { background: input.event.payload.background } : {}),
          },
          { id: input.event.id },
        )
        Database.use((db) =>
          db
            .update(BackgroundTaskEventTable)
            .set({ time_delivered: Date.now(), time_updated: Date.now() })
            .where(eq(BackgroundTaskEventTable.id, input.event!.id))
            .run(),
        )
      }
      if (!isTerminal(input.snapshot.state)) return
      const state = yield* InstanceState.get(waiters)
      const pending = state.get(key(input.snapshot.taskID, input.snapshot.generation))
      if (!pending) return
      yield* Effect.forEach(pending, (deferred) => Deferred.succeed(deferred, input.snapshot), {
        concurrency: "unbounded",
        discard: true,
      })
      state.delete(key(input.snapshot.taskID, input.snapshot.generation))
    })

    const start = Effect.fn("BackgroundTask.start")(function* (input: StartInput) {
      const snapshot = Database.transaction(
        (db) => {
          const now = Date.now()
          const rootSessionID = input.rootSessionID ?? input.parentSessionID
          const depth = Math.max(0, Math.floor(input.depth ?? 1))
          const current = db
            .select()
            .from(BackgroundTaskTable)
            .where(eq(BackgroundTaskTable.task_id, input.taskID))
            .get()
          if (current) {
            const previous = db
              .select()
              .from(BackgroundTaskRunTable)
              .where(
                and(
                  eq(BackgroundTaskRunTable.task_id, input.taskID),
                  eq(BackgroundTaskRunTable.generation, current.current_generation),
                ),
              )
              .get()
            if (previous && !terminalStates.has(previous.state)) {
              throw new Error(`Background task ${input.taskID} is already ${previous.state}`)
            }
          }

          // Admission happens in the same immediate transaction as
          // registration. Only active runs consume the budget, so completed
          // children do not permanently reduce a parent's capacity.
          const activeTasks = db
            .select()
            .from(BackgroundTaskTable)
            .all()
            .flatMap((task) => {
              const run = db
                .select()
                .from(BackgroundTaskRunTable)
                .where(
                  and(
                    eq(BackgroundTaskRunTable.task_id, task.task_id),
                    eq(BackgroundTaskRunTable.generation, task.current_generation),
                  ),
                )
                .get()
              return run && activeStates.has(run.state) ? [{ task, run }] : []
            })
          const maxChildren = input.limits?.maxChildren
          if (
            maxChildren !== undefined &&
            activeTasks.filter(({ task }) => task.parent_session_id === input.parentSessionID).length >= maxChildren
          ) {
            throw new Error(`Subagent direct-child limit reached for session ${input.parentSessionID}`)
          }
          const maxDescendants = input.limits?.maxDescendants
          if (
            maxDescendants !== undefined &&
            activeTasks.filter(({ task }) => (task.root_session_id ?? task.parent_session_id) === rootSessionID)
              .length >= maxDescendants
          ) {
            throw new Error(`Subagent descendant limit reached for root session ${rootSessionID}`)
          }

          const generation = (current?.current_generation ?? 0) + 1
          const startRunning = input.startRunning === true
          db.insert(BackgroundTaskTable)
            .values({
              task_id: input.taskID,
              parent_session_id: input.parentSessionID,
              origin_message_id: input.originMessageID,
              origin_call_id: input.originCallID,
              current_generation: generation,
              title: input.title,
              agent: input.agent,
              model: input.model,
              root_session_id: rootSessionID,
              depth,
              time_created: current?.time_created ?? now,
              time_updated: now,
            })
            .onConflictDoUpdate({
              target: BackgroundTaskTable.task_id,
              set: {
                parent_session_id: input.parentSessionID,
                origin_message_id: input.originMessageID,
                origin_call_id: input.originCallID,
                current_generation: generation,
                title: input.title,
                agent: input.agent,
                model: input.model,
                root_session_id: rootSessionID,
                depth,
                time_updated: now,
                time_dismissed: null,
              },
            })
            .run()
          const run = {
            task_id: input.taskID,
            generation,
            revision: 1,
            state: startRunning ? ("running" as const) : ("queued" as const),
            control_intent: "none" as const,
            owner_runtime_id: startRunning ? runtimeID : null,
            lease_expires_at: startRunning ? now + OWNER_LEASE_MS : null,
            result: null,
            time_created: now,
            time_updated: now,
            time_queued: now,
            time_started: startRunning ? now : null,
            time_finished: null,
          }
          db.insert(BackgroundTaskRunTable).values(run).run()
          return fromRows(
            {
              task_id: input.taskID,
              parent_session_id: input.parentSessionID,
              origin_message_id: input.originMessageID ?? null,
              origin_call_id: input.originCallID ?? null,
              current_generation: generation,
              title: input.title,
              agent: input.agent ?? null,
              model: input.model ?? null,
              root_session_id: rootSessionID,
              depth,
              time_created: current?.time_created ?? now,
              time_updated: now,
              time_dismissed: null,
              time_expires: null,
            },
            run,
          )
        },
        { behavior: "immediate" },
      )
      yield* publish({ snapshot })
      return snapshot
    })

    const update = Effect.fn("BackgroundTask.update")(function* (input: {
      taskID: SessionID
      generation: number
      action: RunAction
    }) {
      const result = Database.transaction(
        (db) => {
          const task = db.select().from(BackgroundTaskTable).where(eq(BackgroundTaskTable.task_id, input.taskID)).get()
          if (!task) return undefined
          const run = db
            .select()
            .from(BackgroundTaskRunTable)
            .where(
              and(
                eq(BackgroundTaskRunTable.task_id, input.taskID),
                eq(BackgroundTaskRunTable.generation, input.generation),
              ),
            )
            .get()
          if (!run) return undefined
          const next = reduceRun(run, input.action)
          if (!next.changed) return { snapshot: fromRows(task, run), changed: false }
          db.update(BackgroundTaskRunTable)
            .set(next.value)
            .where(
              and(
                eq(BackgroundTaskRunTable.task_id, input.taskID),
                eq(BackgroundTaskRunTable.generation, input.generation),
                eq(BackgroundTaskRunTable.revision, run.revision),
              ),
            )
            .run()
          db.update(BackgroundTaskTable)
            .set({ time_updated: next.value.time_updated })
            .where(eq(BackgroundTaskTable.task_id, input.taskID))
            .run()
          const snapshot = fromRows(task, { ...run, ...next.value })
          if (
            !next.stateChanged ||
            !["needs_input", "completed", "failed", "cancelled", "interrupted"].includes(snapshot.state)
          ) {
            return { snapshot, changed: true }
          }
          const event = {
            id: Bus.createID(),
            task_id: input.taskID,
            generation: input.generation,
            revision: snapshot.revision,
            type: snapshot.state as "needs_input" | "completed" | "failed" | "cancelled" | "interrupted",
            payload: {
              parentSessionID: task.parent_session_id,
              title: task.title,
              summary: snapshot.result?.summary,
              error: snapshot.result?.error,
              ...(input.action.type === "finish" && input.action.background !== undefined
                ? { background: input.action.background }
                : {}),
            },
            time_created: next.value.time_updated,
            time_updated: next.value.time_updated,
            time_delivered: null,
            time_acknowledged: null,
          }
          db.insert(BackgroundTaskEventTable).values(event).onConflictDoNothing().run()
          return { snapshot, changed: true, event }
        },
        { behavior: "immediate" },
      )
      if (!result) return undefined
      if (result.changed) yield* publish({ snapshot: result.snapshot, event: result.event })
      return result.snapshot
    })

    const markRunning = Effect.fn("BackgroundTask.markRunning")(function* (input: {
      taskID: SessionID
      generation: number
    }) {
      const snapshot = yield* update({
        ...input,
        action: {
          type: "mark_running",
          ownerRuntimeID: runtimeID,
          leaseExpiresAt: Date.now() + OWNER_LEASE_MS,
        },
      })
      if (!snapshot) throw new Error(`Background task ${input.taskID} was not registered`)
      return snapshot
    })

    const finish = Effect.fn("BackgroundTask.finish")(function* (input: FinishInput) {
      const snapshot = yield* update({
        taskID: input.taskID,
        generation: input.generation,
        action: {
          type: "finish",
          state: input.state,
          background: input.background,
          result: boundResult(input),
        },
      })
      if (!snapshot) throw new Error(`Background task ${input.taskID} was not registered`)
      return snapshot
    })

    const reclaimExpired = Effect.fn("BackgroundTask.reclaimExpired")(function* (input?: { now?: number }) {
      const now = input?.now ?? Date.now()
      const expired = Database.use((db) =>
        db
          .select()
          .from(BackgroundTaskRunTable)
          .all()
          .filter(
            (run) =>
              run.state === "running" &&
              ((run.lease_expires_at !== null && run.lease_expires_at <= now) ||
                !ownerRuntimeIsAlive(run.owner_runtime_id)),
          ),
      )
      const results = yield* Effect.forEach(
        expired,
        (run) =>
          update({
            taskID: run.task_id,
            generation: run.generation,
            action: {
              type: "finish",
              state: "interrupted",
              background: true,
              result: {
                summary: `Runtime lease expired before the subagent completed. Resume with task_id ${run.task_id}.`,
                error: "Runtime lease expired",
                changedFiles: [],
                transcriptSessionID: run.task_id,
              },
            },
          }),
        { concurrency: 1 },
      )
      return results.filter((snapshot): snapshot is Snapshot => Boolean(snapshot))
    })

    const requestCancel = Effect.fn("BackgroundTask.requestCancel")(function* (input: {
      taskID: SessionID
      generation?: number
    }) {
      const snapshot = yield* get(input.taskID, input.generation)
      if (!snapshot) return undefined
      return yield* update({
        taskID: input.taskID,
        generation: snapshot.generation,
        action: { type: "request_cancel" },
      })
    })

    const list = Effect.fn("BackgroundTask.list")((parentSessionID: SessionID) =>
      Effect.sync(() => listSnapshots(parentSessionID)),
    )

    const pendingNotifications = Effect.fn("BackgroundTask.pendingNotifications")(function* (
      parentSessionID?: SessionID,
    ) {
      const context = yield* InstanceState.context
      return Database.use((db) =>
        db
          .select()
          .from(BackgroundTaskEventTable)
          .all()
          .flatMap((event): Notification[] => {
            if (event.time_acknowledged !== null || event.payload?.background !== true) return []
            if (parentSessionID !== undefined && event.payload.parentSessionID !== parentSessionID) return []
            const task = db
              .select()
              .from(BackgroundTaskTable)
              .where(eq(BackgroundTaskTable.task_id, event.task_id))
              .get()
            if (!task || task.time_dismissed !== null) return []
            const parent = db
              .select({ directory: SessionTable.directory })
              .from(SessionTable)
              .where(eq(SessionTable.id, task.parent_session_id))
              .get()
            if (!parent || parent.directory !== context.directory) return []
            return [
              {
                eventID: event.id,
                taskID: event.task_id,
                parentSessionID: event.payload.parentSessionID,
                generation: event.generation,
                revision: event.revision,
                state: event.type,
                title: event.payload.title ?? task.title,
                summary: event.payload.summary,
                error: event.payload.error,
                background: true,
              },
            ]
          })
          .toSorted((a, b) => a.eventID.localeCompare(b.eventID)),
      )
    })

    const acknowledgeNotifications = Effect.fn("BackgroundTask.acknowledgeNotifications")(
      (eventIDs: readonly string[]) =>
        Effect.sync(() => {
          if (eventIDs.length === 0) return
          const now = Date.now()
          Database.transaction((db) => {
            for (const eventID of new Set(eventIDs)) {
              db.update(BackgroundTaskEventTable)
                .set({ time_acknowledged: now, time_updated: now })
                .where(eq(BackgroundTaskEventTable.id, eventID))
                .run()
            }
          })
        }),
    )

    const dismissNotifications = Effect.fn("BackgroundTask.dismissNotifications")((parentSessionID: SessionID) =>
      Effect.sync(() => {
        const now = Date.now()
        Database.use((db) =>
          db
            .update(BackgroundTaskTable)
            .set({ time_dismissed: now, time_updated: now })
            .where(eq(BackgroundTaskTable.parent_session_id, parentSessionID))
            .run(),
        )
      }),
    )

    const wait = Effect.fn("BackgroundTask.wait")(function* (input: {
      taskID: SessionID
      generation?: number
      timeoutMs?: number
    }) {
      const initial = yield* get(input.taskID, input.generation)
      if (!initial) return undefined
      if (isTerminal(initial.state)) return { snapshot: initial, timedOut: false }
      const deferred = yield* Deferred.make<Snapshot>()
      const state = yield* InstanceState.get(waiters)
      const waitKey = key(initial.taskID, initial.generation)
      const pending = state.get(waitKey) ?? new Set<Deferred.Deferred<Snapshot>>()
      pending.add(deferred)
      state.set(waitKey, pending)
      const current = yield* get(initial.taskID, initial.generation)
      if (current && isTerminal(current.state)) {
        pending.delete(deferred)
        if (pending.size === 0) state.delete(waitKey)
        return { snapshot: current, timedOut: false }
      }
      const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? 30_000, 5 * 60_000))
      return yield* Deferred.await(deferred).pipe(
        Effect.map((snapshot) => ({ snapshot, timedOut: false })),
        Effect.raceFirst(
          Effect.sleep(timeoutMs).pipe(
            Effect.flatMap(() => get(initial.taskID, initial.generation)),
            Effect.map((snapshot) => ({ snapshot: snapshot ?? initial, timedOut: true })),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(deferred)
            if (pending.size === 0) state.delete(waitKey)
          }),
        ),
      )
    })

    yield* reclaimExpired()

    return Service.of({
      start,
      markRunning,
      reclaimExpired,
      finish,
      requestCancel,
      get,
      list,
      pendingNotifications,
      acknowledgeNotifications,
      dismissNotifications,
      wait,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as BackgroundTask from "./background-task"
