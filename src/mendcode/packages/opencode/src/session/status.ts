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
    kind: Schema.optional(Schema.Union([Schema.Literal("mflow-wait"), Schema.Literal("memory-extract")])),
    message: Schema.optional(Schema.String),
    until: Schema.optional(NonNegativeInt),
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
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

function foreign(err: unknown) {
  if (typeof err !== "object" || err === null) return false
  if ("code" in err && err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") return true
  return "message" in err && typeof err.message === "string" && err.message.includes("FOREIGN KEY constraint failed")
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(() => Effect.succeed(new Map<SessionID, Info>())),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const local = data.get(sessionID)
      if (local) return local
      const row = Database.use((db) =>
        db.select().from(SessionStatusTable).where(eq(SessionStatusTable.session_id, sessionID)).get(),
      )
      return row?.data ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      const persisted = Database.use((db) => db.select().from(SessionStatusTable).all())
      const result = new Map<SessionID, Info>(persisted.map((row) => [row.session_id, row.data]))
      const data = yield* InstanceState.get(state)
      for (const [sessionID, status] of data) {
        result.set(sessionID, status)
      }
      return result
    })

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      const data = yield* InstanceState.get(state)
      yield* bus.publish(Event.Status, { sessionID, status })
      if (status.type === "idle") {
        yield* bus.publish(Event.Idle, { sessionID })
        data.delete(sessionID)
        Database.use((db) => db.delete(SessionStatusTable).where(eq(SessionStatusTable.session_id, sessionID)).run())
        return
      }
      data.set(sessionID, status)
      try {
        Database.use((db) =>
          db
            .insert(SessionStatusTable)
            .values({
              session_id: sessionID,
              time_created: Date.now(),
              time_updated: Date.now(),
              data: status,
            })
            .onConflictDoUpdate({
              target: SessionStatusTable.session_id,
              set: {
                time_updated: Date.now(),
                data: status,
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
