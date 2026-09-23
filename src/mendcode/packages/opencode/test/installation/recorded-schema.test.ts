import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { assertRecordedSchema } from "../../src/storage/recorded-schema"

test("stable refuses an incompatible beta schema without changing data", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "sessions.db")
  const db = new Database(file)
  db.run("CREATE TABLE session(id TEXT); INSERT INTO session VALUES ('preserved')")
  db.run("CREATE TABLE __mendcode_schema_identity(name TEXT, timestamp INTEGER, hash TEXT)")
  const entry = { name: "future", timestamp: 1, sql: "CREATE TABLE future(id TEXT)" }
  db.query("INSERT INTO __mendcode_schema_identity VALUES (?, ?, ?)").run(entry.name, entry.timestamp, createHash("sha256").update(entry.sql).digest("hex"))
  db.close()
  const before = await fs.readFile(file)
  expect(() => assertRecordedSchema(file, [])).toThrow("incompatible release")
  expect(await fs.readFile(file)).toEqual(before)
  expect(() => assertRecordedSchema(file, [entry])).not.toThrow()
  expect(() => assertRecordedSchema(file, [{ ...entry, sql: "different" }])).toThrow("incompatible release")
})

test("legacy databases keep the existing migration path", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "legacy.db")
  const db = new Database(file)
  db.run("CREATE TABLE session(id TEXT)")
  db.close()
  expect(() => assertRecordedSchema(file, [])).not.toThrow()
})
