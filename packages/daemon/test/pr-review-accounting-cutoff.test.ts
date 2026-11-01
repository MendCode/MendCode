import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PrTokenUsage, SessionEvent, SessionId } from "@mendcode/protocol"
import { accountingFile, createAccounting } from "../src/pr-review/accounting"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { createJobLedger } from "../src/pr-review/jobs"
import { meteredSessions } from "../src/pr-review/run"
import { createPrReviewService } from "../src/pr-review/service"
import { createReviewSessions, ReviewTurnError } from "../src/pr-review/sessions"

/**
 * The model spend of review calls that did not end normally (seen live in C5, PR #4: a daemon SIGKILLed mid-review left no trace
 * of the killed attempt's calls). A call that fails or is stopped keeps what the provider reported before it ended and counts as
 * one call without a report; a call a killed daemon never saw end is accounted at the next start as unknown (`unreported`), plus
 * what its child session recorded beyond what was already counted for it. Nothing is estimated. Temp files and fake children only.
 */

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mc-cutoff-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const KEY = { repo: "acme/api", number: 4, head: "a".repeat(40), reviewer: "global" }

describe("a call a killed daemon never saw end", () => {
  test("it stays on disk while it runs; the next start accounts it as one unknown call of its attempt, once", () => {
    const file = accountingFile(temp())
    const first = createAccounting({ file })
    first.record({ ...KEY, jobId: "job_1", purpose: "review", attempt: 1, input: 1_000, output: 100 })
    first.begin({ ...KEY, jobId: "job_1", purpose: "verify", attempt: 1 })
    expect(JSON.parse(readFileSync(file, "utf8")).open).toHaveLength(1)
    // SIGKILL: no end(). The next process finds it.
    const second = createAccounting({ file })
    expect(second.cutOff().map((call) => [call.jobId, call.purpose, call.attempt])).toEqual([["job_1", "verify", 1]])
    expect(second.settleCutOff()).toEqual([{ jobId: "job_1", tokens: { input: 0, output: 0, unreported: 1 } }])
    expect(second.totals(KEY)).toMatchObject({ calls: 2, tokens: { input: 1_000, output: 100, unreported: 1 } })
    expect(second.entries(KEY).at(-1)).toMatchObject({ purpose: "verify", attempt: 1, input: 0, output: 0, unreported: 1 })
    // Settled once: a third start finds nothing left.
    expect(createAccounting({ file }).cutOff()).toEqual([])
    expect(JSON.parse(readFileSync(file, "utf8")).open).toEqual([])
  })

  test("a call that ended normally leaves nothing to settle", () => {
    const file = accountingFile(temp())
    const first = createAccounting({ file })
    const id = first.begin({ ...KEY, jobId: "job_1", purpose: "review", attempt: 1, sessionId: "ses_child" })
    first.record({ ...KEY, jobId: "job_1", purpose: "review", attempt: 1, input: 500, output: 50, sessionId: "ses_child" })
    first.end(id)
    expect(createAccounting({ file }).cutOff()).toEqual([])
  })

  test("what the child session recorded beyond the calls already counted for it is kept; the rest stays unknown", () => {
    const file = accountingFile(temp())
    const first = createAccounting({ file })
    // The child's first turn was accounted; its second turn was cut off after one model call the engine reported.
    first.record({ ...KEY, jobId: "job_1", purpose: "review", attempt: 1, input: 1_000, output: 100, cached: 400, sessionId: "ses_child" })
    first.begin({ ...KEY, jobId: "job_1", purpose: "review", attempt: 1, sessionId: "ses_child" })
    const second = createAccounting({ file })
    const stored: Record<string, PrTokenUsage> = { ses_child: { input: 1_600, output: 130, cached: 900 } }
    expect(second.settleCutOff((sessionId) => stored[sessionId])).toEqual([{ jobId: "job_1", tokens: { input: 600, output: 30, cached: 500, unreported: 1 } }])
    expect(second.totals(KEY)?.tokens).toEqual({ input: 1_600, output: 130, cached: 900, unreported: 1 })
  })

  test("a child session that recorded nothing more adds no tokens: never a guess", () => {
    const file = accountingFile(temp())
    const first = createAccounting({ file })
    first.record({ ...KEY, jobId: "job_1", purpose: "review", attempt: 1, input: 1_000, output: 100, sessionId: "ses_child" })
    first.begin({ ...KEY, jobId: "job_1", purpose: "review", attempt: 1, sessionId: "ses_child" })
    const second = createAccounting({ file })
    expect(second.settleCutOff(() => ({ input: 1_000, output: 100 }))).toEqual([{ jobId: "job_1", tokens: { input: 0, output: 0, unreported: 1 } }])
  })
})

describe("the service at start", () => {
  test("a call the previous daemon left open is accounted on its job, with what its child session recorded", () => {
    const dir = temp()
    const ledger = createJobLedger({ file: path.join(dir, "pr-review", "jobs.json") })
    const job = ledger.upsert({ provider: "github", repo: KEY.repo, directory: "/repo", number: KEY.number, sessionId: "ses_owner", reviewer: "global", scope: "global", trigger: "opened", coverage: "full", base: "b".repeat(40), head: KEY.head, configKey: "", state: "running" })
    createAccounting({ file: accountingFile(dir) }).begin({ ...KEY, jobId: job.id, purpose: "review", attempt: 1, sessionId: "ses_child" })
    const service = createPrReviewService({
      dir, intervalMs: 3_600_000, enabled: () => false, graphOn: () => false, sessionDirectory: () => undefined, sessionExists: () => true, notify: () => undefined,
      sessions: () => (async () => { throw new Error("no child") }) as never, editor: () => (async () => { throw new Error("no child") }) as never, schedule: async (run) => { await run() },
      sessionUsage: (sessionId) => sessionId === "ses_child" ? { input: 4_000, output: 200, cached: 1_000 } : undefined,
    })
    cleanups.push(() => service.stop())
    expect(service.platform.accounting.totals(KEY)).toMatchObject({ calls: 1, tokens: { input: 4_000, output: 200, cached: 1_000, unreported: 1 } })
    expect(service.platform.jobs.get(job.id)?.tokens).toEqual({ input: 4_000, output: 200, cached: 1_000, unreported: 1 })
  })
})

describe("a call that failed or was stopped", () => {
  test("meteredSessions accounts what the provider reported before the failure, and the call as one without a full report", async () => {
    const accounted: Array<{ purpose: string; tokens: PrTokenUsage; sessionId?: string | undefined }> = []
    const calls: Array<{ purpose: string; sessionId?: string | undefined; ended: boolean }> = []
    const factory: ReviewSessionFactory = async () => ({
      id: "ses_child",
      async send() { const error = new ReviewTurnError("[PR_REVIEW]: the review turn stopped", "error"); error.spent = { input: 300, output: 20, cached: 100 }; throw error },
      async close() {},
    }) as never
    const metered = meteredSessions({
      factory, account: (entry) => accounted.push(entry), resuming: false, failures: [],
      calling: (call) => { const entry = { ...call, ended: false }; calls.push(entry); return () => { entry.ended = true } },
    })
    const session = await metered({ purpose: "review" })
    await expect(session.send("review")).rejects.toThrow("the review turn stopped")
    expect(accounted).toEqual([{ purpose: "review", tokens: { input: 300, output: 20, cached: 100, unreported: 1 }, sessionId: "ses_child" }])
    expect(calls).toEqual([{ purpose: "review", sessionId: "ses_child", ended: true }])
  })

  test("a failure with no report before it stays a call of unknown spend", async () => {
    const accounted: PrTokenUsage[] = []
    const factory: ReviewSessionFactory = async () => ({ async send() { throw new Error("child exited") }, async close() {} })
    const session = await meteredSessions({ factory, account: (entry) => accounted.push(entry.tokens), resuming: false, failures: [] })({ purpose: "verify" })
    await expect(session.send("verify")).rejects.toThrow("child exited")
    expect(accounted).toEqual([{ input: 0, output: 0, unreported: 1 }])
  })

  test("the review sessions carry the usage a turn reported before it failed or was cancelled", async () => {
    let next = 0
    const script: Array<Record<string, unknown>> = [
      { type: "usage.recorded", provider: "claude", model: "opus", input: 200, output: 30, reasoning: 0, cacheRead: 50, cacheWrite: 10, partial: true },
      { type: "turn.cancelled" },
    ]
    const sessions = createReviewSessions({
      create: () => `ses_${++next}` as SessionId,
      submit: async (id) => { let seq = 0; queueMicrotask(() => { for (const event of script) sessions.observe({ sessionId: id, seq: ++seq, at: Date.now(), turnId: "turn_1", ...event } as unknown as SessionEvent) }) },
      deny: () => {}, cancel: async () => {}, remove: () => {},
    })
    const child = await sessions.factory({ directory: "/x" })({ purpose: "review" })
    const error = await child.send("review").catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ReviewTurnError)
    expect((error as ReviewTurnError).spent).toEqual({ input: 260, output: 30, cached: 50 })
    // Without any usage event the error carries none.
    script.splice(0, 1)
    const again = await (await sessions.factory({ directory: "/x" })({ purpose: "review" })).send("review").catch((caught: unknown) => caught)
    expect((again as ReviewTurnError).spent).toBeUndefined()
  })
})
