import { GIT_ACTIONS_MAX_LISTED, type GitPushPlan, type GitPushReport } from "@mendcode/protocol"
import { TIMEOUT_MS, git, networkEnv, repoLocks, run } from "./git-exec"
import { GitActionRefusal, commitsIn, inspect, reader, shownMasked } from "./git-remote"

/** Branches the page treats as protected whatever the remote says: pushing one needs its name typed. */
const PROTECTED = ["main", "master"]
const REJECTED = /\[(remote )?rejected\]|non-fast-forward|fetch first|stale info/i

/** Words of the push a user's `permission.bash` rule can match, from the full command to the plain one: a rule written for `git push origin main` must see it too. */
export function pushLines(plan: Pick<GitPushPlan, "argv" | "remote" | "branch" | "setUpstream">) {
  return [plan.argv.join(" "), `git push${plan.setUpstream ? " -u" : ""} ${plan.remote} ${plan.branch}`, `git push ${plan.remote} ${plan.branch}`, "git push"]
}

/**
 * The push the Git page asks for (`git.push`, docs/git.md): `git push [-u] <remote> <branch>` for the current branch and nothing else. The remote is the
 * branch's own or `origin`; names that could be read as options or refspecs are refused first. It is never forced (`--force`, `--force-with-lease`), never
 * pushes tags, all branches, a mirror, a deletion or a refspec of its own; the flags it does pass only make sure that git's configuration cannot add tags or
 * submodules to it. A rejected push is shown as git printed it. The user's own credentials answer; if git would have to ask for one, the push fails instead.
 * With `preview` nothing runs. `denied` names the user's permission rule that forbids one of the command lines, if any.
 */
export async function gitPush(input: { directory: string; confirm?: string; preview?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number; denied?: (lines: string[]) => string | undefined }): Promise<GitPushReport> {
  const env = input.env ?? process.env
  const state = await inspect({ directory: input.directory, env })
  const { root, branch, remote } = state
  const setUpstream = state.upstream === undefined
  if (!setUpstream && state.ahead === 0) throw new GitActionRefusal(`nothing to push: ${remote}/${branch} has every commit of ${branch} as far as this machine knows`)
  if (setUpstream && state.ahead === 0) throw new GitActionRefusal(`nothing to push: ${branch} has no commit that ${remote} lacks`)
  const range = setUpstream ? ["HEAD", "--not", `--remotes=${remote}`] : [`refs/remotes/${remote}/${branch}..HEAD`]
  const sent = await commitsIn(reader(root, env), range, GIT_ACTIONS_MAX_LISTED)
  const argv = ["git", "push", "--no-recurse-submodules", "--no-follow-tags", ...(setUpstream ? ["-u"] : []), remote, branch]
  const plan: GitPushPlan = {
    root, branch, remote, url: state.url, argv, setUpstream,
    ...(state.upstream ? { upstream: `${remote}/${state.upstream}` } : {}),
    commits: sent.commits, commitsTotal: Math.max(sent.total, state.ahead), behind: state.behind,
    protected: PROTECTED.includes(branch) || branch === state.defaultBranch, hooks: state.hooks,
  }
  const rule = input.denied?.(pushLines(plan))
  if (rule) throw new GitActionRefusal(rule, "forbidden")
  if (input.preview) return { plan, pushed: false }

  if (plan.protected && input.confirm !== branch) throw new GitActionRefusal(`${branch} is protected here: type its name to confirm the push`)
  if (repoLocks.has(root)) throw new GitActionRefusal("another commit, push or pull request is running in this repository")
  repoLocks.add(root)
  try {
    const limit = input.timeoutMs ?? TIMEOUT_MS
    const pushEnv = await sshBatch(root, env)
    const done = await run({ program: "git", cwd: root, args: argv.slice(1), env: networkEnv(pushEnv), timeoutMs: limit, detached: true })
    const text = shownMasked(`${done.out}\n${done.err}`)
    if (done.timedOut) throw new GitActionRefusal(`push timed out after ${Math.round(limit / 1000)}s${text ? `\n${text}` : ""}`)
    if (done.code === 127) throw new GitActionRefusal("git is not installed or not on PATH")
    if (done.code !== 0) throw new GitActionRefusal(`${REJECTED.test(text) ? "push rejected · the page never forces, so update the branch and push again" : `push failed (exit ${done.code})`}${text ? `\n${text}` : ""}`)
    return { plan, pushed: true, ...(text ? { output: text } : {}) }
  } finally { repoLocks.delete(root) }
}

/** The environment with ssh told not to ask anything, unless the user already chose how git runs ssh. */
async function sshBatch(root: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (env.GIT_SSH_COMMAND || env.GIT_SSH) return env
  const configured = await git({ cwd: root, args: ["config", "--get", "core.sshCommand"], env })
  return configured.code === 0 && configured.out.trim() ? env : { ...env, GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }
}
