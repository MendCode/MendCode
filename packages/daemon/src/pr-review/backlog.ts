import { z } from "zod"
import type { PrFacts } from "./contracts"
import { reviewerFromBody, reviewerMarker } from "./publish"
import { isReview } from "./publishers"
import { REVIEW_MARKER } from "./state"

/**
 * The backlog of a watch (docs/pr-review.md, "Open PRs when a watch starts"): when a watch starts, and at every catch-up (a daemon
 * start, a resume after a pause or an outage), the open PRs whose current head has no MendCode review by the reviewer that would
 * take it are queued as reviews (trigger `backlog`), so a PR opened while no watch ran is reviewed without anyone asking. Seen live:
 * a watch ended during a network outage, #23 was opened in the gap, and the new watch took it as the baseline; it was reviewed only
 * once someone wrote `@mendcode review`.
 *
 * Bounded: newest `updatedAt` first, at most `backlog.max_prs` per catch-up (default 10; 0 keeps today's baseline: only a new PR
 * or a new head is reviewed), and only PRs updated within `backlog.window_days` (default 30). At most `MAX_BACKLOG_CHECKS` PRs are
 * decided per catch-up, so a repository full of filtered PRs costs a bounded number of reads. A PR past the cap is not read at all.
 * A PR whose current head already has a review that counts for that reviewer (the local review state, a finished job, or a review on
 * the pull request by this login or a publisher `publishers` counts, as `headReviewedBy` decides for `@mendcode review`; one with
 * another reviewer's marker does not count) stays the baseline. Eligibility (filters, drafts, mode, personal routing) is the platform's own `decide`; a PR it
 * refuses is listed with its reason. Two devices that both queue one PR are settled by the claim gate before either runs.
 *
 * Pure: the platform passes `decide` and `status` (service.ts), so the selection is the same for GitHub, GitLab and Gitea.
 */

export const DEFAULT_BACKLOG_MAX = 10
export const MAX_BACKLOG_MAX = 50
export const DEFAULT_BACKLOG_DAYS = 30
/** PRs decided (eligibility, then their reviews read) per catch-up at most; the rest are listed as not checked. */
export const MAX_BACKLOG_CHECKS = 50
/** At most this many skipped PRs are named in a watch's answer; the rest are counted. */
const MAX_LISTED_SKIPS = 10
const DAY_MS = 86_400_000

/** The repo config's `backlog` (base branch's `.mendcode/review.yaml`); `max_prs: 0` turns it off. */
export const BacklogConfig = z.strictObject({
  max_prs: z.number().int().min(0).max(MAX_BACKLOG_MAX).default(DEFAULT_BACKLOG_MAX),
  window_days: z.number().int().min(1).max(365).default(DEFAULT_BACKLOG_DAYS),
}).default({ max_prs: DEFAULT_BACKLOG_MAX, window_days: DEFAULT_BACKLOG_DAYS })
export type BacklogConfig = z.infer<typeof BacklogConfig>
export const DEFAULT_BACKLOG: BacklogConfig = BacklogConfig.parse(undefined)

/** Whether a PR is reviewed by this daemon (and by which of its reviewers), or why not: eligibility and routing (`plan.decide`). */
export type BacklogDecision = { ok: false; reason: string } | { ok: true; reviewers: readonly string[] }
/**
 * What one reviewer has of a PR's current head: `reviewed` (the local state, a finished job, or its review on the pull request),
 * `queued` (an open job of that head), `unreviewed`, or `unknown` (its reviews could not be read: it is queued, and the publisher
 * looks for another review of the head again before it posts).
 */
export type HeadStatus = "reviewed" | "queued" | "unreviewed" | "unknown"
export type BacklogSkipKind = "cap" | "window" | "filter" | "unchecked"
export type BacklogSkip = { number: number; kind: BacklogSkipKind; reason: string }
export type BacklogPick = { number: number; head: string; reviewers: string[]; reason: string }
export type BacklogPlan = {
  /** Off (`max_prs: 0`): nothing was read, the open PRs are the baseline. */
  off: boolean
  queued: BacklogPick[]
  /** Already reviewed at their current head by every reviewer that takes them: the baseline. */
  reviewed: number[]
  /** A job of their current head is open already. */
  open: number[]
  skipped: BacklogSkip[]
}

const updatedOf = (pr: PrFacts) => { const at = pr.updatedAt ? Date.parse(pr.updatedAt) : NaN; return Number.isFinite(at) ? at : undefined }
/** Newest `updatedAt` first; a PR without one after those with one; the higher number first on a tie. */
export const backlogOrder = (prs: readonly PrFacts[]) => prs.toSorted((a, b) => (updatedOf(b) ?? -Infinity) - (updatedOf(a) ?? -Infinity) || b.number - a.number)
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200)

/**
 * Which open PRs a catch-up queues, in order, and why each other one is not. `decide` is asked only for PRs inside the window and
 * under the cap, `status` only for PRs `decide` takes, once per reviewer. Never throws: a failing `decide` skips the PR with the
 * error; a failing `status` reads as `unknown`.
 */
export async function planBacklog({ prs, config, now, decide, status }: {
  prs: readonly PrFacts[]
  config: BacklogConfig
  now: number
  decide(pr: PrFacts): Promise<BacklogDecision>
  status(pr: PrFacts, reviewer: string): Promise<HeadStatus>
}): Promise<BacklogPlan> {
  const plan: BacklogPlan = { off: config.max_prs === 0, queued: [], reviewed: [], open: [], skipped: [] }
  if (plan.off) return plan
  const cutoff = now - config.window_days * DAY_MS
  let checks = 0
  for (const pr of backlogOrder(prs)) {
    const updated = updatedOf(pr)
    if (updated !== undefined && updated < cutoff) {
      plan.skipped.push({ number: pr.number, kind: "window", reason: `window: last updated ${Math.floor((now - updated) / DAY_MS)} days ago, outside the ${config.window_days}-day backlog.window_days` })
      continue
    }
    if (plan.queued.length >= config.max_prs) {
      plan.skipped.push({ number: pr.number, kind: "cap", reason: `cap: ${config.max_prs} newer PRs were queued first (backlog.max_prs)` })
      continue
    }
    if (checks >= MAX_BACKLOG_CHECKS) {
      plan.skipped.push({ number: pr.number, kind: "unchecked", reason: `not checked: ${MAX_BACKLOG_CHECKS} newer PRs were checked first` })
      continue
    }
    checks++
    const decision = await decide(pr).catch((error: unknown): BacklogDecision => ({ ok: false, reason: `the platform could not decide: ${message(error)}` }))
    if (!decision.ok || !decision.reviewers.length) {
      plan.skipped.push({ number: pr.number, kind: "filter", reason: (decision.ok ? "no reviewer of this daemon takes it" : decision.reason).slice(0, 300) })
      continue
    }
    const statuses: Array<{ reviewer: string; status: HeadStatus }> = []
    for (const reviewer of new Set(decision.reviewers)) statuses.push({ reviewer, status: await status(pr, reviewer).catch((): HeadStatus => "unknown") })
    const pending = statuses.filter((item) => item.status === "unreviewed" || item.status === "unknown")
    if (!pending.length) {
      if (statuses.some((item) => item.status === "queued")) plan.open.push(pr.number)
      else plan.reviewed.push(pr.number)
      continue
    }
    const unread = pending.some((item) => item.status === "unknown")
    plan.queued.push({
      number: pr.number, head: pr.head, reviewers: pending.map((item) => item.reviewer),
      reason: `backlog: head ${pr.head.slice(0, 12)} has no review yet${unread ? " (its reviews could not be read; the publisher checks again before posting)" : ""}`,
    })
  }
  return plan
}

type PostedReview = { id?: unknown; commit_id?: unknown; state?: unknown; body?: unknown; user?: { login?: unknown; type?: unknown } | null; author_association?: unknown }
export type ReviewAuthor = { login?: string | undefined; association?: string | undefined; bot: boolean }

/**
 * The id of a review of `head` that counts for `reviewer` among a PR's submitted reviews (GitHub's shape: `id`, `commit_id`,
 * `state`, `body`, `user`), or undefined: the rule `headReviewedBy` answers `@mendcode review` with, per reviewer. A review is of
 * `head` when it was submitted on that commit or its MendCode head marker names it (GitLab and Gitea posts carry no commit). One
 * with a reviewer marker counts only for the reviewer it names; one without (written in a session or by hand, or from before
 * reviewer markers) counts for every reviewer. `counts` says whether its author counts: this daemon's login, or a publisher
 * `publishers` allows. Pending and dismissed reviews never count.
 */
export function headReviewOf({ reviews, head, reviewer, counts }: { reviews: readonly unknown[]; head: string; reviewer: string; counts(author: ReviewAuthor): boolean }): number | undefined {
  const ours = reviewerFromBody(reviewerMarker({ reviewer, configKey: "x", key: "" }))?.reviewer
  for (const item of reviews as PostedReview[]) {
    if (!item || typeof item !== "object" || typeof item.id !== "number" || item.state === "PENDING" || item.state === "DISMISSED" || !isReview(item)) continue
    const body = typeof item.body === "string" ? item.body : ""
    const marked = REVIEW_MARKER.exec(body)?.[1]
    if (item.commit_id !== head && !(marked && head.startsWith(marked))) continue
    const named = reviewerFromBody(body)
    if (named && named.reviewer !== ours) continue
    const author: ReviewAuthor = { ...(typeof item.user?.login === "string" ? { login: item.user.login } : {}), ...(typeof item.author_association === "string" ? { association: item.author_association } : {}), bot: item.user?.type === "Bot" }
    if (counts(author)) return item.id
  }
  return undefined
}

const numbers = (values: readonly number[]) => values.map((number) => `#${number}`).join(", ")

/**
 * The sentences a watch's answer (or a catch-up's notice) carries about its backlog; empty when it is off or found nothing. The
 * skipped PRs are named with their reasons, at most `MAX_LISTED_SKIPS`, the rest counted.
 */
export function backlogText(plan: BacklogPlan): string {
  if (plan.off) return ""
  const parts: string[] = []
  if (plan.queued.length) parts.push(`Queued ${plan.queued.length} open PR${plan.queued.length === 1 ? "" : "s"} without a review of the current head (${numbers(plan.queued.map((pick) => pick.number))}).`)
  if (plan.open.length) parts.push(`${numbers(plan.open)} ${plan.open.length === 1 ? "has" : "have"} a review job already.`)
  if (plan.reviewed.length) parts.push(`${plan.reviewed.length} already reviewed at the current head stay${plan.reviewed.length === 1 ? "s" : ""} as ${plan.reviewed.length === 1 ? "it is" : "they are"}.`)
  if (plan.skipped.length) {
    const named = plan.skipped.slice(0, MAX_LISTED_SKIPS).map((skip) => `#${skip.number} (${skip.reason})`).join("; ")
    const rest = plan.skipped.length - MAX_LISTED_SKIPS
    parts.push(`Not queued: ${named}${rest > 0 ? `; ${rest} more` : ""}. /pr review N reviews one now.`)
  }
  return parts.join(" ")
}
