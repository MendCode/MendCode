import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PrFinding, type PrReviewResult } from "@mendcode/protocol"
import type { ReviewJob } from "../src/pr-review/contracts"
import { createEffectLedger } from "../src/pr-review/effects"
import { findingId } from "../src/pr-review/findings"
import { createJobLedger, toSummary } from "../src/pr-review/jobs"
import { publishReview, type GhCall } from "../src/pr-review/publish"
import { emptyState } from "../src/pr-review/state"

/**
 * Platform scenarios for restarts and remote effects (docs/pr-review.md, "Jobs, restarts and remote effects"): the job ledger and
 * the effects ledger on a temp data directory, the real idempotent publish, and a fake GitHub that keeps the reviews it accepted
 * (so a "crash" after the POST leaves the review on the PR). A "restart" is a new ledger instance on the same files. No network.
 */

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mc-platform-recovery-"))); temps.push(dir); return dir }

const HEAD = "a".repeat(40), NEXT = "c".repeat(40), BASE = "b".repeat(40)
const bug = PrFinding.parse({ id: findingId({ path: "src/math.ts", line: 3, category: "correctness", summary: "The loop skips the first value" }), path: "src/math.ts", line: 3, side: "RIGHT", severity: "major", category: "correctness", summary: "The loop skips the first value", detail: "Starting at 1 drops values[0].", evidence: ["src/math.ts:3"], verdict: "confirmed" })
const result = (head = HEAD): PrReviewResult => ({ head, base: BASE, findings: [bug], dropped: 0, summary: "Changes the sum loop.", tokens: { input: 10, output: 1 }, budgetHit: false })

/**
 * GitHub for acme/app#12. `reviews` is what is really on the PR. `mode` decides how the next POST ends: `ok`, `timeout` (applied,
 * but gh never answers), `crash` (applied, and the daemon dies before it reads the answer), or `refuse` (a 422-free 403).
 * `listing` false makes the reviews unreadable.
 */
function github() {
  const reviews: Array<{ id: number; body: string; user: { login: string }; state: string }> = []
  const world = { mode: "ok" as "ok" | "timeout" | "crash" | "refuse", listing: true, posts: 0 }
  const gh: GhCall = async ({ argv, stdin }) => {
    const endpoint = argv[1] ?? ""
    if (endpoint === "repos/acme/app/pulls/12/reviews" && argv.includes("POST")) {
      world.posts++
      if (world.mode === "refuse") return { code: 1, out: "", err: "gh: Resource not accessible by integration (HTTP 403)" }
      const id = 900 + reviews.length
      reviews.push({ id, body: JSON.parse(stdin!).body, user: { login: "nora" }, state: "COMMENTED" })
      if (world.mode === "timeout") return { code: 1, out: "", err: "Post \"https://api.github.com/...\": context deadline exceeded" }
      if (world.mode === "crash") throw new Error("daemon killed")
      return { code: 0, out: JSON.stringify({ id }) }
    }
    if (endpoint.startsWith("repos/acme/app/pulls/12/reviews?per_page=")) return world.listing ? { code: 0, out: JSON.stringify(reviews) } : { code: 1, out: "", err: "HTTP 502" }
    if (/reviews\/\d+\/comments\?per_page=/.test(endpoint)) return { code: 0, out: "[]" }
    if (argv[1] === "graphql") return { code: 0, out: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }) }
    return { code: 0, out: "[]" }
  }
  return { gh, reviews, world }
}

/** The daemon's two ledgers on one data directory; calling it again is a restart. */
const daemon = (dir: string, now = () => 1_000) => ({
  jobs: createJobLedger({ file: path.join(dir, "pr-review", "jobs.json"), now }),
  effects: createEffectLedger({ file: path.join(dir, "pr-review", "effects.json"), now }),
})
const jobInput = (head = HEAD): Omit<ReviewJob, "id" | "state" | "attempts" | "createdAt" | "updatedAt" | "checkpoint" | "tokens"> => ({
  provider: "github", repo: "acme/app", directory: "/tmp/acme", number: 12, sessionId: "s1", reviewer: "global", scope: "global", trigger: "opened", coverage: "full", base: BASE, head, configKey: "cfg1",
})
const publish = (gh: GhCall, effects: ReturnType<typeof daemon>["effects"], jobId: string, extra: { isCurrent?: () => boolean; head?: string } = {}) =>
  publishReview({ repo: "acme/app", number: 12, result: result(extra.head), previous: emptyState(), process: gh, effects, reviewer: "global", configKey: "cfg1", jobId, self: "nora", ...(extra.isCurrent ? { isCurrent: extra.isCurrent } : {}) })

describe("platform recovery: a restart between 'effect intended' and 'effect done'", () => {
  test("the daemon dies after GitHub accepted the review: after the restart the job is recovered, the review is found by its marker and nothing is posted twice", async () => {
    const dir = temp()
    const github_ = github()
    const before = daemon(dir)
    const job = before.jobs.upsert(jobInput())
    before.jobs.transition(job.id, "running")
    github_.world.mode = "crash"
    github_.world.listing = false // the crash also cut the read-back
    const first = await publish(github_.gh, before.effects, job.id)
    expect(first).toMatchObject({ posted: false, uncertain: true })
    expect(github_.reviews).toHaveLength(1)
    expect(before.effects.pending()).toHaveLength(1)
    expect(statSync(path.join(dir, "pr-review", "effects.json")).mode & 0o777).toBe(0o600)

    // Restart: new ledgers on the same files.
    github_.world.mode = "ok"
    github_.world.listing = true
    const after = daemon(dir, () => 2_000)
    const recovered = after.jobs.recover()
    expect(recovered.map((item) => [item.id, item.state, item.attempts])).toEqual([[job.id, "pending", 1]])
    expect(after.effects.pending().map((effect) => effect.jobId)).toEqual([job.id])
    after.jobs.transition(job.id, "running")
    const second = await publish(github_.gh, after.effects, job.id)
    expect(second).toMatchObject({ posted: false, duplicate: true, reviewId: 900 })
    expect(github_.world.posts).toBe(1)
    expect(github_.reviews).toHaveLength(1)
    expect(after.effects.pending()).toEqual([])
    expect(after.effects.ofJob(job.id).map((effect) => [effect.state, effect.remote])).toEqual([["done", "900"]])
    expect(toSummary(after.jobs.transition(job.id, "done")).state).toBe("done")
  })
  test("a timeout after GitHub applied the POST is reconciled in the same call, and every later attempt is a duplicate", async () => {
    const dir = temp()
    const { gh, reviews, world } = github()
    const { jobs, effects } = daemon(dir)
    const job = jobs.upsert(jobInput())
    world.mode = "timeout"
    expect(await publish(gh, effects, job.id)).toMatchObject({ posted: true, reviewId: 900 })
    world.mode = "ok"
    expect(await publish(gh, effects, job.id)).toMatchObject({ posted: false, duplicate: true })
    expect(await publish(gh, daemon(dir).effects, job.id)).toMatchObject({ posted: false, duplicate: true })
    expect(world.posts).toBe(1)
    expect(reviews).toHaveLength(1)
  })
  test("an outcome that cannot be confirmed is not resent: the effect stays pending until the PR's reviews can be read", async () => {
    const dir = temp()
    const { gh, world } = github()
    const { effects } = daemon(dir)
    world.mode = "timeout"
    world.listing = false
    expect(await publish(gh, effects, "prj_x")).toMatchObject({ posted: false, uncertain: true })
    // Still unreadable on the next attempt: nothing is sent at all.
    expect(await publish(gh, effects, "prj_x")).toMatchObject({ posted: false, uncertain: true })
    expect(world.posts).toBe(1)
    world.listing = true
    expect(await publish(gh, effects, "prj_x")).toMatchObject({ duplicate: true })
    expect(world.posts).toBe(1)
  })
  test("a refused post is abandoned with its reason, not left pending, and nothing is on the PR", async () => {
    const dir = temp()
    const { gh, reviews, world } = github()
    const { effects } = daemon(dir)
    world.mode = "refuse"
    const refused = await publish(gh, effects, "prj_y")
    expect(refused.posted).toBe(false)
    expect(refused.reason).toContain("HTTP 403")
    expect(effects.pending()).toEqual([])
    expect(effects.ofJob("prj_y").map((effect) => effect.state)).toEqual(["abandoned"])
    expect(reviews).toEqual([])
  })
})

describe("platform recovery: the head moves during a review", () => {
  test("the result of the old head is stale: nothing is posted, the job is marked stale and the new head gets its own job", async () => {
    const dir = temp()
    const { gh, reviews, world } = github()
    const { jobs, effects } = daemon(dir)
    const job = jobs.upsert(jobInput())
    jobs.transition(job.id, "running")
    // The job reviewed HEAD; a push moved the PR to NEXT while it ran.
    const current: string = NEXT
    const report = await publish(gh, effects, job.id, { isCurrent: () => current === HEAD })
    expect(report).toMatchObject({ posted: false, stale: true })
    expect(world.posts).toBe(0)
    expect(reviews).toEqual([])
    expect(effects.pending()).toEqual([])
    expect(jobs.transition(job.id, "stale").state).toBe("stale")
    const next = jobs.upsert({ ...jobInput(NEXT), trigger: "synchronize" })
    expect(next.id).not.toBe(job.id)
    expect(await publish(gh, effects, next.id, { head: NEXT, isCurrent: () => current === NEXT })).toMatchObject({ posted: true })
    expect(reviews.map((review) => review.body.includes(`head=${NEXT}`))).toEqual([true])
  })
})

describe("platform recovery: duplicate and out-of-order events", () => {
  test("the same event twice is one job; a finished job never runs again by itself; an out-of-order move is refused", () => {
    const dir = temp()
    const { jobs } = daemon(dir)
    const first = jobs.upsert(jobInput())
    expect(jobs.upsert({ ...jobInput(), trigger: "synchronize" }).id).toBe(first.id)
    expect(jobs.list()).toHaveLength(1)
    jobs.transition(first.id, "running")
    jobs.transition(first.id, "done")
    // A late `opened` for the head that is done must not run it again: done → running is not a move.
    expect(() => jobs.transition(first.id, "running")).toThrow(RangeError)
    // A pending job never jumps to done without running and validating.
    const other = jobs.upsert(jobInput(NEXT))
    expect(() => jobs.transition(other.id, "done")).toThrow("cannot go from pending to done")
    // After a restart, a done job is not recovered and the pending one is due.
    const restarted = daemon(dir)
    expect(restarted.jobs.recover()).toEqual([])
    expect(restarted.jobs.due(5_000).map((job) => job.id)).toEqual([other.id])
  })
})
