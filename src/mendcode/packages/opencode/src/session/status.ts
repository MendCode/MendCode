import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { Database, eq } from "@/storage/db"
import { SessionID } from "./schema"
import { SessionStatusTable } from "./session.sql"
import { zod } from "@/util/effect-zod"
import { NonNegativeInt, withStatics } from "@/util/schema"
import { Effect, Layer, Context, Schema } from "effect"
import z from "zod"

export const Info = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("idle"),
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    attempt: NonNegativeInt,
    message: Schema.String,
    next: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("busy"),
    kind: Schema.optional(Schema.Union([Schema.Literal("mflow-wait"), Schema.Literal("memory-extract"), Schema.Literal("subagent-wait")])),
    message: Schema.optional(Schema.String),
    until: Schema.optional(NonNegativeInt),
    startedAt: Schema.optional(NonNegativeInt),
  }),
])
  .annotate({ identifier: "SessionStatus" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

export const Event = {
  Status: BusEvent.define(
    "session.status",
    Schema.Struct({
      sessionID: SessionID,
      status: Info,
    }),
  ),
  // deprecated
  Idle: BusEvent.define(
    "session.idle",
    Schema.Struct({
      sessionID: SessionID,
    }),
  ),
}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info, options?: { notify?: boolean }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

export const BUSY_STATUS_STALE_MS = 60 * 1000
const PERSISTED_STATUS_STALE_MS = 5 * 60 * 1000
type StoredStatus = Exclude<Info, { type: "idle" }>
type StatusRecord = { time_created?: number; time_updated: number; data: Info }

function foreign(err: unknown) {
  if (typeof err !== "object" || err === null) return false
  if ("code" in err && err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") return true
  return "message" in err && typeof err.message === "string" && err.message.includes("FOREIGN KEY constraint failed")
}

export function freshStatus(row: StatusRecord, now = Date.now()) {
  if (row.data.type === "busy" && row.data.until && row.data.until > now) return row.data
  if (row.data.type === "busy") return now - row.time_updated <= BUSY_STATUS_STALE_MS ? row.data : undefined
  if (row.data.type === "retry" && row.data.next > now) return row.data
  return now - row.time_updated <= PERSISTED_STATUS_STALE_MS ? row.data : undefined
}

export function withStartedAt(status: Info, current: StatusRecord | undefined, now = Date.now()): Info {
  if (status.type !== "busy") return status
  const currentFresh = current ? freshStatus(current, now) : undefined
  const currentStartedAt = current && currentFresh?.type === "busy" ? (currentFresh.startedAt ?? current.time_created ?? current.time_updated) : undefined
  return {
    ...status,
    startedAt: status.startedAt ?? currentStartedAt ?? now,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(() => Effect.succeed(new Map<SessionID, StatusRecord>())),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const local = data.get(sessionID)
      if (local) {
        const fresh = freshStatus(local)
        if (fresh) return fresh
        data.delete(sessionID)
      }
      const row = Database.use((db) =>
        db.select().from(SessionStatusTable).where(eq(SessionStatusTable.session_id, sessionID)).get(),
      )
      return row ? (freshStatus(row) ?? { type: "idle" as const }) : { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      const persisted = Database.use((db) => db.select().from(SessionStatusTable).all())
      const now = Date.now()
      const result = new Map<SessionID, Info>()
      for (const row of persisted) {
        const status = freshStatus(row, now)
        if (status) result.set(row.session_id, status)
      }
      const data = yield* InstanceState.get(state)
      for (const [sessionID, record] of data) {
        const status = freshStatus(record, now)
        if (status) result.set(sessionID, status)
        else data.delete(sessionID)
      }
      return result
    })

    const set = Effect.fn("SessionStatus.set")(function* (
      sessionID: SessionID,
      status: Info,
      options?: { notify?: boolean },
    ) {
      const data = yield* InstanceState.get(state)
      const now = Date.now()
      if (status.type === "idle") {
        if (options?.notify !== false) {
          yield* bus.publish(Event.Status, { sessionID, status })
          yield* bus.publish(Event.Idle, { sessionID })
        }
        data.delete(sessionID)
        Database.use((db) => db.delete(SessionStatusTable).where(eq(SessionStatusTable.session_id, sessionID)).run())
        return
      }
      const current = data.get(sessionID)
      const row = current
        ? undefined
        : Database.use((db) =>
            db.select().from(SessionStatusTable).where(eq(SessionStatusTable.session_id, sessionID)).get(),
          )
      const nextStatus = withStartedAt(status, current ?? row, now) as StoredStatus
      if (options?.notify !== false) yield* bus.publish(Event.Status, { sessionID, status: nextStatus })
      data.set(sessionID, {
        time_created: current?.time_created ?? row?.time_created ?? now,
        time_updated: now,
        data: nextStatus,
      })
      if (options?.notify === false) return
      try {
        Database.use((db) =>
          db
            .insert(SessionStatusTable)
            .values({
              session_id: sessionID,
              time_created: row?.time_created ?? now,
              time_updated: now,
              data: nextStatus,
            })
            .onConflictDoUpdate({
              target: SessionStatusTable.session_id,
              set: {
                time_updated: now,
                data: nextStatus,
              },
            })
            .run(),
        )
      } catch (err) {
        if (!foreign(err)) throw err
      }
    })

    return Service.of({ get, list, set })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as SessionStatus from "./status"
