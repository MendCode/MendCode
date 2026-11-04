import { lstat, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/** The prefix of every directory `createHostMcp` makes; the owning process id follows it, so a sweep can tell whose it is. */
export const HOST_MCP_DIR_PREFIX = "mendcode-host-mcp-"
/** A directory without a process id was made by an older build; it is swept once its config file has not been written for this long (a live daemon writes it again for every process it starts). */
const LEGACY_AGE_MS = 24 * 60 * 60 * 1000
/** At most this many directories are removed per sweep, so the first start after the leak does not spend long on it; the next start takes the rest. */
const SWEEP_LIMIT = 2000
/** Removals are done this many at a time, with the event loop free in between. */
const CHUNK = 25

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (failure) {
    return (failure as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The directory name for process `pid`: `mendcode-host-mcp-<pid>-` plus mkdtemp's random suffix. */
export const hostMcpPrefix = (pid = process.pid) => `${HOST_MCP_DIR_PREFIX}${pid}-`

/**
 * Removes the host MCP directories (`mendcode-host-mcp-*` in the temporary directory, nothing else) whose daemon is gone: the process
 * id in the name is not running, or the directory is from a build that did not write one and its config is a day old. Only real
 * directories owned by this user are touched. Returns how many were removed.
 */
export async function sweepHostMcpDirs(options: { root?: string; pid?: number; now?: number; limit?: number } = {}): Promise<number> {
  const root = options.root ?? tmpdir()
  const self = options.pid ?? process.pid
  const now = options.now ?? Date.now()
  const limit = options.limit ?? SWEEP_LIMIT
  const uid = process.getuid?.()
  const names = (await readdir(root).catch(() => [] as string[])).filter((name) => name.startsWith(HOST_MCP_DIR_PREFIX))
  let removed = 0
  for (let at = 0; at < names.length && removed < limit; at += CHUNK) {
    const batch = await Promise.all(names.slice(at, at + CHUNK).map(async (name) => {
      const dir = path.join(root, name)
      const info = await lstat(dir).catch(() => undefined)
      if (!info?.isDirectory() || (uid !== undefined && info.uid !== uid)) return false
      const owner = /^(\d+)-/.exec(name.slice(HOST_MCP_DIR_PREFIX.length))
      if (owner) {
        const pid = Number(owner[1])
        if (pid === self || alive(pid)) return false
      } else {
        const written = await lstat(path.join(dir, "mcp.json")).catch(() => undefined)
        if (now - (written?.mtimeMs ?? info.mtimeMs) < LEGACY_AGE_MS) return false
      }
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      return true
    }))
    removed += batch.filter(Boolean).length
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return removed
}
