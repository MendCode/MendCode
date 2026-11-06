import type { PrFinding, PrStopReason } from "@mendcode/protocol"
import { DEFAULT_REVIEWER, failureOf, type GhCall, type PublishReport } from "./publish"
import type { ReviewState } from "./state"

/**
 * The commit status a review sets on the pull request's head (docs/pr-review.md, "Commit status"): `pending` when the review of a
 * head starts, then `success` (nothing blocking), `failure` (a critical or major finding open on the head) or `error` (the review
 * stopped before it was complete). A re-review that posts nothing new still sets it, so the head shows it was reviewed, and branch
 * protection can require the context. Only a run that publishes to GitHub sets it (`publish`, `enabled`, `status`). A status that
 * GitHub refuses (a token without `statuses: write`) is dropped quietly, logged once per repository; it never fails a review.
 */

export const STATUS_CONTEXT = "MendCode review"
/** GitHub's limit on a status description. */
export const STATUS_DESCRIPTION_LIMIT = 140
export type CommitState = "pending" | "success" | "failure" | "error"

/** `MendCode review`, or `MendCode review (<id>)` for a reviewer other than the repository's own. */
export const statusContext = (reviewer?: string | undefined) => !reviewer || reviewer === DEFAULT_REVIEWER ? STATUS_CONTEXT : `${STATUS_CONTEXT} (${reviewer})`.slice(0, 255)

const fit = (text: string) => { const line = text.replace(/\s+/g, " ").trim(); return line.length > STATUS_DESCRIPTION_LIMIT ? `${line.slice(0, STATUS_DESCRIPTION_LIMIT - 1)}…` : line }
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
const blocking = (finding: PrFinding) => finding.severity === "critical" || finding.severity === "major"

/** What a finished run looks like to `statusOf`: the parts of run.ts `ReviewRun` it reads. */
export type StatusRun = {
  status: "skipped" | "reviewed" | "published" | "failed"
  reason?: string | undefined
  stop?: PrStopReason | undefined
  stale?: boolean | undefined
  notPublisher?: true | undefined
  report?: PublishReport | undefined
  state: ReviewState
  fixed?: string[] | undefined
  outcome?: { result: { findings: readonly PrFinding[] } } | undefined
}

const PAUSED: Partial<Record<PrStopReason["kind"], string>> = { budget: "Paused at the token budget", quota: "Paused at the provider's quota", rate_limit: "Paused at the provider's rate limit" }

/** The findings open on the head after the run: this run's, plus earlier published ones not resolved and not found fixed. */
function openFindings(run: StatusRun): PrFinding[] {
  const open = new Map<string, PrFinding>()
  const fixed = new Set(run.fixed ?? [])
  for (const [id, entry] of Object.entries(run.state.published)) if (entry.finding && !entry.resolved && !fixed.has(id)) open.set(id, entry.finding)
  for (const finding of run.outcome?.result.findings ?? []) open.set(finding.id, finding)
  return [...open.values()]
}

/** The final status of a run that set `pending`. A stopped, failed or stale run is `error`, never `success`. */
export function statusOf(run: StatusRun): { state: CommitState; description: string } {
  if (run.status === "failed") return { state: "error", description: fit(`Review failed: ${run.reason ?? "unknown error"}`) }
  if (run.stop) return { state: "error", description: fit(PAUSED[run.stop.kind] ?? `Review stopped: ${run.stop.kind === "error" ? run.stop.detail : run.stop.kind.replace(/_/g, " ")}`) }
  if (run.stale) return { state: "error", description: "The head moved before the review was posted" }
  if (run.notPublisher) return { state: "error", description: fit(`Not posted: ${run.reason ?? "another publisher reviewed this head"}`) }
  if (run.status !== "published" && run.status !== "reviewed") return { state: "error", description: fit(`Review not run: ${run.reason ?? run.status}`) }
  const open = openFindings(run)
  const blockers = open.filter(blocking).length
  const nothingNew = !!run.report && !run.report.posted
  if (blockers) return { state: "failure", description: plural(blockers, "blocking finding") }
  if (!open.length) return { state: "success", description: nothingNew ? "No new findings" : "No findings" }
  return { state: "success", description: `${nothingNew ? "No new findings; " : ""}${plural(open.length, "finding")}, none blocking` }
}

const refusedRepos = new Set<string>()

/** One status POST; false when GitHub refused it (nothing to follow up). Never throws. */
export async function postStatus({ gh, repo, sha, state, description, context, targetUrl }: {
  gh: GhCall; repo: string; sha: string; state: CommitState; description: string; context: string; targetUrl: string
}): Promise<boolean> {
  const body = { state, description: fit(description), context, target_url: targetUrl }
  const done = await gh({ argv: ["api", `repos/${repo}/statuses/${sha}`, "--method", "POST", "--input", "-"], stdin: JSON.stringify(body) })
    .catch((error: unknown) => ({ code: -1, out: "", err: error instanceof Error ? error.message : String(error) }))
  if (done.code === 0) return true
  const refused = failureOf(done) !== "uncertain"
  if (refused && !refusedRepos.has(repo)) {
    refusedRepos.add(repo)
    process.stderr.write(`[PR_REVIEW]: GitHub refused the commit status on ${repo} (${(done.err || done.out).split("\n")[0]?.slice(0, 160) || `exit ${done.code}`}); reviews go on without it (the token needs statuses: write)\n`)
  }
  return !refused
}

/**
 * The status of one run: `start` sets `pending` (once), `finish` the final state, only when `start` ran and GitHub took it.
 * `serverUrl` is the Actions runner's `GITHUB_SERVER_URL` (GitHub Enterprise), else github.com.
 */
export function commitStatus({ gh, repo, number, head, reviewer, serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com" }: {
  gh: GhCall; repo: string; number: number; head: string; reviewer?: string | undefined; serverUrl?: string
}) {
  const context = statusContext(reviewer)
  const pullUrl = `${serverUrl.replace(/\/+$/, "")}/${repo}/pull/${number}`
  let started = false
  let accepted = false
  return {
    async start() {
      if (started) return
      started = true
      accepted = await postStatus({ gh, repo, sha: head, state: "pending", description: "Reviewing…", context, targetUrl: pullUrl })
    },
    async finish(run: StatusRun) {
      if (!started || !accepted) return
      const { state, description } = statusOf(run)
      const reviewId = run.report?.reviewId
      await postStatus({ gh, repo, sha: head, state, description, context, targetUrl: reviewId === undefined ? pullUrl : `${pullUrl}#pullrequestreview-${reviewId}` })
    },
  }
}
