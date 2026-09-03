import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { Database } from "bun:sqlite"
import path from "path"
import os from "os"
import { runGlobalLayoutMigrationFromDirs } from "@/storage/global-layout-migration"
import { GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME } from "@mendcode/core/global-layout"

describe("global-layout migration", () => {
  test("copies legacy roots and writes marker", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "glm-"))
    const legacy = {
      data: path.join(base, "legacy", "data"),
      cache: path.join(base, "legacy", "cache"),
      config: path.join(base, "legacy", "config"),
      state: path.join(base, "legacy", "state"),
      tmp: path.join(base, "legacy", "tmp"),
      bin: path.join(base, "legacy", "cache", "bin"),
      log: path.join(base, "legacy", "data", "log"),
    }
    const mend = {
      data: path.join(base, "mend", "data"),
      cache: path.join(base, "mend", "cache"),
      config: path.join(base, "mend", "config"),
      state: path.join(base, "mend", "state"),
      tmp: path.join(base, "mend", "tmp"),
      bin: path.join(base, "mend", "cache", "bin"),
      log: path.join(base, "mend", "data", "log"),
    }
    mkdirSync(legacy.data, { recursive: true })
    writeFileSync(path.join(legacy.data, ".mendcode-json-storage-migration-v0.done"), "")
    mkdirSync(path.join(legacy.data, "storage"))
    writeFileSync(path.join(legacy.data, "storage", "owned.json"), "{}")
    const r = await runGlobalLayoutMigrationFromDirs(legacy, mend, {})
    expect(r.status).toBe("done")
    if (r.status === "done") expect(r.copiedRoots.length).toBeGreaterThan(0)
    expect(existsSync(path.join(mend.data, GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME))).toBe(true)
    expect(existsSync(path.join(mend.data, "storage", "owned.json"))).toBe(true)
    rmSync(base, { recursive: true, force: true })
  })

  test("refuses ambiguous external OpenCode data without writing a destination", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "glm-ambiguous-"))
    const roots = (segment: string) => ({
      data: path.join(base, segment, "data"),
      cache: path.join(base, segment, "cache"),
      config: path.join(base, segment, "config"),
      state: path.join(base, segment, "state"),
      tmp: path.join(base, segment, "tmp"),
      bin: path.join(base, segment, "cache", "bin"),
      log: path.join(base, segment, "data", "log"),
    })
    const legacy = roots("legacy")
    const mend = roots("mend")
    mkdirSync(legacy.data, { recursive: true })
    writeFileSync(path.join(legacy.data, "opencode.db"), "external")

    await expect(runGlobalLayoutMigrationFromDirs(legacy, mend)).rejects.toThrow("ownership is ambiguous")
    expect(existsSync(mend.data)).toBe(false)
    rmSync(base, { recursive: true, force: true })
  })

  test("rejects an incompatible claimed database before copying files", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "glm-incompatible-"))
    const roots = (segment: string) => ({
      data: path.join(base, segment, "data"),
      cache: path.join(base, segment, "cache"),
      config: path.join(base, segment, "config"),
      state: path.join(base, segment, "state"),
      tmp: path.join(base, segment, "tmp"),
      bin: path.join(base, segment, "cache", "bin"),
      log: path.join(base, segment, "data", "log"),
    })
    const legacy = roots("legacy")
    const mend = roots("mend")
    mkdirSync(legacy.data, { recursive: true })
    const sqlite = new Database(path.join(legacy.data, "mendcode.db"))
    sqlite.run('CREATE TABLE "project" ("id" text PRIMARY KEY)')
    sqlite.close()

    await expect(runGlobalLayoutMigrationFromDirs(legacy, mend)).rejects.toThrow("missing tables")
    expect(existsSync(mend.data)).toBe(false)
    rmSync(base, { recursive: true, force: true })
  })

  test("publishes a merged root atomically and retains the pre-migration destination", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "glm-existing-"))
    const roots = (segment: string) => ({
      data: path.join(base, segment, "data"),
      cache: path.join(base, segment, "cache"),
      config: path.join(base, segment, "config"),
      state: path.join(base, segment, "state"),
      tmp: path.join(base, segment, "tmp"),
      bin: path.join(base, segment, "cache", "bin"),
      log: path.join(base, segment, "data", "log"),
    })
    const legacy = roots("legacy")
    const mend = roots("mend")
    mkdirSync(legacy.data, { recursive: true })
    mkdirSync(mend.data, { recursive: true })
    writeFileSync(path.join(legacy.data, ".mendcode-json-storage-migration-v0.done"), "")
    writeFileSync(path.join(legacy.data, "legacy-value"), "legacy")
    writeFileSync(path.join(mend.data, "existing-value"), "existing")

    const result = await runGlobalLayoutMigrationFromDirs(legacy, mend, { force: true })
    expect(result.status).toBe("done")
    expect(readFileSync(path.join(mend.data, "legacy-value"), "utf8")).toBe("legacy")
    expect(readFileSync(path.join(mend.data, "existing-value"), "utf8")).toBe("existing")
    const marker = JSON.parse(readFileSync(path.join(mend.data, GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME), "utf8")) as {
      backups: string[]
    }
    expect(marker.backups).toHaveLength(1)
    expect(readFileSync(path.join(marker.backups[0]!, "existing-value"), "utf8")).toBe("existing")
    rmSync(base, { recursive: true, force: true })
  })

  test("accepts a compatible MendCode database with an incomplete migration journal without opening it for write", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "glm-incomplete-journal-"))
    const roots = (segment: string) => ({
      data: path.join(base, segment, "data"),
      cache: path.join(base, segment, "cache"),
      config: path.join(base, segment, "config"),
      state: path.join(base, segment, "state"),
      tmp: path.join(base, segment, "tmp"),
      bin: path.join(base, segment, "cache", "bin"),
      log: path.join(base, segment, "data", "log"),
    })
    const legacy = roots("legacy")
    const mend = roots("mend")
    mkdirSync(legacy.data, { recursive: true })
    const source = path.join(legacy.data, "mendcode.db")
    const sqlite = new Database(source)
    for (const table of ["project", "session", "message", "part"]) {
      sqlite.run(`CREATE TABLE "${table}" ("id" text PRIMARY KEY)`)
    }
    sqlite.close()
    const before = readFileSync(source)

    const result = await runGlobalLayoutMigrationFromDirs(legacy, mend)
    expect(result.status).toBe("done")
    expect(readFileSync(source)).toEqual(before)
    expect(readFileSync(path.join(mend.data, "mendcode.db"))).toEqual(before)
    rmSync(base, { recursive: true, force: true })
  })

  test("restores already-published roots when a later root cannot publish", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "glm-rollback-"))
    const legacy = {
      data: path.join(base, "legacy-data"),
      cache: path.join(base, "legacy-cache"),
      config: path.join(base, "legacy-config"),
      state: path.join(base, "legacy-state"),
      tmp: path.join(base, "legacy-tmp"),
      bin: path.join(base, "legacy-cache", "bin"),
      log: path.join(base, "legacy-data", "log"),
    }
    // Deliberately nest the second destination under the first. Publishing
    // data moves the prepared cache sibling, forcing the later cache rename to
    // fail after the data root was already committed.
    const mend = {
      data: path.join(base, "mend-data"),
      cache: path.join(base, "mend-data", "cache"),
      config: path.join(base, "mend-config"),
      state: path.join(base, "mend-state"),
      tmp: path.join(base, "mend-tmp"),
      bin: path.join(base, "mend-data", "cache", "bin"),
      log: path.join(base, "mend-data", "log"),
    }
    mkdirSync(legacy.data, { recursive: true })
    mkdirSync(legacy.cache, { recursive: true })
    mkdirSync(mend.cache, { recursive: true })
    writeFileSync(path.join(legacy.data, ".mendcode-json-storage-migration-v0.done"), "")
    writeFileSync(path.join(legacy.data, "legacy-value"), "legacy")
    writeFileSync(path.join(legacy.cache, "legacy-cache-value"), "legacy-cache")
    writeFileSync(path.join(mend.data, "original-value"), "original")
    writeFileSync(path.join(mend.cache, "original-cache-value"), "original-cache")

    await expect(runGlobalLayoutMigrationFromDirs(legacy, mend, { force: true })).rejects.toThrow(
      "original roots were restored",
    )
    expect(readFileSync(path.join(mend.data, "original-value"), "utf8")).toBe("original")
    expect(readFileSync(path.join(mend.cache, "original-cache-value"), "utf8")).toBe("original-cache")
    expect(existsSync(path.join(mend.data, GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME))).toBe(false)
    rmSync(base, { recursive: true, force: true })
  })
})
