import { realpathSync } from "node:fs"

export class ProjectRestError extends Error {
  constructor(public code: "invalid_command" | "unsupported" | "busy" | "target_mismatch" | "unknown_session", message: string) { super(message) }
}

/** Fixed argv, bounded output and lifetime; no Git network operations. */
export async function projectGit(directory: string, args: string[], signal?: AbortSignal, limit = 180_000) {
  if (signal?.aborted) throw new ProjectRestError("busy", "Request cancelled")
  const child = Bun.spawn(["git", "--no-optional-locks", "-C", directory, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "--no-pager", ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } })
  let stopped = false
  const stop = () => { stopped = true; child.kill() }
  const timer = setTimeout(stop, 5000)
  signal?.addEventListener("abort", stop, { once: true })
  let bytes = 0
  const chunks: Uint8Array[] = []
  try {
    for await (const chunk of child.stdout) {
      bytes += chunk.byteLength
      if (bytes > limit) { stop(); break }
      chunks.push(chunk)
    }
    const ok = await child.exited === 0
    if (stopped) throw new ProjectRestError("busy", signal?.aborted ? "Request cancelled" : "Git output or time limit exceeded")
    return { ok, out: Buffer.concat(chunks).toString("utf8").trimEnd() }
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", stop) }
}

export async function projectGitRoot(directory: string, signal?: AbortSignal) {
  const root = await projectGit(directory, ["rev-parse", "--show-toplevel"], signal)
  if (!root.ok) return undefined
  const common = await projectGit(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)
  const listed = await projectGit(directory, ["worktree", "list", "--porcelain", "-z"], signal)
  const main = listed.out.split("\0").find((field) => field.startsWith("worktree "))?.slice(9)
  return { root: realpathSync(root.out), main: realpathSync(main ?? root.out), common: common.ok ? realpathSync(common.out) : realpathSync(root.out) }
}

export async function defaultBranch(directory: string, signal?: AbortSignal) {
  const remote = await projectGit(directory, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], signal)
  if (remote.ok) return { ref: remote.out, name: remote.out.replace(/^origin\//, "") }
  for (const name of ["main", "master", "trunk"]) if ((await projectGit(directory, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], signal)).ok) return { ref: name, name }
  return undefined
}
