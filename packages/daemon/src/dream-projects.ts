import { realpathSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/** Loops, workflows and PR reviews are machinery, not work the user was doing. */
export const dreamMachinery = (title: string) => /^(loop|workflow|pr review|review) ·/i.test(title)

const SYSTEM_TEMP = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders"]

const under = (directory: string, root: string) => directory === root || directory.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

function tempRoots() {
  const roots = new Set(SYSTEM_TEMP)
  const own = tmpdir()
  roots.add(own)
  try { roots.add(realpathSync(own)) } catch { /* A temp dir that cannot be resolved is still excluded by its plain path. */ }
  return [...roots]
}

/**
 * Whether Dream may run on its own (schedule or recovery) for a project folder. Not temporary folders (tests, replays), not folders
 * that no longer exist, not linked git worktrees (lanes, PR reviews, replays: their `.git` is a file) and not anything under the
 * daemon's own data directory. A manual `/dream` is never filtered: the user asked for that folder.
 */
export function dreamEligibleDirectory(directory: string, input: { dataDir?: string } = {}): boolean {
  if (!directory || !path.isAbsolute(directory)) return false
  if (tempRoots().some((root) => under(directory, root))) return false
  if (input.dataDir && under(directory, input.dataDir)) return false
  try { if (!statSync(directory).isDirectory()) return false } catch { return false }
  // No `.git` at all is a plain folder; a `.git` file marks a linked worktree.
  try { return !statSync(path.join(directory, ".git")).isFile() } catch { return true }
}

/**
 * Whether anything new for a project's Dream exists since its last finished run: a session of the project updated after that run
 * started, or a saved or pending memory touched after it ended (the run's own proposals do not count). No earlier run means yes.
 */
export function hasNewMaterial(input: { lastStartedAt?: number | undefined; lastEndedAt?: number | undefined; sessionsUpdatedAt: readonly number[]; memoriesUpdatedAt: readonly number[] }): boolean {
  if (input.lastStartedAt === undefined) return true
  const sessionsSince = input.lastStartedAt
  const memoriesSince = input.lastEndedAt ?? input.lastStartedAt
  return input.sessionsUpdatedAt.some((at) => at > sessionsSince) || input.memoriesUpdatedAt.some((at) => at > memoriesSince)
}
