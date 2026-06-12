import { spawnSync } from "child_process"
import path from "path"
import type { GitWorktreeEntry } from "./types"

function normalizePath(value: string) {
  return path.resolve(value)
}

export function parseGitWorktreeList(text: string): GitWorktreeEntry[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .reduce<GitWorktreeEntry[]>((entries, line) => {
      if (!line) return entries
      if (line.startsWith("worktree ")) {
        entries.push({ path: normalizePath(line.slice("worktree ".length)), branch: null })
        return entries
      }
      const current = entries[entries.length - 1]
      if (current && line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "")
      return entries
    }, [])
}

export function gitWorktreeList(root: string) {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8", timeout: 1000 })
  if (result.status !== 0) {
    return { ok: false as const, entries: [] as GitWorktreeEntry[], error: String(result.stderr || result.stdout || "").trim() || "failed to read git worktrees" }
  }
  return { ok: true as const, entries: parseGitWorktreeList(String(result.stdout || "")), error: null }
}

function gitCurrentWorktree(root: string) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", timeout: 1000 })
  if (result.status !== 0) return normalizePath(root)
  return normalizePath(String(result.stdout || "").trim() || root)
}

export function resolveWorktreeContext(root: string) {
  const requestedRoot = normalizePath(root)
  const currentPath = gitCurrentWorktree(requestedRoot)
  const git = gitWorktreeList(currentPath)
  const repoRoot = git.ok && git.entries[0]?.path ? git.entries[0].path : currentPath
  const currentEntry = git.entries.find((entry) => entry.path === currentPath)
  return {
    requestedRoot,
    repoRoot,
    currentPath,
    currentBranch: currentEntry?.branch ?? null,
    isLinkedWorktree: currentPath !== repoRoot,
    git,
  }
}
