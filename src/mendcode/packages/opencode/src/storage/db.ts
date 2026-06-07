import { type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
export * from "drizzle-orm"
import { LocalContext } from "@/util/local-context"
import { lazy } from "../util/lazy"
import { Global } from "@mendcode/core/global"
import * as Log from "@mendcode/core/util/log"
import { NamedError } from "@mendcode/core/util/error"
import z from "zod"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import { Flag } from "@mendcode/core/flag/flag"
import { InstallationChannel } from "@mendcode/core/installation/version"
import { InstanceState } from "@/effect/instance-state"
import { iife } from "@/util/iife"
import { init } from "#db"
import {
  legacyChannelDbPath,
  mendChannelDbPath,
  resolveDefaultSqliteDbPath,
  resolveDualReadDbPathFromLayout,
} from "./resolve-default-sqlite-path"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })

export function getChannelPath() {
  return legacyChannelDbPath(Global.Path.data, InstallationChannel, Flag.OPENCODE_DISABLE_CHANNEL_DB)
}

/** Mend-primary sqlite path (new installs); same channel rules as {@link getChannelPath}. */
export function getMendChannelPath() {
  return mendChannelDbPath(Global.Path.data, InstallationChannel, Flag.OPENCODE_DISABLE_CHANNEL_DB)
}

/**
 * Prefer Mend-named DB when present; else legacy opencode*.db so existing sessions keep working.
 * Does not rename or copy files (see docs/adr-storage-global-path-migration.md).
 */
export function resolveDualReadDbPath() {
  return resolveDualReadDbPathFromLayout(Global.Path.data, InstallationChannel, Flag.OPENCODE_DISABLE_CHANNEL_DB)
}

export const Path = iife(() =>
  resolveDefaultSqliteDbPath({
    dataDir: Global.Path.data,
    installationChannel: InstallationChannel,
    disableChannelDb: Flag.OPENCODE_DISABLE_CHANNEL_DB,
    opencodeDb: Flag.OPENCODE_DB,
  }),
)

export type Transaction = SQLiteTransaction<"sync", void>

type Client = SQLiteBunDatabase

type Journal = { sql: string; timestamp: number; name: string }[]

// Drizzle's migrate overloads trigger expensive variance checks here; narrow to the journal overload we actually use.
const migrateFromJournal = migrate as unknown as (db: SQLiteBunDatabase, entries: Journal) => void

function applyMigrations(db: SQLiteBunDatabase, entries: Journal) {
  migrateFromJournal(db, entries)
}

function time(tag: string) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
  if (!match) return 0
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )
}

function migrations(dir: string): Journal {
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  const sql = dirs
    .map((name) => {
      const file = path.join(dir, name, "migration.sql")
      if (!existsSync(file)) return
      return {
        sql: readFileSync(file, "utf-8"),
        timestamp: time(name),
        name,
      }
    })
    .filter(Boolean) as Journal

  return sql.sort((a, b) => a.timestamp - b.timestamp)
}

export const Client = lazy(() => {
  log.info("opening database", { path: Path })

  const db = init(Path)

  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA cache_size = -64000")
  db.run("PRAGMA foreign_keys = ON")
  db.run("PRAGMA wal_checkpoint(PASSIVE)")

  // Apply schema migrations
  const entries =
    typeof OPENCODE_MIGRATIONS !== "undefined"
      ? OPENCODE_MIGRATIONS
      : migrations(path.join(import.meta.dirname, "../../migration"))
  if (entries.length > 0) {
    log.info("applying migrations", {
      count: entries.length,
      mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
    })
    if (Flag.OPENCODE_SKIP_MIGRATIONS) {
      for (const item of entries) {
        item.sql = "select 1;"
      }
    }
    applyMigrations(db, entries)
  }

  return db
})

export function close() {
  if (!Client.loaded()) return
  Client().$client.close()
  Client.reset()
}

export type TxOrDb = Transaction | Client

const ctx = LocalContext.create<{
  tx: TxOrDb
  effects: (() => void | Promise<void>)[]
}>("database")

export function use<T>(callback: (trx: TxOrDb) => T): T {
  try {
    return callback(ctx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()))
      for (const effect of effects) effect()
      return result
    }
    throw err
  }
}

export function effect(fn: () => any | Promise<any>) {
  const bound = InstanceState.bind(fn)
  try {
    ctx.use().effects.push(bound)
  } catch {
    bound()
  }
}

type NotPromise<T> = T extends Promise<any> ? never : T

export function transaction<T>(
  callback: (tx: TxOrDb) => NotPromise<T>,
  options?: {
    behavior?: "deferred" | "immediate" | "exclusive"
  },
): NotPromise<T> {
  try {
    return callback(ctx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const txCallback = InstanceState.bind((tx: TxOrDb) => ctx.provide({ tx, effects }, () => callback(tx)))
      const result = Client().transaction(txCallback, { behavior: options?.behavior })
      for (const effect of effects) effect()
      return result as NotPromise<T>
    }
    throw err
  }
}

export * as Database from "./db"
