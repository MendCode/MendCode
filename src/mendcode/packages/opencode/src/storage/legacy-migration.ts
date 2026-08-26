import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { sql } from "drizzle-orm"

export type LegacyMigrationEntry = {
  sql: string
  timestamp: number
  name: string
}

const JOURNAL_TABLE = "__drizzle_migrations"
const SAVEPOINT = "mendcode_legacy_migration_statement"
const BREAKPOINT = "--> statement-breakpoint"

type Database = Pick<SQLiteBunDatabase, "all" | "run">
type TableInfoRow = { name: string }
type JournalRow = { name: string | null }

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * Drizzle executes migration chunks separated by its breakpoint marker. A few
 * older bundled migrations predate that marker and contain several statements,
 * so split those chunks without cutting quoted semicolons.
 */
function splitStatements(sql: string) {
  const statements: string[] = []
  let start = 0
  let quote: "'" | '"' | "`" | undefined
  let depth = 0

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]
    const next = sql[index + 1]

    if (quote) {
      if (character === quote) {
        if (next === quote && quote !== "`") {
          index += 1
          continue
        }
        quote = undefined
      }
      continue
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character
      continue
    }
    if (character === "(") {
      depth += 1
      continue
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (character === ";" && depth === 0) {
      const statement = sql.slice(start, index).trim()
      if (statement) statements.push(statement)
      start = index + 1
    }
  }

  const remainder = sql.slice(start).trim()
  if (remainder) statements.push(remainder)
  return statements
}

function migrationStatements(sql: string) {
  return sql
    .split(BREAKPOINT)
    .flatMap((chunk) => splitStatements(chunk))
    .map((statement) => statement.trim())
    .filter(Boolean)
}

function tableInfo(db: Database, table: string) {
  return db.all<TableInfoRow>(`PRAGMA table_info(${quoteIdentifier(table)})`)
}

function hasTable(db: Database, table: string) {
  const rows = db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${JSON.stringify(table)} LIMIT 1`,
  )
  return rows.length > 0
}

function declaredTable(statement: string) {
  const match = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?\s*\((.*)\)$/is.exec(
    statement,
  )
  if (!match) return

  const columns = [
    ...match[2].matchAll(
      /(?:^|,)\s*(?!(?:PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK)\b)[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?\s+/gi,
    ),
  ].map((entry) => entry[1])
  return { table: match[1], columns }
}

function declaredAddedColumn(statement: string) {
  const match =
    /^ALTER\s+TABLE\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?\s+ADD\s+(?:COLUMN\s+)?[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?/i.exec(
      statement,
    )
  return match ? { table: match[1], column: match[2] } : undefined
}

function declaredDroppedColumn(statement: string) {
  const match =
    /^ALTER\s+TABLE\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?\s+DROP\s+COLUMN\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?/i.exec(
      statement,
    )
  return match ? { table: match[1], column: match[2] } : undefined
}

function declaredUpdatedTable(statement: string) {
  const match = /^UPDATE\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?\s+SET\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?/i.exec(
    statement,
  )
  return match ? { table: match[1], column: match[2] } : undefined
}

function errorText(error: unknown) {
  const messages: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error) messages.push(current.message)
    else if (typeof current === "object" && current !== null && "message" in current) {
      const message = (current as { message?: unknown }).message
      if (typeof message === "string") messages.push(message)
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined
  }
  return messages.join("\n") || String(error)
}

function isAlreadyApplied(db: Database, statement: string, error: unknown) {
  const message = errorText(error).toLowerCase()
  const normalized = statement.trim()

  if (/^create\s+table\b/i.test(normalized) && message.includes("already exists")) {
    const declaration = declaredTable(normalized)
    if (!declaration || !hasTable(db, declaration.table)) return false
    const actual = new Set(tableInfo(db, declaration.table).map((row) => row.name))
    return declaration.columns.every((column) => actual.has(column))
  }

  if (/^create\s+(?:unique\s+)?index\b/i.test(normalized) && message.includes("already exists")) {
    return true
  }

  if (/^alter\s+table\b/i.test(normalized) && message.includes("duplicate column name")) {
    const declaration = declaredAddedColumn(normalized)
    return declaration ? tableInfo(db, declaration.table).some((row) => row.name === declaration.column) : false
  }

  if (/^alter\s+table\b/i.test(normalized) && message.includes("no such column")) {
    const declaration = declaredDroppedColumn(normalized)
    return declaration ? !tableInfo(db, declaration.table).some((row) => row.name === declaration.column) : false
  }

  if (/^update\s+/i.test(normalized) && message.includes("no such column")) {
    // A legacy database may already have completed a data-move migration and
    // dropped the source column. Only skip when the destination column exists.
    const declaration = declaredUpdatedTable(normalized)
    return declaration ? tableInfo(db, declaration.table).some((row) => row.name === declaration.column) : false
  }

  if (/^drop\s+table\b/i.test(normalized) && message.includes("no such table")) return true
  if (/^drop\s+index\b/i.test(normalized) && message.includes("no such index")) return true
  return false
}

function runStatement(db: Database, statement: string) {
  db.run(`SAVEPOINT ${SAVEPOINT}`)
  try {
    db.run(statement)
    db.run(`RELEASE SAVEPOINT ${SAVEPOINT}`)
  } catch (error) {
    try {
      db.run(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`)
    } finally {
      db.run(`RELEASE SAVEPOINT ${SAVEPOINT}`)
    }
    if (!isAlreadyApplied(db, statement, error)) throw error
  }
}

function createJournal(db: Database) {
  db.run(
    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(JOURNAL_TABLE)} (\n` +
      `  id INTEGER PRIMARY KEY AUTOINCREMENT,\n` +
      `  hash text NOT NULL,\n` +
      `  created_at numeric,\n` +
      `  name text NOT NULL,\n` +
      `  applied_at text\n` +
      `)`,
  )
}

/**
 * Repairs databases created before MendCode's Drizzle journal was persisted.
 * It is deliberately opt-in: a database must already contain `project`, and
 * unknown journal rows abort reconciliation rather than hiding schema drift.
 */
export function reconcileLegacyMigrationJournal(db: Database, entries: LegacyMigrationEntry[]) {
  if (!hasTable(db, "project")) return false

  const journalExists = hasTable(db, JOURNAL_TABLE)
  const journalRows = journalExists ? db.all<JournalRow>(`SELECT name FROM ${quoteIdentifier(JOURNAL_TABLE)}`) : []
  if (journalRows.some((row) => !row.name)) return false

  const knownNames = new Set(entries.map((entry) => entry.name))
  if (journalRows.some((row) => row.name && !knownNames.has(row.name))) return false

  const applied = new Set(journalRows.flatMap((row) => (row.name ? [row.name] : [])))
  const missing = entries.filter((entry) => !applied.has(entry.name))
  if (missing.length === 0) return false

  db.run("BEGIN")
  try {
    createJournal(db)
    for (const entry of missing) {
      for (const statement of migrationStatements(entry.sql)) runStatement(db, statement)
      db.run(
        sql`INSERT INTO ${sql.identifier(JOURNAL_TABLE)} (hash, created_at, name, applied_at) VALUES (${""}, ${entry.timestamp}, ${entry.name}, ${new Date().toISOString()})`,
      )
    }
    db.run("COMMIT")
    return true
  } catch (error) {
    try {
      db.run("ROLLBACK")
    } catch {
      // Preserve the original migration error.
    }
    throw error
  }
}

export const _test = {
  migrationStatements,
  splitStatements,
}
