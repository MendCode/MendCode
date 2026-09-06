import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { sql } from "drizzle-orm"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"

describe("SQLite identifier escaping", () => {
  test("doubles embedded identifier quotes", () => {
    expect(new SQLiteSyncDialect().escapeName('quoted"identifier')).toBe('"quoted""identifier"')
  })

  test("keeps SQL-shaped aliases as literal identifiers", () => {
    const database = new Database(":memory:")
    try {
      database.exec("create table sentinel (id integer)")
      const alias = 'value"; drop table sentinel; --'
      const query = new SQLiteSyncDialect().sqlToQuery(sql`select 1 as ${sql.identifier(alias)}`)
      expect(database.prepare(query.sql).get()).toEqual({ [alias]: 1 })
      expect(database.prepare("select count(*) as count from sentinel").get()).toEqual({ count: 0 })
    } finally {
      database.close()
    }
  })
})
