import { readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

/** `<dir>/daemon-restart`: `<pid> <until>` while a `daemon restart` stops the daemon and starts the next one itself. */
export const RESTART_MARK = "daemon-restart"
/** Longer than a restart takes (stop up to 5 s for the lock, start up to 5 s); a mark past it is ignored, whoever left it. */
export const RESTART_MARK_MS = 15_000

const markPath = (dir: string) => path.join(dir, RESTART_MARK)

/**
 * Set by `daemon restart` before it stops the daemon. A terminal that loses its daemon reconnects within 50 ms and would start the next
 * daemon itself, with its own environment and folder, before the restart's launch gets the writer lock; while the mark holds, it waits
 * for the daemon the restart starts instead (`ensureDaemon`).
 */
export function markRestart(dir: string, { pid = process.pid, now = Date.now() }: { pid?: number; now?: number } = {}) {
  try { writeFileSync(markPath(dir), `${pid} ${now + RESTART_MARK_MS}\n`, { mode: 0o600 }) } catch { /* no mark: the terminals race as before */ }
}

/** Removes the mark this process set; a newer one of another restart stays. */
export function clearRestart(dir: string, pid = process.pid) {
  try { if (Number(readFileSync(markPath(dir), "utf8").split(" ")[0]) === pid) rmSync(markPath(dir), { force: true }) } catch { /* already gone */ }
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

/** True while a restart that is still running and not past its time starts the next daemon. */
export function restartPending(dir: string, { now = Date.now(), isAlive = alive }: { now?: number; isAlive?: (pid: number) => boolean } = {}) {
  let text: string
  try { text = readFileSync(markPath(dir), "utf8") } catch { return false }
  const [pid, until] = text.trim().split(" ").map(Number)
  if (!Number.isSafeInteger(pid) || pid! <= 1 || pid === process.pid || !Number.isFinite(until)) return false
  return now < until! && until! - now <= RESTART_MARK_MS && isAlive(pid!)
}
