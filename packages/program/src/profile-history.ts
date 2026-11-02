import { createHash, randomUUID } from "node:crypto"
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

export type ProfileObject = Record<string, unknown>
const digest = (text: string) => createHash("sha256").update(text).digest("hex")
export const profileFile = (dir: string) => path.join(dir, "tui", "profile.json")
const folder = (file: string) => path.join(path.dirname(file), "backups")
const pattern = /^profile-(\d{13})-([a-f0-9-]+)-([a-f0-9]{64})\.json$/
export function parseProfile(text: string): ProfileObject {
  const raw = JSON.parse(text)
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Profile must be a JSON object; original file was not changed")
  return raw
}
function read(file: string): string | undefined {
  try { return readFileSync(file, "utf8") } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
}
function safe(file: string) {
  for (const target of [path.dirname(file), file, folder(file)]) {
    try { const stat = lstatSync(target); if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw new Error("Profile storage must not contain links") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
}
function atomic(file: string, text: string) {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    const fd = openSync(temp, "wx", 0o600)
    try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, file)
  }
  finally { try { unlinkSync(temp) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error } }
}
function locked<T>(file: string, run: () => T): T {
  safe(file)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const lock = `${file}.lock`
  try { mkdirSync(lock, { mode: 0o700 }) } catch { throw new Error("Profile is being saved; retry (after a crash, remove profile.json.lock when no writer is running)") }
  try { safe(file); return run() } finally { rmdirSync(lock) }
}
export function profileBackups(file: string) {
  safe(file)
  let names: string[]
  try { names = readdirSync(folder(file)) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error }
  return names.flatMap((name) => { const match = pattern.exec(name); return match ? [{ id: `profile-${match[1]}`, at: Number(match[1]), hash: match[3]!, file: path.join(folder(file), name) }] : [] }).sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
}
/** The latest 30 and the newest snapshot of each of the last 30 UTC days; never more than 60. */
export function retainedHistory<T extends { at: number }>(rows: readonly T[], now: number): Set<T> {
  const keep = new Set(rows.slice(0, 30))
  const days = new Set<string>()
  for (const row of rows) {
    if (row.at < Math.floor(now / 86400000) * 86400000 - 29 * 86400000) continue
    const day = new Date(row.at).toISOString().slice(0, 10)
    if (!days.has(day)) { days.add(day); keep.add(row) }
  }
  return keep
}
function snapshot(file: string, text: string, now = Date.now()): string {
  const rows = profileBackups(file)
  const hash = digest(text)
  if (rows[0]?.hash === hash) return rows[0].id
  mkdirSync(folder(file), { recursive: true, mode: 0o700 })
  chmodSync(folder(file), 0o700)
  const at = Math.max(now, (rows[0]?.at ?? 0) + 1)
  const id = `profile-${at}`
  const target = path.join(folder(file), `${id}-${randomUUID()}-${hash}.json`)
  atomic(target, text)
  const all = [{ id, at, hash, file: target }, ...rows]
  const keep = retainedHistory(all, now)
  for (const row of all) if (!keep.has(row)) unlinkSync(row.file)
  return id
}
/** Re-reads under a writer lock. The callback must only replace keys the caller actually owns. */
export function updateProfile(file: string, update: (raw: ProfileObject) => ProfileObject, backupMissing = false): { backupId?: string } {
  return locked(file, () => {
    const before = read(file)
    const raw = before === undefined ? {} : parseProfile(before)
    const next = update(raw)
    if (JSON.stringify(raw) === JSON.stringify(next) && before !== undefined) return {}
    const backupId = before === undefined && !backupMissing ? undefined : snapshot(file, before ?? "{}\n")
    atomic(file, `${JSON.stringify(next, null, 2)}\n`)
    return backupId ? { backupId } : {}
  })
}
export function listProfileBackups(file: string) {
  let current: ProfileObject = {}
  try { current = parseProfile(read(file) ?? "{}") } catch { /* A broken profile can still be restored. */ }
  return profileBackups(file).map((row) => {
    try {
      const saved = parseProfile(backupText(row))
      const keys = new Set([...Object.keys(current), ...Object.keys(saved)])
      return { id: row.id, at: row.at, differences: [...keys].filter((key) => JSON.stringify(current[key]) !== JSON.stringify(saved[key])).length, valid: true }
    } catch { return { id: row.id, at: row.at, differences: 0, valid: false } }
  })
}
function backupText(row: ReturnType<typeof profileBackups>[number]): string {
  const stat = lstatSync(row.file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe profile backup")
  const text = readFileSync(row.file, "utf8")
  if (digest(text) !== row.hash) throw new Error("Profile backup checksum mismatch")
  return text
}
/** Explicit replacement is intentional. Snapshot the result too, so startup does not undo the user's restore. */
export function restoreProfile(file: string, id: string): { backupId?: string } {
  return locked(file, () => {
    const row = profileBackups(file).find((entry) => entry.id === id)
    if (!row) throw new Error("Unknown profile backup")
    const text = backupText(row)
    parseProfile(text)
    const before = read(file)
    const backupId = snapshot(file, before ?? "{}\n")
    atomic(file, text)
    snapshot(file, text)
    return backupId ? { backupId } : {}
  })
}
/** An intentional full replacement (for import rollback), unlike merging ordinary edits. */
export function replaceProfile(file: string, next: ProfileObject | undefined): void {
  locked(file, () => {
    const before = read(file)
    snapshot(file, before ?? "{}\n")
    const text = `${JSON.stringify(next ?? {}, null, 2)}\n`
    if (next === undefined) { if (before !== undefined) unlinkSync(file) }
    else atomic(file, text)
    snapshot(file, text)
  })
}
/** Only startup invokes recovery, never an ordinary read or a headless listing. */
export function recoverProfile(file: string): { restored: number; backupId?: string } {
  // Unchanged startup: one profile read, one hash comparison, no locks or writes.
  safe(file)
  const initial = read(file)
  const latest = profileBackups(file)[0]
  if (initial === undefined && !latest || initial !== undefined && latest?.hash === digest(initial)) return { restored: 0 }
  return locked(file, () => {
    const before = read(file)
    const newest = profileBackups(file)[0]
    if (before !== undefined && newest?.hash === digest(before)) return { restored: 0 }
    let raw: ProfileObject
    try { raw = parseProfile(before ?? "{}") } catch { raw = {} }
    let saved: ProfileObject = {}
    if (newest) { try { saved = parseProfile(backupText(newest)) } catch { /* Never propagate a broken backup. */ } }
    const missing = Object.keys(saved).filter((key) => !Object.hasOwn(raw, key))
    const backupId = snapshot(file, before ?? "{}\n")
    if (!missing.length) return { restored: 0 }
    const next = { ...saved, ...raw }
    atomic(file, `${JSON.stringify(next, null, 2)}\n`)
    return { restored: missing.length, ...(backupId ? { backupId } : {}) }
  })
}
