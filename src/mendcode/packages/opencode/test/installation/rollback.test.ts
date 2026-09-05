import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { tmpdir } from "../fixture/fixture"
import { rollback, rollbackTarget } from "../../src/installation/rollback"
import { acquireDatabaseMaintenance } from "../../src/storage/compatibility"

const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const journal = [{ name: "20260904000000_base", timestamp: 1, hash: hash("base") }]

async function installation(root: string) {
  const executable = path.join(root, "mendcode")
  await fs.writeFile(executable, "current binary")
  const previous = path.join(root, ".update.old")
  const current = path.join(root, ".update.current")
  await fs.mkdir(previous)
  await fs.mkdir(current)
  await fs.writeFile(path.join(previous, "status"), `version=0.1.44\nphase=activated\nbinary_sha256=${hash("old binary")}\n`)
  await fs.writeFile(path.join(previous, "compatibility.json"), JSON.stringify({
    formatVersion: 1, version: "0.1.44", digest: hash("old binary"), journal,
  }))
  await fs.writeFile(path.join(current, "status"), `version=0.1.45\nphase=activated\nbinary_sha256=${hash("current binary")}\nprevious_sha256=${hash("old binary")}\n`)
  await fs.writeFile(path.join(current, "previous"), "old binary")
  return { executable, current, previous }
}

test("rollback verifies retained identity, holds maintenance through activation and preserves the current executable", async () => {
  await using tmp = await tmpdir()
  const { executable } = await installation(tmp.path)
  let released = false
  const result = await rollback({ executable, version: "0.1.45", maintain: async (metadata) => {
    expect(metadata.version).toBe("0.1.44")
    expect(await fs.readFile(executable, "utf8")).toBe("current binary")
    return async () => {
      expect(await fs.readFile(executable, "utf8")).toBe("old binary")
      released = true
    }
  } })
  expect(released).toBe(true)
  expect(result.version).toBe("0.1.44")
  expect(await fs.readFile(path.join(result.operation, "previous"), "utf8")).toBe("current binary")
  expect(await fs.readFile(path.join(result.operation, "status"), "utf8")).toContain("phase=activated")
  expect(await fs.readdir(tmp.path)).not.toContain(".update-lock")
})

test("a previous binary without compatibility history cannot be executed or activated", async () => {
  await using tmp = await tmpdir()
  const { executable, previous } = await installation(tmp.path)
  await fs.rename(path.join(previous, "compatibility.json"), path.join(previous, "compatibility.unavailable"))
  await expect(rollbackTarget(executable, "0.1.45")).rejects.toThrow("Compatibility of the previous executable is unknown")
  expect(await fs.readFile(executable, "utf8")).toBe("current binary")
})

test("tampered retained executable is rejected before database maintenance", async () => {
  await using tmp = await tmpdir()
  const { executable, current } = await installation(tmp.path)
  await fs.writeFile(path.join(current, "previous"), "different binary")
  let maintained = false
  await expect(rollback({ executable, version: "0.1.45", maintain: async () => {
    maintained = true
    return () => {}
  } })).rejects.toThrow("checksum changed")
  expect(maintained).toBe(false)
  expect(await fs.readFile(executable, "utf8")).toBe("current binary")
})

test("incompatible data blocks rollback without changing database or binary bytes", async () => {
  await using tmp = await tmpdir()
  const { executable } = await installation(tmp.path)
  const file = path.join(tmp.path, "future.db")
  const db = new Database(file)
  db.run("CREATE TABLE __drizzle_migrations(name TEXT, created_at INTEGER)")
  db.run("INSERT INTO __drizzle_migrations VALUES ('future', 2)")
  db.close()
  const before = await fs.readFile(file)
  await expect(rollback({ executable, version: "0.1.45", maintain: async ({ journal }) => {
    const maintenance = acquireDatabaseMaintenance(file, journal)
    return () => maintenance.release()
  } })).rejects.toThrow("Unsupported database migration")
  expect(await fs.readFile(file)).toEqual(before)
  expect(await fs.readFile(executable, "utf8")).toBe("current binary")
})

test("an active updater lock prevents rollback without reclaiming its owner", async () => {
  await using tmp = await tmpdir()
  const { executable } = await installation(tmp.path)
  await fs.mkdir(path.join(tmp.path, ".update-lock"))
  await expect(rollback({ executable, version: "0.1.45", maintain: async () => () => {} })).rejects.toThrow("Another update")
  expect(await fs.readdir(tmp.path)).toContain(".update-lock")
  expect(await fs.readFile(executable, "utf8")).toBe("current binary")
})

test("Windows cannot silently use POSIX binary replacement", async () => {
  await expect(rollback({ executable: "unused", version: "0.1.45", platform: "win32", maintain: async () => () => {} }))
    .rejects.toThrow("verified deferred replacement")
})
