import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import type { PrFinding, PrReviewConfigView, PrReviewDashboard, PrReviewerSummary, PrStopReason, PrTokenUsage } from "@mendcode/protocol"
import { cacheName, createIndexer } from "@mendcode/codegraph"
import { ghProcess, parseRef, type GhRun } from "../pr-watch"
import { createAccounting, accountingFile } from "./accounting"
import { createReviewActivity, type ReviewActivityJob } from "./activity"
import { runAudit } from "./audit"
import { backlogOrder, headReviewOf, planBacklog, type BacklogDecision, type HeadStatus, type ReviewAuthor } from "./backlog"
import { budgetPolicy, classifyStop, failureStop, quotaPlan, stopText } from "./budget"
import { gitRun, type GitRun } from "./context"
import { DEFAULT_REVIEW_CONFIG, mayRequest, readReviewConfig, reviewRole, type ReviewConfig } from "./config"
import { createConfigControl } from "./config-control"
import { effectKey, type JobCheckpoint, type Lease, type PlatformHandle, type PrFacts, type PrReviewAction, type ReviewerEntry, type ReviewerScope, type ReviewJob, type ReviewMemoryContext, type ReviewProvider, type RunPlatformInput, type StackGraph } from "./contracts"
import { createPlatformControl } from "./control"
import { deviceId } from "./device"
import { createEffectLedger } from "./effects"
import { eligible, needsFiles } from "./eligibility"
import type { ReviewSessionFactory } from "./engine"
import { openAfterRound, roundsFor, runFixLoop, type FixLoopOutcome } from "./fix-loop"
import { inLanguage } from "./sessions"
import { createJobLedger } from "./jobs"
import { claimMarker, createOwnership, MAX_CLAIM_TTL_MS, ownershipPath, parseClaims, pendingFor, prClaimKey, resolveClaims, type Claim } from "./ownership"
import { createPermissions } from "./permissions"
import { createProfileStore } from "./profile-store"
import { checkoutForge, forgeName, forgeProvider, gatedOff, parseRemoteUrl } from "./providers"
import { listAll, publishReview, publishThroughProvider, reviewerFromBody, reviewerMarker, type GhCall } from "./publish"
import { alreadyReviewedReply, explainFinding, failureFollowUp, filteredReply, hasWriteAccess, MAINTAINERS_ONLY, nothingNewReply, replyTo, REPLY_MARKER, runPrCommand, type CommandComment, type FixResult, type ReviewSummary } from "./commands"
import { pushKept, runFix, type FixSource } from "./fix"
import { answersRequest, answeredBy,answeredThrough, answersMarker, headReviewedBy, headReviewedThrough, isMendCodeReview, mayPublish, mayPublishThrough, type PublishCheck } from "./publishers"
import { readPullRequestInfo } from "./pull-request"
import { createOutbox } from "./outbox"
import { createHeldStore, type HeldReview } from "./held"
import { failureKind } from "./outage"
import { resolveReviewLanguage } from "./language"
import { githubEditor, providerEditor } from "./editors"
import { runDescribe, type ReviewSnapshot } from "./describe"
import { lacksText, mayDo, readRegistry, route, runsHere, type ReviewerRegistry } from "./registry"
import { createRepoWatch, listedToFacts, MAX_CONCURRENT_REVIEWS, MAX_OPEN_PRS, parseListedPr, PUBLISHER_RETRY_MS, routingReason, waitingAssignment, type JobOutcome, type RepoRole, type RepoWatchJob, type ReviewAssignment, type ReviewTrigger, type WatchPlan } from "./repo-watch"
import { buildStackGraph, stackChanges, stackSummary } from "./stacks"
import { controlOf, release, takeOver } from "./takeover"
import { runChecks } from "./verify"
import { layeredConfig, reviewNotice, runConfigKey, runPrReview, type ReviewProgress, type ReviewRun, type RunFallbacks, type RunPrReviewInput, type RunReaders } from "./run"
import { readReviewState, REVIEW_MARKER, stateFromMarkers, writeReviewState, type ReviewState } from "./state"

/**
 * The daemon's PR reviewer (docs/pr-review.md): the repo watch, `/pr review`, and the throwaway worktree each review reads. A review
 * runs as a durable job (`<dataDir>/pr-review/jobs.json`) of the daemon's job scheduler (`schedule`), at most `concurrency` (two)
 * at once. The head is fetched into `FETCH_HEAD` only and checked out detached in `<dataDir>/pr-review/worktrees/`, so the user's
 * checkout and branches are never touched; the worktree is removed when the review ends. Before the first post to a repository the
 * session is asked once (`/pr publish on|off`); until then findings stay in the session as a notice.
 *
 * The platform around one review (the review platform plan, wave 2):
 * - Shared ledgers under `<dataDir>/pr-review/`: jobs, effects (every post recorded before it is sent), accounting (tokens per PR
 *   head and attempt), personal profiles, ownership leases and this device's id.
 * - A job moves running → done | failed (`{ error, retry }`, so the watch backs off) | stale (its head moved; nothing posted) |
 *   checkpointed (a budget, quota or rate-limit stop keeps what was found; a quota or rate limit with `budget.on_quota: wait` waits in
 *   `waiting` until the reset and resumes from the checkpoint, without a second review pass).
 * - Each poll builds the stack graph, gates every PR event through `eligible` (the reason is kept per PR for `/pr list`, never a
 *   notice per PR: a `labels` repository skips most PRs) and routes it through `.mendcode/reviewers.yaml` on the checkout's HEAD.
 *   A repository without that file has the implicit global reviewer, plus `personal:<login>` for a `requested` watch.
 * - Automatic fix modes (`fix.mode` fix-once / fix-loop) run through `runFixLoop`; they push only with `fix.push` (and `fix.personal`
 *   for a personal reviewer) and the user's `/pr publish on`, otherwise the commit is kept on a local ref. `@mendcode fix` still
 *   pushes with `fixes: true`, as before.
 * - Forges: a checkout whose origin is GitLab or Gitea/Forgejo (`checkoutForge`: the remote, `mendcode.forge`, `mendcode.forgeUrl`)
 *   runs through its ReviewProvider (`forgeOf`): listing, views, head refs, permissions, posts, comments, replies, claims and fix
 *   push targets. GitHub keeps its `gh` path unchanged. What a forge lacks (`DAEMON_FEATURES`: check follow-ups and the hosted
 *   runner, thread resolution on Gitea) is said once in the `watch-repo` answer, never skipped silently.
 *
 * Personal reviewers across daemons and devices (R02, R04; decision 5):
 * - A PR routed to a personal reviewer that does not run here (another login's daemon, a device it is pinned to) is recorded as a
 *   `waiting` job with the reason ("waiting for @alice's MendCode ..."), never run and never a failure. That daemon finds the work
 *   from the provider when it starts (`pendingFor`). Every `CLAIM_REFRESH_MS` this daemon reads that PR's claims again to name the
 *   device working on it, and once that reviewer's own login submitted a review of the head the waiting job is closed as done there.
 * - Every review job (a personal reviewer's, and the global reviewer's: a PC and a VPS both watching with `all`) claims its PR
 *   before it runs: a local lease (`ownership.json`) and, only when posting to the repository is allowed (`/pr publish on` and
 *   `publishers`), a hidden marker comment posted through the effects ledger (kind `claim`; idempotent). Claims are read back from
 *   the PR's comments (only those written by the login the reviewer posts as count) and settled with `resolveClaims`: the winner
 *   runs, the loser waits naming the holder. A running job renews its claim every half of its TTL (the marker comment edited in
 *   place) and releases it when it ends; right before each write (`isCurrent` for a review post, `mayPush` for a fix) `writeGate`
 *   checks the fence and the PR's reviews of the head, and a device that was taken over writes nothing. Claims are best-effort, NOT
 *   compare-and-swap; the pre-write check and the effects ledger are what keep writes single. Without permission to post, the claim
 *   stays local and other devices cannot see it (and this daemon cannot post there either).
 * - `@mendcode review` and `fix` are held to the repository's filters and a personal profile's narrowing (`mentionRefusal`): one
 *   reply names the filter, no job runs. Replies go through the effects ledger (`ledgeredReply`): a comment is answered once.
 * - `@mendcode review` runs as a ledger job (trigger `comment`, one per reviewer and head: an open job of that head is reused)
 *   inside the command's slot; the comment is answered once: by the posted review, or by one reply.
 * - Eligibility of a personal reviewer uses the effective config with its personal profile (config-layers: a profile only narrows).
 */

/** `gh` with a request body on stdin, for `gh api --input -`. No shell; the user's own login. */
export const ghCall: GhCall = async ({ argv, stdin }) => {
  try {
    const child = Bun.spawn(["gh", ...argv], { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", NO_COLOR: "1" } })
    const timer = setTimeout(() => child.kill(), 30_000)
    try {
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { code: await child.exited, out: out.trim(), err: err.trim() }
    } finally { clearTimeout(timer) }
  } catch (error) { return { code: 127, out: "", err: error instanceof Error ? error.message : String(error) } }
}

/** One review run as the service calls it (run.ts `runPrReview`); a test may stand in for it. */
export type PlatformReview = (input: RunPrReviewInput) => Promise<ReviewRun>
/** The daemon's memory reader for one review (review-memory.ts `reviewMemoryContext`), bound to its store and settings. */
export type ReviewMemoryRead = (input: { scope: ReviewerScope; directory: string; login?: string | undefined; query: string; budgetTokens: number }) => ReviewMemoryContext | undefined | Promise<ReviewMemoryContext | undefined>

export type PrReviewServiceOptions = {
  dir: string
  run?: GhRun
  call?: GhCall
  git?: GitRun
  intervalMs?: number
  now?: () => number
  /** A clock that stops while the machine sleeps, for the watch's awake time (repo-watch.ts); the real one unless `now` is injected. */
  monotonic?: () => number
  enabled(): boolean
  /** Whether the code graph may index (`codegraph` on); without it reviews use the diff alone. */
  graphOn(): boolean
  sessionDirectory(sessionId: string): string | undefined
  sessionExists(sessionId: string): boolean
  /** Queues a notice when the session is free; `undefined` when it cannot take one now (the outbox holds it and offers it again). */
  notify(sessionId: string, text: string): unknown
  /** Review children for `owner` in `directory`. */
  sessions(owner: string, directory: string): ReviewSessionFactory
  /** The `@mendcode fix` session for `owner`: the default agent under the user's own permission mode. */
  editor(owner: string, directory: string): ReviewSessionFactory
  /**
   * The readers of `owner`'s reviews in `directory` (readers.ts): the install tier and the cheap model of the owner's provider with
   * its children's factory. Absent: data files get local summaries only.
   */
  readers?(owner: string, directory: string): RunReaders
  /** `fallback_models` of `owner`'s reviews in `directory`: a model entry as a session factory on the reviewer's own provider, or why not (fallback.ts). Absent: none. */
  fallbacks?(owner: string, directory: string): RunFallbacks
  /** Runs `job` on the daemon's job scheduler and resolves when it ends. */
  schedule(run: () => Promise<void>): Promise<void>
  /**
   * Reviews and commands running at once (default `MAX_CONCURRENT_REVIEWS`, two): the daemon passes the user's
   * `prReview.concurrency` setting as a function, read again at every start.
   */
  concurrency?: number | (() => number | undefined)
  /** The retry jitter of the job ledger's backoff; tests pin it. */
  random?: () => number
  /**
   * What a child session recorded (the store's `usage.recorded` events, summed as the review sessions add them: `input` with the
   * cached part), for a call a killed daemon left open; absent or undefined, only the unknown call is accounted.
   */
  sessionUsage?: (sessionId: string) => PrTokenUsage | undefined
  /**
   * One finished model turn of a review, fix or verify child, for `/usage` (the role `prReview`): the directory the reviewer works
   * for, the child session that ran it (its model is read there) and the tokens it reported, `input` with the cached part. The turn is
   * already in the days and models of the report as a turn of a hidden session; this says how much of them is the reviewer's.
   */
  reviewUsage?: (turn: { directory: string; childSessionId: string | undefined; tokens: PrTokenUsage }) => void
  /** The reviews running now with their steps, whole on every change (activity.ts); daemon.ts sends it to the local terminals. */
  activity?: (jobs: ReviewActivityJob[]) => void
  /** The memory a reviewer's scope allows (daemon.ts binds it to the store); absent, reviews get no memory context. */
  memory?: ReviewMemoryRead
  /** The model window of the owner session's model, for the per-call context budget; absent, the config or the default. */
  contextWindow?: (sessionId: string) => number | undefined
  /** `prReview.perfAttrib` (daemon.ts binds the setting): false turns the cost phase of MendCode's own pull requests off; read at every review. */
  perfAttrib?: () => boolean | undefined
  /** Overrides of the cost phase (tests stand in a runner and a timeout). */
  perf?: Partial<import("./perf").PerfOptions>
  /** Stands in for `runPrReview` (tests). */
  review?: PlatformReview
  /** Stands in for `runAudit` (tests). */
  audit?: typeof runAudit
  /** How long a job's claim on its pull request lasts (default `CLAIM_TTL_MS`); it is renewed every half of it while the job runs. Tests shorten it. */
  claimTtlMs?: number
  /** Waits between reads of a pushed fix's head (`HEAD_CONFIRM_DELAYS_MS`); tests stand in a clock that does not sleep. */
  sleep?: (ms: number) => Promise<void>
  /**
   * The GitLab or Gitea adapter of a checkout whose origin is one (tests stand in fakes); absent, the real one (`forgeProvider`:
   * the user's `glab` for GitLab, `GITEA_TOKEN` for Gitea).
   */
  providers?: (input: { kind: "gitlab" | "gitea"; baseUrl: string; repo: string; directory: string }) => ReviewProvider
}

/** How often the failing checks of one reviewed PR are read. */
export const FOLLOW_UP_MS = 5 * 60_000
/** At most this many tokens of memory context go into one review's prompt. */
export const REVIEW_MEMORY_TOKENS = 4_000
/** A watch's lease (`watch:<repo>` in ownership.json) lasts this long and is renewed once half of it is gone: two writes an hour. */
export const WATCH_LEASE_MS = 30 * 60_000
/**
 * A job's claim on one PR lasts this long. A running job renews it every half of it (the local lease, and the marker comment edited
 * in place when it was posted) and releases it when it ends; a job that starts with less than half of it left renews it at once.
 */
export const CLAIM_TTL_MS = 2 * 60 * 60_000
/** A job waiting for another daemon's reviewer reads that PR's claims and reviews again at most this often. */
export const CLAIM_REFRESH_MS = 10 * 60_000
/**
 * The waits between reads of a PR's head after MendCode pushed a fix to it: GitHub reports a pushed head a few seconds late, so the
 * fix's review waits for it (about 30 s in all) instead of reading the old head as a moved one.
 */
export const HEAD_CONFIRM_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000]
/** At most this many waiting jobs are refreshed per poll, and this many PRs' claims are read for one catch-up. */
const REFRESH_PER_POLL = 10
const CATCH_UP_CLAIM_READS = 20
/** At most this many PRs' changed files are read per catch-up for a reviewer that routes by area (the listing carries none). */
const CATCH_UP_FILE_READS = 20
/** A claim key's reviewer part allows no `:`; the implicit `personal:<login>` claims as `personal.<login>`. */
const CLAIM_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const claimIdOf = (reviewer: string) => CLAIM_ID.test(reviewer) ? reviewer : reviewer.toLowerCase().replace(/^personal:/, "personal.")
const sameLogin = (a: string | undefined, b: string | undefined) => !!a && !!b && a.replace(/^@/, "").toLowerCase() === b.replace(/^@/, "").toLowerCase()
const isoMinute = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC"

/** An `@mendcode review` whose job of that head runs already (here or on another device): the command waits for its post. */
class JobBusy extends Error {}

export const PR_REVIEW_DISABLED = "The PR reviewer is off: it reaches the network through gh and spends model calls, so turn it on with /experimental pr_review on (balanced tier or above)"

const View = (text: string) => { try { return JSON.parse(text) as { number?: number; headRefOid?: string; baseRefOid?: string; baseRefName?: string; isCrossRepository?: boolean; url?: string; title?: string; body?: string; files?: Array<{ path?: unknown }> } } catch { return {} } }
const SHA = /^[0-9a-f]{40}$/
const IN_FLIGHT: ReadonlySet<ReviewJob["state"]> = new Set(["running", "fixing", "validating"])
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^\[PR_REVIEW\]:\s*/, "")
/** A checkpoint with work in it: a resume verifies or publishes it instead of reviewing again. */
const hasProgress = (checkpoint: JobCheckpoint) => checkpoint.result !== undefined || checkpoint.candidates.length > 0 || checkpoint.completedPhases.length > 0
/** Where a started review is seen: the page, and its reviewer's session (`/reviews open`, as `/loop open` opens a loop's). */
const OPEN_HINT = (jobId: string) => `/reviews shows its phase; /reviews open ${jobId} opens its reviewer session.`
/** Platform triggers as eligibility knows them: a stack revalidation, a routing or a recovery is an automatic event like a push. */
/** A backlog PR is the `opened` event no watch saw: `triggers.opened`, the mode and the filters decide it as they would have. */
const eligibilityTrigger = (trigger: ReviewTrigger) => trigger === "stack" || trigger === "routed" || trigger === "recovered" ? "synchronize" as const : trigger === "backlog" ? "opened" as const : trigger

/** A load run once: every caller, concurrent ones included, gets the same promise and so the same value. */
export function sharedLoad<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | undefined
  return () => (loading ??= load())
}

export function createPrReviewService(options: PrReviewServiceOptions) {
  const run = options.run ?? ghProcess
  const call = options.call ?? ghCall
  const git = options.git ?? gitRun
  const now = options.now ?? Date.now
  const review = options.review ?? runPrReview
  const audit = options.audit ?? runAudit
  const activity = createReviewActivity({ now, emit: (jobs) => options.activity?.(jobs) })
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const root = path.join(options.dir, "pr-review")
  const outbox = createOutbox({ file: path.join(root, "outbox.json"), notify: options.notify, sessionExists: options.sessionExists })
  const realOutbox = outbox
  const held = createHeldStore(path.join(root, "held.json"))
  /** The last checkout step queued on each directory: parallel fetches and worktree adds on one `.git` fail on its locks. */
  const checkouts = new Map<string, Promise<unknown>>()

  // ── Shared ledgers (decision 2): one instance each, under <dataDir>/pr-review/ ─────────────────────────────────────────
  const ledger = createJobLedger({ file: path.join(root, "jobs.json"), now })
  const effects = createEffectLedger({ file: path.join(root, "effects.json"), now })
  const accounting = createAccounting({ file: accountingFile(options.dir), now })
  const permissions = createPermissions({ gh: call, now })
  const profiles = createProfileStore({ dataDir: options.dir, now })
  const ownership = createOwnership({ file: ownershipPath(options.dir), now })
  let device: string | undefined
  /** This daemon's device id, created on first use (`device.json`). */
  const deviceOf = () => device ??= deviceId(options.dir, { now }).id

  function oneAtATime<T>(directory: string, step: () => Promise<T>): Promise<T> {
    const next = (checkouts.get(directory) ?? Promise.resolve()).then(step, step)
    const settled = next.catch(() => undefined)
    checkouts.set(directory, settled)
    void settled.then(() => { if (checkouts.get(directory) === settled) checkouts.delete(directory) })
    return next
  }

  /** Moves a job, false when the ledger refuses (someone else moved it first: a cancel, a take-over, a newer head). */
  function move(id: string, state: ReviewJob["state"], patch: Partial<Omit<ReviewJob, "id" | "state">> = {}) {
    try { ledger.transition(id, state, patch); return true } catch { return false }
  }
  /** A patch on a job without moving it. */
  const patchJob = (id: string, patch: Partial<Omit<ReviewJob, "id" | "state">>) => { const job = ledger.get(id); return job ? move(id, job.state, patch) : false }

  /** A checkout whose origin is GitLab or Gitea: its kind, repository path and adapter. */
  type Forge = { kind: "gitlab" | "gitea"; repo: string; provider: ReviewProvider; name: string }
  const forges = new Map<string, Promise<Forge | undefined>>()
  /**
   * The GitLab or Gitea forge of a checkout (`checkoutForge`: its origin URL, or the kind `git config mendcode.forge` names), read
   * once per directory; undefined for GitHub and for an origin no adapter claims, which keep going through `gh` exactly as before.
   */
  function forgeOf(directory: string): Promise<Forge | undefined> {
    const known = forges.get(directory)
    if (known) return known
    const found = (async (): Promise<Forge | undefined> => {
      const detected = await checkoutForge({ directory, git })
      if (detected.kind !== "gitlab" && detected.kind !== "gitea") return undefined
      const provider = options.providers?.({ kind: detected.kind, baseUrl: detected.baseUrl, repo: detected.repo, directory }) ?? forgeProvider(detected, { git })
      return { kind: detected.kind, repo: detected.repo, provider, name: forgeName(detected.kind) }
    })().catch(() => undefined)
    forges.set(directory, found)
    return found
  }
  /** The forge of a job: its recorded provider, read from its checkout. */
  const forgeOfJob = (job: Pick<ReviewJob, "provider" | "directory">) => job.provider === "github" ? Promise.resolve(undefined) : forgeOf(job.directory)
  /** The forge's facts of PR `number`, or a thrown reason. */
  const forgeView = (forge: Forge, directory: string, number: number) => forge.provider.view({ directory, repo: forge.repo, number })
  /** `forge`'s login may write to its repository now (a fresh read). */
  const forgeMayWrite = async (forge: Forge, login: string | undefined) => !!login && ["admin", "write"].includes(await forge.provider.permission({ repo: forge.repo, login }).catch(() => "unknown"))
  /** The features gated off on a forge, said once when its watch starts (never skipped silently). */
  const gatedText = (forge: Forge | undefined) => forge ? ` ${forge.name} here: ${gatedOff(forge.kind).map((line) => line.replace(/^[^:]+: /, "")).join("; ")}.` : ""

  /** `owner/repo` of a directory's GitHub origin, through gh. */
  async function repoOf(directory: string) {
    const forge = await forgeOf(directory)
    if (forge) return forge.repo
    const done = await run({ argv: ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd: directory })
    // gh's own words go with it: they tell a network outage (waited out) from a repository that is gone (outage.ts).
    const said = done.code !== 0 ? done.err.split("\n").find((line) => line.trim())?.trim().slice(0, 160) : undefined
    if (done.code !== 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(done.out)) throw new Error(`[PR_REVIEW]: gh could not name the GitHub repository of ${directory}${said ? ` (${said})` : ""}`)
    return done.out
  }
  const repos = new Map<string, string>()
  const repoCached = async (directory: string) => { const known = repos.get(directory); if (known) return known; const repo = await repoOf(directory); repos.set(directory, repo); return repo }

  /** The current head of PR `number` on GitHub (GitLab, Gitea: through the adapter), or undefined when it cannot say. */
  async function remoteHead(directory: string, number: number) {
    const forge = await forgeOf(directory)
    if (forge) { const head = (await forgeView(forge, directory, number).catch(() => undefined))?.head; return head && SHA.test(head) ? head : undefined }
    const viewed =await run({ argv: ["pr", "view", String(number), "--json", "headRefOid"], cwd: directory }).catch(() => ({ code: 1, out: "", err: "" }))
    const head = viewed.code === 0 ? View(viewed.out).headRefOid : undefined
    return head && SHA.test(head) ? head : undefined
  }
  /**
   * Whether job `jobId` may still post: the watch has not seen its PR move past it (and it is neither stale nor cancelled), and
   * GitHub's head is still the job's head. A head gh cannot read leaves the watch's answer standing: a gh hiccup does not turn a
   * finished review into a stale one, and the effect ledger and the markers still stop a double post.
   */
  async function isCurrent(jobId: string) {
    const job = ledger.get(jobId)
    if (!job || !watch.isCurrent(jobId)) return false
    const head = await remoteHead(job.directory, job.number)
    if (head && job.head && head !== job.head) return false
    // Right before the post: this job still holds its claim (fence), and no other device posted this reviewer's review of the head.
    return (await writeGate(job, { review: true })).ok
  }

  /** The personal profile of `login` on `repo` (the personal layer), or undefined without one. */
  function personalLayer(repo: string, login: string | undefined) {
    if (!login) return undefined
    try { const profile = profiles.current({ provider: "github", repo, login }); return profile.exists ? profile.config : undefined } catch { return undefined }
  }

  /** The stack input of a stacked PR: its parent's head (the start of its own range) and the parent's open confirmed findings. */
  function stackOf(directory: string, repo: string, job: ReviewJob | undefined, number: number): RunPlatformInput["stack"] {
    const graph = graphs.get(directory)
    const parent = graph?.nodes.get(number)?.parent ?? job?.stack?.parent
    if (parent === undefined) return undefined
    const base = graph?.nodes.get(parent)?.head ?? watch.headOf(directory, parent)
    if (!base || !SHA.test(base)) return undefined
    const parentFindings = Object.values(readReviewState(options.dir, repo, parent).published).flatMap((entry) => entry.finding && !entry.resolved && entry.finding.verdict === "confirmed" ? [entry.finding] : [])
    return { base, parentFindings, parent }
  }

  /** Records one model turn of `job`: in the accounting ledger (per PR head and attempt) and on the job. Never throws. */
  const accountFor = (job: ReviewJob | undefined, repo: string, number: number, head: string): RunPlatformInput["account"] => job ? ({ purpose, tokens, sessionId }) => {
    try { accounting.record({ repo, number, head: head || job.head || "unknown", reviewer: job.reviewer, jobId: job.id, purpose, attempt: job.attempts + 1, input: tokens.input, output: tokens.output, cached: tokens.cached, unreported: tokens.unreported, ...(sessionId ? { sessionId, parentSessionId: job.sessionId } : {}) }) } catch { /* a bad report is dropped, the review goes on */ }
    try { ledger.addTokens(job.id, tokens, purpose === "read") } catch { /* the job may have been pruned */ }
    try { options.reviewUsage?.({ directory: job.directory, childSessionId: sessionId, tokens }) } catch { /* bookkeeping never stops a review */ }
  } : undefined
  /** The call `job` starts, kept on disk until it ends: one a killed daemon never ended is accounted as unknown at the next start. */
  const callingFor = (job: ReviewJob | undefined, repo: string, number: number, head: string): RunPlatformInput["calling"] => job ? ({ purpose, sessionId }) => {
    const id = accounting.begin({ repo, number, head: head || job.head || "unknown", reviewer: job.reviewer, jobId: job.id, purpose, attempt: job.attempts + 1, ...(sessionId ? { sessionId } : {}) })
    // The phase /reviews shows while the job runs: the review pass is `analysis`, the verify passes (and a resume's) `corroboration`.
    try { ledger.checkpoint(job.id, { phase: purpose === "review" ? "analysis" : purpose === "read" ? "readers" : "corroboration" }) } catch { /* the job may have been pruned */ }
    return () => accounting.end(id)
  } : undefined
  // Calls a previous process left open died with it: accounted now, unknown spend as unknown, plus what their child sessions recorded.
  for (const { jobId, tokens } of accounting.settleCutOff(options.sessionUsage)) {
    try { ledger.addTokens(jobId, tokens) } catch { /* the job may have been pruned */ }
  }

  /** Review children that tell the job their session id (`reviewSessionId`), so the page can open the review's session. */
  function recordedSessions(factory: ReviewSessionFactory, jobId: string | undefined): ReviewSessionFactory {
    if (!jobId) return factory
    return async (input) => {
      const session = await factory(input)
      const id = (session as { id?: unknown }).id
      if (input.purpose === "review" && typeof id === "string" && id.length <= 120) patchJob(jobId, { reviewSessionId: id })
      return session
    }
  }

  /** What the memory context of a review run reads: the daemon's reader bound to the job's scope, the watch's checkout and login. */
  const memoryFor = (scope: ReviewerScope, directory: string, login: string | undefined): RunPlatformInput["memory"] => {
    const read = options.memory
    if (!read) return undefined
    return async ({ title, files }) => read({ scope, directory, ...(login ? { login } : {}), query: [title, ...files.slice(0, 200)].join("\n"), budgetTokens: REVIEW_MEMORY_TOKENS })
  }

  /** `forge`: GitLab or Gitea by name, for what the session is told; unset on GitHub. */
  type Reviewed = ReviewRun & { repo: string; head: string; base: string; forge?: string | undefined }
  /**
   * Whether `head` was already reviewed whole under `configKey`: it is the review state's last head, with that config. A state an
   * older version wrote has no config key; then a finished job of that head that ran with it says which config it was.
   */
  function reviewedUnder({ repo, number, head, configKey, state }: { repo: string; number: number; head: string; configKey: string; state: ReviewState }): boolean {
    if (state.lastHead !== head) return false
    if (state.configKey !== undefined) return state.configKey === configKey
    // By number and head: a `/pr review` job names its checkout until a watch names the repository.
    return ledger.list({ number, states: ["done"] }).some((job) => job.head === head && job.coverage !== "audit" && job.configKey === configKey && (job.repo === repo || path.isAbsolute(job.repo)))
  }

  /** The config key a review of this PR would run under now (`runConfigKey`): its base branch's current tip, and the reviewer's personal layer. */
  async function configKeyNow({ directory, repo, base, baseRef, scope }: { directory: string; repo: string; base: string; baseRef: string | undefined; scope: ReviewerScope }): Promise<string> {
    const policy = baseRef && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(baseRef) && !baseRef.includes("..") ? await policyBase(directory, baseRef) : undefined
    const personal = scope === "personal" ? personalLayer(repo, await watch.loginOf(directory)) : undefined
    return runConfigKey({ policy: policy ?? base, layers: personal !== undefined ? { personal } : undefined })
  }

  /** `fresh`: the job's checkpoint is not handed to the run (the review of a pushed fix: a new head, its own range). */
  type ReviewOneInput = { sessionId: string; directory: string; number: number; publish: boolean; manual: boolean; job?: ReviewJob | undefined; fresh?: boolean; recheck?: readonly PrFinding[] | undefined; onlyNew?: boolean }
  /** One run of a job is live in the watching terminals from its fetch to its end, whatever the outcome (activity.ts). */
  async function reviewOne(input: ReviewOneInput): Promise<Reviewed> {
    const job = input.job
    if (!job) return reviewOneRun(input)
    activity.begin({ jobId: job.id, sessionId: input.sessionId, repo: job.repo, number: input.number })
    activity.step(job.id, { phase: "fetch", label: `Fetching #${input.number}`, ...(job.head ? { detail: `head ${job.head.slice(0, 8)}` } : {}) })
    try { return await reviewOneRun(input) } finally { activity.end(job.id) }
  }

  async function reviewOneRun({ sessionId, directory, number, publish, manual, job, fresh = false, recheck, onlyNew = false }: ReviewOneInput): Promise<Reviewed> {
    const repo = await repoOf(directory)
    const forge = await forgeOf(directory)
    // GitLab and Gitea: the adapter's facts in the shape gh prints (the MR's diff base is GitLab's `diff_refs.start_sha`).
    const viewed = forge
      ? await forgeView(forge, directory, number).then((facts) => ({ code: 0, out: JSON.stringify({ number, headRefOid: facts.head, baseRefOid: facts.base, baseRefName: facts.baseRef, url: facts.url, title: facts.title ?? "", body: facts.body ?? "" }) }), () => ({ code: 1, out: "" }))
      : await run({ argv: ["pr", "view", String(number), "--json", "number,headRefOid,baseRefOid,baseRefName,isCrossRepository,url,title,body"], cwd: directory })
    const pr = View(viewed.out)
    if (viewed.code !== 0 || !pr.headRefOid || !pr.baseRefOid || !SHA.test(pr.headRefOid) || !SHA.test(pr.baseRefOid)) throw new Error(`[PR_REVIEW]: ${forge ? forge.name : "gh"} could not read pull request #${number}`)
    const head = pr.headRefOid
    // The head moved while the job waited: nothing to review at the job's head, and the newer head has a job of its own.
    if (job?.head && job.head !== head) return { status: "skipped", reason: `the head of #${number} moved from ${job.head.slice(0, 12)} to ${head.slice(0, 12)}`, stale: true, state: readReviewState(options.dir, repo, number), incremental: false, repo, head, base: pr.baseRefOid }
    // A `/pr review` job is queued before its head is known: it is this head from now on.
    if (job && (!job.head || !job.base)) patchJob(job.id, { head, base: pr.baseRefOid, ...(pr.title ? { title: pr.title.slice(0, 300) } : {}), ...(pr.url && pr.url.length <= 500 ? { url: pr.url } : {}) })
    const base = pr.baseRefName && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(pr.baseRefName) && !pr.baseRefName.includes("..") ? pr.baseRefName : undefined
    // FETCH_HEAD only: no branch or remote-tracking ref of the user's checkout changes.
    const worktree = await oneAtATime(directory, async () => {
      const fetched = await git(["fetch", "--no-tags", "--quiet", "origin", forge ? forge.provider.headRef(number) : `refs/pull/${number}/head`, ...(base ? [`refs/heads/${base}`] : [])], directory)
      if (fetched.code !== 0) throw new Error(`[PR_REVIEW]: git fetch of pull request #${number} failed`)
      mkdirSync(path.join(root, "worktrees"), { recursive: true, mode: 0o700 })
      const created = mkdtempSync(path.join(root, "worktrees", `pr${number}-`))
      rmSync(created, { recursive: true, force: true })
      const added = await git(["worktree", "add", "--detach", "--quiet", created, head], directory)
      if (added.code !== 0) throw new Error(`[PR_REVIEW]: could not check out ${head.slice(0, 12)} in a worktree`)
      return created
    })
    const graphCache = `${worktree}.graph`
    try {
      const policy = base ? await policyBase(directory, base) : undefined
      const login = await watch.loginOf(directory)
      const known = readReviewState(options.dir, repo, number)
      // No saved state (another device, a wiped data dir) but this login's review is on the PR: its head marker is the last reviewed
      // head, so a push reviews what changed since it (run.ts `chooseRange` checks it is still in the branch) instead of the whole PR.
      const posted = known.lastHead || !login ? undefined : await reviewsOf(repo, number, directory).catch(() => undefined)
      const postedHead = posted ? stateFromMarkers({ reviews: (posted as Array<{ body?: string; submitted_at?: string; state?: string; user?: { login?: string } }>).filter((review) => review?.state !== "PENDING" && review?.state !== "DISMISSED" && sameLogin(review.user?.login, login)), comments: [] }).lastHead : undefined
      const state = postedHead ? { ...known, lastHead: postedHead } : known
      const current = job ? ledger.get(job.id) ?? job : undefined
      const scope = current?.scope ?? "global"
      const personal = scope === "personal" ? personalLayer(repo, login) : undefined
      const layers = personal !== undefined ? { personal } : undefined
      const configKey = runConfigKey({ policy: policy ?? pr.baseRefOid, layers })
      if (current && current.configKey !== configKey) patchJob(current.id, { configKey })
      const contextWindow = options.contextWindow?.(sessionId)
      const perfOptions = options.perfAttrib?.() === false ? undefined : { dir: path.join(root, "perf"), ...options.perf }
      const stack = stackOf(directory, repo, current, number)
      const checkpoint = !fresh && current && hasProgress(current.checkpoint) ? current.checkpoint : undefined
      // `onlyNew` (an `@mendcode review` comment): a head whose ancestor was reviewed with this same config is reviewed like a push
      // (the commits since, and the open findings re-checked); anything else, and every explicit `/pr review`, reviews the whole PR.
      const onlyNewCommits = onlyNew && !checkpoint && !!state.lastHead && state.lastHead !== head && state.configKey === configKey
      // `@mendcode review` on a head already reviewed with this config: nothing is new, so it is skipped before any model call.
      const nothingNew = onlyNew && !checkpoint && reviewedUnder({ repo, number, head, configKey, state })
      const reviewed = await review({
        // A watched repository that has not enabled publishing is still reviewed, into this session only: the user started the watch.
        repo, number, directory: worktree, base: pr.baseRefOid, head, ...(policy ? { policy } : {}), state, git, publish, force: true, full: manual && !onlyNewCommits && !nothingNew, onlyIfPublishable: !manual,
        publisher: { login, check: (config) => publisherOf(directory, repo, config.publishers) }, read: call,
        sessionFactory: recordedSessions(options.sessions(sessionId, worktree), current?.id),
        ...(options.readers ? { readers: options.readers(sessionId, worktree) } : {}),
        ...(options.fallbacks ? { fallbacks: options.fallbacks(sessionId, worktree) } : {}),
        // GitLab and Gitea: the title and the description the adapter read (linked issues are read through gh on GitHub), so
        // `template.language: auto` judges the language from both.
        pullRequest: forge ? { title: typeof pr.title === "string" ? pr.title : "", body: typeof pr.body === "string" ? pr.body : "", issues: [] } : await readPullRequestInfo({ gh: call, repo, title: typeof pr.title === "string" ? pr.title : "", body: typeof pr.body === "string" ? pr.body : "" }),
        ...(forge ? { provider: forge.provider } : publish ? { gh: call } : {}),
        // The cost phase of a MendCode pull request (perf.ts): GitHub only (a forge adapter says nothing of forks), unless the user turned it off.
        ...(!forge && perfOptions ? { perf: perfOptions, fork: pr.isCrossRepository === true } : {}),
        ...(options.graphOn() ? { graph: () => createIndexer({ cacheDir: graphCache, now: Date.now }).graph({ cwd: worktree, signal: AbortSignal.timeout(120_000) }) } : {}),
        ...(current ? { reviewer: { id: current.reviewer, scope, ...(login ? { login } : {}) } } : {}),
        ...(layers ? { layers } : {}),
        ...(current ? { memory: memoryFor(scope, directory, login), account: accountFor(current, repo, number, head), calling: callingFor(current, repo, number, head) } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(stack ? { stack } : {}),
        ...(current ? { publishAs: { effects, reviewer: current.reviewer, configKey, jobId: current.id, ...(login ? { self: login } : {}), isCurrent: () => isCurrent(current.id) } } : {}),
        ...(checkpoint ? { checkpoint } : {}),
        ...(recheck?.length ? { recheck } : {}),
        ...(current ? { progress: (step: ReviewProgress) => activity.step(current.id, step) } : {}),
      })
      // A partial review keeps the state of the last whole one (its head and config): it is not a review of this head.
      if (reviewed.status === "published") writeReviewState(options.dir, repo, number, reviewed.state.lastHead === head ? { ...reviewed.state, configKey } : reviewed.state)
      return { ...reviewed, repo, head, base: pr.baseRefOid, ...(forge ? { forge: forge.name } : {}) }
    } finally {
      await git(["worktree", "remove", "--force", worktree], directory)
      rmSync(worktree, { recursive: true, force: true })
      rmSync(graphCache, { recursive: true, force: true })
      // The reviewer's session indexed this worktree in the shared graph cache; it goes with the worktree.
      rmSync(path.join(options.dir, "codegraph", cacheName(worktree)), { force: true })
      await git(["worktree", "prune"], directory)
    }
  }

  /** Quota and rate-limit waits per job (count and since when), for `quotaPlan`'s limits; a restart starts the count again. */
  const waits = new Map<string, { count: number; since: number }>()

  /**
   * A run that stopped before it was complete: its checkpoint is kept, and a quota or rate limit that `quotaPlan` lets wait puts the
   * job in `waiting` until the reset (it resumes from the checkpoint then); any other stop leaves it `checkpointed` for a retry.
   * The session is told why, in `stopText`'s words. Nothing was published.
   */
  function checkpointJob({ job, stop, checkpoint, config, sessionId, label }: { job: ReviewJob; stop: PrStopReason; checkpoint?: JobCheckpoint | undefined; config?: ReviewConfig | undefined; sessionId: string; label: string }): JobOutcome {
    if (checkpoint) try { ledger.checkpoint(job.id, checkpoint) } catch { /* pruned meanwhile */ }
    const at = now()
    let until: number | undefined
    let planned = ""
    if (stop.kind === "quota" || stop.kind === "rate_limit") {
      const before = waits.get(job.id) ?? { count: 0, since: at }
      const plan = quotaPlan({ policy: budgetPolicy(config ?? DEFAULT_REVIEW_CONFIG, { contextWindow: options.contextWindow?.(job.sessionId) }), stop, now: at, waits: before.count, waitedMs: at - before.since })
      if (plan.action === "wait") { until = plan.until; waits.set(job.id, { count: before.count + 1, since: before.since }) } else waits.delete(job.id)
      planned = ` ${plan.reason[0]!.toUpperCase()}${plan.reason.slice(1)}.`
    }
    const tokens = ledger.get(job.id)?.tokens ?? job.tokens
    if (!move(job.id, "checkpointed", { stop })) return
    if (until !== undefined) move(job.id, "waiting", { notBefore: until })
    void outbox.say(sessionId, `${label} ${until !== undefined ? "waits" : "stopped"}.${planned}\n${stopText(stop, { now: at, jobId: job.id, tokens })}`)
    return undefined
  }

  /** The job as it ends when the review reported a stale head: `stale` with the reason, never published. */
  function staleJob(job: ReviewJob, reason: string | undefined) {
    if (job.state === "stale") return
    move(job.id, "stale", { stop: { kind: "superseded", detail: (reason ?? "the head moved before the review was posted").slice(0, 600), resumable: false } })
  }

  /**
   * A job's failure is told by the watch once it knows what happens next (the repository, PR and head, the reason, the retry time
   * or that it gave up: repo-watch `finish`). Only a review without a ledger job is told here.
   */
  const tellFailure = (job: ReviewJob | undefined) => !job

  /**
   * The registry entry of a job's reviewer, for its capabilities: `.mendcode/reviewers.yaml` at the checkout's HEAD, as the watch
   * routes. A reviewer the registry does not list (the implicit ones have every capability) keeps today's behaviour: undefined.
   */
  async function reviewerOf(job: Pick<ReviewJob, "directory" | "reviewer" | "scope">): Promise<ReviewerEntry | undefined> {
    const login = await watch.loginOf(job.directory).catch(() => undefined)
    const registry = await registryOf(job.directory, job.scope === "personal" ? "requested" : "all", login).catch(() => undefined)
    return registry?.reviewers.find((entry) => entry.id === job.reviewer)
  }

  /** One review job: review, ask once before the first post, notify the session, then the fix mode. */
  async function reviewJob(entry: Extract<RepoWatchJob, { kind: "review" }>): Promise<JobOutcome> {
    const job = entry.jobId ? ledger.get(entry.jobId) : undefined
    if (job?.coverage === "audit") return auditJob(job)
    if (job && IN_FLIGHT.has(job.state)) patchJob(job.id, { error: undefined, owner: job.owner ?? deviceOf() })
    if (job) withheld.delete(job.id)
    const reviewer = job ? await reviewerOf(job) : undefined
    if (job && IN_FLIGHT.has(job.state)) {
      // routing.offline_fallback: a stand-in waits for its time and yields to a personal reviewer that came back; a personal
      // reviewer whose stand-in works on, or reviewed, this head does not review it a second time.
      const fallback = await fallbackRefusal(job, { write: false }).catch((): FallbackRefusal => ({ ok: false, until: now() + 60_000, reason: "offline fallback: the pull request could not be read; asked again in a minute" }))
      if (fallback?.cancel) { move(job.id, "cancelled", { error: fallback.cancel }); return }
      if (fallback) { settleGate(job, fallback); return }
      // Another device of this reviewer holds the PR: wait for its claim to expire instead of reviewing it a second time; one that
      // already reviewed this head answers the job. A reviewer without `publish` keeps its claim on this device.
      const gate = await claimGate(job, mayDo(reviewer, "publish")).catch((): ClaimGate => ({ ok: true }))
      if (!gate.ok) { settleGate(job, gate); return }
      const assignment = ledger.get(job.id)?.assignment
      if (assignment !== routingReason(assignment)) patchJob(job.id, { assignment: routingReason(assignment) })
      if (job.covers?.length) await standInTakes(job)
    }
    try {
      const outcome = await reviewJobHeld(entry, job, reviewer)
      // A `/pr describe` that had to wait for this review: it goes on now, or says the review did not finish.
      if (job) await describeAfterReview(job.id, outcome === undefined)
      return outcome
    } finally { if (job) await releaseHold(job.id) }
  }

  /** `/pr describe` waiting for the review job it queued (or joined): where to write and where to say how it went. */
  const describeAfter = new Map<string, { sessionId: string; directory: string; number: number }>()
  async function describeAfterReview(jobId: string, finished: boolean) {
    const wanted = describeAfter.get(jobId)
    if (!wanted) return
    describeAfter.delete(jobId)
    if (!finished) { void outbox.say(wanted.sessionId, `/pr describe ${wanted.number}: the review did not finish, so nothing was described; /pr describe ${wanted.number} asks again.`); return }
    const done = await describeFromSession({ ...wanted, queue: false }).catch((error: unknown) => ({ ok: false as const, message: errorText(error) }))
    void outbox.say(wanted.sessionId, done.ok ? done.text : done.message)
  }

  /**
   * `/pr describe` from the terminal: the walkthrough of the last finished review of the PR's head goes into its description (and
   * title and label as `commands` allows). It writes to the pull request, so it needs what a review needs to post: `/pr publish on`,
   * the repository's `publishers` and the reviewer's `publish` capability. With no finished review it queues the normal one
   * (`queue`) and describes when it ends.
   */
  async function describeFromSession({ sessionId, directory, number, queue = true }: { sessionId: string; directory: string; number: number; queue?: boolean }): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
    const repo = await repoCached(directory)
    const config = await policyOf(directory, number)
    if (watch.consentOf(directory) !== "allowed") return { ok: false, message: `/pr describe writes to ${repo}#${number}: /pr publish on first (until then reviews stay in this session).` }
    const allowed = await publisherOf(directory, repo, config.publishers)
    if (!allowed.ok) return { ok: false, message: `/pr describe: ${allowed.reason}.` }
    const reviewer = await commandReviewer(directory)
    if (reviewer.entry && !mayDo(reviewer.entry, "publish")) return { ok: false, message: `/pr describe: ${lacksText(reviewer.entry, "publish")}.` }
    const forge = await forgeOf(directory)
    const editor = forge ? providerEditor({ provider: forge.provider, repo, number }) : githubEditor({ gh: call, repo, number })
    if (!editor.edit) return { ok: false, message: `/pr describe is not supported on ${editor.name}: its adapter cannot edit a pull request.` }
    const live = await editor.read()
    if (!live?.head) return { ok: false, message: `/pr describe: ${editor.name} did not return ${repo}#${number}.` }
    const review = lastReviewOf(repo, number, live.head)
    if (!review) {
      if (!queue) return { ok: false, message: `/pr describe ${number}: there is no finished review of ${live.head.slice(0, 12)} to write from; /pr review ${number} full, then /pr describe ${number}.` }
      const open = watch.openReview(directory, number, "", reviewer.id)
      const id = open?.id ?? watch.review({ directory, sessionId, number, head: "" }, { reviewer: reviewer.id, scope: reviewer.scope }, forge ? { kind: forge.kind, repo: forge.repo } : undefined)
      if (!id) return { ok: false, message: `/pr describe: the job ledger is full; try again later.` }
      describeAfter.set(id, { sessionId, directory, number })
      return { ok: true, text: `#${number} has no finished review of ${live.head.slice(0, 12)} yet: reviewing it (job ${id}), and the description is written when the review ends.` }
    }
    const done = await runDescribe({ review, current: live, editor, settings: { describeTitle: config.commands.describe_title } })
    return done.ok ? { ok: true, text: `${repo}#${number}: ${done.text}` } : { ok: false, message: `${repo}#${number}: ${done.text}` }
  }

  /**
   * `reviewJob` once its claim is settled: the review, its stop or failure, and the fix mode. A reviewer without the `publish`
   * capability reviews into this session only (nothing posted, nothing held for `/pr publish on`); one without `fix` runs no fix mode.
   */
  async function reviewJobHeld(entry: Extract<RepoWatchJob, { kind: "review" }>, job: ReviewJob | undefined, reviewer: ReviewerEntry | undefined): Promise<JobOutcome> {
    const { sessionId, directory, number, trigger } = entry
    const manual = trigger === "manual"
    // A job whose fix mode had started (a released take-over, a restart mid-fix) announced its review then: it is not said again.
    const announced = (job?.checkpoint.rounds.length ?? 0) > 0
    try {
      const allowed = watch.consentOf(directory) === "allowed"
      const publishes = mayDo(reviewer, "publish")
      const first = await reviewOne({ sessionId, directory, number, publish: allowed && publishes, manual, job })
      const label = `PR review of ${first.repo}#${number}`
      const current = job ? ledger.get(job.id) : undefined
      if (current && first.checkpoint && !first.stop) try { ledger.checkpoint(current.id, first.checkpoint) } catch { /* pruned */ }
      if (first.stale) {
        // Not a moved head: the write gate withheld the post (another device took the claim over, or posted this head already).
        const kept = current ? withheld.get(current.id) : undefined
        if (current && kept && !kept.ok) {
          void outbox.say(sessionId, `${label}: not posted from this device, ${kept.reason}.`)
          if (kept.retry) return { error: kept.reason, retry: true }
          settleGate(current, kept)
          return
        }
        if (current) staleJob(current, first.reason)
        if (manual) void outbox.say(sessionId, `${label}: not posted, ${first.reason ?? "the head moved"}; the newer head is reviewed by its own job.`)
        return
      }
      if (first.stop && current && first.status !== "failed") {
        void outbox.say(sessionId, reviewNotice({ repo: first.repo, number, run: first }))
        return checkpointJob({ job: current, stop: first.stop, checkpoint: first.checkpoint, config: first.config, sessionId, label })
      }
      if (first.status === "failed") {
        const kind = classifyStop(first.reason ?? "").kind
        // A failed model call on a quota or rate limit is a stop, not a failure: it waits or checkpoints like one.
        if (current && kind !== "error") return checkpointJob({ job: current, stop: failureStop(first.reason ?? "the model call failed", { now: now() }), checkpoint: first.checkpoint, config: first.config, sessionId, label })
        // A failure whose words say the network or a timeout (a model turn that timed out, a dropped connection) is the watch's to
        // judge: it waits without spending an attempt, or is tried again with backoff. Any other failure the run did not mark
        // retryable (a refusal of the forge, a review its verification rejected) is not tried again.
        const retry = first.retryable === true ? true : failureKind(first.reason ?? "") === "transient" ? undefined : false
        // A retryable failure keeps what it got to (a failed verifier's candidates): the retry resumes there, not at the review pass.
        if (current && retry && first.checkpoint) try { ledger.checkpoint(current.id, first.checkpoint) } catch { /* pruned */ }
        if (tellFailure(current)) void outbox.say(sessionId, reviewNotice({ repo: first.repo, number, run: first }))
        return { error: first.reason ?? "the review failed", retry }
      }
      if (current) waits.delete(current.id)
      if (first.status === "skipped" && !manual) return
      if (!announced) void outbox.say(sessionId, reviewNotice({ repo: first.repo, number, run: first }))
      if (!announced && !publishes && reviewer && first.status === "reviewed" && first.config?.enabled) void outbox.say(sessionId, `${label} stays in this session: ${lacksText(reviewer, "publish")}, so nothing is posted to the pull request and its claim stays on this device.`)
      // A review that could post but has no consent yet: ask once, hold it, post it when the answer is yes.
      if (!announced && publishes && !allowed && first.status === "reviewed" && first.config?.enabled && !first.notPublisher && first.outcome) holdReview({ sessionId, directory, number, run: first, jobId: current?.id })
      if (current && first.config && first.outcome && (first.status === "reviewed" || first.status === "published")) await autoFix({ job: current, run: first, sessionId, directory, number, reviewer })
      return
    } catch (error) {
      const message = errorText(error)
      const kind = classifyStop(message).kind
      const current = job ? ledger.get(job.id) : undefined
      if (current && kind !== "error" && IN_FLIGHT.has(current.state)) return checkpointJob({ job: current, stop: failureStop(message, { now: now() }), sessionId, label: `PR review of #${number}` })
      if (tellFailure(current)) void outbox.say(sessionId, `PR review of ${await repoCached(directory).catch(() => directory)}#${number} failed: ${message.replace(/^\[PR_REVIEW\]:\s*/, "")}. It is not tried again; /pr review ${number} runs it again.`)
      return { error: message }
    }
  }

  /**
   * Keeps a finished review that could not post for lack of consent (asked, still open, or declined) in `held.json` until
   * `/pr publish on`: it survives a daemon restart, and is posted as it was found (no second model call), only while its head is current.
   */
  function holdReview({ sessionId, directory, number, run: first, jobId }: { sessionId: string; directory: string; number: number; run: Reviewed; jobId?: string | undefined }) {
    const consent = watch.publishConsent(directory)
    const job = jobId ? ledger.get(jobId) : undefined
    held.add({
      sessionId, directory, repo: first.repo, number, head: first.head, result: first.outcome!.result, at: now(),
      ...(first.forge ? { forge: first.forge } : {}), ...(job ? { jobId: job.id } : {}), ...((first.configKey ?? job?.configKey) ? { configKey: (first.configKey ?? job?.configKey)! } : {}),
      ...(first.info ? { info: first.info } : {}), ...(first.config?.template.sections.length ? { template: first.config.template } : {}),
      ...(first.outcome?.sections ? { sections: first.outcome.sections } : {}),
    })
    if (consent === "ask") void outbox.say(sessionId, `MendCode has never posted a review to ${first.repo}. Type /pr publish on to post this review and later ones to ${first.forge ?? "GitHub"}, or /pr publish off to keep reviews in this session. You are asked once.`)
  }

  /** Posts a held review as it was found. A head that moved since is said and not posted. */
  async function postHeld(review: HeldReview) {
    const { sessionId, directory, number, repo } = review
    const job = review.jobId ? ledger.get(review.jobId) : undefined
    const live = await remoteHead(directory, number)
    if ((live && live !== review.head) || (review.jobId && !(await isCurrent(review.jobId)))) { void outbox.say(sessionId, `The held review of ${repo}#${number} was not posted: the pull request moved past ${review.head.slice(0, 12)}; its new head is reviewed on its own.`); return }
    const login = await watch.loginOf(directory)
    const forge = await forgeOf(directory)
    const common = {
      repo, number, result: review.result, previous: readReviewState(options.dir, repo, number), ...(review.info ? { info: review.info } : {}),
      ...(review.template ? { template: review.template as never } : {}), ...(review.sections ? { sections: review.sections } : {}),
      ...(job ? { effects, reviewer: job.reviewer, configKey: review.configKey ?? job.configKey, jobId: job.id, isCurrent: () => isCurrent(job.id) } : {}),
    }
    const report = forge ? await publishThroughProvider({ provider: forge.provider, ...common }) : await publishReview({ ...common, process: call, ...(job && login ? { self: login } : {}) })
    // With the config it ran under, as a review posted at once keeps it: a later `@mendcode review` or `/pr review` of this head knows it.
    const configKey = review.configKey ?? job?.configKey
    if (report.posted) writeReviewState(options.dir, repo, number, { ...report.state, ...(configKey ? { configKey } : {}) })
    void outbox.say(sessionId, report.posted ? `Posted the held review of ${repo}#${number} (${report.comments} inline comment${report.comments === 1 ? "" : "s"}).` : `The held review of ${repo}#${number} was not posted: ${report.reason ?? "unknown reason"}.`)
  }

  /**
   * The automatic fix mode after a review with open confirmed findings (`fix.mode` fix-once or fix-loop), through `runFixLoop` on
   * the job. It pushes only with `fix.push` (and `fix.personal` for a personal reviewer) once the user allowed posting to the
   * repository; otherwise each fix is committed and kept on a local ref. The first round fixes what this review found: no second
   * review pass. After a pushed fix the watch takes the new head as seen and the job reviews it itself (incremental: only the fix's
   * commits), once GitHub reports that head (`confirmedHead`, bounded); a head GitHub never reports in that time is handed back to the
   * watch (`unadopt`), which reviews it when it shows up, and the job says the fix was not reviewed instead of ending `done`. A round
   * a take-over interrupted before its push is continued after the release from its kept commit (`pushKept`), not counted twice.
   */
  async function autoFix({ job, run: first, sessionId, directory, number, reviewer }: { job: ReviewJob; run: Reviewed; sessionId: string; directory: string; number: number; reviewer?: ReviewerEntry | undefined }) {
    const config = first.config!
    if (config.fix.mode === "review") return
    const mode = config.fix.mode
    const confirmed = (result: Reviewed["outcome"]) => (result?.result.findings ?? []).filter((finding) => finding.verdict === "confirmed")
    const open = confirmed(first.outcome)
    if (!open.length) return
    // `capabilities` without `fix`: the fix mode never runs for this reviewer, whatever `fix.mode` says.
    if (reviewer && !mayDo(reviewer, "fix")) {
      void outbox.say(sessionId, `${first.repo}#${number}: fix mode ${mode} is not run on ${open.length} confirmed finding${open.length === 1 ? "" : "s"}: ${lacksText(reviewer, "fix")}.`)
      return
    }
    const publishes = mayDo(reviewer, "publish")
    const personal = job.scope === "personal"
    const push = config.fix.push && (!personal || config.fix.personal) && watch.consentOf(directory) === "allowed"
    const repo = first.repo
    const self = await watch.loginOf(directory)
    /** Why a fix is kept instead of pushed, or undefined when it is pushed. Each round re-reads whether the branch accepts pushes. */
    const keptBecause = (pushable: boolean) =>
      !config.fix.push ? "`fix.push` is off"
      : personal && !config.fix.personal ? "`fix.personal` is off for a personal reviewer"
      : watch.consentOf(directory) !== "allowed" ? "posting to this repository is not allowed yet (/pr publish on)"
      : !pushable ? "the branch lives in a fork that does not let maintainers push"
      : undefined
    // A failed read here is retried by the first round, which refuses to push when it cannot tell.
    const kept = keptBecause(await fixTarget(directory, number).then((target) => target.pushable, () => true))
    const findingsText = `${open.length} confirmed finding${open.length === 1 ? "" : "s"}`
    const where = kept === undefined ? "pushed to the branch" : `committed and kept locally, not pushed (${kept})`
    // A round a take-over interrupted: the release continues from it, and it is not counted against the rounds.
    const last = (ledger.get(job.id) ?? job).checkpoint.rounds.at(-1)
    const carried = last?.interrupted ? last : undefined
    let reviewed = false
    /** The head the last pushed fix was made on, so a late GitHub still reporting it is told from a head that moved past the fix. */
    let fixedFrom: string | undefined
    void outbox.say(sessionId, carried
      ? `${repo}#${number}: fix mode ${mode} continues after the take-over was released: ${carried.commit && carried.kept ? `the kept fix ${carried.commit.slice(0, 12)} (${carried.kept}) is ${where}` : `a new fix of the ${findingsText}, ${where}`}; the interrupted round is not counted.`
      : `${repo}#${number}: fix mode ${mode} on ${findingsText}; fixes are ${where}.`)
    const source = { kind: "mode" as const, mode }
    const guards = {
      stillOpen: () => stillOpen(repo, number, directory),
      mayPush: async (): Promise<true | string> => {
        // Fenced: a device that took this pull request over is the one that pushes; this one keeps its commit on a local ref.
        const gate = await writeGate(ledger.get(job.id) ?? job, { review: false })
        if (!gate.ok) return gate.reason
        return await mayWriteNow(directory, repo, self) ? true : `@${self ?? "this login"} has no write access to ${repo} now`
      },
      controlOf: () => controlOf(ledger, job.id),
    }
    /** A fix's result as the loop takes it: a pushed commit is the job's head from now on, a kept one says why it was kept. */
    const landed = (done: FixResult, target: Awaited<ReturnType<typeof fixTarget>>): FixResult => {
      if (done.ok && done.pushed) {
        // The new head is this job's from now on: the watch does not review it again, and the next round's post is current.
        fixedFrom = target.head
        patchJob(job.id, { head: done.commit })
        watch.adopt(directory, number, done.commit)
      }
      if (!done.ok || done.pushed) return done
      const notPushed = keptBecause(target.pushable)
      return notPushed ? { ...done, notPushed } : done
    }
    const fetchHead = async (target: Awaited<ReturnType<typeof fixTarget>>) => (await oneAtATime(directory, () => git(["fetch", "--no-tags", "--quiet", "origin", target.headRef], directory))).code === 0
    const outcome = await runFixLoop({
      // fix-once is one round whatever `fix.max_rounds` says; fix-loop runs up to it.
      jobId: job.id, ledger, maxRounds: roundsFor(mode, config.fix.max_rounds), maxNoProgress: config.phases.max_rounds_without_progress, now,
      controlOf: () => controlOf(ledger, job.id),
      review: async (fixing) => {
        if (!reviewed) { reviewed = true; return { open } }
        const pushed = ledger.get(job.id)?.head ?? job.head
        const seen = await confirmedHead({ directory, number, head: pushed, from: fixedFrom })
        if (!seen.ok) {
          // Never reported: the watch takes the pushed head back as unseen, so the listing that reports it queues its review.
          if (!seen.moved && fixedFrom) watch.unadopt(directory, number, pushed, fixedFrom)
          return { open: [...fixing], unreviewed: { reason: seen.reason, ...(seen.moved ? { stale: true } : {}) } }
        }
        // The findings the round set out to fix are re-checked with the published ones: the round resolves only what that closed.
        const again = await reviewOne({ sessionId, directory, number, publish: publishes && watch.consentOf(directory) === "allowed", manual: false, job: ledger.get(job.id), fresh: true, recheck: fixing })
        if (again.stale || again.status === "skipped") return { open: [...fixing], unreviewed: { reason: again.reason ?? "the review of the pushed head was skipped", ...(again.stale ? { stale: true } : {}) } }
        if (again.status === "failed" || again.stop) throw new Error(`[PR_REVIEW]: the review after the fix ${again.stop ? `stopped (${again.stop.kind})` : "failed"}: ${again.reason ?? again.stop?.detail ?? "unknown"}`)
        return { open: openAfterRound({ fixing, found: confirmed(again.outcome), fixed: again.fixed }) }
      },
      fix: async (findings: PrFinding[]) => {
        const target = await fixTarget(directory, number)
        if (!await fetchHead(target)) return { ok: false, reason: `git fetch of pull request #${number} failed` }
        const done = await runFix({
          directory, root, number, head: target.head, branch: target.branch, pushUrl: target.pushUrl, findings, git, now, source,
          instructions: `Fix the ${findings.length === 1 ? "confirmed finding" : `${findings.length} confirmed findings`} of MendCode's review of this pull request.`,
          // The fix's commit message and its notes are public like the review: in the repository's review language.
          checks: target.config.checks, runChecks: (dir, commands) => runChecks({ directory: dir, commands }), sessions: (worktree) => inLanguage(options.editor(sessionId, worktree), config.template.language),
          push: push && target.pushable, ...guards,
          onSession: (id) => patchJob(job.id, { fixSessionId: id }),
        })
        return landed(done, target)
      },
      resumeKept: async ({ commit, kept: ref }) => {
        const target = await fixTarget(directory, number)
        if (!await fetchHead(target)) return { ok: false, commit, kept: ref, reason: `git fetch of pull request #${number} failed` }
        const done = await pushKept({ directory, number, head: target.head, branch: target.branch, pushUrl: target.pushUrl, git, commit, kept: ref, push: push && target.pushable, ...guards })
        return done && landed(done, target)
      },
      // `runFix` runs the repository's checks on every fix and refuses a fix that fails them: the validation already happened there.
      validate: async () => ({ ok: true, detail: config.checks.length ? "the repository's checks passed on each fix" : "no checks are configured" }),
    }).catch((error: unknown): FixLoopOutcome => ({ state: "failed", rounds: 0, open: [], stop: { kind: "error", detail: errorText(error).slice(0, 600), resumable: false } }))
    // The stop names the findings left (`path:line`); the counts are said without one.
    const named = !outcome.unreviewed && outcome.stop?.remaining?.includes("still open") ? outcome.stop.remaining : undefined
    const left = outcome.open.length ? `, ${named ?? `${outcome.open.length} confirmed finding${outcome.open.length === 1 ? "" : "s"} ${outcome.unreviewed ? "not checked again after the fix" : "still open"}`}` : ""
    void outbox.say(sessionId, `${repo}#${number}: fix mode ended ${outcome.state} after ${outcome.rounds} round${outcome.rounds === 1 ? "" : "s"}${left}${outcome.kept ? `; the last fix is kept as ${outcome.kept}` : ""}${outcome.stop ? `: ${outcome.stop.detail}` : ""}.`)
  }

  /**
   * Waits until the forge reports `head` (a fix MendCode just pushed) as PR `number`'s head: GitHub reports a push a few seconds
   * late, and reviewing then would read the old head as a moved one. Reads at once, then after each of `HEAD_CONFIRM_DELAYS_MS`.
   * `moved`: the forge reports a third head (someone pushed on top of the fix); its own job reviews it, the fix's commits included.
   */
  async function confirmedHead({ directory, number, head, from }: { directory: string; number: number; head: string; from: string | undefined }): Promise<{ ok: true } | { ok: false; reason: string; moved?: true }> {
    let last: string | undefined
    for (let attempt = 0; ; attempt++) {
      last = await remoteHead(directory, number)
      if (last === head) return { ok: true }
      if (last && last !== from) return { ok: false, moved: true, reason: `the head of #${number} moved past it to ${last.slice(0, 12)} before its review; that head's review covers it` }
      const delay = HEAD_CONFIRM_DELAYS_MS[attempt]
      if (delay === undefined) break
      await sleep(delay)
    }
    const waited = Math.round(HEAD_CONFIRM_DELAYS_MS.reduce((sum, ms) => sum + ms, 0) / 1000)
    const forge = (await forgeOf(directory))?.name ?? "GitHub"
    return { ok: false, reason: `${last ? `${forge} still reported ${last.slice(0, 12)} as the head` : `${forge} could not say the head`} after ${waited} s, so it was not reviewed here; the watch reviews it once ${forge} reports it` }
  }

  /** Whether PR `number` is still open on GitHub (GitLab, Gitea: through the adapter), read fresh before a push. */
  async function stillOpen(repo: string, number: number, directory: string) {
    const forge = await forgeOf(directory)
    if (forge) return (await forgeView(forge, directory, number).catch(() => undefined))?.open === true
    const done = await call({ argv: ["api", `repos/${repo}/pulls/${number}`, "--jq", ".state"] })
    return done.code === 0 && done.out.trim() === "open"
  }
  /** This daemon's login may write to `repo` now (a fresh read: GitHub's collaborator permission, or the forge's). */
  async function mayWriteNow(directory: string, repo: string, self: string | undefined) {
    const forge = await forgeOf(directory)
    if (forge) return forgeMayWrite(forge, self)
    return !!self && await permissions.mayWrite(repo, self, { fresh: true })
  }

  /**
   * A fork's push URL on GitLab or Gitea: the checkout's origin URL as written (its scheme, host, port and user, so the same git
   * credentials apply) with the fork's repository path in place of the base's.
   */
  async function forkPushUrl(directory: string, forkRepo: string) {
    const origin = await git(["config", "--get", "remote.origin.url"], directory)
    const url = origin.code === 0 ? origin.out.trim() : ""
    const remote = parseRemoteUrl(url)
    if (!remote || !/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(forkRepo)) throw new Error("[PR_REVIEW]: invalid fork repository")
    const at = url.lastIndexOf(remote.path)
    if (at < 0) throw new Error("[PR_REVIEW]: the origin URL does not name its repository path")
    return `${url.slice(0, at)}${forkRepo}${url.slice(at + remote.path.length)}`
  }

  /** `@mendcode fix`: the PR's branch, where it lives, and the base config's checks and `fixes`. */
  async function fixTarget(directory: string, number: number) {
    const forge = await forgeOf(directory)
    if (forge) {
      const target = await forge.provider.pushTarget?.({ repo: forge.repo, number })
      if (!target || !SHA.test(target.head) || !SHA.test(target.base) || (await git(["check-ref-format", "--branch", target.branch], directory)).code !== 0) throw new Error(`[PR_REVIEW]: ${forge.name} could not read pull request #${number}`)
      const { config } = await readReviewConfig({ directory, base: target.base, head: target.base, git, forge: forge.kind })
      return { branch: target.branch, head: target.head, pushUrl: target.fork ? await forkPushUrl(directory, target.repo) : "origin", pushable: target.pushable, config, headRef: forge.provider.headRef(number) }
    }
    const viewed = await run({ argv: ["pr", "view", String(number), "--json", "headRefName,headRefOid,baseRefOid,isCrossRepository,maintainerCanModify,headRepository,headRepositoryOwner"], cwd: directory })
    let pr: { headRefName?: string; headRefOid?: string; baseRefOid?: string; isCrossRepository?: boolean; maintainerCanModify?: boolean; headRepository?: { name?: string }; headRepositoryOwner?: { login?: string } } = {}
    try { pr = JSON.parse(viewed.out) } catch { /* checked below */ }
    if (viewed.code !== 0 || !pr.headRefName || !SHA.test(pr.headRefOid ?? "") || !SHA.test(pr.baseRefOid ?? "") || (await git(["check-ref-format", "--branch", pr.headRefName], directory)).code !== 0) throw new Error(`[PR_REVIEW]: gh could not read pull request #${number}`)
    const fork = pr.isCrossRepository === true
    const owner = pr.headRepositoryOwner?.login ?? "", name = pr.headRepository?.name ?? ""
    if (fork && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || fork && !/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new Error("[PR_REVIEW]: invalid fork repository")
    const { config } = await readReviewConfig({ directory, base: pr.baseRefOid!, head: pr.baseRefOid!, git, forge: "github" })
    return { branch: pr.headRefName, head: pr.headRefOid!, pushUrl: fork ? `https://github.com/${owner}/${name}.git` : "origin", pushable: !fork || pr.maintainerCanModify === true, config, headRef: `refs/pull/${number}/head` }
  }

  const publishers = new Map<string, { at: number; check: PublishCheck }>()
  /** Whether this daemon's login may post to `repo` (`publishers` in the repo config), asked at most every ten minutes per repository. */
  async function publisherOf(directory: string, repo: string, rule: ReviewConfig["publishers"]): Promise<PublishCheck> {
    const key = `${directory}\n${JSON.stringify(rule)}`
    const at = now()
    const known = publishers.get(key)
    if (known && at - known.at < 600_000) return known.check
    const forge = await forgeOf(directory)
    const check = forge ? await mayPublishThrough({ provider: forge.provider, repo, login: await watch.loginOf(directory), rule }) : await mayPublish({ gh: call, repo, login: await watch.loginOf(directory), rule })
    publishers.set(key, { at, check })
    return check
  }
  /** The checkout's forge for its config's logins (`reviewers`, `publishers`): GitLab, Gitea, else GitHub. */
  const loginForge = async (directory: string) => (await forgeOf(directory))?.kind ?? "github"
  const baseConfig = async (directory: string) => (await readReviewConfig({ directory, base: "HEAD", head: "HEAD", git, forge: await loginForge(directory) })).config

  /**
   * The current tip of `branch` on origin, its objects fetched into FETCH_HEAD only. The repository's policy (`enabled`,
   * `publishers`, `reviewers`) is read there: the base GitHub reports for a PR is the one of its last push, and on
   * a watched repository it predated the commit that added `.mendcode/review.yaml`. Undefined when origin cannot say.
   */
  async function policyBase(directory: string, branch: string) {
    const listed = await git(["ls-remote", "--quiet", "origin", `refs/heads/${branch}`], directory)
    const tip = listed.code === 0 ? /^([0-9a-f]{40})\s/.exec(listed.out)?.[1] : undefined
    if (!tip) return undefined
    const local = async () => (await git(["cat-file", "-e", `${tip}^{commit}`], directory)).code === 0
    if (await local()) return tip
    await oneAtATime(directory, () => git(["fetch", "--no-tags", "--quiet", "origin", `refs/heads/${branch}`], directory))
    return await local() ? tip : undefined
  }
  /** The policy for one PR: its base branch's current config, else the one at its recorded base, else the checkout's. */
  async function policyOf(directory: string, number: number): Promise<ReviewConfig> {
    const forge = await forgeOf(directory)
    const viewed = forge
      ? await forgeView(forge, directory, number).then((facts) => ({ code: 0, out: JSON.stringify({ baseRefName: facts.baseRef, baseRefOid: facts.base }) }), () => ({ code: 1, out: "" }))
      : await run({ argv: ["pr", "view", String(number), "--json", "baseRefName,baseRefOid"], cwd: directory })
    let pr: { baseRefName?: string; baseRefOid?: string } = {}
    try { pr = viewed.code === 0 ? JSON.parse(viewed.out) : {} } catch { /* the checkout's config below */ }
    const branch = pr.baseRefName && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(pr.baseRefName) && !pr.baseRefName.includes("..") ? pr.baseRefName : undefined
    const at = (branch ? await policyBase(directory, branch) : undefined) ?? (SHA.test(pr.baseRefOid ?? "") ? pr.baseRefOid : undefined)
    if (at && (await git(["cat-file", "-e", `${at}^{commit}`], directory)).code === 0) return (await readReviewConfig({ directory, base: at, head: at, git, forge: forge?.kind ?? "github" })).config
    return baseConfig(directory)
  }

  /** The open jobs of one PR, newest first: a command acts on them (take-over control, the fix session). */
  const openJobsOf = (repo: string, number: number) => ledger.list({ repo, number, states: ["pending", "waiting", "running", "fixing", "validating", "checkpointed", "paused"] }).toSorted((a, b) => b.createdAt - a.createdAt)

  /**
   * `@mendcode review` as a ledger job (trigger `comment`), run inside the command's slot so the command can answer from its result.
   * The reviewer is the watch's: the login's personal reviewer for a `requested` watch, else the repository's default global one.
   * One job per reviewer and head: an open job of that head is taken over (a pending or backed-off one runs now, a checkpointed
   * one resumes from its checkpoint); one running, or claimed by another device, throws `JobBusy` and the command waits for its
   * post. A daemon stopped mid-run leaves the job `running`: the next start recovers it and the kept command finds its review.
   */
  /**
   * The reviewer that answers this checkout's `@mendcode` comments: the login's personal reviewer for a `requested` watch, else the
   * repository's default global one. `entry`: its registry entry (capabilities), absent for the implicit global reviewer.
   */
  async function commandReviewer(directory: string): Promise<{ id: string; scope: ReviewerScope; entry?: ReviewerEntry | undefined }> {
    const info = watch.watchOf(directory)
    const login = await watch.loginOf(directory)
    const personal = info?.role === "requested" && !!login
    const registry = await registryOf(directory, personal ? "requested" : "all", login).catch(() => undefined)
    const entry = personal ? (registry ? personalOf(registry, login!) : implicitPersonal(login!)) : registry?.reviewers.find((item) => item.id === registry.routing.default && item.scope === "global")
    return entry ? { id: entry.id, scope: entry.scope, entry } : { id: "global", scope: "global" }
  }

  /** The newest finished review of `head` as the job ledger kept it (its result holds the walkthrough and the findings). */
  function lastReviewOf(repo: string, number: number, head: string): ReviewSnapshot | undefined {
    const job = lastReviewJob(repo, number, head)
    return job?.checkpoint.result ? { head, result: job.checkpoint.result } : undefined
  }

  /** The job behind `lastReviewOf`: its result, and `updatedAt` for when it finished. */
  function lastReviewJob(repo: string, number: number, head: string): ReviewJob | undefined {
    return ledger.list({ repo, number, states: ["done", "running", "fixing", "validating"] }).filter((item) => item.coverage !== "audit" && !item.stop && item.checkpoint.result?.head === head).toSorted((a, b) => b.updatedAt - a.updatedAt)[0]
  }

  async function commentReview({ sessionId, directory, repo, number, head, actor, full = false }: { sessionId: string; directory: string; repo: string; number: number; head: string; actor: string; full?: boolean }): Promise<ReviewSummary> {
    const reviewer = await commandReviewer(directory)
    // `capabilities` without `publish`: the review is made, into this session only, and its claim is not posted either.
    const publishes = mayDo(reviewer.entry, "publish")
    const open = openJobsOf(repo, number).find((job) => job.reviewer === reviewer.id && job.head === head && job.coverage !== "audit")
    if (open && (IN_FLIGHT.has(open.state))) throw new JobBusy(`job ${open.id} reviews this head now`)
    if (open?.state === "paused") return { status: "skipped", reason: `the review of this head is paused (job ${open.id}); resume it from /reviews`, posted: false }
    const asked = `@mendcode review from @${actor}`
    let job: ReviewJob
    if (open) {
      if (open.state === "checkpointed" && !move(open.id, "pending")) throw new JobBusy(`job ${open.id} moved meanwhile`)
      if (!move(open.id, "running", { trigger: "comment", notBefore: undefined, owner: deviceOf(), assignment: `${asked}; ${routingReason(open.assignment) ?? ""}`.replace(/; $/, "").slice(0, 400) })) throw new JobBusy(`job ${open.id} moved meanwhile`)
      job = ledger.get(open.id)!
    } else {
      job = ledger.upsert({ provider: (await forgeOf(directory))?.kind ?? "github", repo, directory, number, sessionId, reviewer: reviewer.id, scope: reviewer.scope, assignment: asked.slice(0, 400), trigger: "comment", coverage: "full", base: "", head, configKey: "", owner: deviceOf(), state: "running" })
      if (job.state !== "running") throw new JobBusy(`job ${job.id} is ${job.state}`)
    }
    withheld.delete(job.id)
    const gate = await claimGate(job, publishes).catch((): ClaimGate => ({ ok: true }))
    // Held by, or already reviewed on, another device: the comment waits and is answered by that device's review.
    if (!gate.ok) { settleGate(job, gate); throw new JobBusy(gate.reason) }
    try {
      const done = await reviewOne({ sessionId, directory, number, publish: publishes, manual: true, job, onlyNew: !full })
      if (done.incremental && ledger.get(job.id)?.coverage === "full") patchJob(job.id, { coverage: "incremental" })
      // Nothing new on a new head posts no review, but this command's reply (a comment) says so: the notice must not say nothing was posted.
      const answeredByComment = done.status === "published" && !!done.report && !done.report.posted && !done.report.duplicate
      void outbox.say(sessionId, reviewNotice({ repo, number, run: answeredByComment ? { ...done, reason: "no new review was posted; one comment on the pull request says there is nothing new" } : done }))
      const local = !publishes && reviewer.entry && done.status === "reviewed" ? `the review stays in the reviewer's MendCode session: ${lacksText(reviewer.entry, "publish")}` : undefined
      if (local) void outbox.say(sessionId, `PR review of ${repo}#${number} stays in this session: ${lacksText(reviewer.entry!, "publish")}, so nothing is posted to the pull request and its claim stays on this device.`)
      const current = ledger.get(job.id)
      const kept = withheld.get(job.id)
      if (done.stale && current && kept && !kept.ok && IN_FLIGHT.has(current.state)) {
        if (kept.retry) { move(job.id, "failed", { attempts: current.attempts + 1, error: kept.reason.slice(0, 2000) }); throw new JobBusy(kept.reason) }
        // What it found is kept: a parked job that runs again publishes it without a second review pass.
        if (done.checkpoint) try { ledger.checkpoint(job.id, done.checkpoint) } catch { /* pruned */ }
        settleGate(current, kept)
        throw new JobBusy(kept.reason)
      }
      if (current && IN_FLIGHT.has(current.state)) {
        if (done.stale) staleJob(current, done.reason)
        else if (done.stop && done.status !== "failed") checkpointJob({ job: current, stop: done.stop, checkpoint: done.checkpoint, config: done.config, sessionId, label: `PR review of ${repo}#${number}` })
        // Answered by one reply saying it failed: not retried behind the comment's back, `@mendcode review` again or /reviews retries it.
        else if (done.status === "failed") {
          // A retryable failure keeps its checkpoint, so `/reviews` retry or the next `@mendcode review` resumes from it.
          if (done.retryable && done.checkpoint) try { ledger.checkpoint(job.id, done.checkpoint) } catch { /* pruned */ }
          move(job.id, "failed", { attempts: current.attempts + 1, error: (done.reason ?? "the review failed").slice(0, 2000) })
        }
        else {
          if (done.checkpoint) try { ledger.checkpoint(job.id, done.checkpoint) } catch { /* pruned */ }
          move(job.id, "done")
        }
      }
      // Published with nothing new on a new head posts no review: the reply then names the head and the earlier findings' state.
      const report = done.report
      const nothingNew = done.status === "published" && report && !report.posted && !report.duplicate ? nothingNewReply({ head, resolved: report.resolved, state: report.state }) : undefined
      // A head already reviewed ran nothing: the reply gives that review's result, never just "skipped".
      const before = done.status === "skipped" && done.reviewedBefore ? lastReviewJob(repo, number, head) : undefined
      const already = done.status === "skipped" && done.reviewedBefore ? alreadyReviewedReply({ head, state: done.state, result: before?.checkpoint.result, at: before?.updatedAt, now: now() }) : undefined
      const text = nothingNew ?? already
      return { status: done.status, reason: local ?? done.reason ?? report?.reason, posted: report?.posted ?? false, ...(text ? { text } : {}) }
    } catch (error) {
      const current = ledger.get(job.id)
      if (current && IN_FLIGHT.has(current.state)) move(job.id, "failed", { attempts: current.attempts + 1, error: errorText(error).slice(0, 2000) })
      throw error
    } finally { await releaseHold(job.id) }
  }

  /** PR `number` as eligibility reads it (labels, base branch, author, draft, changed files), fresh from gh; throws when gh cannot say. */
  async function prFacts(directory: string, number: number): Promise<PrFacts> {
    const forge = await forgeOf(directory)
    if (forge) {
      const facts = await forgeView(forge, directory, number)
      const files = await forge.provider.files?.({ repo: forge.repo, number }).catch(() => undefined)
      return { ...facts, ...(files ? { files: files.slice(0, 3000) } : {}) }
    }
    const viewed = await run({ argv: ["pr", "view", String(number), "--json", "number,headRefOid,baseRefOid,baseRefName,headRefName,isDraft,labels,author,files,isCrossRepository,maintainerCanModify,reviewRequests,assignees"], cwd: directory })
    let pr: Record<string, unknown> = {}
    try { pr = viewed.code === 0 ? JSON.parse(viewed.out) as Record<string, unknown> : {} } catch { /* checked below */ }
    const parsed = parseListedPr(pr)
    if (!parsed.success) throw new Error(`[PR_REVIEW]: gh could not read pull request #${number}`)
    const files = Array.isArray(pr.files) ? (pr.files as Array<{ path?: unknown }>).flatMap((file) => typeof file.path === "string" ? [file.path] : []).slice(0, 3000) : undefined
    return { ...listedToFacts(parsed.data), ...(files ? { files } : {}) }
  }

  /**
   * Why an `@mendcode review` or `fix` is not run on PR `number`: the repository's filters and draft rule, as for an automatic
   * review (eligibility's `comment` trigger: the mode and trigger switches do not apply, someone asked), and for a personal reviewer
   * (`personal`: its login) its profile's narrowing too. Undefined when it runs. A comment never overrides a filter. `manual`: the
   * daemon's own login asked, which is its owner's `/pr review`: only the exclusions hold.
   */
  async function mentionRefusal({ directory, repo, number, config, personal, manual = false }: { directory: string; repo: string; number: number; config: ReviewConfig; personal: string | undefined; manual?: boolean }) {
    const facts = await prFacts(directory, number)
    const trigger = manual ? "manual" as const : "comment" as const
    const verdict = eligible({ facts, config, trigger })
    if (!verdict.ok) return verdict.reason
    const profile = personalLayer(repo, personal)
    if (profile === undefined) return undefined
    const narrowed = eligible({ facts, config: layeredConfig(config, { personal: profile }).config, trigger })
    return narrowed.ok ? undefined : `your personal profile: ${narrowed.reason}`
  }

  /**
   * A command's reply through the effects ledger (kind `reply`, one effect per answered comment): an answer already done is not sent
   * again, and right before the write the pull request is read for an answer to the same comment (this login's from a crash or
   * another device, or another publisher's): one found counts as the answer and nothing is sent.
   */
  const ledgeredReply = ({ repo, number, comment, rule, self, forge }: { repo: string; number: number; comment: CommandComment; rule: ReviewConfig["publishers"]; self: string | undefined; forge?: Forge | undefined }) => async ({ endpoint, body }: { endpoint: string; body: string }) => {
    const effect = effects.intend({ kind: "reply", key: effectKey({ kind: "reply", repo, number, reviewer: "commands", configKey: "", head: "", base: "", payload: `answers=${comment.id}` }), marker: answersMarker(comment.id) })
    if (effect.state === "done") return true
    const other = forge ? await answeredThrough({ provider: forge.provider, repo, number, commentId: comment.id, rule, self }) : await answeredBy({ gh: call, repo, number, commentId: comment.id, rule, self })
    if (other && sameLogin(other, self)) { effects.done(effect.id); return true }
    if (other) { effects.abandon(effect.id, `@${other} answered it meanwhile`); return false }
    if (forge) {
      // In the comment's own thread (a GitLab discussion, a Gitea review conversation), else the conversation.
      const sent = await forge.provider.reply?.({ repo, number, to: comment, body }).catch(() => undefined)
      if (!sent?.ok) return false
      effects.done(effect.id, String(sent.id))
      return true
    }
    const done = await call({ argv: ["api", endpoint, "--method", "POST", "--input", "-"], stdin: JSON.stringify({ body }) }).catch(() => ({ code: 1, out: "" }))
    // Not confirmed: the effect stays pending, and the next try reads the pull request for the answer before it sends again.
    if (done.code !== 0) return false
    let remote: string | undefined
    try { const id = (JSON.parse(done.out) as { id?: unknown }).id; remote = id === undefined ? undefined : String(id).slice(0, 100) } catch { /* no id */ }
    effects.done(effect.id, remote)
    return true
  }

  /** A comment's link on GitHub: a conversation comment, or a review comment's thread. */
  const commentUrl = (repo: string, number: number, comment: CommandComment) => `https://github.com/${repo}/pull/${number}#${comment.surface === "review" ? `discussion_r${comment.id}` : `issuecomment-${comment.id}`}`
  /**
   * Whether the review of this head on the pull request is the answer to this `@mendcode review` itself: it waited for a running
   * job's review (`blocked: job`), or its own job ran (a restart after that job posted). Otherwise the head was reviewed before
   * anyone asked, and the comment gets one reply linking that review.
   */
  const answeredByItsReview = (entry: Extract<RepoWatchJob, { kind: "command" }>, repo: string, number: number) =>
    entry.blocked === "job" || ledger.list({ repo, number }).some((job) => job.trigger === "comment" && job.head === entry.head && (job.assignment ?? "").startsWith(`@mendcode review from @${entry.comment.actor}`))

  /**
   * `@mendcode review` written by this daemon's own login: its owner's `/pr review` (only the exclusions hold), queued as a durable
   * job that posts only as `/pr publish` allows. A refusal is said in this session, never on the pull request.
   */
  async function ownReview({ sessionId, directory, repo, number, config, asked, forge }: { sessionId: string; directory: string; repo: string; number: number; config: ReviewConfig; asked: string; forge: Forge | undefined }): Promise<JobOutcome> {
    const refused = await mentionRefusal({ directory, repo, number, config, personal: undefined, manual: true }).catch((error: unknown) => errorText(error))
    if (refused) { void outbox.say(sessionId, `${asked} (this daemon's own login): not run, ${refused}; nothing is posted on the pull request.`); return }
    const reviewer = await commandReviewer(directory)
    const id = watch.review({ directory, sessionId, number, head: "" }, { reviewer: reviewer.id, scope: reviewer.scope }, forge ? { kind: forge.kind, repo: forge.repo } : undefined)
    void outbox.say(sessionId, id
      ? `${asked} (this daemon's own login): run as your own /pr review; the findings arrive in this session, and the review is posted only as /pr publish allows.`
      : `${asked} (this daemon's own login): not queued, the job ledger is full; /pr review ${number} tries again.`)
  }

  /**
   * One `@mendcode` comment of a watched repository: answered on GitHub with the user's own gh, once they allowed posting there, when
   * the repository lets this reviewer post (`publishers`) and no publisher, this one included, answered it yet. A comment that cannot
   * be answered yet comes back `blocked`: the watch keeps it and runs it again once that can change, and the session is told once.
   */
  /** What each `@mendcode` comment's session already heard, by comment id (the newest `TOLD_COMMENTS`): one notice per change of state. */
  const told = new Map<number, Set<string>>()
  const TOLD_COMMENTS = 200
  /** Comments whose command runs now in this process: a second offer of the same comment never starts a second run. */
  const answering = new Set<number>()
  async function commandJob(entry: Extract<RepoWatchJob, { kind: "command" }>): Promise<JobOutcome> {
    const { comment } = entry
    if (answering.has(comment.id)) return entry.blocked ? { blocked: entry.blocked } : undefined
    answering.add(comment.id)
    try { return await commandJobOnce(entry) } finally { answering.delete(comment.id) }
  }
  async function commandJobOnce(entry: Extract<RepoWatchJob, { kind: "command" }>): Promise<JobOutcome> {
    const { sessionId, directory, number, command, comment } = entry
    // A notice about this comment is said once per state: the same words for the same comment are never said again.
    const outbox = {
      say(to: string, text: string) {
        const known = told.get(comment.id) ?? new Set<string>()
        if (known.has(text)) return Promise.resolve()
        known.add(text)
        told.delete(comment.id)
        told.set(comment.id, known)
        if (told.size > TOLD_COMMENTS) told.delete(told.keys().next().value!)
        return realOutbox.say(to, text)
      },
    }
    try {
      const repo = await repoCached(directory)
      const asked = `@mendcode ${command.kind} from ${comment.actor} on ${repo}#${number}`
      const config = await policyOf(directory, number)
      const forge = await forgeOf(directory)
      const self = await watch.loginOf(directory)
      // The daemon's own login is its owner, not a stranger: its comment is the owner's `/pr review` (or a fix it may push), and
      // nothing it is refused is ever posted on the pull request, only said in this session.
      const own = sameLogin(comment.actor, self)
      if (own && command.kind === "review") return ownReview({ sessionId, directory, repo, number, config, asked, forge })
      // `reviewers` as a list is the team that may ask: anyone else's comment is not taken, and nobody is told (no notice to flood).
      if (!own && !mayRequest(config.reviewers, comment.actor)) return
      if (watch.consentOf(directory) !== "allowed") {
        if (entry.blocked !== "consent") void outbox.say(sessionId, `${asked} is not answered yet: MendCode posts to ${repo} only after /pr publish on, and answers it then.`)
        return { blocked: "consent" }
      }
      const allowed = await publisherOf(directory, repo, config.publishers)
      if (!(own && command.kind === "fix") && !allowed.ok) {
        if (entry.blocked !== "publisher") void outbox.say(sessionId, `${asked} is not answered yet: ${allowed.reason}. It is tried again every ${PUBLISHER_RETRY_MS / 60_000} minutes while the pull request is open.`)
        return { blocked: "publisher" }
      }
      const other = forge ? await answeredThrough({ provider: forge.provider, repo, number, commentId: comment.id, rule: config.publishers, self }) : await answeredBy({ gh: call, repo, number, commentId: comment.id, rule: config.publishers, self })
      // This login's own reply: the command ran before a restart or an earlier try, and is not answered twice.
      if (other && self && other.toLowerCase() === self.toLowerCase()) return
      if (other) { void outbox.say(sessionId, `${asked}: @${other} answered it already.`); return }
      const send = ledgeredReply({ repo, number, comment, rule: config.publishers, self, ...(forge ? { forge } : {}) })
      const via = forge ? { provider: forge.provider } : {}
      // One order for every command: the commenter's permission, then the filters, then the reviewed head (and claims). Someone
      // without write access always gets the one refusal, whatever the head's state.
      if (own ? !await mayWriteNow(directory, repo, self) : !await hasWriteAccess({ gh: call, repo, actor: comment.actor, association: comment.association, ...via })) {
        if (own) { void outbox.say(sessionId, `${asked} (this daemon's own login): not run, @${self} has no write access to ${repo}; nothing is posted on the pull request.`); return }
        const posted = await replyTo({ gh: call, repo, number, comment, text: MAINTAINERS_ONLY, send, ...via })
        void outbox.say(sessionId, `${asked}: refused (no write access)${posted ? "" : "; the reply could not be posted"}.`)
        return
      }
      const personal = watch.watchOf(directory)?.role === "requested"
      if (command.kind === "review" || command.kind === "fix" || command.kind === "describe") {
        const refused = await mentionRefusal({ directory, repo, number, config, personal: personal ? self : undefined, manual: own })
        if (refused) {
          if (own) { void outbox.say(sessionId, `${asked} (this daemon's own login): not run, ${refused}; nothing is posted on the pull request.`); return }
          const posted = await replyTo({ gh: call, repo, number, comment, text: filteredReply(command.kind === "fix" ? "fix" : "review", refused), send, ...via })
          void outbox.say(sessionId, `${asked}: not run, the repository's filters keep it off this pull request; ${posted ? "one reply says which" : "the reply could not be posted"}.`)
          return
        }
      }
      if (command.kind === "review") {
        const done = forge ? await headReviewedThrough({ provider: forge.provider, repo, number, head: entry.head, rule: config.publishers, self }) : await headReviewedBy({ gh: call, repo, number, head: entry.head, rule: config.publishers, self })
        // A kept request can outlive its answer: the review its own job posted (or the running job it waited for) answers it.
        if (done && answeredByItsReview(entry, repo, number)) { void outbox.say(sessionId, `${asked}: @${done.login} already reviewed this head (review ${done.id}), so it is not reviewed again.`); return }
        // This login's own review, submitted at or after the comment, is the answer: no second reply beside it.
        if (done && answersRequest({ done, asked: comment.createdAt })) { void outbox.say(sessionId, `${asked}: answered by this reviewer's own review of this head (review ${done.id}); no reply is posted.`); return }
        if (done) {
          // Reviewed before anyone asked: one reply (answered once through the effects ledger) links that review, and the request
          // is kept on the pull request: its next head is reviewed, even with `triggers.synchronize` off.
          const kept = watch.askNext(directory, number, { head: entry.head, by: comment.actor, comment: comment.id })
          const link = forge ? `review ${done.id}` : `https://github.com/${repo}/pull/${number}#pullrequestreview-${done.id}`
          const next = kept ? "the next push will be reviewed" : "a new push is reviewed as usual"
          const text = `@${done.login.replace(/^@/, "")} already reviewed this head (${entry.head.slice(0, 12)}): ${link}. It is not reviewed again; ${next}.`
          const posted = await replyTo({ gh: call, repo, number, comment, text, send, ...via })
          void outbox.say(sessionId, `${asked}: @${done.login} already reviewed this head (review ${done.id}), so it is not reviewed again; ${next}; ${posted ? `one reply on ${forge?.name ?? "GitHub"} links it` : "the reply linking it could not be posted"}.`)
          return
        }
      }
      /** The daemon's own login's `@mendcode fix` is answered in this session only: what it would have replied is said here. */
      const ownReplies: string[] = []
      const state = readReviewState(options.dir, repo, number)
      let target: Awaited<ReturnType<typeof fixTarget>> | undefined
      const fixInfo = async () => (target ??= await fixTarget(directory, number))
      // A personal reviewer's `@mendcode fix` pushes only with `fix.personal`; the repository's reviewer pushes with `fixes`, as before.
      // The answering reviewer's `capabilities` without `fix`: one reply says so, and no fix session starts.
      const fixer = command.kind === "fix" ? (await commandReviewer(directory)).entry : undefined
      const noFix = fixer && !mayDo(fixer, "fix") ? lacksText(fixer, "fix") : undefined
      // `describe`, `resolve` and `approve` write to the pull request: the answering reviewer needs `publish` like a review does.
      const writer = command.kind === "describe" || command.kind === "resolve" || command.kind === "approve" ? (await commandReviewer(directory)).entry : undefined
      const noWrite = writer && !mayDo(writer, "publish") ? lacksText(writer, "publish") : undefined
      if (noWrite) {
        const posted = await replyTo({ gh: call, repo, number, comment, text: `\`@mendcode ${command.kind}\` is not run here: ${noWrite}. Add \`publish\` to its \`capabilities\` there to let it write to the pull request.`, send, ...via })
        void outbox.say(sessionId, `${asked}: not run, ${noWrite}; ${posted ? "one reply says why" : "the reply could not be posted"}.`)
        return
      }
      const outcome = await runPrCommand(command, {
        editor: forge ? providerEditor({ provider: forge.provider, repo, number }) : githubEditor({ gh: call, repo, number }),
        lastReview: async (head) => lastReviewOf(repo, number, head),
        settings: { describeTitle: config.commands.describe_title, approve: config.commands.approve },
        ...(noFix ? { fixUnavailable: `\`@mendcode fix\` is not run here: ${noFix}. Add \`fix\` to its \`capabilities\` there to let it fix.` } : {}),
        gh: call, repo, number, comment, state, ...via, checked: true,
        send: own && command.kind === "fix" ? async ({ body }) => { ownReplies.push(body.split(REPLY_MARKER)[0]!.trim()); return false } : send,
        // `@mendcode review` reviews what is new since the last review of an earlier head; `@mendcode review full` reviews the whole PR.
        review: () => commentReview({ sessionId, directory, repo, number, head: entry.head, actor: comment.actor, full: /^full\b/i.test(command.arg ?? "") }),
        // The answer is public like the review: in the review's language (`auto` keeps the one this PR's reviews resolved).
        explain: (question) => explainFinding({ sessionFactory: inLanguage(options.sessions(sessionId, directory), resolveReviewLanguage({ configured: config.template.language, stored: state.language }).language), ...question }),
        fixesAllowed: async () => (await fixInfo()).config.fixes,
        pushable: async () => (await fixInfo()).pushable,
        ...(personal ? { pushAllowed: async () => (await fixInfo()).config.fix.personal } : {}),
        fix: noFix ? undefined : async ({ instructions, finding, push, guards }) => {
          const info = await fixInfo()
          if ((await oneAtATime(directory, () => git(["fetch", "--no-tags", "--quiet", "origin", info.headRef], directory))).code !== 0) return { ok: false, reason: `git fetch of pull request #${number} failed` }
          void outbox.say(sessionId, `@mendcode fix on ${repo}#${number}: a fix session is editing a copy of the branch; its approvals come to you like any session's.`)
          const job = openJobsOf(repo, number)[0]
          const source: FixSource = { kind: "comment", actor: comment.actor, ...(forge ? {} : { url: commentUrl(repo, number, comment) }) }
          return runFix({
            directory, root, number, head: info.head, branch: info.branch, pushUrl: info.pushUrl, instructions, finding, source, checks: info.config.checks, runChecks: (dir, commands) => runChecks({ directory: dir, commands }), sessions: (worktree) => inLanguage(options.editor(sessionId, worktree), info.config.template.language), git,
            push, stillOpen: guards.stillOpen,
            // The commenter may still write and the branch still takes the push (`guards`), and this daemon's login may push to it now.
            mayPush: async () => { const ok = await guards.mayPush(); if (ok !== true) return ok; return await mayWriteNow(directory, repo, self) ? true : `@${self ?? "this login"} has no write access to ${repo} now` },
            // A job of this PR the user took over has one writer: the user.
            controlOf: () => openJobsOf(repo, number).some((open) => controlOf(ledger, open.id) === "user") ? "user" : "reviewer",
            ...(job ? { onSession: (id: string) => patchJob(job.id, { fixSessionId: id }) } : {}),
          })
        },
      })
      if (outcome.state !== state) writeReviewState(options.dir, repo, number, outcome.state)
      if (own && command.kind === "fix") { void outbox.say(sessionId, `${asked} (this daemon's own login), answered in this session only: ${ownReplies.join(" ") || "done"}`); return }
      const said = outcome.kind === "denied" ? "refused (no write access)" : noFix && outcome.kind === "fix" ? `not run, ${noFix}; ${outcome.posted ? "one reply says why" : "the reply could not be posted"}` : outcome.kind === "filtered" ? `not run, the repository's filters keep it off this pull request; ${outcome.posted ? "one reply says which" : "the reply could not be posted"}` : outcome.posted ? `answered on ${forge?.name ?? "GitHub"}` : "the reply could not be posted"
      void outbox.say(sessionId, `@mendcode ${command.kind} from ${comment.actor} on ${repo}#${number}: ${said}.`)
    } catch (error) {
      if (error instanceof JobBusy) {
        // Its job's review answers it: offered again at each poll, it then finds that review on the PR (`headReviewedBy`).
        if (entry.blocked !== "job") void outbox.say(sessionId, `@mendcode ${command.kind} from ${comment.actor} on ${await repoCached(directory).catch(() => "")}#${number} waits: ${errorText(error)}; the comment is answered by that review.`)
        return { blocked: "job" }
      }
      const repo = await repoCached(directory).catch(() => directory)
      void outbox.say(sessionId, `@mendcode ${command.kind} from ${comment.actor} on ${repo}#${number}${entry.head ? ` at ${entry.head.slice(0, 12)}` : ""} failed: ${errorText(error).replace(/^\[PR_REVIEW\]:\s*/, "")}. It is not tried again; writing the comment again asks again.`)
    }
  }

  const followed = new Map<string, number>()
  /** Explains the failing checks of a head MendCode reviewed and posted on, at most every `FOLLOW_UP_MS` per PR. */
  async function followUp(directory: string, sessionId: string, prs: ReadonlyArray<{ number: number; headRefOid: string }>) {
    if (watch.consentOf(directory) !== "allowed") return
    // GitHub check runs and Actions logs only (DAEMON_FEATURES.checkFollowUp): a GitLab or Gitea watch was told so when it started.
    if (await forgeOf(directory)) return
    const repo = await repoCached(directory)
    if (!(await publisherOf(directory, repo, (await baseConfig(directory)).publishers)).ok) return
    const at = now()
    for (const pr of prs) {
      const state = readReviewState(options.dir, repo, pr.number)
      if (state.lastHead !== pr.headRefOid || !Object.keys(state.published).length) continue
      const key = `${repo}#${pr.number}`
      if (at - (followed.get(key) ?? -Infinity) < FOLLOW_UP_MS) continue
      followed.set(key, at)
      const done = await failureFollowUp({ gh: call, repo, number: pr.number, head: pr.headRefOid, state })
      if (done.state !== state) writeReviewState(options.dir, repo, pr.number, done.state)
      if (done.posted) void outbox.say(sessionId, `Checks failed on ${repo}#${pr.number} after the review; MendCode posted their cause on the pull request.`)
    }
  }

  // ── Personal reviewers across daemons and devices: claims, waiting jobs, availability ───────────────────────────────────

  /** The newest trusted claim seen per reviewer id (any device, this one included): its availability on the reviews page. */
  const claimsSeen = new Map<string, Claim>()
  const whose = (entry: Pick<ReviewerEntry, "id" | "login">) => entry.login ? `@${entry.login}'s MendCode` : `${entry.id}'s MendCode`
  /** Why a job waits for a device that claimed its PR. */
  const holderText = (entry: Pick<ReviewerEntry, "id" | "login">, claim: Claim) => `waiting: ${whose(entry)} on device ${claim.owner.slice(0, 40)} claimed this pull request until ${isoMinute(claim.expiresAt)}; it reviews there`
  /** Why a job waits for a reviewer whose MendCode is another daemon. */
  const awayText = (entry: ReviewerEntry) => `waiting for ${whose(entry)} (offline or another device${entry.device ? `; pinned to device ${entry.device.slice(0, 40)}` : ""}); it reviews when that daemon runs`

  /**
   * The conversation comments of PR `number` in GitHub's shape (`id`, `body`, `user.login`): `gh` on GitHub, the adapter's
   * conversation comments on GitLab and Gitea. Undefined when they cannot be read.
   */
  async function conversationOf(repo: string, number: number, directory: string): Promise<unknown[] | undefined> {
    const forge = await forgeOf(directory)
    if (!forge) return listAll(call, `repos/${repo}/issues/${number}/comments`)
    const read = await forge.provider.comments?.({ repo, number }).catch(() => undefined)
    return read?.ok ? read.comments.filter((comment) => comment.surface === "issue").map((comment) => ({ id: comment.id, body: comment.body, user: { login: comment.author } })) : undefined
  }
  /**
   * The submitted reviews of PR `number` in GitHub's shape (`id`, `commit_id`, `state`, `body`, `user.login`): `gh` on GitHub; on
   * Gitea its reviews, on GitLab its notes, whose reviewed head is the head marker every MendCode review body carries.
   */
  async function reviewsOf(repo: string, number: number, directory: string): Promise<unknown[] | undefined> {
    const forge = await forgeOf(directory)
    if (!forge) return listAll(call, `repos/${repo}/pulls/${number}/reviews`)
    const read = await forge.provider.markers?.({ repo, number }).catch(() => undefined)
    return read?.ok ? read.posts.map((post) => ({ id: post.id, commit_id: post.commit ?? REVIEW_MARKER.exec(post.body)?.[1], state: post.state, body: post.body, user: { login: post.author } })) : undefined
  }
  type ClaimComment = { id?: number | undefined; body: string; author?: string | undefined }
  type ClaimRead = { claims: Claim[]; bodies: string[]; comments: ClaimComment[] }
  /** The claim markers on PR `number` (with their authors' logins) and the comments that carry one; undefined when gh cannot list them. */
  async function readClaims(repo: string, number: number, directory: string): Promise<ClaimRead | undefined> {
    const items = await conversationOf(repo, number, directory)
    if (!items) return undefined
    const comments = items.flatMap((item): ClaimComment[] => {
      const comment = item as { id?: unknown; body?: unknown; user?: { login?: unknown } | null }
      return typeof comment.body === "string" && comment.body.includes("mendcode:claim") ? [{ ...(typeof comment.id === "number" ? { id: comment.id } : {}), body: comment.body, ...(typeof comment.user?.login === "string" ? { author: comment.user.login } : {}) }] : []
    })
    return { claims: parseClaims(comments).filter((claim) => claim.repo === repo && claim.number === number), bodies: comments.map((comment) => comment.body), comments }
  }
  /** This device's own claim comment of `key` (written by `login`), which renewals and the release edit in place. */
  const ownClaimComment = (read: ClaimRead | undefined, key: string, me: string, login: string | undefined) =>
    read?.comments.filter((comment) => comment.id !== undefined && (!login || sameLogin(comment.author, login)) && parseClaims([comment]).some((claim) => claim.key === key && claim.owner === me)).at(-1)?.id

  /**
   * The claims that count for `entry`: its claim id, written by its own login (a claim is an ordinary comment anyone can write).
   * They come back with `reviewer: entry.id` (what `pendingFor` compares); their fences are observed, so this device's next claim of
   * the key is above them; the newest is kept for the reviewer's availability.
   */
  function trustedClaims(entry: Pick<ReviewerEntry, "id" | "login">, claims: readonly Claim[]): Claim[] {
    const id = claimIdOf(entry.id)
    const trusted = claims.filter((claim) => claim.reviewer === id && (!entry.login || sameLogin(claim.author, entry.login))).map((claim) => ({ ...claim, reviewer: entry.id }))
    for (const claim of trusted) {
      try { ownership.observe(claim.key, claim.fence) } catch { /* a key it cannot keep observes nothing */ }
      const known = claimsSeen.get(entry.id)
      if (!known || claim.acquiredAt >= known.acquiredAt) claimsSeen.set(entry.id, claim)
    }
    return trusted
  }
  /** The live winning claim of `entry` on PR `number` among `claims`, if any. */
  function winningClaim(entry: Pick<ReviewerEntry, "id" | "login">, repo: string, number: number, claims: readonly Claim[]): Claim | undefined {
    let key: string
    try { key = prClaimKey({ repo, number, reviewer: claimIdOf(entry.id) }) } catch { return undefined }
    return resolveClaims(trustedClaims(entry, claims).filter((claim) => claim.key === key), now()).get(key)
  }

  /** Whether this daemon may post a claim to `repo`: the user allowed posting there and `publishers` lets its login post. */
  async function mayPostClaim(directory: string, repo: string) {
    if (watch.consentOf(directory) !== "allowed") return false
    const config = await baseConfig(directory).catch(() => undefined)
    return !!config && (await publisherOf(directory, repo, config.publishers)).ok
  }

  /**
   * Why a job may not run or write: another device holds the pull request's claim (`holder`), that reviewer's review of the head is
   * on the pull request already from another device (`reviewed`), or the claims could not be read to tell (`retry`).
   */
  type GateRefusal = { ok: false; reason: string; holder?: Claim | undefined; reviewed?: { id: number; device?: string | undefined } | undefined; retry?: boolean | undefined; until?: number | undefined }
  type ClaimGate = { ok: true } | GateRefusal
  /**
   * The claim a running job holds on its pull request (one per job): the local lease with its fence, whether the marker comment is
   * on the pull request (`visible`: only when this daemon may post there), that comment's id (renewals and the release edit it in
   * place, so a device keeps one claim comment per pull request), and why it was lost, once it was.
   */
  type Hold = { job: ReviewJob; key: string; lease: Lease; entry: { id: string; login?: string | undefined }; visible: boolean; commentId?: number | undefined; lost?: string | undefined; timer?: ReturnType<typeof setInterval> | undefined; renewing?: boolean | undefined }
  const holds = new Map<string, Hold>()
  /** The write gate's last refusal per job, read when the run comes back `stale` without a moved head. */
  const withheld = new Map<string, GateRefusal>()
  const claimTtl = Math.max(1, Math.floor(options.claimTtlMs ?? CLAIM_TTL_MS))

  /** A submitted review of `head` by `login` that is `reviewer`'s (its marker names it) or carries no reviewer marker; its id. */
  async function reviewOfHead(repo: string, number: number, head: string, login: string, reviewer: string, directory: string): Promise<number | undefined> {
    const ours = reviewerFromBody(reviewerMarker({ reviewer, configKey: "x", key: "" }))?.reviewer
    const reviews = await reviewsOf(repo, number, directory)
    for (const item of reviews ?? []) {
      const review = item as { id?: unknown; commit_id?: unknown; state?: unknown; body?: unknown; user?: { login?: unknown } | null }
      if (review.commit_id !== head || review.state === "PENDING" || review.state === "DISMISSED" || typeof review.id !== "number" || typeof review.user?.login !== "string" || !sameLogin(review.user.login, login)) continue
      // A reply in a finding's thread ("Fixed in ...") is a review of this login for GitHub, not a review of the head.
      if (!isMendCodeReview(review.body)) continue
      const marked = reviewerFromBody(typeof review.body === "string" ? review.body : "")
      if (!marked || marked.reviewer === ours) return review.id
    }
    return undefined
  }

  /**
   * Posts or edits this device's claim marker for `lease` through the effects ledger (kind `claim`, one effect per marker): an
   * effect already done is not sent again, a pending one found on the pull request is done without a send. With `commentId` the
   * comment is edited in place; a failed edit posts a new comment only when `fallback` (the first claim of a job).
   */
  async function announce({ hold, lease, text, fallback, bodies }: { hold: Hold; lease: Lease; text: string; fallback: boolean; bodies?: readonly string[] | undefined }): Promise<boolean> {
    const { job } = hold
    // A marker longer than a day is ignored by every reader; a lease renewed for longer is announced from a day before its end.
    const marker = claimMarker({ ...lease, acquiredAt: Math.max(lease.acquiredAt, lease.expiresAt - MAX_CLAIM_TTL_MS) }, claimIdOf(job.reviewer), (job.covers ?? []).map(claimIdOf))
    const effect = effects.intend({ kind: "claim", key: effectKey({ kind: "claim", repo: job.repo, number: job.number, reviewer: job.reviewer, configKey: "", head: "", base: "", payload: marker }), jobId: job.id, ...(marker.length <= 500 ? { marker } : {}) })
    if (effect.state === "done") return true
    if (bodies?.some((body) => body.includes(marker))) { effects.done(effect.id); return true }
    const body = `${text}\n\n${marker}${REPLY_MARKER}`
    const forge = await forgeOf(job.directory)
    if (forge) {
      // GitLab and Gitea: the same edit-in-place, then a new comment only for a job's first claim.
      const write = (edit?: number) => forge.provider.comment?.({ repo: job.repo, number: job.number, body, ...(edit !== undefined ? { edit } : {}) }).catch(() => undefined)
      if (hold.commentId !== undefined) {
        const edited = await write(hold.commentId)
        if (edited?.ok) { effects.done(effect.id, String(hold.commentId)); return true }
        if (!fallback) { effects.abandon(effect.id, "the claim comment could not be edited"); return false }
      }
      const posted = await write()
      if (!posted?.ok) return false
      hold.commentId = posted.id
      effects.done(effect.id, String(posted.id))
      return true
    }
    if (hold.commentId !== undefined) {
      const edited = await call({ argv: ["api", `repos/${job.repo}/issues/comments/${hold.commentId}`, "--method", "PATCH", "--input", "-"], stdin: JSON.stringify({ body }) }).catch(() => ({ code: 1, out: "" }))
      if (edited.code === 0) { effects.done(effect.id, String(hold.commentId)); return true }
      if (!fallback) { effects.abandon(effect.id, "the claim comment could not be edited"); return false }
    }
    const posted = await call({ argv: ["api", `repos/${job.repo}/issues/${job.number}/comments`, "--method", "POST", "--input", "-"], stdin: JSON.stringify({ body }) }).catch(() => ({ code: 1, out: "" }))
    // Not confirmed: the effect stays pending and is reconciled against the comments at the next claim; the job runs meanwhile.
    if (posted.code !== 0) return false
    let remote: number | undefined
    try { const id = (JSON.parse(posted.out) as { id?: unknown }).id; remote = typeof id === "number" ? id : undefined } catch { /* no id */ }
    if (remote !== undefined) hold.commentId = remote
    effects.done(effect.id, remote === undefined ? undefined : String(remote))
    return true
  }
  const workingText = (hold: Hold, lease: Lease) => `<sub>MendCode: ${whose(hold.entry)} works on this pull request on one of its devices until ${isoMinute(lease.expiresAt)}${hold.job.covers?.length ? ` as the offline fallback for ${hold.job.covers.join(", ")}, who did not take it in time (routing.offline_fallback)` : ""}.</sub>`

  /**
   * Settles PR `job.number` for a job before it runs (decision 5; best-effort, not compare-and-swap), for a personal reviewer and
   * for the repository's global one alike (a PC and a VPS both watching with `all`). Another device's live claim wins: the job waits.
   * A lapsed or released claim of another device whose review of this head is on the pull request answers the job: it is done there.
   * Otherwise this device claims the key (a local lease with a fence above every fence read) and, only when it may post to the
   * repository, posts the claim marker through the effects ledger and reads the claims back, so of two devices that started
   * together the one `resolveClaims` names runs and the other waits. A claim this daemon cannot post stays local: other devices cannot
   * see it, and this daemon cannot post anything there either. `publishes` false (the reviewer's `capabilities` lack `publish`)
   * keeps the claim local the same way. A job that holds its claim renews it every half of `claimTtl` and releases it when it ends
   * (`releaseHold`); `writeGate` checks it right before each write.
   */
  async function claimGate(job: ReviewJob, publishes = true): Promise<ClaimGate> {
    let key: string
    try { key = prClaimKey({ repo: job.repo, number: job.number, reviewer: claimIdOf(job.reviewer) }) } catch { return { ok: true } }
    // The reviewer runs here, so its claims are posted by this daemon's login, on this device and on its other ones.
    const login = await watch.loginOf(job.directory).catch(() => undefined)
    const entry = { id: job.reviewer, ...(login ? { login } : {}) }
    const me = deviceOf()
    const before = await readClaims(job.repo, job.number, job.directory)
    const rival = before && winningClaim(entry, job.repo, job.number, before.claims)
    if (rival && rival.owner !== me) return { ok: false, holder: rival, reason: holderText(entry, rival) }
    const foreign = before ? trustedClaims(entry, before.claims).filter((claim) => claim.key === key && claim.owner !== me).toSorted((a, b) => b.acquiredAt - a.acquiredAt) : []
    if (foreign.length && login && job.head) {
      const review = await reviewOfHead(job.repo, job.number, job.head, login, job.reviewer, job.directory)
      if (review !== undefined) return { ok: false, reviewed: { id: review, device: foreign[0]!.owner }, reason: `reviewed by ${whose(entry)} on device ${foreign[0]!.owner.slice(0, 40)} (review ${review})` }
    }
    const claimed = ownership.claim(key, me, claimTtl)
    if (!claimed.ok) return { ok: true }
    const hold: Hold = { job, key, lease: claimed.lease, entry, visible: publishes && await mayPostClaim(job.directory, job.repo), commentId: ownClaimComment(before, key, me, login) }
    holds.set(job.id, hold)
    hold.timer = setInterval(() => void renewHold(job.id), Math.max(1, Math.floor(claimTtl / 2)))
    hold.timer.unref?.()
    if (!hold.visible) return { ok: true }
    // This device's own live claim with more than half its time left needs no new marker.
    if (rival && rival.expiresAt - now() > claimTtl / 2) return { ok: true }
    if (!(await announce({ hold, lease: hold.lease, text: workingText(hold, hold.lease), fallback: true, bodies: before?.bodies }))) return { ok: true }
    const after = await readClaims(job.repo, job.number, job.directory)
    const winner = after && winningClaim(entry, job.repo, job.number, after.claims)
    if (winner && winner.owner !== me) {
      await releaseHold(job.id)
      return { ok: false, holder: winner, reason: holderText(entry, winner) }
    }
    return { ok: true }
  }

  /**
   * The heartbeat of a held claim, every half of `claimTtl` while the job runs: the local lease is renewed (taken again with a new
   * fence when it lapsed while this process slept, unless another owner holds it: then the hold is lost) and, when the marker is on
   * the pull request, its comment is edited with the new expiry. A failed edit is not fatal here: the write gate reads the claims.
   */
  async function renewHold(jobId: string) {
    const hold = holds.get(jobId)
    if (!hold || hold.renewing || hold.lost) return
    hold.renewing = true
    try {
      const renewed = ownership.renew(hold.lease, claimTtl)
      if (renewed.ok) hold.lease = renewed.lease
      else {
        const again = ownership.claim(hold.key, deviceOf(), claimTtl)
        if (!again.ok) { hold.lost = `this device's lease on the pull request is held by ${again.holder.owner.slice(0, 40)} (fence ${again.holder.fence}) now`; return }
        hold.lease = again.lease
      }
      if (hold.visible) await announce({ hold, lease: hold.lease, text: workingText(hold, hold.lease), fallback: false })
    } catch { /* the next beat tries again; the write gate decides */ } finally { hold.renewing = false }
  }

  /** Ends a job's hold: the heartbeat stops, the local lease is released, and a posted marker is edited to say it was released. */
  async function releaseHold(jobId: string) {
    const hold = holds.get(jobId)
    if (!hold) return
    holds.delete(jobId)
    if (hold.timer) clearInterval(hold.timer)
    try { ownership.release(hold.lease) } catch { /* the lease expires by itself */ }
    if (!hold.visible || hold.commentId === undefined || hold.lost) return
    const released: Lease = { ...hold.lease, expiresAt: Math.max(hold.lease.acquiredAt + 1, now()) }
    const standIn = hold.job.covers?.length ? ` as the offline fallback for ${hold.job.covers.join(", ")} (routing.offline_fallback)` : ""
    await announce({ hold, lease: released, text: `<sub>MendCode: ${whose(hold.entry)} worked on this pull request on one of its devices${standIn}; released ${isoMinute(released.expiresAt)}.</sub>`, fallback: false }).catch(() => false)
  }

  /**
   * Right before a remote write of `job` (its review post with `review`, a fix push, the claim's own edits aside): it refuses when
   * the job lost its claim (the local lease went to another owner, or the claims on the pull request now name another device as
   * winner: a higher fence that took over after this one's claim lapsed) and, for a review, when this reviewer's review of the head is
   * already on the pull request from another device. The refusal is kept in `withheld` for the job's end. Claims that cannot be read
   * are a refusal to retry (a failed read is never a yes). A job without a hold (no claim key) is only checked for the review.
   */
  async function writeGate(job: ReviewJob, { review }: { review: boolean }): Promise<ClaimGate> {
    const refuse = (refusal: GateRefusal) => { withheld.set(job.id, refusal); return refusal }
    if (review && (job.covers?.length || job.scope === "personal")) {
      // Two devices that started together: a stand-in yields to its personal reviewer, and neither posts a second review of a head.
      const fallback = await fallbackRefusal(job, { write: true }).catch(() => undefined)
      if (fallback && !fallback.cancel) return refuse(fallback)
    }
    const hold = holds.get(job.id)
    const login = await watch.loginOf(job.directory).catch(() => undefined)
    const elsewhere = async () => {
      if (!review || !login || !job.head || readReviewState(options.dir, job.repo, job.number).lastHead === job.head) return undefined
      return reviewOfHead(job.repo, job.number, job.head, login, job.reviewer, job.directory)
    }
    let holder: Claim | undefined
    let lost = hold?.lost
    if (hold && !lost && !ownership.valid(hold.key, hold.lease.fence)) {
      const again = ownership.claim(hold.key, deviceOf(), claimTtl)
      if (again.ok) hold.lease = again.lease
      else lost = hold.lost = `this device's lease on the pull request is held by ${again.holder.owner.slice(0, 40)} (fence ${again.holder.fence}) now`
    }
    if (hold && !lost && hold.visible) {
      const read = await readClaims(job.repo, job.number, job.directory)
      if (!read) return refuse({ ok: false, retry: true, reason: "the pull request's claims could not be read, so this device cannot tell whether it still holds it; nothing was sent" })
      const winner = winningClaim(hold.entry, job.repo, job.number, read.claims)
      if (winner && winner.owner !== deviceOf()) {
        holder = winner
        lost = `device ${winner.owner.slice(0, 40)} took this pull request over (claim fence ${winner.fence}, this job's ${hold.lease.fence}) while this job ran`
      }
    }
    const reviewed = await elsewhere()
    if (reviewed !== undefined) return refuse({ ok: false, reviewed: { id: reviewed, ...(holder ? { device: holder.owner } : {}) }, reason: `${whose(hold?.entry ?? { id: job.reviewer, ...(login ? { login } : {}) })} already reviewed this head${holder ? ` on device ${holder.owner.slice(0, 40)}` : " from another device"} (review ${reviewed})` })
    if (lost) return refuse({ ok: false, ...(holder ? { holder } : {}), reason: lost })
    return { ok: true }
  }

  /**
   * Where a job goes when its gate refused: held by another device, `waiting` until that claim expires (it settles the claim again
   * then, and resumes from its checkpoint); reviewed on another device, `done` naming that review; otherwise `waiting` for a retry.
   */
  function settleGate(job: ReviewJob, gate: GateRefusal) {
    const current = ledger.get(job.id) ?? job
    const assignment = waitingAssignment(gate.reason, current.assignment)
    if (gate.reviewed) {
      if (current.state === "waiting" || current.state === "pending") move(job.id, "running")
      move(job.id, "done", { assignment, error: undefined, ...(gate.reviewed.device ? { owner: gate.reviewed.device.slice(0, 120) } : {}) })
      return
    }
    move(job.id, "waiting", { notBefore: gate.until ?? (gate.holder?.expiresAt ?? now()) + 1_000, assignment, error: undefined })
  }

  /**
   * A claim comment of these PRs changed (posted, renewed or released, read by the watch's comment poll): the jobs that wait for a
   * claim there (`settleGate`: `waiting` until the holder's expiry, no error, not a quota or rate-limit wait) are due now, so they
   * settle the claims again at once. A released claim is noticed at the next poll instead of after the claim's lifetime; a claim
   * still held sends the job back to wait for it, at the cost of one read of the PR's comments.
   */
  function wakeClaimWaits(directory: string, numbers: readonly number[]) {
    const at = now()
    const changed = new Set(numbers)
    for (const job of ledger.list({ states: ["waiting"] })) {
      if (job.directory !== directory || !changed.has(job.number) || job.notBefore === undefined || job.notBefore <= at || job.error !== undefined) continue
      if (job.stop?.kind === "quota" || job.stop?.kind === "rate_limit") continue
      patchJob(job.id, { notBefore: at })
    }
  }

  // ── Offline fallback (routing.offline_fallback) ──────────────────────────────────────────────────────────────────────────

  /**
   * The stand-in job of one PR event on this daemon: when the registry names an offline fallback that runs here, nothing else of
   * this daemon reviews the PR, and it waits only for personal reviewers of other devices, the fallback's job waits until
   * `afterMs` from now (`notBefore`), naming whom it covers; `coverGate` decides then whether it still has to review.
   */
  function offlineFallbackFor({ registry, reviewers, here, assignments }: { registry: ReviewerRegistry; reviewers: ReadonlyMap<string, ReviewerEntry>; here: { device: string; login?: string | undefined }; assignments: readonly ReviewAssignment[] }): ReviewAssignment | undefined {
    const fallback = registry.routing.offlineFallback
    const cover = fallback ? reviewers.get(fallback.reviewer) : undefined
    if (!fallback || !cover || cover.scope !== "global" || !mayDo(cover, "review") || !runsHere(cover, here)) return undefined
    if (assignments.some((assignment) => assignment.reviewer === cover.id || assignment.waiting === undefined)) return undefined
    const away = assignments.filter((assignment) => assignment.scope === "personal" && assignment.waiting !== undefined).map((assignment) => assignment.reviewer)
    if (!away.length) return undefined
    const at = now() + fallback.afterMs
    const minutes = Math.round(fallback.afterMs / 60_000)
    return {
      reviewer: cover.id, scope: "global", covers: away, owner: here.device, notBefore: at,
      assignment: `offline fallback for ${away.join(", ")} after ${minutes} min (routing.offline_fallback)`,
      waiting: `offline fallback: ${cover.id} reviews this pull request at ${isoMinute(at)} unless ${coveredNames(away, reviewers)} claims or reviews its head first`,
    }
  }
  const coveredNames = (ids: readonly string[], reviewers: ReadonlyMap<string, ReviewerEntry>) => ids.map((id) => { const entry = reviewers.get(id); return entry ? `${whose(entry)} (${id})` : id }).join(" or ")

  /** A stand-in takes its PR: the job's assignment and the session say why and for whom, once. */
  async function standInTakes(job: ReviewJob) {
    const login = await watch.loginOf(job.directory).catch(() => undefined)
    const registry = await registryOf(job.directory, "all", login).catch(() => undefined)
    const reviewers = new Map((registry?.reviewers ?? []).map((entry) => [entry.id, entry]))
    const minutes = Math.round((registry?.routing.offlineFallback?.afterMs ?? 0) / 60_000)
    const why = `offline fallback: ${coveredNames(job.covers ?? [], reviewers)} did not claim or review head ${job.head.slice(0, 12)} within ${minutes} min, so ${job.reviewer} reviews it`
    patchJob(job.id, { assignment: why.slice(0, 400) })
    void outbox.say(job.sessionId, `PR review of ${job.repo}#${job.number}: ${why} on this device (routing.offline_fallback in .mendcode/reviewers.yaml).`)
  }

  /** The claims on a PR in which `cover` (trusted by its login, or the claim's author when it has none) stands in for `personal`. */
  const coverClaims = (cover: ReviewerEntry, personal: string, claims: readonly Claim[]) =>
    claims.filter((claim) => claim.reviewer === claimIdOf(cover.id) && !!claim.covers?.includes(claimIdOf(personal)) && (!cover.login || sameLogin(claim.author, cover.login)))

  type FallbackRefusal = GateRefusal & { cancel?: string | undefined }
  /**
   * The offline fallback's checks for `job`. A stand-in job (`covers`): before its time it waits (a claim comment woke it early);
   * a covered reviewer holding a live claim is back, so it waits for that claim; one whose review of the head is on the pull request
   * answered it. A personal reviewer's job: a live claim of a stand-in covering it makes it wait; a stand-in's review of this head
   * answers it, so the personal reviewer never posts a second review of a head its fallback reviewed. `write`: the same, right
   * before a post (a stand-in yields to a covered reviewer's live claim even then; a personal reviewer only to a posted review).
   */
  async function fallbackRefusal(job: ReviewJob, { write }: { write: boolean }): Promise<FallbackRefusal | undefined> {
    const covers = job.covers ?? []
    if (!covers.length && job.scope !== "personal") return undefined
    const login = await watch.loginOf(job.directory).catch(() => undefined)
    const registry = await registryOf(job.directory, "all", login).catch(() => undefined)
    const fallback = registry?.routing.offlineFallback
    const reviewers = new Map((registry?.reviewers ?? []).map((entry) => [entry.id, entry]))
    if (covers.length) {
      if (!fallback || fallback.reviewer !== job.reviewer) return { ok: false, cancel: "routing.offline_fallback no longer names this reviewer in .mendcode/reviewers.yaml", reason: "" }
      const due = job.createdAt + fallback.afterMs
      if (!write && now() < due) return { ok: false, until: due, reason: `offline fallback: ${job.reviewer} reviews this pull request at ${isoMinute(due)} unless ${coveredNames(covers, reviewers)} claims or reviews its head first` }
      const read = await readClaims(job.repo, job.number, job.directory)
      if (!read) return { ok: false, until: now() + 60_000, reason: "offline fallback: the pull request's claims could not be read, so it cannot tell whether its personal reviewer is back; asked again in a minute" }
      for (const id of covers) {
        const entry = reviewers.get(id)
        if (!entry) continue
        const holder = winningClaim(entry, job.repo, job.number, read.claims)
        if (holder) return { ok: false, holder, reason: `offline fallback not needed now: ${whose(entry)} is back (device ${holder.owner.slice(0, 40)} claimed this pull request until ${isoMinute(holder.expiresAt)}); it reviews there` }
        const review = entry.login && job.head ? await reviewOfHead(job.repo, job.number, job.head, entry.login, entry.id, job.directory) : undefined
        if (review !== undefined) return { ok: false, reviewed: { id: review }, reason: `offline fallback not needed: reviewed by ${whose(entry)} (review ${review})` }
      }
      return undefined
    }
    const cover = fallback ? reviewers.get(fallback.reviewer) : undefined
    if (!cover || cover.id === job.reviewer) return undefined
    const read = await readClaims(job.repo, job.number, job.directory)
    if (!read) return undefined
    const standing = coverClaims(cover, job.reviewer, read.claims)
    if (!standing.length) return undefined
    const live = [...resolveClaims(standing, now()).values()].find((claim) => claim.owner !== deviceOf())
    if (live && !write) return { ok: false, holder: live, reason: `waiting: ${whose(cover)} stands in for this reviewer (routing.offline_fallback) on device ${live.owner.slice(0, 40)} until ${isoMinute(live.expiresAt)}` }
    const author = cover.login ?? standing.find((claim) => claim.author)?.author
    const review = author && job.head ? await reviewOfHead(job.repo, job.number, job.head, author, cover.id, job.directory) : undefined
    if (review !== undefined) return { ok: false, reviewed: { id: review, device: standing.at(-1)!.owner }, reason: `reviewed by ${whose(cover)} as the offline fallback (review ${review}); not reviewed again here` }
    return undefined
  }

  /** A submitted review of `head` by `login` on PR `number` (that reviewer's MendCode ran elsewhere); undefined when there is none. */
  async function reviewedElsewhere(repo: string, number: number, head: string, login: string, directory: string): Promise<number | undefined> {
    const reviews = await reviewsOf(repo, number, directory)
    for (const item of reviews ?? []) {
      const review = item as { id?: unknown; commit_id?: unknown; state?: unknown; body?: unknown; user?: { login?: unknown } | null }
      if (review.commit_id === head && review.state !== "PENDING" && review.state !== "DISMISSED" && typeof review.id === "number" && typeof review.user?.login === "string" && sameLogin(review.user.login, login) && isMendCodeReview(review.body)) return review.id
    }
    return undefined
  }

  /**
   * The jobs this daemon only records for another daemon's personal reviewer (`waiting`, no time to run): at most every
   * `CLAIM_REFRESH_MS` each reads its PR's claims, naming the device that works on it, and the reviews, closing the job as done
   * once that reviewer's login submitted a review of the head. At most `REFRESH_PER_POLL` per poll.
   */
  const refreshed = new Map<string, number>()
  async function refreshWaiting({ directory, repo, reviewers, here, open }: { directory: string; repo: string; reviewers: ReadonlyMap<string, ReviewerEntry>; here: { device: string; login?: string | undefined }; open?: ReadonlySet<number> | undefined }) {
    const at = now()
    const kept = ledger.list({ repo, states: ["waiting"] }).filter((job) => job.directory === directory && job.notBefore === undefined && job.scope === "personal")
    // A pull request that is no longer open (the listing was complete) has nothing left to wait for.
    if (open) for (const job of kept) if (!open.has(job.number)) move(job.id, "cancelled", { error: "the pull request is no longer open" })
    // This daemon's offline fallback reviewed the head in this reviewer's place: the record of it is done here too.
    for (const job of kept) {
      const standIn = ledger.list({ repo, number: job.number, states: ["done"] }).find((other) => other.head === job.head && !!other.covers?.includes(job.reviewer) && !other.assignment?.startsWith("offline fallback not needed"))
      if (standIn && ledger.get(job.id)?.state === "waiting" && move(job.id, "running")) move(job.id, "done", { assignment: waitingAssignment(`reviewed on this device by ${standIn.reviewer}, the offline fallback (job ${standIn.id})`, job.assignment) })
    }
    const away = kept.filter((job) => {
      const entry = reviewers.get(job.reviewer)
      return (!open || open.has(job.number)) && !!entry && !runsHere(entry, here) && at - (refreshed.get(job.id) ?? -Infinity) >= CLAIM_REFRESH_MS
    })
    for (const job of away.slice(0, REFRESH_PER_POLL)) {
      refreshed.set(job.id, at)
      const entry = reviewers.get(job.reviewer)!
      const read = await readClaims(repo, job.number, directory)
      const holder = read && winningClaim(entry, repo, job.number, read.claims)
      const review = entry.login && job.head ? await reviewedElsewhere(repo, job.number, job.head, entry.login, directory) : undefined
      if (review !== undefined) {
        // The reviewer's own daemon reviewed this head: the job this daemon kept for it is done there, not here.
        if (move(job.id, "running")) move(job.id, "done", { assignment: waitingAssignment(`reviewed by ${whose(entry)}${holder ? ` on device ${holder.owner.slice(0, 40)}` : ""} (review ${review})`, job.assignment), ...(holder ? { owner: holder.owner.slice(0, 120) } : {}) })
        refreshed.delete(job.id)
        continue
      }
      patchJob(job.id, { assignment: waitingAssignment(holder ? holderText(entry, holder) : awayText(entry), job.assignment), ...(holder ? { owner: holder.owner.slice(0, 120) } : {}) })
    }
    for (const id of refreshed.keys()) if (!ledger.get(id) || ledger.get(id)!.state !== "waiting") refreshed.delete(id)
  }

  // ── Routing, eligibility, stacks and catch-up for each listing ───────────────────────────────────────────────────────

  /** The stack graph of each watched directory's last listing (in memory: the first poll after a start has no previous one). */
  const graphs = new Map<string, StackGraph>()
  /** The implicit personal reviewer of a `requested` watch's login, when the registry lists none for it. */
  const implicitPersonal = (login: string): ReviewerEntry => ({ id: `personal:${login}`, scope: "personal", login, areas: [], capabilities: ["review", "fix", "publish"] })
  /** The personal reviewer of `login` in `registry` (the first listed one), else the implicit one. */
  const personalOf = (registry: ReviewerRegistry, login: string) => registry.reviewers.find((entry) => entry.scope === "personal" && entry.login?.toLowerCase() === login.toLowerCase()) ?? implicitPersonal(login)

  /**
   * The registry a watch routes with: `.mendcode/reviewers.yaml` at the checkout's HEAD (like the triggers), its logins in the
   * checkout's forge's username syntax (a GitLab or Gitea username may hold `.` and `_`), plus the implicit
   * personal reviewer of a `requested` watch's login when the file lists none for it: `requested` worked before any registry did.
   */
  async function registryOf(directory: string, role: RepoRole, login: string | undefined): Promise<ReviewerRegistry> {
    const forge = (await forgeOf(directory))?.kind
    const { registry } = await readRegistry({ directory, ref: "HEAD", git, ...(forge ? { forge } : {}) }).catch(() => ({ registry: undefined }))
    const base: ReviewerRegistry = registry ?? { version: 1, reviewers: [{ id: "global", scope: "global", areas: [], capabilities: ["review", "fix", "publish"] }], routing: { default: "global", global: "always", labels: {} } }
    if (role !== "requested" || !login || base.reviewers.some((entry) => entry.scope === "personal" && entry.login?.toLowerCase() === login.toLowerCase())) return base
    return { ...base, reviewers: [...base.reviewers, implicitPersonal(login)] }
  }

  /**
   * A `requested` watch's question for an `@mendcode` comment addressed to no one on a PR that does not request its login: does
   * routing give that PR to the login's personal reviewer (an area its changed files touch, or a label route)? The same `route` the
   * watch's reviews follow, so a comment is taken exactly where a review would be. `undefined` when the files cannot be read.
   */
  async function routedHere(directory: string, facts: PrFacts): Promise<boolean | undefined> {
    const login = await watch.loginOf(directory).catch(() => undefined)
    if (!login) return false
    const registry = await registryOf(directory, "requested", login)
    const me = personalOf(registry, login)
    if (!me.capabilities.includes("review") || !(me.areas.length > 0 || Object.values(registry.routing.labels).includes(me.id))) return false
    const files = me.areas.length ? facts.files ?? await filesOf(directory, facts.number) : facts.files ?? []
    if (!files) return undefined
    return route({ facts, files, registry }).some((assignment) => assignment.reviewer === me.id)
  }

  /** The changed files of a PR (for `filters.paths` and area routing), read only for PRs with an event. */
  async function filesOf(directory: string, number: number): Promise<string[] | undefined> {
    const forge = await forgeOf(directory)
    if (forge) return (await forge.provider.files?.({ repo: forge.repo, number }).catch(() => undefined))?.slice(0, 3000)
    const viewed =await run({ argv: ["pr", "view", String(number), "--json", "files"], cwd: directory }).catch(() => ({ code: 1, out: "", err: "" }))
    if (viewed.code !== 0) return undefined
    const files = View(viewed.out).files
    return Array.isArray(files) ? files.flatMap((file) => typeof file.path === "string" ? [file.path] : []).slice(0, 3000) : undefined
  }

  /** Renews the watch's lease on this device (`watch:<repo>`) once half of it has passed: availability for the reviews page. */
  const leases = new Map<string, number>()
  function heartbeat(repo: string) {
    const key = `watch:${repo}`
    if ((leases.get(key) ?? 0) - now() > WATCH_LEASE_MS / 2) return
    try { const claimed = ownership.claim(key, deviceOf(), WATCH_LEASE_MS); if (claimed.ok) leases.set(key, claimed.lease.expiresAt) } catch { /* availability only */ }
  }

  /**
   * Whether a catch-up leaves `repo` + PR `number` at `head` alone for `reviewer`: it was reviewed (the review state, or a finished
   * job), or its job failed for good (an error that retrying does not change). The failure was told once; /reviews still lists it
   * and its retry runs it again, but a daemon start does not queue it and announce it again.
   */
  const reviewedHead = (repo: string, reviewer: string, number: number, head: string) =>
    readReviewState(options.dir, repo, number).lastHead === head || ledger.list({ repo, number, reviewer }).some((job) => job.head === head && (job.state === "done" || (job.state === "failed" && failureKind(job.error ?? "") !== "transient")))

  async function plan({ directory, role, login, prs, catchUp }: { directory: string; sessionId: string; role: RepoRole; login?: string | undefined; prs: PrFacts[]; catchUp: boolean }): Promise<WatchPlan> {
    const config = await baseConfig(directory)
    const repo = watch.watchOf(directory)?.repo ?? await repoCached(directory).catch(() => directory)
    const registry = await registryOf(directory, role, login)
    const here = { device: deviceOf(), ...(login ? { login } : {}) }
    heartbeat(repo)
    const graph = buildStackGraph(prs)
    const previous = graphs.get(directory)
    graphs.set(directory, graph)
    const extra: Array<WatchPlan["extra"][number]> = []
    if (previous) {
      const { changes } = stackChanges(previous, graph)
      for (const change of changes) for (const number of change.revalidate) if (!extra.some((item) => item.number === number)) extra.push({ number, trigger: "stack", reason: `stack: ${change.reason}` })
    }
    const reviewers = new Map(registry.reviewers.map((entry) => [entry.id, entry]))
    /** Whether the PR requests a review from, or is assigned to, this daemon's login. */
    const asksMe = (facts: PrFacts) => !!login && [...facts.requested, ...facts.assignees].some((who) => sameLogin(who, login))
    /** This login's personal reviewers, which a `requested` watch runs. */
    const isMine = (entry: ReviewerEntry) => entry.scope === "personal" && sameLogin(entry.login, login)
    /** Whether routing can give a PR that does not ask this login to one of its personal reviewers: an area or a label route. */
    const routable = registry.reviewers.some((entry) => isMine(entry) && entry.capabilities.includes("review") && (entry.areas.length > 0 || Object.values(registry.routing.labels).includes(entry.id)))
    /** Claims read for this listing, per PR: a catch-up's, so `decide` sees another device's live claim without reading again. */
    const claimsRead = new Map<number, Claim[]>()
    const wantsFiles = needsFiles(config) || registry.reviewers.some((entry) => entry.areas.length > 0)
    /** Changed files read for this listing, per PR (a listing carries none): read once, for the catch-up and `decide` alike. */
    const filesRead = new Map<number, string[]>()
    const filesFor = async (facts: PrFacts) => {
      if (facts.files) return facts.files
      const known = filesRead.get(facts.number)
      if (known) return known
      const files = await filesOf(directory, facts.number)
      if (files) filesRead.set(facts.number, files)
      return files
    }
    const withFiles = (facts: PrFacts): PrFacts => { const files = facts.files ?? filesRead.get(facts.number); return files ? { ...facts, files } : facts }
    if (catchUp && login) {
      // Offline catch-up from the provider's current state: what routes to this daemon's personal reviewers, whose head was not
      // reviewed yet, and which no other device holds a live claim of (read from the PRs' comments, `CATCH_UP_CLAIM_READS` at most).
      const own = role === "requested" ? [personalOf(registry, login)] : registry.reviewers.filter((entry) => entry.scope === "personal" && entry.capabilities.includes("review") && runsHere(entry, here))
      for (const me of own) {
        const done = (number: number, head: string) => reviewedHead(repo, me.id, number, head)
        const open = prs.filter((pr) => !done(pr.number, pr.head))
        // An area reviewer routes by changed files, which the listing does not carry: a PR opened while this daemon was offline
        // would never match. The newest `CATCH_UP_FILE_READS` unreviewed PRs have theirs read once.
        if (me.areas.length) for (const pr of backlogOrder(open).slice(0, CATCH_UP_FILE_READS)) await filesFor(pr)
        const routed = open.map(withFiles).filter((pr) => route({ facts: pr, files: pr.files ?? [], registry }).some((assignment) => assignment.reviewer === me.id))
        const claims: Claim[] = []
        for (const pr of routed.slice(0, CATCH_UP_CLAIM_READS)) {
          const read = claimsRead.get(pr.number) ?? (await readClaims(repo, pr.number, directory))?.claims
          if (!read) continue
          claimsRead.set(pr.number, read)
          claims.push(...trustedClaims(me, read))
        }
        const pending = pendingFor({ reviewer: me, prs: routed, registry, files: (number) => filesRead.get(number), claims, done, repo, device: here.device, now: now() })
        // A PR that asks this login is `requested`; one only routing gives it (a label) is `routed`, an automatic event like a push.
        const triggerOf = (number: number) => routed.some((pr) => pr.number === number && asksMe(pr)) ? "requested" as const : "routed" as const
        for (const work of pending) if (!extra.some((item) => item.number === work.number)) extra.push({ number: work.number, trigger: triggerOf(work.number), reason: work.reason })
        // Held by another device of this reviewer: `decide` records it as waiting, naming the holder.
        for (const pr of routed) {
          if (pending.some((work) => work.number === pr.number) || extra.some((item) => item.number === pr.number)) continue
          const holder = winningClaim(me, repo, pr.number, claimsRead.get(pr.number) ?? [])
          if (holder && holder.owner !== here.device) extra.push({ number: pr.number, trigger: triggerOf(pr.number), reason: `claimed by device ${holder.owner.slice(0, 40)}` })
        }
      }
    }
    await refreshWaiting({ directory, repo, reviewers, here, open: prs.length < MAX_OPEN_PRS ? new Set(prs.map((pr) => pr.number)) : undefined }).catch(() => undefined)
    const decide: WatchPlan["decide"] = async (facts, trigger) => {
        // A `requested` watch takes someone else's PR only from this login's personal reviewers (by area or label), never the
        // global reviewer's work or another login's; without such a route there is nothing to read for it.
        const mine = role !== "requested" || asksMe(facts)
        if (!mine && !routable) return { ok: false, reason: `requested: @${login ?? "this login"} is neither a requested reviewer nor an assignee` }
        const files = wantsFiles ? await filesFor(facts) : facts.files
        const full: PrFacts = files ? { ...facts, files } : facts
        const gate = eligibilityTrigger(trigger)
        const verdict = eligible({ facts: full, config, trigger: gate, login })
        if (!verdict.ok) return verdict
        const routed = route({ facts: full, files: files ?? [], registry })
        const reason = extra.find((item) => item.number === facts.number)?.reason
        const stack = stackSummary(graph, facts.number)
        const text = (routedReason: string) => `${routedReason}${reason ? `; ${reason}` : ""}`
        const assignments: ReviewAssignment[] = []
        const refused: string[] = []
        for (const assignment of routed) {
          const entry = reviewers.get(assignment.reviewer)
          if (!entry) continue
          if (!mine && !isMine(entry)) continue
          if (!runsHere(entry, here)) {
            // Another daemon's personal reviewer: recorded as waiting (offline is not failure), naming a device that claimed it.
            if (entry.scope !== "personal") continue
            const read = claimsRead.get(facts.number) ?? (await readClaims(repo, facts.number, directory))?.claims
            if (read) claimsRead.set(facts.number, read)
            const holder = read && winningClaim(entry, repo, facts.number, read)
            assignments.push({ reviewer: entry.id, scope: entry.scope, assignment: assignment.reason, waiting: holder ? holderText(entry, holder) : awayText(entry), ...(holder ? { owner: holder.owner.slice(0, 120) } : {}), ...(stack ? { stack } : {}) })
            continue
          }
          // A `requested` watch runs its login's personal reviewer; an `all` watch the global reviewers and the personal ones of
          // this daemon (its login or device), which no other daemon would run.
          if (role === "requested" && !(entry.scope === "personal" && sameLogin(entry.login, login))) continue
          if (entry.scope === "personal") {
            // The personal profile only narrows (config-layers refuses what would widen the repository's config).
            const personal = personalLayer(repo, entry.login ?? login)
            const narrowed = personal !== undefined ? eligible({ facts: full, config: layeredConfig(config, { personal }).config, trigger: gate, login }) : verdict
            if (!narrowed.ok) { refused.push(`${entry.id}: personal profile: ${narrowed.reason}`); continue }
            const holder = winningClaim(entry, repo, facts.number, claimsRead.get(facts.number) ?? [])
            if (holder && holder.owner !== here.device) {
              assignments.push({ reviewer: entry.id, scope: entry.scope, assignment: text(assignment.reason), waiting: holderText(entry, holder), notBefore: holder.expiresAt + 1_000, owner: here.device, ...(stack ? { stack } : {}) })
              continue
            }
          }
          assignments.push({ reviewer: entry.id, scope: entry.scope, assignment: text(assignment.reason), owner: here.device, ...(stack ? { stack } : {}) })
        }
        const standIn = role === "requested" ? undefined : offlineFallbackFor({ registry, reviewers, here, assignments })
        if (standIn) assignments.push({ ...standIn, ...(stack ? { stack } : {}) })
        if (assignments.some((assignment) => assignment.waiting === undefined)) return { ok: true, reason: verdict.reason, assignments }
        const why = refused.length ? refused.join("; ") : routed.length ? `routed to ${routed.map((assignment) => `${assignment.reviewer} (${assignment.reason})`).join(", ")}, not to this daemon` : "no reviewer in .mendcode/reviewers.yaml takes it"
        return { ok: true, reason: why, assignments }
    }
    // The open PRs whose current head no reviewer of this daemon has reviewed yet (a PR opened while no watch ran, or while this
    // daemon was down): the bounded backlog (backlog.ts) joins the catch-up as `backlog` events, decided like any other.
    const backlog = catchUp ? await backlogOf({ directory, repo, login, config, prs: prs.filter((pr) => !extra.some((item) => item.number === pr.number)), decide }) : undefined
    for (const pick of backlog?.queued ?? []) extra.push({ number: pick.number, trigger: "backlog", reason: pick.reason })
    return { extra, decide, ...(backlog ? { backlog } : {}) }
  }

  /**
   * The backlog of one catch-up (backlog.ts): eligibility and routing are the plan's own `decide` (only this daemon's reviewers
   * that run here count; another daemon's are its own backlog), and a head counts as reviewed by a reviewer when its review state
   * or a finished job says so, a job of it is open, or a review of it that counts for that reviewer is on the pull request from
   * this login or a publisher `publishers` counts (`headReviewOf`). A PR's reviews are read once, and only for PRs `decide` takes.
   */
  async function backlogOf({ directory, repo, login, config, prs, decide }: { directory: string; repo: string; login: string | undefined; config: ReviewConfig; prs: PrFacts[]; decide: WatchPlan["decide"] }) {
    const reviews = new Map<number, Promise<unknown[] | undefined>>()
    const reviewsOn = (number: number) => { let known = reviews.get(number); if (!known) { known = reviewsOf(repo, number, directory).catch(() => undefined); reviews.set(number, known) } return known }
    const self = login ?? await watch.loginOf(directory).catch(() => undefined)
    const rule = config.publishers
    const counts = (author: ReviewAuthor) => sameLogin(author.login, self) || author.bot || rule === "anyone"
      || Array.isArray(rule) && rule.some((entry) => sameLogin(entry, author.login))
      || rule === "maintainers" && ["OWNER", "MEMBER", "COLLABORATOR"].includes(author.association ?? "")
    return planBacklog({
      prs, config: config.backlog, now: now(),
      decide: async (facts): Promise<BacklogDecision> => {
        const decision = await decide(facts, "backlog")
        if (!decision.ok) return decision
        // An offline fallback's job waits on purpose (for the personal reviewers first): it is this daemon's work all the same.
        const here = decision.assignments.filter((assignment) => assignment.waiting === undefined || assignment.covers?.length).map((assignment) => assignment.reviewer)
        return here.length ? { ok: true, reviewers: here } : { ok: false, reason: decision.reason }
      },
      status: async (facts, reviewer): Promise<HeadStatus> => {
        if (reviewedHead(repo, reviewer, facts.number, facts.head)) return "reviewed"
        if (openJobsOf(repo, facts.number).some((job) => job.reviewer === reviewer && job.head === facts.head && job.directory === directory)) return "queued"
        const posted = await reviewsOn(facts.number)
        if (!posted) return "unknown"
        return headReviewOf({ reviews: posted, head: facts.head, reviewer, counts }) !== undefined ? "reviewed" : "unreviewed"
      },
    })
  }

  const watch = createRepoWatch({
    dir: options.dir, run, ...(options.now ? { now } : {}), ...(options.monotonic ? { monotonic: options.monotonic } : {}), ...(options.intervalMs ? { intervalMs: options.intervalMs } : {}),
    jobs: ledger, concurrency: options.concurrency ?? MAX_CONCURRENT_REVIEWS, ...(options.random ? { random: options.random } : {}),
    enabled: options.enabled, sessionExists: options.sessionExists, notify: (sessionId, text) => void outbox.say(sessionId, text),
    triggers: async (directory) => (await baseConfig(directory)).triggers,
    limits: async (directory) => { const config = await baseConfig(directory); return { cooldown: config.cooldown, reviewers: reviewRole(config.reviewers) } },
    start: async (entry) => {
      let outcome: JobOutcome = undefined
      await options.schedule(async () => { outcome = entry.kind === "command" ? await commandJob(entry) : await reviewJob(entry) })
      return outcome
    },
    followUp,
    plan,
    forge: forgeOf,
    claimsChanged: wakeClaimWaits,
    routedHere,
  })

  // ── Audit: an explicit review of the whole repository; findings stay in the session ─────────────────────────────────

  /** Runs an audit job (queued by `audit`, or recovered after a restart): `runAudit` at the job's commit, never published. */
  async function auditJob(job: ReviewJob): Promise<JobOutcome> {
    const label = `Audit of ${job.repo}`
    try {
      const login = await watch.loginOf(job.directory).catch(() => undefined)
      const contextWindow = options.contextWindow?.(job.sessionId)
      const done = await audit({
        directory: job.directory, head: job.head, git, sessionFactory: recordedSessions(options.sessions(job.sessionId, job.directory), job.id),
        account: accountFor(job, job.repo, job.number, job.head), calling: callingFor(job, job.repo, job.number, job.head), memory: memoryFor(job.scope, job.directory, login),
        ...(contextWindow ? { contextWindow } : {}), ...(hasProgress(job.checkpoint) ? { checkpoint: job.checkpoint } : {}),
      })
      if (done.stop && done.status !== "failed") { void outbox.say(job.sessionId, done.text); return checkpointJob({ job, stop: done.stop, checkpoint: done.checkpoint, config: done.config, sessionId: job.sessionId, label }) }
      if (done.checkpoint) try { ledger.checkpoint(job.id, done.checkpoint) } catch { /* pruned */ }
      void outbox.say(job.sessionId, done.text)
      return done.status === "failed" ? { error: done.reason ?? "the audit failed", retry: false } : undefined
    } catch (error) {
      void outbox.say(job.sessionId, `${label} failed: ${errorText(error)}`)
      return { error: errorText(error), retry: false }
    }
  }

  // ── The platform handle for control.ts ───────────────────────────────────────────────────────────────────────────────

  async function reviewersOf(directory: string): Promise<PrReviewerSummary[]> {
    const info = watch.watchOf(directory)
    const login = info?.login ?? await watch.loginOf(directory).catch(() => undefined)
    const role: RepoRole = info?.role ?? reviewRole((await baseConfig(directory).catch(() => DEFAULT_REVIEW_CONFIG)).reviewers)
    const registry = await registryOf(directory, role, login)
    const repo = info?.repo ?? repos.get(directory)
    const lease = repo ? (() => { try { return ownership.current(`watch:${repo}`) } catch { return undefined } })() : undefined
    const here = { device: deviceOf(), ...(login ? { login } : {}) }
    const at = now()
    return registry.reviewers.slice(0, 200).map((entry): PrReviewerSummary => {
      // This device's own reviewers are online while the watch runs and holds its lease. Any reviewer is online while a claim of it
      // read from a PR (this device's or another's) is live, and offline once the last one seen expired; else unknown here.
      const local = runsHere(entry, here)
      const leased = local && !!info?.active && !!lease && lease.owner === here.device && lease.expiresAt > at
      const claim = claimsSeen.get(entry.id)
      const claimed = !!claim && claim.expiresAt > at
      const availability = leased || claimed ? "online" : claim || local ? "offline" : "unknown"
      const device = claim && !leased ? claim.owner : entry.device ?? (local ? here.device : undefined)
      const seenAt = leased && lease ? lease.expiresAt - WATCH_LEASE_MS : claim?.acquiredAt
      return {
        id: entry.id.slice(0, 120), scope: entry.scope, ...(entry.login ? { login: entry.login } : {}), areas: entry.areas.slice(0, 50).map((area) => area.slice(0, 300)),
        availability,
        ...(device ? { device: device.slice(0, 120) } : {}),
        ...(seenAt !== undefined ? { lastSeenAt: Math.trunc(seenAt) } : {}),
      }
    })
  }

  const handle: PlatformHandle = {
    dataDir: options.dir,
    jobs: ledger,
    device: deviceOf,
    rows: () => watch.rows(),
    get concurrency() { return watch.concurrency },
    repoOf: repoCached,
    loginOf: (directory) => watch.loginOf(directory),
    reviewers: reviewersOf,
    async retry(jobId, reason) {
      const job = ledger.get(jobId)
      if (!job) return { ok: false, message: `no job ${jobId}` }
      // The checkpoint stays with the job: a checkpointed (or quota-waiting) one resumes from it at its next run.
      const resumes = hasProgress(job.checkpoint) && (job.state === "checkpointed" || job.state === "waiting")
      if (!move(jobId, "pending", { notBefore: undefined, error: undefined, stop: undefined, attempts: 0 })) return { ok: false, message: `job ${jobId} is ${job.state}; it cannot be queued again` }
      waits.delete(jobId)
      watch.kick()
      return { ok: true, text: `Queued #${job.number} of ${job.repo} again (${reason.slice(0, 200)})${resumes ? ", continuing from its checkpoint without a second review pass" : ""}.` }
    },
    async audit({ sessionId, directory }) {
      const forge = await forgeOf(directory)
      const resolved = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], directory)
      const head = resolved.out.trim()
      if (resolved.code !== 0 || !/^[0-9a-f]{40,64}$/.test(head)) return { ok: false, message: `${directory} has no commit to audit` }
      const repo = await repoCached(directory).catch(() => path.basename(directory))
      const info = watch.watchOf(directory)
      const personal = info?.role === "requested" && info.login
      try {
        // An audit is a job like a review (one at a time with the rest, recovered after a restart), with no pull request: number 1.
        const job = ledger.upsert({
          provider: forge?.kind ?? "github", repo, directory, number: 1, sessionId, reviewer: personal ? `personal:${info.login}` : "global", scope: personal ? "personal" : "global",
          trigger: "manual", coverage: "audit", base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", head, configKey: head, owner: deviceOf(), title: `Audit of ${repo} at ${head.slice(0, 12)}`.slice(0, 300),
        })
        watch.kick()
        return { ok: true, jobId: job.id, text: `Auditing ${directory} at ${head.slice(0, 12)} (job ${job.id}). The findings arrive in this session and are never posted.` }
      } catch (error) { return { ok: false, message: errorText(error) } }
    },
  }

  const configControl = createConfigControl({ dataDir: options.dir, repo: (directory) => repoCached(directory).catch(() => undefined), login: (directory) => watch.loginOf(directory), git, now, provider: "github", profiles })
  // The reviews page's pull request states load with the page's first read of them, never at start-up.
  let prStates: import("./pr-states").PrStates | undefined
  // One shared load: concurrent first reads (one per repository) must all fill the same cache, not one each.
  const loadPrStates = sharedLoad(() => import("./pr-states").then(({ createPrStates }) => (prStates = createPrStates({ run, now }))))
  const pullRequests = { fetch: async (repo: string, directory: string, refresh: boolean) => (await loadPrStates()).fetch(repo, directory, refresh), cached: (repo: string) => prStates?.cached(repo) }
  const platform = createPlatformControl(handle, { configControl, takeover: { takeOver, release }, now, tokens24h: () => accounting.last24h().tokens, pullRequests })

  /** `full` (`review` only): review the head whole even when it was already reviewed with this config. */
  type ControlInput = { sessionId: string; action: PrReviewAction; directory?: string | undefined; pr?: string | undefined; full?: boolean | undefined; role?: "all" | "requested" | undefined; jobId?: string | undefined; reason?: string | undefined; scope?: ReviewerScope | undefined; patch?: Record<string, unknown> | undefined; version?: number | undefined; pullRequests?: "cached" | "refresh" | undefined }
  type ControlResult = { ok: true; text: string; watches: ReturnType<typeof watch.rows>; dashboard?: PrReviewDashboard; config?: PrReviewConfigView } | { ok: false; message: string }

  async function control({ sessionId, action, directory: given, pr, full, role, jobId, reason, scope, patch, version, pullRequests: readPullRequests }: ControlInput): Promise<ControlResult> {
    if (!options.enabled()) return { ok: false, message: PR_REVIEW_DISABLED }
    const directory = given ?? options.sessionDirectory(sessionId)
    if (!directory || !path.isAbsolute(directory)) return { ok: false, message: "unknown session directory" }
    const done = (text: string) => ({ ok: true as const, text, watches: watch.rows() })
    if (action === "list") return done(`${watch.describe()}\nThis device runs at most ${watch.concurrency} review${watch.concurrency === 1 ? "" : "s"} or command${watch.concurrency === 1 ? "" : "s"} at once (prReview.concurrency).`)
    if (action === "unwatch-repo") { const result = watch.unwatchRepo(directory); return result.ok ? done(result.text) : result }
    if (action === "watch-repo") {
      const result = await watch.watchRepo(sessionId, directory, role)
      // GitLab and Gitea: what this daemon does not do there is said once, here, never skipped silently.
      return result.ok ? done(`${result.text}${/^Watching /.test(result.text) ? gatedText(await forgeOf(directory)) : ""}`) : result
    }
    if (action === "publish-on" || action === "publish-off") {
      watch.setPublish(directory, sessionId, action === "publish-on" ? "allowed" : "denied")
      // `publish-off` keeps what is held (a later `publish-on` posts it while its head is current).
      const waiting = action === "publish-on" ? held.take(directory) : []
      for (const review of waiting) void options.schedule(() => postHeld(review))
      return done(action === "publish-on" ? `Reviews of this repository are posted to ${(await forgeOf(directory))?.name ?? "GitHub"} from now on${waiting.length ? `; posting ${waiting.length} held review${waiting.length === 1 ? "" : "s"}` : "; no finished review was waiting"}.` : "Reviews of this repository stay in this session.")
    }
    if (action !== "review" && action !== "describe") {
      const result = await platform.run({ sessionId, action, directory, jobId, reason, scope, patch, version, pullRequests: readPullRequests })
      return result.ok ? { ...done(result.text), ...(result.dashboard ? { dashboard: result.dashboard } : {}), ...(result.config ? { config: result.config } : {}) } : result
    }
    const ref = parseRef(pr)
    if (!ref.ok) return ref
    const forge = await forgeOf(directory)
    let number = ref.number
    if (number === undefined && forge) {
      // GitLab and Gitea: the open PR/MR whose source branch is the one named, else the checkout's current branch.
      const branch = ref.arg ?? (await git(["rev-parse", "--abbrev-ref", "HEAD"], directory)).out.trim()
      const listed = await forge.provider.listOpen({ directory, repo: forge.repo }).catch(() => undefined)
      number = listed?.ok ? listed.prs.find((item) => !item.fork && item.headRef === branch)?.number ?? listed.prs.find((item) => item.headRef === branch)?.number : undefined
      if (number === undefined) return { ok: false, message: `no open ${forge.kind === "gitlab" ? "merge request" : "pull request"} found for the branch ${branch.slice(0, 200)}; name one: /pr review 12` }
    }
    if (number === undefined) {
      const current = await run({ argv: ["pr", "view", ...(ref.arg ? [ref.arg] : []), "--json", "number", "--jq", ".number"], cwd: directory })
      number = current.code === 0 && /^\d{1,7}$/.test(current.out) ? Number(current.out) : undefined
      if (number === undefined) return { ok: false, message: "no pull request found for the current branch; name one: /pr review 12" }
    }
    // The repository's exclusions hold for `/pr review` too (the narrowing filters and the mode do not: this is the owner's own ask).
    const facts = await prFacts(directory, number).catch(() => undefined)
    if (facts) {
      const verdict = eligible({ facts, config: await policyOf(directory, number), trigger: "manual" })
      if (!verdict.ok) return { ok: false, message: `#${number} is not reviewed: ${verdict.reason} (filters in .mendcode/review.yaml on the base branch)` }
    }
    if (action === "describe") {
      const described = await describeFromSession({ sessionId, directory, number })
      return described.ok ? done(described.text) : described
    }
    // A `requested` watch reviews as its login's personal reviewer, an `all` watch as the repository's default global reviewer, each
    // under the id reviewers.yaml gives it: its claims and its per-head review marker then match the watch's own reviews of that head,
    // so a head the watch reviewed as `team` is not posted again as `global`.
    const reviewer = await commandReviewer(directory)
    // A review of this PR that is queued or running already is the one this request asks for: it joins it, nothing is spent twice.
    const joined = watch.openReview(directory, number, "", reviewer.id)
    if (joined) return done(`#${number} is already being reviewed (job ${joined.id}, ${joined.state}${joined.checkpoint.phase ? `, ${joined.checkpoint.phase}` : ""}${joined.head ? `, head ${joined.head.slice(0, 12)}` : ""}); this request joined it, and the findings arrive in the session that started it. ${OPEN_HINT(joined.id)}`)
    // The same head under the same config was reviewed already: answered now, before anything is spent, unless `full` is asked.
    if (facts && !full) {
      const repo = await repoCached(directory).catch(() => undefined)
      const state = repo ? readReviewState(options.dir, repo, number) : undefined
      if (repo && state?.lastHead === facts.head) {
        const configKey = await configKeyNow({ directory, repo, base: facts.base, baseRef: facts.baseRef, scope: reviewer.scope }).catch(() => undefined)
        if (configKey && reviewedUnder({ repo, number, head: facts.head, configKey, state })) return done(`#${number} was already reviewed at ${facts.head.slice(0, 12)} with this config, so nothing was run. To review it again whole: /pr review ${number} full (pr_review with full: true).`)
      }
    }
    // A review that closed as partial at the token budget keeps its job checkpointed: asking again continues it with the parts and
    // candidates still missing, under a fresh allowance. `full` drops that checkpoint and reviews the whole diff again.
    const partial = facts ? ledger.list({ number, states: ["checkpointed"] }).find((job) => job.directory === directory && job.reviewer === reviewer.id && job.head === facts.head && job.coverage !== "audit" && job.stop?.kind === "budget" && hasProgress(job.checkpoint)) : undefined
    if (partial) {
      if (full) move(partial.id, "cancelled", { error: "replaced by a full review of the whole diff" })
      else {
        patchJob(partial.id, { sessionId })
        const continued = await handle.retry(partial.id, "/pr review continues the partial review")
        return continued.ok ? done(`${continued.text} The findings arrive in this session when it ends. ${OPEN_HINT(partial.id)}`) : { ok: false, message: continued.message }
      }
    }
    const queued = watch.review({ directory, sessionId, number, head: "" }, { reviewer: reviewer.id, scope: reviewer.scope }, forge ? { kind: forge.kind, repo: forge.repo } : undefined)
    return done(`Reviewing #${number}. The findings arrive in this session when the review ends (two passes, no edits).${queued ? ` Job ${queued}: ${OPEN_HINT(queued)}` : ""}`)
  }

  // Jobs a stopped daemon left queued or running start now, without waiting for a watch's first poll (the pump checks `enabled`).
  queueMicrotask(() => watch.kick())

  return {
    control, command: commandJob, tick: watch.tick, pending: watch.pending,
    /** Starts due work now: a raised `prReview.concurrency` fills its new slots without waiting for the next poll. */
    kick: () => watch.kick(),
    /** The session went idle: notices it could not take earlier are offered now. */
    idle: (sessionId: string) => outbox.flush(sessionId),
    held: outbox.held,
    /** The reviews running now with their steps, for a terminal that connects while one runs. */
    activity: () => activity.snapshot(),
    /** The platform's shared state, for daemon.ts and the tests. */
    platform: { handle, jobs: ledger, effects, accounting, permissions, profiles, ownership, device: deviceOf },
    stop() { watch.stop(); outbox.stop(); for (const hold of holds.values()) if (hold.timer) clearInterval(hold.timer) },
  }
}
export type PrReviewService = ReturnType<typeof createPrReviewService>
