import { rm } from "fs/promises"
import { Database } from "@/storage/db"
import { assertTestSqliteIsolation } from "@/storage/resolve-default-sqlite-path"
import { disposeAllInstances } from "./fixture"

export async function resetDatabase() {
  assertTestSqliteIsolation({
    dbPath: Database.Path,
    nodeEnv: "test",
    allowedRoots: [process.env.XDG_DATA_HOME ?? ""],
  })
  await disposeAllInstances().catch(() => undefined)
  Database.close()
  await rm(Database.Path, { force: true }).catch(() => undefined)
  await rm(`${Database.Path}-wal`, { force: true }).catch(() => undefined)
  await rm(`${Database.Path}-shm`, { force: true }).catch(() => undefined)
}
