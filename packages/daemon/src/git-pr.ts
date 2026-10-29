import { GIT_ACTIONS_MAX_LISTED, GIT_PR_MAX_BASE, GIT_PR_MAX_BODY, GIT_PR_MAX_TITLE, redactSecrets, type GitPrChecks, type GitPrCreateReport, type GitPrInfo, type GitPrPlan, type GitPrView } from "@mendcode/protocol"
import { networkEnv, repoLocks, run } from "./git-exec"
import { GitActionRefusal, commitsIn, inspect, reader, safeRefName, shownMasked } from "./git-remote"
import { FIELDS, parseSnapshot, type Snapshot } from "./pr-watch"

const READ_MS = 30_000
const CREATE_MS = 60_000
/** Subjects in the prefilled body. */
const BODY_COMMITS = 50
const LINK = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d{0,8}$/

export const NO_GH = "gh is not installed or not on PATH"
export const NOT_LOGGED_IN = "gh is not logged in: run gh auth login in your shell"

export const first = (text: string) => shownMasked(text).split("\n").find((line) => line.trim())?.slice(0, 160) ?? ""
export const unauthenticated = (text: string) => /gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i.test(text)

function info(snapshot: Snapshot): GitPrInfo {
  const checks: GitPrChecks = { pass: 0, fail: 0, pending: 0, skip: 0 }
  for (const check of snapshot.checks) checks[check.bucket === "pass" ? "pass" : check.bucket === "fail" ? "fail" : check.bucket === "skip" ? "skip" : "pending"] += 1
  const names = (bucket: string) => snapshot.checks.filter((check) => check.bucket === bucket).slice(0, 5).map((check) => shownMasked(check.name).slice(0, 80))
  return {
    number: snapshot.number, title: shownMasked(snapshot.title).replace(/\n/g, " ").slice(0, 200), url: snapshot.url, state: snapshot.state, draft: snapshot.draft,
    base: shownMasked(snapshot.base).slice(0, 100), head: shownMasked(snapshot.head).slice(0, 100), checks, failing: names("fail"), pending: names("pending"),
    ...(snapshot.review ? { review: snapshot.review } : {}), mergeable: snapshot.mergeable,
  }
}

/** The command lines a user's `permission.bash` rule can match for the read and for the creation. */
export const viewLines = () => ["gh pr view --json " + FIELDS, "gh pr view"]
export const createLines = (plan: Pick<GitPrPlan, "argv" | "base" | "branch">) => [plan.argv.join(" "), `gh pr create --base ${plan.base} --head ${plan.branch}`, "gh pr create"]

/**
 * The pull request of the current branch (`git.pr.view`, docs/git.md): `gh pr view --json …` in the repository, read through the user's own gh login
 * and parsed with the same reader as the PR watch. No pull request is a result (`pr` absent); a missing gh, no login, no remote and a branch that is
 * not usable are one refusing line each.
 */
export async function gitPrView(input: { directory: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; denied?: (lines: string[]) => string | undefined }): Promise<GitPrView> {
  const env = input.env ?? process.env
  const { root, branch } = await inspect({ directory: input.directory, env })
  const rule = input.denied?.(viewLines())
  if (rule) throw new GitActionRefusal(rule, "forbidden")
  const done = await run({ program: "gh", cwd: root, args: ["pr", "view", "--json", FIELDS], env: networkEnv(env), timeoutMs: input.timeoutMs ?? READ_MS, detached: true })
  if (done.code === 127) throw new GitActionRefusal(NO_GH)
  if (done.timedOut) throw new GitActionRefusal("gh timed out")
  if (done.code !== 0) {
    if (/no pull requests? found/i.test(done.err)) return { branch }
    if (unauthenticated(done.err)) throw new GitActionRefusal(NOT_LOGGED_IN)
    throw new GitActionRefusal(`gh could not read the pull request: ${first(done.err) || `exit ${done.code}`}`)
  }
  const snapshot = parseSnapshot(redactSecrets(done.out).text)
  if (!snapshot) throw new GitActionRefusal("gh returned something that is not a pull request")
  return { branch, pr: info(snapshot) }
}

/** One line, no control characters. */
const plainLine = (text: string) => !/[\u0000-\u001f\u007f-\u009f]/.test(text)

/**
 * Creates the pull request of the current branch (`git.pr.create`, docs/git.md): `gh pr create --base B --head BRANCH --title=T --body-file - [--draft]`
 * with the body on standard input. Title and body are text for gh, never a shell string. The branch must already be on its upstream and level with it:
 * a branch that is not is refused with what to push first, and nothing is pushed here. Base defaults to the remote's default branch. With `preview`
 * nothing runs; the plan carries the prefill from the commits since the merge-base with the base.
 */
export async function gitPrCreate(input: { directory: string; title?: string; body?: string; base?: string; draft?: boolean; preview?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number; denied?: (lines: string[]) => string | undefined }): Promise<GitPrCreateReport> {
  const env = input.env ?? process.env
  const state = await inspect({ directory: input.directory, env })
  const { root, branch, remote } = state
  const base = (input.base ?? "").trim() || state.defaultBranch || ""
  if (base && (!safeRefName(base) || base.length > GIT_PR_MAX_BASE)) throw new GitActionRefusal(`the base branch ${JSON.stringify(shownMasked(base).slice(0, 60))} cannot be used from the page`)
  if (base === branch) throw new GitActionRefusal(`${branch} is the base branch: switch to the branch the changes are on`)

  const read = reader(root, env)
  const known = base ? (await read(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${base}`])).code === 0 : false
  const since = known ? await commitsIn(read, [`refs/remotes/${remote}/${base}..HEAD`], BODY_COMMITS, true) : { commits: [], total: 0 }
  const defaults = {
    title: since.commits.length === 1 ? since.commits[0]!.subject : branch,
    body: since.commits.map((commit) => `- ${commit.subject}`).join("\n"),
  }
  const title = (input.title ?? defaults.title).trim()
  const body = (input.body ?? defaults.body).replace(/\r\n?/g, "\n").trim()
  const draft = input.draft === true
  const argv = ["gh", "pr", "create", "--base", base, "--head", branch, `--title=${title}`, "--body-file", "-", ...(draft ? ["--draft"] : [])]
  const pushNote = state.upstream === undefined ? `${branch} is not on ${remote} yet`
    : state.ahead > 0 ? `${state.ahead} ${state.ahead === 1 ? "commit is" : "commits are"} not on ${remote}/${branch}`
    : state.behind > 0 ? `${remote}/${branch} has ${state.behind} ${state.behind === 1 ? "commit" : "commits"} this branch lacks: update the branch first` : undefined
  const listed = since.commits.slice(-GIT_ACTIONS_MAX_LISTED)
  const plan: GitPrPlan = {
    root, branch, remote, url: state.url, base, argv, title, body, draft, defaults, commits: listed, commitsTotal: Math.max(since.total, since.commits.length),
    pushed: pushNote === undefined, ...(pushNote ? { pushNote } : {}),
  }
  const rule = base ? input.denied?.(createLines(plan)) : undefined
  if (rule) throw new GitActionRefusal(rule, "forbidden")
  if (input.preview) return { plan, created: false }

  if (!base) throw new GitActionRefusal("cannot tell the base branch: type it")
  if (!title) throw new GitActionRefusal("empty title")
  if (title.length > GIT_PR_MAX_TITLE) throw new GitActionRefusal(`the title is too long (${GIT_PR_MAX_TITLE} characters at most)`)
  if (!plainLine(title)) throw new GitActionRefusal("the title must be one line of text")
  if (body.length > GIT_PR_MAX_BODY || body.includes("\0")) throw new GitActionRefusal("the body is invalid or too long")
  if (pushNote) throw new GitActionRefusal(`push first: ${pushNote}`)
  if (repoLocks.has(root)) throw new GitActionRefusal("another commit, push or pull request is running in this repository")
  repoLocks.add(root)
  try {
    const limit = input.timeoutMs ?? CREATE_MS
    const done = await run({ program: "gh", cwd: root, args: argv.slice(1), env: networkEnv(env), timeoutMs: limit, stdin: body, detached: true })
    if (done.code === 127) throw new GitActionRefusal(NO_GH)
    const text = shownMasked(`${done.out}\n${done.err}`)
    if (done.timedOut) throw new GitActionRefusal(`gh timed out after ${Math.round(limit / 1000)}s${text ? `\n${text}` : ""}`)
    if (done.code !== 0) throw new GitActionRefusal(unauthenticated(done.err) ? NOT_LOGGED_IN : `gh could not create the pull request (exit ${done.code})${text ? `\n${text}` : ""}`)
    const url = done.out.split("\n").map((line) => line.trim()).findLast((line) => LINK.test(line))
    return { plan, created: true, ...(url ? { url, number: Number(url.slice(url.lastIndexOf("/") + 1)) } : {}) }
  } finally { repoLocks.delete(root) }
}
