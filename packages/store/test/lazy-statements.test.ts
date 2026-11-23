import { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { openStore } from "../src"
import { openPrivateDatabase } from "../src/private-database"

const dirs: string[] = []
function tempDir() {
  const dir = mkdtempSync(path.join(import.meta.dir, ".lazy-statements-"))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test("opening a fresh or existing store prepares only startup queries", () => {
  const dir = tempDir()
  for (const phase of ["fresh", "reopened"]) {
    const query = spyOn(Database.prototype, "query")
    const prepare = spyOn(Database.prototype, "prepare")
    let store: ReturnType<typeof openStore> | undefined
    try {
      store = openStore({ dir })
      // Count native statement identities, not the lightweight store wrappers or repeated cache hits.
      const statements = new Set([...query.mock.results, ...prepare.mock.results]
        .filter(result => result.type === "return").map(result => result.value))
      console.info(`${phase} store: ${statements.size} prepared statements`)
      expect(statements.size).toBeGreaterThan(0)
      expect(statements.size).toBeLessThanOrEqual(45)
    } finally { store?.close(); query.mockRestore(); prepare.mockRestore() }
  }
})

test("statements prepare on first use and reuse the native query cache", () => {
  const dir = tempDir()
  const { db } = openPrivateDatabase(dir, path.join(dir, "test.db"))
  const query = spyOn(Database.prototype, "query")
  try {
    db.run("CREATE TABLE items (value TEXT)")
    const insert = db.query("INSERT INTO items VALUES (?)")
    const read = db.query<{ value: string }, []>("SELECT value FROM items")
    expect(query).not.toHaveBeenCalled()
    insert.run("first")
    insert.run("second")
    expect(query).toHaveBeenCalledTimes(1)
    expect(read.all()).toEqual([{ value: "first" }, { value: "second" }])
    expect(read.get()).toEqual({ value: "first" })
    expect(query).toHaveBeenCalledTimes(2)
    // The same SQL from a new wrapper reuses the native statement the first one prepared.
    db.query("SELECT value FROM items").all()
    expect(query).toHaveBeenCalledTimes(2)

    const rollbackInsert = db.query("INSERT INTO items VALUES ('rolled back')")
    expect(() => db.transaction(() => { rollbackInsert.run(); throw new Error("rollback") })()).toThrow("rollback")
    expect(read.all()).toHaveLength(2)
  } finally { query.mockRestore(); db.close() }
})

test("past Bun's own cache of 20 texts, each SQL text is still compiled once, and a prepared statement stays the caller's", () => {
  const dir = tempDir()
  const { db } = openPrivateDatabase(dir, path.join(dir, "test.db"))
  db.run("CREATE TABLE items (value TEXT)")
  const query = spyOn(Database.prototype, "query")
  try {
    const texts = Array.from({ length: 60 }, (_, index) => `SELECT value, ${index} AS n FROM items`)
    for (let round = 0; round < 3; round++) for (const text of texts) db.query(text).all()
    expect(query).toHaveBeenCalledTimes(texts.length)
    // `prepare` may be finalized by its caller (a cursor left early): the shared statement of the same text keeps working.
    const own = db.prepare(texts[0]!)
    own.all()
    own.finalize()
    expect(db.query(texts[0]!).all()).toEqual([])
  } finally { query.mockRestore(); db.close() }
})

test("grouped writes commit together, inside a caller's transaction stay in it, and commit before a statement of their own", async () => {
  const dir = tempDir()
  const file = path.join(dir, "test.db")
  const database = openPrivateDatabase(dir, file)
  const { db } = database
  try {
    db.run("CREATE TABLE items (value TEXT)")
    database.start()
    database.group()
    db.query("INSERT INTO items VALUES ('a')").run()
    database.group()
    db.query("INSERT INTO items VALUES ('b')").run()
    // A transaction of the caller's runs as a savepoint of the group; a script run inside it does not end the group under it.
    db.transaction(() => { db.query("INSERT INTO items VALUES ('c')").run(); db.run("INSERT INTO items VALUES ('d')") })()
    const other = new Database(file, { readonly: true })
    expect(other.query("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 })
    await Bun.sleep(60)
    expect(other.query("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 4 })
    database.group()
    db.query("INSERT INTO items VALUES ('e')").run()
    // A statement run on the connection (a pragma, a script) commits the group first.
    db.run("INSERT INTO items VALUES ('f')")
    expect(other.query("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 6 })
    other.close()
  } finally { db.close() }
})

test("unused and used statements follow privacy connection replacements", () => {
  const dir = tempDir()
  const database = openPrivateDatabase(dir, path.join(dir, "test.db"))
  const { db } = database
  try {
    db.run("CREATE TABLE items (value TEXT)")
    const insert = db.query("INSERT INTO items VALUES (?)")
    const read = db.query<{ value: string }, []>("SELECT value FROM items")
    insert.run("plain")
    database.start()
    database.set(true)
    expect(read.all()).toEqual([{ value: "plain" }])
    insert.run("sealed")
    database.set(false)
    insert.run("plain again")
    expect(read.all()).toEqual([{ value: "plain" }, { value: "sealed" }, { value: "plain again" }])
  } finally { db.close() }
})

test("explicitly prepared bindings and statement metadata remain usable", () => {
  const dir = tempDir()
  const { db } = openPrivateDatabase(dir, path.join(dir, "test.db"))
  const prepare = spyOn(Database.prototype, "prepare")
  try {
    const statement = db.prepare<{ value: string }, string[]>("SELECT ? AS value", ["bound"])
    expect(prepare).not.toHaveBeenCalled()
    expect(statement.columnNames).toEqual(["value"])
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(statement.get()).toEqual({ value: "bound" })
    expect(statement.values()).toEqual([["bound"]])
    expect(prepare).toHaveBeenCalledTimes(1)
    statement.finalize()
  } finally { prepare.mockRestore(); db.close() }
})
