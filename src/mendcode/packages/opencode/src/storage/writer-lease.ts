import { mkdirSync, realpathSync, readFileSync, writeFileSync, renameSync, lstatSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

function canonical(file: string): string {
  try { return realpathSync(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    const parent = path.dirname(file)
    if (parent === file) throw error
    return path.join(canonical(parent), path.basename(file))
  }
}

function owner(directory: string): { pid: number; token: string } {
  const file = path.join(directory, "owner.json")
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.size > 4096) throw new Error("Database writer owner cannot be verified")
  const value = JSON.parse(readFileSync(file, "utf8"))
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.token !== "string" || !/^[a-f0-9-]{36}$/.test(value.token)) {
    throw new Error("Database writer owner is invalid")
  }
  return value
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/** All new runtime writers and maintenance share this lease, independent of XDG and channel. */
export function acquireWriterLease(file: string) {
  if (file === ":memory:") return () => {}
  const resolved = canonical(path.resolve(file))
  const directory = `${resolved}.writer-lock`
  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 })
  const token = randomUUID()
  try {
    mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Database writer lock is redirected")
    const previous = owner(directory)
    if (alive(previous.pid)) throw new Error(`Database already has a writer (PID ${previous.pid}). Connect to its backend or close it after its work finishes.`)
    // Only one recoverer can move this dead lease; an incomplete recovery fails
    // visibly and retains evidence instead of deleting a possibly new lock.
    mkdirSync(path.join(directory, "recovery"), { mode: 0o700 })
    const current = owner(directory)
    if (current.token !== previous.token || current.pid !== previous.pid || alive(current.pid)) throw new Error("Database writer ownership changed during recovery")
    renameSync(directory, `${directory}.recovered-${randomUUID()}`)
    mkdirSync(directory, { mode: 0o700 })
  }
  writeFileSync(path.join(directory, "owner.json"), JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 })
  let released = false
  return () => {
    if (released) return
    const current = owner(directory)
    if (current.pid !== process.pid || current.token !== token) throw new Error("Database writer lease is no longer owned by this process")
    // Retain the tiny ownership receipt; never remove another process's state.
    renameSync(directory, `${directory}.released-${token}`)
    released = true
  }
}
