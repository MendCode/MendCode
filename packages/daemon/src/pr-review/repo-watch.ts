import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { NO_GH } from "../git-pr"
import { ghProcess, WATCH_INTERVAL_MS, type GhRun } from "../pr-watch"
import { backlogText, type BacklogPlan } from "./backlog"
import { parsePrCommand, type CommandComment, type PrCommand } from "./commands"
import type { JobLedger, JobState, JobTrigger, PrFacts, ReviewerScope, ReviewJob, ReviewProvider } from "./contracts"
import { createJobLedger, MAX_JOB_ATTEMPTS, nextAttemptAt, TRANSIENT_RETRY_WINDOW_MS, transientRetryAt } from "./jobs"
import { clockMark, elapsed, failureKind, OUTAGE_LIMIT_MS, outageGap, type ClockMark } from "./outage"

/**
 * The repo watch (docs/pr-review.md): the daemon lists a repository's open pull requests through the user's own `gh` about once a
 * minute and queues a review only for a PR it has not seen or a head that moved, so an idle repository costs no model call. At most
 * `concurrency` (default two) reviews and commands run at once per daemon; the rest wait in order. PRs already open when the watch starts are the baseline (`/pr review
 * N` reviews one of them), except, with the platform, the backlog: at the start (whose first listing runs at once, so the answer
 * says what it queued) and at every catch-up, open PRs whose current head has no MendCode review yet are queued (`backlog`, bounded
 * by the repo config's `backlog`; backlog.ts). Drafts wait until they are ready unless the repo config's `triggers.drafts` says otherwise. A missing or
 * logged-out `gh` pauses the watch with one notice; it tries again every 5 minutes (and at the daemon's first tick) and resumes by
 * itself, keeping what it saw, so the PRs, pushes and comments of the pause are read then. A listing that fails otherwise backs off
 * (one interval, doubling, at most 15 minutes) and counts its failing time awake (outage.ts): a network or forge outage, or a laptop
 * asleep, never ends the watch; it resumes by itself and reads what it missed. Only a permanent error (the repository gone, access
 * revoked) for 15 awake minutes ends it.
 *
 * Two limits keep a busy repository from spending without end (`cooldown` in the repo config): a PR is reviewed again only after
 * `pr_minutes`, and then once, at its newest head; and a repository starts at most `repo_per_hour` automatic reviews. A watch has a
 * role: `all` reviews every PR (one reviewer for the repository), `requested` only a PR that requests a review from, or is assigned
 * to, this daemon's own `gh` login, or that the platform routes to that login's personal reviewer by area or label (each
 * developer's own reviewer; never the global reviewer's work). Being requested is a trigger of its own.
 *
 * Reviews are durable jobs (`jobs.ts`, `<dataDir>/pr-review/jobs.json`), not an in-memory queue: a daemon that stops while a
 * review runs or waits finds it at the next start (`recover`, the interrupted attempt counted) and runs it once. The same PR and
 * head is never queued twice; a listing older than one already read (out of order) changes nothing; a push while a job of the PR
 * runs marks that job `superseded` (it ends `stale`, and `isCurrent` tells the publisher not to post it) and queues the new head.
 * A job that fails is retried with exponential backoff and full jitter, up to `MAX_JOB_ATTEMPTS`, then it is `failed` with its
 * error; one that fails on a transient error (the network, the forge's servers, a sleep during the attempt) waits and retries
 * without spending an attempt, for up to 24 hours. `@mendcode` commands stay durable in watches.json, as before, and share the same concurrency cap.
 *
 * Catch-up never relies on a missed event: each poll lists every open PR (`gh pr list` paginates GraphQL itself, up to
 * `MAX_OPEN_PRS`) and compares it with what the watch kept, so after a pause or downtime the PRs opened, the heads pushed and the
 * reviews requested meanwhile are this poll's events. Conditional requests (ETag/304) are not used: `gh pr list` is GraphQL, which
 * has none, and `gh api -i --paginate` interleaves every page's headers with the body and exits non-zero on a 304, so a cheap
 * "unchanged" could not be told from an error cleanly; an idle poll is three requests a minute, far under the hourly limit.
 * watches.json is written only when its content changed, so an idle poll writes nothing.
 *
 * With a platform (`plan`, service.ts) each listing is decided once more before anything is queued: every PR event goes through
 * eligibility and routing (`decide`), which name the reviewers of this daemon that take it, one job each, with the reason on the
 * job; an event refused there keeps its reason on the PR (`skipped`, shown by `/pr list`) instead of a notice per PR. `extra`
 * adds PRs without an event of their own: a stack whose parent moved (`stack`) and, at a watch's start or resume, the work a
 * personal reviewer finds from the provider's current state (`requested`). Cooldowns apply to those as to any event. An assignment
 * marked `waiting` (a personal reviewer whose MendCode is another daemon) is recorded as a `waiting` job with its reason and never
 * started here: offline is not failure, and that daemon finds the work from the provider when it runs.
 */

/** What started a review: the watch's own events, `/pr review` (`manual`), or another front's (routing, stacks, a recovery). */
/** `comment`: a maintainer's `@mendcode review` kept for the PR's next head (`askNext`). */
export type ReviewTrigger = JobTrigger
/**
 * Who reviews one PR event (the platform's routing): one job per assignment. `waiting` is an assignment this daemon only records:
 * a personal reviewer whose MendCode runs elsewhere (another login's daemon, a device it is pinned to, another device's claim). Its
 * job is kept `waiting` with that reason, never started here, and never counted against the cooldowns; with `notBefore` (a claim's
 * expiry) it is started then and settles its claim again. `covers`: a global reviewer's job that stands in for these personal
 * reviewers (`routing.offline_fallback`); it waits until `notBefore` like a claim's expiry.
 */
export type ReviewAssignment = { reviewer: string; scope: ReviewerScope; assignment?: string | undefined; owner?: string | undefined; stack?: ReviewJob["stack"]; waiting?: string | undefined; notBefore?: number | undefined; covers?: string[] | undefined }
/** Between the reason a job waits and the routing reason in a job's `assignment`, so a later wait replaces only the first part. */
const WAITING_SEPARATOR = " · assigned: "
/** The routing reason of a job's `assignment`, without the reason it waited for. */
export const routingReason = (assignment: string | undefined) => {
  const at = assignment?.indexOf(WAITING_SEPARATOR) ?? -1
  return assignment !== undefined && at >= 0 ? assignment.slice(at + WAITING_SEPARATOR.length) : assignment
}
/** A job's `assignment` while it waits: the reason first (the page shows it as is), then the routing reason; at most 400 characters. */
export const waitingAssignment = (reason: string, assignment: string | undefined) => {
  const routed = routingReason(assignment)
  return `${reason.slice(0, 300)}${routed ? `${WAITING_SEPARATOR}${routed}` : ""}`.slice(0, 400)
}
/** Whether a PR event is reviewed (eligibility) and by whom (routing); a refusal carries the reason the watch keeps for the PR. */
export type WatchDecision = { ok: false; reason: string } | { ok: true; reason: string; assignments: ReviewAssignment[] }
/**
 * What the platform (service.ts) decides for one successful listing, built once per poll: `decide` gates and routes each PR event,
 * `extra` names PRs to review without an event of their own (a stack whose parent moved, a personal reviewer's offline catch-up).
 */
export type WatchPlan = {
  decide(facts: PrFacts, trigger: ReviewTrigger): Promise<WatchDecision>
  /**
   * `requested`: the PR requests (or is assigned to) the watch's login; `routed`: routing alone gives it to this daemon's reviewer;
   * `backlog`: at a catch-up, its current head has no MendCode review yet (backlog.ts).
   */
  extra: ReadonlyArray<{ number: number; trigger: "stack" | "requested" | "routed" | "backlog"; reason: string }>
  /** A catch-up's backlog: what it queued and what it did not, with the reasons, for the watch's answer or a notice. */
  backlog?: BacklogPlan | undefined
}
export type RepoWatchJob =
  /** `jobId` names the ledger job: the runner checkpoints into it and asks `isCurrent(jobId)` before it publishes. */
  | { kind: "review"; directory: string; sessionId: string; number: number; head: string; trigger: ReviewTrigger; jobId?: string | undefined }
  /** A maintainer's `@mendcode ...` comment on an open PR of the watched repository. */
  | { kind: "command"; directory: string; sessionId: string; number: number; head: string; trigger: "comment"; command: PrCommand; comment: CommandComment; blocked?: CommandBlock | undefined }
/**
 * Why a command could not be answered yet: no `/pr publish on` (`consent`), the repository does not let this login post
 * (`publisher`), or an `@mendcode review` whose job of that head is running already or claimed by another device (`job`): it is
 * offered again at every poll and answered once that job's review is on the pull request.
 */
export type CommandBlock = "consent" | "publisher" | "job"
/**
 * What a job reports back: a command that is `blocked` stays with the watch and is tried again once that can change. A review
 * that reports `error` (or whose `start` rejects) is retried with backoff; `retry: false` fails it at once (nothing a retry fixes).
 */
export type JobOutcome = { blocked?: CommandBlock | undefined; error?: string | undefined; retry?: boolean | undefined } | void
export type RepoTriggers = { opened: boolean; synchronize: boolean; ready_for_review: boolean; drafts: boolean }
export type RepoRole = "all" | "requested"
/** The repo config's limits and role (`cooldown`, `reviewers`); without them nothing is limited and every PR counts. */
export type RepoLimits = { cooldown: { pr_minutes: number; repo_per_hour: number }; reviewers: RepoRole }
const NO_LIMITS: RepoLimits = { cooldown: { pr_minutes: 0, repo_per_hour: Number.MAX_SAFE_INTEGER }, reviewers: "all" }
const HOUR_MS = 3_600_000
/** States a runner works a job in; a job its runner left in any other state was settled by the runner itself. */
const IN_FLIGHT_STATES: readonly JobState[] = ["running", "fixing", "validating"]

const AutoTrigger = z.enum(["opened", "synchronize", "ready_for_review", "requested", "routed", "stack", "comment", "backlog"])
const Seen = z.object({
  head: z.string(), draft: z.boolean(),
  /**
   * A maintainer's `@mendcode review` of a head already reviewed (`head`): the PR's next head is reviewed (trigger `comment`, which
   * the trigger switches and cooldowns do not stop; the filters still hold), once. It goes with the PR when the PR closes.
   */
  asked: z.object({ head: z.string().max(64), by: z.string().max(255), comment: z.number().int(), at: z.number() }).optional(),
  /** This daemon's login is a requested reviewer or an assignee of the PR. */
  requested: z.boolean().optional(),
  /** When its last automatic review started, for `cooldown.pr_minutes`. */
  reviewedAt: z.number().optional(),
  /** A trigger that came during the cooldown or over the hourly limit: the newest head is reviewed once both allow it. */
  waiting: AutoTrigger.optional(),
  /** The PR's `updatedAt` when it was read: a listing older than this one is out of order and changes nothing. */
  updatedAt: z.string().max(40).optional(),
  /** Heads this PR had before (newest last): one of them listed again without a newer `updatedAt` is an out-of-order read. */
  previous: z.array(z.string().max(64)).max(10).optional(),
  /**
   * Why the platform did not review this PR's last event (`plan.decide`: eligibility or routing), kept for `/pr list` instead of a
   * session notice per PR: a repository in `labels` or `on-request` mode skips most PRs, and a notice for each would bury the rest.
   */
  skipped: z.string().max(300).optional(),
})
/** A taken `@mendcode` comment the watch keeps until it is answered: it survives a restart, a full queue and a missing consent. */
const Stored = z.object({
  comment: z.object({ id: z.number().int(), createdAt: z.string().max(40).optional(), surface: z.enum(["issue", "review"]), actor: z.string().max(255), body: z.string().max(100_000), association: z.string().max(40).optional(), inReplyTo: z.number().int().optional(), diffHunk: z.string().max(50_000).optional(), discussion: z.string().max(64).optional(), path: z.string().max(1000).optional(), line: z.number().int().optional() }),
  number: z.number().int().positive(),
  blocked: z.enum(["consent", "publisher", "job"]).optional(),
  /** When it was last handed to a job. */
  triedAt: z.number().optional(),
})
type StoredCommand = z.infer<typeof Stored>
const Watch = z.object({
  directory: z.string(), sessionId: z.string(), createdAt: z.number(),
  seen: z.record(z.string(), Seen).default({}),
  /** Set once the user answered the question before the first post to this repository. */
  publish: z.enum(["allowed", "denied"]).optional(),
  /** The question was asked; it is asked once. */
  asked: z.boolean().optional(),
  /** Why gh cannot list the PRs (missing, logged out); the watch tries again every `PAUSE_RETRY_MS` and resumes by itself. */
  paused: z.string().optional(),
  /** When it paused, for the notice that it resumed. */
  pausedAt: z.number().optional(),
  /** Read only to drop it: watches saved before outages were counted awake (`outage`) kept the wall time of the first failure. */
  unreadableSince: z.number().optional(),
  /**
   * Listings that failed in a row (outage.ts): since when, the awake time they took (sleep does not count), the awake time of the
   * permanent errors among them (only those end a watch), the last reason, when to list again, and whether the session was told.
   */
  outage: z.object({ since: z.number(), awakeMs: z.number(), permanentMs: z.number(), failures: z.number().int(), reason: z.string().max(300), retryAt: z.number(), told: z.boolean().optional() }).optional(),
  ended: z.object({ at: z.number(), reason: z.string() }).optional(),
  /** Comments updated after this ISO time are read for `@mendcode` commands. */
  commentsSince: z.string().max(40).optional(),
  /** Comment ids already read, so a comment edited later is taken once. */
  answered: z.array(z.number().int()).max(200).optional(),
  /** Taken commands not answered yet, oldest first. Missing in a watch saved before they were kept. */
  commands: z.array(Stored).max(100).optional(),
  /** `/pr watch-repo all|requested`; unset, the repo config's `reviewers` decides. */
  role: z.enum(["all", "requested"]).optional(),
  /** This daemon's `gh` login (GitLab, Gitea: the adapter's), read when the watch starts; `requested` matches it. */
  login: z.string().max(255).optional(),
  /** GitLab or Gitea: the watch lists and reads comments through that adapter (`forge`). Unset: GitHub through `gh`. */
  provider: z.enum(["gitlab", "gitea"]).optional(),
  /** Start times of the automatic reviews of the last hour, for `cooldown.repo_per_hour`. */
  starts: z.array(z.number()).max(500).optional(),
  /** When the hourly limit was last reported, so it is said once an hour. */
  limited: z.number().optional(),
  /** `owner/repo`, read from the PRs' URLs: the jobs' repository. */
  repo: z.string().max(200).optional(),
  /** The next successful listing asks the platform for work the provider shows but no event announced (a start, a resume). */
  catchUp: z.boolean().optional(),
})
export type RepoWatchRecord = z.infer<typeof Watch>
const File = z.object({ version: z.literal(1), watches: z.array(z.unknown()) })
/** A user (`login`) or a team (`slug`) in `reviewRequests`, `assignees` or `author`. */
const Who = z.object({ login: z.string().max(100).optional(), slug: z.string().max(100).optional(), is_bot: z.boolean().optional() }).passthrough()
/** One open PR as `gh pr list --json LIST_FIELDS` prints it; only `number` and `headRefOid` are required (older fakes and gh). */
const ListedPr = z.object({
  number: z.number().int().positive(), headRefOid: z.string().regex(/^[0-9a-f]{7,64}$/), isDraft: z.boolean().optional(), updatedAt: z.string().optional(),
  reviewRequests: z.array(Who).optional(), assignees: z.array(Who).optional(),
  title: z.string().optional(), url: z.string().optional(), labels: z.array(z.object({ name: z.string() }).passthrough()).optional(),
  baseRefName: z.string().optional(), baseRefOid: z.string().optional(), headRefName: z.string().optional(),
  author: Who.nullable().optional(), isCrossRepository: z.boolean().optional(), maintainerCanModify: z.boolean().optional(),
})
export type ListedPr = z.infer<typeof ListedPr>
/** One PR as `gh pr view --json` prints it (the listing's fields), validated like a listed one. */
export const parseListedPr = (value: unknown) => ListedPr.safeParse(value)
/** At most this many open PRs are read per poll (newest first, ten GraphQL pages); a repository with more keeps the rest as last seen. */
export const MAX_OPEN_PRS = 1000
const Listed = z.array(ListedPr).max(MAX_OPEN_PRS)
const LIST_FIELDS = "number,headRefOid,isDraft,updatedAt,reviewRequests,assignees,title,url,labels,baseRefName,baseRefOid,headRefName,author,isCrossRepository,maintainerCanModify"

/** What other fronts (eligibility, routing, stacks) need of a listed PR, in the provider-neutral `PrFacts` shape. */
export function listedToFacts(pr: ListedPr): PrFacts {
  const who = (list: ListedPr["assignees"]) => (list ?? []).flatMap((item) => item.login ? [item.login] : item.slug ? [`team:${item.slug}`] : [])
  const author = pr.author?.login ?? ""
  return {
    number: pr.number, head: pr.headRefOid, base: pr.baseRefOid ?? "", baseRef: pr.baseRefName ?? "", headRef: pr.headRefName ?? "",
    draft: pr.isDraft === true, labels: (pr.labels ?? []).map((label) => label.name), author,
    authorIsBot: pr.author?.is_bot === true || /\[bot\]$/i.test(author), fork: pr.isCrossRepository === true,
    ...(pr.maintainerCanModify === undefined ? {} : { maintainerCanModify: pr.maintainerCanModify }),
    requested: who(pr.reviewRequests), assignees: who(pr.assignees),
    ...(pr.title === undefined ? {} : { title: pr.title }), ...(pr.url === undefined ? {} : { url: pr.url }), ...(pr.updatedAt === undefined ? {} : { updatedAt: pr.updatedAt }),
  }
}
/** `owner/repo` of a PR URL (`https://github.com/owner/repo/pull/N`). */
const repoOfUrl = (url: string | undefined) => /^https:\/\/[^/]+\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/\d+$/.exec(url ?? "")?.[1]

export const MAX_CONCURRENT_REVIEWS = 2
/** The highest `prReview.concurrency`: the daemon's background scheduler never runs more jobs at once (its `high` resource mode). */
export const MAX_REVIEW_CONCURRENCY = 4
/** A concurrency value or setting as a slot count: unset or invalid is the default, anything else is clamped to 1 … `MAX_REVIEW_CONCURRENCY`. */
export function reviewConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_CONCURRENT_REVIEWS
  return Math.min(MAX_REVIEW_CONCURRENCY, Math.max(1, Math.floor(value)))
}
const MAX_REPOS = 10
/**
 * The run queue's size: work this daemon will run itself (`pending`, `running`, `fixing`, `validating`, and `waiting` jobs that
 * are this daemon's own retries or whose wait is over). It is a backlog mark, not a refusal: past it new work is still recorded as
 * `pending` (durable, run in order) and the session is told once an hour how far behind the queue is. The ledger's own bound
 * (`DEFAULT_MAX_ACTIVE` open jobs) is the hard limit; reaching it evicts the oldest record of the waiting kind first.
 */
export const MAX_QUEUE = 50
/**
 * Records of work this daemon does not run now (`waiting` for another device's reviewer, a claim held elsewhere, a quota reset)
 * are bounded separately: past this many, the oldest is `cancelled` with the reason, never dropped silently.
 */
export const MAX_WAITING = 500
/**
 * Whether a job counts against the run queue (`MAX_QUEUE`) at `at`: pending and running work, a backed-off retry (a `waiting` job
 * with an error), and a `waiting` job whose time came. Everything else waiting (another device, a claim, a quota reset) is a
 * waiting record (`MAX_WAITING`).
 */
export const runnable = (job: Pick<ReviewJob, "state" | "notBefore" | "error">, at: number) =>
  job.state === "pending" || job.state === "running" || job.state === "fixing" || job.state === "validating"
  || job.state === "waiting" && (job.error !== undefined || job.notBefore !== undefined && job.notBefore <= at)
const waitingRecord = (job: Pick<ReviewJob, "state" | "notBefore" | "error">, at: number) => job.state === "waiting" && !runnable(job, at)
const MAX_COMMANDS = 100
/** A command the repository did not let this login answer is tried again this often (`publishers` is cached as long). */
export const PUBLISHER_RETRY_MS = 600_000
/** A paused watch lists its PRs again this often, and once at the first tick after the daemon starts (gh may be there now). */
export const PAUSE_RETRY_MS = 300_000

export type RepoWatchOptions = {
  dir: string
  run?: GhRun
  now?: () => number
  /**
   * A clock that stops while the machine sleeps (default `performance.now`, only when `now` is the real clock too), so failing time
   * is counted awake (outage.ts). Tests inject both.
   */
  monotonic?: () => number
  intervalMs?: number
  /** `experimental.pr_review` and the tier permit. Checked on every tick and command: off, no `gh` runs. */
  enabled(): boolean
  /** The repo config's triggers for a watched directory (its base branch's `.mendcode/review.yaml`). */
  triggers(directory: string): Promise<RepoTriggers>
  /** The repo config's cooldown and role for a watched directory. */
  limits?(directory: string): Promise<RepoLimits>
  /** Runs one review or command to its end (T2 to T4); the watch counts it against the concurrency cap and keeps a blocked command. */
  start(job: RepoWatchJob): Promise<JobOutcome>
  notify(sessionId: string, text: string): void
  sessionExists(sessionId: string): boolean
  /** After each successful listing: explain the failing checks of reviewed heads (docs/pr-review.md, follow-ups). */
  followUp?(directory: string, sessionId: string, prs: ReadonlyArray<{ number: number; headRefOid: string }>): Promise<void>
  /** The durable job ledger; absent, the watch keeps one at `<dir>/pr-review/jobs.json`. The watch is its scheduler: it calls `recover()` once. */
  jobs?: JobLedger
  /** Reviews and commands running at once (default `MAX_CONCURRENT_REVIEWS`); a function is read again at every start, so a setting changed while running applies to the next job. */
  concurrency?: number | (() => number | undefined)
  /** For the retry jitter; tests pin it. */
  random?: () => number
  /** Unsuccessful ends (failures and interruptions) before a job is `failed` for good (default `MAX_JOB_ATTEMPTS`). */
  maxAttempts?: number
  /**
   * The platform's eligibility, routing, stacks and catch-up for one listing (service.ts). Absent, every event the triggers and
   * the role allow is reviewed by this watch's one reviewer (`global`, or `personal:<login>` for `requested`), as before.
   */
  plan?(input: { directory: string; sessionId: string; role: RepoRole; login?: string | undefined; prs: PrFacts[]; catchUp: boolean }): Promise<WatchPlan>
  /**
   * The GitLab or Gitea adapter of a checkout (service.ts): the watch then lists, reads `@mendcode` comments and names its login
   * through it. Undefined for a GitHub checkout, or one no adapter claims: `gh`, exactly as before.
   */
  forge?(directory: string): Promise<WatchForge | undefined>
  /**
   * A claim marker comment of these PRs was posted or edited since the last read (a device claimed, renewed or released one): the
   * platform settles the jobs that wait for a claim there again now instead of at its expiry. Due work starts right after.
   */
  claimsChanged?(directory: string, numbers: readonly number[]): void
  /**
   * For a `requested` watch: whether the platform's routing (an area or a label of `.mendcode/reviewers.yaml`) gives PR `facts` to
   * this login's personal reviewer although the PR neither requests nor assigns it; `undefined` when that cannot be read now (the
   * comment is read again at the next poll). An `@mendcode` comment addressed to no one on such a PR is this reviewer's.
   */
  routedHere?(directory: string, facts: PrFacts): Promise<boolean | undefined>
}
/** A checkout's forge for the watch: its kind, repository path and adapter (with `comments` and `self`). */
export type WatchForge = { kind: "gitlab" | "gitea"; repo: string; provider: ReviewProvider }
/** A provider's facts in the listing's shape, so the poll treats a GitLab or Gitea listing exactly as a `gh pr list`. */
export function factsToListed(facts: PrFacts): ListedPr {
  return {
    number: facts.number, headRefOid: facts.head, isDraft: facts.draft, ...(facts.updatedAt ? { updatedAt: facts.updatedAt } : {}),
    reviewRequests: facts.requested.map((login) => ({ login })), assignees: facts.assignees.map((login) => ({ login })),
    ...(facts.title !== undefined ? { title: facts.title } : {}), ...(facts.url ? { url: facts.url } : {}), labels: facts.labels.map((name) => ({ name })),
    baseRefName: facts.baseRef, baseRefOid: facts.base, headRefName: facts.headRef, author: { login: facts.author, is_bot: facts.authorIsBot },
    isCrossRepository: facts.fork, ...(facts.maintainerCanModify === undefined ? {} : { maintainerCanModify: facts.maintainerCanModify }),
  }
}
/** Comments up to this much older than the last read are read again (forge and daemon clocks differ); `answered` dedupes them. */
const COMMENT_SLACK_MS = 5 * 60_000
const forgeName = (kind: WatchForge["kind"] | undefined) => kind === "gitlab" ? "GitLab" : kind === "gitea" ? "Gitea" : "GitHub"
const cliOf = (kind: WatchForge["kind"] | undefined) => kind === "gitlab" ? "glab" : kind === "gitea" ? "the Gitea API" : "gh"

type Listed = z.infer<typeof Listed>
/** A comment as `gh api --jq` prints it, one object per line. */
const PolledComment = z.object({ id: z.number().int(), body: z.string().max(100_000).nullable(), user: z.string().max(100).nullable(), association: z.string().max(40).nullable().optional(), created_at: z.string().max(40).optional(), html_url: z.string().max(500).optional(), pull_request_url: z.string().max(500).optional(), in_reply_to_id: z.number().int().nullable().optional(), diff_hunk: z.string().max(50_000).nullable().optional() })
const ISSUE_COMMENTS = ".[] | {id, body, user: .user.login, association: .author_association, created_at, html_url}"
/** What every claim marker comment carries (ownership.ts `claimMarker`). */
const CLAIM_MARK = "mendcode:claim"
/** Why a draft is not reviewed while `triggers.drafts` is off, kept for `/pr list` like any other skipped PR (eligibility's words). */
const DRAFT_SKIPPED = "draft: waits for ready for review"
const REVIEW_COMMENTS = ".[] | {id, body, user: .user.login, association: .author_association, created_at, pull_request_url, in_reply_to_id, diff_hunk}"

export function createRepoWatch(options: RepoWatchOptions) {
  const run = options.run ?? ghProcess
  const now = options.now ?? Date.now
  // An injected wall clock without a monotonic one: comparing it with the real `performance.now` would read every jump as sleep.
  const monotonic = options.monotonic ?? (options.now ? undefined : () => performance.now())
  const mark = () => clockMark(now, monotonic)
  const interval = options.intervalMs ?? WATCH_INTERVAL_MS
  const random = options.random ?? Math.random
  const file = path.join(options.dir, "pr-review", "watches.json")
  let watches = load()
  // A daemon start is a catch-up like a resume: the work that routes to this daemon's personal reviewers while it was down (a
  // review requested, a claim that expired) is read from the provider's current state at the first listing, not from events.
  for (const watch of watches) if (!watch.ended) watch.catchUp = true
  const ledger = options.jobs ?? createJobLedger({ file: path.join(options.dir, "pr-review", "jobs.json"), now })
  const concurrency = () => reviewConcurrency(typeof options.concurrency === "function" ? options.concurrency() : options.concurrency)
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? MAX_JOB_ATTEMPTS))
  /** Commands waiting for a free slot; the commands themselves are durable in watches.json and offered again after a restart. */
  const queue: Array<Extract<RepoWatchJob, { kind: "command" }>> = []
  /** Comment ids whose command job runs now: offered again only once it ends. */
  const inFlight = new Set<number>()
  /** Ledger jobs this process runs now. */
  const runningJobs = new Set<string>()
  let running = 0
  let timer: ReturnType<typeof setInterval> | undefined
  /** Wakes the pump when the earliest retry is due, between polls. */
  let wakeTimer: ReturnType<typeof setTimeout> | undefined
  let ticking = false
  let stopped = false
  /** When each paused watch last tried gh in this process; one not tried yet is due. */
  const pauseTried = new Map<RepoWatchRecord, number>()

  function load(): RepoWatchRecord[] {
    try {
      const parsed = File.safeParse(JSON.parse(readFileSync(file, "utf8")))
      return parsed.success ? withoutOldEnded(carryConsent(parsed.data.watches.flatMap((item) => { const watch = Watch.safeParse(item); return watch.success ? [upgrade(watch.data)] : [] }))) : []
    } catch { return [] }
  }
  /**
   * A directory keeps at most one stopped watch, its newest (history, and the answer to "may MendCode post here"); older ended
   * records are dropped: a directory restarted and stopped many times listed every try, and a daemon that lost its network
   * ended each of them again.
   */
  function withoutOldEnded(records: RepoWatchRecord[]): RepoWatchRecord[] {
    const newest = new Map<string, RepoWatchRecord>()
    for (const watch of records) if (watch.ended && (newest.get(watch.directory)?.ended?.at ?? -Infinity) <= watch.ended.at) newest.set(watch.directory, watch)
    return records.filter((watch) => !watch.ended || newest.get(watch.directory) === watch)
  }
  /**
   * The answer to "may MendCode post here" belongs to the directory, not to one watch record: a stopped watch stays in the file
   * next to the running one. Before, `/pr publish on` went to the first record of the directory, a stopped one, and the running
   * watch kept asking (seen live). A running watch without an answer takes the one its directory's other records hold.
   */
  function carryConsent(records: RepoWatchRecord[]): RepoWatchRecord[] {
    for (const watch of records) {
      if (watch.ended) continue
      const other = records.find((item) => item !== watch && item.directory === watch.directory && (item.publish || item.asked))
      if (!watch.publish && other?.publish) watch.publish = other.publish
      if (!watch.asked && other?.asked) watch.asked = true
    }
    return records
  }
  /**
   * A watch saved before commands were kept marked every comment read before it was answered, so one refused for a missing
   * `/pr publish on` was lost. While posting was never allowed nothing was answered on GitHub: its comments are read again from
   * the watch's start and kept this time. A watch that did post keeps its marks (an answered command must not run twice).
   */
  function upgrade(watch: RepoWatchRecord): RepoWatchRecord {
    if (watch.commands) return watch
    if (watch.publish === "allowed") return { ...watch, commands: [] }
    const { commentsSince: _since, answered: _answered, ...rest } = watch
    return { ...rest, commands: [] }
  }
  /** What the file holds now: an idle poll changes nothing, and writing the same tens of kilobytes every minute is waste. */
  let saved: string | undefined
  function save() {
    const text = JSON.stringify({ version: 1, watches })
    if (text === saved) return
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const temp = `${file}.${crypto.randomUUID()}.tmp`
      writeFileSync(temp, text, { mode: 0o600, flag: "wx" })
      renameSync(temp, file)
      saved = text
    } catch { /* an unsaved watch still works until the daemon stops */ }
  }
  const active = (watch: RepoWatchRecord) => !watch.ended && !watch.paused
  function arm() {
    const needed = !stopped && watches.some((watch) => !watch.ended)
    if (needed && !timer) { timer = setInterval(() => void tick(), interval); timer.unref?.() }
    if (!needed && timer) { clearInterval(timer); timer = undefined }
  }

  /** `start` that never throws synchronously: a runner that throws is a failed attempt like one that rejects. */
  const launch = (job: RepoWatchJob): Promise<JobOutcome> => { try { return Promise.resolve(options.start(job)) } catch (error) { return Promise.reject(error) } }
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^\[PR_REVIEW\]:\s*/, "").slice(0, 600) || "failed"

  /**
   * Starts work while fewer than `concurrency` jobs run: kept commands first (a person is waiting on the PR), then the ledger's
   * due reviews, oldest first. Nothing starts while the feature is off or after `stop`.
   */
  function pump() {
    if (stopped || !options.enabled()) return
    const skipped = new Set<string>()
    while (running < concurrency()) {
      const command = queue.shift()
      if (command) { startCommand(command); continue }
      const job = ledger.due(now()).find((item) => !runningJobs.has(item.id) && !skipped.has(item.id))
      if (!job) break
      if (!startReview(job)) skipped.add(job.id)
    }
    wake()
  }
  function startCommand(job: Extract<RepoWatchJob, { kind: "command" }>) {
    running++
    inFlight.add(job.comment.id)
    void launch(job).catch(() => undefined).then((outcome) => settle(job, outcome)).finally(() => {
      inFlight.delete(job.comment.id)
      running--
      pump()
    })
  }
  /** Moves a ledger job, false when it can no longer move there (another front moved it first). */
  function move(id: string, state: JobState, patch: Partial<Omit<ReviewJob, "id" | "state">> = {}) {
    try { ledger.transition(id, state, patch); return true } catch { return false }
  }
  function startReview(job: ReviewJob) {
    if (!options.sessionExists(job.sessionId)) { move(job.id, "cancelled", { error: "its session was closed before it ran" }); return false }
    if (!move(job.id, "running", { notBefore: undefined })) return false
    running++
    runningJobs.add(job.id)
    const entry: RepoWatchJob = { kind: "review", directory: job.directory, sessionId: job.sessionId, number: job.number, head: job.head, trigger: job.trigger === "comment" ? "manual" : job.trigger, jobId: job.id }
    const started = mark()
    void launch(entry).then((outcome) => finish(job.id, outcome, started), (error: unknown) => finish(job.id, { error: message(error) }, started)).catch(() => undefined).finally(() => {
      runningJobs.delete(job.id)
      running--
      pump()
    })
    return true
  }
  /**
   * A review's runner returned. A job its runner already moved (checkpointed, waiting, done) is left as it is. A superseded one
   * ends `stale`; an error is retried after `nextAttemptAt` until `maxAttempts`, then `failed`. A transient error (`transientFailure`)
   * spends no attempt: the job waits (`transientRetryAt`, at most 15 minutes) and runs again, for up to `TRANSIENT_RETRY_WINDOW_MS`
   * after its first such failure; past that its failures count. A stopped watch writes nothing: the job stays `running` on disk and
   * is recovered at the next start, exactly as after a crash.
   */
  /**
   * Whether a job's error is the network or the forge for now, not the job: its words say so (`failureKind`), the machine slept
   * during the attempt (the wall clock ran ahead of the monotonic one), or, when the words are unclear (a failed `git fetch` says
   * nothing about why), the forge cannot be reached right now either (`reachable`). A permanent error never is.
   */
  async function transientFailure(directory: string, error: string, started: ClockMark) {
    const kind = failureKind(error)
    if (kind !== "unknown") return kind === "transient"
    if (elapsed(started, mark()).slept) return true
    const probe = await reachable(directory)
    return !probe.ok && failureKind(probe.reason) === "transient"
  }
  /** One cheap read of the forge: GitHub's rate limit (not counted against it), or a GitLab or Gitea listing through the adapter. */
  async function reachable(directory: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const forge = await options.forge?.(directory).catch(() => undefined)
    if (forge) {
      const listed = await list(directory, forge)
      return listed.ok ? { ok: true } : { ok: false, reason: listed.reason }
    }
    const done = await run({ argv: ["api", "rate_limit", "--jq", ".resources.core.remaining"], cwd: directory }).catch((error: unknown) => ({ code: 1, out: "", err: message(error) }))
    return done.code === 0 ? { ok: true } : { ok: false, reason: done.err.split("\n").find((line) => line.trim())?.slice(0, 160) ?? `gh exited with ${done.code}` }
  }
  async function finish(id: string, outcome: JobOutcome, started: ClockMark) {
    if (stopped) return
    const before = ledger.get(id)
    if (!before || !IN_FLIGHT_STATES.includes(before.state)) return
    if (before.stop?.kind === "superseded") { move(id, "stale"); return }
    const error = outcome?.error
    if (error === undefined) { move(id, "done", { transient: undefined }); return }
    const transient = outcome?.retry !== false && await transientFailure(before.directory, error, started)
    // Read again after the probe: a push or a cancel may have moved the job meanwhile.
    const job = ledger.get(id)
    if (stopped || !job || !IN_FLIGHT_STATES.includes(job.state)) return
    if (job.stop?.kind === "superseded") { move(id, "stale"); return }
    const at = now()
    const since = job.transient?.since ?? at
    if (transient && at - since < TRANSIENT_RETRY_WINDOW_MS) {
      const waits = (job.transient?.waits ?? 0) + 1
      const notBefore = transientRetryAt(waits, at, random)
      if (job.state !== "running") move(id, "running")
      move(id, "waiting", { error: `${error.slice(0, 1_500)} (a network or forge outage: tried again without spending an attempt)`, transient: { since, waits }, notBefore })
      if (waits === 1) options.notify(job.sessionId, `${failureLabel(job)} could not finish: ${reasonText(error)}. That looks like a network or forge outage: it waits for the network and is tried again at ${clockText(notBefore)} without spending an attempt (${maxAttempts - job.attempts} attempt${maxAttempts - job.attempts === 1 ? "" : "s"} left).`)
      return
    }
    const attempts = job.attempts + 1
    if (outcome?.retry === false || attempts >= maxAttempts) {
      move(id, "failed", { attempts, error })
      options.notify(job.sessionId, `${failureLabel(job)} failed: ${reasonText(error)}. It is not tried again (${outcome?.retry === false ? "this error does not go away by retrying" : `all ${maxAttempts} attempts spent`}); /reviews retries it.`)
      return
    }
    const notBefore = nextAttemptAt(attempts, now(), random)
    // fixing and validating have no direct way back to waiting; through running is the same job's next attempt.
    if (job.state !== "running") move(id, "running")
    move(id, "waiting", { attempts, error, notBefore })
    // The first failure is said with what happens next; the retries between are quiet, the last one says it gave up.
    if (attempts === 1) options.notify(job.sessionId, `${failureLabel(job)} failed: ${reasonText(error)}. It is tried again at ${clockText(notBefore)} (${maxAttempts - attempts} attempt${maxAttempts - attempts === 1 ? "" : "s"} left).`)
  }
  /** A failed job as the session hears of it: the repository, the PR and the head it reviews. */
  const failureLabel = (job: ReviewJob) => `PR review of ${job.repo}#${job.number}${job.head ? ` at ${job.head.slice(0, 12)}` : ""}`
  const reasonText = (error: string) => error.replace(/^\[PR_REVIEW\]:\s*/, "").replace(/\s+/g, " ").trim().slice(0, 400) || "unknown error"
  /** A retry time a person reads: UTC, to the minute. */
  const clockText = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`
  /**
   * One timer, unref'd, for the earliest retry: a backed-off job runs when due, not only at the next poll. Computed once per turn
   * of the event loop: a poll that queues hundreds of jobs pumps once per job, and each computation reads every open job.
   */
  let wakeQueued = false
  function wake() {
    if (wakeQueued) return
    wakeQueued = true
    queueMicrotask(() => { wakeQueued = false; wakeNow() })
  }
  function wakeNow() {
    if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = undefined }
    if (stopped) return
    const at = now()
    const next = Math.min(...ledger.list({ states: ["pending", "waiting"] }).flatMap((job) => job.notBefore !== undefined && job.notBefore > at ? [job.notBefore] : []))
    if (!Number.isFinite(next)) return
    wakeTimer = setTimeout(() => { wakeTimer = undefined; pump() }, Math.min(next - at, 2 ** 31 - 1))
    wakeTimer.unref?.()
  }

  /**
   * Jobs a stopped daemon left running are pending again (`recover`); one interrupted `maxAttempts` times is failed instead of
   * crashing the daemon again. They start at the first tick, when the feature is known to be on.
   */
  function recoverJobs() {
    for (const job of ledger.recover()) {
      if (job.attempts < maxAttempts) continue
      // A pending job has no direct way to `failed`: it is this attempt that is given up.
      if (move(job.id, "running")) move(job.id, "failed", { error: `interrupted ${job.attempts} times (the daemon stopped while it ran)` })
    }
  }

  const OPEN_STATES: readonly JobState[] = ["pending", "waiting", "running", "fixing", "validating", "checkpointed", "paused"]
  const openJobs = (directory: string, number: number) => ledger.list({ number, states: OPEN_STATES }).filter((job) => job.directory === directory)

  /**
   * The head of PR `number` is now `head`: every open job of an older head is superseded. One not started yet is `stale` at once;
   * one running keeps running (it cannot be stopped mid-call) but is marked, ends `stale`, and `isCurrent` refuses its publish.
   * True when a started job was superseded (the watch then lets the new head skip the PR cooldown, nothing will be posted).
   */
  function supersede(directory: string, number: number, head: string) {
    let started = false
    for (const job of openJobs(directory, number)) {
      if (!job.head || job.head === head || job.stop?.kind === "superseded") continue
      const stop = { kind: "superseded" as const, detail: `the head of #${number} moved from ${job.head.slice(0, 12)} to ${head.slice(0, 12)} while this job ${job.state === "pending" || job.state === "waiting" ? "waited" : "ran"}`, resumable: false }
      if (["running", "fixing", "validating"].includes(job.state)) { started = move(job.id, job.state, { stop }) || started; continue }
      move(job.id, "stale", { stop })
    }
    return started
  }

  /**
   * The open review job a request for `head` of PR `number` by `reviewer` joins instead of becoming a second one. An empty `head` is
   * a `/pr review`, queued before its head is known (the run fills it in): it joins the reviewer's job that is queued or running for
   * the PR, whatever head that job has, since that job reviews the PR as it is now (a moved head supersedes it as ever).
   */
  function sameReview(directory: string, number: number, head: string, reviewer: string) {
    const open = openJobs(directory, number).filter((job) => job.reviewer === reviewer && job.coverage !== "audit")
    if (head) return open.find((job) => job.head === head)
    const current = find(directory)?.seen[String(number)]?.head
    return open.find((job) => ["pending", "running", "fixing", "validating"].includes(job.state) && (!job.head || !current || job.head === current))
  }

  /**
   * Queues a review of one PR head in the ledger. The same directory, PR and head already open is that job (never two); the
   * oldest pending job is cancelled, visibly, when `MAX_QUEUE` wait already.
   */
  /** The watch's one reviewer when no platform routes: `personal:<login>` for a `requested` watch, else the repository's `global`. */
  const ownReviewer = (watch: RepoWatchRecord | undefined): ReviewAssignment => watch?.role === "requested" && watch.login ? { reviewer: `personal:${watch.login}`, scope: "personal" } : { reviewer: "global", scope: "global" }
  function enqueueReview({ watch, directory, sessionId, number, head, trigger, pr, assignment = ownReviewer(watch), forge }: { watch: RepoWatchRecord | undefined; directory: string; sessionId: string; number: number; head: string; trigger: ReviewTrigger; pr?: ListedPr | undefined; assignment?: ReviewAssignment | undefined; forge?: { kind: WatchForge["kind"]; repo: string } | undefined }) {
    // One job per reviewer and head: two reviewers routed to one PR each get theirs, the same reviewer never two.
    const same = sameReview(directory, number, head, assignment.reviewer)
    if (same) return same.id
    if (head) supersede(directory, number, head)
    const recordOnly = assignment.waiting !== undefined
    if (recordOnly) trimWaiting(1)
    else noteBacklog(directory, sessionId)
    const text = recordOnly ? waitingAssignment(assignment.waiting!, assignment.assignment) : assignment.assignment?.slice(0, 400)
    const upsert = () => ledger.upsert({
        provider: watch?.provider ?? forge?.kind ?? "github", repo: watch?.repo ?? forge?.repo ?? repoOfUrl(pr?.url) ?? directory, directory, number, sessionId,
        reviewer: assignment.reviewer, scope: assignment.scope,
        ...(text ? { assignment: text } : {}), ...(assignment.owner ? { owner: assignment.owner } : {}), ...(assignment.stack ? { stack: assignment.stack } : {}),
        ...(assignment.covers?.length ? { covers: assignment.covers.slice(0, 10) } : {}),
        trigger, coverage: trigger === "synchronize" ? "incremental" : "full", base: pr?.baseRefOid ?? "", head, configKey: "",
        ...(pr?.title ? { title: pr.title.slice(0, 300) } : {}), ...(pr?.url && pr.url.length <= 500 ? { url: pr.url } : {}),
        // Recorded, not run: a reviewer of another daemon waits (offline is not failure); a claim's expiry makes it due again.
        ...(assignment.waiting !== undefined ? { state: "waiting" as const, ...(assignment.notBefore !== undefined ? { notBefore: assignment.notBefore } : {}) } : {}),
      })
    let job: ReviewJob
    try { job = upsert() } catch {
      // The ledger's open-job bound: the oldest waiting record makes room once; otherwise the caller keeps the event for the next poll.
      if (!trimWaiting(1, true)) return undefined
      try { job = upsert() } catch { return undefined }
    }
    pump()
    return job.id
  }

  /**
   * Keeps the waiting records (`waitingRecord`) within `MAX_WAITING` with `room` more to come: the oldest are cancelled with the
   * reason (a `/reviews` retry queues one again). `force` evicts one even under the bound (the ledger is full). How many it evicted.
   */
  function trimWaiting(room = 0, force = false) {
    const at = now()
    const records = ledger.list({ states: ["waiting"] }).filter((job) => waitingRecord(job, at)).toSorted((a, b) => a.createdAt - b.createdAt)
    const excess = Math.max(records.length + room - MAX_WAITING, force && records.length ? 1 : 0)
    let evicted = 0
    for (const job of records.slice(0, excess)) {
      if (move(job.id, "cancelled", { error: `more than ${MAX_WAITING} jobs were waiting for another device or a quota reset; this, the oldest, was cancelled (/reviews retries it)` })) evicted++
    }
    return evicted
  }
  /** When the session was last told its run queue is past `MAX_QUEUE`, per directory: once an hour. */
  const backlogTold = new Map<string, number>()
  function noteBacklog(directory: string, sessionId: string) {
    const at = now()
    // Told within the hour: nothing to count (a burst of new PRs would otherwise read the whole ledger per job).
    if (at - (backlogTold.get(directory) ?? -Infinity) < HOUR_MS) return
    const queued = ledger.list({ states: ["pending", "running", "fixing", "validating", "waiting"] }).filter((job) => runnable(job, at)).length
    if (queued < MAX_QUEUE) return
    backlogTold.set(directory, at)
    options.notify(sessionId, `${queued} reviews are queued on this daemon (more than its run queue of ${MAX_QUEUE}); new ones are still recorded and run in order, none is dropped. /reviews shows them.`)
  }
  function enqueueCommand(job: Extract<RepoWatchJob, { kind: "command" }>) {
    if (inFlight.has(job.comment.id) || queue.some((item) => item.comment.id === job.comment.id)) return
    if (queue.length >= MAX_QUEUE) queue.shift()
    queue.push(job)
    pump()
  }

  /**
   * The `@mendcode` commands written on the repository's open PRs since the last poll: two `gh api` calls, issue comments and
   * review comments, filtered by `since`. MendCode's own replies carry a marker and are never read as commands. Failures are
   * quiet: the next poll reads from the same time again.
   */
  /**
   * Which `@mendcode` comments this reviewer takes: one addressed to its login (`@mendcode review @alice`), or one addressed to no
   * one when it reviews every PR (`all`) or the PR requests it. Many developers can run their own reviewer on one repository and a
   * comment is answered by the reviewer it is meant for.
   */
  const takes = ({ command, role, me, requested }: { command: PrCommand; role: RepoRole; me: string | undefined; requested: boolean }) =>
    command.target ? !!me && command.target.toLowerCase() === me : role === "all" || requested
  /**
   * `takes` for one comment, with a `requested` watch's routing asked only when it matters (a comment addressed to no one on a PR
   * that does not request this login): an area or label route to its personal reviewer makes the PR its own. `undefined`: the
   * routing could not be read, so the comment is left for the next poll.
   */
  async function takesComment({ command, role, me, requested, directory, pr }: { command: PrCommand; role: RepoRole; me: string | undefined; requested: boolean; directory: string; pr: ListedPr | undefined }): Promise<boolean | undefined> {
    if (takes({ command, role, me, requested })) return true
    if (command.target || role !== "requested" || !pr || !options.routedHere) return false
    return options.routedHere(directory, listedToFacts(pr)).catch(() => undefined)
  }

  /**
   * `pollComments` on GitLab or Gitea: neither lists a repository's comments since a time, so the comments of each open PR updated
   * since the last read (a comment updates its PR there) are read through the adapter. The same rules as on GitHub: a comment is
   * taken once (`answered`), MendCode's own replies carry a marker, and a failed read is read again at the next poll.
   */
  async function pollCommentsThrough(watch: RepoWatchRecord, prs: Listed, role: RepoRole, forge: WatchForge) {
    const me = watch.login?.toLowerCase()
    const requestedOf = (pr: ListedPr) => !!me && [...(pr.reviewRequests ?? []), ...(pr.assignees ?? [])].some((who) => who.login?.toLowerCase() === me)
    const started = new Date(now()).toISOString()
    const since = Date.parse(watch.commentsSince ?? new Date(watch.createdAt).toISOString()) - COMMENT_SLACK_MS
    const answered = new Set(watch.answered ?? [])
    const claimed = new Set<number>()
    let complete = true
    let read = false
    for (const pr of prs) {
      if (pr.updatedAt && Date.parse(pr.updatedAt) < since) continue
      const got = await forge.provider.comments?.({ repo: forge.repo, number: pr.number }).catch(() => undefined)
      if (!got?.ok) { complete = false; continue }
      for (const item of got.comments) {
        const at = Date.parse(item.updatedAt ?? item.createdAt ?? "")
        if (Number.isFinite(at) && at < since) continue
        read = true
        if (item.body?.includes(CLAIM_MARK)) claimed.add(pr.number)
        if (answered.has(item.id) || !item.body || !item.author) continue
        const command = parsePrCommand(item.body)
        if (!command) continue
        const mine = await takesComment({ command, role, me, requested: requestedOf(pr), directory: watch.directory, pr })
        if (mine === undefined) { complete = false; continue }
        answered.add(item.id)
        if (!mine) continue
        const comment: CommandComment = { id: item.id, ...(item.createdAt ? { createdAt: item.createdAt } : {}), surface: item.surface, actor: item.author.slice(0, 255), body: item.body.slice(0, 100_000), ...(item.inReplyTo ? { inReplyTo: item.inReplyTo } : {}), ...(item.discussion ? { discussion: item.discussion.slice(0, 64) } : {}), ...(item.path ? { path: item.path.slice(0, 1000) } : {}), ...(item.line ? { line: item.line } : {}) }
        const commands = watch.commands ??= []
        if (!commands.some((stored) => stored.comment.id === item.id)) commands.push({ comment: comment as StoredCommand["comment"], number: pr.number })
        if (commands.length > MAX_COMMANDS) commands.splice(0, commands.length - MAX_COMMANDS)
      }
    }
    watch.answered = [...answered].slice(-200)
    if (complete && read) watch.commentsSince = started
    noteClaims(watch, claimed)
    offer(watch)
  }

  async function pollComments(watch: RepoWatchRecord, prs: Listed, role: RepoRole) {
    const forge = watch.provider ? await options.forge?.(watch.directory).catch(() => undefined) : undefined
    if (forge) return pollCommentsThrough(watch, prs, role, forge)
    const me = watch.login?.toLowerCase()
    const requestedOf = (number: number) => { const pr = prs.find((entry) => entry.number === number); return !!me && !!pr && [...(pr.reviewRequests ?? []), ...(pr.assignees ?? [])].some((who) => who.login?.toLowerCase() === me) }
    const started = new Date(now()).toISOString()
    const since = watch.commentsSince ?? new Date(watch.createdAt).toISOString()
    const heads = new Map(prs.map((pr) => [pr.number, pr.headRefOid]))
    const answered = new Set(watch.answered ?? [])
    const claimed = new Set<number>()
    let complete = true
    /** Whether any comment is newer than `since`: with none, `since` stays where it is and an idle poll changes (and writes) nothing. */
    let read = false
    for (const [endpoint, jq] of [["issues/comments", ISSUE_COMMENTS], ["pulls/comments", REVIEW_COMMENTS]] as const) {
      // Every page: after a long pause more than 100 comments can be newer than `since`, and only one page was read before.
      const done = await run({ argv: ["api", `repos/{owner}/{repo}/${endpoint}?since=${since}&per_page=100`, "--paginate", "--jq", jq], cwd: watch.directory })
      if (done.code !== 0) { complete = false; continue }
      for (const line of done.out.split("\n")) {
        let item: z.infer<typeof PolledComment>
        try { const parsed = PolledComment.safeParse(JSON.parse(line)); if (!parsed.success) continue; item = parsed.data } catch { continue }
        read = true
        const number = Number((endpoint === "issues/comments" ? /\/pull\/(\d+)(?:#|$)/.exec(item.html_url ?? "") : /\/pulls\/(\d+)$/.exec(item.pull_request_url ?? ""))?.[1])
        // `since` reads edits too: a claim marker posted, renewed or released since the last read.
        if (item.body?.includes(CLAIM_MARK) && heads.has(number)) claimed.add(number)
        if (answered.has(item.id) || !item.body || !item.user) continue
        const command = parsePrCommand(item.body)
        const head = heads.get(number)
        if (!command || !head) continue
        const mine = await takesComment({ command, role, me, requested: requestedOf(number), directory: watch.directory, pr: prs.find((entry) => entry.number === number) })
        if (mine === undefined) { complete = false; continue }
        answered.add(item.id)
        if (!mine) continue
        const comment: CommandComment = { id: item.id, ...(item.created_at ? { createdAt: item.created_at } : {}), surface: endpoint === "pulls/comments" ? "review" : "issue", actor: item.user, body: item.body, ...(item.association ? { association: item.association } : {}), ...(item.in_reply_to_id ? { inReplyTo: item.in_reply_to_id } : {}), ...(item.diff_hunk ? { diffHunk: item.diff_hunk } : {}) }
        const commands = watch.commands ??= []
        if (!commands.some((stored) => stored.comment.id === item.id)) commands.push({ comment: comment as StoredCommand["comment"], number })
        if (commands.length > MAX_COMMANDS) commands.splice(0, commands.length - MAX_COMMANDS)
      }
    }
    watch.answered = [...answered].slice(-200)
    if (complete && read) watch.commentsSince = started
    noteClaims(watch, claimed)
    offer(watch)
  }

  /** Claims changed on these PRs: the platform settles their claim waits now (`claimsChanged`), and what became due starts. */
  function noteClaims(watch: RepoWatchRecord, numbers: ReadonlySet<number>) {
    if (!numbers.size || !options.claimsChanged) return
    try { options.claimsChanged(watch.directory, [...numbers]) } catch { /* the claim's expiry still makes the job due */ }
    pump()
  }

  async function list(directory: string, forge?: WatchForge | undefined): Promise<{ ok: true; prs: Listed } | { ok: false; auth: boolean; reason: string }> {
    if (forge) {
      // Every open PR/MR through the adapter (all pages); one without a head commit yet (an empty MR) has nothing to review.
      const listed = await forge.provider.listOpen({ directory, repo: forge.repo }).catch((error: unknown) => ({ ok: false as const, auth: false, reason: message(error) }))
      if (!listed.ok) return listed
      const parsed = Listed.safeParse(listed.prs.filter((pr) => /^[0-9a-f]{7,64}$/.test(pr.head)).slice(0, MAX_OPEN_PRS).map(factsToListed))
      return parsed.success ? { ok: true, prs: parsed.data } : { ok: false, auth: false, reason: `${forgeName(forge.kind)} returned a pull request this watch cannot read` }
    }
    // Every open PR, not the first 100: gh follows the GraphQL cursor itself (cursor pages do not skip a PR when one closes
    // between pages, as numbered REST pages can). `MAX_OPEN_PRS` bounds a poll to ten pages.
    const result = await run({ argv: ["pr", "list", "--state", "open", "--limit", String(MAX_OPEN_PRS), "--json", LIST_FIELDS], cwd: directory })
    if (result.code === 127) return { ok: false, auth: true, reason: NO_GH }
    if (result.code !== 0) {
      const line = result.err.split("\n").find((entry) => entry.trim())?.slice(0, 160) ?? `gh exited with ${result.code}`
      return { ok: false, auth: /auth|log ?in|token|credentials|HTTP 401/i.test(result.err), reason: line }
    }
    try {
      const parsed = Listed.safeParse(JSON.parse(result.out))
      return parsed.success ? { ok: true, prs: parsed.data } : { ok: false, auth: false, reason: "gh returned something that is not a pull request list" }
    } catch { return { ok: false, auth: false, reason: "gh returned something that is not JSON" } }
  }

  /** A command job ended: answered (or refused for good) it is dropped, blocked it waits for its condition. */
  function settle(job: Extract<RepoWatchJob, { kind: "command" }>, outcome: JobOutcome) {
    const watch = watches.find((item) => item.directory === job.directory && !item.ended)
    const stored = watch?.commands?.find((item) => item.comment.id === job.comment.id)
    if (!watch || !stored) return
    const blocked = outcome?.blocked
    if (blocked) stored.blocked = blocked
    else watch.commands = watch.commands!.filter((item) => item !== stored)
    save()
  }

  /**
   * Queues the kept commands that are due: a new one, one whose job never ended (a restart, a full queue), one blocked on consent
   * once posting is allowed, one blocked by `publishers` every `PUBLISHER_RETRY_MS` while posting is allowed. A command of a PR
   * that is no longer open is dropped. One comment is never queued or run twice at once.
   */
  function offer(watch: RepoWatchRecord) {
    if (!watch.commands?.length || !active(watch)) return
    const allowed = consentOf(watch.directory) === "allowed"
    const kept: StoredCommand[] = []
    for (const stored of watch.commands) {
      const head = watch.seen[String(stored.number)]?.head
      if (!head) continue
      kept.push(stored)
      const busy = inFlight.has(stored.comment.id) || queue.some((job) => job.comment.id === stored.comment.id)
      const due = !stored.blocked || stored.blocked === "job" || allowed && (stored.blocked === "consent" || now() - (stored.triedAt ?? 0) >= PUBLISHER_RETRY_MS)
      const command = parsePrCommand(stored.comment.body)
      if (busy || !due || !command) continue
      stored.triedAt = now()
      enqueueCommand({ kind: "command", directory: watch.directory, sessionId: watch.sessionId, number: stored.number, head, trigger: "comment", command, comment: stored.comment, ...(stored.blocked ? { blocked: stored.blocked } : {}) })
    }
    watch.commands = kept
  }

  const retryDue = (watch: RepoWatchRecord) => !watch.ended && !!watch.paused && now() - (pauseTried.get(watch) ?? -Infinity) >= PAUSE_RETRY_MS
  const pauseText = (watch: RepoWatchRecord, reason: string) => `The PR review watch of ${watch.directory} is paused: ${reason}. ${watch.provider === "gitlab" ? "Install glab and log it in to this host (glab auth login)" : watch.provider === "gitea" ? "Give the daemon a Gitea token in GITEA_TOKEN" : reason === NO_GH ? "Install gh or put its folder on the daemon's PATH" : "Log gh in (gh auth login)"}; the watch tries again every ${Math.round(PAUSE_RETRY_MS / 60_000)} minutes and resumes by itself, and /pr watch-repo tries now. Pull requests and @mendcode comments from the pause are read then, none is lost.`
  /** A paused watch that listed its PRs again: what was kept (heads, comment time, kept commands) carries the pause's events over. */
  function resume(watch: RepoWatchRecord) {
    if (!watch.paused) return
    const minutes = watch.pausedAt === undefined ? undefined : Math.max(1, Math.round((now() - watch.pausedAt) / 60_000))
    options.notify(watch.sessionId, `The PR review watch of ${watch.directory} resumed${minutes ? ` after ${minutes} minute${minutes === 1 ? "" : "s"}` : ""} paused (${watch.paused}); pull requests and @mendcode comments from the pause are read now.`)
    delete watch.paused
    delete watch.pausedAt
    pauseTried.delete(watch)
    watch.catchUp = true
  }

  /**
   * A listing of a PR older than the one the watch already read (GitHub's lists are eventually consistent; a retried call can
   * answer late): an older `updatedAt`, or, without times, a head the PR already moved away from. It changes nothing. A real
   * force-push back to an earlier head carries a newer `updatedAt` and is read as the push it is.
   */
  const outOfOrder = (before: RepoWatchRecord["seen"][string], pr: ListedPr) => {
    if (before.head === pr.headRefOid) return false
    const was = before.updatedAt ? Date.parse(before.updatedAt) : NaN, is = pr.updatedAt ? Date.parse(pr.updatedAt) : NaN
    if (Number.isFinite(was) && Number.isFinite(is)) return is < was
    return (before.previous ?? []).includes(pr.headRefOid)
  }

  /** The last failed listing of each watch in this process: the next one adds only the awake time between the two. */
  const lastFailure = new Map<RepoWatchRecord, ClockMark>()
  /** Whether a watch whose listings fail is due again (`outage.retryAt`, with half an interval of slack for the timer). */
  const outageDue = (watch: RepoWatchRecord) => !watch.outage || now() + interval / 2 >= watch.outage.retryAt
  /**
   * A listing failed (not a missing or logged-out gh, which pauses). The watch lists again after a growing gap (`outageGap`: one
   * interval, doubling, at most 15 minutes) and counts the failing time awake: the time between two failed listings counts only as
   * far as the monotonic clock saw it, and never more than two gaps, so a sleeping laptop's hours are not failing time. A network or
   * forge outage (or an unclear error) never ends the watch: after 15 awake minutes the session hears of it once, and the watch
   * resumes by itself. Only a permanent error (the repository gone, access revoked, the origin changed) for 15 awake minutes ends it.
   */
  function failedListing(watch: RepoWatchRecord, reason: string) {
    const at = mark()
    delete watch.unreadableSince
    const kind = failureKind(reason)
    const before = watch.outage
    const previous = lastFailure.get(watch)
    const step = before && previous ? elapsed(previous, at, 2 * outageGap(before.failures, interval)).awake : 0
    lastFailure.set(watch, at)
    const failures = (before?.failures ?? 0) + 1
    const outage: NonNullable<RepoWatchRecord["outage"]> = {
      since: before?.since ?? at.wall, awakeMs: (before?.awakeMs ?? 0) + step, permanentMs: kind === "permanent" ? (before?.permanentMs ?? 0) + step : 0,
      // After the first failure the next tick lists again; after more, the gap doubles.
      failures, reason: reason.slice(0, 300), retryAt: failures === 1 ? at.wall : at.wall + outageGap(failures, interval), ...(before?.told ? { told: true } : {}),
    }
    watch.outage = outage
    if (kind === "permanent" && outage.permanentMs >= OUTAGE_LIMIT_MS) {
      watch.ended = { at: at.wall, reason: "unreadable" }
      delete watch.outage
      lastFailure.delete(watch)
      options.notify(watch.sessionId, `The PR review watch of ${watch.directory} ended: ${cliOf(watch.provider)} could not list its pull requests for ${Math.round(OUTAGE_LIMIT_MS / 60_000)} minutes (${reason}). That is not a network outage, which never ends a watch; /pr watch-repo starts it again once the repository can be read.`)
      return
    }
    if (!outage.told && outage.awakeMs >= OUTAGE_LIMIT_MS) {
      outage.told = true
      // Said so it cannot be read as an end (seen live: a session told the user the watch "stopped after 15 minutes").
      options.notify(watch.sessionId, `The PR review watch of ${watch.directory} is waiting for ${forgeName(watch.provider)}: it could not list its pull requests for ${Math.round(outage.awakeMs / 60_000)} minutes (${reason}). The watch has not stopped and needs nothing from you: it keeps trying, at most ${Math.round(outageGap(Infinity, interval) / 60_000)} minutes apart, and resumes by itself; the pull requests, pushes and @mendcode comments of the outage are read then, once.`)
    }
  }
  /** A listing worked again: the outage is over, and the next listing catches up the work the provider shows (as after a pause). */
  function listedAgain(watch: RepoWatchRecord) {
    delete watch.unreadableSince
    lastFailure.delete(watch)
    const outage = watch.outage
    if (!outage) return
    delete watch.outage
    watch.catchUp = true
    if (outage.told) {
      const minutes = Math.max(1, Math.round((now() - outage.since) / 60_000))
      options.notify(watch.sessionId, `The PR review watch of ${watch.directory} lists its pull requests again after ${minutes} minute${minutes === 1 ? "" : "s"} of failures (${outage.reason}); the pull requests, pushes and @mendcode comments of that time are read now.`)
    }
  }

  /** One listing of a watch and the events it carries; a catch-up's backlog comes back, for the answer or notice that says it. */
  async function poll(watch: RepoWatchRecord): Promise<BacklogPlan | undefined> {
    const forge = watch.provider ? await options.forge?.(watch.directory).catch(() => undefined) : undefined
    const found: Awaited<ReturnType<typeof list>> = watch.provider && !forge ? { ok: false, auth: true, reason: `the ${forgeName(watch.provider)} adapter of this checkout is not available (its origin changed, or the daemon has no adapter for it)` } : await list(watch.directory, forge)
    if (!found.ok) {
      if (watch.paused) { pauseTried.set(watch, now()); return }
      if (found.auth) {
        watch.paused = found.reason
        watch.pausedAt = now()
        pauseTried.set(watch, now())
        options.notify(watch.sessionId, pauseText(watch, found.reason))
        return
      }
      failedListing(watch, found.reason)
      return
    }
    listedAgain(watch)
    resume(watch)
    const triggers = await options.triggers(watch.directory).catch((): RepoTriggers => ({ opened: true, synchronize: true, ready_for_review: true, drafts: false }))
    const limits = (await options.limits?.(watch.directory).catch(() => undefined)) ?? NO_LIMITS
    const role = watch.role ?? limits.reviewers
    const me = watch.login?.toLowerCase()
    const open = new Set<string>()
    watch.starts = (watch.starts ?? []).filter((at) => now() - at < HOUR_MS)
    watch.repo ??= forge ? forge.repo : found.prs.map((pr) => repoOfUrl(pr.url)).find(Boolean)
    const catchUp = watch.catchUp === true
    const plan = options.plan ? await options.plan({ directory: watch.directory, sessionId: watch.sessionId, role, login: watch.login, prs: found.prs.map(listedToFacts), catchUp }).catch(() => undefined) : undefined
    // Kept for the next listing only when the platform failed to answer; without a platform there is nothing to catch up.
    if (plan || !options.plan) delete watch.catchUp
    const extras = new Map((plan?.extra ?? []).map((item) => [item.number, item]))
    for (const pr of found.prs) {
      const key = String(pr.number)
      open.add(key)
      const before = watch.seen[key]
      if (before && outOfOrder(before, pr)) continue
      const draft = pr.isDraft === true
      const requested = !!me && [...(pr.reviewRequests ?? []), ...(pr.assignees ?? [])].some((who) => who.login?.toLowerCase() === me)
      const moved = !!before && before.head !== pr.headRefOid
      const previous = moved ? [...(before.previous ?? []).filter((head) => head !== before.head && head !== pr.headRefOid), before.head].slice(-10) : before?.previous
      const seen: RepoWatchRecord["seen"][string] = { head: pr.headRefOid, draft, requested, ...(before?.asked ? { asked: before.asked } : {}), ...(before?.reviewedAt ? { reviewedAt: before.reviewedAt } : {}), ...(before?.waiting ? { waiting: before.waiting } : {}), ...(pr.updatedAt ? { updatedAt: pr.updatedAt } : {}), ...(previous?.length ? { previous } : {}), ...(before?.skipped && !moved ? { skipped: before.skipped } : {}) }
      watch.seen[key] = seen
      // A push while a job of this PR runs: that job's result is obsolete, so the new head need not wait out the PR cooldown.
      if (moved && supersede(watch.directory, pr.number, pr.headRefOid)) delete seen.reviewedAt
      // Said for a PR this watch would take (a `requested` watch: one requesting its login), as eligibility would say it.
      if (draft && !triggers.drafts) { if (role !== "requested" || requested) seen.skipped = DRAFT_SKIPPED; continue }
      if (seen.skipped === DRAFT_SKIPPED) delete seen.skipped
      let trigger: z.infer<typeof AutoTrigger> | undefined = !before ? "opened" : before.draft && !draft ? "ready_for_review" : before.head !== pr.headRefOid ? "synchronize" : undefined
      if (trigger && !triggers[trigger as keyof RepoTriggers]) trigger = undefined
      if (role === "requested") {
        // Someone else's PR is this reviewer's only when the platform routes it to this login's personal reviewer (an area of
        // `.mendcode/reviewers.yaml`, a label route), never the global reviewer's work. Without the platform nothing waits for it,
        // and a request for this login is what starts one.
        if (!requested && !plan && !seen.asked) { delete seen.waiting; continue }
        if (requested && before && !before.requested) trigger = "requested"
      } else if (plan && !trigger && before && !before.requested && requested) {
        // With the platform deciding, a new request to this login is an event of its own (`mode: on-request` lives on it).
        trigger = "requested"
      }
      // A maintainer asked for a review of a head that was already reviewed: the next head is that review, whatever the switches say.
      if (seen.asked && seen.asked.head !== pr.headRefOid) trigger = "comment"
      const extra = extras.get(pr.number)
      const due = trigger ?? seen.waiting ?? extra?.trigger
      if (!due) continue
      // The kept request is answered by this event's decision (a review, or the reason it is not one): once.
      if (due === "comment") delete seen.asked
      let assignments: ReviewAssignment[] | undefined
      if (plan) {
        const decision = await plan.decide(listedToFacts(pr), due).catch((error: unknown): WatchDecision => ({ ok: false, reason: `the platform could not decide: ${message(error)}` }))
        // Reviewers of other daemons are recorded as waiting now, whatever this daemon's cooldowns say: they spend nothing here.
        if (decision.ok) for (const assignment of decision.assignments) if (assignment.waiting !== undefined) enqueueReview({ watch, directory: watch.directory, sessionId: watch.sessionId, number: pr.number, head: pr.headRefOid, trigger: due, pr, assignment })
        if (!decision.ok || !decision.assignments.some((assignment) => assignment.waiting === undefined)) {
          // Not reviewed, and not kept waiting either: the next event of this PR is decided again. Someone else's PR that routing
          // does not give a `requested` watch's login was never this reviewer's: nothing is said about it.
          if (role === "requested" && !requested) delete seen.skipped
          else seen.skipped = (decision.ok ? `${decision.reason}; no reviewer of this daemon is assigned` : decision.reason).slice(0, 300)
          delete seen.waiting
          continue
        }
        delete seen.skipped
        assignments = decision.assignments.filter((assignment) => assignment.waiting === undefined)
      }
      // A review someone asked for is not an automatic one: the cooldowns do not hold it back.
      const asked = due === "comment"
      const cooling = !asked && seen.reviewedAt !== undefined && now() - seen.reviewedAt < limits.cooldown.pr_minutes * 60_000
      const full = !asked && watch.starts.length >= limits.cooldown.repo_per_hour
      if (cooling || full) {
        seen.waiting = due
        if (full && !cooling && (watch.limited === undefined || now() - watch.limited >= HOUR_MS)) {
          watch.limited = now()
          options.notify(watch.sessionId, `The PR review watch of ${watch.directory} reached ${limits.cooldown.repo_per_hour} automatic reviews this hour (cooldown.repo_per_hour in .mendcode/review.yaml); the waiting PRs are reviewed at their newest head as the hour frees up. /pr review N still runs one now.`)
        }
        continue
      }
      delete seen.waiting
      seen.reviewedAt = now()
      if (!asked) watch.starts.push(now())
      const queued = (assignments ?? [ownReviewer(watch)]).map((assignment) => enqueueReview({ watch, directory: watch.directory, sessionId: watch.sessionId, number: pr.number, head: pr.headRefOid, trigger: due, pr, assignment }))
      // The ledger refused (its open-job bound, nothing waiting to evict): the event stays with the PR and the next poll tries again.
      if (queued.some((id) => id === undefined)) seen.waiting = due
    }
    // A full listing may have cut the oldest PRs off: those are kept as last seen rather than taken as closed.
    if (found.prs.length < MAX_OPEN_PRS) for (const key of Object.keys(watch.seen)) if (!open.has(key)) delete watch.seen[key]
    await pollComments(watch, found.prs, role)
    await options.followUp?.(watch.directory, watch.sessionId, found.prs).catch(() => undefined)
    return plan?.backlog
  }

  /**
   * A catch-up the session did not ask for (a daemon start, a resume after a pause or an outage) that queued backlog reviews says
   * so once; one that queued nothing says nothing (its skips are the same at every start).
   */
  function tellBacklog(watch: RepoWatchRecord, backlog: BacklogPlan | undefined) {
    if (!backlog?.queued.length) return
    options.notify(watch.sessionId, `The PR review watch of ${watch.directory} caught up. ${backlogText(backlog)}`)
  }

  async function tick() {
    if (ticking || stopped) return
    ticking = true
    try {
      // Jobs parked by a runner (a claim held elsewhere, a quota wait) join the waiting records outside `enqueueReview`.
      trimWaiting()
      // Recovered and backed-off jobs start here too, not only when a poll queues something.
      pump()
      if (options.enabled()) for (const watch of [...watches]) {
        if (stopped) break
        if (!options.sessionExists(watch.sessionId)) { watches = watches.filter((item) => item !== watch); continue }
        if (active(watch) && outageDue(watch) || retryDue(watch)) tellBacklog(watch, await poll(watch))
      }
    } finally {
      ticking = false
      save()
      arm()
    }
  }

  const roleText = (watch: RepoWatchRecord) => watch.role === "requested" ? `only PRs that request ${watch.login ? `@${watch.login}` : "you"} or route to that login's personal reviewer` :watch.role === "all" ? "every PR" : "role from the repo config"
  const waitingOf = (watch: RepoWatchRecord) => Object.values(watch.seen).filter((seen) => seen.waiting).length
  const skippedOf = (watch: RepoWatchRecord) => Object.entries(watch.seen).flatMap(([number, seen]) => seen.skipped ? [{ number: Number(number), reason: seen.skipped }] : [])
  /** At most three skip reasons per watch in `/pr list`, newest PRs first; the rest are counted. */
  const skippedText = (watch: RepoWatchRecord) => {
    const skipped = skippedOf(watch).toSorted((a, b) => b.number - a.number)
    if (!skipped.length) return ""
    return ` · ${skipped.length} not reviewed (${skipped.slice(0, 3).map((item) => `#${item.number}: ${item.reason}`).join("; ")}${skipped.length > 3 ? "; …" : ""})`
  }
  /** The jobs of a directory as `/pr list` counts them: queued for this daemon (the run queue) and waiting records. */
  const jobsText = (directory: string) => {
    const at = now()
    const open = ledger.list({ states: ["pending", "waiting"] }).filter((job) => job.directory === directory)
    const queued = open.filter((job) => runnable(job, at)).length, waiting = open.length - queued
    return queued || waiting ? ` · jobs: ${queued} queued, ${waiting} waiting (another device, a claim or a quota reset)` : ""
  }
  const describe = () => watches.length ? watches.map((watch) => `${watch.directory} · ${watch.ended ? `ended (${watch.ended.reason})` : watch.paused ? `paused (${watch.paused})` : "watching"} · ${roleText(watch)} · ${Object.keys(watch.seen).length} open PR${Object.keys(watch.seen).length === 1 ? "" : "s"}${waitingOf(watch) ? ` · ${waitingOf(watch)} waiting for the cooldown` : ""}${watch.ended ? "" : jobsText(watch.directory) + skippedText(watch)} · publish ${watch.publish ?? "not asked yet"}`).join("\n") : "no repository is watched"
  const rows = () => watches.map((watch) => ({ directory: watch.directory, role: watch.role ?? "config", state: watch.ended ? `ended (${watch.ended.reason})` : watch.paused ? "paused" : "watching", open: Object.keys(watch.seen).length, publish: watch.publish ?? "not asked", ...(watch.provider ? { provider: watch.provider } : {}) }))
  const find = (directory: string) => watches.find((watch) => watch.directory === directory && !watch.ended)

  /** This daemon's `gh` login, which `requested` matches; undefined when gh cannot say. */
  async function ownLogin(directory: string) {
    const forge = await options.forge?.(directory).catch(() => undefined)
    if (forge) {
      const login = await forge.provider.self?.().catch(() => undefined)
      return login && /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,254}$/.test(login) ? login : undefined
    }
    const done = await run({ argv: ["api", "user", "--jq", ".login"], cwd: directory }).catch(() => ({ code: 1, out: "", err: "" }))
    const login = done.code === 0 ? done.out.trim() : ""
    return /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : undefined
  }

  async function watchRepo(sessionId: string, directory: string, role?: RepoRole): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
    const existing = find(directory)
    if (existing && !existing.paused && (role === undefined || role === existing.role)) return { ok: true, text: `Already watching ${directory} (${roleText(existing)}).` }
    if (existing && !existing.paused && role) {
      if (role === "requested" && !existing.login) existing.login = await ownLogin(directory)
      if (role === "requested" && !existing.login) return { ok: false, message: "could not read your gh login (gh api user), which requested reviews are matched against" }
      existing.role = role
      save()
      return { ok: true, text: `Watching ${directory}: ${roleText(existing)} from now on.` }
    }
    if (existing?.paused) {
      // Not a new baseline: the PRs opened, the heads pushed and the comments written while it was paused are this poll's events.
      const reason = existing.paused
      const login = existing.login ?? await ownLogin(directory)
      if (role === "requested" && !login) return { ok: false, message: "could not read your gh login (gh api user), which requested reviews are matched against" }
      if (role) existing.role = role
      if (login) existing.login = login
      existing.sessionId = sessionId
      pauseTried.delete(existing)
      let backlog: BacklogPlan | undefined
      if (!ticking) { ticking = true; try { backlog = await poll(existing) } finally { ticking = false; save(); arm() } }
      else return { ok: true, text: `${directory} is being read now; the watch resumes by itself if gh works.` }
      const caught = backlogText(backlog ?? { off: true, queued: [], reviewed: [], open: [], skipped: [] })
      return existing.paused ? { ok: false, message: `could not list pull requests: ${existing.paused}` } : { ok: true, text: `Watching ${directory} again (${roleText(existing)}): it was paused (${reason}); the pull requests and @mendcode comments from the pause are read now.${caught ? ` ${caught}` : ""}` }
    }
    if (!existing && watches.filter((watch) => !watch.ended).length >= MAX_REPOS) return { ok: false, message: `at most ${MAX_REPOS} repositories are watched at once` }
    const forge = await options.forge?.(directory).catch(() => undefined)
    const found = await list(directory, forge)
    if (!found.ok) return { ok: false, message: `could not list pull requests: ${found.reason}` }
    // What is open now is the baseline: only a new PR or a new head after this moment starts a review.
    const login = existing?.login ?? await ownLogin(directory)
    if (role === "requested" && !login) return { ok: false, message: forge ? `could not read your ${forgeName(forge.kind)} login (GET /user), which requested reviews are matched against` : "could not read your gh login (gh api user), which requested reviews are matched against" }
    const me = login?.toLowerCase()
    const seen = Object.fromEntries(found.prs.map((pr) => [String(pr.number), { head: pr.headRefOid, draft: pr.isDraft === true, requested: !!me && [...(pr.reviewRequests ?? []), ...(pr.assignees ?? [])].some((who) => who.login?.toLowerCase() === me) }]))
    // A new watch of a directory keeps the answer a stopped one got: the user is asked once per repository.
    const answered = consentRecord(directory)
    const consent = { ...(answered?.publish ? { publish: answered.publish } : {}), ...(answered?.asked ? { asked: true } : {}) }
    const record: RepoWatchRecord = { ...consent, ...(existing ?? {}), directory, sessionId, createdAt: existing?.createdAt ?? now(), seen, ...(role ? { role } : {}), ...(login ? { login } : {}), ...(forge ? { provider: forge.kind, repo: forge.repo } : {}), catchUp: true }
    delete record.paused
    delete record.unreadableSince
    delete record.outage
    watches = withoutOldEnded([...watches.filter((watch) => watch !== existing), record])
    save()
    // With the platform, the first listing runs now, so the answer says which open PRs without a review of their current head it
    // queued (the backlog) and which it did not, and why. Busy with another listing, the next tick does it and says it in a notice.
    let backlog: BacklogPlan | undefined
    if (options.plan && !ticking) { ticking = true; try { backlog = await poll(record) } finally { ticking = false; save() } }
    arm()
    const caught = backlog && !backlog.off ? backlogText(backlog) || "None of them waits for a review." : undefined
    const opened = `${found.prs.length} open PR${found.prs.length === 1 ? "" : "s"}${caught === undefined ? ` ${found.prs.length === 1 ? "is" : "are"} the baseline.` : `. ${caught}`}`
    const minutes = Math.max(1, Math.round(interval / 60_000))
    const limits = (await options.limits?.(directory).catch(() => undefined)) ?? NO_LIMITS
    const effective = role ?? limits.reviewers
    const who = effective === "requested" ? `Only PRs that request a review from @${login} or are assigned to them are reviewed, and those .mendcode/reviewers.yaml routes to @${login}'s personal reviewer by area or label (never the global reviewer's). ` : ""
    const cooldown = limits.cooldown.pr_minutes || limits.cooldown.repo_per_hour < NO_LIMITS.cooldown.repo_per_hour ? `A PR is reviewed again after ${limits.cooldown.pr_minutes} minutes at its newest head, and at most ${limits.cooldown.repo_per_hour} reviews start per hour (cooldown in .mendcode/review.yaml). ` : ""
    return { ok: true, text: `Watching ${directory}${forge ? ` (${forgeName(forge.kind)}, ${forge.repo})` : ""}: ${opened} Every ${minutes} minute${minutes === 1 ? "" : "s"} ${cliOf(forge?.kind)} lists them; a new PR or a new push starts a review (no model call while nothing changes). ${who}${cooldown}Before the first post to this repository you are asked once.` }
  }

  function unwatchRepo(directory: string): { ok: true; text: string } | { ok: false; message: string } {
    const watch = find(directory)
    if (!watch) return { ok: false, message: `${directory} is not watched` }
    watch.ended = { at: now(), reason: "stopped" }
    for (let index = queue.length - 1; index >= 0; index--) if (queue[index]!.directory === directory) queue.splice(index, 1)
    // Reviews not started yet are dropped with the watch; one running ends as it would.
    for (const job of ledger.list({ states: ["pending", "waiting"] })) if (job.directory === directory) move(job.id, "cancelled", { error: "the repository watch was stopped" })
    save()
    arm()
    return { ok: true, text: `Stopped watching ${directory}.` }
  }

  /**
   * Whether a review of `directory` may post: `allowed` once the user said so, `denied` when they declined, `ask` the first time
   * (the caller asks in the session and the question is not asked again), `wait` while the question is open.
   */
  function publishConsent(directory: string): "allowed" | "denied" | "ask" | "wait" {
    const watch = consentRecord(directory)
    if (!watch) return "ask"
    if (watch.publish) return watch.publish
    if (watch.asked) return "wait"
    for (const item of watches) if (item.directory === directory) item.asked = true
    save()
    return "ask"
  }
  /** The record whose answer counts for a directory: its running watch, else its newest record. */
  const consentRecord = (directory: string) => find(directory) ?? watches.findLast((item) => item.directory === directory)
  /** The answer so far, without asking. */
  const consentOf = (directory: string) => consentRecord(directory)?.publish
  function setPublish(directory: string, sessionId: string, answer: "allowed" | "denied") {
    if (!watches.some((item) => item.directory === directory)) watches.push({ directory, sessionId, createdAt: now(), seen: {}, ended: { at: now(), reason: "not watched" } })
    // Every record of the directory holds the answer, so whichever one is read later agrees.
    for (const item of watches) if (item.directory === directory) item.publish = answer
    // Commands that waited for this answer are answered now, without waiting for the next poll.
    const running = find(directory)
    if (answer === "allowed" && running) offer(running)
    save()
  }

  /**
   * Whether a review job's result may still be published: false once the PR's head moved past it (marked `superseded`, or a
   * newer head already seen by the watch), or once it is stale or cancelled. The publisher asks right before it posts.
   */
  function isCurrent(jobId: string) {
    const job = ledger.get(jobId)
    if (!job || job.stop?.kind === "superseded" || job.state === "stale" || job.state === "cancelled") return false
    const seen = find(job.directory)?.seen[String(job.number)]
    return !job.head || !seen || seen.head === job.head
  }

  recoverJobs()
  arm()
  return {
    tick, watchRepo, unwatchRepo, describe, rows, publishConsent, consentOf, setPublish, isCurrent,
    /** The job ledger this watch schedules (the dashboard and the runners read and checkpoint it). */
    jobs: ledger,
    /** The slots now: the setting as it reads at this moment. */
    get concurrency() { return concurrency() },
    /** Starts due work now (a job re-queued by hand, a quota wait cut short), without waiting for the next poll. */
    kick: () => pump(),
    /**
     * A head MendCode itself pushed to PR `number` (a fix): taken as seen, so the next listing does not read it as a push that
     * needs a review (the fix mode reviews it itself) and the job that pushed it is still current.
     */
    adopt(directory: string, number: number, head: string) {
      const seen = find(directory)?.seen[String(number)]
      if (!seen || seen.head === head) return
      seen.previous = [...(seen.previous ?? []).filter((item) => item !== seen.head && item !== head), seen.head].slice(-10)
      seen.head = head
      delete seen.updatedAt
      save()
    },
    /**
     * Undoes `adopt` for a pushed fix the job could not review (the forge did not report its head in time): the watch takes `back`
     * (the head the fix was made on) as last seen again, so the listing that reports `head` is a push it reviews, as any other.
     */
    unadopt(directory: string, number: number, head: string, back: string) {
      const seen = find(directory)?.seen[String(number)]
      if (!seen || seen.head !== head) return
      seen.head = back
      seen.previous = (seen.previous ?? []).filter((item) => item !== back && item !== head)
      if (!seen.previous.length) delete seen.previous
      delete seen.updatedAt
      save()
    },
    /**
     * A maintainer's `@mendcode review` of `head`, which was already reviewed: kept on the PR (it survives a restart) so its next
     * head is reviewed even with `triggers.synchronize` off; answered once by that review, gone when the PR closes. False when
     * the watch does not follow the PR.
     */
    askNext(directory: string, number: number, ask: { head: string; by: string; comment: number }) {
      const seen = find(directory)?.seen[String(number)]
      if (!seen) return false
      seen.asked = { head: ask.head.slice(0, 64), by: ask.by.slice(0, 255), comment: ask.comment, at: now() }
      save()
      return true
    },
    /** The head the watch last read for PR `number` of `directory`; undefined when it does not follow that PR. */
    headOf: (directory: string, number: number) => find(directory)?.seen[String(number)]?.head,
    /** The running watch of `directory`: its effective role (unset: the repo config's), its login and repository. */
    watchOf: (directory: string) => { const watch = find(directory); return watch ? { role: watch.role, login: watch.login, repo: watch.repo, active: active(watch), sessionId: watch.sessionId, provider: watch.provider } : undefined },
    /** PRs of `directory` whose last event was not reviewed, with the reason (eligibility or routing). */
    skipped: (directory: string) => { const watch = find(directory); return watch ? skippedOf(watch) : [] },
    /** The `gh` login this daemon posts as in a watched directory: read once, then kept with the watch. */
    async loginOf(directory: string) {
      const watch = find(directory)
      if (watch?.login) return watch.login
      const login = await ownLogin(directory)
      if (watch && login) { watch.login = login; save() }
      return login
    },
    /** The open job a review of `head` (empty: the PR as it is now) by `reviewer` would join, or undefined when it would be a new one. */
    openReview: (directory: string, number: number, head: string, reviewer: string) => sameReview(directory, number, head, reviewer),
    /** A review asked for by hand (`/pr review`): a durable job queued behind the cap like any other; its id, unless the ledger is full. */
    review(job: Omit<RepoWatchJob, "kind" | "trigger">, assignment?: ReviewAssignment, forge?: { kind: WatchForge["kind"]; repo: string }) { return enqueueReview({ watch: find(job.directory), directory: job.directory, sessionId: job.sessionId, number: job.number, head: job.head, trigger: "manual", ...(assignment ? { assignment } : {}), ...(forge ? { forge } : {}) }) },
    /**
     * Running reviews and commands; those queued for a slot (the run queue: pending, backed-off and due reviews, queued commands);
     * and the waiting records this daemon does not run now (another device, a claim, a quota reset).
     */
    pending: () => {
      const at = now()
      const open = ledger.list({ states: ["pending", "waiting"] })
      return { running, queued: queue.length + open.filter((job) => runnable(job, at)).length, waiting: open.filter((job) => waitingRecord(job, at)).length }
    },
    /** The commands of `directory` that are kept, not answered yet. */
    commands: (directory: string) => (find(directory)?.commands ?? []).map((stored) => ({ id: stored.comment.id, number: stored.number, blocked: stored.blocked })),
    /** Stops polling and starting; the ledger keeps every job as it is, so the next start recovers what ran and runs what waited. */
    stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; if (wakeTimer) clearTimeout(wakeTimer); wakeTimer = undefined; queue.splice(0); save() },
  }
}
export type RepoWatchService = ReturnType<typeof createRepoWatch>
