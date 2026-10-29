import { existsSync } from "node:fs"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { GIT_NO_REMOTE, redactSecrets, type GitCommitLine } from "@mendcode/protocol"
import { git, shown, type Run } from "./git-exec"

/**
 * What the Git page's push and pull request read about the repository before anything leaves the machine (docs/git.md): the branch, the remote it
 * goes to, where that remote points, and how the branch stands against its upstream, all from this machine's own refs (nothing is fetched). A name that
 * could be read as an option or a refspec is refused here, before it reaches an argument list.
 */

/** A reason the action did not happen: one clear line, plus redacted output for a command that failed. */
export class GitActionRefusal extends Error {
  constructor(message: string, readonly code: "invalid_command" | "not_git" | "forbidden" = "invalid_command") { super(`[GIT]: ${message}`) }
}

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi

/** True for a name git may keep and that no argument parser can mistake for something else: no leading dash, no `..`, no `:`, no control characters, spaces or glob characters. */
export const safeRefName = (name: string) => name.length > 0 && name.length <= 255 && !name.startsWith("-") && !name.startsWith("/") && !name.endsWith("/") && !name.endsWith(".") && !name.endsWith(".lock")
  && !name.includes("..") && !name.includes("//") && !name.includes("@{") && name !== "@" && !/[\u0000- \u007f-\u009f:~^?*[\\]/.test(name)

/** A remote's address with credentials masked: `https://user:token@host/x` is `https://***@host/x`. Anything else comes back as it is, after the secret scan. */
export const maskUrl = (url: string) => redactSecrets(url.replace(CREDENTIALS, "$1***@")).text

/** What a failed command printed, with the credentials of any address in it masked as well. */
export const shownMasked = (text: string) => shown(text.replace(CREDENTIALS, "$1***@"))

const label = (name: string) => JSON.stringify(shownMasked(name).slice(0, 60))

export type Inspected = {
  root: string
  branch: string
  remote: string
  /** The push address of the remote, credentials masked. */
  url: string
  /** The upstream branch name on the remote when the branch tracks one that exists here, else undefined. */
  upstream?: string
  /** Commits the branch has that its upstream (or, with none, the remote) does not; commits the upstream has that the branch lacks. */
  ahead: number
  behind: number
  defaultBranch?: string
  hooks: string[]
}

export type Reader = (args: string[]) => Promise<Run>

/** A reader of git in `cwd`: a read that times out is a refusal. */
export function reader(cwd: string, env: NodeJS.ProcessEnv): Reader {
  return async (args) => {
    const done = await git({ cwd, args, env })
    if (done.timedOut) throw new GitActionRefusal(`git ${args[0]} timed out`)
    return done
  }
}

export async function repositoryRoot(directory: string, env: NodeJS.ProcessEnv) {
  const top = await git({ cwd: directory, args: ["rev-parse", "--show-toplevel"], env }).catch(() => undefined)
  if (!top || top.code !== 0 || !top.out.trim()) throw new GitActionRefusal("not a git repository", "not_git")
  return realpath(top.out.trim()).catch(() => { throw new GitActionRefusal("not a git repository", "not_git") })
}

const lines = (run: Run) => run.out.split("\n").map((line) => line.trim()).filter(Boolean)

/** `<hash> <subject>` of the commits in `range`, newest first (or oldest first with `reverse`), at most `limit`; with the total count. */
export async function commitsIn(read: Reader, range: string[], limit: number, reverse = false) {
  const [count, listed] = await Promise.all([
    read(["rev-list", "--count", ...range]),
    read(["log", "--format=%h%x00%s", `--max-count=${limit}`, ...(reverse ? ["--reverse"] : []), ...range]),
  ])
  const commits: GitCommitLine[] = lines(listed).map((line) => {
    const [sha = "", ...subject] = line.split("\0")
    return { sha, subject: shownMasked(subject.join("\0")).replace(/\n/g, " ").slice(0, 200) }
  })
  return { commits, total: count.code === 0 ? Number(count.out.trim()) || 0 : commits.length }
}

export async function inspect(input: { directory: string; env: NodeJS.ProcessEnv }): Promise<Inspected> {
  const { env } = input
  const root = await repositoryRoot(input.directory, env)
  const read = reader(root, env)

  const head = await read(["symbolic-ref", "-q", "--short", "HEAD"])
  if (head.code !== 0 || !head.out.trim()) throw new GitActionRefusal("detached HEAD: switch to a branch first")
  const branch = head.out.trim()
  if (!safeRefName(branch)) throw new GitActionRefusal(`the branch name ${label(branch)} cannot be used from the page: it could be read as an option or a refspec`)
  const valid = await read(["check-ref-format", `refs/heads/${branch}`])
  if (valid.code !== 0) throw new GitActionRefusal(`${label(branch)} is not a valid branch name`)

  const [remotes, configured, merge] = await Promise.all([read(["remote"]), read(["config", "--get", `branch.${branch}.remote`]), read(["config", "--get", `branch.${branch}.merge`])])
  const known = lines(remotes)
  if (known.length === 0) throw new GitActionRefusal(`${GIT_NO_REMOTE}: add one with git remote add origin <url>`)
  const wanted = configured.code === 0 && configured.out.trim() && configured.out.trim() !== "." ? configured.out.trim() : "origin"
  if (!REMOTE_NAME.test(wanted) || wanted.includes("..")) throw new GitActionRefusal(`the remote name ${label(wanted)} cannot be used from the page: it could be read as an option`)
  if (!known.includes(wanted)) throw new GitActionRefusal(configured.code === 0 && wanted !== "origin" ? `the remote ${label(wanted)} of this branch is not configured` : "no remote named origin: add one with git remote add origin <url>")
  const remote = wanted

  const address = await read(["remote", "get-url", "--push", remote])
  if (address.code !== 0 || !address.out.trim()) throw new GitActionRefusal(`the remote ${remote} has no address`)

  let upstream: string | undefined
  const tracked = merge.code === 0 ? merge.out.trim().replace(/^refs\/heads\//, "") : ""
  if (configured.code === 0 && configured.out.trim() === remote && tracked) {
    if (tracked !== branch) throw new GitActionRefusal(`this branch tracks ${remote}/${shownMasked(tracked).slice(0, 60)} under another name: push it from your shell`)
    const ref = await read(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`])
    if (ref.code === 0) upstream = branch
  }
  let ahead = 0
  let behind = 0
  if (upstream) {
    const counts = await read(["rev-list", "--left-right", "--count", `refs/remotes/${remote}/${branch}...HEAD`])
    const [left = "0", right = "0"] = counts.out.trim().split(/\s+/)
    behind = Number(left) || 0
    ahead = Number(right) || 0
  } else {
    const fresh = await read(["rev-list", "--count", "HEAD", "--not", `--remotes=${remote}`])
    ahead = fresh.code === 0 ? Number(fresh.out.trim()) || 0 : 0
  }

  let defaultBranch: string | undefined
  const symbolic = await read(["symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`])
  if (symbolic.code === 0 && symbolic.out.trim().startsWith(`${remote}/`)) defaultBranch = symbolic.out.trim().slice(remote.length + 1)
  for (const guess of defaultBranch ? [] : ["main", "master"]) {
    if ((await read(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${guess}`])).code === 0) { defaultBranch = guess; break }
  }
  if (defaultBranch && !safeRefName(defaultBranch)) defaultBranch = undefined

  const hooksDir = await read(["rev-parse", "--git-path", "hooks"])
  const hooks = hooksDir.code === 0 && existsSync(path.resolve(root, hooksDir.out.trim(), "pre-push")) ? ["pre-push"] : []

  return { root, branch, remote, url: maskUrl(address.out.trim()), ...(upstream ? { upstream } : {}), ahead, behind, ...(defaultBranch ? { defaultBranch } : {}), hooks }
}
