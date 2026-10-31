import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { GhRun } from "../src/pr-watch"
import { createJobLedger } from "../src/pr-review/jobs"
import { createRepoWatch, MAX_QUEUE, MAX_WAITING, runnable, type ReviewAssignment, type WatchPlan } from "../src/pr-review/repo-watch"

/**
 * The run queue and the waiting records (docs/pr-review.md, "Jobs, restarts and remote effects"): `MAX_QUEUE` counts the work this
 * daemon runs itself and is a backlog mark, never a refusal or an eviction; records of work waiting for another device, a claim or a
 * quota reset are bounded by `MAX_WAITING`, oldest cancelled first with the reason. Also: a daemon start is a catch-up. The watch
 * runs over a fake `gh` and a temp data directory; nothing reaches the network.
 */

const cleanups: Array<() => unknown> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pr-queue-cap-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const sha = (n: number) => n.toString(16).padStart(40, "0")

function harness({ dir = temp(), clock = { now: 1_000_000 }, concurrency = 1, assign }: { dir?: string; clock?: { now: number }; concurrency?: number; assign?: (number: number) => ReviewAssignment[] } = {}) {
  const prs: Array<{ number: number; headRefOid: string; url: string }> = []
  const run: GhRun = async ({ argv }) => {
    if (argv[0] === "pr" && argv[1] === "list") return { code: 0, out: JSON.stringify(prs), err: "" }
    if (argv.join(" ") === "api user --jq .login") return { code: 0, out: "ana", err: "" }
    if (argv[0] === "api") return { code: 0, out: "", err: "" }
    return { code: 1, out: "", err: "unexpected" }
  }
  const notices: string[] = []
  const catchUps: boolean[] = []
  const started: number[] = []
  const plan = async ({ catchUp }: { catchUp: boolean }): Promise<WatchPlan> => {
    catchUps.push(catchUp)
    return { extra: [], decide: async (facts) => ({ ok: true, reason: "routed", assignments: assign?.(facts.number) ?? [{ reviewer: "global", scope: "global" }] }) }
  }
  const watch = createRepoWatch({
    dir, run, intervalMs: 3_600_000, now: () => clock.now, random: () => 0.5, concurrency, enabled: () => true, sessionExists: () => true,
    notify: (_session, text) => notices.push(text),
    triggers: async () => ({ opened: true, synchronize: true, ready_for_review: true, drafts: false }),
    // Every started review holds its slot: the run queue fills up behind it.
    start: async (job) => { started.push(job.number); await new Promise(() => undefined) },
    plan,
  })
  cleanups.push(() => watch.stop())
  const open = (from: number, count: number) => { for (let n = from; n < from + count; n++) prs.push({ number: n, headRefOid: sha(n), url: `https://github.com/acme/app/pull/${n}` }) }
  return { watch, prs, open, notices, catchUps, started, dir, clock }
}

/** Another daemon's personal reviewer: recorded here as waiting, never run. */
const away: ReviewAssignment = { reviewer: "alice", scope: "personal", waiting: "waiting for @alice's MendCode (offline or another device)" }

describe("what counts against the run queue", () => {
  test("pending, running and a backed-off retry are queued work; a wait for another device, a claim or a quota reset is a waiting record until its time comes", () => {
    const at = 5_000
    expect(runnable({ state: "pending" }, at)).toBe(true)
    expect(runnable({ state: "running" }, at)).toBe(true)
    expect(runnable({ state: "validating" }, at)).toBe(true)
    // A retry with backoff is this daemon's own work, even before its time.
    expect(runnable({ state: "waiting", notBefore: at + 60_000, error: "gh timed out" }, at)).toBe(true)
    // Another device's reviewer (no time), a claim held elsewhere or a quota reset (a time to come): waiting records.
    expect(runnable({ state: "waiting" }, at)).toBe(false)
    expect(runnable({ state: "waiting", notBefore: at + 60_000 }, at)).toBe(false)
    // Its time came: it runs now, so it counts as queued work.
    expect(runnable({ state: "waiting", notBefore: at - 1 }, at)).toBe(true)
    expect(runnable({ state: "checkpointed" }, at)).toBe(false)
    expect(runnable({ state: "done" }, at)).toBe(false)
  })
})

describe("the run queue (MAX_QUEUE) is a backlog mark, not a refusal", () => {
  test("past the run queue's size every new review is still recorded as pending, none is cancelled, and the session is told once an hour", async () => {
    const h = harness()
    await h.watch.watchRepo("ses_a", "/repo")
    h.open(1, MAX_QUEUE + 10)
    await h.watch.tick()
    const jobs = h.watch.jobs.list()
    expect(jobs).toHaveLength(MAX_QUEUE + 10)
    expect(jobs.filter((job) => job.state === "cancelled")).toEqual([])
    expect(jobs.filter((job) => job.state === "pending")).toHaveLength(MAX_QUEUE + 9)
    expect(h.watch.pending()).toEqual({ running: 1, queued: MAX_QUEUE + 9, waiting: 0 })
    const told = h.notices.filter((text) => text.includes(`more than its run queue of ${MAX_QUEUE}`))
    expect(told).toHaveLength(1)
    expect(told[0]).toContain("new ones are still recorded and run in order, none is dropped")
    // More work within the hour: recorded, not told again; an hour later it is told again.
    h.open(1000, 5)
    await h.watch.tick()
    expect(h.watch.jobs.list({ states: ["pending"] })).toHaveLength(MAX_QUEUE + 14)
    expect(h.notices.filter((text) => text.includes("run queue"))).toHaveLength(1)
    h.clock.now += 3_600_000
    h.open(2000, 1)
    await h.watch.tick()
    expect(h.notices.filter((text) => text.includes("run queue"))).toHaveLength(2)
    expect(h.watch.describe()).toContain(`jobs: ${MAX_QUEUE + 15} queued, 0 waiting`)
  })

  test("records waiting for another device do not count against it: sixty of them leave the run queue empty and cancel nothing", async () => {
    const h = harness({ assign: (number) => number <= 60 ? [away] : [{ reviewer: "global", scope: "global" }] })
    await h.watch.watchRepo("ses_a", "/repo")
    h.open(1, 60)
    await h.watch.tick()
    expect(h.watch.jobs.list({ states: ["waiting"] })).toHaveLength(60)
    expect(h.watch.pending()).toEqual({ running: 0, queued: 0, waiting: 60 })
    expect(h.started).toEqual([])
    // This daemon's own work still runs at once behind them.
    h.open(61, 2)
    await h.watch.tick()
    expect(h.started).toEqual([61])
    expect(h.watch.pending()).toEqual({ running: 1, queued: 1, waiting: 60 })
    expect(h.watch.jobs.list({ states: ["cancelled"] })).toEqual([])
    expect(h.notices.some((text) => text.includes("run queue"))).toBe(false)
    expect(h.watch.describe()).toContain("jobs: 1 queued, 60 waiting (another device, a claim or a quota reset)")
  })
})

describe("waiting records are bounded (MAX_WAITING)", () => {
  test("at the bound, the oldest waiting record is cancelled with the reason, never dropped silently; queued work is never evicted for it", async () => {
    const dir = temp()
    // A ledger that already holds MAX_WAITING waiting records (another device's reviewer) and one pending review of this daemon.
    const seed = createJobLedger({ file: path.join(dir, "pr-review", "jobs.json"), now: () => 1_000 })
    for (let n = 1; n <= MAX_WAITING; n++) seed.upsert({ provider: "github", repo: "acme/app", directory: "/repo", number: n, sessionId: "ses_a", reviewer: "alice", scope: "personal", trigger: "opened", coverage: "full", base: "", head: sha(n), configKey: "", state: "waiting" })
    const mine = seed.upsert({ provider: "github", repo: "acme/app", directory: "/repo", number: 9_000, sessionId: "ses_a", reviewer: "global", scope: "global", trigger: "opened", coverage: "full", base: "", head: sha(9_000), configKey: "" })
    const oldest = seed.list({ number: 1 })[0]!
    const h = harness({ dir, concurrency: 1, assign: () => [away] })
    await h.watch.watchRepo("ses_a", "/repo")
    h.open(10_001, 1)
    await h.watch.tick()
    const cancelled = h.watch.jobs.list({ states: ["cancelled"] })
    expect(cancelled.map((job) => job.id)).toEqual([oldest.id])
    expect(cancelled[0]!.error).toBe(`more than ${MAX_WAITING} jobs were waiting for another device or a quota reset; this, the oldest, was cancelled (/reviews retries it)`)
    expect(h.watch.jobs.list({ states: ["waiting"] })).toHaveLength(MAX_WAITING)
    expect(h.watch.jobs.list({ number: 10_001 })[0]).toMatchObject({ state: "waiting", reviewer: "alice" })
    // This daemon's own review was not touched by the bound: it runs.
    expect(h.watch.jobs.get(mine.id)!.state).toBe("running")
  })

  test("a record parked by a runner (a claim held elsewhere) is trimmed at the next tick too", async () => {
    const dir = temp()
    const seed = createJobLedger({ file: path.join(dir, "pr-review", "jobs.json"), now: () => 1_000 })
    for (let n = 1; n <= MAX_WAITING + 3; n++) seed.upsert({ provider: "github", repo: "acme/app", directory: "/repo", number: n, sessionId: "ses_a", reviewer: "alice", scope: "personal", trigger: "opened", coverage: "full", base: "", head: sha(n), configKey: "", state: "waiting", notBefore: 9_999_999_999 })
    const h = harness({ dir })
    await h.watch.watchRepo("ses_a", "/repo")
    await h.watch.tick()
    expect(h.watch.jobs.list({ states: ["cancelled"] }).map((job) => job.number)).toEqual([1, 2, 3])
    expect(h.watch.pending()).toMatchObject({ waiting: MAX_WAITING })
  })
})

describe("a daemon start is a catch-up", () => {
  test("the first listing after a restart asks the platform for work the provider shows but no event announced", async () => {
    const first = harness()
    await first.watch.watchRepo("ses_a", "/repo")
    await first.watch.tick()
    await first.watch.tick()
    // The watch's own start catches up once (its first listing runs with the answer), then polls normally.
    expect(first.catchUps).toEqual([true, false, false])
    first.watch.stop()
    const second = harness({ dir: first.dir })
    await second.watch.tick()
    await second.watch.tick()
    expect(second.catchUps).toEqual([true, false])
  })
})
