/**
 * JSON in → JSON out. Used by MendCode CLI helpers so `mend config paths`
 * reports the same default sqlite path as `packages/opencode/src/storage/db.ts` without duplicating rules.
 *
 * Usage: `bun script/print-resolved-sqlite-path.ts '<json-payload>'`
 */
import {
  legacyChannelDbPath,
  mendChannelDbPath,
  resolveDefaultSqliteDbPath,
} from "../src/storage/resolve-default-sqlite-path"

type Payload = {
  dataDir: string
  installationChannel: string
  disableChannelDb: boolean
  opencodeDb?: string
}

const raw = process.argv[2]
if (!raw) {
  console.error("missing json payload argv[2]")
  process.exit(2)
}

let payload: Payload
try {
  payload = JSON.parse(raw) as Payload
} catch {
  console.error("invalid json payload")
  process.exit(2)
}

const { dataDir, installationChannel, disableChannelDb, opencodeDb } = payload

console.log(
  JSON.stringify({
    resolvedDefaultSqlitePath: resolveDefaultSqliteDbPath({
      dataDir,
      installationChannel,
      disableChannelDb,
      opencodeDb,
    }),
    mendChannelDbPath: mendChannelDbPath(dataDir, installationChannel, disableChannelDb),
    legacyChannelDbPath: legacyChannelDbPath(dataDir, installationChannel, disableChannelDb),
    installationChannel,
    disableChannelDb,
  }),
)
