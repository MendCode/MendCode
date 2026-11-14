import { describe, expect, test } from "bun:test"
import { PrReviewDashboard, type PrFinding } from "@mendcode/protocol"
import { buildDashboard, DASHBOARD_MAX_BYTES, DASHBOARD_MAX_JOBS, findingCounts, fitDashboard, jobSummary, newestJobs } from "../src/pr-review/dashboard"
import type { ReviewJob } from "../src/pr-review/contracts"

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0)
const HOUR = 60 * 60 * 1000
const sha = (seed: number) => seed.toString(16).padStart(40, "0")

function finding(seed: number, verdict?: PrFinding["verdict"]): PrFinding {
  return { id: sha(seed), path: "src/auth/session.ts", line: 40 + seed, side: "RIGHT", severity: "major", category: "correctness", summary: `token refresh race ${seed}`, detail: "Two refreshes can interleave and the older token wins.", evidence: ["src/auth/session.ts:41"], ...(verdict ? { verdict } : {}) }
}

let next = 0
function job(patch: Partial<ReviewJob> = {}): ReviewJob {
  next++
  return {
    id: `job-${next}`, provider: "github", repo: "acme/payments", directory: "/work/payments", number: 100 + next, sessionId: "ses_watch",
    reviewer: "global", scope: "global", trigger: "opened", state: "pending", coverage: "incremental", base: sha(9000 + next), head: sha(8000 + next),
    configKey: "cfg-1", attempts: 0, createdAt: NOW - 2 * HOUR, updatedAt: NOW - HOUR,
    checkpoint: { completedPhases: [], candidates: [], verified: [], rounds: [], decisions: [] },
    tokens: { input: 0, output: 0 },
    ...patch,
  }
}

const watches = [{ directory: "/work/payments", repo: "acme/payments", state: "watching", open: 7, publish: "on" }]
const reviewers = [
  { id: "global", scope: "global" as const, areas: ["**"], availability: "online" as const, device: "studio-mac" },
  { id: "personal:ana", scope: "personal" as const, login: "ana", areas: ["src/billing/**"], availability: "offline" as const, device: "ana-vps", lastSeenAt: NOW - 5 * HOUR },
]

describe("buildDashboard", () => {
  test("metrics count the ledger's states: running includes fixing and validating, done and failed only within 24 hours", () => {
    const jobs = [
      job({ state: "running" }), job({ state: "fixing" }), job({ state: "validating" }),
      job({ state: "pending" }), job({ state: "pending" }), job({ state: "waiting" }),
      job({ state: "done", updatedAt: NOW - 3 * HOUR }), job({ state: "done", updatedAt: NOW - 30 * HOUR }),
      job({ state: "failed", updatedAt: NOW - HOUR }), job({ state: "failed", updatedAt: NOW - 25 * HOUR }),
      job({ state: "checkpointed" }), job({ state: "cancelled" }),
    ]
    const dashboard = buildDashboard({ jobs, watches, reviewers, now: NOW, concurrency: 2 })
    expect(dashboard.metrics).toMatchObject({ running: 3, queued: 2, waiting: 1, done24h: 1, failed24h: 1, concurrency: 2 })
    expect(dashboard.updatedAt).toBe(NOW)
  })

  test("tokens of 24 hours sum only jobs updated in that window and keep cached and unreported absent when no job reported them", () => {
    const plain = buildDashboard({ jobs: [job({ tokens: { input: 1200, output: 300 } }), job({ updatedAt: NOW - 48 * HOUR, tokens: { input: 99_999, output: 99_999 } })], watches, reviewers, now: NOW, concurrency: 1 })
    expect(plain.metrics.tokens24h).toEqual({ input: 1200, output: 300 })
    const cached = buildDashboard({ jobs: [job({ tokens: { input: 1000, output: 10, cached: 600 } }), job({ tokens: { input: 50, output: 5, unreported: 2 } })], watches, reviewers, now: NOW, concurrency: 1 })
    expect(cached.metrics.tokens24h).toEqual({ input: 1050, output: 15, cached: 600, unreported: 2 })
  })

  test("an empty ledger is a valid dashboard with zero counts, not an error", () => {
    const dashboard = buildDashboard({ jobs: [], watches: [], reviewers: [], now: NOW, concurrency: 2 })
    expect(PrReviewDashboard.safeParse(dashboard).success).toBe(true)
    expect(dashboard.metrics).toEqual({ running: 0, queued: 0, waiting: 0, done24h: 0, failed24h: 0, tokens24h: { input: 0, output: 0 }, concurrency: 2 })
  })

  test("at most 500 jobs: every live job is kept ahead of the newest finished ones, metrics still count the whole ledger", () => {
    const finished = Array.from({ length: 600 }, (_, index) => job({ state: "done", updatedAt: NOW - index * 1000 }))
    const live = [job({ state: "running", updatedAt: NOW - 100 * HOUR }), job({ state: "waiting", updatedAt: NOW - 200 * HOUR })]
    const dashboard = buildDashboard({ jobs: [...finished, ...live], watches, reviewers, now: NOW, concurrency: 2 })
    expect(dashboard.jobs.length).toBe(DASHBOARD_MAX_JOBS)
    expect(dashboard.jobs.slice(0, 2).map((entry) => entry.state)).toEqual(["running", "waiting"])
    expect(dashboard.jobs[2]!.id).toBe(finished[0]!.id)
    expect(dashboard.metrics.done24h).toBe(600)
    expect(dashboard.metrics.running).toBe(1)
  })

  test("watches and reviewers are bounded to the schema's 50 and 200 and the provider defaults to github", () => {
    const many = Array.from({ length: 80 }, (_, index) => ({ directory: `/work/r${index}`, state: "watching", open: index, publish: "not asked" }))
    const people = Array.from({ length: 260 }, (_, index) => ({ id: `personal:u${index}`, scope: "personal" as const, areas: [], availability: "unknown" as const }))
    const dashboard = buildDashboard({ jobs: [], watches: many, reviewers: people, now: NOW, concurrency: 4 })
    expect(dashboard.watches.length).toBe(50)
    expect(dashboard.reviewers.length).toBe(200)
    expect(dashboard.watches[0]).toEqual({ directory: "/work/r0", provider: "github", state: "watching", open: 0, publish: "not asked" })
  })

  test("long ledger strings are cut to the protocol's bounds so a verbose error never breaks the page", () => {
    const dashboard = buildDashboard({ jobs: [job({ state: "failed", error: "x".repeat(5000), title: "t".repeat(900), checkpoint: { phase: "p".repeat(200), completedPhases: [], candidates: [], verified: [], rounds: [], decisions: [] } })], watches: [{ directory: "/w", state: "s".repeat(500), open: 1, publish: "maintainers-and-more-than-forty-characters-long" }], reviewers, now: NOW, concurrency: 1 })
    expect(dashboard.jobs[0]!.error!.length).toBe(600)
    expect(dashboard.jobs[0]!.title!.length).toBe(300)
    expect(dashboard.jobs[0]!.phase!.length).toBe(60)
    expect(dashboard.watches[0]!.state.length).toBe(120)
    expect(dashboard.watches[0]!.publish.length).toBe(40)
  })

  test("a concurrency under one is refused with a RangeError", () => {
    expect(() => buildDashboard({ jobs: [], watches, reviewers, now: NOW, concurrency: 0 })).toThrow(RangeError)
    expect(() => buildDashboard({ jobs: [], watches, reviewers, now: NOW, concurrency: 1.5 })).toThrow(RangeError)
  })

  test("a ledger row the protocol refuses throws instead of shipping an invalid dashboard", () => {
    expect(() => buildDashboard({ jobs: [job({ number: 0 })], watches, reviewers, now: NOW, concurrency: 1 })).toThrow()
  })
})

describe("jobSummary", () => {
  test("maps the review session, phase, stop, control and stack, and leaves out what the job does not have", () => {
    const stop = { kind: "budget" as const, detail: "tokens_per_pr reached", unit: "tokens" as const, used: 1_000_000, limit: 1_000_000, resumable: true, remaining: "4 candidates not verified" }
    const summary = jobSummary(job({ state: "checkpointed", reviewSessionId: "ses_review", fixSessionId: "ses_fix", control: "user", stop, stack: { parent: 101, children: [103], depth: 1 }, checkpoint: { phase: "corroboration", completedPhases: ["discovery", "analysis"], candidates: [], verified: [], rounds: [], decisions: [] } }))
    expect(summary).toMatchObject({ state: "checkpointed", sessionId: "ses_review", fixSessionId: "ses_fix", control: "user", phase: "corroboration", stop, stack: { parent: 101, children: [103], depth: 1 } })
    const bare = jobSummary(job())
    for (const key of ["title", "url", "assignment", "phase", "owner", "sessionId", "fixSessionId", "control", "stop", "error", "stack"]) expect(key in bare).toBe(false)
  })
})

describe("findingCounts", () => {
  test("confirmed and plausible come from verified verdicts, candidates from unverified ones, and rejected ones count nowhere", () => {
    const counts = findingCounts({ checkpoint: { completedPhases: [], candidates: [finding(1), finding(2)], verified: [finding(3, "confirmed"), finding(4, "confirmed"), finding(5, "plausible"), finding(6, "rejected")], rounds: [], decisions: [] } })
    expect(counts).toEqual({ confirmed: 2, plausible: 1, candidates: 2, resolved: 0, blocking: 2 })
  })

  test("resolved counts confirmed findings the last fix round no longer lists as open; only the open major ones block", () => {
    const counts = findingCounts({ checkpoint: { completedPhases: [], candidates: [], verified: [finding(3, "confirmed"), finding(4, "confirmed"), finding(5, "confirmed")], rounds: [{ at: NOW - HOUR, open: [sha(3), sha(4), sha(5)] }, { at: NOW, open: [sha(5)], commit: "abc1234" }], decisions: [] } })
    expect(counts.resolved).toBe(2)
    expect(counts.blocking).toBe(1)
    const minor = findingCounts({ checkpoint: { completedPhases: [], candidates: [], verified: [{ ...finding(7, "confirmed"), severity: "minor" }], rounds: [], decisions: [] } })
    expect("blocking" in minor).toBe(false)
  })
})

describe("newestJobs", () => {
  test("orders by last update, newest first, with live jobs ahead of finished ones", () => {
    const old = job({ state: "pending", updatedAt: NOW - 10 * HOUR })
    const recentDone = job({ state: "done", updatedAt: NOW })
    const recentRun = job({ state: "running", updatedAt: NOW - HOUR })
    expect(newestJobs([old, recentDone, recentRun]).map((entry) => entry.id)).toEqual([recentRun.id, old.id, recentDone.id])
  })
})

describe("fitDashboard", () => {
  test("a ledger too big for one reply leaves out its oldest finished jobs, never a live one, and fits the frame", () => {
    // Finished reviews with their findings, as a repository with a hundred reviewed pull requests holds them.
    const finished = Array.from({ length: 200 }, (_, n) => job({ state: "done", updatedAt: NOW - n * HOUR, checkpoint: { completedPhases: ["discovery", "analysis"], candidates: [], verified: Array.from({ length: 6 }, (_, k) => finding(n * 10 + k)), rounds: [], decisions: Array.from({ length: 4 }, (_, k) => ({ phase: "analysis", action: "kept" as const, reason: `round ${k}: ${"the change keeps the old contract. ".repeat(8)}` })) } }))
    const live = job({ state: "running", updatedAt: NOW - 300 * HOUR })
    const whole = buildDashboard({ jobs: [...finished, live], watches, reviewers, now: NOW, concurrency: 2 })
    expect(Buffer.byteLength(JSON.stringify(whole))).toBeGreaterThan(DASHBOARD_MAX_BYTES)
    const { dashboard, dropped } = fitDashboard(whole)
    expect(Buffer.byteLength(JSON.stringify(dashboard))).toBeLessThanOrEqual(DASHBOARD_MAX_BYTES)
    expect(dropped).toBeGreaterThan(0)
    expect(dashboard.jobs.length + dropped).toBe(whole.jobs.length)
    expect(dashboard.jobs[0]!.id).toBe(live.id)
    // What stays is the newest: the list is the same one, cut at its end.
    expect(dashboard.jobs.map((entry) => entry.id)).toEqual(whole.jobs.slice(0, dashboard.jobs.length).map((entry) => entry.id))
    expect(PrReviewDashboard.parse(dashboard)).toEqual(dashboard)
  })

  test("a dashboard that fits is returned as it is", () => {
    const small = buildDashboard({ jobs: [job({ state: "done" })], watches, reviewers, now: NOW, concurrency: 1 })
    expect(fitDashboard(small)).toEqual({ dashboard: small, dropped: 0 })
  })
})
