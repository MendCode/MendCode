import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
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
    writeFileSync(path.join(legacy.data, "x.db"), "")
    const r = await runGlobalLayoutMigrationFromDirs(legacy, mend, {})
    expect(r.status).toBe("done")
    if (r.status === "done") expect(r.copiedRoots.length).toBeGreaterThan(0)
    expect(existsSync(path.join(mend.data, GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME))).toBe(true)
    expect(existsSync(path.join(mend.data, "x.db"))).toBe(true)
    rmSync(base, { recursive: true, force: true })
  })
})
