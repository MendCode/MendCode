import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import path from "node:path"
import type { ProjectRestInfo, StorageWorktree, StorageWorktreesReport } from "@mendcode/protocol"
import { readGitBranch } from "./git-branch"
import { defaultBranch, projectGit } from "./project-git"

const DAY_MS = 86_400_000
/** Entries one size walk visits at most: a worktree this large reports a lower bound instead of stalling the daemon. */
const WALK_LIMIT = 400_000
/** Worktrees idle this long are cleaned when no age is given. */
export const DEFAULT_WORKTREE_IDLE_DAYS = 14

/** Bytes under `root` without following links, yielding to the event loop between directories. */
export async function treeBytes(root: string, limit = WALK_LIMIT): Promise<number> {
  let bytes = 0
  let seen = 0
  const pending = [root]
  while (pending.length && seen < limit) {
    const directory = pending.pop()!
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (++seen > limit) break
      const full = path.join(directory, entry.name)
      try {
        const stat = await lstat(full)
        // Allocated blocks, like du: a tree of many small files costs more disk than its bytes add up to.
        bytes += stat.blocks > 0 ? stat.blocks * 512 : stat.size
        if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(full)
      } catch { /* vanished while walking */ }
    }
  }
  return bytes
}

type Target = StorageWorktree & { project: ProjectRestInfo }

/**
 * What the daemon's worktrees cost and which of them may go. A worktree is a git checkout that shares the project's
 * object store (`git worktree add`), so the cost is its working files and ignored build output; removal uses plain
 * `git worktree remove` (no --force), which git itself refuses for uncommitted or untracked work.
 */
export function createWorktreeGc(input: {
  dir: string
  projects(): ProjectRestInfo[]
  occupied(directory: string): boolean
  /** Last time a session worked in `directory` (0 when none ever did). */
  lastSession(directory: string): number
  /** Drops the registry entries of a removed (or vanished) worktree. */
  forget(project: ProjectRestInfo, directory: string): void
  now(): number
}) {
  const { dir } = input

  function lastTouched(directory: string): number {
    let latest = 0
    const touch = (file: string) => { try { latest = Math.max(latest, statSync(file).mtimeMs) } catch { /* absent */ } }
    touch(directory)
    const pointer = path.join(directory, ".git")
    touch(pointer)
    try {
      // A linked worktree's .git is a file naming its private git dir; HEAD and index move with every commit and checkout.
      const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(pointer, "utf8"))?.[1]?.trim()
      if (target) { touch(path.join(target, "HEAD")); touch(path.join(target, "index")) }
    } catch { /* a missing or odd .git: the directory time stands */ }
    return Math.max(latest, input.lastSession(directory))
  }

  async function inspect(project: ProjectRestInfo, directory: string, idleDays: number, signal?: AbortSignal): Promise<Target> {
    const occupied = input.occupied(directory)
    if (!existsSync(directory)) return { project, directory, branch: null, bytes: 0, state: "missing", clean: true, idleDays: 0, occupied, removable: !occupied, ...(occupied ? { keep: "a session still lists it" } : {}) }
    const branch = readGitBranch(directory).branch ?? null
    const status = await projectGit(directory, ["status", "--porcelain", "--untracked-files=normal"], signal).catch(() => undefined)
    const clean = status?.ok === true && status.out === ""
    const base = await defaultBranch(project.worktree, signal).catch(() => undefined)
    let merged = false
    if (branch) for (const head of ["HEAD", ...(base ? [base.ref] : [])]) if ((await projectGit(project.worktree, ["merge-base", "--is-ancestor", branch, head], signal).catch(() => undefined))?.ok) { merged = true; break }
    const idle = Math.max(0, Math.floor((input.now() - lastTouched(directory)) / DAY_MS))
    const keep = occupied ? "a session, loop or workflow works in it" : !clean ? "uncommitted or untracked changes" : !merged ? (branch ? "branch has commits that are not merged" : "detached HEAD") : idle < idleDays ? `used ${idle} day${idle === 1 ? "" : "s"} ago` : undefined
    return { project, directory, branch, bytes: await treeBytes(directory), state: merged ? "merged" : "unmerged", clean, occupied, idleDays: idle, removable: keep === undefined, ...(keep ? { keep } : {}) }
  }

  async function scan(idleDays: number, signal?: AbortSignal): Promise<Target[]> {
    const found: Target[] = []
    for (const project of input.projects()) {
      for (const directory of project.sandboxes) {
        if (found.length >= 500) return found
        found.push(await inspect(project, directory, idleDays, signal))
      }
    }
    return found
  }

  /** Old safety copies `workspace-remove` leaves in `trash/worktrees`. */
  function trashEntries(): Array<{ file: string; mtimeMs: number }> {
    const root = path.join(dir, "trash", "worktrees")
    try {
      return readdirSync(root).flatMap((name) => {
        const file = path.join(root, name)
        try { return [{ file, mtimeMs: statSync(file).mtimeMs }] } catch { return [] }
      })
    } catch { return [] }
  }

  async function trashBytes() {
    let total = 0
    for (const entry of trashEntries()) total += await treeBytes(entry.file)
    return total
  }

  async function loopBytes() {
    const root = path.join(dir, "loop-worktrees")
    return existsSync(root) ? treeBytes(root) : 0
  }

  async function report(idleDays = DEFAULT_WORKTREE_IDLE_DAYS, signal?: AbortSignal): Promise<StorageWorktreesReport> {
    const targets = await scan(idleDays, signal)
    const worktrees = targets.map(({ project: _project, ...rest }): StorageWorktree => rest)
    return {
      worktrees,
      totalBytes: worktrees.reduce((sum, item) => sum + item.bytes, 0),
      removableBytes: worktrees.filter((item) => item.removable).reduce((sum, item) => sum + item.bytes, 0),
      trashBytes: await trashBytes(),
      loopBytes: await loopBytes(),
    }
  }

  /** Removes what `report` marks removable (and trash older than the window). `dryRun` only counts. */
  async function clean(options: { idleDays?: number; dryRun?: boolean; signal?: AbortSignal }) {
    const idleDays = options.idleDays ?? DEFAULT_WORKTREE_IDLE_DAYS
    const targets = await scan(idleDays, options.signal)
    let removed = 0
    let bytes = 0
    for (const target of targets) {
      if (!target.removable) continue
      if (!options.dryRun) {
        if (target.state === "missing") await projectGit(target.project.worktree, ["worktree", "prune"], options.signal).catch(() => undefined)
        else {
          const gone = await projectGit(target.project.worktree, ["worktree", "remove", target.directory], options.signal).catch(() => undefined)
          // git refuses unclean work itself: whatever it keeps was not safe to remove.
          if (!gone?.ok || existsSync(target.directory)) continue
          if (target.branch) await projectGit(target.project.worktree, ["branch", "-d", "--", target.branch], options.signal).catch(() => undefined)
        }
        input.forget(target.project, target.directory)
      }
      removed++
      bytes += target.bytes
    }
    const cutoff = input.now() - idleDays * DAY_MS
    for (const entry of trashEntries()) {
      if (entry.mtimeMs > cutoff) continue
      bytes += await treeBytes(entry.file)
      if (!options.dryRun) rmSync(entry.file, { recursive: true, force: true })
      removed++
    }
    return { removed, bytes }
  }

  return { report, clean, trashBytes, treeBytes }
}

export type WorktreeGc = ReturnType<typeof createWorktreeGc>
