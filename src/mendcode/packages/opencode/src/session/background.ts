import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Database, eq } from "@/storage/db"
import { zod } from "@/util/effect-zod"
import { NonNegativeInt, withStatics } from "@/util/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { BackgroundSessionTable } from "./session.sql"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

export const State = Schema.Literals(["queued", "working", "needs_input", "completed", "failed", "stopped"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type State = Schema.Schema.Type<typeof State>

const ProcessInfo = Schema.Struct({
  pid: NonNegativeInt,
  started: NonNegativeInt,
})

const WriterLease = Schema.Struct({
  clientID: Schema.String,
  acquired: NonNegativeInt,
  expires: NonNegativeInt,
})
export type WriterLease = Schema.Schema.Type<typeof WriterLease>

const Data = Schema.Struct({
  state: State,
  summary: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  pinned: Schema.optional(Schema.Boolean),
  process: Schema.optional(ProcessInfo),
  writer: Schema.optional(WriterLease),
})
type Data = Schema.Schema.Type<typeof Data>

const InfoFields = {
  sessionID: SessionID,
  state: State,
  summary: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  pinned: Schema.Boolean,
  process: Schema.optional(ProcessInfo),
  writer: Schema.optional(WriterLease),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
  }),
}

export const Info = Schema.Struct(InfoFields)
  .annotate({ identifier: "BackgroundSession" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

const SessionInfo = Schema.Struct({
  id: SessionID,
  title: Schema.String,
  directory: Schema.String,
  path: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
  }),
})

export const Entry = Schema.Struct({
  ...InfoFields,
  session: Schema.optional(SessionInfo),
})
  .annotate({ identifier: "BackgroundSessionEntry" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Entry = Schema.Schema.Type<typeof Entry>
export type EntrySession = NonNullable<Entry["session"]>

export const Event = {
  Updated: BusEvent.define(
    "background_session.updated",
    Schema.Struct({
      sessionID: SessionID,
      info: Info,
    }),
  ),
  Deleted: BusEvent.define(
    "background_session.deleted",
    Schema.Struct({
      sessionID: SessionID,
    }),
  ),
}

type Row = typeof BackgroundSessionTable.$inferSelect

export type RegisterInput = {
  sessionID: SessionID
  state?: State
  summary?: string
  error?: string
  pinned?: boolean
  process?: Data["process"]
}

export type WriterInput = {
  sessionID: SessionID
  clientID: string
  ttlMs?: number
}

export type AcquireWriterResult =
  | {
      acquired: true
      info: Info
    }
  | {
      acquired: false
      info?: Info
    }

export interface Interface {
  readonly register: (input: RegisterInput) => Effect.Effect<Info>
  readonly setState: (input: RegisterInput & { state: State }) => Effect.Effect<Info>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void>
  readonly acquireWriter: (input: WriterInput) => Effect.Effect<AcquireWriterResult>
  readonly releaseWriter: (input: { sessionID: SessionID; clientID: string }) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BackgroundSession") {}

function fromRow(row: Row): Info {
  return {
    sessionID: row.session_id,
    state: row.data.state,
    summary: row.data.summary,
    error: row.data.error,
    pinned: row.data.pinned ?? false,
    process: row.data.process,
    writer: row.data.writer,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  }
}

function nextData(input: RegisterInput, current?: Data): Data {
  return {
    ...current,
    state: input.state ?? current?.state ?? "queued",
    summary: input.summary ?? current?.summary,
    error: input.error ?? current?.error,
    pinned: input.pinned ?? current?.pinned,
    process: input.process ?? current?.process,
  }
}

export function deriveState(input: {
  background?: Info
  status?: SessionStatus.Info
  pendingInput?: number
}): State {
  if (input.background?.state === "failed" || input.background?.state === "stopped") return input.background.state
  if ((input.pendingInput ?? 0) > 0 || input.status?.type === "retry") return "needs_input"
  if (input.status?.type === "busy") return "working"
  if (input.background?.state === "working") return "completed"
  return input.background?.state ?? "completed"
}

export function sessionInfo(input: {
  id: SessionID
  title: string
  directory: string
  path?: string
  agent?: string
  time: { created: number; updated: number }
}): EntrySession {
  return {
    id: input.id,
    title: input.title,
    directory: input.directory,
    path: input.path,
    agent: input.agent,
    time: {
      created: input.time.created,
      updated: input.time.updated,
    },
  }
}

export function toEntry(input: {
  info: Info
  status?: SessionStatus.Info
  pendingInput?: number
  session?: EntrySession
}): Entry {
  return {
    ...input.info,
    state: deriveState({
      background: input.info,
      status: input.status,
      pendingInput: input.pendingInput,
    }),
    session: input.session,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const publishUpdated = (info: Info) =>
      bus.publish(Event.Updated, {
        sessionID: info.sessionID,
        info,
      })

    const register = Effect.fn("BackgroundSession.register")(function* (input: RegisterInput) {
      const info = Database.transaction((db) => {
        const now = Date.now()
        const row = db
          .select()
          .from(BackgroundSessionTable)
          .where(eq(BackgroundSessionTable.session_id, input.sessionID))
          .get()
        const data = nextData(input, row?.data)
        db.insert(BackgroundSessionTable)
          .values({
            session_id: input.sessionID,
            time_created: row?.time_created ?? now,
            time_updated: now,
            data,
          })
          .onConflictDoUpdate({
            target: BackgroundSessionTable.session_id,
            set: {
              time_updated: now,
              data,
            },
          })
          .run()
        return fromRow({
          session_id: input.sessionID,
          time_created: row?.time_created ?? now,
          time_updated: now,
          data,
        })
      })
      yield* publishUpdated(info)
      return info
    })

    const setState: Interface["setState"] = (input) => register(input)

    const get = Effect.fn("BackgroundSession.get")(function* (sessionID: SessionID) {
      const row = Database.use((db) =>
        db.select().from(BackgroundSessionTable).where(eq(BackgroundSessionTable.session_id, sessionID)).get(),
      )
      return row ? fromRow(row) : undefined
    })

    const list = Effect.fn("BackgroundSession.list")(function* () {
      return Database.use((db) => db.select().from(BackgroundSessionTable).all())
        .map(fromRow)
        .toSorted((a, b) => b.time.updated - a.time.updated || b.sessionID.localeCompare(a.sessionID))
    })

    const remove = Effect.fn("BackgroundSession.remove")(function* (sessionID: SessionID) {
      const row = Database.use((db) =>
        db.select().from(BackgroundSessionTable).where(eq(BackgroundSessionTable.session_id, sessionID)).get(),
      )
      if (row) {
        Database.use((db) =>
          db.delete(BackgroundSessionTable).where(eq(BackgroundSessionTable.session_id, sessionID)).run(),
        )
        yield* bus.publish(Event.Deleted, { sessionID })
      }
    })

    const acquireWriter = Effect.fn("BackgroundSession.acquireWriter")(function* (
      input: WriterInput,
    ) {
      const result = Database.transaction(
        (db): AcquireWriterResult => {
          const now = Date.now()
          const row = db
            .select()
            .from(BackgroundSessionTable)
            .where(eq(BackgroundSessionTable.session_id, input.sessionID))
            .get()
          if (!row) return { acquired: false }
          const writer = row.data.writer
          if (writer && writer.clientID !== input.clientID && writer.expires > now) {
            return { acquired: false, info: fromRow(row) }
          }
          const data: Data = {
            ...row.data,
            writer: {
              clientID: input.clientID,
              acquired: now,
              expires: now + Math.max(1, input.ttlMs ?? 30_000),
            },
          }
          db.update(BackgroundSessionTable)
            .set({ data, time_updated: now })
            .where(eq(BackgroundSessionTable.session_id, input.sessionID))
            .run()
          return {
            acquired: true,
            info: fromRow({ ...row, data, time_updated: now }),
          }
        },
        { behavior: "immediate" },
      )
      if (result.acquired) yield* publishUpdated(result.info)
      return result
    })

    const releaseWriter = Effect.fn("BackgroundSession.releaseWriter")(function* (input: {
      sessionID: SessionID
      clientID: string
    }) {
      const info = Database.transaction(
        (db) => {
          const now = Date.now()
          const row = db
            .select()
            .from(BackgroundSessionTable)
            .where(eq(BackgroundSessionTable.session_id, input.sessionID))
            .get()
          if (!row || row.data.writer?.clientID !== input.clientID) return undefined
          const { writer: _writer, ...data } = row.data
          db.update(BackgroundSessionTable)
            .set({ data, time_updated: now })
            .where(eq(BackgroundSessionTable.session_id, input.sessionID))
            .run()
          return fromRow({ ...row, data, time_updated: now })
        },
        { behavior: "immediate" },
      )
      if (info) yield* publishUpdated(info)
      return info
    })

    return Service.of({ register, setState, get, list, remove, acquireWriter, releaseWriter })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as BackgroundSession from "./background"
