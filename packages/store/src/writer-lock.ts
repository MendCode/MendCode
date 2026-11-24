import { spawnSync } from "node:child_process"
import { closeSync, linkSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs"

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** A process that started this long after the lock was written cannot be the one that wrote it (clock and file-time rounding). */
const START_SLACK_MS = 2_000

/**
 * When the OS started `pid` (epoch milliseconds), `"gone"` when no such process exists, undefined when it cannot be read. Only Windows
 * needs it: it hands a pid out again within seconds (a reboot restarts the numbering), so a lock left by a daemon that died
 * uncleanly can name a pid that now belongs to an unrelated program, which `kill(pid, 0)` cannot tell apart from the daemon.
 */
function processStartMs(pid: number): number | "gone" | undefined {
  const script = `try { [DateTimeOffset]::new((Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds() } catch [Microsoft.PowerShell.Commands.ProcessCommandException] { 'gone' }`
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
  const text = run.stdout?.trim() ?? ""
  if (text === "gone") return "gone"
  return /^\d{10,15}$/.test(text) ? Number(text) : undefined
}

/** What the lock checks ask of the OS; tests replace it. */
export type LockProbe = { platform: string; alive(pid: number): boolean; startMs(pid: number): number | "gone" | undefined; lockMs(file: string): number | undefined }
const OS_PROBE: LockProbe = {
  platform: process.platform,
  alive,
  startMs: processStartMs,
  lockMs: (file) => { try { return statSync(file).mtimeMs } catch { return undefined } },
}

/** Whether the process that `file` names is still the one that wrote it: alive, and on Windows not a later process that reused its pid. */
export function lockOwnerAlive(file: string, owner: number, probe: LockProbe = OS_PROBE) {
  if (!probe.alive(owner)) return false
  if (probe.platform !== "win32") return true
  const written = probe.lockMs(file)
  if (written === undefined) return true
  const started = probe.startMs(owner)
  if (started === "gone") return false
  return started === undefined || started <= written + START_SLACK_MS
}

function ownerOf(file: string) {
  try {
    return Number(readFileSync(file, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/** The live process holding the lock, if any: a daemon that owns the data directory whether or not it answers on its socket. */
export function writerLockOwner(file: string, probe: LockProbe = OS_PROBE): number | undefined {
  const owner = ownerOf(file)
  return owner !== undefined && Number.isInteger(owner) && owner > 0 && lockOwnerAlive(file, owner, probe) ? owner : undefined
}

/**
 * One writer process per data directory (A11). A second daemon fails fast with the owner's pid
 * instead of "recovering" the lock; a lock left by a dead process is replaced.
 *
 * The lock file appears with its pid already in it: the pid is written to a file of this process and linked into place, which
 * fails when a lock exists. So no other process can read an empty lock and take it for a dead one. A dead owner's lock is removed
 * only while it still names that owner, so two processes recovering the same stale lock cannot remove each other's new one.
 */
export function acquireWriterLock(file: string, pid = process.pid, probe: LockProbe = OS_PROBE) {
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
        if (Number.isInteger(owner) && owner > 0 && (owner === pid || lockOwnerAlive(file, owner, probe))) {
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
