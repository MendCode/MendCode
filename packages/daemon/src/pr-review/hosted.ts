import type { Graph } from "@mendcode/codegraph"
import { GithubContext, type GithubReviewReport } from "@mendcode/protocol"
import { explainFinding, MAINTAINERS_ONLY, parsePrCommand, pausedFromComments, runPrCommand, type CommandComment } from "./commands"
import { gitRun, type GitRun } from "./context"
import { mayRequest, readReviewConfig } from "./config"
import type { ReviewSessionFactory } from "./engine"
import { findingFromComment, type GhCall } from "./publish"
import { reviewNotice, runPrReview, type ReviewRun } from "./run"
import { readPullRequestInfo } from "./pull-request"
import { FINDING_MARKER, stateFromMarkers, type ReviewState } from "./state"

/**
 * `github run --review` (docs/pr-review.md): the hosted-runner Action's review of the event's pull request in the job's checkout,
 * and the answer to a maintainer's `@mendcode` comment. The state comes from GitHub itself (the markers of earlier reviews and
 * replies), so a runner keeps nothing between runs. Only markers written by the token's own identity count: anyone can paste a
 * marker into a comment. A hosted review runs no `checks`, because the job's environment holds the provider key; the verifier is
 * told so. `@mendcode fix` does not run here: the workflow's token can read the repository but not push to it.
 */

export const HOSTED_CHECKS_SKIPPED = "not run: a hosted review runs no checks, because the job's environment holds the provider key"
export const HOSTED_NO_FIX = "`@mendcode fix` does not run in the hosted workflow: its token has `contents: read` and cannot push. Run it from a local MendCode that watches this repository (`/pr watch-repo`)."
/** The identity `GITHUB_TOKEN` writes as. */
export const ACTIONS_BOT = "github-actions[bot]"

export type HostedReviewInput = {
  directory: string
  event: string
  /** `gh` with the job's token; the caller binds the token. */
  gh: GhCall
  sessionFactory: ReviewSessionFactory
  publish: boolean
  mentions?: readonly string[] | undefined
  git?: GitRun
  graph?: () => Promise<Graph | undefined>
}

type Data = Record<string, unknown>
const obj = (value: unknown): Data => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {}
const parse = (text: string): unknown => { try { return JSON.parse(text) } catch { return undefined } }
/** `gh api --paginate --jq '.[]'` output: one JSON value per line. */
const lines = (text: string) => text.split("\n").flatMap((line) => { const value = parse(line); return value === undefined ? [] : [obj(value)] })
const str = (value: unknown) => typeof value === "string" ? value : undefined

/** Whether `body` asks MendCode for a review: a configured mention followed by `review`. */
export const asksForReview = (body: string, mentions: readonly string[] = ["@mendcode"]) => parsePrCommand(body, mentions)?.kind === "review"

/** The identities whose markers count: the Actions bot, and the token's user when `gh api user` names one (a personal token). */
async function trustedAuthors(gh: GhCall) {
  const authors = new Set([ACTIONS_BOT])
  const user = await gh({ argv: ["api", "user", "--jq", ".login"] }).catch(() => ({ code: 1, out: "" }))
  if (user.code === 0 && /^[A-Za-z0-9-]{1,39}(\[bot\])?$/.test(user.out.trim())) authors.add(user.out.trim())
  return authors
}

/** The review state as GitHub shows it: each published finding read back from its comment, and the newest pause or resume. */
export async function stateFromGithub({ gh, repo, number }: { gh: GhCall; repo: string; number: number }): Promise<ReviewState> {
  const authors = await trustedAuthors(gh)
  const list = async (endpoint: string) => {
    const done = await gh({ argv: ["api", `${endpoint}?per_page=100`, "--paginate", "--jq", ".[]"] })
    if (done.code !== 0) throw new Error(`[PR_REVIEW]: gh could not list ${endpoint}`)
    return lines(done.out).filter((item) => authors.has(String(obj(item.user).login ?? "")))
  }
  const reviews = await list(`repos/${repo}/pulls/${number}/reviews`)
  const comments = await list(`repos/${repo}/pulls/${number}/comments`)
  const replies = await list(`repos/${repo}/issues/${number}/comments`)
  const typed = comments.map((comment) => ({ id: typeof comment.id === "number" ? comment.id : undefined, body: str(comment.body) ?? "", path: str(comment.path), line: typeof comment.line === "number" ? comment.line : null }))
  const state = stateFromMarkers({ reviews: reviews.map((review) => ({ body: str(review.body) ?? "", submitted_at: str(review.submitted_at) ?? "" })), comments: typed.map(({ id, path, ...rest }) => ({ ...(id === undefined ? {} : { id }), ...(path === undefined ? {} : { path }), ...rest })) })
  for (const comment of typed) {
    const id = FINDING_MARKER.exec(comment.body)?.[1]
    const entry = id ? state.published[id] : undefined
    if (!id || !entry || entry.finding) continue
    const finding = findingFromComment({ id, body: comment.body, path: comment.path, line: comment.line })
    if (finding) entry.finding = finding
  }
  const paused = pausedFromComments([...replies, ...comments].map((item) => ({ body: str(item.body) ?? "", created_at: str(item.created_at) ?? "" })))
  return paused ? { ...state, paused } : state
}

export async function hostedReview(input: HostedReviewInput): Promise<GithubReviewReport> {
  const git = input.git ?? gitRun
  let event: GithubContext
  try { event = GithubContext.parse(JSON.parse(input.event)) } catch { throw new Error("[PR_REVIEW]: invalid or unsupported GitHub event") }
  const repo = `${event.repo.owner}/${event.repo.repo}`
  const skipped = (reason: string, number?: number): GithubReviewReport => ({ repository: repo, ...(number ? { number } : {}), status: "skipped", reason, text: `MendCode review skipped: ${reason}.`, posted: false, comments: 0 })
  const comment = event.eventName === "issue_comment" || event.eventName === "pull_request_review_comment"
  const number = event.eventName === "pull_request" ? event.payload.pull_request?.number : comment && (event.eventName === "pull_request_review_comment" || event.payload.issue?.pull_request) ? event.payload.pull_request?.number ?? event.payload.issue?.number : undefined
  if (!number) throw new Error("[PR_REVIEW]: github run --review needs a pull_request event or a comment on a pull request")
  const viewed = await input.gh({ argv: ["api", `repos/${repo}/pulls/${number}`] })
  const pr = obj(parse(viewed.out))
  const head = String(obj(pr.head).sha ?? ""), base = String(obj(pr.base).sha ?? "")
  if (viewed.code !== 0 || !/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(base)) throw new Error(`[PR_REVIEW]: gh could not read pull request #${number}`)
  const ensureCommits = async () => { for (const sha of [base, head]) if ((await git(["cat-file", "-e", `${sha}^{commit}`], input.directory)).code !== 0) throw new Error(`[PR_REVIEW]: the checkout lacks ${sha.slice(0, 12)}; check out the pull request with fetch-depth: 0`) }

  async function reviewNow(full: boolean, state?: ReviewState): Promise<ReviewRun> {
    await ensureCommits()
    return runPrReview({
      repo, number: number!, directory: input.directory, base, head, state: state ?? await stateFromGithub({ gh: input.gh, repo, number: number! }), git, gh: input.gh, publish: input.publish, sessionFactory: input.sessionFactory,
      force: true, full,
      pullRequest: await readPullRequestInfo({ gh: input.gh, repo, title: typeof pr.title === "string" ? pr.title : "", body: typeof pr.body === "string" ? pr.body : "" }),
      checks: async (_directory, commands) => commands.map((command) => ({ command, code: -1, output: HOSTED_CHECKS_SKIPPED })),
      ...(input.graph ? { graph: input.graph } : {}),
    })
  }
  const report = (run: ReviewRun): GithubReviewReport => ({
    repository: repo, number, status: run.status, ...(run.reason ? { reason: run.reason } : {}),
    text: reviewNotice({ repo, number, run }), posted: run.report?.posted ?? false, comments: run.report?.comments ?? 0,
    ...(run.outcome ? { tokens: run.outcome.result.tokens } : {}),
  })

  if (!comment) {
    await ensureCommits()
    const { config } = await readReviewConfig({ directory: input.directory, base, head, git })
    const action = typeof event.payload.action === "string" ? event.payload.action : "opened"
    if (pr.draft === true && !config.triggers.drafts) return skipped("the pull request is a draft (triggers.drafts is off)", number)
    if ((action === "opened" || action === "synchronize" || action === "ready_for_review") && !config.triggers[action]) return skipped(`triggers.${action} is off in .mendcode/review.yaml`, number)
    return report(await reviewNow(false))
  }

  const body = event.payload.comment?.body ?? ""
  const command = parsePrCommand(body, input.mentions)
  // A comment addressed to one developer's reviewer (`@mendcode review @alice`) is theirs to answer, not the repository's workflow.
  if (command?.target) return skipped(`the comment is addressed to @${command.target}'s reviewer`, number)
  if (!command) return skipped("the comment holds no @mendcode command", number)
  if (!event.actor) return skipped("the comment event names no actor", number)
  // `reviewers` as a list on the base branch is the team that may ask; anyone else's comment is not answered at all. A checkout
  // without the base commit has no list to read, and the command's own write-access check still applies.
  const policy = await ensureCommits().then(() => readReviewConfig({ directory: input.directory, base, head: base, git })).then(({ config }) => config, () => undefined)
  if (policy && !mayRequest(policy.reviewers, event.actor)) return skipped(`@${event.actor} is not in reviewers of .mendcode/review.yaml`, number)
  const raw = obj(event.payload.comment)
  const target: CommandComment = {
    id: event.payload.comment!.id, surface: event.eventName === "pull_request_review_comment" ? "review" : "issue", actor: event.actor, body,
    ...(typeof raw.in_reply_to_id === "number" ? { inReplyTo: raw.in_reply_to_id } : {}),
    ...(str(raw.diff_hunk) ? { diffHunk: str(raw.diff_hunk) } : {}),
  }
  const state = await stateFromGithub({ gh: input.gh, repo, number })
  let reviewed: ReviewRun | undefined
  const outcome = await runPrCommand(command, {
    gh: input.gh, repo, number, comment: target, state,
    review: async () => { reviewed = await reviewNow(true, state); return { status: reviewed.status, reason: reviewed.reason, posted: reviewed.report?.posted ?? false } },
    explain: (question) => explainFinding({ sessionFactory: input.sessionFactory, ...question }),
    fixUnavailable: HOSTED_NO_FIX,
    fixesAllowed: async () => false,
    pushable: async () => false,
  })
  if (outcome.kind === "denied") return { ...skipped(`${event.actor} has no write access; ${MAINTAINERS_ONLY.toLowerCase()}`, number), command: command.kind, posted: outcome.posted }
  if (reviewed) return { ...report(reviewed), command: command.kind }
  return { repository: repo, number, status: "answered", command: command.kind, text: outcome.reply ?? "", posted: outcome.posted, comments: 0 }
}
