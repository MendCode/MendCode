import type { PrFinding, PrJobSummary, PrReviewResult, PrStopReason, PrTokenUsage } from "@mendcode/protocol"
import type { PrReviewControl } from "@mendcode/protocol"
import type { z } from "zod"
import type { ReviewConfig } from "./config"

/** A cheap reader's structured read of one changed code file: what changed and the risk spots (RIGHT-side line ranges) a reviewer should open. */
export type CodeRead = { path: string; changed: string; risks: Array<{ start: number; end: number; kind: string; why: string }>; nothingRisky: boolean }

/**
 * The review platform's shared contracts (docs/pr-review.md): the shapes that cross module boundaries between the job ledger,
 * the providers, the routing, the memory context, the fix sessions, the phases, the stacks, the budget and the TUI page. Each
 * module owns its implementation; this file only names what they hand each other. Types only, plus a few constants.
 */

export type PrReviewAction = z.infer<typeof PrReviewControl>["action"]

/** The prompt cap of one call when neither the repo config nor the model says (half of it is the diff and graph context). */
export const DEFAULT_CONTEXT_TOKENS = 200_000

// ── Durable jobs (jobs.ts) ────────────────────────────────────────────────────────────────────────────────────────────────

export type JobState = PrJobSummary["state"]
export type JobTrigger = PrJobSummary["trigger"]
export type Coverage = PrJobSummary["coverage"]
export type ReviewerScope = PrJobSummary["scope"]

/** What a job keeps between attempts: enough to resume without a second model call for work already done. */
export type JobCheckpoint = {
  /** The phase the job stopped in and the ones already completed. */
  phase?: string | undefined
  completedPhases: string[]
  /** Candidates found but not verified yet: verification resumes on them instead of reviewing again. */
  candidates: PrFinding[]
  /** Findings already verified (any verdict), so a resume never judges one twice. */
  verified: PrFinding[]
  /** The review pass's answer when it completed (summary, walkthrough), so a resume can publish it. */
  result?: PrReviewResult | undefined
  /**
   * Fix rounds done and the open confirmed finding ids after each, for the no-progress guard. `interrupted`: a take-over stopped the
   * round before its push; it does not count, and `kept` is the local ref of its commit, which the release pushes.
   */
  rounds: Array<{ at: number; open: string[]; commit?: string | undefined; interrupted?: true | undefined; kept?: string | undefined }>
  /** Phase decisions with their reasons (`dynamic` phases), shown in the job's detail. */
  decisions: Array<{ phase: string; action: "added" | "skipped" | "kept"; reason: string }>
  /** The template's own sections the review pass wrote (`template.sections` with a prompt), so a resumed review still renders them. */
  sections?: Record<string, string> | undefined
  /** The readers' summaries of this head (readers.ts), so a resume of the same head does not pay for them again. */
  readers?: Array<{ id: string; paths: string[]; text: string; by: string; code?: CodeRead[] | undefined }> | undefined
}

export type ReviewJob = {
  id: string
  provider: PrJobSummary["provider"]
  repo: string
  /** The checkout the watch reads (`git` runs there; the review itself runs in a throwaway worktree). */
  directory: string
  number: number
  /** The session told about the job (the watch's session). */
  sessionId: string
  reviewer: string
  scope: ReviewerScope
  assignment?: string | undefined
  trigger: JobTrigger
  state: JobState
  coverage: Coverage
  base: string
  head: string
  /** The config version the job ran with (the base commit of `.mendcode/review.yaml` plus the personal profile version). */
  configKey: string
  attempts: number
  createdAt: number
  updatedAt: number
  /** Not before this time (backoff, quota reset, cooldown). */
  notBefore?: number | undefined
  owner?: string | undefined
  reviewSessionId?: string | undefined
  fixSessionId?: string | undefined
  control?: "reviewer" | "user" | undefined
  checkpoint: JobCheckpoint
  tokens: PrTokenUsage
  /** The part of `tokens` spent by cheap readers (purpose `read`). */
  readTokens?: PrTokenUsage | undefined
  stop?: PrStopReason | undefined
  error?: string | undefined
  /** Failing on transient errors (the network, the forge's servers, a sleep) since `since`, `waits` retries so far: no attempt spent. */
  transient?: { since: number; waits: number } | undefined
  title?: string | undefined
  url?: string | undefined
  stack?: PrJobSummary["stack"] | undefined
  /**
   * A global reviewer's job under `routing.offline_fallback`: the personal reviewers (registry ids) it stands in for. It waits until
   * `createdAt` plus the fallback's time, then reviews only if none of them claimed or reviewed the head meanwhile.
   */
  covers?: string[] | undefined
}

/** Who may move a job and where: the ledger refuses a transition not in this table. */
export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  pending: ["running", "waiting", "failed", "cancelled", "stale", "paused"],
  waiting: ["pending", "running", "cancelled", "stale", "paused"],
  running: ["validating", "fixing", "checkpointed", "done", "failed", "cancelled", "stale", "waiting", "paused"],
  fixing: ["validating", "running", "waiting", "checkpointed", "done", "failed", "cancelled", "stale", "paused"],
  validating: ["fixing", "waiting", "done", "failed", "checkpointed", "cancelled", "stale", "paused"],
  checkpointed: ["pending", "waiting", "cancelled", "stale", "paused"],
  paused: ["pending", "cancelled", "stale"],
  done: ["pending"],
  failed: ["pending"],
  cancelled: ["pending"],
  stale: ["pending"],
}

export interface JobLedger {
  /** A new job, or the existing one for the same `jobKey` (reviewer, repo, number, head, base, configKey) when it is not terminal. */
  upsert(input: Omit<ReviewJob, "id" | "state" | "attempts" | "createdAt" | "updatedAt" | "checkpoint" | "tokens"> & { state?: JobState }): ReviewJob
  get(id: string): ReviewJob | undefined
  /** Throws `RangeError` for a transition `JOB_TRANSITIONS` does not allow. */
  transition(id: string, state: JobState, patch?: Partial<Omit<ReviewJob, "id" | "state">>): ReviewJob
  checkpoint(id: string, patch: Partial<JobCheckpoint>): ReviewJob
  /** `read`: the tokens are a cheap reader's; they count in `tokens` too and are also kept apart in `readTokens`. */
  addTokens(id: string, tokens: PrTokenUsage, read?: boolean): ReviewJob
  list(filter?: { repo?: string; number?: number; states?: readonly JobState[]; reviewer?: string }): ReviewJob[]
  /** Jobs that were `running`, `fixing` or `validating` when the daemon stopped: back to `pending` with `trigger` kept and `attempts` + 1. */
  recover(): ReviewJob[]
  /** Pending and waiting jobs whose `notBefore` passed, oldest first. */
  due(now: number): ReviewJob[]
}

export const jobKey = (job: Pick<ReviewJob, "reviewer" | "repo" | "number" | "head" | "base" | "configKey">) => [job.reviewer, job.repo, job.number, job.head, job.base, job.configKey].join("\u0000")

// ── Remote effects (effects.ts) ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * A write to the provider (a review, a reply, a resolved thread, a push), recorded before it is sent. After a crash or a timeout
 * the effect is `pending`: the caller reads the remote state (the hidden marker, the branch tip) before sending it again.
 */
export type EffectKind = "review" | "comment" | "reply" | "resolve" | "push" | "claim"
export type Effect = {
  id: string
  kind: EffectKind
  /** Operation identity: kind, repo, number, reviewer, configKey, head, base and the payload hash. Same key, same effect. */
  key: string
  jobId?: string | undefined
  state: "pending" | "done" | "abandoned"
  createdAt: number
  updatedAt: number
  /** What the provider returned (review id, comment id, commit sha), once known. */
  remote?: string | undefined
  /** The marker the effect carries remotely, so a reconciliation can find it. */
  marker?: string | undefined
}
export interface EffectLedger {
  /** Records the intent; an existing `done` effect with the same key comes back as is and must not be sent again. */
  intend(input: { kind: EffectKind; key: string; jobId?: string | undefined; marker?: string | undefined }): Effect
  done(id: string, remote?: string): Effect
  abandon(id: string, reason: string): Effect
  pending(): Effect[]
  byKey(key: string): Effect | undefined
}
export const effectKey = (parts: { kind: EffectKind; repo: string; number: number; reviewer: string; configKey: string; head: string; base: string; payload: string }) =>
  [parts.kind, parts.repo, parts.number, parts.reviewer, parts.configKey, parts.head, parts.base, parts.payload].join("\u0000")

// ── Eligibility (eligibility.ts) ──────────────────────────────────────────────────────────────────────────────────────────

/** What the provider says about one open pull request, enough to decide whether and why it is reviewed. */
export type PrFacts = {
  number: number
  title?: string | undefined
  /** The PR's description, when the provider's read gives it (GitLab `description`, Gitea `body`): `template.language: auto` reads it. */
  body?: string | undefined
  head: string
  base: string
  baseRef: string
  headRef: string
  draft: boolean
  labels: string[]
  author: string
  authorIsBot: boolean
  fork: boolean
  maintainerCanModify?: boolean | undefined
  requested: string[]
  assignees: string[]
  /** Changed files, when the provider listed them (needed only for `filters.paths` and routing). */
  files?: string[] | undefined
  url?: string | undefined
  updatedAt?: string | undefined
  /** Whether it is still open, when the provider said (a single read: GitLab `state`, Gitea `state`). */
  open?: boolean | undefined
}
export type EligibilityTrigger = "opened" | "synchronize" | "ready_for_review" | "requested" | "label" | "comment" | "manual"
export type Eligibility = { ok: true; reason: string } | { ok: false; reason: string }

// ── Providers (providers/*.ts) ────────────────────────────────────────────────────────────────────────────────────────────

/** What a provider adapter can really do; the platform never pretends a missing one (no fake threads or approvals). */
export type ProviderCapabilities = {
  inlineComments: boolean
  suggestions: boolean
  resolveThreads: boolean
  reviewEvents: boolean
  requestedReviewers: boolean
  labels: boolean
  draft: boolean
  forkPush: boolean
  conditionalRequests: boolean
  /** How the adapter was verified: `live` only after the daemon-level flow of scripts/live-forges.ts passed against that provider in this build. */
  verified: "live" | "contract"
}
export type ProviderKind = PrJobSummary["provider"]
export type CommandRun = (input: { argv: string[]; cwd?: string | undefined; stdin?: string | undefined }) => Promise<{ code: number; out: string; err: string }>
export interface ReviewProvider {
  kind: ProviderKind
  capabilities: ProviderCapabilities
  /** `owner/repo` (GitHub, Gitea) or `group/subgroup/project` (GitLab) of a checkout's remote. */
  repoOf(directory: string): Promise<string>
  /** Every open PR/MR, all pages; `etag` lets an unchanged list cost no rate limit where the provider supports it. */
  listOpen(input: { directory: string; repo: string; etag?: string | undefined }): Promise<{ ok: true; prs: PrFacts[]; etag?: string | undefined; notModified?: boolean } | { ok: false; auth: boolean; reason: string }>
  view(input: { directory: string; repo: string; number: number }): Promise<PrFacts>
  /** The fetch refspec of a PR head (`refs/pull/N/head`, `refs/merge-requests/N/head`). */
  headRef(number: number): string
  /** Publishes a review body and inline comments within `capabilities`; the marker makes it idempotent. */
  publish(input: { repo: string; number: number; head: string; body: string; comments: Array<{ path: string; line: number; endLine?: number | undefined; body: string }>; marker: string }): Promise<{ ok: true; remote: string; comments: number; movedToBody: number; /** Its marker was already there: nothing was sent. */ duplicate?: boolean | undefined } | { ok: false; reason: string; retryable: boolean }>
  /** Whether a body carrying `marker` is already on the PR (for a reconciliation after a timeout). */
  findMarker(input: { repo: string; number: number; marker: string }): Promise<{ found: boolean; remote?: string | undefined }>
  permission(input: { repo: string; login: string }): Promise<"admin" | "write" | "read" | "none" | "unknown">
  // ── What the daemon needs beyond a review post (GitLab and Gitea; the daemon's GitHub path keeps its own `gh` calls) ──────
  /** The login the provider's credentials act as (`GET /user`); undefined when it cannot say (logged out, no token). */
  self?(): Promise<string | undefined>
  /** The changed paths of one PR/MR, all pages; undefined when they cannot be read. */
  files?(input: { repo: string; number: number }): Promise<string[] | undefined>
  /** Every non-system comment of one PR/MR (conversation and diff threads) with its author; `ok: false` when unreadable. */
  comments?(input: { repo: string; number: number }): Promise<{ ok: true; comments: ForgeComment[] } | { ok: false; reason: string }>
  /** A new conversation comment, or `edit` (a comment id this login wrote) replaced in place. The new or edited comment's id. */
  comment?(input: { repo: string; number: number; body: string; edit?: number | undefined }): Promise<{ ok: true; id: number } | { ok: false; reason: string }>
  /** A reply where `to` was written: its diff thread (GitLab discussion, Gitea review conversation) or the conversation. */
  reply?(input: { repo: string; number: number; to: Pick<ForgeComment, "id" | "surface" | "discussion" | "inReplyTo">; body: string }): Promise<{ ok: true; id: number } | { ok: false; reason: string }>
  /** The top-level posts that can carry a review of a head (Gitea reviews, GitLab notes) with their authors. */
  markers?(input: { repo: string; number: number }): Promise<{ ok: true; posts: ForgeMarker[] } | { ok: false; reason: string }>
  /** The diff threads with the body of their first comment (where the finding marker is), for resolving fixed findings. */
  threads?(input: { repo: string; number: number }): Promise<Array<{ id: string; resolved: boolean; body: string }> | undefined>
  /** Resolves one diff thread (only where `capabilities.resolveThreads`). */
  resolve?(input: { repo: string; number: number; discussion: string }): Promise<boolean>
  /** The names of the repository's labels (for `@mendcode describe`, which adds only a label that exists); undefined when unreadable. */
  repoLabels?(input: { repo: string }): Promise<string[] | undefined>
  /** Edits a PR/MR: a new title or description, and labels (names that exist) added to the ones it has. */
  edit?(input: { repo: string; number: number; title?: string | undefined; body?: string | undefined; labels?: string[] | undefined }): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Approves `head` of a PR/MR (`@mendcode approve`, when the repository enabled it). */
  approve?(input: { repo: string; number: number; head: string; body: string }): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Where a fix of the PR's branch is pushed: the branch, its repository path, whether it is a fork and whether it takes a push. */
  pushTarget?(input: { repo: string; number: number }): Promise<PushTarget>
}

/** One comment of a PR/MR as the daemon reads it for `@mendcode` commands, replies and claims. */
export type ForgeComment = {
  id: number
  author: string
  body: string
  /** `review`: a comment in a diff thread; `issue`: the conversation. */
  surface: "issue" | "review"
  createdAt?: string | undefined
  updatedAt?: string | undefined
  /** GitLab: the discussion a note belongs to (a reply goes there). */
  discussion?: string | undefined
  /** The first comment of the diff thread this one answers (its finding marker names the finding). */
  inReplyTo?: number | undefined
  path?: string | undefined
  line?: number | undefined
}
/** A top-level post (a Gitea review, a GitLab note) with its author and, where the provider records it, the commit it reviewed. */
export type ForgeMarker = { id: number; author: string; body: string; commit?: string | undefined; state?: string | undefined }
/** Where a fix is pushed: `repo` is the head repository's path (the base's own for a same-repository PR). */
export type PushTarget = { branch: string; head: string; base: string; baseRef: string; repo: string; fork: boolean; pushable: boolean }

/**
 * What the daemon does on each forge, beyond the adapter's API capabilities (`ProviderCapabilities`): `true` runs, `false` is
 * gated off with the reason `DAEMON_FEATURE_REASONS` gives, said to the session once instead of being skipped silently.
 */
export type DaemonFeature = "watch" | "review" | "publish" | "mentions" | "claims" | "fix" | "resolveThreads" | "checkFollowUp" | "hostedRunner"

// ── Reviewers, routing and ownership (registry.ts, ownership.ts) ──────────────────────────────────────────────────────────

/**
 * A reviewer the repository knows (`.mendcode/reviewers.yaml` on the base branch): shared facts only, never anyone's private
 * memory. `global` is the repository's reviewer; a `personal` one is one developer's own MendCode.
 */
export type ReviewerEntry = {
  id: string
  scope: ReviewerScope
  login?: string | undefined
  areas: string[]
  capabilities: Array<"review" | "fix" | "publish">
  /** Where it runs: a device id; unset, whichever daemon of `login` claims it. */
  device?: string | undefined
}
export type Assignment = { reviewer: string; scope: ReviewerScope; reason: string; areas: string[] }

/** One owner per watch or job across devices, with a fencing number that grows with every new owner. */
export type Lease = { key: string; owner: string; fence: number; expiresAt: number; acquiredAt: number }
export interface Ownership {
  claim(key: string, owner: string, ttlMs: number): { ok: true; lease: Lease } | { ok: false; holder: Lease }
  renew(lease: Lease, ttlMs: number): { ok: true; lease: Lease } | { ok: false; reason: string }
  release(lease: Lease): void
  /** An explicit handover: the new owner gets `fence + 1`; the old one's writes with its fence are refused from then on. */
  transfer(lease: Lease, to: string, ttlMs: number): Lease
  current(key: string): Lease | undefined
  /** Whether a write fenced with `fence` may still happen. */
  valid(key: string, fence: number): boolean
}

// ── Memory context (review-memory.ts) ─────────────────────────────────────────────────────────────────────────────────────

/** Where a piece of review context came from, so a headless review can show it and a proposal can trace back. */
export type MemoryProvenance = { id?: string | undefined; source: "memory" | "repository" | "review" | "learnings"; scope: "user" | "project" | "review"; createdAt?: number | undefined; verifiedAt?: number | undefined }
export type ReviewMemoryContext = { text: string; sources: MemoryProvenance[]; tokens: number; refused: Array<{ id: string; reason: string }> }

// ── Phases and templates (phases.ts, template.ts) ─────────────────────────────────────────────────────────────────────────

export type PhaseId = string
export type PhasePlan = {
  mode: ReviewConfig["phases"]["mode"]
  phases: Array<{ id: PhaseId; prompt?: string | undefined; reason: string; source: "preset" | "config" | "dynamic" }>
  decisions: JobCheckpoint["decisions"]
}
export type PhaseFacts = { files: string[]; changedLines: number; risk?: "low" | "medium" | "high" | undefined; stacked: boolean; fixMode: ReviewConfig["fix"]["mode"] }

// ── Stacks (stacks.ts) ────────────────────────────────────────────────────────────────────────────────────────────────────

export type StackNode = { number: number; baseRef: string; headRef: string; head: string; base: string; parent?: number | undefined; children: number[]; depth: number }
export type StackGraph = { nodes: Map<number, StackNode>; roots: number[]; cycles: number[][]; ambiguous: Array<{ number: number; candidates: number[] }> }

// ── Budget (budget.ts) ────────────────────────────────────────────────────────────────────────────────────────────────────

export type BudgetPolicy = {
  /** Undefined: no internal cap on tokens per PR head. */
  tokensPerPr?: number | undefined
  contextTokens: number
  onQuota: "wait" | "stop"
  maxWaitMinutes: number
}
export type BudgetCheck = { ok: true; remaining?: number | undefined } | { ok: false; stop: PrStopReason }

// ── Wave 2 wiring: run.ts ⇄ service.ts ⇄ control.ts ──────────────────────────────────────────────────────────────────────

/**
 * What service.ts hands one review run besides today's `runPrReview` input (run.ts): the reviewer and its layers, the memory its
 * scope allows, the model window, the accounting sink, the stack range and the publish identity. Every field is optional so the
 * hosted runner keeps calling `runPrReview` as it does.
 */
export type RunPlatformInput = {
  reviewer?: { id: string; scope: ReviewerScope; login?: string | undefined } | undefined
  /** The personal profile (raw, validated by config-layers) and the task overrides (`/pr review` flags). */
  layers?: { personal?: unknown; task?: unknown } | undefined
  /** Built per run from the reviewer's scope (review-memory.ts); undefined = no memory context. */
  memory?: ((query: { title: string; files: string[] }) => Promise<ReviewMemoryContext | undefined>) | undefined
  contextWindow?: number | undefined
  /** One call per model turn of the run (accounting.ts `record`); `sessionId`: the child session the turn ran in, when it has one. */
  account?: ((entry: { purpose: "review" | "verify" | "fix" | "explain" | "resume" | "read"; tokens: PrTokenUsage; sessionId?: string | undefined }) => void) | undefined
  /**
   * Called as a model turn starts (accounting.ts `begin`, kept on disk); the function it returns is called when the turn ends,
   * whatever way. A turn the daemon did not see end (it was killed mid-call) is accounted at the next start as unknown.
   */
  calling?: ((call: { purpose: "review" | "verify" | "fix" | "explain" | "resume" | "read"; sessionId?: string | undefined }) => () => void) | undefined
  /** A stacked PR: its own range starts at the parent's head; the parent's confirmed findings are not repeated. */
  stack?: { base: string; parentFindings: PrFinding[]; parent: number } | undefined
  /** Publishing identity and the guard against stale results (publish.ts). */
  publishAs?: { effects: EffectLedger; reviewer: string; configKey: string; jobId: string; self?: string | undefined; isCurrent: () => boolean | Promise<boolean> } | undefined
  /** Resume a checkpointed job: verification continues from it instead of a new review pass. */
  checkpoint?: JobCheckpoint | undefined
}
/** What a run reports back beyond `ReviewRun`: the config identity, the checkpoint to keep and why it stopped. */
export type RunPlatformOutput = { configKey: string; checkpoint?: JobCheckpoint | undefined; stop?: PrStopReason | undefined; stale?: boolean | undefined; plan?: PhasePlan | undefined }

/** service.ts → control.ts: what the new `pr.review` actions act on. */
export type PlatformHandle = {
  dataDir: string
  jobs: JobLedger & { all(): ReviewJob[] }
  /** This daemon's device id (device.ts): the page says "this device" for the jobs and watches it owns, not the id. */
  device?: (() => string) | undefined
  rows(): Array<{ directory: string; state: string; open: number; publish: string; provider?: ProviderKind | undefined }>
  concurrency: number
  repoOf(directory: string): Promise<string>
  loginOf(directory: string): Promise<string | undefined>
  reviewers(directory: string): Promise<import("@mendcode/protocol").PrReviewerSummary[]>
  /** Re-queues a failed/cancelled/stale/checkpointed job (a checkpointed one resumes from its checkpoint). */
  retry(jobId: string, reason: string): Promise<{ ok: true; text: string } | { ok: false; message: string }>
  /** An explicit audit of the repository at the checkout's HEAD: findings stay in the session, never on a PR. */
  audit(input: { sessionId: string; directory: string }): Promise<{ ok: true; text: string; jobId: string } | { ok: false; message: string }>
}
export type PlatformControlInput = { sessionId: string; action: PrReviewAction; directory: string; jobId?: string | undefined; reason?: string | undefined; scope?: ReviewerScope | undefined; patch?: Record<string, unknown> | undefined; version?: number | undefined; pullRequests?: "cached" | "refresh" | undefined }
export type PlatformControlResult = { ok: true; text: string; dashboard?: import("@mendcode/protocol").PrReviewDashboard; config?: import("@mendcode/protocol").PrReviewConfigView } | { ok: false; message: string }
