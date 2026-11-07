import { PrReviewDashboard, type PrJobSummary, type PrReviewerSummary, type PrTokenUsage } from "@mendcode/protocol"
import type { JobState, ReviewJob } from "./contracts"

/**
 * The TUI's reviews page data (`pr.review` action `status`, docs/pr-review.md): the watches, the reviewers and the newest jobs of
 * the ledger as `PrReviewDashboard`. Pure: the caller reads the ledgers and passes them in. Every metric is a count or a sum over
 * the job ledger; nothing is estimated, and a number the ledger does not hold is left out rather than guessed.
 */

export const DASHBOARD_MAX_JOBS = 500
export const DASHBOARD_MAX_WATCHES = 50
export const DASHBOARD_MAX_REVIEWERS = 200
const DAY_MS = 24 * 60 * 60 * 1000

/** States a job is still moving in; they are listed before any finished job when the ledger holds more than the page shows. */
const LIVE_STATES: ReadonlySet<JobState> = new Set(["pending", "waiting", "running", "fixing", "validating", "checkpointed", "paused"])
const RUNNING_STATES: ReadonlySet<JobState> = new Set(["running", "fixing", "validating"])

/** A watch as the repo watch lists it (`rows()`), plus what the platform knows about it. `provider` defaults to GitHub. */
export type DashboardWatchInput = {
  directory: string
  repo?: string | undefined
  provider?: PrJobSummary["provider"] | undefined
  state: string
  open: number
  publish: string
  owner?: string | undefined
}

export type DashboardInput = {
  jobs: readonly ReviewJob[]
  watches: readonly DashboardWatchInput[]
  reviewers: readonly PrReviewerSummary[]
  now: number
  /** How many jobs may run at once (the scheduler's setting). */
  concurrency: number
}

const cut = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text)
const cutOptional = (text: string | undefined, max: number) => (text === undefined ? undefined : cut(text, max))

/**
 * Findings as the checkpoint holds them. `resolved` counts confirmed findings that a fix round no longer lists as open (the last
 * round's `open` ids); without a fix round nothing is resolved. Counts are what was found, not a measure of the review's quality.
 */
export function findingCounts(job: Pick<ReviewJob, "checkpoint">): PrJobSummary["findings"] {
  const { verified, candidates, rounds } = job.checkpoint
  const confirmed = verified.filter((finding) => finding.verdict === "confirmed")
  const plausible = verified.filter((finding) => finding.verdict === "plausible").length
  const lastOpen = rounds.at(-1)?.open
  const open = lastOpen ? new Set(lastOpen) : undefined
  const resolved = open ? confirmed.filter((finding) => !open.has(finding.id)).length : 0
  const blocking = confirmed.filter((finding) => (finding.severity === "critical" || finding.severity === "major") && (!open || open.has(finding.id))).length
  return { confirmed: confirmed.length, plausible, candidates: candidates.length, resolved, ...(blocking ? { blocking } : {}) }
}

/** One ledger job as the page shows it: `sessionId` is the review session (not the watch's), strings cut to the protocol's bounds. */
export function jobSummary(job: ReviewJob): PrJobSummary {
  const title = cutOptional(job.title, 300)
  const url = cutOptional(job.url, 500)
  const assignment = cutOptional(job.assignment, 400)
  const phase = cutOptional(job.checkpoint.phase, 60)
  const owner = cutOptional(job.owner, 120)
  const sessionId = cutOptional(job.reviewSessionId, 120)
  const fixSessionId = cutOptional(job.fixSessionId, 120)
  const error = cutOptional(job.error, 600)
  return {
    id: cut(job.id, 80),
    provider: job.provider,
    repo: cut(job.repo, 200),
    number: job.number,
    reviewer: cut(job.reviewer, 120),
    scope: job.scope,
    trigger: job.trigger,
    state: job.state,
    coverage: job.coverage,
    base: cut(job.base, 64),
    head: cut(job.head, 64),
    attempts: job.attempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    findings: findingCounts(job),
    tokens: job.tokens,
    ...(job.readTokens ? { readTokens: job.readTokens } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(assignment !== undefined ? { assignment } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(fixSessionId !== undefined ? { fixSessionId } : {}),
    ...(job.control ? { control: job.control } : {}),
    ...(job.stop ? { stop: job.stop } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(job.stack ? { stack: { ...job.stack, children: job.stack.children.slice(0, 50) } } : {}),
    ...(job.checkpoint.completedPhases.length ? { completedPhases: job.checkpoint.completedPhases.slice(0, 50).map((phase) => cut(phase, 60)) } : {}),
    ...(job.checkpoint.decisions.length ? { decisions: job.checkpoint.decisions.slice(-20).map((decision) => ({ phase: cut(decision.phase, 60), action: decision.action, reason: cut(decision.reason, 600) })) } : {}),
  }
}

/** Live jobs first (all of them while they fit), then the newest finished ones; at most `max`, newest first within each group. */
export function newestJobs(jobs: readonly ReviewJob[], max = DASHBOARD_MAX_JOBS): ReviewJob[] {
  const newest = (a: ReviewJob, b: ReviewJob) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt
  const live = jobs.filter((job) => LIVE_STATES.has(job.state)).sort(newest)
  const finished = jobs.filter((job) => !LIVE_STATES.has(job.state)).sort(newest)
  return [...live, ...finished].slice(0, max)
}

/**
 * Tokens of the jobs updated in the last 24 hours (each job's whole total: the ledger keeps no per-call times). `cached` and
 * `unreported` appear only when some job reported them, so an absent value never reads as zero.
 */
export function tokensSince(jobs: readonly ReviewJob[], since: number): PrTokenUsage {
  const total: PrTokenUsage = { input: 0, output: 0 }
  for (const job of jobs) {
    if (job.updatedAt < since) continue
    total.input += job.tokens.input
    total.output += job.tokens.output
    if (job.tokens.cached !== undefined) total.cached = (total.cached ?? 0) + job.tokens.cached
    if (job.tokens.unreported !== undefined) total.unreported = (total.unreported ?? 0) + job.tokens.unreported
  }
  return total
}

export function dashboardMetrics(jobs: readonly ReviewJob[], now: number, concurrency: number): PrReviewDashboard["metrics"] {
  const since = now - DAY_MS
  const count = (match: (job: ReviewJob) => boolean) => jobs.reduce((sum, job) => sum + (match(job) ? 1 : 0), 0)
  return {
    running: count((job) => RUNNING_STATES.has(job.state)),
    queued: count((job) => job.state === "pending"),
    waiting: count((job) => job.state === "waiting"),
    done24h: count((job) => job.state === "done" && job.updatedAt >= since),
    failed24h: count((job) => job.state === "failed" && job.updatedAt >= since),
    tokens24h: tokensSince(jobs, since),
    concurrency,
  }
}

/** Throws `RangeError` for a concurrency under 1 and the schema's error for a ledger row the protocol refuses. */
export function buildDashboard({ jobs, watches, reviewers, now, concurrency }: DashboardInput): PrReviewDashboard {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError(`[PR_REVIEW]: concurrency must be a positive integer, got ${concurrency}`)
  const dashboard: PrReviewDashboard = {
    updatedAt: Math.trunc(now),
    watches: watches.slice(0, DASHBOARD_MAX_WATCHES).map((watch) => ({
      directory: cut(watch.directory, 4096),
      ...(watch.repo ? { repo: cut(watch.repo, 200) } : {}),
      provider: watch.provider ?? "github",
      state: cut(watch.state, 120),
      open: Math.max(0, Math.trunc(watch.open)),
      publish: cut(watch.publish, 40),
      ...(watch.owner ? { owner: cut(watch.owner, 120) } : {}),
    })),
    reviewers: reviewers.slice(0, DASHBOARD_MAX_REVIEWERS).map((reviewer) => ({ ...reviewer })),
    jobs: newestJobs(jobs).map(jobSummary),
    metrics: dashboardMetrics(jobs, now, concurrency),
  }
  return PrReviewDashboard.parse(dashboard)
}
