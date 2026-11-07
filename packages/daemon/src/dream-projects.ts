import { realpathSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
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
  // The nearest `.git` up the tree decides: a file marks a linked worktree (also for a subfolder of one); none at all is a plain folder.
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    try { return !statSync(path.join(current, ".git")).isFile() } catch { /* No `.git` here: look one level up. */ }
    if (current === path.dirname(current)) return true
  }
}

/** Folder names that hold keys and credentials rather than projects. */
const SECRET_SEGMENT = /^(secrets?|credentials?|private[-_]?keys?|keys?)$/i
/** Parents tools create for clones and checkouts of other repos (autopilot `*-wt`, `worktrees`): never the user's own project. */
const TOOL_CLONE_SEGMENT = /(^|[-_.])(wt|worktrees?)$/i

/**
 * Why Dream may not run on its own on `directory`, or undefined when it may. On top of `dreamEligibleDirectory`, a scheduled or
 * recovered run needs a real project: a folder inside a git repository whose root is a full checkout, not the home folder or
 * anything above it, no hidden folder on the way (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config`, a repo's `.git`), not `~/Library`,
 * no folder named like keys or secrets, and no parent a tool made for clones (`*-wt`, `worktrees`). A repository is required because
 * Dream proposes project facts: a session started in a plain folder (Downloads, a notes folder) has no project to learn about.
 */
export function dreamProjectSkip(directory: string, input: { dataDir?: string; home?: string } = {}): string | undefined {
  if (!dreamEligibleDirectory(directory, input)) return "temporary, missing, data-directory or linked-worktree folder"
  const resolved = path.resolve(directory)
  const home = path.resolve(input.home ?? homedir())
  if (resolved === path.parse(resolved).root || under(home, resolved)) return "the home folder or a folder above it"
  const segments = (under(resolved, home) ? path.relative(home, resolved) : resolved.slice(path.parse(resolved).root.length)).split(path.sep).filter(Boolean)
  if (segments.some((segment) => segment.startsWith("."))) return "a hidden folder"
  if (under(resolved, home) && segments[0] === "Library") return "the Library folder"
  if (segments.some((segment) => SECRET_SEGMENT.test(segment))) return "a keys or secrets folder"
  if (segments.some((segment) => TOOL_CLONE_SEGMENT.test(segment))) return "a folder of clones made by a tool"
  for (let current = resolved; ; current = path.dirname(current)) {
    try {
      // The nearest `.git`: a folder is a full checkout; a file is a linked worktree, also for a subfolder of one.
      return statSync(path.join(current, ".git")).isDirectory() ? undefined : "inside a linked worktree"
    } catch { /* No `.git` here: look one level up. */ }
    if (current === home || current === path.dirname(current)) return "not inside a git repository"
  }
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
