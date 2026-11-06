import { PrReviewDashboard, type PrPullRequestState, type PrReviewerSummary, type PrTokenUsage } from "@mendcode/protocol"
import type { ConfigControl, ConfigControlAction } from "./config-control"
import { JOB_TRANSITIONS, type JobState, type PlatformControlInput, type PlatformControlResult, type PlatformHandle, type ReviewJob } from "./contracts"
import { buildDashboard, type DashboardWatchInput } from "./dashboard"
import { holderOf, type release, type takeOver } from "./takeover"

/**
 * The review platform's `pr.review` actions (docs/pr-review.md): `status` (the reviews page), the job actions on `jobId`, the
 * explicit `audit` and the configuration actions on `scope`. service.ts routes these here with its `PlatformHandle`; the watch
 * actions (`watch-repo`, `review`, …) stay in service.ts.
 *
 * Every job action reads the job first and checks the move against `JOB_TRANSITIONS` before touching the ledger, so a refusal
 * names the job's state instead of surfacing a ledger error. A job taken over by the user (takeover.ts) has a single writer: pause,
 * resume and a second take-over are refused with the holder's name, and only `release` gives it back.
 *
 * Directory rule: job actions are not refused for a job of another checkout than the session's. `pr.review` is local-only (the
 * daemon refuses remote and peer clients), every job belongs to this machine's user, and the reviews page lists the jobs of every
 * watch from whichever session it is opened in; refusing there would only break the page. The answer always names the job's
 * repository and PR so the user sees which one moved. Configuration is different: it acts on one checkout, so a `jobId` given
 * with a `config-*` action reads that job's checkout, and `scope` is never guessed.
 */

export type PlatformControlDeps = {
  configControl: ConfigControl
  takeover: { takeOver: typeof takeOver; release: typeof release }
  now?: () => number
  /**
   * Tokens of the last 24 hours from the accounting ledger (`accounting.last24h().tokens`, per-call times). Unset, the page's
   * metric is the job totals of the jobs updated in that window (dashboard.ts).
   */
  tokens24h?: () => PrTokenUsage
  /** How long `status` waits for a checkout's reviewers before answering without them (`REVIEWERS_MS`). */
  reviewersMs?: number
  /** The pull requests' GitHub states (pr-states.ts): `status` with `pullRequests` reads them, every `status` attaches the last read. */
  pullRequests?: {
    fetch(repo: string, directory: string, refresh: boolean): Promise<void>
    cached(repo: string): ReadonlyMap<number, PrPullRequestState> | undefined
  }
  /** How long `status` waits for those reads before answering with what is cached (`PULL_REQUESTS_MS`); a slower read lands in the cache. */
  pullRequestsMs?: number
}

const REVIEWERS_MS = 3_000
const PULL_REQUESTS_MS = 8_000
const THIS_DEVICE = "this device"
/** `promise`'s value, or undefined once `ms` passed first; the timer is cleared either way. */
async function withinTime<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms) })])
  } finally { clearTimeout(timer) }
}

const PLATFORM_ACTIONS = new Set<PlatformControlInput["action"]>(["status", "audit", "job-pause", "job-resume", "job-cancel", "job-retry", "take-over", "release", "config-show", "config-preview", "config-apply", "config-revert", "config-history"])
const CONFIG_ACTIONS = new Set<string>(["config-show", "config-preview", "config-apply", "config-revert", "config-history"])
const RETRYABLE: ReadonlySet<JobState> = new Set(["failed", "cancelled", "stale", "checkpointed"])
const FINISHED: ReadonlySet<JobState> = new Set(["done", "failed", "cancelled", "stale"])

const describe = (job: ReviewJob) => `#${job.number} of ${job.repo} (${job.reviewer} reviewer, job ${job.id})`
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const refuse = (text: string): PlatformControlResult => ({ ok: false, message: text.startsWith("[PR_REVIEW]:") ? text : `[PR_REVIEW]: ${text}` })
const allowed = (from: JobState, to: JobState) => JOB_TRANSITIONS[from].includes(to)

export function createPlatformControl(handle: PlatformHandle, deps: PlatformControlDeps) {
  const now = deps.now ?? Date.now

  /** The job named by `jobId`, or the refusal to answer with. */
  function jobFor(input: PlatformControlInput): { job: ReviewJob } | { refusal: PlatformControlResult } {
    if (!input.jobId) return { refusal: refuse(`${input.action} needs jobId (the reviews page names each job)`) }
    const job = handle.jobs.get(input.jobId)
    return job ? { job } : { refusal: refuse(`no job ${input.jobId}; it may have been pruned from the ledger (terminal jobs keep the newest 500)`) }
  }

  /** A move the ledger allows, with the ledger's own guard as the last word (another writer may have moved it meanwhile). */
  function move(job: ReviewJob, to: JobState, patch: Partial<Omit<ReviewJob, "id" | "state">>): { job: ReviewJob } | { refusal: PlatformControlResult } {
    if (!allowed(job.state, to)) return { refusal: refuse(`${describe(job)} is ${job.state}; it cannot become ${to}`) }
    try {
      return { job: handle.jobs.transition(job.id, to, patch) }
    } catch (error) {
      return { refusal: refuse(`${describe(job)} could not become ${to}: ${message(error)}`) }
    }
  }

  /** Reads each GitHub repository's pull requests once (`fetch` dedupes and caches), waiting at most `pullRequestsMs`. */
  async function readPullRequests(jobs: readonly ReviewJob[], mode: "cached" | "refresh") {
    const source = deps.pullRequests
    if (!source) return
    const repos = new Map<string, string>()
    for (const job of jobs) if (job.provider === "github" && job.coverage !== "audit" && !repos.has(job.repo)) repos.set(job.repo, job.directory)
    const reads = [...repos].slice(0, 50).map(([repo, directory]) => source.fetch(repo, directory, mode === "refresh").catch(() => undefined))
    if (reads.length) await withinTime(Promise.all(reads), deps.pullRequestsMs ?? PULL_REQUESTS_MS)
  }

  function withPullRequests(dashboard: PrReviewDashboard): PrReviewDashboard {
    const source = deps.pullRequests
    if (!source) return dashboard
    return { ...dashboard, jobs: dashboard.jobs.map((job) => {
      const pullRequest = job.provider === "github" && job.coverage !== "audit" ? source.cached(job.repo)?.get(job.number) : undefined
      return pullRequest ? { ...job, pullRequest } : job
    }) }
  }

  async function status(input: PlatformControlInput): Promise<PlatformControlResult> {
    const jobs = handle.jobs.all()
    const pullRequests = input.pullRequests ? readPullRequests(jobs, input.pullRequests) : undefined
    // The repository of a watch from its newest job: no provider call on a page that refreshes every few seconds.
    const repoOf = new Map<string, string>()
    for (const job of [...jobs].sort((a, b) => a.updatedAt - b.updatedAt)) repoOf.set(job.directory, job.repo)
    const watches: DashboardWatchInput[] = handle.rows().map((row) => ({ ...row, ...(repoOf.has(row.directory) ? { repo: repoOf.get(row.directory) } : {}) }))
    const reviewers = new Map<string, PrReviewerSummary>()
    // The reviewers are read from each checkout (git, the forge): one that does not answer in time is left out and named, so the
    // page never waits on a busy checkout or a hung child process for the jobs it already has.
    const directories = [...new Set(watches.map((watch) => watch.directory))]
    const unread: string[] = []
    const listed = await Promise.all(directories.map((directory) => withinTime(handle.reviewers(directory).catch(() => [] as PrReviewerSummary[]), deps.reviewersMs ?? REVIEWERS_MS).then((read) => { if (!read) unread.push(directory); return read ?? [] })))
    for (const reviewer of listed.flat()) if (!reviewers.has(reviewer.id)) reviewers.set(reviewer.id, reviewer)
    let dashboard = buildDashboard({ jobs, watches, reviewers: [...reviewers.values()], now: now(), concurrency: handle.concurrency })
    // This daemon's own device reads as "this device": its id says nothing to the person looking at the page.
    const here = handle.device?.()
    if (here) dashboard = { ...dashboard, jobs: dashboard.jobs.map((job) => job.owner === here ? { ...job, owner: THIS_DEVICE } : job), watches: dashboard.watches.map((watch) => watch.owner === here ? { ...watch, owner: THIS_DEVICE } : watch), reviewers: dashboard.reviewers.map((reviewer) => reviewer.device === here ? { ...reviewer, device: THIS_DEVICE } : reviewer) }
    const tokens = deps.tokens24h?.()
    if (tokens) dashboard = PrReviewDashboard.parse({ ...dashboard, metrics: { ...dashboard.metrics, tokens24h: tokens } })
    await pullRequests
    dashboard = withPullRequests(dashboard)
    const { running, queued, waiting } = dashboard.metrics
    return { ok: true, text: `${dashboard.watches.length} watch${dashboard.watches.length === 1 ? "" : "es"}, ${dashboard.jobs.length} job${dashboard.jobs.length === 1 ? "" : "s"} (${running} running, ${queued} queued, ${waiting} waiting); at most ${dashboard.metrics.concurrency} at once on this device (prReview.concurrency).${unread.length ? ` Reviewers not read yet (the checkout did not answer in time): ${unread.join(", ")}.` : ""}`, dashboard }
  }

  async function pause(input: PlatformControlInput): Promise<PlatformControlResult> {
    const found = jobFor(input)
    if ("refusal" in found) return found.refusal
    const holder = holderOf(found.job)
    if (holder) return refuse(`${describe(found.job)} is taken over by ${holder}; it is already paused and only release gives it back`)
    if (found.job.state === "paused") return refuse(`${describe(found.job)} is already paused; job-resume queues it again`)
    const moved = move(found.job, "paused", { control: "reviewer", stop: { kind: "user", detail: `paused by the user at ${new Date(now()).toISOString()}`, resumable: true } })
    if ("refusal" in moved) return moved.refusal
    return { ok: true, text: `Paused ${describe(moved.job)}. Nothing runs on it until job-resume; a run already in progress stops before its next write.` }
  }

  async function resume(input: PlatformControlInput): Promise<PlatformControlResult> {
    const found = jobFor(input)
    if ("refusal" in found) return found.refusal
    const holder = holderOf(found.job)
    if (holder) return refuse(`${describe(found.job)} is taken over by ${holder}; release it to hand it back to the reviewer`)
    if (found.job.state !== "paused") return refuse(`${describe(found.job)} is ${found.job.state}, not paused${RETRYABLE.has(found.job.state) ? "; job-retry with a reason queues it again" : ""}`)
    const moved = move(found.job, "pending", { stop: undefined, control: "reviewer" })
    if ("refusal" in moved) return moved.refusal
    return { ok: true, text: `Resumed ${describe(moved.job)}: queued${moved.job.checkpoint.candidates.length || moved.job.checkpoint.completedPhases.length ? ", continuing from its checkpoint" : ""}.` }
  }

  async function cancel(input: PlatformControlInput): Promise<PlatformControlResult> {
    const found = jobFor(input)
    if ("refusal" in found) return found.refusal
    if (FINISHED.has(found.job.state)) return refuse(`${describe(found.job)} is already ${found.job.state}; nothing to cancel`)
    const holder = holderOf(found.job)
    const moved = move(found.job, "cancelled", { control: "reviewer", stop: { kind: "user", detail: `cancelled by the user at ${new Date(now()).toISOString()}`, resumable: false } })
    if ("refusal" in moved) return moved.refusal
    return { ok: true, text: `Cancelled ${describe(moved.job)}${holder ? ` (it was taken over by ${holder}; its fix session stays open)` : ""}. Nothing more is posted or pushed for it; job-retry with a reason queues it again.` }
  }

  async function retry(input: PlatformControlInput): Promise<PlatformControlResult> {
    const found = jobFor(input)
    if ("refusal" in found) return found.refusal
    const reason = input.reason?.trim()
    if (!reason) return refuse(`job-retry needs a reason (why ${describe(found.job)} should run again); it is kept with the job`)
    if (!RETRYABLE.has(found.job.state)) return refuse(`${describe(found.job)} is ${found.job.state}; only a failed, cancelled, stale or checkpointed job is retried`)
    const done = await handle.retry(found.job.id, reason).catch((error: unknown) => ({ ok: false as const, message: message(error) }))
    return done.ok ? { ok: true, text: done.text } : refuse(done.message)
  }

  /** Who acts: the provider login of the job's checkout, so a refusal names a person; `user` when it cannot be read. */
  const actor = async (job: ReviewJob) => (await handle.loginOf(job.directory).catch(() => undefined)) ?? "user"

  async function takeOverJob(input: PlatformControlInput): Promise<PlatformControlResult> {
    const found = jobFor(input)
    if ("refusal" in found) return found.refusal
    const by = await actor(found.job)
    const done = deps.takeover.takeOver({ ledger: handle.jobs, jobId: found.job.id, now, by })
    if (!done.ok) return refuse(done.holder ? `${describe(found.job)}: already taken over by ${done.holder}; only they release it` : `${describe(found.job)}: ${done.reason.replace("[PR_REVIEW]: ", "")}`)
    const session = done.job.fixSessionId ?? done.job.reviewSessionId
    return { ok: true, text: `You (${by}) hold ${describe(done.job)} now: it is paused and no automatic fix or push runs on it.${session ? ` Open session ${session} to continue the work.` : ""} release hands it back to the reviewer.` }
  }

  async function releaseJob(input: PlatformControlInput): Promise<PlatformControlResult> {
    const found = jobFor(input)
    if ("refusal" in found) return found.refusal
    const by = await actor(found.job)
    const done = deps.takeover.release({ ledger: handle.jobs, jobId: found.job.id, now, by })
    if (!done.ok) return refuse(done.holder && done.holder !== by ? `${describe(found.job)} is held by ${done.holder}, not ${by}; only the holder releases it` : `${describe(found.job)}: ${done.reason.replace("[PR_REVIEW]: ", "")}`)
    return { ok: true, text: `Released ${describe(done.job)}: the reviewer has it again and it is queued, continuing from its checkpoint.` }
  }

  async function audit(input: PlatformControlInput): Promise<PlatformControlResult> {
    const done = await handle.audit({ sessionId: input.sessionId, directory: input.directory }).catch((error: unknown) => ({ ok: false as const, message: message(error) }))
    return done.ok ? { ok: true, text: done.text } : refuse(done.message)
  }

  async function config(input: PlatformControlInput): Promise<PlatformControlResult> {
    // A job named with a config action reads that job's checkout: the page opens a job's config from any session.
    const job = input.jobId ? handle.jobs.get(input.jobId) : undefined
    if (input.jobId && !job) return refuse(`no job ${input.jobId}`)
    const directory = job?.directory ?? input.directory
    // No scope: config-control answers which targets exist and changes nothing; that answer is the reply, never a guess.
    const done = await deps.configControl.run({ action: input.action as ConfigControlAction, scope: input.scope, directory, patch: input.patch, version: input.version })
    return done.ok ? { ok: true, text: done.text, config: done.config } : { ok: false, message: done.text }
  }

  return {
    async run(input: PlatformControlInput): Promise<PlatformControlResult> {
      if (!PLATFORM_ACTIONS.has(input.action)) return refuse(`${input.action} is not a review platform action`)
      try {
        switch (input.action) {
          case "status": return await status(input)
          case "job-pause": return await pause(input)
          case "job-resume": return await resume(input)
          case "job-cancel": return await cancel(input)
          case "job-retry": return await retry(input)
          case "take-over": return await takeOverJob(input)
          case "release": return await releaseJob(input)
          case "audit": return await audit(input)
          default: return CONFIG_ACTIONS.has(input.action) ? await config(input) : refuse(`${input.action} is not a review platform action`)
        }
      } catch (error) {
        return refuse(message(error))
      }
    },
  }
}
export type PlatformControl = ReturnType<typeof createPlatformControl>
