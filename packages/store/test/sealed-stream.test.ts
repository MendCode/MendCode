import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openPrivateDatabase } from "../src/private-database"
import { atomicPrivateWrite, createSealedFiles } from "../src/sealed-file"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mend-sealed-")); dirs.push(dir); return dir }
/** Larger than one streamed slice, not a multiple of it, so the last slice is partial. */
const large = () => { const bytes = Buffer.allocUnsafe(9 * 1024 * 1024 + 4321); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255; return bytes }

test("a streamed seal is the same format as a whole one: each opens the other's file", () => {
  const dir = temp()
  const sealed = createSealedFiles(dir, "chats", () => false)
  const bytes = large()
  const streamed = path.join(dir, "streamed")
  sealed.sealToFile(streamed, bytes, "database")
  expect(statSync(streamed).size).toBe(bytes.length + 36)
  expect(sealed.open(readFileSync(streamed), "database", true).equals(bytes)).toBe(true)
  const whole = path.join(dir, "whole")
  atomicPrivateWrite(whole, sealed.seal(bytes, "database"))
  expect(sealed.openFile(whole, "database").equals(bytes)).toBe(true)
})

test("a streamed open refuses a damaged file, a wrong context and a plain file", () => {
  const dir = temp()
  const sealed = createSealedFiles(dir, "chats", () => false)
  const file = path.join(dir, "db")
  sealed.sealToFile(file, large(), "database")
  expect(() => sealed.openFile(file, "blob")).toThrow("authentication failed")
  const damaged = readFileSync(file)
  damaged.writeUInt8(damaged.readUInt8(5 * 1024 * 1024) ^ 1, 5 * 1024 * 1024)
  writeFileSync(file, damaged)
  expect(() => sealed.openFile(file, "database")).toThrow("authentication failed")
  writeFileSync(file, Buffer.from("SQLite format 3\0 plain bytes, long enough to pass the size check"))
  expect(() => sealed.openFile(file, "database")).toThrow("authentication failed")
})

function encrypted(dir: string) {
  const file = path.join(dir, "mendd.db")
  const opened = openPrivateDatabase(dir, file)
  opened.start()
  opened.db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
  opened.db.query("INSERT INTO t VALUES (1, 'one')").run()
  opened.set(true)
  return { file, opened }
}
const inode = (file: string) => statSync(file).ino

test("with encryption on, a statement that changes nothing leaves the sealed file as it is", () => {
  const dir = temp()
  const { file, opened } = encrypted(dir)
  const before = inode(file)
  opened.db.query("INSERT OR IGNORE INTO t VALUES (1, 'again')").run()
  opened.db.run("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)")
  opened.db.query("UPDATE t SET v = 'x' WHERE id = 99").run()
  opened.db.transaction(() => { opened.db.query("DELETE FROM t WHERE id = 99").run() })()
  expect(inode(file)).toBe(before)
  opened.db.close()
})

test("with encryption on, every real change is sealed and survives a reopen: rows, schema and user version", () => {
  const dir = temp()
  const { file, opened } = encrypted(dir)
  let last = inode(file)
  const changed = () => { const now = inode(file); const moved = now !== last; last = now; return moved }
  opened.db.query("INSERT INTO t VALUES (2, 'two')").run()
  expect(changed()).toBe(true)
  opened.db.run("CREATE TABLE u (k TEXT)")
  expect(changed()).toBe(true)
  opened.db.run("PRAGMA user_version = 7")
  expect(changed()).toBe(true)
  opened.db.transaction(() => { opened.db.query("UPDATE t SET v = 'TWO' WHERE id = 2").run() })()
  expect(changed()).toBe(true)
  opened.db.close()
  const reopened = openPrivateDatabase(dir, file)
  reopened.start()
  expect(reopened.enabled()).toBe(true)
  expect(reopened.db.query("SELECT v FROM t ORDER BY id").all()).toEqual([{ v: "one" }, { v: "TWO" }])
  expect(reopened.db.query("SELECT name FROM sqlite_master WHERE name = 'u'").get()).toEqual({ name: "u" })
  expect(reopened.db.query("PRAGMA user_version").get()).toEqual({ user_version: 7 })
  // Opening and reading an encrypted database writes nothing.
  const opened2 = inode(file)
  reopened.db.query("SELECT COUNT(*) AS n FROM t").get()
  expect(inode(file)).toBe(opened2)
  reopened.db.close()
})

test("an encrypted database sealed whole, as earlier versions wrote it, still opens", () => {
  const dir = temp()
  const file = path.join(dir, "mendd.db")
  const plain = new Database(":memory:")
  plain.run("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('written by an older version')")
  const sealed = createSealedFiles(dir, "chats", () => false)
  atomicPrivateWrite(file, sealed.seal(plain.serialize(), "database"))
  plain.close()
  const reopened = openPrivateDatabase(dir, file)
  reopened.start()
  expect(reopened.enabled()).toBe(true)
  expect(reopened.db.query("SELECT v FROM t").get()).toEqual({ v: "written by an older version" })
  reopened.db.close()
})
