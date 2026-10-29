import type { Graph } from "@mendcode/codegraph"
import { buildReviewContext, gitRun, type GitRun } from "./context"
import { ignoredBy, promptConfig, readReviewConfig, type ReviewConfig } from "./config"
import { reviewPullRequest, type ReviewOutcome, type ReviewSessionFactory } from "./engine"
import { publishReview, type GhCall, type PublishReport, type ReviewInfo } from "./publish"
import type { PublishCheck } from "./publishers"
import { reviewedBy } from "./publishers"
import type { PullRequestInfo } from "./pull-request"
import { reviewRange, type ReviewState } from "./state"
import { fixedFindings, runChecks, type CheckResult } from "./verify"

/**
 * One review of one pull request, the same for the daemon's repo watch and the hosted-runner Action (docs/pr-review.md): the repo
 * config from base and head, the range since the last reviewed head, the review and verify passes, the threads the new commits
 * fixed, then one publish when `publish` allows it. `directory` is a checkout that holds both commits (the Action's checkout, or the
 * daemon's throwaway worktree at the head). Nothing here posts unless `gh` is given and `publish` is true.
 */

export type ReviewRun = {
  status: "skipped" | "reviewed" | "published" | "failed"
  reason?: string
  outcome?: ReviewOutcome
  report?: PublishReport
  state: ReviewState
  config?: ReviewConfig
  incremental: boolean
  /** What the review looked at, for the published summary (a held review is posted later with it). */
  info?: ReviewInfo
  /** The repository's `publishers` does not let this reviewer post, or another publisher already did: nothing to ask or hold. */
  notPublisher?: true
}

export async function runPrReview(input: {
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
  /** Reads the PR's reviews for `reviewedBy`, when `gh` (which only a publishing run gets) is absent. */
  read?: GhCall
}): Promise<ReviewRun> {
  const git = input.git ?? gitRun
  const { config, learnings, notes } = await readReviewConfig({ directory: input.directory, base: input.policy ?? input.base, head: input.head, git })
  if (!config.enabled && !input.force) return { status: "skipped", reason: ".mendcode/review.yaml on the base branch does not set enabled: true", state: input.state, config, incremental: false }
  if (input.state.paused && !input.full) return { status: "skipped", reason: "reviews are paused on this pull request (@mendcode resume)", state: input.state, config, incremental: false }
  const ancestor = input.state.lastHead ? (await git(["merge-base", "--is-ancestor", input.state.lastHead, input.head], input.directory)).code === 0 : false
  const range = input.full ? { base: input.base, head: input.head, incremental: false } : reviewRange({ state: input.state, base: input.base, head: input.head, isAncestor: ancestor })
  if (!range) return { status: "skipped", reason: "this head was already reviewed", state: input.state, config, incremental: false }
  try {
    const graph = await input.graph?.().catch(() => undefined)
    const context = await buildReviewContext({ directory: input.directory, base: range.base, head: range.head, budgetTokens: config.budget.tokens_per_pr, graph, git, ignore: ignoredBy(config) })
    context.notes.unshift(...notes)
    if (input.pullRequest) context.pullRequest = input.pullRequest
    if (range.incremental) context.notes.push(`Incremental review: only the commits since ${range.base.slice(0, 12)}.`)
    const engineConfig = promptConfig(config, context.files.map((file) => file.path), learnings)
    const checks = config.checks.length ? () => (input.checks ?? ((directory, commands) => runChecks({ directory, commands })))(input.directory, config.checks) : undefined
    const outcome = await reviewPullRequest({ sessionFactory: input.sessionFactory, context, config: engineConfig, cap: config.cap, ...(checks ? { checks } : {}) })
    const previous = Object.values(input.state.published).flatMap((entry) => entry.finding && !entry.resolved ? [entry.finding] : [])
    const fixed = range.incremental && previous.length ? await fixedFindings({ sessionFactory: input.sessionFactory, previous, context }) : []
    // The base of the result is the PR's base, so a later incremental review still knows where the PR starts.
    const result = { ...outcome.result, base: input.base }
    const info: ReviewInfo = { files: context.files.map((file) => ({ path: file.path, touched: file.touched.length })), profile: config.profile, cap: config.cap, incremental: range.incremental, notes: context.notes.filter((note) => !note.startsWith("Incremental review:")) }
    if (!outcome.verified) return { status: "failed", reason: "verification failed; nothing was published", outcome, state: input.state, config, incremental: range.incremental }
    const reader = input.gh ?? input.read
    if (input.publisher && config.enabled) {
      const allowed = await input.publisher.check(config)
      if (!allowed.ok) return { status: "reviewed", reason: `kept in this session: ${allowed.reason}`, notPublisher: true, outcome: { ...outcome, result }, state: input.state, config, incremental: range.incremental, info }
      const other = reader ? await reviewedBy({ gh: reader, repo: input.repo, number: input.number, head: input.head, rule: config.publishers, self: input.publisher.login }) : undefined
      if (other) return { status: "reviewed", reason: `@${other} already posted a MendCode review of this head; kept in this session`, notPublisher: true, outcome: { ...outcome, result }, state: input.state, config, incremental: range.incremental, info }
    }
    if (!input.gh || !input.publish || !config.enabled) return { status: "reviewed", ...(!config.enabled ? { reason: "publishing needs enabled: true in .mendcode/review.yaml on the base branch" } : {}), outcome: { ...outcome, result }, state: input.state, config, incremental: range.incremental, info }
    const report = await publishReview({ repo: input.repo, number: input.number, result, previous: input.state, process: input.gh, resolve: fixed, info })
    if (!report.posted && report.reason?.startsWith("GitHub refused")) return { status: "failed", reason: report.reason, outcome: { ...outcome, result }, report, state: input.state, config, incremental: range.incremental, info }
    return { status: "published", outcome: { ...outcome, result }, report, state: report.state, config, incremental: range.incremental, info }
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error), state: input.state, config, incremental: range.incremental }
  }
}

/** The findings of a review as lines for a session notice: what was confirmed, what was folded, and why nothing was posted. */
export function reviewNotice({ repo, number, run }: { repo: string; number: number; run: ReviewRun }): string {
  const lines = [`PR review of ${repo}#${number}: ${run.status}${run.reason ? ` (${run.reason})` : ""}`]
  const result = run.outcome?.result
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
  return lines.join("\n")
}
