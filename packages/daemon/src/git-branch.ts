import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

export type BranchInfo = { branch?: string; detached?: boolean }

const MAX_LEVELS = 40

/** Finds the nearest `.git` walking up from `directory` (a directory, or a file in a worktree/submodule). */
function findGit(directory: string) {
  let current = path.resolve(directory)
  for (let level = 0; level < MAX_LEVELS; level++) {
    const candidate = path.join(current, ".git")
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

function read(file: string) {
  try {
    return readFileSync(file, "utf8").trim()
  } catch {
    return undefined
  }
}

/**
 * Current branch straight from `HEAD`, without spawning git. A `.git` file (worktree, submodule) points at
 * the real git dir; a detached HEAD reports the short commit id. Not a repository, or unreadable → `{}`.
 */
export function readGitBranch(directory: string): BranchInfo {
  const dot = findGit(directory)
  if (!dot) return {}
  let gitDir = dot
  try {
    if (statSync(dot).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(read(dot) ?? "")?.[1]?.trim()
      if (!pointer) return {}
      gitDir = path.resolve(path.dirname(dot), pointer)
    }
  } catch {
    return {}
  }
  const head = read(path.join(gitDir, "HEAD"))
  if (!head) return {}
  const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim()
  if (ref) return { branch: ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref }
  return /^[0-9a-f]{7,64}$/i.test(head) ? { branch: head.slice(0, 7), detached: true } : {}
}
