import { readGitBranch } from "./git-branch"

/** Read-only status, including local upstream divergence. Never fetches or refreshes the index. */
export async function readGitStatus(directory: string) {
  const branch = readGitBranch(directory)
  if (!branch.branch) return {}
  const proc = Bun.spawn(["git", "-C", directory, "status", "--porcelain=v2", "--branch", "-z"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } })
  const [output, errors, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) return { ...branch, error: errors.trim().slice(0, 200) }
  const entries = output.split("\0")
  let dirty = 0
  let conflicts = 0
  let untracked = 0
  for (let i = 0; i < entries.length; i++) {
    if (/^[12u?] /.test(entries[i]!)) dirty++
    if (entries[i]?.startsWith("u ")) conflicts++
    if (entries[i]?.startsWith("? ")) untracked++
    if (entries[i]?.startsWith("2 ")) i++
  }
  const divergence = /# branch.ab \+(\d+) -(\d+)/.exec(output)
  return { ...branch, dirty, conflicts, untracked, ...(divergence ? { ahead: Number(divergence[1]), behind: Number(divergence[2]) } : {}) }
}
