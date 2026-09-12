import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "./schema"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { Effect, Layer, Context, Schema } from "effect"
import z from "zod"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { TodoTable, TodoTargetLockTable } from "./session.sql"

export type TargetStage = "transfer" | "flash" | "verify"
export type TargetIdentity = {
  targetID: string
  artifact: string
  sha256: string
  port: string
  stage: TargetStage
}
export type OperationEvidence = TargetIdentity & {
  command: string
  result: "succeeded" | "failed" | "interrupted" | "unknown"
  output: string
  exitCode: number | null
  timestamp: number
}
export type TargetLockState = {
  revision: number
  active: TargetIdentity
  evidence: OperationEvidence[]
  inFlight?: TargetIdentity & { token: string; command: string; startedAt: number }
}

export const Info = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.String.annotate({ description: "Priority level of the task: high, medium, low" }),
})
  .annotate({ identifier: "Todo" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

export const Event = {
  Updated: BusEvent.define(
    "todo.updated",
    Schema.Struct({
      sessionID: SessionID,
      todos: Schema.Array(Info),
    }),
  ),
}

export interface Interface {
  readonly update: (input: { sessionID: SessionID; todos: Info[] }) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info[]>
  readonly getTargetLock: (sessionID: SessionID) => Effect.Effect<TargetLockState | undefined>
  readonly setTargetLock: (input: {
    sessionID: SessionID
    expectedRevision: number
    target: TargetIdentity
  }) => Effect.Effect<TargetLockState>
  readonly beginOperation: (input: {
    sessionID: SessionID
    expectedRevision: number
    target: TargetIdentity
    command: string
  }) => Effect.Effect<{ token: string; revision: number }>
  readonly completeOperation: (input: {
    sessionID: SessionID
    token: string
    revision: number
    result: OperationEvidence["result"]
    output: string
    exitCode: number | null
  }) => Effect.Effect<TargetLockState>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTodo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const update = Effect.fn("Todo.update")(function* (input: { sessionID: SessionID; todos: Info[] }) {
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
          if (input.todos.length === 0) return
          db.insert(TodoTable)
            .values(
              input.todos.map((todo, position) => ({
                session_id: input.sessionID,
                content: todo.content,
                status: todo.status,
                priority: todo.priority,
                position,
              })),
            )
            .run()
        }),
      )
      yield* bus.publish(Event.Updated, input)
    })

    const get = Effect.fn("Todo.get")(function* (sessionID: SessionID) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(TodoTable).where(eq(TodoTable.session_id, sessionID)).orderBy(asc(TodoTable.position)).all(),
        ),
      )
      return rows.map((row) => ({
        content: row.content,
        status: row.status,
        priority: row.priority,
      }))
    })

    const getTargetLock = Effect.fn("Todo.getTargetLock")(function* (sessionID: SessionID) {
      return yield* Effect.sync(
        () =>
          Database.use((db) =>
            db.select().from(TodoTargetLockTable).where(eq(TodoTargetLockTable.session_id, sessionID)).get(),
          )?.data,
      )
    })

    const setTargetLock = Effect.fn("Todo.setTargetLock")(function* (input: {
      sessionID: SessionID
      expectedRevision: number
      target: TargetIdentity
    }) {
      return yield* Effect.sync(() =>
        Database.transaction((db) => {
          const row = db
            .select()
            .from(TodoTargetLockTable)
            .where(eq(TodoTargetLockTable.session_id, input.sessionID))
            .get()
          const revision = row?.revision ?? 0
          if (revision !== input.expectedRevision) {
            throw new Error(
              `TODO target lock revision mismatch: expected ${input.expectedRevision}, current ${revision}.`,
            )
          }
          if (row?.data.inFlight) throw new Error("TODO target lock cannot change while an operation is running.")
          const next: TargetLockState = {
            revision: revision + 1,
            active: input.target,
            evidence: row?.data.evidence ?? [],
          }
          db.insert(TodoTargetLockTable)
            .values({ session_id: input.sessionID, revision: next.revision, data: next })
            .onConflictDoUpdate({
              target: TodoTargetLockTable.session_id,
              set: { revision: next.revision, data: next, time_updated: Date.now() },
            })
            .run()
          return next
        }),
      )
    })

    const beginOperation = Effect.fn("Todo.beginOperation")(function* (input: {
      sessionID: SessionID
      expectedRevision: number
      target: TargetIdentity
      command: string
    }) {
      return yield* Effect.sync(() =>
        Database.transaction((db) => {
          const row = db
            .select()
            .from(TodoTargetLockTable)
            .where(eq(TodoTargetLockTable.session_id, input.sessionID))
            .get()
          if (!row) throw new Error("No active TODO target lock exists for this operation.")
          if (row.revision !== input.expectedRevision) {
            throw new Error(
              `TODO target lock revision mismatch: expected ${input.expectedRevision}, current ${row.revision}.`,
            )
          }
          if (row.data.inFlight) throw new Error("Another target-locked operation is already running.")
          for (const field of ["targetID", "artifact", "sha256", "port", "stage"] as const) {
            if (row.data.active[field] !== input.target[field]) {
              throw new Error(
                `TODO target lock mismatch for ${field}: active ${JSON.stringify(row.data.active[field])}, command ${JSON.stringify(input.target[field])}.`,
              )
            }
          }
          const token = crypto.randomUUID()
          const revision = row.revision + 1
          const next: TargetLockState = {
            ...row.data,
            revision,
            inFlight: { ...input.target, token, command: input.command, startedAt: Date.now() },
          }
          db.update(TodoTargetLockTable)
            .set({ revision, data: next, time_updated: Date.now() })
            .where(eq(TodoTargetLockTable.session_id, input.sessionID))
            .run()
          return { token, revision }
        }),
      )
    })

    const completeOperation = Effect.fn("Todo.completeOperation")(function* (input: {
      sessionID: SessionID
      token: string
      revision: number
      result: OperationEvidence["result"]
      output: string
      exitCode: number | null
    }) {
      return yield* Effect.sync(() =>
        Database.transaction((db) => {
          const row = db
            .select()
            .from(TodoTargetLockTable)
            .where(eq(TodoTargetLockTable.session_id, input.sessionID))
            .get()
          if (!row?.data.inFlight || row.data.inFlight.token !== input.token || row.revision !== input.revision) {
            throw new Error("Stale operation result cannot update the current TODO target lock.")
          }
          const running = row.data.inFlight
          const revision = row.revision + 1
          const evidence: OperationEvidence = {
            targetID: running.targetID,
            artifact: running.artifact,
            sha256: running.sha256,
            port: running.port,
            stage: running.stage,
            command: running.command,
            result: input.result,
            output: input.output.slice(-8_000),
            exitCode: input.exitCode,
            timestamp: Date.now(),
          }
          const next: TargetLockState = {
            revision,
            active: row.data.active,
            evidence: [...row.data.evidence, evidence].slice(-100),
          }
          db.update(TodoTargetLockTable)
            .set({ revision, data: next, time_updated: Date.now() })
            .where(eq(TodoTargetLockTable.session_id, input.sessionID))
            .run()
          return next
        }),
      )
    })

    return Service.of({ update, get, getTargetLock, setTargetLock, beginOperation, completeOperation })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Todo from "./todo"
