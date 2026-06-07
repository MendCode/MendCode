import path from "path"
import os from "os"
import { existsSync, readdirSync } from "fs"
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

/** Keep in sync with `JSON_STORAGE_MIGRATION_DONE_BASENAME` in `packages/opencode/src/storage/json-migration.ts`. */
const JSON_STORAGE_MIGRATION_DONE_BASENAME = ".mendcode-json-storage-migration-v0.done"

function envOpen(openKey: string) {
  const mendKey = `MENDCODE_${openKey.slice("OPENCODE_".length)}`
  const primary = process.env[mendKey]
  if (primary !== undefined && primary !== "") return primary
  const fallback = process.env[openKey]
  if (fallback !== undefined && fallback !== "") return fallback
  return undefined
}

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

export function globalLayoutMigrationMarkerPath(mendDataDir: string) {
  return path.join(mendDataDir, GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME)
}

/**
 * Resolves XDG app segment for {@link Global.Path}.
 *
 * - `OPENCODE_GLOBAL_LAYOUT` / `MENDCODE_GLOBAL_LAYOUT`: `legacy` | `mendcode` | `auto` (default).
 * - `legacy`: always `opencode`.
 * - `mendcode`: always `mendcode` (operator override; ensure data exists or run migration first).
 * - `auto`: `mendcode` if migration marker exists under mend data, else `opencode` if legacy data has
 *   artifacts, else `mendcode` (greenfield installs use Mend segment without a marker).
 */
export function resolveActiveAppSegment(): typeof XDG_APP_SEGMENT_LEGACY | typeof XDG_APP_SEGMENT_MEND {
  const raw = envOpen("OPENCODE_GLOBAL_LAYOUT")?.trim().toLowerCase()
  if (raw === "legacy") return XDG_APP_SEGMENT_LEGACY
  if (raw === "mendcode") return XDG_APP_SEGMENT_MEND

  const mendRoots = computeGlobalRoots(XDG_APP_SEGMENT_MEND)
  if (existsSync(globalLayoutMigrationMarkerPath(mendRoots.data))) return XDG_APP_SEGMENT_MEND

  const legacyRoots = computeGlobalRoots(XDG_APP_SEGMENT_LEGACY)
  if (legacyDataHasIdentityArtifacts(legacyRoots.data)) return XDG_APP_SEGMENT_LEGACY

  return XDG_APP_SEGMENT_MEND
}
