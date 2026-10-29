import { lstat, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { GitInitPlan, GitInitReport } from "@mendcode/protocol"
import { TIMEOUT_MS, git, repoLocks, shown } from "./git-exec"
import { GitActionRefusal, safeRefName } from "./git-remote"

const FIRST_BRANCH = "main"

/** Where a `.git` entry is, from `start` up to the root of the file system: the first one, or undefined. Only looks; nothing is opened for writing. */
async function dotGitAbove(start: string) {
  for (let current = start; ; current = path.dirname(current)) {
    const entry = path.join(current, ".git")
    if (await lstat(entry).then(() => true, () => false)) return entry
    if (path.dirname(current) === current) return undefined
  }
}

/**
 * The repository the Git page's Initialize asks for (`git.init`, docs/git.md): `git init`, or `git init -b main` when the user's `init.defaultBranch` is
 * not set, in the project folder of the session and nowhere else. It makes the `.git` folder and touches nothing else: no first commit, no `.gitignore`,
 * no remote, no network. It is refused inside any repository (the answer names the root), in `/`, in the home folder itself, outside the session's
 * project folder, and where a `.git` exists that git cannot read: that one is reported and never deleted or overwritten. With `preview` nothing runs.
 */
export async function gitInit(input: { directory: string; project: string; preview?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<GitInitReport> {
  const env = input.env ?? process.env
  const folder = await realpath(input.directory).catch(() => { throw new GitActionRefusal("this folder does not exist") })
  const project = await realpath(input.project).catch(() => undefined)
  if (project !== folder) throw new GitActionRefusal("only the project folder of this session can be initialized")
  if (!(await lstat(folder)).isDirectory()) throw new GitActionRefusal("this is not a folder")
  if (path.dirname(folder) === folder) throw new GitActionRefusal("the root of the file system is not a project: open a folder of your own")
  for (const candidate of new Set([env.HOME, env.USERPROFILE, os.homedir()])) {
    if (candidate && (await realpath(candidate).catch(() => undefined)) === folder) throw new GitActionRefusal("this is your home folder: open a project folder instead")
  }

  const inside = await git({ cwd: folder, args: ["rev-parse", "--show-toplevel"], env })
  if (inside.timedOut) throw new GitActionRefusal("git timed out")
  if (inside.code === 127) throw new GitActionRefusal("git is not installed or not on PATH")
  if (inside.code === 0 && inside.out.trim()) {
    const root = await realpath(inside.out.trim()).catch(() => inside.out.trim())
    throw new GitActionRefusal(root === folder ? `this folder is already a git repository: ${root}` : `this folder is inside the git repository at ${root}: the page does not start another one`)
  }
  const dot = await dotGitAbove(folder)
  if (dot) throw new GitActionRefusal(`${dot} exists but git cannot read it: repair or move it yourself, nothing was changed`)
  if (!/not a git repository/i.test(inside.err)) throw new GitActionRefusal(`git could not read this folder: ${shown(inside.err).split("\n").at(-1) || `exit ${inside.code}`}`)

  const configured = await git({ cwd: folder, args: ["config", "--get", "init.defaultBranch"], env })
  const wanted = configured.code === 0 ? configured.out.trim() : ""
  const named = wanted !== "" && safeRefName(wanted) && (await git({ cwd: folder, args: ["check-ref-format", `refs/heads/${wanted}`], env })).code === 0
  const plan: GitInitPlan = named
    ? { directory: folder, argv: ["git", "init"], branch: wanted, branchFrom: "config" }
    : { directory: folder, argv: ["git", "init", "-b", FIRST_BRANCH], branch: FIRST_BRANCH, branchFrom: "default" }
  if (input.preview) return { plan, initialized: false }

  if (repoLocks.has(folder)) throw new GitActionRefusal("another action is running in this folder")
  repoLocks.add(folder)
  try {
    const done = await git({ cwd: folder, args: plan.argv.slice(1), env, timeoutMs: input.timeoutMs ?? TIMEOUT_MS })
    if (done.timedOut) throw new GitActionRefusal(`git init timed out${shown(`${done.out}\n${done.err}`) ? `\n${shown(`${done.out}\n${done.err}`)}` : ""}`)
    if (done.code === 127) throw new GitActionRefusal("git is not installed or not on PATH")
    if (done.code !== 0) throw new GitActionRefusal(`git init failed (exit ${done.code})\n${shown(`${done.out}\n${done.err}`)}`.trimEnd())
    const top = await git({ cwd: folder, args: ["rev-parse", "--show-toplevel"], env })
    return { plan, initialized: true, root: top.code === 0 && top.out.trim() ? await realpath(top.out.trim()).catch(() => folder) : folder }
  } finally { repoLocks.delete(folder) }
}
