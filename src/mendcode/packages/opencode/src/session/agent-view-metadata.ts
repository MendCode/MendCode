import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Database, eq } from "@/storage/db"
import { zod } from "@/util/effect-zod"
import { NonNegativeInt, withStatics } from "@/util/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentViewMetadataTable } from "./session.sql"
import { SessionID } from "./schema"

export const Priority = Schema.Literals(["low", "normal", "high", "urgent"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type Priority = Schema.Schema.Type<typeof Priority>

const Data = Schema.Struct({
  title: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  group: Schema.optional(Schema.String),
  priority: Schema.optional(Priority),
  notes: Schema.optional(Schema.String),
  pinned: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
})
type Data = Schema.Schema.Type<typeof Data>

export const Info = Schema.Struct({
  sessionID: SessionID,
  title: Schema.optional(Schema.String),
  tags: Schema.Array(Schema.String),
  group: Schema.optional(Schema.String),
  priority: Schema.optional(Priority),
  notes: Schema.optional(Schema.String),
  pinned: Schema.Boolean,
  archived: Schema.Boolean,
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
  }),
})
  .annotate({ identifier: "AgentViewMetadata" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

export const Patch = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  tags: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  group: Schema.optional(Schema.NullOr(Schema.String)),
  priority: Schema.optional(Schema.NullOr(Priority)),
  notes: Schema.optional(Schema.NullOr(Schema.String)),
  pinned: Schema.optional(Schema.NullOr(Schema.Boolean)),
  archived: Schema.optional(Schema.NullOr(Schema.Boolean)),
})
  .annotate({ identifier: "AgentViewMetadataPatch" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Patch = Schema.Schema.Type<typeof Patch>

export const Event = {
  Updated: BusEvent.define(
    "agent_view.metadata.updated",
    Schema.Struct({
      sessionID: SessionID,
      info: Info,
    }),
  ),
  Deleted: BusEvent.define(
    "agent_view.metadata.deleted",
    Schema.Struct({
      sessionID: SessionID,
    }),
  ),
}

type Row = typeof AgentViewMetadataTable.$inferSelect

export type PatchInput = Patch & {
  sessionID: SessionID
}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
  readonly patch: (input: PatchInput) => Effect.Effect<Info>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentViewMetadata") {}

function normalizeString(value: string | null | undefined, maxLength: number) {
  if (value === undefined) return undefined
  if (value === null) return null
  const trimmed = value.trim().slice(0, maxLength)
  return trimmed.length > 0 ? trimmed : null
}

function normalizeTags(value: readonly string[] | null | undefined) {
  if (value === undefined) return undefined
  if (value === null) return null
  const seen = new Set<string>()
  return value
    .map((item) => item.trim().slice(0, 40))
    .filter((item) => {
      if (!item || seen.has(item)) return false
      seen.add(item)
      return true
    })
    .slice(0, 20)
}

function withPatch(current: Data | undefined, patch: Patch): Data {
  const title = normalizeString(patch.title, 120)
  const tags = normalizeTags(patch.tags)
  const group = normalizeString(patch.group, 80)
  const notes = normalizeString(patch.notes, 4_000)
  return {
    ...current,
    ...(title !== undefined ? { title: title ?? undefined } : {}),
    ...(tags !== undefined ? { tags: tags?.length ? tags : undefined } : {}),
    ...(group !== undefined ? { group: group ?? undefined } : {}),
    ...(patch.priority !== undefined ? { priority: patch.priority ?? undefined } : {}),
    ...(notes !== undefined ? { notes: notes ?? undefined } : {}),
    ...(patch.pinned !== undefined ? { pinned: patch.pinned ?? undefined } : {}),
    ...(patch.archived !== undefined ? { archived: patch.archived ?? undefined } : {}),
  }
}

function hasData(data: Data) {
  return Boolean(
    data.title ||
      data.group ||
      data.priority ||
      data.notes ||
      data.pinned ||
      data.archived ||
      (data.tags && data.tags.length > 0),
  )
}

function fromData(input: { sessionID: SessionID; data?: Data; created: number; updated: number }): Info {
  return {
    sessionID: input.sessionID,
    title: input.data?.title,
    tags: input.data?.tags ?? [],
    group: input.data?.group,
    priority: input.data?.priority,
    notes: input.data?.notes,
    pinned: input.data?.pinned ?? false,
    archived: input.data?.archived ?? false,
    time: {
      created: input.created,
      updated: input.updated,
    },
  }
}

function fromRow(row: Row): Info {
  return fromData({
    sessionID: row.session_id,
    data: row.data,
    created: row.time_created,
    updated: row.time_updated,
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const get = Effect.fn("AgentViewMetadata.get")(function* (sessionID: SessionID) {
      const row = Database.use((db) =>
        db.select().from(AgentViewMetadataTable).where(eq(AgentViewMetadataTable.session_id, sessionID)).get(),
      )
      return row ? fromRow(row) : undefined
    })

    const list = Effect.fn("AgentViewMetadata.list")(function* () {
      return Database.use((db) => db.select().from(AgentViewMetadataTable).all())
        .map(fromRow)
        .toSorted((a, b) => b.time.updated - a.time.updated || b.sessionID.localeCompare(a.sessionID))
    })

    const patch = Effect.fn("AgentViewMetadata.patch")(function* (input: PatchInput) {
      const result = Database.transaction(
        (db) => {
          const now = Date.now()
          const row = db
            .select()
            .from(AgentViewMetadataTable)
            .where(eq(AgentViewMetadataTable.session_id, input.sessionID))
            .get()
          const data = withPatch(row?.data, input)
          if (!hasData(data)) {
            if (row) {
              db.delete(AgentViewMetadataTable).where(eq(AgentViewMetadataTable.session_id, input.sessionID)).run()
            }
            return { info: fromData({ sessionID: input.sessionID, created: row?.time_created ?? now, updated: now }), deleted: true }
          }
          db.insert(AgentViewMetadataTable)
            .values({
              session_id: input.sessionID,
              time_created: row?.time_created ?? now,
              time_updated: now,
              data,
            })
            .onConflictDoUpdate({
              target: AgentViewMetadataTable.session_id,
              set: {
                time_updated: now,
                data,
              },
            })
            .run()
          return {
            info: fromData({ sessionID: input.sessionID, data, created: row?.time_created ?? now, updated: now }),
            deleted: false,
          }
        },
        { behavior: "immediate" },
      )
      if (result.deleted) {
        yield* bus.publish(Event.Deleted, { sessionID: input.sessionID })
        return result.info
      }
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, info: result.info })
      return result.info
    })

    const remove = Effect.fn("AgentViewMetadata.remove")(function* (sessionID: SessionID) {
      const row = Database.use((db) =>
        db.select().from(AgentViewMetadataTable).where(eq(AgentViewMetadataTable.session_id, sessionID)).get(),
      )
      if (!row) return
      Database.use((db) => db.delete(AgentViewMetadataTable).where(eq(AgentViewMetadataTable.session_id, sessionID)).run())
      yield* bus.publish(Event.Deleted, { sessionID })
    })

    return Service.of({ get, list, patch, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as AgentViewMetadata from "./agent-view-metadata"
