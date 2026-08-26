import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { reconcileLegacyMigrationJournal } from "../../src/storage/legacy-migration"

const projectTable = `
  CREATE TABLE "project" (
    "id" text PRIMARY KEY,
    "worktree" text NOT NULL,
    "vcs" text,
    "name" text,
    "icon_url" text,
    "icon_color" text,
    "time_created" integer NOT NULL,
    "time_updated" integer NOT NULL,
    "time_initialized" integer,
    "sandboxes" text NOT NULL
  )
`

const initial = {
  name: "20260127222353_familiar_lady_ursula",
  timestamp: 1769552633000,
  sql: `${projectTable};
    --> statement-breakpoint
    CREATE TABLE "message" ("id" text PRIMARY KEY NOT NULL, "session_id" text NOT NULL);
    --> statement-breakpoint
    CREATE INDEX "message_session_idx" ON "message" ("session_id");
  `,
}

describe("legacy sqlite migration reconciliation", () => {
  test("rebuilds the journal and preserves already-created tables", () => {
    const sqlite = new Database(":memory:")
    const db = drizzle({ client: sqlite })
    db.run(projectTable)

    const changed = {
      name: "20260128000000_add_workspace",
      timestamp: 1769558400000,
      sql: `ALTER TABLE "project" ADD COLUMN "workspace" text;`,
    }

    expect(reconcileLegacyMigrationJournal(db, [initial, changed])).toBe(true)
    expect(
      sqlite
        .query(`SELECT name FROM "__drizzle_migrations" ORDER BY id`)
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual([initial.name, changed.name])
    expect(sqlite.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message'`).all()).toHaveLength(
      1,
    )
    expect(
      sqlite
        .query(`PRAGMA table_info("project")`)
        .all()
        .some((row) => (row as { name: string }).name === "workspace"),
    ).toBe(true)

    sqlite.close()
  })

  test("does not mask an incompatible existing table", () => {
    const sqlite = new Database(":memory:")
    const db = drizzle({ client: sqlite })
    db.run(`CREATE TABLE "project" ("id" text PRIMARY KEY, "worktree" text NOT NULL)`)

    expect(() => reconcileLegacyMigrationJournal(db, [initial])).toThrow(/CREATE TABLE/)
    expect(sqlite.query(`SELECT name FROM sqlite_master WHERE name = '__drizzle_migrations'`).all()).toHaveLength(0)

    sqlite.close()
  })

  test("leaves a fresh database on the normal Drizzle migration path", () => {
    const sqlite = new Database(":memory:")
    const db = drizzle({ client: sqlite })
    expect(reconcileLegacyMigrationJournal(db, [initial])).toBe(false)
    expect(sqlite.query(`SELECT name FROM sqlite_master WHERE name = '__drizzle_migrations'`).all()).toHaveLength(0)
    sqlite.close()
  })
})
