import { existsSync } from "node:fs"
import { open, readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"

/** A cache nobody has loaded in this long is deleted; loading one (`refresh`) renews it. */
export const CACHE_IDLE_MS = 30 * 86_400_000
/** A temporary file of a write that failed before its rename. */
export const TEMP_GRACE_MS = 3_600_000
/** Entries one pass looks at, oldest first; the rest wait for the next pass. */
export const PRUNE_LIMIT = 200
const HEAD_BYTES = 4_096

export type PruneResult = { scanned: number; removed: number; orphaned: number; idle: number; temporary: number }

/** The folder a cache was built for: `cwd` is the second key of the file, so its first bytes hold it and the (large) rest is never read. */
async function folderOf(file: string): Promise<string | undefined> {
  const handle = await open(file, "r").catch(() => undefined)
  if (!handle) return undefined
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0)
    const match = /"cwd":("(?:[^"\\]|\\.)*")/.exec(buffer.toString("utf8", 0, bytesRead))
    return match ? (JSON.parse(match[1]!) as string) : undefined
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Removes graph caches that can never be used again: those whose folder no longer exists (a PR review's worktree, a finished lane),
 * those unused for `idleMs`, and leftover `.tmp` files. Bounded: at most `limit` entries per pass, oldest first, and a cache is only
 * opened for its first 4 KB. A cache that cannot be read is left unless it is idle.
 */
export async function pruneCaches(input: { cacheDir: string; now: number; idleMs?: number; limit?: number; exists?: (folder: string) => boolean }): Promise<PruneResult> {
  const result: PruneResult = { scanned: 0, removed: 0, orphaned: 0, idle: 0, temporary: 0 }
  const exists = input.exists ?? existsSync
  const names = await readdir(input.cacheDir).catch(() => [] as string[])
  const entries = (await Promise.all(names.filter((name) => name.endsWith(".json") || name.endsWith(".tmp")).map(async (name) => {
    const info = await stat(join(input.cacheDir, name)).catch(() => undefined)
    return info?.isFile() ? { name, at: info.mtimeMs } : undefined
  }))).filter((entry): entry is { name: string; at: number } => entry !== undefined).sort((a, b) => a.at - b.at).slice(0, input.limit ?? PRUNE_LIMIT)
  for (const entry of entries) {
    result.scanned++
    const file = join(input.cacheDir, entry.name)
    if (entry.name.endsWith(".tmp")) {
      if (input.now - entry.at >= TEMP_GRACE_MS) { await rm(file, { force: true }); result.temporary++; result.removed++ }
      continue
    }
    const idle = input.now - entry.at >= (input.idleMs ?? CACHE_IDLE_MS)
    const folder = await folderOf(file)
    const orphan = folder !== undefined && !exists(folder)
    if (!idle && !orphan) continue
    await rm(file, { force: true })
    result.removed++
    if (orphan) result.orphaned++
    else result.idle++
  }
  return result
}
