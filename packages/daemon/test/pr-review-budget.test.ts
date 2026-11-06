import { describe, expect, test } from "bun:test"
import { PrStopReason } from "@mendcode/protocol"
import { budgetPolicy, checkBudget, scaledBudget, classifyStop, CONTEXT_WINDOW_SHARE, countedTokens, failureStop, MAX_RATE_LIMIT_WAITS, quotaPlan, RESET_GRACE_MS, stopText, UNKNOWN_RESET_BACKOFF_MINUTES } from "../src/pr-review/budget"
import { DEFAULT_REVIEW_CONFIG, ReviewConfig } from "../src/pr-review/config"
import { DEFAULT_CONTEXT_TOKENS, type BudgetPolicy } from "../src/pr-review/contracts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.UTC(2026, 9, 30, 12, 0)
const withBudget = (budget: Record<string, unknown>) => ReviewConfig.parse({ budget })
const policy = (patch: Partial<BudgetPolicy> = {}): BudgetPolicy => ({ tokensPerPr: 1_000_000, contextTokens: DEFAULT_CONTEXT_TOKENS, onQuota: "wait", maxWaitMinutes: 360, ...patch })

describe("budgetPolicy", () => {
  test("the default config caps a PR head at 1,000,000 tokens and waits for a quota for up to 6 hours", () => {
    expect(budgetPolicy(DEFAULT_REVIEW_CONFIG)).toEqual({ tokensPerPr: 1_000_000, contextTokens: DEFAULT_CONTEXT_TOKENS, onQuota: "wait", maxWaitMinutes: 360 })
  })

  test("tokens_per_pr null is no internal cap: tokensPerPr is absent, and the context still comes from the window", () => {
    const found = budgetPolicy(withBudget({ tokens_per_pr: null }), { contextWindow: 1_000_000 })
    expect(found.tokensPerPr).toBeUndefined()
    expect("tokensPerPr" in found).toBe(false)
    expect(found.contextTokens).toBe(1_000_000 * CONTEXT_WINDOW_SHARE)
  })

  test("context_tokens wins over the model's window, which wins over the default; it is per call, not the cumulative cap", () => {
    expect(budgetPolicy(withBudget({ tokens_per_pr: 5_000_000, context_tokens: 120_000 }), { contextWindow: 1_000_000 }).contextTokens).toBe(120_000)
    expect(budgetPolicy(withBudget({ tokens_per_pr: 5_000_000 }), { contextWindow: 200_000 }).contextTokens).toBe(150_000)
    expect(budgetPolicy(withBudget({ tokens_per_pr: 5_000_000 })).contextTokens).toBe(DEFAULT_CONTEXT_TOKENS)
    expect(budgetPolicy(withBudget({ tokens_per_pr: 5_000_000 }), { contextWindow: 0 }).contextTokens).toBe(DEFAULT_CONTEXT_TOKENS)
    expect(budgetPolicy(withBudget({ tokens_per_pr: 5_000_000 }), { contextWindow: Number.NaN }).contextTokens).toBe(DEFAULT_CONTEXT_TOKENS)
  })

  test("one call never carries more than the PR's own cap, and a tiny window is brought up to the schema's floor", () => {
    expect(budgetPolicy(withBudget({ tokens_per_pr: 50_000 }), { contextWindow: 1_000_000 }).contextTokens).toBe(50_000)
    expect(budgetPolicy(withBudget({ tokens_per_pr: null }), { contextWindow: 4_000 }).contextTokens).toBe(8_000)
  })

  test("on_quota and max_wait_minutes are carried over", () => {
    expect(budgetPolicy(withBudget({ on_quota: "stop", max_wait_minutes: 30 }))).toMatchObject({ onQuota: "stop", maxWaitMinutes: 30 })
  })
})

describe("checkBudget", () => {
  test("without an internal cap nothing stops it, however much was used", () => {
    const unlimited = policy({ tokensPerPr: undefined })
    for (const input of [0, 1_000_000, 50_000_000_000]) expect(checkBudget(unlimited, { input, output: input })).toEqual({ ok: true })
  })

  test("under the cap it says what is left of it", () => {
    expect(checkBudget(policy(), { input: 300_000, output: 20_000 })).toEqual({ ok: true, remaining: 680_000 })
  })

  test("at the cap it stops resumably with the exact unit, used and limit, and what remains", () => {
    const check = checkBudget(policy(), { input: 990_000, output: 10_000 }, { remaining: "3 candidates not verified; phase validation not run" })
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.stop).toMatchObject({ kind: "budget", unit: "tokens", used: 1_000_000, limit: 1_000_000, resumable: true, remaining: "3 candidates not verified; phase validation not run" })
    expect(PrStopReason.parse(check.stop)).toEqual(check.stop)
    expect(check.stop.detail).toContain("1,000,000 of 1,000,000 tokens counted")
  })

  test("cached input is excluded from the count, not discounted: 900k input of which 850k cached is 50k counted", () => {
    const used = { input: 900_000, output: 30_000, cached: 850_000 }
    expect(countedTokens(used)).toBe(80_000)
    expect(checkBudget(policy({ tokensPerPr: 100_000 }), used)).toEqual({ ok: true, remaining: 20_000 })
    const over = checkBudget(policy({ tokensPerPr: 50_000 }), used)
    expect(over.ok).toBe(false)
    if (!over.ok) {
      expect(over.stop.used).toBe(80_000)
      expect(over.stop.detail).toContain("850,000 cached input tokens are not counted")
    }
  })

  test("calls without a provider report make the figure a lower bound, and the stop says so", () => {
    const over = checkBudget(policy({ tokensPerPr: 10_000 }), { input: 20_000, output: 0, unreported: 2 })
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.stop.detail).toContain("2 calls reported no usage")
  })
})

describe("classifyStop", () => {
  const cases: Array<[string, "quota" | "rate_limit" | "error"]> = [
    // native engine (provider-http.ts: a quota 429 is final, its body says so)
    ['[PROVIDER]: openai 429 {"error":{"code":"usage_limit_reached","message":"The usage limit has been reached"}}', "quota"],
    ["[PROVIDER]: openai 429 insufficient_quota", "quota"],
    // Claude Code
    ["Claude AI usage limit reached|1791036000", "quota"],
    ["5-hour limit reached ∙ resets 2:10 AM (America/Panama)", "quota"],
    ["You've hit your limit · resets 9pm (America/Panama)", "quota"],
    ["Credit balance is too low", "quota"],
    // Codex
    ["You've hit your usage limit. Upgrade to Pro or try again in 3h 20m.", "quota"],
    // rate limits: the engine's retries ran out on a plain 429/529
    ["exceeded retry limit, last status: 429 Too Many Requests", "rate_limit"],
    ['[PROVIDER]: anthropic 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', "rate_limit"],
    ['[PROVIDER]: anthropic 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "rate_limit"],
    ["rate limit, retry after 45 seconds", "rate_limit"],
    // ordinary failures
    ["[PROVIDER]: openai 500 internal error", "error"],
    ["[PR_REVIEW]: the review turn timed out", "error"],
    ["[CLAUDE]: claude exited during the turn", "error"],
    ["TypeError: undefined is not a function", "error"],
    // a prompt over the model's window is the context, not the account's quota: waiting would not cure it
    ["prompt is too long: 250000 tokens > 200000 maximum (token limit exceeded)", "error"],
  ]
  for (const [message, kind] of cases) test(`${kind}: ${message.slice(0, 70)}`, () => expect(classifyStop(message, { now: NOW }).kind).toBe(kind))

  test("the review session's wrapper is read through", () => {
    expect(classifyStop("[PR_REVIEW]: the review turn failed: Claude AI usage limit reached|1793368800", { now: NOW })).toEqual({ kind: "quota", resetsAt: NOW + 2 * HOUR })
    // A named time already past is not a reset: unknown, not "now".
    expect(classifyStop("Claude AI usage limit reached|1791036000", { now: NOW })).toEqual({ kind: "quota" })
  })

  test("a reset the message names is kept; none named is undefined, never guessed", () => {
    expect(classifyStop("You've hit your usage limit. Try again in 3h 20m.", { now: NOW })).toEqual({ kind: "quota", resetsAt: NOW + 3 * HOUR + 20 * MINUTE })
    expect(classifyStop("rate limit, retry after 45 seconds", { now: NOW })).toEqual({ kind: "rate_limit", resetsAt: NOW + 45_000 })
    expect(classifyStop("usage limit reached", { now: NOW })).toEqual({ kind: "quota" })
    expect(classifyStop("[PROVIDER]: openai 500 internal error, resets at 5pm", { now: NOW }).resetsAt).toBeUndefined()
  })

  test("the turn's usage_limit code is a quota whatever the words", () => {
    expect(classifyStop("something odd", { now: NOW, code: "usage_limit" }).kind).toBe("quota")
    expect(classifyStop("faux 429 something", { now: NOW, code: "usage_limit_reached" }).kind).toBe("quota")
  })

  test("failureStop makes a valid resumable stop without the [PR_REVIEW] prefix", () => {
    const stop = failureStop("[PR_REVIEW]: the review turn failed: 5-hour limit reached ∙ resets 2:10 AM (UTC)", { now: NOW, remaining: "verify of 4 candidates" })
    expect(PrStopReason.parse(stop)).toEqual(stop)
    expect(stop).toMatchObject({ kind: "quota", resumable: true, remaining: "verify of 4 candidates", resetsAt: Date.UTC(2026, 9, 31, 2, 10) })
    expect(stop.detail.startsWith("the review turn failed")).toBe(true)
  })
})

describe("quotaPlan", () => {
  const quota = (resetsAt?: number): PrStopReason => ({ kind: "quota", detail: "usage limit reached", resumable: true, ...(resetsAt !== undefined ? { resetsAt } : {}) })

  test("on_quota wait with a named reset waits until the reset plus a small grace", () => {
    expect(quotaPlan({ policy: policy(), stop: quota(NOW + 2 * HOUR), now: NOW })).toMatchObject({ action: "wait", until: NOW + 2 * HOUR + RESET_GRACE_MS, resetKnown: true })
  })

  test("a reset beyond max_wait_minutes stops instead of waiting longer than allowed", () => {
    const plan = quotaPlan({ policy: policy({ maxWaitMinutes: 60 }), stop: quota(NOW + 3 * HOUR), now: NOW })
    expect(plan.action).toBe("stop")
    expect(plan.reason).toContain("beyond budget.max_wait_minutes (60 minutes)")
  })

  test("waits already made count against max_wait_minutes", () => {
    expect(quotaPlan({ policy: policy({ maxWaitMinutes: 120 }), stop: quota(NOW + HOUR), now: NOW, waitedMs: 90 * MINUTE }).action).toBe("stop")
    expect(quotaPlan({ policy: policy({ maxWaitMinutes: 120 }), stop: quota(), now: NOW, waitedMs: 120 * MINUTE }).action).toBe("stop")
  })

  test("on_quota stop stops at once", () => {
    const plan = quotaPlan({ policy: policy({ onQuota: "stop" }), stop: quota(NOW + MINUTE), now: NOW })
    expect(plan).toEqual({ action: "stop", reason: "budget.on_quota is stop" })
  })

  test("an unknown reset backs off along the schedule, says it is unknown, and the total stays within max_wait_minutes", () => {
    const capped = policy({ maxWaitMinutes: 100 })
    let waited = 0
    const untils: number[] = []
    for (let waits = 0; waits < 20; waits++) {
      const plan = quotaPlan({ policy: capped, stop: quota(), now: NOW + waited, waits, waitedMs: waited })
      if (plan.action === "stop") break
      expect(plan.resetKnown).toBe(false)
      expect(plan.reason).toContain("unknown")
      untils.push(plan.until - (NOW + waited))
      waited += plan.until - (NOW + waited)
    }
    expect(untils.slice(0, 3)).toEqual(UNKNOWN_RESET_BACKOFF_MINUTES.slice(0, 3).map((minutes) => minutes * MINUTE))
    expect(waited).toBe(100 * MINUTE)
  })

  test("a rate limit backs off even with on_quota stop, and stops after the last backoff", () => {
    const stop: PrStopReason = { kind: "rate_limit", detail: "429 Too Many Requests", resumable: true }
    expect(quotaPlan({ policy: policy({ onQuota: "stop" }), stop, now: NOW })).toMatchObject({ action: "wait", until: NOW + MINUTE })
    expect(quotaPlan({ policy: policy(), stop, now: NOW, waits: MAX_RATE_LIMIT_WAITS }).action).toBe("stop")
  })

  test("a budget, error or loop stop is never waited for", () => {
    for (const kind of ["budget", "error", "no_progress", "max_rounds"] as const) expect(quotaPlan({ policy: policy(), stop: { kind, detail: "x", resumable: true }, now: NOW }).action).toBe("stop")
  })

  test("no plan offers another model, provider or paid usage: the only actions are wait and stop", () => {
    const plans = [quota(), quota(NOW + HOUR), quota(NOW + 99 * HOUR)].flatMap((stop) => [policy(), policy({ onQuota: "stop" })].map((p) => quotaPlan({ policy: p, stop, now: NOW })))
    for (const plan of plans) {
      expect(["wait", "stop"]).toContain(plan.action)
      expect(Object.keys(plan).toSorted()).toEqual(plan.action === "wait" ? ["action", "reason", "resetKnown", "until"] : ["action", "reason"])
    }
  })
})

describe("stopText", () => {
  test("a budget stop names the unit, used, limit, cached part, what remains and how to continue", () => {
    const check = checkBudget(policy(), { input: 1_200_000, output: 50_000, cached: 250_000 }, { remaining: "2 candidates not verified" })
    if (check.ok) throw new Error("expected a stop")
    expect(stopText(check.stop, { now: NOW, jobId: "job_7", tokens: { input: 1_200_000, output: 50_000, cached: 250_000 } })).toBe([
      "Stopped at MendCode's token budget for this pull request head (budget.tokens_per_pr), not at a provider limit.",
      "Used: 1,000,000 tokens (measured) of 1,000,000 tokens; counted is input not served from the provider's cache plus output; 250,000 cached input tokens were read and are not counted.",
      "Remaining: 2 candidates not verified.",
      "The job is checkpointed: what it found so far is kept, and nothing unfinished is published as a complete review.",
      "To continue: raise budget.tokens_per_pr in .mendcode/review.yaml, or set it to null for no internal limit, then retry it from /reviews (r on job job_7) or comment @mendcode review on the PR.",
    ].join("\n"))
  })

  test("unreported calls turn the figure into an at-least", () => {
    expect(stopText({ kind: "budget", detail: "x", unit: "tokens", used: 20_000, limit: 10_000, resumable: true }, { tokens: { input: 20_000, output: 0, unreported: 1 } })).toContain("at least 20,000 tokens (1 call reported no usage; the rest is unknown)")
  })

  test("a quota stop says quota left is unknown, when it resets, and that no paid fallback is used", () => {
    const text = stopText({ kind: "quota", detail: "5-hour limit reached", resumable: true, resetsAt: NOW + 3 * HOUR + 12 * MINUTE }, { now: NOW, jobId: "job_1" })
    expect(text).toContain("the account's real quota, not MendCode's budget")
    expect(text).toContain("Quota left: unknown (the provider did not report it); resets 2026-10-30 15:12 UTC (in 3h 12m).")
    expect(text).toContain("Remaining: not recorded.")
    expect(text).toContain("MendCode does not switch to an API key or extra paid usage.")
    expect(text).toContain("or retry it from /reviews (r on job job_1) or comment @mendcode review on the PR after it.")
    expect(text).not.toContain("job-retry")
  })

  test("a quota stop without a reset time says the reset is unknown; a percent figure is shown as quota left", () => {
    expect(stopText({ kind: "quota", detail: "usage limit reached", resumable: true }, { now: NOW })).toContain("reset time unknown (the provider did not say)")
    expect(stopText({ kind: "quota", detail: "weekly limit", unit: "percent", used: 100, resumable: true }, { now: NOW })).toContain("Quota left: 0% (100% used)")
  })

  test("a loop stop with no limit says no internal limit", () => {
    const text = stopText({ kind: "no_progress", detail: "two rounds left the same findings open", unit: "rounds", used: 2, resumable: false })
    expect(text).toContain("Used: 2 rounds (measured) of no internal limit.")
    expect(text).toContain("The job cannot continue from where it stopped.")
  })
})

describe("scaledBudget", () => {
  const budget = (tokens_per_pr: number | null, tokens_per_diff_token = 8) => ({ tokens_per_pr, tokens_per_diff_token })
  test("the cap grows with the diff from a base, never above the configured ceiling, and is off without a ceiling", () => {
    expect(scaledBudget(budget(1_000_000), 1_000)).toBe(158_000)
    expect(scaledBudget(budget(1_000_000), 130_000)).toBe(1_000_000)
    expect(scaledBudget(budget(100_000), 1_000)).toBe(100_000)
    expect(scaledBudget(budget(5_000), 0)).toBe(5_000)
    expect(scaledBudget(budget(null), 1_000)).toBeUndefined()
    expect(scaledBudget(budget(1_000_000, 0), 1_000)).toBe(1_000_000)
  })
})
