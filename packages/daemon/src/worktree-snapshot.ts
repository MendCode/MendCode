import { execFileSync } from "node:child_process"
import path from "node:path"

export const WORKTREE_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024
export const WORKTREE_SNAPSHOT_MAX_FILES = 10_000
export const WORKTREE_FILE_MAX_BYTES = 2 * 1024 * 1024

/** Read-only Git inventory, including untracked files and worktrees whose .git is a file. */
export function worktreeFiles(directory: string): { root: string; files: string[]; complete: boolean } | undefined {
  let cwd = directory
  const git = (args: string[], input?: string) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", input, maxBuffer: 4 * 1024 * 1024, timeout: 2000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] })
  try {
    const root = git(["rev-parse", "--show-toplevel"]).trim()
    cwd = root
    const candidates = [...new Set(git(["ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "-z"]).split("\0").filter(Boolean))].sort()
    let ignored = ""
    if (candidates.length) {
      try { ignored = git(["check-ignore", "--no-index", "--stdin", "-z"], `${candidates.join("\0")}\0`) }
      catch (error) {
        const result = error as { status?: number; stdout?: string }
        if (result.status !== 1) throw error
        ignored = result.stdout ?? ""
      }
    }
    const excludes = new Set(ignored.split("\0"))
    const files = candidates.filter((file) => !excludes.has(file)).map((file) => path.join(root, file))
    return { root, files: files.slice(0, WORKTREE_SNAPSHOT_MAX_FILES), complete: files.length <= WORKTREE_SNAPSHOT_MAX_FILES }
  } catch {
    return undefined
  }
}
