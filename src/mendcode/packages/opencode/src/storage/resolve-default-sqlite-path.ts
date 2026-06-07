import path from "path"
import { existsSync } from "fs"

export type ResolveDefaultSqliteInput = {
  dataDir: string
  installationChannel: string
  disableChannelDb: boolean
  opencodeDb?: string
}

const SIMPLE_NAME_CHANNELS = new Set(["latest", "beta", "prod"])

function useSimpleDbBasename(installationChannel: string, disableChannelDb: boolean) {
  return SIMPLE_NAME_CHANNELS.has(installationChannel) || disableChannelDb
}

/** Legacy opencode*.sqlite path (donor-era naming). */
export function legacyChannelDbPath(dataDir: string, installationChannel: string, disableChannelDb: boolean) {
  if (useSimpleDbBasename(installationChannel, disableChannelDb)) return path.join(dataDir, "opencode.db")
  const safe = installationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
  return path.join(dataDir, `opencode-${safe}.db`)
}

/** Mend-primary sqlite path (new installs); same channel rules as {@link legacyChannelDbPath}. */
export function mendChannelDbPath(dataDir: string, installationChannel: string, disableChannelDb: boolean) {
  if (useSimpleDbBasename(installationChannel, disableChannelDb)) return path.join(dataDir, "mendcode.db")
  const safe = installationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
  return path.join(dataDir, `mendcode-${safe}.db`)
}

/**
 * Prefer Mend-named DB when present; else legacy opencode*.db so existing sessions keep working.
 * Does not rename or copy files (see docs/adr-storage-global-path-migration.md).
 */
export function resolveDualReadDbPathFromLayout(
  dataDir: string,
  installationChannel: string,
  disableChannelDb: boolean,
) {
  const mend = mendChannelDbPath(dataDir, installationChannel, disableChannelDb)
  const legacy = legacyChannelDbPath(dataDir, installationChannel, disableChannelDb)
  if (existsSync(mend)) return mend
  if (existsSync(legacy)) return legacy
  return mend
}

/** Default sqlite file path used by the runtime (honors OPENCODE_DB / dual-read when unset). */
export function resolveDefaultSqliteDbPath(input: ResolveDefaultSqliteInput): string {
  const { dataDir, installationChannel, disableChannelDb, opencodeDb } = input
  if (opencodeDb) {
    if (opencodeDb === ":memory:" || path.isAbsolute(opencodeDb)) return opencodeDb
    return path.join(dataDir, opencodeDb)
  }
  return resolveDualReadDbPathFromLayout(dataDir, installationChannel, disableChannelDb)
}
