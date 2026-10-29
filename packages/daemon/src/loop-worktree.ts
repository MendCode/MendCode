import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import type { WorktreePort } from "@mendcode/loops"

type GitResult = { ok: boolean; out: string; err: string }

/** git without a shell; a failure to start (no git) is a failed result, never a throw. */
async function git(args: string[], cwd: string, env?: Record<string, string>): Promise<GitResult> {
  try {
    const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { ok: code === 0, out: out.trim(), err: err.trim() }
  } catch (error) {
    return { ok: false, out: "", err: error instanceof Error ? error.message : String(error) }
  }
}

/** True when `directory` is inside a git work tree. */
export async function isGitCheckout(directory: string): Promise<boolean> {
  return (await git(["rev-parse", "--is-inside-work-tree"], directory)).out === "true"
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "loop"

/** Identity for the commit that keeps a run's leftovers, only when the repository has none of its own. */
async function identity(cwd: string): Promise<Record<string, string>> {
  const email = await git(["config", "user.email"], cwd)
  return email.out ? {} : { GIT_AUTHOR_NAME: "MendCode loop", GIT_AUTHOR_EMAIL: "loop@mendcode.invalid", GIT_COMMITTER_NAME: "MendCode loop", GIT_COMMITTER_EMAIL: "loop@mendcode.invalid" }
}

/**
 * Loop worktree leases on git. Worktrees live under `root` (never inside the user's checkout) on branches
 * `loop/<name>-<key>`. Ending a lease never loses work: what the run left uncommitted is committed to its branch first;
 * a run that changed nothing leaves no trace (worktree and branch deleted), otherwise only the directory goes and the
 * branch stays for the user to review or merge.
 */
export function createGitWorktrees(options: { root: string }): WorktreePort {
  const root = path.resolve(options.root)
  const inside = (target: string) => path.resolve(target).startsWith(`${root}${path.sep}`)
  return {
    async create({ directory, key, label, from }) {
      if (!/^[A-Za-z0-9_-]+$/.test(key)) return { ok: false, message: "invalid lease key" }
      const top = await git(["rev-parse", "--show-toplevel"], directory)
      if (!top.ok) return { ok: false, message: `${directory} is not a git checkout` }
      const base = await git(["rev-parse", "--verify", `${from ?? "HEAD"}^{commit}`], top.out)
      if (!base.ok) return { ok: false, message: from ? `the previous run's branch ${from} is gone` : "the repository has no commit to branch from" }
      mkdirSync(root, { recursive: true })
      const target = path.join(root, key)
      if (existsSync(target)) return { ok: false, message: `${target} already exists` }
      const branch = `loop/${slug(label)}-${key}`
      const added = await git(["worktree", "add", "-b", branch, target, base.out], top.out)
      if (!added.ok) return { ok: false, message: added.err.split("\n").at(-1) || "git worktree add failed" }
      return { ok: true, path: target, branch, base: base.out }
    },
    async release({ directory, path: target, branch, base }) {
      if (!inside(target)) return { state: "retained", detail: "refusing to clean a path outside the loop worktree root" }
      const present = existsSync(target)
      if (present) {
        const status = await git(["status", "--porcelain"], target)
        if (!status.ok) return { state: "retained", detail: `cannot read the worktree: ${status.err}`.slice(0, 500) }
        if (status.out) {
          const staged = await git(["add", "-A"], target)
          const committed = staged.ok ? await git(["commit", "--no-verify", "-q", "-m", "loop run: changes left uncommitted by the run"], target, await identity(target)) : staged
          if (!committed.ok) return { state: "retained", detail: `could not commit what the run left; the worktree is kept at ${target}: ${committed.err}`.slice(0, 500) }
        }
      }
      const ahead = base ? await git(["rev-list", "--count", `${base}..${branch}`], directory) : undefined
      const commits = ahead?.ok ? Number(ahead.out) : undefined
      if (present) {
        const removed = await git(["worktree", "remove", "--force", target], directory)
        if (!removed.ok) return { state: "retained", detail: `could not remove the worktree at ${target}: ${removed.err}`.slice(0, 500) }
      }
      await git(["worktree", "prune"], directory)
      if (commits === 0) {
        await git(["branch", "-D", branch], directory)
        return { state: "removed" }
      }
      return { state: "retained", detail: commits === undefined ? `the run's work is on branch ${branch}` : `${commits} commit${commits === 1 ? "" : "s"} on branch ${branch}` }
    },
  }
}
