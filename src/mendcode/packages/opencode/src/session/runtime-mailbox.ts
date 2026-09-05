import { Database, and, eq, inArray, desc, lt, sql } from "@/storage/db"
import { ContinuityRecordTable as Table } from "./continuity.sql"
import { SessionID } from "./schema"
import { BusEvent } from "@/bus/bus-event"
import { Schema } from "effect"

export type Record = {
  id: string
  sessionID: SessionID
  directory: string
  kind: "job" | "question" | "event" | "generation" | "note"
  generation: number
  status: string
  data: { [key: string]: unknown }
  timeCreated: number
  timeUpdated: number
}
export const Event = {
  Updated: BusEvent.define(
    "continuity.updated",
    Schema.Struct({ sessionID: SessionID, id: Schema.String, kind: Schema.String, status: Schema.String }),
  ),
}
function decode(row: typeof Table.$inferSelect): Record {
  return {
    id: row.id,
    sessionID: SessionID.make(row.session_id),
    directory: row.directory,
    kind: row.kind as Record["kind"],
    generation: row.generation,
    status: row.status,
    data: JSON.parse(row.data),
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  }
}
export function getRecord(sessionID: SessionID, id: string) {
  const row = Database.use((db) =>
    db
      .select()
      .from(Table)
      .where(and(eq(Table.id, id), eq(Table.session_id, sessionID)))
      .get(),
  )
  return row ? decode(row) : undefined
}
export function getDirectoryRecord(directory: string, id: string, kind: Record["kind"]) {
  const row = Database.use((db) =>
    db
      .select()
      .from(Table)
      .where(and(eq(Table.id, id), eq(Table.directory, directory), eq(Table.kind, kind)))
      .get(),
  )
  return row ? decode(row) : undefined
}
type ListOptions = { limit?: number; before?: number; statuses?: string[]; generation?: number }
export function listRecords(sessionID: SessionID, kind?: Record["kind"], options: ListOptions = {}) {
  return Database.use((db) =>
    db
      .select()
      .from(Table)
      .where(
        and(
          eq(Table.session_id, sessionID),
          kind ? eq(Table.kind, kind) : undefined,
          options.statuses ? inArray(Table.status, options.statuses) : undefined,
          options.before === undefined ? undefined : lt(Table.time_created, options.before),
          options.generation === undefined ? undefined : eq(Table.generation, options.generation),
        ),
      )
      .orderBy(desc(Table.time_created))
      .limit(Math.max(1, Math.min(1000, options.limit ?? 100)))
      .all(),
  ).map(decode)
}
export function directoryRecords(directory: string, kind: Record["kind"], options: ListOptions = {}) {
  return Database.use((db) =>
    db
      .select()
      .from(Table)
      .where(
        and(
          eq(Table.directory, directory),
          eq(Table.kind, kind),
          options.statuses ? inArray(Table.status, options.statuses) : undefined,
        ),
      )
      .orderBy(desc(Table.time_created))
      .limit(Math.max(1, Math.min(1000, options.limit ?? 1000)))
      .all(),
  ).map(decode)
}
export function putRecord(record: Record) {
  Database.use((db) =>
    db
      .insert(Table)
      .values({
        id: record.id,
        session_id: record.sessionID,
        directory: record.directory,
        kind: record.kind,
        generation: record.generation,
        status: record.status,
        data: JSON.stringify(record.data),
        time_created: record.timeCreated,
        time_updated: Date.now(),
      })
      .onConflictDoUpdate({
        target: Table.id,
        set: {
          status: record.status,
          data: JSON.stringify(record.data),
          generation: record.generation,
          time_updated: Date.now(),
        },
      })
      .run(),
  )
  return record
}
export function generation(sessionID: SessionID) {
  return getRecord(sessionID, `generation_${sessionID}`)?.generation ?? 0
}
export function cancelGeneration(sessionID: SessionID, directory: string) {
  const next = generation(sessionID) + 1
  putRecord({
    id: `generation_${sessionID}`,
    sessionID,
    directory,
    kind: "generation",
    generation: next,
    status: "active",
    data: {},
    timeCreated: Date.now(),
    timeUpdated: Date.now(),
  })
  return next
}
export function enqueueResult(record: Record) {
  const id = `event_${record.id}`
  if (getRecord(record.sessionID, id)) return
  putRecord({
    ...record,
    id,
    kind: "event",
    status:
      record.generation === generation(record.sessionID) && record.data.continuationCancelled !== true
        ? "pending"
        : "cancelled",
    data: { recordID: record.id, kind: record.kind, status: record.status },
  })
}
export function completeRecord(record: Record) {
  return Database.transaction(() => {
    putRecord(record)
    enqueueResult(record)
    return record
  })
}
export function pendingEvents(sessionID: SessionID) {
  return listRecords(sessionID, "event", { statuses: ["pending"], generation: generation(sessionID), limit: 100 }).sort(
    (a, b) => a.timeCreated - b.timeCreated,
  )
}
export function boundedEventBatch(events: Record[], maxChars = 24000) {
  const included: Record[] = []
  for (const event of events) {
    if (JSON.stringify(eventContext([...included, event])).length > maxChars) break
    included.push(event)
  }
  return included
}
export function acknowledgeEvents(events: Record[]) {
  Database.transaction(() => events.forEach((event) => putRecord({ ...event, status: "delivered" })))
}
export function cancelContinuations(directory: string, kind: "job" | "question") {
  Database.use((db) => db.update(Table).set({ status: "cancelled", time_updated: Date.now() }).where(and(eq(Table.directory, directory), eq(Table.kind, "event"), eq(Table.status, "pending"), sql`json_extract(${Table.data}, '$.kind') = ${kind}`)).run())
}
export function eventContext(events: Record[]) {
  return events.map((event) => {
    const record = getRecord(event.sessionID, String(event.data.recordID))
    const result = record?.data.result ?? record?.data.answers ?? record?.data.error
    return {
      event_id: event.id,
      record_id: record?.id,
      kind: record?.kind,
      status: record?.status,
      result: (typeof result === "string" ? result : JSON.stringify(result))?.slice(0, 4096),
    }
  })
}
