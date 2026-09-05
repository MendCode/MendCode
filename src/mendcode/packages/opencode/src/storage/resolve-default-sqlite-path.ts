import path from "path"
import { existsSync } from "fs"

export type ResolveDefaultSqliteInput = {
  dataDir: string
  installationChannel: string
  disableChannelDb: boolean
  opencodeDb?: string
}

export type TestSqliteIsolationInput = {
  dbPath: string
  nodeEnv?: string
  allowedRoots: string[]
}

const SIMPLE_NAME_CHANNELS = new Set(["latest", "stable", "beta", "nightly", "prod"])

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
  const mendLocal = mendChannelDbPath(dataDir, "local", disableChannelDb)
  const baseMend = path.join(dataDir, "mendcode.db")
  const baseLegacy = path.join(dataDir, "opencode.db")
  if (existsSync(mend)) return mend
  if (existsSync(mendLocal)) return mendLocal
  if (existsSync(legacy)) return legacy
  if (existsSync(baseMend)) return baseMend
  if (existsSync(baseLegacy)) return baseLegacy
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

function isInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

/** Fail closed when a test runner resolves SQLite outside its isolated roots. */
export function assertTestSqliteIsolation(input: TestSqliteIsolationInput) {
  if (input.nodeEnv !== "test" || input.dbPath === ":memory:") return
  if (input.allowedRoots.filter(Boolean).some((root) => isInside(root, input.dbPath))) return
  throw new Error(
    `Refusing to use non-isolated SQLite database during tests: ${input.dbPath}. ` +
      "Run tests from src/mendcode/packages/opencode so test/preload.ts can configure an isolated database.",
  )
}
