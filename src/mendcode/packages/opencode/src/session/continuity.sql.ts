import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./session.sql"

export const ContinuityRecordTable = sqliteTable(
  "continuity_record",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    directory: text().notNull(),
    kind: text().notNull(),
    generation: integer().notNull(),
    status: text().notNull(),
    data: text().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [index("continuity_session_kind_idx").on(table.session_id, table.kind)],
)
