import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PrJobSummary } from "@mendcode/protocol"
import type { ReviewJob } from "../src/pr-review/contracts"
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, createJobLedger, nextAttemptAt, toSummary } from "../src/pr-review/jobs"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pr-review-jobs-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const sha = (n: number) => n.toString(16).padStart(40, "0")

function ledger({ dir = temp(), clock = { now: 1_000 }, retainTerminal, maxActive }: { dir?: string; clock?: { now: number }; retainTerminal?: number; maxActive?: number } = {}) {
  const file = path.join(dir, "pr-review", "jobs.json")
  const jobs = createJobLedger({ file, now: () => clock.now, ...(retainTerminal === undefined ? {} : { retainTerminal }), ...(maxActive === undefined ? {} : { maxActive }) })
  return { jobs, file, dir, clock }
}
const input = (number: number, head = sha(number)) => ({ provider: "github" as const, repo: "acme/app", directory: "/repo", number, sessionId: "ses_a", reviewer: "global", scope: "global" as const, trigger: "opened" as const, coverage: "full" as const, base: sha(1000), head, configKey: "cfg1" })

describe("job ledger", () => {
  test("forget removes a finished pull request with its earlier runs, refuses while one of its jobs is open, and keeps other PRs", () => {
    const { jobs, file } = ledger()
    const first = jobs.upsert(input(12)); jobs.transition(first.id, "running"); jobs.transition(first.id, "failed")
    const second = jobs.upsert(input(12, sha(99))); jobs.transition(second.id, "cancelled")
    const other = jobs.upsert(input(13))
    expect(jobs.forget!(second.id)).toBe(2)
    expect(jobs.list({ number: 12 })).toEqual([])
    expect(jobs.get(other.id)).toBeDefined()
    expect(createJobLedger({ file }).list({ number: 12 })).toEqual([])
    const done = jobs.upsert(input(14)); jobs.transition(done.id, "running"); jobs.transition(done.id, "done")
    jobs.upsert(input(14, sha(77)))
    expect(() => jobs.forget!(done.id)).toThrow("still has a pending job")
  })
  test("upsert returns the open job of the same reviewer, repo, PR, head, base and config instead of a second one; a finished one does not block a new job", () => {
    const { jobs } = ledger()
    const first = jobs.upsert(input(12))
    expect(jobs.upsert(input(12)).id).toBe(first.id)
    expect(jobs.upsert({ ...input(12), configKey: "cfg2" }).id).not.toBe(first.id)
    expect(jobs.upsert(input(12, sha(13))).id).not.toBe(first.id)
    jobs.transition(first.id, "running")
    jobs.transition(first.id, "done")
    const again = jobs.upsert(input(12))
    expect(again.id).not.toBe(first.id)
    expect(again).toMatchObject({ state: "pending", attempts: 0, checkpoint: { candidates: [], verified: [] }, tokens: { input: 0, output: 0 } })
  })

  test("transition refuses a move JOB_TRANSITIONS does not list with a RangeError; the same state applies only the patch", () => {
    const { jobs } = ledger()
    const job = jobs.upsert(input(1))
    expect(() => jobs.transition(job.id, "done")).toThrow(RangeError)
    expect(() => jobs.transition(job.id, "fixing")).toThrow("cannot go from pending to fixing")
    expect(() => jobs.transition("prj_missing", "running")).toThrow(RangeError)
    jobs.transition(job.id, "running")
    const marked = jobs.transition(job.id, "running", { stop: { kind: "superseded", detail: "head moved", resumable: false } })
    expect(marked).toMatchObject({ state: "running", stop: { kind: "superseded" } })
    // An invalid patch never reaches the file.
    expect(() => jobs.transition(job.id, "running", { head: "x".repeat(65) })).toThrow(RangeError)
    expect(jobs.get(job.id)!.head).toBe(sha(1))
  })

  test("a restart finds every job: running, fixing and validating ones come back pending with the attempt counted and the trigger kept", () => {
    const first = ledger()
    const running = first.jobs.upsert({ ...input(1), trigger: "requested" })
    const fixing = first.jobs.upsert(input(2))
    const waiting = first.jobs.upsert(input(3))
    const done = first.jobs.upsert(input(4))
    first.jobs.transition(running.id, "running")
    first.jobs.transition(fixing.id, "running")
    first.jobs.transition(fixing.id, "fixing")
    first.jobs.transition(waiting.id, "waiting", { notBefore: 5_000 })
    first.jobs.transition(done.id, "running")
    first.jobs.transition(done.id, "done")
    first.jobs.checkpoint(running.id, { phase: "analysis", completedPhases: ["discovery"] })
    const second = ledger({ dir: first.dir, clock: first.clock })
    const recovered = second.jobs.recover()
    expect(recovered.map((job) => [job.number, job.state, job.attempts, job.trigger])).toEqual([[1, "pending", 1, "requested"], [2, "pending", 1, "opened"]])
    expect(second.jobs.get(running.id)!.checkpoint).toMatchObject({ phase: "analysis", completedPhases: ["discovery"] })
    expect(second.jobs.get(waiting.id)!.state).toBe("waiting")
    expect(second.jobs.get(done.id)!.state).toBe("done")
    // Recovering twice changes nothing more.
    expect(second.jobs.recover()).toEqual([])
  })

  test("due lists pending jobs and waiting jobs whose notBefore passed, oldest first; a waiting job without a time is held", () => {
    const { jobs, clock } = ledger()
    const a = jobs.upsert(input(1))
    clock.now += 1
    const b = jobs.upsert(input(2))
    clock.now += 1
    const c = jobs.upsert(input(3))
    const d = jobs.upsert(input(4))
    jobs.transition(a.id, "waiting", { notBefore: clock.now + 100 })
    jobs.transition(d.id, "waiting")
    expect(jobs.due(clock.now).map((job) => job.id)).toEqual([b.id, c.id])
    expect(jobs.due(clock.now + 100).map((job) => job.id)).toEqual([a.id, b.id, c.id])
  })

  test("the file is written atomically with mode 0600 in a 0700 directory, and tokens add up across attempts", () => {
    const { jobs, file } = ledger()
    const job = jobs.upsert(input(1))
    jobs.addTokens(job.id, { input: 100, output: 10 })
    jobs.addTokens(job.id, { input: 50, output: 5, cached: 20, unreported: 1 })
    expect(jobs.get(job.id)!.tokens).toEqual({ input: 150, output: 15, cached: 20, unreported: 1 })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, jobs: [{ id: job.id, tokens: { input: 150 } }] })
  })

  test("bounded: the newest finished jobs are kept, open ones never dropped, and one open job beyond maxActive is refused", () => {
    const { jobs, clock, dir } = ledger({ retainTerminal: 3, maxActive: 4 })
    const open = jobs.upsert(input(100))
    for (let number = 1; number <= 6; number++) {
      clock.now += 1
      const job = jobs.upsert(input(number))
      jobs.transition(job.id, "cancelled")
    }
    expect(jobs.all().map((job) => job.number)).toEqual([100, 4, 5, 6])
    expect(ledger({ dir, clock }).jobs.all()).toHaveLength(4)
    for (const number of [7, 8, 9]) jobs.upsert(input(number))
    expect(() => jobs.upsert(input(10))).toThrow("holds 4 open jobs")
    expect(jobs.get(open.id)!.state).toBe("pending")
  })

  test("a damaged file is kept aside and the ledger starts empty; a file with one bad job keeps the others and a copy", () => {
    const { file, dir, clock } = ledger()
    const first = createJobLedger({ file, now: () => clock.now })
    first.upsert(input(1))
    writeFileSync(file, "{ not json")
    const broken = ledger({ dir, clock })
    expect(broken.jobs.all()).toEqual([])
    expect(existsSync(`${file}.corrupt-${clock.now}`)).toBe(true)
    expect(existsSync(file)).toBe(false)
    const good = broken.jobs.upsert(input(2))
    const saved = JSON.parse(readFileSync(file, "utf8"))
    saved.jobs.push({ id: "prj_bad", state: "exploded" })
    writeFileSync(file, JSON.stringify(saved))
    clock.now += 1
    const partial = ledger({ dir, clock })
    expect(partial.jobs.all().map((job) => job.id)).toEqual([good.id])
    expect(existsSync(`${file}.corrupt-${clock.now}`)).toBe(true)
  })

  test("toSummary is a valid PrJobSummary: counts instead of findings, the review session as sessionId, long text clipped", () => {
    const { jobs } = ledger()
    const job = jobs.upsert({ ...input(7), repo: `acme/${"r".repeat(300)}`, title: "Fix it" })
    const finding = (n: number, verdict?: "confirmed" | "plausible" | "rejected") => ({ id: sha(n), path: "a.ts", line: n, side: "RIGHT" as const, severity: "major" as const, category: "correctness" as const, summary: "s", detail: "d", evidence: [], ...(verdict ? { verdict } : {}) })
    jobs.checkpoint(job.id, { phase: "corroboration", candidates: [finding(1)], verified: [finding(2, "confirmed"), finding(3, "plausible"), finding(4, "rejected")] })
    const failed: ReviewJob = { ...jobs.transition(job.id, "running", { reviewSessionId: "ses_child", error: "e".repeat(2000) }) }
    const summary = toSummary(failed)
    expect(PrJobSummary.safeParse(summary).success).toBe(true)
    expect(summary).toMatchObject({ id: job.id, number: 7, state: "running", phase: "corroboration", sessionId: "ses_child", title: "Fix it", findings: { confirmed: 1, plausible: 1, candidates: 1, resolved: 0 } })
    expect(summary.repo).toHaveLength(200)
    expect(summary.error).toHaveLength(600)
  })
})

describe("retry backoff", () => {
  test("full jitter: each retry waits a uniform delay below min(30 min, 30 s doubled per attempt)", () => {
    expect(nextAttemptAt(1, 1_000, () => 0)).toBe(1_000)
    expect(nextAttemptAt(1, 1_000, () => 0.5)).toBe(1_000 + BACKOFF_BASE_MS / 2)
    expect(nextAttemptAt(3, 0, () => 0.999_999)).toBeLessThan(4 * BACKOFF_BASE_MS)
    expect(nextAttemptAt(3, 0, () => 0.999_999)).toBeGreaterThan(4 * BACKOFF_BASE_MS - 1_000)
    // Large attempt counts stay at the cap; a random() of exactly 1 never reaches it.
    expect(nextAttemptAt(50, 0, () => 1)).toBeLessThan(BACKOFF_CAP_MS)
    expect(nextAttemptAt(50, 0, () => 0.5)).toBe(BACKOFF_CAP_MS / 2)
    // Attempt 0 or negative is the first retry.
    expect(nextAttemptAt(0, 0, () => 0.5)).toBe(BACKOFF_BASE_MS / 2)
    for (let attempts = 1; attempts <= 12; attempts++) for (let i = 0; i < 50; i++) {
      const delay = nextAttemptAt(attempts, 0)
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThan(Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1)))
    }
  })
})
