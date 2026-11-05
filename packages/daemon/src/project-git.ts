import { readFileSync, realpathSync, statSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

export class ProjectRestError extends Error {
  constructor(public code: "invalid_command" | "unsupported" | "busy" | "target_mismatch" | "unknown_session", message: string) { super(message) }
}

let captures = 0

/**
 * Runs `argv` and returns its standard output (at most `limit` bytes) within `timeoutMs`. The output goes through a
 * temporary file removed afterwards, not a pipe: Bun holds about half a megabyte of native buffer for every piped child,
 * which a scan of many worktrees turns into tens of megabytes the system does not take back.
 */
export async function captureOutput(argv: string[], options: { env?: Record<string, string | undefined>; signal?: AbortSignal | undefined; limit: number; timeoutMs: number }) {
  const file = path.join(tmpdir(), `mendcode-capture-${process.pid}-${captures++}`)
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: Bun.file(file), stderr: "ignore", ...(options.env ? { env: options.env } : {}) })
  let stopped = false
  const stop = () => { stopped = true; child.kill() }
  const timer = setTimeout(stop, options.timeoutMs)
  // A file has no backpressure: its size is watched while the child runs.
  const watch = setInterval(() => { try { if (statSync(file).size > options.limit) stop() } catch { /* not created yet */ } }, 50)
  options.signal?.addEventListener("abort", stop, { once: true })
  try {
    const code = await child.exited
    let size = 0
    try { size = statSync(file).size } catch { /* nothing written */ }
    if (size > options.limit) stopped = true
    return { code, stopped, out: stopped ? "" : readFileSync(file, "utf8") }
  } finally {
    clearTimeout(timer)
    clearInterval(watch)
    options.signal?.removeEventListener("abort", stop)
    try { unlinkSync(file) } catch { /* never created */ }
  }
}

/** Fixed argv, bounded output and lifetime; no Git network operations. */
export async function projectGit(directory: string, args: string[], signal?: AbortSignal, limit = 180_000, timeoutMs = 5000) {
  if (signal?.aborted) throw new ProjectRestError("busy", "Request cancelled")
  const result = await captureOutput(["git", "--no-optional-locks", "-C", directory, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "--no-pager", ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, signal, limit, timeoutMs })
  if (result.stopped) throw new ProjectRestError("busy", signal?.aborted ? "Request cancelled" : "Git output or time limit exceeded")
  return { ok: result.code === 0, out: result.out.trimEnd() }
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
