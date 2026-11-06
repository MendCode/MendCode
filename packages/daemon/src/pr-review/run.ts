import { createHash } from "node:crypto"
import type { PrFinding, PrStopReason, PrTokenUsage, Tier } from "@mendcode/protocol"
import { groupFiles, READER_SHARE, READERS_BY_TIER, readersNote, readGroups, type ReaderSource, type ReaderSummary, type ReadResult } from "./readers"
import { cheapReaderList, isCheapReaderModel } from "./reader-models"
import type { Graph } from "@mendcode/codegraph"
import { failureStop, budgetPolicy, scaledBudget, stopText } from "./budget"
import { buildReviewContext, gitRun, type ContextReaders, type GitRun, type ReviewContext } from "./context"
import { ignoredBy, promptConfig, readReviewConfig, type ReviewConfig } from "./config"
import { effectiveConfig } from "./config-layers"
import type { JobCheckpoint, PhasePlan, ReviewMemoryContext, ReviewProvider, RunPlatformInput, RunPlatformOutput } from "./contracts"
import { closeCheckpoint, resumeReview, REVIEW_PASS_SHARE, ReviewPassError, reviewPullRequest, type ReviewCheckpoint, type ReviewEngineConfig, type ReviewOutcome, type ReviewSessionFactory } from "./engine"
import { fallbackUsed, newFallbackState, withFallbacks, type FallbackSource, type FallbackState } from "./fallback"
import { dedupeInherited, lineReader } from "./fingerprint"
import { resolveReviewLanguage, withReviewLanguage } from "./language"
import { parsePartPhase, phaseFacts, phasesBefore, planPhases } from "./phases"
import { measurePerf, perfBody, perfFinding, perfNote, perfPrompt, type PerfOptions, type PerfOutcome } from "./perf"
import { publishReview, publishThroughProvider, type GhCall, type PublishReport, type ReviewInfo } from "./publish"
import type { PublishCheck } from "./publishers"
import { reviewedBy, reviewedThrough } from "./publishers"
import type { PullRequestInfo } from "./pull-request"
import { childNotStarted, isOverBudget, isStalled, ReviewTurnError, type ReviewTurnOverBudget, type ReviewTurnStalled } from "./sessions"
import { reviewRange, type ReviewState } from "./state"
import { fixedFindings, runChecks, spent, type CheckResult } from "./verify"

/**
 * One review of one pull request, the same for the daemon's repo watch and the hosted-runner Action (docs/pr-review.md): the repo
 * config from base and head, the range since the last reviewed head, the review and verify passes, the threads the new commits
 * fixed, then one publish when `publish` allows it. `directory` is a checkout that holds both commits (the Action's checkout, or the
 * daemon's throwaway worktree at the head). Nothing here posts unless `gh` is given and `publish` is true.
 *
 * The platform fields (`RunPlatformInput`, all optional, so the hosted runner calls this as it always did): the reviewer's personal
 * and task config layers over the repository's (never widening it), the memory its scope allows, the model window that bounds one
 * call's context, a per-turn accounting sink, a stacked PR's own range, the publishing identity with its stale-head guard, and a
 * checkpoint to resume from. A review that stopped before it was complete (the token budget, a quota, a rate limit, a failed
 * verifier) is never published: it comes back with `stop` and the `checkpoint` that finishes it (locked decision 7).
 */

export type ReviewRun = {
  status: "skipped" | "reviewed" | "published" | "failed"
  reason?: string
  /** The head this run looked at, for the notice (a failure that names no commit cannot be told apart from the next head's). */
  head?: string
  outcome?: ReviewOutcome
  report?: PublishReport
  state: ReviewState
  config?: ReviewConfig
  incremental: boolean
  /** What the review looked at, for the published summary (a held review is posted later with it). */
  info?: ReviewInfo
  /** The repository's `publishers` does not let this reviewer post, or another publisher already did: nothing to ask or hold. */
  notPublisher?: true
  /** The config version the run used (`runConfigKey`). */
  configKey?: string
  /** What to keep for the job: the plan's decisions always; with `stop`, the candidates a resume verifies. */
  checkpoint?: JobCheckpoint
  /** Set when the review is incomplete: it was not published, whatever `publish` said. */
  stop?: PrStopReason
  /** The head moved before the post: nothing was written (status `reviewed`). */
  stale?: boolean
  plan?: PhasePlan
  /** A failure worth trying again as it is: a post GitHub did not confirm, a quota or rate limit, a model child that never started. */
  retryable?: true
  /** How many findings were left out because the stack's parent already reported them. */
  inherited?: number
  /**
   * The ids of earlier findings (published and unresolved, plus `recheck`) the re-check of an incremental review found fixed: their
   * threads are resolved with the post. Set only when that re-check ran (a complete incremental review); a whole-PR review finds
   * again what is still there, so it has none.
   */
  fixed?: string[]
}

export type RunPrReviewInput = {
  repo: string
  number: number
  directory: string
  base: string
  head: string
  /** Where the base-controlled config is read (`enabled`, `publishers`, ...): the base branch's current tip; else `base`. */
  policy?: string
  state: ReviewState
  sessionFactory: ReviewSessionFactory
  git?: GitRun
  graph?: () => Promise<Graph | undefined>
  gh?: GhCall
  /** Known publisher identity, including installation-token bots that cannot call GET /user. */
  self?: string | undefined
  /** The caller's consent to post (the repo config's `enabled` is checked here too). */
  publish: boolean
  /** Review the whole PR even when the head was reviewed before (`@mendcode review`). */
  full?: boolean
  /** Review even when the repo config is off (an explicit `/pr review` or `github run --review`); publishing still needs `enabled`. */
  force?: boolean
  checks?: (directory: string, commands: readonly string[]) => Promise<CheckResult[]>
  /** Title, description and linked issues for the pre-merge checks (`readPullRequestInfo`); without it the review has no checks. */
  pullRequest?: PullRequestInfo
  /**
   * The local daemon's own `gh` login and whether the repository's `publishers` lets it post (`mayPublish`). Without it (the hosted
   * runner, which is the repository's own workflow) the reviewer always may. A reviewer that may post still stands down when another
   * publisher already posted a review of this head.
   */
  publisher?: { login: string | undefined; check(config: ReviewConfig): Promise<PublishCheck> }
  /**
   * A run nobody is waiting on (a watch's automatic review, a fix round's re-review): when it means to publish, whether this
   * reviewer may post and whether another publisher already reviewed the head is asked before the context is built or a model is
   * called, and a run that could not post is skipped. A manual `/pr review` keeps its review for the user's session instead.
   */
  onlyIfPublishable?: boolean
  /** Reads the PR's reviews for `reviewedBy`, when `gh` (which only a publishing run gets) is absent. */
  read?: GhCall
  /**
   * GitLab or Gitea: the adapter that reads the other publishers' posts and, with `publish`, posts the review
   * (`publishThroughProvider`). `gh` and `read` are then unused.
   */
  provider?: ReviewProvider
  /**
   * The findings a fix round set out to fix (the job's open confirmed findings): re-checked with the published ones on an
   * incremental review, so a round counts only what the re-check closed, published or not.
   */
  recheck?: readonly PrFinding[]
  /**
   * The cost phase of a MendCode pull request (perf.ts): when set, and the checkout is the MendCode repository and the diff can
   * change what it costs, `scripts/perf-attrib.ts` runs as a subprocess before the model pass and its table goes to the model and
   * the review. Absent (the hosted runner, a repository that is not MendCode, `prReview.perfAttrib: false`): no phase.
   */
  perf?: PerfOptions | undefined
  /** The head is in a fork: the phase would build and run the fork's code, so it says it did not. */
  fork?: boolean
  /**
   * The reviewer's readers (readers.ts): the install tier (how many read at once when `readers.parallel` is unset) and the cheap
   * model of the reviewer's own provider with the factory of its children, or why there is none. Absent (the hosted runner):
   * data files get local summaries, never a model.
   */
  readers?: RunReaders | undefined
  /** Where `fallback_models` resolve to sessions (the reviewer's own provider, the allowed model list). */
  fallbacks?: RunFallbacks | undefined
  /** Each step the run starts (readers, analysis, verification, posting), for the live activity a watching terminal shows. Never throws into the run. */
  progress?: ((step: ReviewProgress) => void) | undefined
} & RunPlatformInput

/** `fallback_models`: the factory of each model the run may move to (fallback.ts), or why it may not; absent (the hosted runner): none. */
export type RunFallbacks = { source(model: string): { ok: true; model: string; factory: ReviewSessionFactory } | { ok: false; reason: string } }

/** A step of a running review as the activity shows it: the ledger's phase word, a label and an optional detail. */
export type ReviewProgress = { phase: string; label: string; detail?: string | undefined }

export type RunReaders = { tier?: Tier | undefined; source(requested?: string | undefined): ReaderSource }

// ── Shared with audit.ts ─────────────────────────────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
/** JSON with object keys sorted at every depth: the same layers always hash the same. */
const stableJson = (value: unknown) => JSON.stringify(value ?? null, (_key, entry: unknown) => isRecord(entry) ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry)
const hasLayers = (layers: RunPlatformInput["layers"]) => layers?.personal !== undefined || layers?.task !== undefined

/**
 * The config version of a run: the commit the repository's policy is read at, plus (when a personal or task layer is given) the
 * first 12 hex of the SHA-256 of both layers as sorted JSON. Deterministic, so service.ts can compute a job's key before the run.
 */
export function runConfigKey({ policy, layers }: { policy: string; layers?: RunPlatformInput["layers"] }): string {
  if (!hasLayers(layers)) return policy
  return `${policy}+${createHash("sha256").update(stableJson({ personal: layers?.personal ?? null, task: layers?.task ?? null })).digest("hex").slice(0, 12)}`
}

/** The repository's config (base, plus the head's path instructions) under the personal and task layers; problems for the notes. */
export function layeredConfig(repository: ReviewConfig, layers: RunPlatformInput["layers"]): { config: ReviewConfig; problems: string[] } {
  if (!hasLayers(layers)) return { config: repository, problems: [] }
  const effective = effectiveConfig({ preset: repository.preset, repository, personal: layers?.personal, task: layers?.task })
  return { config: effective.config, problems: effective.problems }
}

/** The engine's config for one context: path instructions, budget, phase plan, template sections, tone, language and memory. */
export function engineConfigFor({ config, context, learnings, budgetTokens, plan, memory }: { config: ReviewConfig; context: ReviewContext; learnings: string; budgetTokens: number; plan: PhasePlan; memory?: ReviewMemoryContext | undefined }): ReviewEngineConfig {
  const sections = config.template.sections.filter((section) => section.enabled).map(({ id, title, prompt }) => ({ id, ...(title ? { title } : {}), ...(prompt ? { prompt } : {}) }))
  return {
    ...promptConfig(config, context.files.map((file) => file.path), learnings),
    budgetTokens, phases: plan, tone: config.template.tone, language: config.template.language,
    ...(sections.length ? { sections } : {}),
    ...(memory ? { memory } : {}),
  }
}

type Account = RunPlatformInput["account"]
type Calling = RunPlatformInput["calling"]

/**
 * The session factory with each turn accounted (`account`, one call per model turn, the tokens the provider reported for it) and
 * each failed turn remembered, so a quota or rate limit inside the verify pass (which the engine turns into a failed verifier)
 * can still be told apart from a broken one. A failed turn is accounted as one call with no report: its tokens are unknown.
 * `language` (the repository's `template.language`) goes to each child, so a harness with a language setting of its own runs in it.
 */
export function meteredSessions({ factory, account, calling, resuming, failures, language }: { factory: ReviewSessionFactory; account: Account; calling?: Calling; resuming: boolean; failures: ReviewTurnError[]; language?: string | undefined }): ReviewSessionFactory {
  return async ({ purpose }) => {
    const session = await factory({ purpose, ...(language ? { language } : {}) })
    // A reader's turn is review-pass work in the ledger (its child session tells /usage which model ran it).
    const label = purpose === "read" ? "review" : resuming && purpose === "verify" ? "resume" : purpose
    const id = (session as { id?: unknown }).id
    const sessionId = typeof id === "string" && id.length <= 120 ? id : undefined
    const of = sessionId ? { sessionId } : {}
    return {
      ...session,
      async send(prompt: string, options?: { limit?: number | undefined }) {
        // Kept on disk while the call runs: a daemon killed mid-call leaves it, and the next start accounts it as unknown.
        let ended: (() => void) | undefined
        try { ended = calling?.({ purpose: label, ...of }) } catch { /* accounting never stops a review */ }
        try {
          const turn = await session.send(prompt, options)
          const tokens: PrTokenUsage = { input: turn.tokens.input, output: turn.tokens.output, ...(turn.tokens.cached !== undefined ? { cached: turn.tokens.cached } : {}) }
          account?.({ purpose: label, tokens, ...of })
          return turn
        } catch (error) {
          if (error instanceof ReviewTurnError) failures.push(error)
          // What the provider reported before the turn failed or was stopped is kept; its full spend is unknown, so it also counts
          // as one call without a report.
          const spent = error instanceof ReviewTurnError ? error.spent : undefined
          account?.({ purpose: label, tokens: { input: spent?.input ?? 0, output: spent?.output ?? 0, ...(spent?.cached ? { cached: spent.cached } : {}), unreported: 1 }, ...of })
          throw error
        } finally { try { ended?.() } catch { /* the next start settles it */ } }
      },
      close: () => session.close(),
    }
  }
}

/** A quota or rate-limit turn failure as a resumable stop (the error's own kind and reset win over the words). */
export function turnStop(error: ReviewTurnError, remaining?: string): PrStopReason {
  const stop = failureStop(error.message, remaining ? { remaining } : {})
  return { ...stop, ...(error.kind !== "error" ? { kind: error.kind } : {}), ...(error.resetsAt !== undefined ? { resetsAt: error.resetsAt } : {}) }
}
const providerLimit = (error: unknown): ReviewTurnError | undefined => error instanceof ReviewTurnError && error.kind !== "error" ? error : undefined
/** A turn the daemon stopped at its token limit as a resumable `budget` stop: what was counted, and which settings raise it. */
export function overBudgetStop(error: ReviewTurnOverBudget, remaining?: string): PrStopReason {
  return {
    kind: "budget",
    detail: `A model turn counted ${Math.round(error.used).toLocaleString("en-US")} tokens against the ${Math.round(error.limit).toLocaleString("en-US")} left for it (what the turns before it left of this review's cap: budget.tokens_per_pr, scaled by the diff's size with budget.tokens_per_diff_token) before it answered, so it was stopped.`,
    unit: "tokens", used: Math.round(error.used), limit: Math.round(error.limit), resumable: true, ...(remaining ? { remaining } : {}),
  }
}

export type ReviewAttempt =
  | { ok: true; outcome: ReviewOutcome; limit?: ReviewTurnError | undefined; stalled?: ReviewTurnStalled | undefined }
  /**
   * The review pass hit a quota or rate limit (`stop`), or a turn of it stalled (`stalled`, no stop: a retry with backoff). The
   * checkpoint keeps the parts of a large diff reviewed before it, or restarts the review pass when there were none.
   */
  | { ok: false; stop: PrStopReason; stalled?: undefined; checkpoint: JobCheckpoint }
  | { ok: false; stop?: undefined; stalled: ReviewTurnStalled; checkpoint: JobCheckpoint }

/**
 * The review (or its resume from `checkpoint`, which holds the review pass's result): a quota or rate limit in the review pass
 * becomes a resumable stop; one in the verify pass replaces the engine's "verification failed" stop with the provider's limit,
 * keeping the engine's checkpoint and its candidates. A stalled turn (`ReviewTurnStalled`) keeps what was done before it the same
 * way, for a retry. Any other error propagates.
 */
export async function attemptReview({ sessionFactory, account, calling, context, config, plan, cap, checks, checkpoint, fallbacks }: {
  sessionFactory: ReviewSessionFactory; fallbacks?: { sources: readonly FallbackSource[]; state: FallbackState } | undefined; account: Account; calling?: Calling; context: ReviewContext; config: ReviewEngineConfig; plan: PhasePlan; cap: number
  checks?: (() => Promise<CheckResult[]>) | undefined; checkpoint?: ReviewCheckpoint | undefined
}): Promise<ReviewAttempt> {
  const failures: ReviewTurnError[] = []
  const metered = (factory: ReviewSessionFactory) => meteredSessions({ factory, account, calling, resuming: !!checkpoint, failures, language: config.language })
  const factory = fallbacks?.sources.length ? withFallbacks({ primary: metered(sessionFactory), sources: fallbacks.sources.map((source) => ({ model: source.model, factory: metered(source.factory) })), state: fallbacks.state }) : metered(sessionFactory)
  let outcome: ReviewOutcome
  try {
    outcome = checkpoint
      ? await resumeReview({ sessionFactory: factory, context, config, checkpoint, cap, ...(checks ? { checks } : {}) })
      : await reviewPullRequest({ sessionFactory: factory, context, config, cap, ...(checks ? { checks } : {}) })
  } catch (error) {
    const partial = error instanceof ReviewPassError ? error : undefined
    const failure = partial ? partial.failure : error
    const kept: JobCheckpoint = partial?.checkpoint ?? { phase: "analysis", completedPhases: phasesBefore(plan, "analysis"), candidates: [], verified: [], rounds: checkpoint?.rounds ?? [], decisions: plan.decisions }
    const remaining = partial?.checkpoint.result ? partial.remaining : "the review pass has not finished"
    const limit = providerLimit(failure)
    if (limit) return { ok: false, stop: turnStop(limit, remaining), checkpoint: kept }
    if (isOverBudget(failure)) {
      const stop = overBudgetStop(failure, remaining)
      // A turn counted past the cap: the parts reviewed before it are not lost. One short closing check, then a partial review.
      if (partial) {
        const progressed = !checkpoint || (parsePartPhase(partial.checkpoint.phase)?.done ?? 0) > (parsePartPhase(checkpoint.phase)?.done ?? 0)
        const closed = await closeCheckpoint({ sessionFactory: factory, context, config, cap, checkpoint: partial.checkpoint, stop, progressed }).catch(() => undefined)
        if (closed) return { ok: true, outcome: closed }
      }
      return { ok: false, stop, checkpoint: kept }
    }
    if (isStalled(failure)) return { ok: false, stalled: failure, checkpoint: kept }
    throw failure
  }
  const stalled = failures.filter(isStalled).at(-1)
  if (stalled && outcome.stop && !outcome.verified) return { ok: true, outcome, stalled }
  const over = failures.filter(isOverBudget).at(-1)
  if (over && outcome.stop && !outcome.verified) {
    // A verify turn counted past the cap: what it judged before is kept, and one short closing check verifies the strongest of the rest.
    if (outcome.checkpoint) {
      const progressed = !checkpoint || outcome.checkpoint.verified.length > checkpoint.verified.length
      const closed = await closeCheckpoint({ sessionFactory: factory, context, config, cap, checkpoint: outcome.checkpoint as ReviewCheckpoint, stop: overBudgetStop(over, outcome.stop.remaining), progressed }).catch(() => undefined)
      if (closed) return { ok: true, outcome: closed }
    }
    outcome = { ...outcome, stop: overBudgetStop(over, outcome.stop.remaining), result: { ...outcome.result, summary: outcome.result.summary.replace(/Verification failed \(.*\); nothing was published\./, "Stopped at the token budget before every candidate was verified; nothing was published.") } }
    return { ok: true, outcome, limit: over }
  }
  const limit = failures.filter((entry) => !!providerLimit(entry)).at(-1)
  if (limit && outcome.stop && !outcome.verified) {
    outcome = { ...outcome, stop: turnStop(limit, outcome.stop.remaining), result: { ...outcome.result, summary: outcome.result.summary.replace(/Verification failed \(.*\); nothing was published\./, `Stopped by the provider's ${limit.kind === "quota" ? "quota" : "rate limit"} before every candidate was verified; nothing was published.`) } }
    return { ok: true, outcome, limit }
  }
  return { ok: true, outcome }
}

// ── runPrReview ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const isAncestor = async (git: GitRun, directory: string, ancestor: string, of: string) => (await git(["merge-base", "--is-ancestor", ancestor, of], directory)).code === 0

/**
 * Why this run's review could not be posted by this reviewer, or undefined: the repository's `publishers` does not let it post, or
 * another publisher already has a MendCode review of this head. Asked before the model (`onlyIfPublishable`) or after it.
 */
async function publishBlock({ input, config }: { input: RunPrReviewInput; config: ReviewConfig }): Promise<{ kind: "not-allowed"; why: string } | { kind: "other"; login: string } | undefined> {
  const publisher = input.publisher
  if (!publisher) return undefined
  const allowed = await publisher.check(config)
  if (!allowed.ok) return { kind: "not-allowed", why: allowed.reason }
  const reader = input.gh ?? input.read
  const other = input.provider ? await reviewedThrough({ provider: input.provider, repo: input.repo, number: input.number, head: input.head, rule: config.publishers, self: publisher.login })
    : reader ? await reviewedBy({ gh: reader, repo: input.repo, number: input.number, head: input.head, rule: config.publishers, self: publisher.login }) : undefined
  return other ? { kind: "other", login: other } : undefined
}

/**
 * The range to review. A resume reviews exactly the range its checkpoint was taken on (`result.base..result.head`, the same head
 * only). Otherwise from the PR's base, or for a stacked PR from the parent's head; `full` (asked, or `coverage: full`) is the whole
 * range, else only the commits since the last reviewed head when it is still in the branch (and, stacked, still past the parent).
 */
async function chooseRange({ input, git, full, resume }: { input: RunPrReviewInput; git: GitRun; full: boolean; resume?: ReviewCheckpoint | undefined }): Promise<{ base: string; head: string; incremental: boolean; alreadyReviewed?: number[] } | undefined> {
  if (resume?.result) return { base: resume.result.base, head: input.head, incremental: !!input.state.lastHead && resume.result.base === input.state.lastHead }
  const start = input.stack?.base ?? input.base
  // `coverage: full` from the config re-reviews a new head whole; only an explicit request re-reviews the same head.
  if (input.full) return { base: start, head: input.head, incremental: false }
  if (input.state.lastHead === input.head) return undefined
  if (full) return { base: start, head: input.head, incremental: false }
  const last = input.state.lastHead
  const ancestor = last ? await isAncestor(git, input.directory, last, input.head) : false
  const range = reviewRange({ state: input.state, base: start, head: input.head, isAncestor: ancestor })
  if (range?.incremental && input.stack && last && !await isAncestor(git, input.directory, input.stack.base, last)) return { base: start, head: input.head, incremental: false }
  const gh = input.gh ?? input.read
  if (range && gh && !input.provider) {
    const { alreadyReviewed } = await import("./already-reviewed")
    const covered = await alreadyReviewed({ gh, git, directory: input.directory, repo: input.repo, number: input.number, base: range.base, head: range.head,
      reviewer: input.publishAs?.reviewer ?? input.reviewer?.id, self: input.publishAs?.self ?? input.self ?? input.publisher?.login ?? input.reviewer?.login })
    if (covered) return { base: covered.base, head: range.head, incremental: true, alreadyReviewed: covered.prs }
  }
  return range
}

/** The child's findings without the ones the parent already reported (same fingerprint on each side's head). */
async function dropInherited({ git, directory, head, stack, findings }: { git: GitRun; directory: string; head: string; stack: NonNullable<RunPlatformInput["stack"]>; findings: readonly PrFinding[] }): Promise<{ kept: PrFinding[]; inherited: number }> {
  if (!findings.length || !stack.parentFindings.length) return { kept: [...findings], inherited: 0 }
  const child = lineReader({ git, directory, commit: head })
  const parent = lineReader({ git, directory, commit: stack.base })
  const lines = new Map<string, string | undefined>()
  const keyOf = (finding: PrFinding, side: "child" | "parent") => `${side}\u0000${finding.id}`
  for (const finding of findings) lines.set(keyOf(finding, "child"), await child(finding.path, finding.line))
  for (const finding of stack.parentFindings) lines.set(keyOf(finding, "parent"), await parent(finding.path, finding.line))
  const { kept, inherited } = dedupeInherited({ child: findings, parent: stack.parentFindings, lineText: (finding, side) => lines.get(keyOf(finding, side)) })
  return { kept, inherited: inherited.length }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
/** The run's step for the live activity; a listener that throws never stops the review. */
function tell(input: Pick<RunPrReviewInput, "progress">, step: ReviewProgress) {
  try { input.progress?.(step) } catch { /* the activity is not the review */ }
}

/**
 * Why a run with a stalled turn failed, and that it is not lost: `kept` (what the checkpoint holds) says the retry continues from
 * it; without it the retry runs the review pass again. Never "timed out": a stall is not a network outage (outage.ts).
 */
function stalledReason(error: ReviewTurnStalled, kept: string | undefined): string {
  const words = error.message.replace(/^\[PR_REVIEW\]:\s*/, "")
  return kept
    ? `review incomplete, ${words}; the work before it is kept (${kept}) and the retry continues from there; nothing was published`
    : `review incomplete, ${words}; the retry runs the review pass again; nothing was published`
}

/**
 * Why a run whose verifier failed published nothing: the verifier's own words (`stop.detail`, "Verification failed: …"), and how
 * many candidates the checkpoint keeps for the retry.
 */
function verifyFailedReason(stop: PrStopReason | undefined, checkpoint: JobCheckpoint): string {
  const cause = stop?.detail.replace(/^Verification failed:\s*/, "").replace(/\s+/g, " ").trim()
  const kept = checkpoint.candidates.length
  return `verification failed${cause ? ` (${cause})` : ""}; ${kept ? `${plural(kept, "candidate finding")} kept for the retry; ` : ""}nothing was published`
}

/** The base branch's `.gitattributes`, bounded; the PR's own never decides what the review pass reads. */
async function baseAttributes(git: GitRun, directory: string, ref: string): Promise<string | undefined> {
  const done = await git(["show", `${ref}:.gitattributes`], directory).catch(() => undefined)
  return done && done.code === 0 ? done.out.slice(0, 256 * 1024) : undefined
}

/**
 * The readers of one run (readers.ts), bound to the config, the reviewer's reader source and the run's accounting: `read` is what
 * the context calls; `spent` what the readers counted, which comes off the review's cap; `note` the line for the summary and the
 * session notice; `summaries` what the checkpoint keeps for a resume of this head, which reads none of them again.
 */
function runReaders({ input, config, resume }: { input: RunPrReviewInput; config: ReviewConfig; resume: ReviewCheckpoint | undefined }) {
  const parallel = config.readers.parallel ?? READERS_BY_TIER[input.readers?.tier ?? "balanced"]
  const notes: string[] = []
  const total: ReadResult = { summaries: new Map(), tokens: { input: 0, output: 0, cached: 0 }, calls: 0, byModel: 0, byLocal: 0, reasons: [] }
  const kept: ReaderSummary[] = []
  let reused = 0
  let source: ReaderSource | undefined
  const pick = (): ReaderSource => {
    if (source) return source
    const wanted = config.readers.model
    if (wanted && !isCheapReaderModel(wanted)) notes.push(`readers.model ${wanted} was refused: it is not a cheap reader model (${cheapReaderList()}); the automatic pick was used.`)
    const asked = wanted && isCheapReaderModel(wanted) ? wanted : undefined
    let picked: ReaderSource = input.readers ? input.readers.source(asked) : { ok: false, reason: "this runner has no reader model" }
    if (!picked.ok && asked && input.readers) { notes.push(`readers.model ${asked} was refused: ${picked.reason}; the automatic pick was used.`); picked = input.readers.source(undefined) }
    source = picked.ok ? { ...picked, factory: meteredSessions({ factory: picked.factory, account: input.account, calling: input.calling, resuming: false, failures: [] }) } : picked
    return source
  }
  const read: ContextReaders = async ({ data, cut, diffTokens, load }) => {
    const groups = groupFiles({ data, cut })
    const cached = resume?.readers ?? []
    const covered = (group: (typeof groups)[number]) => cached.find((summary) => summary.by !== "not read" && (group.kind !== "code" || summary.by !== "local") && summary.paths.length === group.files.length && group.files.every((entry) => summary.paths.includes(entry.file.path)))
    const out: ReaderSummary[] = []
    const fresh = groups.filter((group) => { const hit = covered(group); if (hit) { out.push(hit); reused += hit.paths.length } return !hit })
    if (fresh.length) {
      const cap = scaledBudget(config.budget, diffTokens)
      const allowance = cap === undefined ? Number.POSITIVE_INFINITY : Math.floor(cap * READER_SHARE) - spent(total.tokens)
      const chosen = pick()
      tell(input, { phase: "readers", label: "Readers", detail: [plural(fresh.reduce((sum, group) => sum + group.files.length, 0), "file"), chosen.ok ? chosen.model : ""].filter(Boolean).join(" · ") })
      const result = await readGroups({ groups: fresh, source: chosen, parallel, allowance, load, directory: input.directory })
      out.push(...result.summaries.values())
      total.tokens = { input: total.tokens.input + result.tokens.input, output: total.tokens.output + result.tokens.output, cached: (total.tokens.cached ?? 0) + (result.tokens.cached ?? 0) }
      total.calls += result.calls; total.byModel += result.byModel; total.byLocal += result.byLocal
      if (result.notRead?.length) (total.notRead ??= []).push(...result.notRead)
      total.model ??= result.model
      for (const reason of result.reasons) if (!total.reasons.includes(reason)) total.reasons.push(reason)
    }
    // Job checkpoints already allow at most 500 summaries. Unread markers are rebuilt, not stored as successful coverage.
    kept.push(...out.filter((summary) => summary.by !== "not read").slice(0, Math.max(0, 500 - kept.length)))
    return out
  }
  const note = () => [
    ...notes,
    readersNote(total, parallel),
    reused ? `Readers: the summaries of ${reused.toLocaleString("en-US")} file${reused === 1 ? "" : "s"} were kept from this head's earlier run, not read again.` : undefined,
  ].filter((line): line is string => !!line)
  return { read, note, spent: () => spent(total.tokens), summaries: () => kept }
}

export async function runPrReview(input: RunPrReviewInput): Promise<ReviewRun & RunPlatformOutput> {
  const run = await reviewRun(input)
  return { ...run, head: input.head }
}

async function reviewRun(input: RunPrReviewInput): Promise<ReviewRun & RunPlatformOutput> {
  const git = input.git ?? gitRun
  const policyRef = input.policy ?? input.base
  const configKey = runConfigKey({ policy: policyRef, layers: input.layers })
  const read = await readReviewConfig({ directory: input.directory, base: policyRef, head: input.head, git })
  const layered = layeredConfig(read.config, input.layers)
  const problems = layered.problems
  // `template.language: auto`: the language this PR's review keeps (language.ts), stored with its state for later reviews.
  const language = resolveReviewLanguage({ configured: layered.config.template.language, stored: input.state.language, pullRequest: input.pullRequest })
  const config = withReviewLanguage(layered.config, language.language)
  const state = language.stored ? { ...input.state, language: language.stored } : input.state
  const skipped = (reason: string) => ({ status: "skipped" as const, reason, state: input.state, config, incremental: false, configKey })
  if (!config.enabled && !input.force) return skipped(".mendcode/review.yaml on the base branch does not set enabled: true")
  if (input.state.paused && !input.full) return skipped("reviews are paused on this pull request (@mendcode resume)")
  const notes = [...read.notes, ...problems]
  const resume = input.checkpoint?.result && input.checkpoint.result.head === input.head ? input.checkpoint as ReviewCheckpoint : undefined
  if (input.checkpoint && !resume) notes.push(input.checkpoint.result ? `The checkpoint was taken on head ${input.checkpoint.result.head.slice(0, 12)}, not this one: reviewed again from the start.` : "The checkpoint holds no finished review pass: the review pass runs again.")
  const range = await chooseRange({ input, git, full: config.coverage === "full", resume })
  if (!range) return skipped(`head ${input.head.slice(0, 12)} was already reviewed, so nothing was sent to a model; /pr review ${input.number} full reviews it again whole`)
  const incremental = range.incremental
  if (input.onlyIfPublishable && input.publish && config.enabled && (input.gh || input.provider)) {
    const blocked = await publishBlock({ input, config })
    if (blocked) return { ...skipped(`${blocked.kind === "other" ? `@${blocked.login} already posted a MendCode review of this head` : blocked.why}; nothing was sent to a model`), notPublisher: true as const }
  }
  try {
    const nothingLeft = !!range.alreadyReviewed && (await git(["diff", "--no-ext-diff", "--quiet", range.base, range.head, "--"], input.directory)).code === 0
    const coverageNote = range.alreadyReviewed ? `Already reviewed in ${range.alreadyReviewed.map((number) => `#${number}`).join(", ")}; ${nothingLeft ? "nothing else changed, so no model was called." : `this review covers only ${range.base.slice(0, 12)}..${range.head.slice(0, 12)}.`}` : undefined
    const graph = nothingLeft ? undefined : await input.graph?.().catch(() => undefined)
    const budget = budgetPolicy(config, { contextWindow: input.contextWindow })
    const readers = config.readers.enabled && input.readers?.tier !== "minimalist" ? runReaders({ input, config, resume }) : undefined
    const attributes = readers ? await baseAttributes(git, input.directory, policyRef) : undefined
    // An oversized diff must also fit the pass's existing cap after readers and verification. Leave room for summaries/briefs.
    const mainBytes = budget.tokensPerPr === undefined ? undefined : Math.floor(budget.tokensPerPr * (1 - READER_SHARE) * REVIEW_PASS_SHARE * 0.9 * 4)
    const context = await buildReviewContext({ directory: input.directory, base: range.base, head: range.head, budgetTokens: budget.contextTokens, graph, git, ignore: ignoredBy(config), readers: readers?.read, attributes, mainBytes })
    context.notes.unshift(...notes)
    if (readers) context.notes.push(...readers.note())
    if (input.pullRequest) context.pullRequest = input.pullRequest
    if (coverageNote) context.notes.push(coverageNote)
    else if (incremental) context.notes.push(`Incremental review: only what changed since the last review at ${range.base.slice(0, 7)}; the rest of the pull request was reviewed then (read other files with your tools when a change depends on them).`)
    else if (input.stack && range.base === input.stack.base) context.notes.push(`Stacked on #${input.stack.parent}: only this pull request's own commits since #${input.stack.parent}'s head ${input.stack.base.slice(0, 12)}.`)
    // The cost phase: a subprocess with execution, outside the model's read-only pass; it never fails or blocks the review.
    const perf: PerfOutcome | undefined = input.perf && !nothingLeft ? await measurePerf({ directory: input.directory, base: range.alreadyReviewed ? range.base : input.base, head: input.head, git, options: input.perf, fork: input.fork === true }) : undefined
    if (perf) {
      context.perf = perfPrompt(perf)
      const note = perfNote(perf)
      if (note) context.notes.push(note)
    }
    const plan = planPhases({ config: config.phases, facts: phaseFacts({ context, fixMode: config.fix.mode, stacked: !!input.stack }) })
    const files = context.files.map((file) => file.path)
    const memory = input.memory && !nothingLeft ? await input.memory({ title: input.pullRequest?.title ?? `${input.repo}#${input.number}`, files }).catch(() => { context.notes.push("The reviewer's memory context could not be read; reviewed without it."); return undefined }) : undefined
    // The cap follows the change: the whole diff's size (all its parts), under `tokens_per_pr`.
    // The diffs readers read count too, so the cap is the same with or without them; what the readers counted comes off it.
    const diffTokens = (context.parts ? context.parts.reduce((sum, part) => sum + part.tokens, 0) : context.tokens) + (context.readTokens ?? 0)
    const cap = scaledBudget(config.budget, diffTokens)
    const budgetTokens = cap === undefined ? Number.POSITIVE_INFINITY : Math.max(10_000, cap - (readers?.spent() ?? 0))
    const engineConfig = { ...engineConfigFor({ config, context, learnings: read.learnings, budgetTokens, plan, memory }), ...(input.progress ? { onVerify: (candidates: number) => tell(input, { phase: "corroboration", label: `Verifying ${plural(candidates, "candidate")}` }) } : {}) }
    // A resume that already has the review pass goes on with what it kept (its verify step says so); otherwise the pass starts here.
    if (!resume?.result) tell(input, { phase: "analysis", label: "Analysis", detail: `${plural(context.files.length, "file")}${incremental ? " · incremental" : ""}` })
    const withReaders = <T extends JobCheckpoint>(checkpoint: T): T => readers?.summaries().length ? { ...checkpoint, readers: readers.summaries() } : checkpoint
    const checks = config.checks.length ? () => (input.checks ?? ((directory, commands) => runChecks({ directory, commands })))(input.directory, config.checks) : undefined
    const common = { state, config, incremental, configKey, plan }
    const fallbackSources: FallbackSource[] = []
    for (const requested of config.fallback_models) {
      const picked = input.fallbacks?.source(requested) ?? { ok: false as const, reason: "this run has no model catalog to resolve it" }
      if (picked.ok) { if (!fallbackSources.some((source) => source.model === picked.model)) fallbackSources.push({ model: picked.model, factory: picked.factory }) }
      else context.notes.push(`fallback_models: ${picked.reason}; skipped.`)
    }
    const fallbackState = newFallbackState()
    const fallbacks = { sources: fallbackSources, state: fallbackState }
    const attempt: ReviewAttempt = nothingLeft ? { ok: true, outcome: {
      result: { base: range.base, head: range.head, findings: [], dropped: 0, summary: coverageNote!, tokens: { input: 0, output: 0, cached: 0 }, budgetHit: false },
      verified: true, folded: 0, candidates: [], validation: { ok: true, reason: "Already reviewed; no remaining changes." },
    } } : await attemptReview({ sessionFactory: input.sessionFactory, account: input.account, calling: input.calling, context, config: engineConfig, plan, cap: config.cap, checks, checkpoint: resume, fallbacks })
    // A stalled turn: a retryable failure with no stop, so the job keeps the checkpoint and is tried again with backoff.
    if (!attempt.ok && attempt.stalled) {
      const part = attempt.checkpoint.result ? parsePartPhase(attempt.checkpoint.phase) : undefined
      const kept = part ? `${part.done} of ${part.total} parts of the diff reviewed, ${plural(attempt.checkpoint.candidates.length, "candidate finding")}` : undefined
      return { status: "failed", reason: stalledReason(attempt.stalled, kept), ...common, checkpoint: withReaders(attempt.checkpoint), retryable: true }
    }
    if (!attempt.ok) return { status: "reviewed", reason: `review incomplete, stopped ${attempt.stop.kind === "budget" ? "at the token budget" : `by the provider's ${attempt.stop.kind === "quota" ? "quota" : "rate limit"}`}; nothing was published`, ...common, stop: attempt.stop, checkpoint: withReaders(attempt.checkpoint), ...(attempt.stop.kind === "budget" ? {} : { retryable: true as const }) }
    let outcome = attempt.outcome
    let inherited = 0
    if (input.stack) {
      const shown = await dropInherited({ git, directory: input.directory, head: input.head, stack: input.stack, findings: outcome.result.findings })
      const pending = outcome.checkpoint ? await dropInherited({ git, directory: input.directory, head: input.head, stack: input.stack, findings: outcome.checkpoint.candidates }) : undefined
      inherited = shown.inherited + (pending?.inherited ?? 0)
      outcome = { ...outcome, result: { ...outcome.result, findings: shown.kept }, ...(outcome.checkpoint && pending ? { checkpoint: { ...outcome.checkpoint, candidates: pending.kept } } : {}) }
    }
    const complete = !outcome.stop
    // A measured rise is a critical finding of its own: it does not depend on what the model noticed.
    const risen = perf && complete ? perfFinding({ outcome: perf, context }) : undefined
    const risenAdded = !!risen && !outcome.result.findings.some((finding) => finding.id === risen.id)
    if (risen && risenAdded) outcome ={ ...outcome, result: { ...outcome.result, findings: [risen, ...outcome.result.findings] }, candidates: [risen, ...outcome.candidates] }
    const published = Object.values(input.state.published).flatMap((entry) => entry.finding && !entry.resolved ? [entry.finding] : [])
    const previous = [...published, ...(input.recheck ?? []).filter((finding) => !published.some((known) => known.id === finding.id))]
    // An explicit full review re-checks the open findings too: otherwise asking again after a fix could never close their threads.
    const rechecked = complete && !nothingLeft && (incremental || !!input.full)
    const recheckFactory = (factory: ReviewSessionFactory) => meteredSessions({ factory, account: input.account, calling: input.calling, resuming: false, failures: [], language: config.template.language })
    const fixed = rechecked && previous.length ? await fixedFindings({ sessionFactory: withFallbacks({ primary: recheckFactory(input.sessionFactory), sources: fallbackSources.map((source) => ({ model: source.model, factory: recheckFactory(source.factory) })), state: fallbackState }), previous, context, language: config.template.language }) : []
    // The base of the result is the PR's base, so a later incremental review still knows where the PR starts.
    const result = { ...outcome.result, base: input.base }
    const inheritedNote = inherited ? [`${plural(inherited, "finding")} #${input.stack!.parent} already reported ${inherited === 1 ? "was" : "were"} left out (this pull request is stacked on it).`] : []
    const usedModel = fallbackUsed(fallbackState, fallbackSources)
    const info: ReviewInfo = { ...(usedModel ? { fallback: { model: usedModel, ...(fallbackState.reason ? { why: fallbackState.reason } : {}) } } : {}), files: context.files.map((file) => ({ path: file.path, touched: file.touched.length })), profile: config.profile, cap: config.cap, incremental, ...(incremental ? { since: range.base } : {}), notes: [...context.notes.filter((note) => !note.startsWith("Incremental review:")), ...inheritedNote], ...(complete ? { checked: outcome.candidates.length - (risenAdded ? 1 : 0) } : {}), ...(perf && perfBody(perf) ? { perf: perfBody(perf) } : {}), ...(outcome.partial ? { partial: { ...outcome.partial, number: input.number } } : {}) }
    if (complete && !result.budgetHit && !outcome.partial && !context.unread?.length && !incremental && !input.stack && range.base === input.base) info.fullBase = input.base
    // Always a checkpoint: the plan's decisions; complete, every judged finding; stopped, what a resume verifies.
    const checkpoint: JobCheckpoint = withReaders(outcome.checkpoint ?? {
      completedPhases: outcome.completedPhases ?? [], candidates: [], verified: outcome.candidates, result: outcome.result,
      rounds: input.checkpoint?.rounds ?? [], decisions: plan.decisions, ...(outcome.sections ? { sections: outcome.sections } : {}),
    })
    const reviewed = { ...common, outcome: { ...outcome, result }, info, checkpoint, ...(inherited ? { inherited } : {}), ...(rechecked ? { fixed } : {}) }
    // A review that reached its token budget and closed with a short check is posted as a partial review, never as nothing. Its stop and
    // checkpoint stay with the job (`keep`), so the next /pr review continues with the parts and candidates still missing.
    const closing = !!outcome.partial && outcome.stop?.kind === "budget"
    const keep = closing ? { stop: outcome.stop! } : {}
    if (outcome.stop && !closing) {
      const stop = outcome.stop
      if (attempt.stalled) return { status: "failed", reason: stalledReason(attempt.stalled, stop.remaining), ...reviewed, retryable: true }
      // A verifier that failed (an answer it could not repair, a crashed child) is the model's, not the change's: the job is tried
      // again with backoff, and the retry verifies the kept candidates without a second review pass.
      if (!outcome.verified && !attempt.limit) return { status: "failed", reason: verifyFailedReason(stop, checkpoint), ...reviewed, stop, retryable: true }
      // An "error" stop of a complete verify pass is the review pass saying it could not review the change: its words, not a bare kind.
      return { status: "reviewed", reason: `review incomplete (${stop.kind === "error" ? stop.detail.replace(/^The review pass/, "the review pass") : stop.kind}); nothing was published`, ...reviewed, stop, ...(attempt.limit ? { retryable: true as const } : {}) }
    }
    if (!outcome.verified) return { status: "failed", reason: verifyFailedReason(undefined, checkpoint), ...reviewed, retryable: true }
    const provider = input.provider
    if (input.publisher && config.enabled) {
      const blocked = await publishBlock({ input, config })
      if (blocked) return { status: "reviewed", reason: blocked.kind === "other" ? `@${blocked.login} already posted a MendCode review of this head; kept in this session` : `kept in this session: ${blocked.why}`, notPublisher: true, ...reviewed, ...keep }
    }
    if (!(input.gh || provider) || !input.publish || !config.enabled) return { status: "reviewed", ...(!config.enabled ? { reason: "publishing needs enabled: true in .mendcode/review.yaml on the base branch" } : {}), ...reviewed, ...keep }
    const as = input.publishAs
    if (provider) {
      tell(input, { phase: "posting", label: "Posting review" })
      const report = await publishThroughProvider({
        provider, repo: input.repo, number: input.number, result, previous: state, resolve: fixed, info,
        ...(config.template.sections.length ? { template: config.template } : {}), ...(outcome.sections ? { sections: outcome.sections } : {}),
        ...(as ? { effects: as.effects, reviewer: as.reviewer, configKey: as.configKey, jobId: as.jobId, isCurrent: as.isCurrent } : {}),
      })
      if (report.stale) return { status: "reviewed", reason: report.reason ?? "the head moved; nothing was posted", ...reviewed, report, stale: true }
      if (report.uncertain) return { status: "failed", reason: report.reason ?? "the forge did not confirm the review", ...reviewed, report, retryable: true }
      if (!report.posted && !report.duplicate && / refused the review/.test(report.reason ?? "")) return { status: "failed", reason: report.reason!, ...reviewed, report }
      return { status: "published", ...notPosted(report), ...reviewed, ...keep, report, state: report.state }
    }
    tell(input, { phase: "posting", label: "Posting review" })
    const report = await publishReview({
      repo: input.repo, number: input.number, result, previous: state, process: input.gh!, resolve: fixed, info, self: input.self,
      ...(config.template.sections.length ? { template: config.template } : {}), ...(outcome.sections ? { sections: outcome.sections } : {}),
      ...(as ? { effects: as.effects, reviewer: as.reviewer, configKey: as.configKey, jobId: as.jobId, isCurrent: as.isCurrent, ...(as.self ? { self: as.self } : {}) } : {}),
    })
    if (report.stale) return { status: "reviewed", reason: report.reason ?? "the head moved; nothing was posted", ...reviewed, report, stale: true }
    if (report.uncertain) return { status: "failed", reason: report.reason ?? "GitHub did not confirm the review", ...reviewed, report, retryable: true }
    if (!report.posted && report.reason?.startsWith("GitHub refused")) return { status: "failed", reason: report.reason, ...reviewed, report }
    return { status: "published", ...notPosted(report), ...reviewed, ...keep, report, state: report.state }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { status: "failed", reason, state: input.state, config, incremental, configKey, ...(childNotStarted(reason) ? { retryable: true as const } : {}) }
  }
}

/** The findings of a review as lines for a session notice: what was confirmed, what was folded, and why nothing was posted. */
/**
 * Why a `published` run posted nothing (seen live, e2e #16: a manual `/pr review` of a reviewed head told the session a bare
 * "published"): this head's review was already posted, or nothing is new on it. The pull request keeps the earlier review, which
 * can differ from this run's result.
 */
function notPosted(report: PublishReport): { reason?: string } {
  if (report.posted) return {}
  const why = report.duplicate ? `this head's review${report.reviewId ? ` ${report.reviewId}` : ""} was already posted` : report.reason ?? "nothing is new on this head"
  return { reason: `nothing was posted: ${why}; the pull request keeps the earlier review, not this run's result` }
}

export function reviewNotice({ repo, number, run }: { repo: string; number: number; run: ReviewRun }): string {
  const result = run.outcome?.result
  const head = run.head ?? result?.head
  const lines = [`PR review of ${repo}#${number}: ${run.status}${run.reason ? ` (${run.reason})` : ""}`]
  // A failed or incomplete review names the commit it was on: the retry, or the next head's job, is told apart from it.
  if (head && (run.status === "failed" || run.stop)) lines.push(`Head: ${head.slice(0, 12)}.`)
  if (result) {
    lines.push(result.summary.trim() || "No findings.")
    const walkthrough = result.walkthrough
    if (walkthrough) {
      lines.push(`Merge risk: ${walkthrough.risk.level} · ${walkthrough.type} · ${walkthrough.risk.reason}`)
      for (const check of walkthrough.checks.filter((entry) => entry.status !== "passed")) lines.push(`Check ${check.name}: ${check.status} · ${check.explanation}`)
    }
    for (const finding of result.findings) lines.push(`- ${finding.path}:${finding.line} ${finding.severity} ${finding.category}${finding.verdict === "plausible" ? " (plausible)" : ""}: ${finding.summary}`)
    lines.push(`tokens: ${result.tokens.input.toLocaleString("en-US")} in, ${result.tokens.output.toLocaleString("en-US")} out${run.report?.posted ? ` · posted review ${run.report.reviewId ?? ""} with ${run.report.comments} inline comment${run.report.comments === 1 ? "" : "s"}` : ""}`)
  }
  if (run.stop) lines.push(stopText(run.stop, result ? { tokens: result.tokens } : {}))
  return lines.join("\n")
}
