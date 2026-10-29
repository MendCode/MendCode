import { closeSync, linkSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function ownerOf(file: string) {
  try {
    return Number(readFileSync(file, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/**
 * One writer process per data directory (A11). A second daemon fails fast with the owner's pid
 * instead of "recovering" the lock; a lock left by a dead process is replaced.
 *
 * The lock file appears with its pid already in it: the pid is written to a file of this process and linked into place, which
 * fails when a lock exists. So no other process can read an empty lock and take it for a dead one. A dead owner's lock is removed
 * only while it still names that owner, so two processes recovering the same stale lock cannot remove each other's new one.
 */
export function acquireWriterLock(file: string, pid = process.pid) {
  const own = `${file}.${pid}.${Math.random().toString(36).slice(2)}`
  const fd = openSync(own, "wx", 0o600)
  try {
    writeSync(fd, String(pid))
  } finally {
    closeSync(fd)
  }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(own, file)
        let released = false
        return {
          release() {
            if (released) return
            released = true
            try {
              if (readFileSync(file, "utf8") === String(pid)) rmSync(file)
            } catch {}
          },
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        const owner = ownerOf(file)
        if (owner === undefined) continue
        if (Number.isInteger(owner) && owner > 0 && (owner === pid || alive(owner))) {
          throw new Error(`[STORE]: data directory is owned by running process ${owner}`)
        }
        if (ownerOf(file) === owner) rmSync(file, { force: true })
      }
    }
    throw new Error("[STORE]: could not acquire writer lock")
  } finally {
    rmSync(own, { force: true })
  }
}
