import { existsSync } from "node:fs"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { GIT_COMMIT_MAX_LISTED, GIT_COMMIT_MAX_MESSAGE, GIT_COMMIT_MAX_PATHS, type GitCommitPlan, type GitCommitReport } from "@mendcode/protocol"
import { projectPath } from "./file-rest"
import { FileApiError } from "./file-rest-process"
import { TIMEOUT_MS, git, repoLocks, shown } from "./git-exec"

/** Where git keeps the state of a half-done operation, and what to tell the user. */
const IN_PROGRESS = [["MERGE_HEAD", "a merge"], ["rebase-merge", "a rebase"], ["rebase-apply", "a rebase"], ["CHERRY_PICK_HEAD", "a cherry-pick"], ["REVERT_HEAD", "a revert"]] as const
const HOOKS = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]

/** A reason the commit did not happen: one clear line, plus the redacted git output for a failed commit. `code` is the daemon's reply code. */
export class GitCommitRefusal extends Error {
  constructor(message: string, readonly code: "invalid_command" | "not_git" = "invalid_command") { super(`[GIT]: ${message}`) }
}

/**
 * The commit the Git page asks for (`git.commit`, docs/git.md). It checks everything that can be checked, then runs `git add -- <untracked
 * selected paths>` when some selected files are new and `git commit -m <message> -- <selected paths>`. The repository's own hooks run; there is no
 * `--no-verify`, `--amend`, `--force` or `-a`, no path outside the selection is touched, and nothing is pushed. Paths are relative to the
 * repository root and are resolved with the project containment helper (`..` and symlinks that leave the repository are refused). Changes already
 * staged for other paths stay staged and are left out of the commit (git's `--only` form); the plan names them. With `preview` nothing runs.
 */
export async function gitCommit(input: { directory: string; message: string; paths: readonly string[]; preview?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<GitCommitReport> {
  const env = input.env ?? process.env
  const limit = input.timeoutMs ?? TIMEOUT_MS
  const top = await git({ cwd: input.directory, args: ["rev-parse", "--show-toplevel"], env }).catch(() => undefined)
  if (!top || top.code !== 0 || !top.out.trim()) throw new GitCommitRefusal("not a git repository", "not_git")
  const root = await realpath(top.out.trim()).catch(() => { throw new GitCommitRefusal("not a git repository", "not_git") })
  const read = async (args: string[]) => {
    const done = await git({ cwd: root, args, env })
    if (done.timedOut) throw new GitCommitRefusal(`git ${args[0]} timed out`)
    return done
  }

  const head = await read(["symbolic-ref", "-q", "--short", "HEAD"])
  if (head.code !== 0 || !head.out.trim()) throw new GitCommitRefusal("detached HEAD: switch to a branch before committing")
  const branch = head.out.trim()
  for (const [name, label] of IN_PROGRESS) {
    const where = await read(["rev-parse", "--git-path", name])
    if (where.code === 0 && existsSync(path.resolve(root, where.out.trim()))) throw new GitCommitRefusal(`${label} is in progress: finish or abort it first`)
  }
  const [name, email] = await Promise.all([read(["config", "--get", "user.name"]), read(["config", "--get", "user.email"])])
  const named = (name.code === 0 && name.out.trim()) || env.GIT_AUTHOR_NAME
  const mailed = (email.code === 0 && email.out.trim()) || env.GIT_AUTHOR_EMAIL
  if (!named || !mailed) throw new GitCommitRefusal("no git identity: set user.name and user.email")

  const message = input.message.replace(/\r\n?/g, "\n").trim()
  if (!message) throw new GitCommitRefusal("empty message")
  if (message.includes("\0") || message.length > GIT_COMMIT_MAX_MESSAGE) throw new GitCommitRefusal("message is invalid or too long")
  if (input.paths.length === 0) throw new GitCommitRefusal("nothing selected")
  if (input.paths.length > GIT_COMMIT_MAX_PATHS) throw new GitCommitRefusal(`too many files (${GIT_COMMIT_MAX_PATHS} at most)`)

  const paths: string[] = []
  for (const raw of input.paths) {
    if (!raw || raw.includes("\0") || path.isAbsolute(raw)) throw new GitCommitRefusal(`${shown(raw).slice(0, 80) || "empty path"}: not a path inside the repository`)
    const relative = await projectPath(root, raw).then(({ full }) => path.relative(root, full).split(path.sep).join("/"), (error: unknown) => {
      throw new GitCommitRefusal(`${raw.slice(0, 80)}: ${error instanceof FileApiError ? "outside the repository" : "cannot be resolved"}`)
    })
    if (!relative || relative === ".." || relative.startsWith("../") || relative === ".git" || relative.startsWith(".git/")) throw new GitCommitRefusal(`${raw.slice(0, 80)}: outside the repository`)
    const info = await lstat(path.join(root, relative)).catch(() => undefined)
    if (info?.isDirectory()) throw new GitCommitRefusal(`${relative}: is a folder, select its files`)
    if (!paths.includes(relative)) paths.push(relative)
  }

  const changed = await read(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", ...paths])
  if (changed.code !== 0) throw new GitCommitRefusal(`git status failed: ${shown(changed.err).split("\n").at(-1) ?? ""}`)
  const entries = changed.out.split("\0").filter(Boolean).map((entry) => ({ code: entry.slice(0, 2), path: entry.slice(3) }))
  const withChanges = new Set(entries.map((entry) => entry.path))
  const unchanged = paths.find((candidate) => !withChanges.has(candidate))
  if (unchanged) throw new GitCommitRefusal(`${unchanged}: no changes to commit`)
  const untracked = paths.filter((candidate) => entries.some((entry) => entry.path === candidate && entry.code === "??"))

  const staged = await read(["diff", "--cached", "--name-only", "-z", "--no-renames"])
  const elsewhere = staged.out.split("\0").filter((candidate) => candidate && !paths.includes(candidate))

  const hooksDir = await read(["rev-parse", "--git-path", "hooks"])
  const hooks = hooksDir.code === 0 ? HOOKS.filter((hook) => existsSync(path.resolve(root, hooksDir.out.trim(), hook))) : []

  const argv = ["git", "commit", "-m", message, "--", ...paths]
  const plan: GitCommitPlan = {
    root, branch, argv, paths, untracked, hooks,
    ...(untracked.length ? { add: ["git", "add", "--", ...untracked] } : {}),
    stagedElsewhere: elsewhere.slice(0, GIT_COMMIT_MAX_LISTED), stagedElsewhereTotal: elsewhere.length,
  }
  if (input.preview) return { plan, committed: false }

  if (repoLocks.has(root)) throw new GitCommitRefusal("another commit is running in this repository")
  repoLocks.add(root)
  try {
    if (plan.add) {
      const added = await git({ cwd: root, args: plan.add.slice(1), env, timeoutMs: limit })
      if (added.code !== 0) throw new GitCommitRefusal(`git add failed\n${shown(added.err || added.out)}`)
    }
    const done = await git({ cwd: root, args: argv.slice(1), env, timeoutMs: limit })
    if (done.code !== 0 || done.timedOut) {
      // Put the new files back as they were: untracked, as the user left them. Nothing else was touched.
      if (untracked.length) await git({ cwd: root, args: ["rm", "--cached", "-q", "--", ...untracked], env })
      const reason = done.timedOut ? `commit timed out after ${Math.round(limit / 1000)}s` : `commit failed (exit ${done.code})`
      throw new GitCommitRefusal(`${reason}\n${shown(`${done.out}\n${done.err}`)}`)
    }
    const sha = await git({ cwd: root, args: ["rev-parse", "--short", "HEAD"], env })
    return { plan, committed: true, sha: sha.out.trim(), subject: message.split("\n")[0]!.slice(0, 200) }
  } finally { repoLocks.delete(root) }
}
