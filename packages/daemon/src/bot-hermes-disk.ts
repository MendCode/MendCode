import { Database } from "bun:sqlite"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Hermes read from its own folder, for a machine where no `hermes serve` runs (its desktop app talks to a server elsewhere, or only the
 * gateway runs): the profiles are the folders under `<home>/profiles` plus the root one, and their sessions are in each profile's
 * `state.db`, opened read-only. Nothing is written. Loaded by the Hermes connector only when it found Hermes this way.
 */

export type DiskProfile = { name: string; display_name?: string; description?: string; model?: string }
export type DiskSession = { id: string; profile: string; is_active: boolean; title?: string | null; source?: string | null; started_at?: number | null; last_active?: number | null }
export type DiskMessage = { role?: string; content?: unknown; tool_name?: string | null; timestamp?: number | null }

const ROOT_PROFILE = "default"
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,57}$/
/** A session whose last activity is this recent and that has not ended counts as running. */
const ACTIVE_SECONDS = 120
const PROFILE_FILE_MAX = 64 * 1024

const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, "$2").trim()

function readSmall(path: string): string {
  try {
    if (!existsSync(path) || statSync(path).size > PROFILE_FILE_MAX) return ""
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

/** A top-level `key: value` of a small YAML file (no YAML library: only plain one-line scalars are read). */
function topLevel(text: string, key: string): string | undefined {
  const found = new RegExp(`^${key}:[ \\t]*(\\S.*)$`, "m").exec(text)?.[1]
  const value = found === undefined ? undefined : unquote(found)
  return value && value !== "null" && value !== "~" ? value : undefined
}

/** `model: name`, or the `default:` line of a `model:` block. */
function modelOf(config: string): string | undefined {
  const scalar = topLevel(config, "model")
  if (scalar && !scalar.startsWith("{")) return scalar
  const block = /^model:[ \t]*\n((?:[ \t]+.*\n?)*)/m.exec(config)?.[1]
  const value = block ? /^[ \t]+default:[ \t]*(\S.*)$/m.exec(block)?.[1] : undefined
  return value ? unquote(value) || undefined : undefined
}

/** The name the app shows: `display_name`, else the `title:` its desktop app keeps under `ui_meta`. */
function displayName(profile: string): string | undefined {
  const direct = topLevel(profile, "display_name")
  if (direct) return direct
  const meta = /^ui_meta:[ \t]*\n((?:[ \t]+.*\n?)*)/m.exec(profile)?.[1]
  const title = meta ? /^[ \t]+title:[ \t]*(\S.*)$/m.exec(meta)?.[1] : undefined
  return title ? unquote(title) || undefined : undefined
}

/** The folder of one profile: the root profile is the home itself. */
const profileDir = (home: string, name: string) => name === ROOT_PROFILE ? home : join(home, "profiles", name)

export function diskProfiles(home: string): DiskProfile[] {
  const names: string[] = []
  try {
    for (const entry of readdirSync(join(home, "profiles"), { withFileTypes: true })) if (entry.isDirectory() && PROFILE_NAME.test(entry.name) && entry.name !== ROOT_PROFILE) names.push(entry.name)
  } catch (error) {
    // No profiles folder: the root profile alone. A folder that cannot be read now is a failed refresh, so the bots known before stay (stale).
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error
  }
  names.sort()
  names.unshift(ROOT_PROFILE)
  return names.map((name) => {
    const dir = profileDir(home, name)
    const profile = readSmall(join(dir, "profile.yaml"))
    const config = readSmall(join(dir, "config.yaml"))
    const shown = displayName(profile)
    const description = topLevel(profile, "description")
    const model = modelOf(config)
    return { name, ...(shown ? { display_name: shown } : {}), ...(description ? { description } : {}), ...(model ? { model } : {}) }
  })
}

function withDatabase<T>(home: string, profile: string, read: (db: Database) => T, fallback: T): T {
  const path = join(profileDir(home, profile), "state.db")
  if (!existsSync(path)) return fallback
  let db: Database | undefined
  try {
    db = new Database(path, { readonly: true })
    return read(db)
  } catch {
    return fallback
  } finally {
    db?.close()
  }
}

type SessionRow = { id: string; title: string | null; source: string | null; started_at: number | null; last_activity_at: number | null; ended_at: number | null }

/** The newest sessions of each profile with at least one message, hidden and archived ones left out where the app keeps those marks. */
export function diskSessions(home: string, profiles: readonly string[], limit: number, nowSeconds: number): DiskSession[] {
  const sessions: DiskSession[] = []
  for (const profile of profiles) {
    const rows = withDatabase(home, profile, (db) => {
      const columns = new Set((db.query("pragma table_info(sessions)").all() as Array<{ name: string }>).map((column) => column.name))
      const activity = columns.has("last_activity_at") ? "last_activity_at" : "NULL"
      const kept = [columns.has("hidden") ? "coalesce(hidden, 0) = 0" : "", columns.has("archived") ? "coalesce(archived, 0) = 0" : "", columns.has("message_count") ? "message_count > 0" : ""].filter(Boolean)
      const where = kept.length ? `where ${kept.join(" and ")}` : ""
      return db.query(`select id, title, source, started_at, ${activity} as last_activity_at, ended_at from sessions ${where} order by coalesce(${activity}, started_at) desc limit ?`).all(limit) as SessionRow[]
    }, [] as SessionRow[])
    for (const row of rows) {
      const last = row.last_activity_at ?? row.started_at
      sessions.push({ id: row.id, profile, is_active: row.ended_at === null && typeof last === "number" && nowSeconds - last <= ACTIVE_SECONDS, title: row.title, source: row.source, started_at: row.started_at, last_active: row.last_activity_at })
    }
  }
  return sessions
}

/** The newest `limit` messages of one session, oldest first. */
export function diskMessages(home: string, profile: string, session: string, limit: number): DiskMessage[] {
  const rows = withDatabase(home, profile, (db) => db.query("select role, content, tool_name, timestamp from messages where session_id = ? order by timestamp desc, id desc limit ?").all(session, limit) as DiskMessage[], [] as DiskMessage[])
  return rows.reverse()
}
