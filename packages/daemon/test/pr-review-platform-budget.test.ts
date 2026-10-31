import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PrFinding } from "@mendcode/protocol"
import { accountingFile, createAccounting } from "../src/pr-review/accounting"
import { budgetPolicy, checkBudget, classifyStop, failureStop, MAX_RATE_LIMIT_WAITS, quotaPlan, stopText } from "../src/pr-review/budget"
import { parseReviewConfig } from "../src/pr-review/config"
import { findingId } from "../src/pr-review/findings"
import { createJobLedger, toSummary } from "../src/pr-review/jobs"

/**
 * Platform scenarios for budgets and quotas (docs/pr-review.md, "Budgets, quotas and accounting"): the repository's YAML parsed
 * as the daemon parses it, the budget check, the persistent accounting and the job ledger's checkpoint, across a daemon restart.
 * The model calls are simulated by their usage reports; no provider is called.
 */

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mc-platform-budget-"))); temps.push(dir); return dir }

const HEAD = "a".repeat(40), BASE = "b".repeat(40)
const candidate = (line: number, summary: string) => PrFinding.parse({ id: findingId({ path: "src/a.ts", line, category: "correctness", summary }), path: "src/a.ts", line, side: "RIGHT", severity: "major", category: "correctness", summary, detail: "d", evidence: [`src/a.ts:${line}`] })
const config = (yaml: string) => { const parsed = parseReviewConfig(yaml); expect(parsed.problem).toBeUndefined(); return parsed.config }
const key = { repo: "acme/app", number: 12, head: HEAD, reviewer: "global" }

describe("platform budget: a capped review checkpoints with its candidates and resumes", () => {
  test("at the cap the job stops resumably in tokens, keeps its five candidates across a restart, and resumes to done once the cap is lifted; accounting spans both attempts", () => {
    const dir = temp()
    let clock = 1_000
    const jobsFile = path.join(dir, "pr-review", "jobs.json")
    const capped = budgetPolicy(config("budget: { tokens_per_pr: 100000 }\n"))
    expect(capped.tokensPerPr).toBe(100_000)

    const jobs = createJobLedger({ file: jobsFile, now: () => clock })
    const accounting = createAccounting({ file: accountingFile(dir), now: () => clock })
    const job = jobs.upsert({ provider: "github", repo: "acme/app", directory: "/tmp/acme", number: 12, sessionId: "s1", reviewer: "global", scope: "global", trigger: "opened", coverage: "full", base: BASE, head: HEAD, configKey: "cfg1" })
    jobs.transition(job.id, "running")
    // The review pass: 90k input of which 40k came from the provider's cache, 10k output → 60k counted.
    accounting.record({ ...key, jobId: job.id, purpose: "review", attempt: 1, input: 90_000, output: 10_000, cached: 40_000 })
    const candidates = [1, 2, 3, 4, 5].map((line) => candidate(line, `problem ${line}`))
    jobs.checkpoint(job.id, { phase: "corroboration", completedPhases: ["discovery", "analysis"], candidates })
    expect(checkBudget(capped, accounting.totals(key)!.tokens)).toEqual({ ok: true, remaining: 40_000 })
    // The verifier's first turn: 45k counted more → 105k, over the cap.
    accounting.record({ ...key, jobId: job.id, purpose: "verify", attempt: 1, input: 40_000, output: 5_000, sessionId: "verify-child", parentSessionId: "s1" })
    const check = checkBudget(capped, accounting.totals(key)!.tokens, { remaining: "5 candidates not verified" })
    if (check.ok) throw new Error("the cap must stop the job")
    expect(check.stop).toMatchObject({ kind: "budget", unit: "tokens", used: 105_000, limit: 100_000, resumable: true, remaining: "5 candidates not verified" })
    expect(check.stop.detail).toContain("40,000 cached input tokens are not counted")
    const stopped = jobs.transition(job.id, "checkpointed", { stop: check.stop })
    expect(toSummary(stopped)).toMatchObject({ state: "checkpointed", phase: "corroboration", findings: { candidates: 5, confirmed: 0 }, stop: { kind: "budget", resumable: true } })
    // What the user reads: MendCode's budget, not the provider; the figures; what remains; how to continue.
    const text = stopText(check.stop, { jobId: job.id, tokens: accounting.totals(key)!.tokens })
    expect(text).toContain("not at a provider limit")
    expect(text).toContain("105,000 tokens (measured) of 100,000 tokens")
    expect(text).toContain("Remaining: 5 candidates not verified.")
    expect(text).toContain("nothing unfinished is published as a complete review")
    expect(text).toContain("set it to null for no internal limit")

    // Restart: a checkpointed job is not in flight, so it is not recovered as interrupted; its work is all there.
    clock = 50_000
    const restarted = createJobLedger({ file: jobsFile, now: () => clock })
    expect(restarted.recover()).toEqual([])
    const kept = restarted.get(job.id)!
    expect(kept.state).toBe("checkpointed")
    expect(kept.checkpoint.candidates.map((item) => item.id)).toEqual(candidates.map((item) => item.id))
    expect(kept.checkpoint.completedPhases).toEqual(["discovery", "analysis"])

    // The maintainer sets `tokens_per_pr: null` and retries: no internal cap, the verify resumes on the kept candidates.
    const unlimited = budgetPolicy(config("budget: { tokens_per_pr: null }\n"))
    expect(unlimited.tokensPerPr).toBeUndefined()
    restarted.transition(job.id, "pending", { attempts: kept.attempts + 1, stop: undefined })
    restarted.transition(job.id, "running")
    const later = createAccounting({ file: accountingFile(dir), now: () => clock })
    later.record({ ...key, jobId: job.id, purpose: "resume", attempt: 2, input: 30_000, output: 3_000, sessionId: "verify-child-2", parentSessionId: "s1" })
    expect(checkBudget(unlimited, later.totals(key)!.tokens)).toEqual({ ok: true })
    const verified = candidates.map((item, index) => ({ ...item, verdict: index < 2 ? "confirmed" as const : "rejected" as const }))
    restarted.checkpoint(job.id, { verified, candidates: [], completedPhases: ["discovery", "analysis", "corroboration"] })
    restarted.transition(job.id, "validating")
    const done = restarted.transition(job.id, "done")
    expect(toSummary(done)).toMatchObject({ state: "done", attempts: 1, findings: { confirmed: 2, candidates: 0 } })
    const totals = later.totals(key)!
    expect(totals).toMatchObject({ calls: 3, attempts: 2, counted: 138_000, tokens: { input: 160_000, output: 18_000, cached: 40_000, unreported: 0 } })
    expect(Object.keys(totals.byPurpose).sort()).toEqual(["resume", "review", "verify"])
  })
  test("no internal cap never stops a job, whatever it spends, and the context per call is a window, not the PR total", () => {
    const unlimited = budgetPolicy(config("budget: { tokens_per_pr: null }\n"), { contextWindow: 1_000_000 })
    expect(checkBudget(unlimited, { input: 50_000_000, output: 2_000_000 })).toEqual({ ok: true })
    expect(unlimited.contextTokens).toBe(750_000)
    // With a cap below the window, one call cannot carry more than the whole cap.
    expect(budgetPolicy(config("budget: { tokens_per_pr: 120000 }\n"), { contextWindow: 1_000_000 }).contextTokens).toBe(120_000)
    // The default is a high cap, not 200k or 600k.
    expect(budgetPolicy(config("")).tokensPerPr).toBe(1_000_000)
  })
})

describe("platform budget: a real quota or rate limit waits or stops, never switches to paid usage", () => {
  const now = Date.UTC(2026, 9, 30, 12, 0, 0)
  test("a subscription quota with a named reset waits for it under on_quota: wait, stops under on_quota: stop, and no plan has a third action", () => {
    const reset = Math.floor(now / 1000) + 2 * 3600
    const stop = failureStop(`[PR_REVIEW]: the review turn failed: Claude AI usage limit reached|${reset}`, { now, remaining: "verify 5 candidates" })
    expect(stop).toMatchObject({ kind: "quota", resumable: true, resetsAt: reset * 1000, remaining: "verify 5 candidates" })
    const waiting = quotaPlan({ policy: budgetPolicy(config("")), stop, now })
    expect(waiting).toMatchObject({ action: "wait", resetKnown: true, until: reset * 1000 + 3_000 })
    expect(quotaPlan({ policy: budgetPolicy(config("budget: { on_quota: stop }\n")), stop, now })).toEqual({ action: "stop", reason: "budget.on_quota is stop" })
    // A reset beyond max_wait_minutes stops instead of waiting forever.
    expect(quotaPlan({ policy: budgetPolicy(config("budget: { max_wait_minutes: 60 }\n")), stop, now }).action).toBe("stop")
    expect(stopText(stop, { now })).toContain("the account's real quota, not MendCode's budget")
  })
  test("a quota without a reset time says the reset is unknown; a rate limit backs off a bounded number of times and is told apart from a quota", () => {
    const unknown = failureStop("You've hit your usage limit", { now })
    expect(unknown.resetsAt).toBeUndefined()
    const plan = quotaPlan({ policy: budgetPolicy(config("")), stop: unknown, now })
    expect(plan.action).toBe("wait")
    expect(plan.reason).toContain("(unknown)")
    expect(classifyStop("exceeded retry limit, last status: 429 Too Many Requests").kind).toBe("rate_limit")
    expect(classifyStop("insufficient_quota: 429").kind).toBe("quota")
    const rate = failureStop("HTTP 429 Too Many Requests", { now })
    const actions = Array.from({ length: MAX_RATE_LIMIT_WAITS + 1 }, (_, waits) => quotaPlan({ policy: budgetPolicy(config("")), stop: rate, now, waits }).action)
    expect(actions).toEqual([...Array(MAX_RATE_LIMIT_WAITS).fill("wait"), "stop"])
    for (const action of actions) expect(["wait", "stop"]).toContain(action)
    // An ordinary error is not waited for.
    expect(quotaPlan({ policy: budgetPolicy(config("")), stop: failureStop("socket hang up", { now }), now }).action).toBe("stop")
  })
})
