import fs from "fs/promises"
import { existsSync, readdirSync } from "fs"
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import path from "path"
import type { GlobalRoots } from "@mendcode/core/global-layout"
import {
  GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME,
  globalLayoutMigrationMarkerPath,
  legacyDataHasIdentityArtifacts,
  legacyDataHasMendCodeIdentityArtifacts,
  normalizeGlobalLayoutSelection,
  readGlobalLayoutInstallSelection,
  XDG_APP_SEGMENT_LEGACY,
  XDG_APP_SEGMENT_MEND,
  computeGlobalRoots,
} from "@mendcode/core/global-layout"

export type GlobalLayoutMigrateResult =
  | { status: "skipped"; reason: "already_migrated" }
  | { status: "skipped"; reason: "nothing_to_migrate" }
  | { status: "done"; copiedRoots: readonly ("data" | "cache" | "config" | "state")[] }

const ROOT_KEYS = ["data", "cache", "config", "state"] as const
const REQUIRED_SQLITE_TABLES = ["project", "session", "message", "part"] as const

function mendDataHasUnexpectedEntries(mendDataDir: string) {
  if (!existsSync(mendDataDir)) return false
  return readdirSync(mendDataDir).some((n) => n !== GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME)
}

function assertLegacySqliteCompatible(legacyDataDir: string) {
  for (const name of readdirSync(legacyDataDir)) {
    if (!name.endsWith(".db")) continue
    const file = path.join(legacyDataDir, name)
    let sqlite: Database | undefined
    try {
      sqlite = new Database(file, { readonly: true })
      const tables = new Set(
        sqlite
          .query("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => (row as { name: string }).name),
      )
      const missing = REQUIRED_SQLITE_TABLES.filter((table) => !tables.has(table))
      if (missing.length > 0) {
        throw new Error(`incompatible legacy database ${file}; missing tables: ${missing.join(", ")}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("incompatible legacy database")) throw error
      throw new Error(`incompatible legacy database ${file}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      sqlite?.close()
    }
  }
}

async function copyDirectoryContents(from: string, to: string) {
  await fs.mkdir(to, { recursive: true })
  for (const entry of await fs.readdir(from)) {
    await fs.cp(path.join(from, entry), path.join(to, entry), { recursive: true, force: true })
  }
}

type PreparedRoot = {
  key: (typeof ROOT_KEYS)[number]
  to: string
  staging: string
  backup?: string
}

function migrationSibling(target: string, role: "staging" | "backup") {
  return `${target}.mendcode-migration-${role}-${process.pid}-${Date.now()}-${randomUUID()}`
}

async function prepareRoot(key: PreparedRoot["key"], from: string, to: string): Promise<PreparedRoot> {
  const staging = migrationSibling(to, "staging")
  await fs.mkdir(path.dirname(staging), { recursive: true })
  if (existsSync(to)) await copyDirectoryContents(to, staging)
  await copyDirectoryContents(from, staging)
  return {
    key,
    to,
    staging,
    backup: existsSync(to) ? migrationSibling(to, "backup") : undefined,
  }
}

async function publishPreparedRoots(prepared: PreparedRoot[]) {
  const published: PreparedRoot[] = []
  try {
    for (const item of prepared) {
      if (item.backup) await fs.rename(item.to, item.backup)
      try {
        await fs.rename(item.staging, item.to)
      } catch (error) {
        if (item.backup) await fs.rename(item.backup, item.to)
        throw error
      }
      published.push(item)
    }
  } catch (error) {
    for (const item of published.toReversed()) {
      const failed = `${item.staging}.failed`
      await fs.rename(item.to, failed).catch(() => undefined)
      if (item.backup) await fs.rename(item.backup, item.to).catch(() => undefined)
    }
    throw new Error(
      `global layout migration publish failed; original roots were restored and staged copies were preserved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

/**
 * One-shot copy legacy global layout → Mend roots. Every root is fully staged
 * beside its destination before commit, published with an atomic rename, and
 * rolled back to its original destination if a later root cannot publish.
 * Existing destinations are retained as recoverable sibling backups.
 * Restart the process after success so {@link Global.Path} picks up the marker.
 */
export async function runGlobalLayoutMigrationFromDirs(
  legacy: GlobalRoots,
  mend: GlobalRoots,
  options: { force?: boolean; sourceOwned?: boolean } = {},
): Promise<GlobalLayoutMigrateResult> {
  const marker = globalLayoutMigrationMarkerPath(mend.data)
  if (existsSync(marker)) return { status: "skipped", reason: "already_migrated" }
  if (!legacyDataHasIdentityArtifacts(legacy.data)) return { status: "skipped", reason: "nothing_to_migrate" }
  if (!options.sourceOwned && !legacyDataHasMendCodeIdentityArtifacts(legacy.data)) {
    throw new Error(
      `legacy data ownership is ambiguous (${legacy.data}); select MENDCODE_GLOBAL_LAYOUT=legacy only after verifying it belongs to MendCode`,
    )
  }
  assertLegacySqliteCompatible(legacy.data)
  if (mendDataHasUnexpectedEntries(mend.data) && !options.force) {
    throw new Error(
      `mend data directory is not empty (${mend.data}); back up, clean, or pass --force after verifying`,
    )
  }

  const prepared: PreparedRoot[] = []
  for (const key of ROOT_KEYS) {
    const from = legacy[key]
    const to = mend[key]
    if (!existsSync(from)) continue
    prepared.push(await prepareRoot(key, from, to))
  }
  const data = prepared.find((item) => item.key === "data")
  if (!data) throw new Error(`legacy identity exists without a migratable data root (${legacy.data})`)
  await fs.writeFile(
    path.join(data.staging, GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME),
    `${JSON.stringify({
      v: 1,
      migratedAt: Date.now(),
      backups: prepared.flatMap((item) => (item.backup ? [item.backup] : [])),
    })}\n`,
    "utf8",
  )
  await publishPreparedRoots(prepared)
  return { status: "done", copiedRoots: prepared.map((item) => item.key) }
}

export async function runGlobalLayoutMigration(options: { force?: boolean } = {}) {
  const explicit = normalizeGlobalLayoutSelection(
    process.env.MENDCODE_GLOBAL_LAYOUT,
  )
  return runGlobalLayoutMigrationFromDirs(
    computeGlobalRoots(XDG_APP_SEGMENT_LEGACY),
    computeGlobalRoots(XDG_APP_SEGMENT_MEND),
    {
      ...options,
      sourceOwned: explicit === "legacy" || readGlobalLayoutInstallSelection() === "legacy",
    },
  )
}
