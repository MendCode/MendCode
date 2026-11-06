import { captureOutput } from "@mendcode/tools"
import { readGitBranch } from "./git-branch"

/** A status of a huge tree is cut past this (the counts then fall short) and ends at the time limit. */
const STATUS_OUTPUT_BYTES = 32 * 1024 * 1024
const STATUS_TIMEOUT_MS = 60_000

/** Read-only status, including local upstream divergence. Never fetches or refreshes the index. */
export async function readGitStatus(directory: string) {
  const branch = readGitBranch(directory)
  if (!branch.branch) return {}
  const result = await captureOutput(["git", "-C", directory, "status", "--porcelain=v2", "--branch", "-z"], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, stderr: "capture", limit: STATUS_OUTPUT_BYTES, timeoutMs: STATUS_TIMEOUT_MS, keepOnLimit: true })
  if (result.code !== 0 || result.stopped) return { ...branch, error: result.err.trim().slice(0, 200) }
  const output = result.out
  const entries = output.split("\0")
  let dirty = 0
  let conflicts = 0
  let untracked = 0
  // Of the changed entries, those with a change in the index (`X` of `XY`) and those with one in the worktree (`Y`): a file can be both.
  let staged = 0
  let unstaged = 0
  for (let i = 0; i < entries.length; i++) {
    if (/^[12u?] /.test(entries[i]!)) dirty++
    if (/^[12] /.test(entries[i]!)) {
      if (entries[i]![2] !== ".") staged++
      if (entries[i]![3] !== ".") unstaged++
    }
    if (entries[i]?.startsWith("u ")) conflicts++
    if (entries[i]?.startsWith("? ")) untracked++
    if (entries[i]?.startsWith("2 ")) i++
  }
  const divergence = /# branch.ab \+(\d+) -(\d+)/.exec(output)
  return { ...branch, dirty, conflicts, untracked, staged, unstaged, ...(divergence ? { ahead: Number(divergence[1]), behind: Number(divergence[2]) } : {}) }
}
