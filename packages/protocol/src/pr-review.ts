import { z } from "zod"
import { lazySchema } from "./lazy"

/**
 * The PR reviewer's findings (docs/pr-review.md): what a review child returns, what the verify pass judges and what a publish
 * turns into inline comments. One schema for the daemon's repo watch and the hosted-runner Action, so either can publish what the
 * other found. A finding names a line on the diff's new side; its `id` is the sha1 of path, line, category and summary, so the
 * same finding found again on a later head is recognised and never posted twice.
 */

export const PR_FINDING_SEVERITIES = ["critical", "major", "minor"] as const
export const PR_FINDING_CATEGORIES = ["correctness", "security", "performance", "reliability", "tests", "maintainability"] as const
export const PR_FINDING_VERDICTS = ["confirmed", "plausible", "rejected"] as const

export const PrFinding = lazySchema(() => z.strictObject({
  id: z.string().regex(/^[0-9a-f]{40}$/),
  path: z.string().min(1).max(500).refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "a repository-relative path"),
  line: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  side: z.literal("RIGHT"),
  severity: z.enum(PR_FINDING_SEVERITIES),
  category: z.enum(PR_FINDING_CATEGORIES),
  summary: z.string().min(1).max(160),
  detail: z.string().min(1).max(1200),
  /** `file:line` references the finding rests on. */
  evidence: z.array(z.string().min(1).max(300)).max(12),
  /** The text that replaces lines `line`..`endLine` (or `line` alone): only for a fix that stays inside them. */
  suggestion: z.strictObject({ replacement: z.string().max(4000) }).optional(),
  verdict: z.enum(PR_FINDING_VERDICTS).optional(),
  /** The verifier's 0 to 10 judgment of how sure and how much it matters; absent when the verifier gave none. */
  score: z.number().int().min(0).max(10).optional(),
}))
export type PrFinding = z.infer<typeof PrFinding>

export const PR_CHANGE_TYPES = ["bug fix", "feature", "refactor", "performance", "tests", "docs", "build", "chore"] as const
export const PR_MERGE_RISKS = ["low", "medium", "high"] as const
export const PR_CHECK_STATUSES = ["passed", "warning", "failed"] as const

/** One group of the walkthrough's changes table: related files (a layer or a purpose) and what changed in them. */
export const PrWalkthroughChange = lazySchema(() => z.strictObject({
  layer: z.string().min(1).max(80),
  files: z.array(z.string().min(1).max(500)).min(1).max(40),
  summary: z.string().min(1).max(400),
}))
export type PrWalkthroughChange = z.infer<typeof PrWalkthroughChange>

/** A pre-merge check: whether the title, description and linked issues match the change, and what is out of scope. */
export const PrPreMergeCheck = lazySchema(() => z.strictObject({
  name: z.string().min(1).max(40),
  status: z.enum(PR_CHECK_STATUSES),
  explanation: z.string().min(1).max(600),
}))
export type PrPreMergeCheck = z.infer<typeof PrPreMergeCheck>

/**
 * What the change is, for a reader who has not opened it: an overview, the changes grouped by layer, a sequence diagram when the
 * change alters how components call each other, its type, the merge risk with its reason, and the pre-merge checks. Written by the
 * review pass; the risk is never below what the confirmed findings show (`docs/pr-review.md`).
 */
export const PrWalkthrough = lazySchema(() => z.strictObject({
  overview: z.string().min(1).max(1500),
  changes: z.array(PrWalkthroughChange).max(12),
  /** A Mermaid `sequenceDiagram` or `flowchart`, without its fence. */
  diagram: z.string().min(1).max(3000).optional(),
  type: z.enum(PR_CHANGE_TYPES),
  risk: z.strictObject({ level: z.enum(PR_MERGE_RISKS), reason: z.string().min(1).max(600) }),
  checks: z.array(PrPreMergeCheck).max(6),
}))
export type PrWalkthrough = z.infer<typeof PrWalkthrough>

export const PrReviewResult = lazySchema(() => z.strictObject({
  head: z.string().min(1).max(200),
  base: z.string().min(1).max(200),
  findings: z.array(PrFinding).max(200),
  /** Candidates left out: outside the diff, rejected by the verifier, or past the cap. */
  dropped: z.number().int().nonnegative(),
  summary: z.string().max(8000),
  /** `cached`: the part of `input` the provider served from its cache; the PR budget does not count it. */
  tokens: z.strictObject({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(), cached: z.number().int().nonnegative().optional() }),
  budgetHit: z.boolean(),
  walkthrough: PrWalkthrough.optional(),
}))
export type PrReviewResult = z.infer<typeof PrReviewResult>

/**
 * The review platform (docs/pr-review.md): durable jobs, who runs them, why one stopped and what the TUI page shows. A job is one
 * reviewer's work on one pull request head; it survives a daemon restart and keeps its findings, checkpoint and remote effects.
 */

export const PR_REVIEW_PROVIDERS = ["github", "gitlab", "gitea"] as const
export const PR_REVIEWER_SCOPES = ["global", "personal"] as const
/**
 * `waiting`: due but held (offline owner, cooldown, quota reset, missing consent); `checkpointed`: stopped resumably with its work
 * kept (budget, quota, rate limit); `stale`: the head or base moved while it ran, its results are marked obsolete and not published.
 */
export const PR_JOB_STATES = ["pending", "waiting", "running", "fixing", "validating", "checkpointed", "paused", "done", "failed", "cancelled", "stale"] as const
/** `backlog`: an open PR whose current head had no MendCode review when a watch started or caught up (backlog.ts). */
export const PR_JOB_TRIGGERS = ["opened", "synchronize", "ready_for_review", "requested", "label", "comment", "manual", "routed", "recovered", "stack", "backlog"] as const
export const PR_STOP_KINDS = ["budget", "quota", "rate_limit", "no_progress", "max_rounds", "error", "user", "permission", "superseded"] as const
/** What a review covered: the diff since the last review, the whole pull request, or an explicitly requested audit of the repository. */
export const PR_REVIEW_COVERAGES = ["incremental", "full", "audit"] as const

/** Tokens as the provider reported them: `cached` is part of `input` served from cache and is never converted into billable tokens. */
export const PrTokenUsage = lazySchema(() => z.strictObject({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative().optional(),
  /** Calls with no provider report: their tokens are unknown, not zero. */
  unreported: z.number().int().nonnegative().optional(),
}))
export type PrTokenUsage = z.infer<typeof PrTokenUsage>

/** Why a job stopped, in the unit it was measured in, and whether it can continue from its checkpoint. */
export const PrStopReason = lazySchema(() => z.strictObject({
  kind: z.enum(PR_STOP_KINDS),
  detail: z.string().min(1).max(600),
  unit: z.enum(["tokens", "rounds", "minutes", "requests", "percent"]).optional(),
  used: z.number().nonnegative().optional(),
  /** Undefined: no internal limit is configured for this unit. */
  limit: z.number().nonnegative().optional(),
  /** When a quota or rate limit resets, if the source says so. */
  resetsAt: z.number().int().optional(),
  resumable: z.boolean(),
  /** What remains: candidates not verified, phases not run. */
  remaining: z.string().max(400).optional(),
}))
export type PrStopReason = z.infer<typeof PrStopReason>

/**
 * The pull request on GitHub as `gh pr list` last read it (one call per repository, cached briefly): open, merged or closed, a
 * draft, whether it merges without conflicts and how its checks stand, with up to three failing check names.
 */
export const PrPullRequestState = lazySchema(() => z.strictObject({
  state: z.enum(["open", "merged", "closed"]),
  draft: z.boolean(),
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  checks: z.enum(["passing", "failing", "pending", "none"]),
  failing: z.array(z.string().max(120)).max(3).optional(),
}))
export type PrPullRequestState = z.infer<typeof PrPullRequestState>

export const PrJobSummary = lazySchema(() => z.strictObject({
  id: z.string().min(1).max(80),
  provider: z.enum(PR_REVIEW_PROVIDERS),
  repo: z.string().min(1).max(200),
  number: z.number().int().positive(),
  title: z.string().max(300).optional(),
  url: z.string().max(500).optional(),
  /** `global`, or `personal:<login>` for one developer's reviewer. */
  reviewer: z.string().min(1).max(120),
  scope: z.enum(PR_REVIEWER_SCOPES),
  /** Why this reviewer has the job (the routing decision), shown with the job. */
  assignment: z.string().max(400).optional(),
  trigger: z.enum(PR_JOB_TRIGGERS),
  state: z.enum(PR_JOB_STATES),
  phase: z.string().max(60).optional(),
  coverage: z.enum(PR_REVIEW_COVERAGES),
  base: z.string().max(64),
  head: z.string().max(64),
  attempts: z.number().int().nonnegative(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** The device that owns it (`deviceId`), when ownership is tracked. */
  owner: z.string().max(120).optional(),
  /** The review session and, when a fix ran, the fix session the user can open and take over. */
  sessionId: z.string().max(120).optional(),
  fixSessionId: z.string().max(120).optional(),
  /** Who holds the fix session now: the reviewer, or the user after a take-over. */
  control: z.enum(["reviewer", "user"]).optional(),
  /** `blocking`: confirmed critical or major findings a fix round has not resolved. */
  findings: z.strictObject({ confirmed: z.number().int().nonnegative(), plausible: z.number().int().nonnegative(), candidates: z.number().int().nonnegative(), resolved: z.number().int().nonnegative(), blocking: z.number().int().nonnegative().optional() }),
  /** The pull request's GitHub state, when it was read (GitHub only; `status` with `pullRequests`). */
  pullRequest: PrPullRequestState.optional(),
  tokens: PrTokenUsage,
  /** The part of `tokens` the cheap readers spent (the rest is the review and verify passes' model); absent when no reader ran. */
  readTokens: PrTokenUsage.optional(),
  stop: PrStopReason.optional(),
  error: z.string().max(600).optional(),
  stack: z.strictObject({ parent: z.number().int().positive().optional(), children: z.array(z.number().int().positive()).max(50), depth: z.number().int().nonnegative() }).optional(),
  /** The stages run so far and each dynamic decision with its reason, for the job's detail. */
  completedPhases: z.array(z.string().max(60)).max(50).optional(),
  decisions: z.array(z.strictObject({ phase: z.string().max(60), action: z.enum(["added", "skipped", "kept"]), reason: z.string().max(600) })).max(20).optional(),
}))
export type PrJobSummary = z.infer<typeof PrJobSummary>

export const PrReviewerSummary = lazySchema(() => z.strictObject({
  id: z.string().min(1).max(120),
  scope: z.enum(PR_REVIEWER_SCOPES),
  login: z.string().max(100).optional(),
  areas: z.array(z.string().max(300)).max(50),
  /** `online`: its daemon answered within the lease; `offline` is not a failure, its work waits. */
  availability: z.enum(["online", "offline", "unknown"]),
  device: z.string().max(120).optional(),
  lastSeenAt: z.number().int().optional(),
}))
export type PrReviewerSummary = z.infer<typeof PrReviewerSummary>

export const PrReviewDashboard = lazySchema(() => z.strictObject({
  updatedAt: z.number().int(),
  watches: z.array(z.strictObject({ directory: z.string().max(4096), repo: z.string().max(200).optional(), provider: z.enum(PR_REVIEW_PROVIDERS), state: z.string().max(120), open: z.number().int().nonnegative(), publish: z.string().max(40), owner: z.string().max(120).optional() })).max(50),
  reviewers: z.array(PrReviewerSummary).max(200),
  jobs: z.array(PrJobSummary).max(500),
  /** Counts from the job ledger only; nothing estimated. */
  metrics: z.strictObject({ running: z.number().int().nonnegative(), queued: z.number().int().nonnegative(), waiting: z.number().int().nonnegative(), done24h: z.number().int().nonnegative(), failed24h: z.number().int().nonnegative(), tokens24h: PrTokenUsage, concurrency: z.number().int().positive() }),
}))
export type PrReviewDashboard = z.infer<typeof PrReviewDashboard>

/** One effective setting and where it came from: the preset, the repository's file, the user's personal profile or the task. */
export const PrConfigOrigin = lazySchema(() => z.enum(["preset", "repository", "personal", "task"]))
export const PrReviewConfigView = lazySchema(() => z.strictObject({
  scope: z.enum(PR_REVIEWER_SCOPES),
  /** `.mendcode/review.yaml` of the repository, or the personal profile's file under the data directory. */
  target: z.string().max(4096),
  repo: z.string().max(200).optional(),
  login: z.string().max(100).optional(),
  version: z.number().int().nonnegative(),
  /** The effective config as JSON with each top-level key's origin. */
  effective: z.record(z.string(), z.unknown()),
  origins: z.record(z.string(), PrConfigOrigin),
  /** A preview or apply: the text before and after, and problems that block it. */
  before: z.string().max(65_536).optional(),
  after: z.string().max(65_536).optional(),
  problems: z.array(z.string().max(400)).max(20).optional(),
  history: z.array(z.strictObject({ version: z.number().int().nonnegative(), at: z.number().int(), summary: z.string().max(200) })).max(50).optional(),
}))
export type PrReviewConfigView = z.infer<typeof PrReviewConfigView>
