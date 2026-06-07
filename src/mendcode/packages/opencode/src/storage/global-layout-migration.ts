import fs from "fs/promises"
import { existsSync, readdirSync } from "fs"
import type { GlobalRoots } from "@mendcode/core/global-layout"
import {
  GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME,
  globalLayoutMigrationMarkerPath,
  legacyDataHasIdentityArtifacts,
  XDG_APP_SEGMENT_LEGACY,
  XDG_APP_SEGMENT_MEND,
  computeGlobalRoots,
} from "@mendcode/core/global-layout"

export type GlobalLayoutMigrateResult =
  | { status: "skipped"; reason: "already_migrated" }
  | { status: "skipped"; reason: "nothing_to_migrate" }
  | { status: "done"; copiedRoots: readonly ("data" | "cache" | "config" | "state")[] }

const ROOT_KEYS = ["data", "cache", "config", "state"] as const

function mendDataHasUnexpectedEntries(mendDataDir: string) {
  if (!existsSync(mendDataDir)) return false
  return readdirSync(mendDataDir).some((n) => n !== GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME)
}

/**
 * One-shot copy legacy global layout → mend segment roots, then writes
 * {@link GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME} under mend `data`.
 * Restart the process after success so {@link Global.Path} picks up the marker.
 */
export async function runGlobalLayoutMigrationFromDirs(
  legacy: GlobalRoots,
  mend: GlobalRoots,
  options: { force?: boolean } = {},
): Promise<GlobalLayoutMigrateResult> {
  const marker = globalLayoutMigrationMarkerPath(mend.data)
  if (existsSync(marker)) return { status: "skipped", reason: "already_migrated" }
  if (!legacyDataHasIdentityArtifacts(legacy.data)) return { status: "skipped", reason: "nothing_to_migrate" }
  if (mendDataHasUnexpectedEntries(mend.data) && !options.force) {
    throw new Error(
      `mend data directory is not empty (${mend.data}); back up, clean, or pass --force after verifying`,
    )
  }

  const copied: ("data" | "cache" | "config" | "state")[] = []
  for (const key of ROOT_KEYS) {
    const from = legacy[key]
    const to = mend[key]
    if (!existsSync(from)) continue
    await fs.mkdir(to, { recursive: true })
    await fs.cp(from, to, { recursive: true, force: true })
    copied.push(key)
  }
  await fs.mkdir(mend.data, { recursive: true })
  await fs.writeFile(marker, `{"v":0,"migratedAt":${Date.now()}}\n`, "utf8")
  return { status: "done", copiedRoots: copied }
}

export async function runGlobalLayoutMigration(options: { force?: boolean } = {}) {
  return runGlobalLayoutMigrationFromDirs(
    computeGlobalRoots(XDG_APP_SEGMENT_LEGACY),
    computeGlobalRoots(XDG_APP_SEGMENT_MEND),
    options,
  )
}
