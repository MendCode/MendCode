import path from "path"
import os from "os"
import { existsSync, readFileSync, readdirSync } from "fs"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"

/** XDG app directory name: donor-era installs and legacy layout root. */
export const XDG_APP_SEGMENT_LEGACY = "opencode"

/** Target MendCode-owned XDG segment after global layout migration (ADR Phase B). */
export const XDG_APP_SEGMENT_MEND = "mendcode"

/**
 * Written under {@link Global.Path.data} after a successful one-shot global layout migration.
 * Keep in sync with MendCode runtime migration helpers.
 */
export const GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME = ".mendcode-global-layout-v0.done"

/** Installer-owned selection; keeps MendCode layout choice scoped to MendCode instead of shell config. */
export const GLOBAL_LAYOUT_INSTALL_SELECTION_BASENAME = ".global-layout-v1"

/** Keep in sync with `JSON_STORAGE_MIGRATION_DONE_BASENAME` in `packages/opencode/src/storage/json-migration.ts`. */
const JSON_STORAGE_MIGRATION_DONE_BASENAME = ".mendcode-json-storage-migration-v0.done"

export interface GlobalRoots {
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
}

/** Pure layout helper: XDG bases from `xdg-basedir` + tmp under `os.tmpdir()`. */
export function computeGlobalRoots(appSegment: string): GlobalRoots {
  const data = path.join(xdgData!, appSegment)
  const cache = path.join(xdgCache!, appSegment)
  const config = path.join(xdgConfig!, appSegment)
  const state = path.join(xdgState!, appSegment)
  const tmp = path.join(os.tmpdir(), appSegment)
  return {
    data,
    cache,
    config,
    state,
    tmp,
    bin: path.join(cache, "bin"),
    log: path.join(data, "log"),
  }
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * True when legacy `data` appears to hold identity/session state worth preserving on the legacy
 * XDG segment until an explicit global-layout migration (Phase B1).
 */
export function legacyDataHasIdentityArtifacts(legacyDataDir: string): boolean {
  for (const name of safeReadDir(legacyDataDir)) {
    if (name === "storage") return true
    if (name === "auth.json" || name === "mcp-auth.json") return true
    if (name.endsWith(".db")) return true
    if (name === JSON_STORAGE_MIGRATION_DONE_BASENAME) return true
    if (name === GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME) return true
  }
  return false
}

/** Strong ownership only: generic OpenCode auth/storage/db names are intentionally excluded. */
export function legacyDataHasMendCodeIdentityArtifacts(legacyDataDir: string): boolean {
  for (const name of safeReadDir(legacyDataDir)) {
    if (name.startsWith("mendcode") && name.endsWith(".db")) return true
    if (name === JSON_STORAGE_MIGRATION_DONE_BASENAME) return true
    if (name === GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME) return true
  }
  return false
}

export function globalLayoutMigrationMarkerPath(mendDataDir: string) {
  return path.join(mendDataDir, GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME)
}

export function globalLayoutInstallSelectionPath(home = process.env.OPENCODE_TEST_HOME ?? os.homedir()) {
  return path.join(home, ".mendcode", GLOBAL_LAYOUT_INSTALL_SELECTION_BASENAME)
}

export type GlobalLayoutSelection = "legacy" | "mendcode"

export function normalizeGlobalLayoutSelection(value: string | undefined): GlobalLayoutSelection | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "legacy" || normalized === "mendcode") return normalized
  return undefined
}

export function readGlobalLayoutInstallSelection(home?: string): GlobalLayoutSelection | undefined {
  try {
    const file = globalLayoutInstallSelectionPath(home)
    const value = normalizeGlobalLayoutSelection(readFileSync(file, "utf8"))
    if (!value) throw new Error(`Invalid MendCode layout selection in ${file}; expected legacy or mendcode`)
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export function resolveActiveAppSegmentFromDirs(input: {
  environmentSelection?: string
  installSelection?: string
  legacyEnvironmentSelection?: string
  legacyDataDir: string
  mendDataDir: string
}): typeof XDG_APP_SEGMENT_LEGACY | typeof XDG_APP_SEGMENT_MEND {
  const selected =
    normalizeGlobalLayoutSelection(input.environmentSelection) ??
    normalizeGlobalLayoutSelection(input.installSelection) ??
    normalizeGlobalLayoutSelection(input.legacyEnvironmentSelection)
  if (selected === "legacy") return XDG_APP_SEGMENT_LEGACY
  if (selected === "mendcode") return XDG_APP_SEGMENT_MEND
  if (existsSync(globalLayoutMigrationMarkerPath(input.mendDataDir))) return XDG_APP_SEGMENT_MEND
  if (legacyDataHasIdentityArtifacts(input.legacyDataDir)) return XDG_APP_SEGMENT_LEGACY
  return XDG_APP_SEGMENT_MEND
}

/**
 * Resolves XDG app segment for {@link Global.Path}.
 *
 * - `MENDCODE_GLOBAL_LAYOUT`: primary explicit override (`legacy` | `mendcode` | `auto`).
 * - `legacy`: always `opencode`.
 * - `mendcode`: always `mendcode` (operator override; ensure data exists or run migration first).
 * - Installer selection: persists the installer choice without changing global shell configuration.
 * - `OPENCODE_GLOBAL_LAYOUT`: donor-era fallback only when no MendCode-owned selection exists.
 * - `auto`: `mendcode` if migration marker exists under mend data, else `opencode` if legacy data has
 *   artifacts, else `mendcode` (manual/greenfield runs without installer metadata preserve compatibility).
 */
export function resolveActiveAppSegment(): typeof XDG_APP_SEGMENT_LEGACY | typeof XDG_APP_SEGMENT_MEND {
  const mendRoots = computeGlobalRoots(XDG_APP_SEGMENT_MEND)
  const legacyRoots = computeGlobalRoots(XDG_APP_SEGMENT_LEGACY)
  return resolveActiveAppSegmentFromDirs({
    environmentSelection: process.env.MENDCODE_GLOBAL_LAYOUT,
    installSelection: readGlobalLayoutInstallSelection(),
    legacyEnvironmentSelection: process.env.OPENCODE_GLOBAL_LAYOUT,
    legacyDataDir: legacyRoots.data,
    mendDataDir: mendRoots.data,
  })
}
