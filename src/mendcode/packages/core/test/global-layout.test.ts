import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import {
  computeGlobalRoots,
  GLOBAL_LAYOUT_INSTALL_SELECTION_BASENAME,
  GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME,
  globalLayoutInstallSelectionPath,
  legacyDataHasIdentityArtifacts,
  readGlobalLayoutInstallSelection,
  resolveActiveAppSegmentFromDirs,
  XDG_APP_SEGMENT_LEGACY,
  XDG_APP_SEGMENT_MEND,
} from "@mendcode/core/global-layout"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"

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
    expect(GLOBAL_LAYOUT_INSTALL_SELECTION_BASENAME).toBe(".global-layout-v1")
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

  test("installer selection keeps a new MendCode install separate from OpenCode data", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mend-gl-select-"))
    const legacy = path.join(dir, "opencode")
    const mend = path.join(dir, "mendcode")
    try {
      mkdirSync(legacy)
      writeFileSync(path.join(legacy, "opencode.db"), "external-opencode")
      expect(
        resolveActiveAppSegmentFromDirs({
          installSelection: "mendcode\n",
          legacyDataDir: legacy,
          mendDataDir: mend,
        }),
      ).toBe(XDG_APP_SEGMENT_MEND)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("explicit environment selection wins over installer metadata", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mend-gl-env-"))
    try {
      expect(
        resolveActiveAppSegmentFromDirs({
          environmentSelection: "legacy",
          installSelection: "mendcode",
          legacyDataDir: path.join(dir, "opencode"),
          mendDataDir: path.join(dir, "mendcode"),
        }),
      ).toBe(XDG_APP_SEGMENT_LEGACY)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("installer metadata isolates MendCode from a donor environment variable", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mend-gl-donor-env-"))
    try {
      expect(
        resolveActiveAppSegmentFromDirs({
          installSelection: "mendcode",
          legacyEnvironmentSelection: "legacy",
          legacyDataDir: path.join(dir, "opencode"),
          mendDataDir: path.join(dir, "mendcode"),
        }),
      ).toBe(XDG_APP_SEGMENT_MEND)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("invalid installer metadata fails closed instead of falling back to donor data", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mend-gl-invalid-selection-"))
    try {
      const selection = globalLayoutInstallSelectionPath(dir)
      mkdirSync(path.dirname(selection), { recursive: true })
      writeFileSync(selection, "corrupt\n")
      expect(() => readGlobalLayoutInstallSelection(dir)).toThrow("Invalid MendCode layout selection")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
