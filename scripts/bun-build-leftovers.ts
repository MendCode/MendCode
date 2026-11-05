import { readdirSync, rmSync, statSync } from "node:fs"
import path from "node:path"

/** Temp files `bun build --compile` leaves next to its output: `.<hash>-00000000.bun-build`, as large as the executable. */
export const BUN_BUILD_LEFTOVER = /^\..+\.bun-build$/
/** Younger files may belong to a build still running in the same directory. */
export const BUN_BUILD_MIN_AGE_MS = 5 * 60_000

/** Removes the leftovers in `directory` older than `minAgeMs`; returns the paths removed. */
export function removeBunBuildLeftovers(directory: string, now = Date.now(), minAgeMs = BUN_BUILD_MIN_AGE_MS): string[] {
  const removed: string[] = []
  let names: string[]
  try { names = readdirSync(directory) } catch { return removed }
  for (const name of names) {
    if (!BUN_BUILD_LEFTOVER.test(name)) continue
    const file = path.join(directory, name)
    try {
      const stat = statSync(file)
      if (!stat.isFile() || now - stat.mtimeMs <= minAgeMs) continue
      rmSync(file, { force: true })
      removed.push(file)
    } catch { /* gone already, or not ours to remove */ }
  }
  return removed
}
