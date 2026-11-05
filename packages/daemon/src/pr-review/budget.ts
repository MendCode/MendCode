import type { PrStopReason, PrTokenUsage } from "@mendcode/protocol"
import { parseResetTime } from "../usage-limit-reset"
import type { ReviewConfig } from "./config"
import { DEFAULT_CONTEXT_TOKENS, type BudgetCheck, type BudgetPolicy } from "./contracts"

/**
 * The review platform's model-work limits (docs/pr-review.md, budgets; locked decision 7). Five things are kept apart because
 * they are different facts with different owners:
 *
 * - `tokens_per_pr`, MendCode's own cumulative cap per pull request head (review, verify, fix and resumed rounds together);
 *   `null` is no internal cap at all. Only this one is checked by `checkBudget`.
 * - `context_tokens`, what ONE call may carry (a window, not a total), from the config or the model's window.
 * - The provider's quota (a subscription window or an account's credit), which only the provider knows: a failure that says so
 *   is classified `quota` and waited for or stopped on (`quotaPlan`), never worked around.
 * - A rate limit (too many requests in a short time), which passes by itself: backed off, not a quota.
 * - Loop limits (`max_rounds`, no progress) live with the fix loop and phases, not here.
 *
 * Nothing here prices tokens or estimates a bill: under a subscription there is no per-token bill to compute, and an API price
 * table is the global `budgets` setting's business (docs/budgets.md). Nothing here ever switches a job to another model,
 * provider, API key or "extra usage": a quota stop waits or stops.
 */

/**
 * The share of a model's context window one review call may fill. The rest is headroom the call itself needs: the harness's own
 * system prompt and tool definitions, the files the child reads with its tools during the turn, and the answer.
 */
export const CONTEXT_WINDOW_SHARE = 0.75
/** The bounds `budget.context_tokens` has in the config schema; a window outside them is brought inside. */
const MIN_CONTEXT_TOKENS = 8_000
const MAX_CONTEXT_TOKENS = 2_000_000

/**
 * The budget a job runs under. `tokensPerPr` is undefined when `tokens_per_pr` is `null` (no internal cap). `contextTokens` is the
 * config's `context_tokens`, else `CONTEXT_WINDOW_SHARE` of the model's window, else `DEFAULT_CONTEXT_TOKENS`; it never exceeds
 * the PR's own cap, since one call carrying more than the cap would pass it alone.
 */
export function budgetPolicy(config: Pick<ReviewConfig, "budget">, { contextWindow }: { contextWindow?: number | undefined } = {}): BudgetPolicy {
  const { tokens_per_pr: cap, context_tokens: configured, on_quota: onQuota, max_wait_minutes: maxWaitMinutes } = config.budget
  const window = contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow * CONTEXT_WINDOW_SHARE) : undefined
  const wanted = Math.min(MAX_CONTEXT_TOKENS, Math.max(MIN_CONTEXT_TOKENS, configured ?? window ?? DEFAULT_CONTEXT_TOKENS))
  const tokensPerPr = cap ?? undefined
  return { ...(tokensPerPr !== undefined ? { tokensPerPr } : {}), contextTokens: tokensPerPr !== undefined ? Math.min(wanted, tokensPerPr) : wanted, onQuota, maxWaitMinutes }
}

/**
 * The tokens that count against `tokens_per_pr`: input the provider did NOT serve from its cache, plus output. `input` includes the
 * cached part (the review sessions add `cacheRead` and `cacheWrite` into it, `cached` is `cacheRead`), the same rule as `spent` in
 * verify.ts. Cached tokens are excluded, not discounted: no conversion rate between cached and fresh tokens is assumed.
 */
export const countedTokens = (used: PrTokenUsage) => Math.max(0, used.input - (used.cached ?? 0)) + used.output

/** The base every review's scaled budget starts from: the fixed cost of a child that reads the checkout, whatever the size of the diff. */
export const SCALED_BUDGET_BASE = 150_000

/**
 * The cap one review runs under: `tokens_per_pr` is the ceiling, and the cap grows with the change from `SCALED_BUDGET_BASE` by
 * `tokens_per_diff_token` for each token of diff (`diffTokens`, the whole diff, not only one part of it). Undefined when
 * `tokens_per_pr` is `null` (no internal cap) or the scale is 0 and nothing else bounds it.
 */
export function scaledBudget(budget: Pick<ReviewConfig["budget"], "tokens_per_pr" | "tokens_per_diff_token">, diffTokens: number): number | undefined {
  const ceiling = budget.tokens_per_pr ?? undefined
  if (ceiling === undefined) return undefined
  if (!budget.tokens_per_diff_token) return ceiling
  return Math.min(ceiling, Math.max(10_000, SCALED_BUDGET_BASE + Math.round(budget.tokens_per_diff_token * Math.max(0, diffTokens))))
}

/** Two usages added field by field; an absent `cached` or `unreported` stays absent when both lack it. */
export function addUsage(a: PrTokenUsage, b: PrTokenUsage): PrTokenUsage {
  const cached = a.cached === undefined && b.cached === undefined ? undefined : (a.cached ?? 0) + (b.cached ?? 0)
  const unreported = a.unreported === undefined && b.unreported === undefined ? undefined : (a.unreported ?? 0) + (b.unreported ?? 0)
  return { input: a.input + b.input, output: a.output + b.output, ...(cached !== undefined ? { cached } : {}), ...(unreported !== undefined ? { unreported } : {}) }
}

const tokensText = (value: number) => Math.round(value).toLocaleString("en-US")
const callsText = (count: number) => `${count} call${count === 1 ? "" : "s"}`

/**
 * Whether the job may make another call. Without a cap it always may (`remaining` undefined: nothing internal to run out of). At
 * or past the cap it stops with a resumable `budget` stop in tokens; `remaining` (what the job has not done yet) is the caller's
 * to say. Calls without a provider report (`unreported`) make the count a lower bound, and the detail says so.
 */
export function checkBudget(policy: BudgetPolicy, used: PrTokenUsage, { remaining }: { remaining?: string | undefined } = {}): BudgetCheck {
  const counted = countedTokens(used)
  if (policy.tokensPerPr === undefined) return { ok: true }
  if (counted < policy.tokensPerPr) return { ok: true, remaining: policy.tokensPerPr - counted }
  const unknown = used.unreported ? `; ${callsText(used.unreported)} reported no usage, so the real figure is higher by an unknown amount` : ""
  const cached = used.cached ? `; ${tokensText(used.cached)} cached input tokens are not counted` : ""
  const detail = `token budget of this pull request head reached: ${tokensText(counted)} of ${tokensText(policy.tokensPerPr)} tokens counted (input not served from cache plus output${cached}${unknown})`
  return { ok: false, stop: { kind: "budget", detail: detail.slice(0, 600), unit: "tokens", used: counted, limit: policy.tokensPerPr, resumable: true, ...(remaining ? { remaining: remaining.slice(0, 400) } : {}) } }
}

/**
 * The account ran out (a subscription window, a plan's quota, an API key's credit): waiting for the reset is the only cure.
 * The words are the native engine's quota 429 bodies (`isQuotaBody`), Claude Code's (`Claude AI usage limit reached|<epoch>`,
 * `5-hour limit reached ∙ resets 2:10 AM`, `You've hit your limit · resets 9pm`) and Codex's (`You've hit your usage limit`).
 */
const QUOTA_WORDS = /usage_limit|insufficient_quota|\busage limit\b|\bquota\b|\bhit your (?:usage )?limit\b|\bout of (?:extra )?(?:usage|credits)\b|\bcredit balance is too low\b|\b(?:5-hour|five[- ]hour|weekly|daily|monthly|session|opus|sonnet)\s+limit\b|\blimit reached\s*[|∙·]|\bplan limit\b/i
/**
 * Too many requests in a short time, or a provider that is overloaded: it passes by itself. A 429 whose body names a quota is
 * matched by `QUOTA_WORDS` first; Codex's `exceeded retry limit, last status: 429 Too Many Requests` and an HTTP 429/529 are this.
 */
const RATE_WORDS = /\b429\b|\b529\b|rate[_ -]?limit|too many requests|\boverloaded\b|requests per (?:minute|second)|tokens per minute|retry[- ]after|slow down/i

export type StopClass = { kind: "quota" | "rate_limit" | "error"; resetsAt?: number | undefined }

/**
 * What a failed model call's message says about why it failed: `quota` (the account ran out; wait for the reset), `rate_limit`
 * (requests too fast; back off), else `error`. `resetsAt` is the time the message names (`usage-limit-reset.ts`, the parser the
 * session usage-limit pause uses), undefined when it names none; it is never guessed. `code` is the `turn.failed` code when the
 * caller has it (`usage_limit` is a quota whatever the words). Accepts the review session's `[PR_REVIEW]: the review turn failed: …`.
 */
export function classifyStop(message: string, { now = Date.now(), code }: { now?: number; code?: string | undefined } = {}): StopClass {
  const kind = /^usage_limit/.test(code ?? "") || QUOTA_WORDS.test(message) ? "quota" : RATE_WORDS.test(message) ? "rate_limit" : "error"
  if (kind === "error") return { kind }
  const resetsAt = parseResetTime(message, now)
  return resetsAt === undefined ? { kind } : { kind, resetsAt }
}

/**
 * The stop a classified failure becomes, with the provider's words cut to the detail's limit. Resumable in every case: the job's
 * checkpoint is kept, so a quota or rate limit resumes after its wait and an error can be retried (/reviews `r`).
 */
export function failureStop(message: string, options: { now?: number; code?: string | undefined; remaining?: string | undefined } = {}): PrStopReason {
  const found = classifyStop(message, options)
  const words = message.replace(/^\[PR_REVIEW\]:\s*/, "").trim() || "the model call failed"
  return {
    kind: found.kind, detail: words.slice(0, 600), resumable: true,
    ...(found.resetsAt !== undefined ? { resetsAt: found.resetsAt } : {}), ...(options.remaining ? { remaining: options.remaining.slice(0, 400) } : {}),
  }
}

/** The wait before trying again when the provider named no reset time: it grows, and the whole wait stays within `max_wait_minutes`. */
export const UNKNOWN_RESET_BACKOFF_MINUTES: readonly number[] = [5, 15, 30, 60, 120, 240]
export const RATE_LIMIT_BACKOFF_MINUTES: readonly number[] = [1, 2, 5, 10, 20]
/** A rate limit backed off this many times in a row is no longer a hiccup: the job stops and says so. */
export const MAX_RATE_LIMIT_WAITS = RATE_LIMIT_BACKOFF_MINUTES.length
/** Past a named reset, a little more: the provider's clock and ours differ (the session pause uses the same 3 s). */
export const RESET_GRACE_MS = 3_000
const MINUTE_MS = 60_000

export type QuotaPlan =
  | { action: "wait"; until: number; resetKnown: boolean; reason: string }
  | { action: "stop"; reason: string }

/**
 * What a job does after a quota or rate-limit stop. A quota with `on_quota: wait` waits until the named reset, or along
 * `UNKNOWN_RESET_BACKOFF_MINUTES` when none was named (and says the reset is unknown); a rate limit backs off along
 * `RATE_LIMIT_BACKOFF_MINUTES` (or until its named retry time) whatever `on_quota` says, at most `MAX_RATE_LIMIT_WAITS` times.
 * Every wait of the job together stays within `max_wait_minutes` (`waitedMs`: what it already waited for this stop); past that it
 * stops. Any other stop kind is not waited for. There is no third action: no other model, provider, API key or paid usage.
 */
export function quotaPlan({ policy, stop, now, waits = 0, waitedMs = 0 }: { policy: BudgetPolicy; stop: PrStopReason; now: number; waits?: number; waitedMs?: number }): QuotaPlan {
  if (stop.kind !== "quota" && stop.kind !== "rate_limit") return { action: "stop", reason: `a ${stop.kind} stop is not waited for` }
  if (stop.kind === "quota" && policy.onQuota === "stop") return { action: "stop", reason: "budget.on_quota is stop" }
  if (stop.kind === "rate_limit" && waits >= MAX_RATE_LIMIT_WAITS) return { action: "stop", reason: `the rate limit persisted through ${waits} backoffs` }
  const allowed = policy.maxWaitMinutes * MINUTE_MS - waitedMs
  if (allowed <= 0) return { action: "stop", reason: `already waited budget.max_wait_minutes (${policy.maxWaitMinutes} minutes)` }
  const resetKnown = stop.resetsAt !== undefined
  if (resetKnown) {
    const wait = Math.max(0, stop.resetsAt! - now) + RESET_GRACE_MS
    if (wait > allowed) return { action: "stop", reason: `the ${stop.kind === "quota" ? "quota resets" : "rate limit ends"} at ${clock(stop.resetsAt!)}, beyond budget.max_wait_minutes (${policy.maxWaitMinutes} minutes${waitedMs ? `, ${Math.round(waitedMs / MINUTE_MS)} already waited` : ""})` }
    return { action: "wait", until: now + wait, resetKnown, reason: `waiting for the ${stop.kind === "quota" ? "quota reset" : "rate limit to pass"} at ${clock(stop.resetsAt!)}` }
  }
  const schedule = stop.kind === "quota" ? UNKNOWN_RESET_BACKOFF_MINUTES : RATE_LIMIT_BACKOFF_MINUTES
  const step = schedule[Math.min(waits, schedule.length - 1)]! * MINUTE_MS
  const wait = Math.min(step, allowed)
  return { action: "wait", until: now + wait, resetKnown, reason: `${stop.kind === "quota" ? "the provider did not say when the quota resets (unknown)" : "the provider did not say when to retry"}; trying again in ${Math.round(wait / MINUTE_MS)} minute${Math.round(wait / MINUTE_MS) === 1 ? "" : "s"}` }
}

/** A UTC time a log line and a test can both read; the TUI shows local times itself. */
const clock = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`
function inText(ms: number) {
  const minutes = Math.max(0, Math.round(ms / MINUTE_MS))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/**
 * The exact reason a job stopped, for the user: which limit (MendCode's budget, the provider's quota, a rate limit, a loop limit),
 * in its unit, how much was used against which limit (or "no internal limit"), whether that figure is measured, partly unknown
 * or unknown, what work remains, and how to continue. `tokens` adds the cached and unreported parts of a token figure; `jobId`
 * names the job to pick on the /reviews page. The ways to retry are the ones a user has: `r` on /reviews, or an `@mendcode
 * review` comment on the PR.
 */
export function stopText(stop: PrStopReason, { now = Date.now(), jobId, tokens }: { now?: number; jobId?: string | undefined; tokens?: PrTokenUsage | undefined } = {}): string {
  const retry = `retry it from /reviews (r${jobId ? ` on job ${jobId}` : ""}) or comment @mendcode review on the PR`
  const unit = stop.unit ?? "tokens"
  const limit = stop.limit === undefined ? "no internal limit" : `${tokensText(stop.limit)} ${unit}`
  const lines: string[] = []
  const unreported = tokens?.unreported ?? 0
  const measured = stop.used === undefined ? "unknown (the source did not report it)" : unreported ? `at least ${tokensText(stop.used)} ${unit} (${callsText(unreported)} reported no usage; the rest is unknown)` : `${tokensText(stop.used)} ${unit} (measured)`
  const reset = stop.resetsAt === undefined ? "reset time unknown (the provider did not say)" : `resets ${clock(stop.resetsAt)} (in ${inText(stop.resetsAt - now)})`
  switch (stop.kind) {
    case "budget":
      lines.push(`Stopped at MendCode's token budget for this pull request head (budget.tokens_per_pr), not at a provider limit.`)
      lines.push(`Used: ${measured} of ${limit}; counted is input not served from the provider's cache plus output${tokens?.cached ? `; ${tokensText(tokens.cached)} cached input tokens were read and are not counted` : ""}.`)
      break
    case "quota":
      lines.push(`Stopped at the provider's usage limit (the account's real quota, not MendCode's budget): ${stop.detail}`)
      lines.push(`Quota left: ${stop.unit === "percent" && stop.used !== undefined ? `${100 - Math.min(100, stop.used)}% (${stop.used}% used)` : "unknown (the provider did not report it)"}; ${reset}.`)
      break
    case "rate_limit":
      lines.push(`Stopped by the provider's rate limit (too many requests in a short time; the quota itself may be fine): ${stop.detail}`)
      lines.push(`Retry: ${stop.resetsAt === undefined ? "the provider named no time; the job backs off" : `the provider allows it ${clock(stop.resetsAt)} (in ${inText(stop.resetsAt - now)})`}.`)
      break
    default:
      lines.push(`Stopped (${stop.kind}): ${stop.detail}`)
      if (stop.used !== undefined || stop.limit !== undefined) lines.push(`Used: ${measured} of ${limit}.`)
  }
  lines.push(`Remaining: ${stop.remaining ?? "not recorded"}.`)
  lines.push(stop.resumable ? "The job is checkpointed: what it found so far is kept, and nothing unfinished is published as a complete review." : "The job cannot continue from where it stopped.")
  switch (stop.kind) {
    case "budget":
      lines.push(`To continue: raise budget.tokens_per_pr in .mendcode/review.yaml, or set it to null for no internal limit, then ${retry}.`)
      break
    case "quota":
      lines.push(`To continue: wait for the reset (with budget.on_quota: wait the job resumes by itself, waiting at most budget.max_wait_minutes), or ${retry} after it. MendCode does not switch to an API key or extra paid usage.`)
      break
    case "rate_limit":
      lines.push(`To continue: the job retries by itself after a backoff, or ${retry} to retry now. MendCode does not switch to an API key or extra paid usage.`)
      break
    default:
      if (stop.resumable) lines.push(`To continue: ${retry}.`)
  }
  return lines.join("\n")
}
