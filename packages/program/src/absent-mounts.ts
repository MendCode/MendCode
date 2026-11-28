import { existsSync } from "node:fs"

/**
 * macOS mounts `/home` and `/net` through autofs: every lookup below a `/home/<name>` that is not there asks the automounter and takes
 * 10 to 15 ms, an `existsSync`, a `realpathSync` and a `stat` alike, and blocks the thread for all of it. Sessions that came from a
 * Linux hub carry folders like `/home/<user>/projects/…`; a loop that checked each of them for a `.git`, a manifest or its real path
 * held the daemon's event loop for seconds, and once for over a minute. The top folder under the mount is asked once and the answer
 * kept: a path below one that is not there is absent without touching the file system.
 */
const AUTOFS_ROOTS = ["/home/", "/net/"]
/** How long an answer about a mount's top folder holds (a share mounted meanwhile is seen within this). */
export const ABSENT_MOUNT_TTL_MS = 5 * 60_000
const MAX_KEPT = 256
const kept = new Map<string, { at: number; present: boolean }>()

/** Whether `path` lies under an automounted top folder (`/home/<name>`, `/net/<host>`) that does not exist on this machine. */
export function underAbsentMount(path: string, options: { platform?: string; now?: number; exists?: (path: string) => boolean } = {}): boolean {
  if ((options.platform ?? process.platform) !== "darwin") return false
  const root = AUTOFS_ROOTS.find((prefix) => path.startsWith(prefix))
  if (!root) return false
  const name = path.slice(root.length).split("/")[0]
  if (!name) return false
  const top = `${root}${name}`
  const now = options.now ?? Date.now()
  const known = kept.get(top)
  if (known && now - known.at < ABSENT_MOUNT_TTL_MS) return !known.present
  const present = (options.exists ?? existsSync)(top)
  kept.delete(top)
  kept.set(top, { at: now, present })
  while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string)
  return !present
}

/** Forgets every kept answer (tests). */
export function forgetAbsentMounts() {
  kept.clear()
}
