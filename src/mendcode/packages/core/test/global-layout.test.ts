import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import {
  computeGlobalRoots,
  GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME,
  legacyDataHasIdentityArtifacts,
  XDG_APP_SEGMENT_LEGACY,
  XDG_APP_SEGMENT_MEND,
} from "@mendcode/core/global-layout"
import { mkdtempSync, rmSync, writeFileSync } from "fs"

describe("global-layout", () => {
  test("legacy and mend segments produce distinct root sets", () => {
    const legacy = computeGlobalRoots(XDG_APP_SEGMENT_LEGACY)
    const mend = computeGlobalRoots(XDG_APP_SEGMENT_MEND)
    expect(legacy.data).not.toBe(mend.data)
    expect(legacy.tmp).toBe(path.join(os.tmpdir(), XDG_APP_SEGMENT_LEGACY))
    expect(mend.tmp).toBe(path.join(os.tmpdir(), XDG_APP_SEGMENT_MEND))
    expect(legacy.bin).toBe(path.join(legacy.cache, "bin"))
    expect(legacy.log).toBe(path.join(legacy.data, "log"))
  })

  test("migration marker basename is stable", () => {
    expect(GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME).toMatch(/^\.mendcode-global-layout-v/)
  })

  test("legacyDataHasIdentityArtifacts detects sqlite and storage", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mend-gl-"))
    try {
      expect(legacyDataHasIdentityArtifacts(dir)).toBe(false)
      writeFileSync(path.join(dir, "mendcode.db"), "")
      expect(legacyDataHasIdentityArtifacts(dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
