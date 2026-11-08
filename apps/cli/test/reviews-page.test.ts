import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import type { PrJobSummary, PrReviewDashboard } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { createReviewsPageState, filterJobs, groupedRows, listedJobs, metricsSummary, prCell, renderReviewsPage, stackOrder, type ReviewsData, type ReviewsPageState } from "../src/view/reviews-page"
import { reviewsCommand, reviewsPageKey } from "../src/view/reviews-keys"
import { textWidth } from "../src/view/wrap"
import { createTicks } from "../src/ui/app/ticks"

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0)
const MIN = 60_000
const SIZES = [[80, 24], [120, 40], [160, 48]] as const
const text = (line: Line) => line.map((span) => span.text).join("")
const screen = (rows: Line[]) => rows.map(text).join("\n")
const sha = (seed: number) => seed.toString(16).padStart(40, "a")

let next = 0
function job(patch: Partial<PrJobSummary> = {}): PrJobSummary {
  next++
  return {
    id: `job-${next}`, provider: "github", repo: "acme/payments", number: 400 + next, title: "Refresh tokens before they expire", url: `https://github.com/acme/payments/pull/${400 + next}`,
    reviewer: "global", scope: "global", trigger: "synchronize", state: "pending", coverage: "incremental", base: sha(1), head: sha(2), attempts: 1,
    createdAt: NOW - 40 * MIN, updatedAt: NOW - 3 * MIN, findings: { confirmed: 0, plausible: 0, candidates: 0, resolved: 0 }, tokens: { input: 0, output: 0 },
    ...patch,
  }
}

function dashboard(jobs: PrJobSummary[]): PrReviewDashboard {
  return {
    updatedAt: NOW,
    watches: [
      { directory: "/Users/dev/Code/payments", repo: "acme/payments", provider: "github", state: "watching", open: 6, publish: "on", owner: "studio-mac" },
      { directory: "/Users/dev/Code/web", repo: "acme/web", provider: "github", state: "paused", open: 2, publish: "not asked" },
    ],
    reviewers: [
      { id: "global", scope: "global", areas: ["**"], availability: "online", device: "studio-mac" },
      { id: "personal:ana", scope: "personal", login: "ana", areas: ["src/billing/**"], availability: "offline", device: "ana-vps", lastSeenAt: NOW - 5 * 60 * MIN },
    ],
    jobs,
    metrics: { running: 1, queued: 1, waiting: 1, done24h: 4, failed24h: 1, tokens24h: { input: 1_240_000, output: 82_000, cached: 610_000 }, concurrency: 2 },
  }
}

function populated() {
  const root = job({ id: "root", number: 410, title: "Billing: split invoice service", state: "running", phase: "analysis", reviewSessionId: undefined, sessionId: "ses_review410", stack: { children: [411], depth: 0 }, tokens: { input: 210_000, output: 9_000, cached: 120_000 } })
  const child = job({ id: "child", number: 411, title: "Billing: invoice retries", state: "running", phase: "discovery", stack: { parent: 410, children: [], depth: 1 } })
  return [
    root, child,
    job({ id: "fixing", number: 412, state: "fixing", phase: "fix", fixSessionId: "ses_fix412", control: "reviewer", sessionId: "ses_review412" }),
    job({ id: "waiting", number: 413, state: "waiting", reviewer: "personal:ana", scope: "personal", assignment: "src/billing/** matches personal:ana's area; her device ana-vps is offline" }),
    job({ id: "checkpointed", number: 414, state: "checkpointed", stop: { kind: "budget", detail: "tokens_per_pr reached", unit: "tokens", used: 1_000_000, limit: 1_000_000, resumable: true, remaining: "6 candidates not verified" }, findings: { confirmed: 2, plausible: 1, candidates: 6, resolved: 0 } }),
    job({ id: "pending", number: 415, state: "pending" }),
    job({ id: "failed", number: 416, repo: "acme/web", state: "failed", error: "gh: HTTP 502 while reading the diff", stop: { kind: "error", detail: "the provider failed three times", resumable: false } }),
    job({ id: "done", number: 417, state: "done", findings: { confirmed: 0, plausible: 0, candidates: 0, resolved: 3 }, updatedAt: NOW - 90 * MIN }),
  ]
}

const ready = (jobs = populated()): ReviewsData => ({ status: "ready", dashboard: dashboard(jobs), fetchedAt: NOW })
const render = (data: ReviewsData, state: ReviewsPageState, width: number, height: number, offline = false) => renderReviewsPage({ data, state, width, height, now: NOW, offline })

function exactSize(rows: Line[], width: number, height: number) {
  expect(rows.length).toBe(height)
  for (const row of rows) expect(textWidth(text(row))).toBeLessThanOrEqual(width)
}

describe("reviews page render", () => {
  for (const [width, height] of SIZES) {
    test(`a populated dashboard at ${width}x${height} fills the screen exactly, lists groups in order and shows the stack child under its root`, () => {
      const rows = render(ready(), createReviewsPageState(), width, height)
      exactSize(rows, width, height)
      const out = screen(rows)
      expect(out).toContain("Reviews")
      expect(out).toContain("1 Jobs")
      expect(out).toContain("⠋ 1 running · 1 queued · 1 waiting · 1 failed")
      expect(out).toContain("enter detail · / search · ? keys")
      expect(out).not.toMatch(/24h|\d+ done|\d out\b|2 watches/)
      // 80x24 shows the list above a detail preview, so only the first groups fit; the selected job is the first one.
      const labels = height >= 40 ? ["Running", "Fixing · validating", "Waiting · offline", "Checkpointed", "Pending"] : ["Running", "Fixing · validating"]
      const order = labels.map((label) => out.indexOf(label))
      for (const at of order) expect(at).toBeGreaterThan(-1)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
      expect(out).toMatch(/❯ #410 Billing[^\n]*\n[^\n]*└─ #411 Billing/)
    })

    test(`an empty ledger at ${width}x${height} says there is no job and how to get one`, () => {
      const data: ReviewsData = { status: "ready", dashboard: { ...dashboard([]), watches: [], reviewers: [] } }
      const rows = render(data, createReviewsPageState(), width, height)
      exactSize(rows, width, height)
      expect(screen(rows)).toContain("No review jobs yet.")
      expect(screen(rows)).toContain("/pr watch-repo")
    })

    test(`loading, error, unavailable and offline at ${width}x${height} each have their own message and keep the exact size`, () => {
      const cases: Array<[ReviewsData, boolean, string]> = [
        [{ status: "loading" }, false, "reading review status"],
        [{ status: "error", error: "[DAEMON]: experimental.pr_review is off" }, false, "pr_review is off"],
        [{ status: "unavailable" }, false, "not available from this daemon"],
        [{ status: "loading" }, true, "daemon is offline"],
        [{ status: "remote" }, false, "runs gh on the daemon's own machine"],
      ]
      for (const [data, offline, message] of cases) {
        const rows = render(data, createReviewsPageState(), width, height, offline)
        exactSize(rows, width, height)
        expect(screen(rows).replace(/\s+/g, " ")).toContain(message)
      }
    })
  }

  test("an offline daemon keeps the last dashboard on screen and says so in the title", () => {
    const out = screen(render(ready(), createReviewsPageState(), 120, 40, true))
    expect(out).toContain("daemon offline")
    expect(out).toContain("#410")
  })

  test("a failed refresh keeps the last dashboard and marks the title instead of blanking the page", () => {
    const out = screen(render({ ...ready(), status: "error", error: "timeout" }, createReviewsPageState(), 120, 40))
    expect(out).toContain("refresh failed")
    expect(out).toContain("#412")
  })

  test("the detail shows phase, assignment, findings with the not-a-quality note, tokens and the stop reason in its unit", () => {
    let state = createReviewsPageState()
    const data = ready()
    state = { ...state, selectedId: "checkpointed" }
    state = reviewsPageKey(state, "\r", data.dashboard).state
    const out = screen(render(data, state, 160, 48)).replace(/\s+/g, " ")
    expect(out).toContain("2 confirmed · 1 plausible · 6 candidates · 0 resolved")
    expect(out).toContain("not a measure of the review")
    expect(out).toContain("tokens: used 1,000,000 · limit 1,000,000")
    expect(out).toContain("resumable yes")
    expect(out).toContain("6 candidates not verified")
    expect(out).toContain("cached not reported")
  })

  test("a job updated this minute reads 'updated just now', never 'now ago'", () => {
    const fresh = ready(populated().map((entry) => entry.id === "checkpointed" ? { ...entry, updatedAt: NOW - 10_000 } : entry))
    const state = reviewsPageKey({ ...createReviewsPageState(), selectedId: "checkpointed" }, "\r", fresh.dashboard).state
    const out = screen(render(fresh, state, 160, 48)).replace(/\s+/g, " ")
    expect(out).toContain("updated just now")
    expect(out).not.toContain("now ago")
  })

  test("the waiting job's detail shows why it was routed to that reviewer", () => {
    const state = { ...createReviewsPageState(), selectedId: "waiting", detail: true }
    expect(screen(render(ready(), state, 120, 40)).replace(/\s+/g, " ")).toContain("her device ana-vps is offline")
  })

  test("the watches tab lists watches, reviewers with availability and owner device, and the ledger's numbers", () => {
    const state = reviewsPageKey(createReviewsPageState(), "2", dashboard(populated())).state
    for (const [width, height] of SIZES) {
      const rows = render(ready(), state, width, height)
      exactSize(rows, width, height)
      const out = screen(rows)
      expect(out).toContain("acme/payments")
      expect(out).toContain("personal:ana")
      expect(out).toContain("offline")
      expect(out).toContain("ana-vps")
    }
    expect(screen(render(ready(), state, 160, 48))).toContain("in 1,240,000 · out 82,000 · cached 610,000")
  })

  test("a list longer than the screen keeps the selected job visible", () => {
    const many = Array.from({ length: 80 }, (_, index) => job({ id: `p${index}`, number: 1000 + index, state: "pending", updatedAt: NOW - index * MIN }))
    let state = createReviewsPageState()
    for (let i = 0; i < 60; i++) state = reviewsPageKey(state, "j", dashboard(many)).state
    const out = screen(render(ready(many), state, 80, 24))
    expect(out).toContain("#1060")
  })

  test("metrics never invent a number: without a dashboard the summary is empty", () => {
    expect(metricsSummary(undefined, 200)).toEqual([])
  })

  test("the tab row counts only what needs attention: non-zero running, queued, waiting and failed, else idle", () => {
    const words = (spans: ReturnType<typeof metricsSummary>) => spans.map((span) => span.text).join("")
    const base = dashboard([])
    expect(words(metricsSummary(base, 200, "⠙"))).toBe("⠙ 1 running · 1 queued · 1 waiting · 1 failed")
    expect(words(metricsSummary(base, 20))).toBe("⠋ 1 running")
    const some = { ...base, metrics: { ...base.metrics, running: 0, waiting: 0 } }
    expect(words(metricsSummary(some, 200))).toBe("1 queued · 1 failed")
    const idle = { ...base, metrics: { ...base.metrics, running: 0, queued: 0, waiting: 0, failed24h: 0 } }
    expect(metricsSummary(idle, 200)).toEqual([{ text: "idle", fg: "muted", dim: true }])
  })

  test("? lists every key under the tabs and hides it again; esc hides it before it unpins or leaves", () => {
    const data = dashboard(populated())
    const opened = reviewsPageKey(createReviewsPageState(), "?", data).state
    expect(opened.keys).toBe(true)
    const out = screen(render(ready(), opened, 200, 40))
    for (const meaning of ["open PR", "retry (asks why)", "config", "state filter", "repo filter", "select", "refresh", "follow latest, back", "take over, release", "hide keys"]) expect(out).toContain(meaning)
    expect(out).toContain("enter detail · / search · ? hide keys")
    exactSize(render(ready(), opened, 80, 24), 80, 24)
    expect(reviewsPageKey(opened, "?", data).state.keys).toBeUndefined()
    const escaped = reviewsPageKey(opened, "\x1b", data)
    expect(escaped.action.type).toBe("none")
    expect(escaped.state.keys).toBeUndefined()
    expect(screen(render(ready(), createReviewsPageState(), 200, 40))).not.toContain("retry (asks why)")
  })

  test("the header names one context key at most: esc clear filter while a filter is on", () => {
    const filtered = reviewsPageKey(createReviewsPageState(), "f", dashboard(populated())).state
    expect(screen(render(ready(), filtered, 200, 40))).toContain("? keys · esc clear filter")
  })
})

describe("reviews page model", () => {
  test("a stack cycle never loops and every job is listed once", () => {
    const a = job({ number: 1, stack: { parent: 2, children: [2], depth: 1 } })
    const b = job({ number: 2, stack: { parent: 1, children: [1], depth: 1 } })
    const order = stackOrder([a, b])
    expect(order.map((entry) => entry.job.number).sort()).toEqual([1, 2])
  })

  test("a child whose parent is in another state group says what it is stacked on", () => {
    const rows = groupedRows([job({ number: 10, state: "done" }), job({ number: 11, state: "running", stack: { parent: 10, children: [], depth: 1 } })])
    expect(rows.find((row) => row.kind === "job" && row.job.number === 11)).toMatchObject({ depth: 0, stackedOn: 10 })
  })

  test("the text filter needs every word; state and repo filters narrow further", () => {
    const jobs = populated()
    expect(filterJobs(jobs, { text: "billing retries", state: "all" }).map((entry) => entry.number)).toEqual([411])
    expect(filterJobs(jobs, { text: "#416", state: "all" }).map((entry) => entry.id)).toEqual(["failed"])
    expect(filterJobs(jobs, { text: "", state: "fixing" }).map((entry) => entry.id)).toEqual(["fixing"])
    expect(filterJobs(jobs, { text: "", state: "all", repo: "acme/web" }).map((entry) => entry.id)).toEqual(["failed"])
  })
})

describe("reviews page keys", () => {
  const data = dashboard(populated())
  const at = (id: string): ReviewsPageState => ({ ...createReviewsPageState(), selectedId: id })
  const SES = "ses_main"

  test("p pauses and u resumes, sending pr.review job-pause and job-resume for the selected job", () => {
    const pause = reviewsPageKey(at("pending"), "p", data)
    expect(reviewsCommand(pause.action, SES)).toEqual({ type: "pr.review", sessionId: SES, action: "job-pause", jobId: "pending" })
    const resume = reviewsPageKey(at("checkpointed"), "u", data)
    expect(reviewsCommand(resume.action, SES)).toEqual({ type: "pr.review", sessionId: SES, action: "job-resume", jobId: "checkpointed" })
    expect(reviewsPageKey(at("done"), "p", data).action.type).toBe("none")
  })

  test("x asks before cancelling; x or y confirms with job-cancel, any other key keeps the job", () => {
    const asked = reviewsPageKey(at("pending"), "x", data)
    expect(asked.action.type).toBe("none")
    expect(asked.state.confirm).toEqual({ kind: "cancel", jobId: "pending", number: 415 })
    expect(screen(render(ready(), asked.state, 80, 24))).toContain("cancel")
    const kept = reviewsPageKey(asked.state, "n", data)
    expect(kept.action.type).toBe("none")
    expect(kept.state.confirm).toBeUndefined()
    const sent = reviewsPageKey(asked.state, "y", data)
    expect(reviewsCommand(sent.action, SES)).toEqual({ type: "pr.review", sessionId: SES, action: "job-cancel", jobId: "pending" })
  })

  test("R asks for a reason; an empty reason sends nothing, a typed one sends job-retry with it", () => {
    let state = reviewsPageKey(at("failed"), "R", data).state
    expect(state.reason).toEqual({ jobId: "failed", number: 416, text: "" })
    expect(reviewsPageKey(state, "\r", data).action.type).toBe("none")
    for (const key of ["gh ", "recovered", "x", "\x7f"]) state = reviewsPageKey(state, key, data).state
    const sent = reviewsPageKey(state, "\r", data)
    expect(reviewsCommand(sent.action, SES)).toEqual({ type: "pr.review", sessionId: SES, action: "job-retry", jobId: "failed", reason: "gh recovered" })
    expect(sent.state.reason).toBeUndefined()
    expect(reviewsPageKey(at("running"), "R", data).state.reason).toBeUndefined()
  })

  test("t takes over the reviewer's fix session after a confirm, and t on a taken-over job releases it", () => {
    const asked = reviewsPageKey(at("fixing"), "t", data)
    expect(asked.state.confirm?.kind).toBe("take-over")
    expect(reviewsCommand(reviewsPageKey(asked.state, "t", data).action, SES)).toEqual({ type: "pr.review", sessionId: SES, action: "take-over", jobId: "fixing" })
    const mine = dashboard(populated().map((entry) => (entry.id === "fixing" ? { ...entry, control: "user" as const } : entry)))
    const release = reviewsPageKey(at("fixing"), "t", mine)
    expect(release.state.confirm?.kind).toBe("release")
    expect(reviewsCommand(reviewsPageKey(release.state, "y", mine).action, SES)).toMatchObject({ action: "release", jobId: "fixing" })
    expect(reviewsPageKey(at("pending"), "t", data).state.confirm).toBeUndefined()
  })

  test("o opens the PR url, s the review session, S the fix session", () => {
    const url = data.jobs.find((entry) => entry.id === "fixing")!.url!
    expect(reviewsPageKey(at("fixing"), "o", data).action).toEqual({ type: "url", url })
    expect(reviewsPageKey(at("fixing"), "s", data).action).toEqual({ type: "session", sessionId: "ses_review412" })
    expect(reviewsPageKey(at("fixing"), "S", data).action).toEqual({ type: "session", sessionId: "ses_fix412" })
    expect(reviewsPageKey(at("pending"), "S", data).action.type).toBe("none")
  })

  test("c asks config-show for the job's scope in the watched checkout of its repository", () => {
    const result = reviewsPageKey(at("waiting"), "c", data)
    expect(result.state.config).toMatchObject({ jobId: "waiting", scope: "personal", status: "loading" })
    expect(reviewsCommand(result.action, SES)).toEqual({ type: "pr.review", sessionId: SES, action: "config-show", scope: "personal", jobId: "waiting", directory: "/Users/dev/Code/payments" })
    expect(reviewsPageKey(result.state, "\x1b", data).state.config).toBeUndefined()
  })

  test("/ types a filter, Enter keeps it, Esc in the list clears it, and a second Esc closes the page", () => {
    let state = reviewsPageKey(createReviewsPageState(), "/", data).state
    for (const key of ["i", "n", "v", "o", "i", "c", "e"]) state = reviewsPageKey(state, key, data).state
    state = reviewsPageKey(state, "\r", data).state
    expect(state.typing).toBe(false)
    expect(listedJobs(data, state.filter).map((entry) => entry.number)).toEqual([410, 411])
    state = reviewsPageKey(state, "\x1b", data).state
    expect(state.filter).toEqual({ text: "", state: "all" })
    expect(reviewsPageKey(state, "\x1b", data).action).toEqual({ type: "close" })
  })

  test("f cycles the state filter and m the repository filter, both back to all", () => {
    let state = createReviewsPageState()
    state = reviewsPageKey(state, "f", data).state
    expect(state.filter.state).toBe("running")
    state = reviewsPageKey(state, "F", data).state
    expect(state.filter.state).toBe("all")
    state = reviewsPageKey(state, "m", data).state
    expect(state.filter.repo).toBe("acme/payments")
    state = reviewsPageKey(state, "m", data).state
    expect(state.filter.repo).toBe("acme/web")
    state = reviewsPageKey(state, "m", data).state
    expect(state.filter.repo).toBeUndefined()
  })

  test("the selection follows the job across a refresh that reorders the list", () => {
    let state = reviewsPageKey(createReviewsPageState(), "j", data).state
    const chosen = state.selectedId
    const reordered = dashboard([...populated()].reverse())
    state = reviewsPageKey(state, "z", reordered).state
    expect(listedJobs(reordered, state.filter).find((entry) => entry.id === state.selectedId)?.id).toBe(chosen)
  })

  test("r refreshes, q closes, and a key that means nothing returns the same state object", () => {
    const state = createReviewsPageState()
    expect(reviewsPageKey(state, "r", data).action).toEqual({ type: "refresh" })
    expect(reviewsPageKey(state, "q", data).action).toEqual({ type: "close" })
    expect(reviewsPageKey(state, "z", data).state).toBe(state)
  })
})

describe("one row per pull request", () => {
  const history = () => [
    job({ id: "old-fail", number: 23, state: "failed", head: sha(3), createdAt: NOW - 120 * MIN, updatedAt: NOW - 118 * MIN, phase: "corroboration", attempts: 1, error: "verification failed (no JSON object in the answer); nothing was published" }),
    job({ id: "older-fail", number: 23, state: "failed", head: sha(4), createdAt: NOW - 180 * MIN, updatedAt: NOW - 178 * MIN, phase: "corroboration", attempts: 1, error: "verification failed; nothing was published" }),
    job({ id: "latest-done", number: 23, state: "done", head: sha(5), createdAt: NOW - 30 * MIN, updatedAt: NOW - 25 * MIN, phase: "analysis", attempts: 0, findings: { confirmed: 1, plausible: 0, candidates: 0, resolved: 0 } }),
    job({ id: "only-fail", number: 30, state: "failed", head: sha(6), createdAt: NOW - 10 * MIN, updatedAt: NOW - 9 * MIN, phase: "corroboration", attempts: 5, error: "verification failed (the verifier crashed); nothing was published" }),
  ]

  test("failures a later review of the same PR superseded are its history, not a failed row; Failed lists only PRs whose last run failed", () => {
    const listed = listedJobs(dashboard(history()), createReviewsPageState().filter)
    expect(listed.map((entry) => entry.id)).toEqual(["only-fail", "latest-done"])
    const out = screen(render(ready(history()), createReviewsPageState(), 120, 40))
    expect(out).toMatch(/Failed {2}1/)
    expect(out).toMatch(/Done {2}1/)
    expect(out).toMatch(/#23 Refresh[^\n]* · 3 runs/)
    expect(out).toContain("done · 1 finding")
    expect(out).toContain("Pull requests · 2")
  })

  test("a done job's detail says how it ended, never a phase or attempt 0; its earlier runs say why each failed", () => {
    const state = { ...createReviewsPageState(), selectedId: "latest-done", detail: true }
    const out = screen(render(ready(history()), state, 160, 48))
    expect(out).toContain("state      done · 1 finding")
    expect(out).not.toContain("phase analysis")
    expect(out).not.toContain("attempt 0")
    expect(out).toContain("Earlier runs · 2")
    expect(out).toContain("failed · corroboration · 2h ago · verification failed (no JSON object in the answer); nothing was published")
    const failed = screen(render(ready(history()), { ...state, selectedId: "only-fail" }, 120, 40))
    expect(failed).toContain("state      failed in corroboration · 5 attempts")
  })

  test("a running review shows its live phase and time in the list and its steps in the detail", () => {
    const jobs = [job({ id: "run", number: 25, state: "running", phase: "corroboration", attempts: 0 })]
    const activity = [{ jobId: "run", sessionId: "ses_watch" as never, repo: "acme/payments", number: 25, phase: "analysis", startedAt: NOW - 80_000, steps: [{ label: "Fetching #25", detail: "head 51fe4047", startedAt: NOW - 80_000, endedAt: NOW - 76_000 }, { label: "Analysis", detail: "112 files", startedAt: NOW - 76_000 }] }]
    const list = screen(renderReviewsPage({ data: ready(jobs), state: createReviewsPageState(), width: 100, height: 30, now: NOW, activity }))
    expect(list).toMatch(/Running {2}1/)
    expect(list).toContain("⠋ analysis · 112 files · 1m 20s")
    const detail = screen(renderReviewsPage({ data: ready(jobs), state: { ...createReviewsPageState(), selectedId: "run", detail: true }, width: 100, height: 30, now: NOW, activity }))
    expect(detail).toContain("state      running · analysis · 1m 20s · attempt 1")
    expect(detail).toContain("           ⠋ analysis · 112 files · 1m 20s")
    expect(detail).toContain("steps      Fetching #25 · head 51fe4047 · 4s")
    expect(detail).toContain("Analysis · 112 files · 1m 16s so far")
    if (process.env.CAPTURE_DIR) {
      writeFileSync(`${process.env.CAPTURE_DIR}/reviews-running-list-100x30.txt`, list)
      writeFileSync(`${process.env.CAPTURE_DIR}/reviews-running-detail-100x30.txt`, detail)
    }
  })
})

describe("the selection follows the latest review until one is picked", () => {
  type Activity = NonNullable<Parameters<typeof renderReviewsPage>[0]["activity"]>
  const running = (jobId: string, number: number, startedAt: number): Activity[number] => ({ jobId, sessionId: "ses_watch" as never, repo: "acme/payments", number, phase: "analysis", startedAt, steps: [{ label: "Analysis", detail: "112 files", startedAt }] })
  const selectedRow = (out: string) => out.split("\n").find((line) => line.includes("❯"))
  const draw = (jobs: PrJobSummary[], state: ReviewsPageState, activity: Activity = []) => screen(renderReviewsPage({ data: ready(jobs), state, width: 160, height: 48, now: NOW, activity }))

  test("follows the running job, the one started last when several run", () => {
    const jobs = [job({ id: "old-run", number: 30, state: "running", phase: "analysis" }), job({ id: "new-run", number: 31, state: "running", phase: "analysis" }), job({ id: "fresh-done", number: 32, state: "done", updatedAt: NOW - 1_000 })]
    const activity = [running("old-run", 30, NOW - 10 * MIN), running("new-run", 31, NOW - MIN)]
    expect(selectedRow(draw(jobs, createReviewsPageState(), activity))).toContain("#31")
    expect(reviewsPageKey(createReviewsPageState(), "s", dashboard(jobs), activity).state.selectedId).toBeUndefined()
  })

  test("follows the newest job when none runs, and moves on its own when a new review starts", () => {
    const idle = [job({ id: "older", number: 40, state: "done", updatedAt: NOW - 60 * MIN }), job({ id: "newer", number: 41, state: "failed", updatedAt: NOW - 2 * MIN })]
    const state = createReviewsPageState()
    expect(selectedRow(draw(idle, state))).toContain("#41")
    const started = [...idle, job({ id: "started", number: 42, state: "running", phase: "discovery", updatedAt: NOW - 30 * MIN })]
    expect(selectedRow(draw(started, state, [running("started", 42, NOW - 5_000)]))).toContain("#42")
  })

  test("an arrow pins the selection, says so in the detail title and the hints, and a new review does not move it", () => {
    const jobs = [job({ id: "a", number: 50, state: "done", updatedAt: NOW - MIN }), job({ id: "b", number: 51, state: "done", updatedAt: NOW - 9 * MIN })]
    const unpinned = draw(jobs, createReviewsPageState())
    expect(unpinned).not.toContain("pinned")
    expect(unpinned).not.toContain("esc follow latest")
    const state = reviewsPageKey(createReviewsPageState(), "\x1b[B", dashboard(jobs)).state
    expect(state.selectedId).toBe("b")
    const pinned = draw(jobs, state)
    expect(selectedRow(pinned)).toContain("#51")
    expect(pinned).toContain("#51 · pinned")
    expect(pinned).toContain("esc follow latest")
    const later = [...jobs, job({ id: "c", number: 52, state: "running", phase: "analysis" })]
    expect(selectedRow(draw(later, state, [running("c", 52, NOW - 1_000)]))).toContain("#51")
  })

  test("esc on a pinned selection unpins and follows again; a second esc leaves the page", () => {
    const data = dashboard(populated())
    const pinned = reviewsPageKey(reviewsPageKey(createReviewsPageState(), "j", data).state, "\r", data).state
    expect(pinned).toMatchObject({ selectedId: "child", detail: true })
    const list = reviewsPageKey(pinned, "\x1b", data)
    expect(list.state).toMatchObject({ selectedId: "child", detail: false })
    const following = reviewsPageKey(list.state, "\x1b", data)
    expect(following.action.type).toBe("none")
    expect(following.state.selectedId).toBeUndefined()
    expect(reviewsPageKey(following.state, "\x1b", data).action).toEqual({ type: "close" })
  })

  test("a running row shows the activity spinner with its phase, running step and time", () => {
    const jobs = [job({ id: "run", number: 60, state: "running", phase: "analysis" }), job({ id: "idle", number: 61, state: "done" })]
    const activity = [running("run", 60, NOW - 75_000)]
    const frame = (spinner: string) => screen(renderReviewsPage({ data: ready(jobs), state: createReviewsPageState(), width: 160, height: 48, now: NOW, activity, spinner }))
    // The list row, left of a wide page's detail pane.
    const rowOf = (out: string, number: number) => out.split("\n").map((line) => line.split("│ │")[0]!).find((line) => line.includes(`#${number} Refresh`))!
    expect(rowOf(frame("⠙"), 60)).toContain("⠙ analysis · 112 files · 1m 15s")
    expect(rowOf(frame("⠙"), 61)).not.toContain("⠙")
    for (const width of [80, 100, 120]) {
      const narrow = screen(renderReviewsPage({ data: ready(jobs), state: createReviewsPageState(), width, height: 24, now: NOW, activity }))
      expect(rowOf(narrow, 60)).toMatch(/❯ #60 Refresh[^\n]*⠋ analysis[^\n]* · 1m 15s/)
    }
  })

  test("no redraw timer runs on the page while no review runs; one pulse runs while one does", () => {
    const state = { page: "reviews", settingsPageState: { row: 9 }, transcript: { foreground: "idle", blocks: () => [] }, agentSessions: new Map(), turnState: {}, reviewActivity: [] as Activity[number][], reducedMotion: false, pulse: undefined as ReturnType<typeof setInterval> | undefined, pulseOn: true, loopsTick: undefined as ReturnType<typeof setInterval> | undefined, spinFrame: 0 }
    const ticks = createTicks({ state, schedule() {}, input: {} } as never, { chatWidth: () => 100, sessionTitle: () => "", render() {} })
    try {
      ticks.syncPulse()
      ticks.syncLoopsTick()
      expect(state.pulse).toBeUndefined()
      expect(state.loopsTick).toBeUndefined()
      state.reviewActivity = [running("run", 60, NOW)]
      ticks.syncPulse()
      ticks.syncLoopsTick()
      expect(state.pulse).toBeDefined()
      expect(state.loopsTick).toBeUndefined()
      state.reviewActivity = []
      ticks.syncPulse()
      ticks.syncLoopsTick()
      expect(state.pulse).toBeUndefined()
      expect(state.loopsTick).toBeUndefined()
    } finally {
      if (state.pulse) clearInterval(state.pulse)
      if (state.loopsTick) clearInterval(state.loopsTick)
    }
  })
})

describe("the pull request's GitHub state", () => {
  type Pr = NonNullable<PrJobSummary["pullRequest"]>
  const open: Pr = { state: "open", draft: false, mergeable: "mergeable", checks: "passing" }
  const cases: Array<{ name: string; pr: Pr; blocking?: number; text: string; fg: string }> = [
    { name: "merged", pr: { ...open, state: "merged" }, text: "merged", fg: "muted" },
    { name: "closed", pr: { ...open, state: "closed" }, text: "closed", fg: "muted" },
    { name: "draft", pr: { ...open, draft: true }, text: "draft", fg: "muted" },
    { name: "ready", pr: open, text: "open · ready", fg: "success" },
    { name: "ready without any check", pr: { ...open, checks: "none" }, text: "open · ready", fg: "success" },
    { name: "a failed check", pr: { ...open, checks: "failing", failing: ["lint", "e2e"] }, text: "open · CI ✗", fg: "error" },
    { name: "checks running", pr: { ...open, checks: "pending" }, text: "open · CI …", fg: "muted" },
    { name: "a conflict", pr: { ...open, mergeable: "conflicting" }, text: "open · conflict", fg: "warning" },
    { name: "an open major finding", pr: open, blocking: 1, text: "open · findings", fg: "warning" },
  ]
  const withPr = (pr: Pr | undefined, blocking?: number, patch: Partial<PrJobSummary> = {}) => job({ state: "done", ...(pr ? { pullRequest: pr } : {}), findings: { confirmed: blocking ?? 0, plausible: 0, candidates: 0, resolved: 0, ...(blocking ? { blocking } : {}) }, ...patch })

  for (const entry of cases) {
    test(`${entry.name}: the row says ${entry.text} in ${entry.fg}, and so does the detail's pull request line`, () => {
      const target = withPr(entry.pr, entry.blocking)
      expect(prCell(target)).toEqual({ text: entry.text, fg: entry.fg as never })
      const rows = render(ready([target]), createReviewsPageState(), 160, 48)
      const span = rows.flat().find((item) => item.text === entry.text)
      expect(span?.fg).toBe(entry.fg as never)
      expect(screen(rows)).toContain(`pull request  ${entry.text}`)
    })
  }

  test("the detail names the failing checks; an unknown state shows no cell and no pull request line", () => {
    const failing = render(ready([withPr({ ...open, checks: "failing", failing: ["lint", "e2e", "build"] })]), createReviewsPageState(), 160, 48)
    expect(screen(failing)).toContain("failing lint, e2e, build")
    const unknown = render(ready([withPr(undefined)]), createReviewsPageState(), 160, 48)
    expect(screen(unknown)).not.toContain("pull request  ")
    expect(prCell(withPr(undefined))).toBeUndefined()
  })

  test("f reaches ready, needs work and closed after the review states; each keeps only its pull requests", () => {
    const jobs = [
      withPr(open, undefined, { id: "ready" }),
      withPr({ ...open, checks: "failing" }, undefined, { id: "ci" }),
      withPr({ ...open, mergeable: "conflicting" }, undefined, { id: "conflict" }),
      withPr(open, 2, { id: "blocking" }),
      withPr({ ...open, state: "merged" }, undefined, { id: "merged" }),
      withPr({ ...open, state: "closed" }, undefined, { id: "closed" }),
      withPr({ ...open, draft: true }, undefined, { id: "draft" }),
      withPr(undefined, undefined, { id: "unknown" }),
    ]
    const board = dashboard(jobs)
    let state = createReviewsPageState()
    const seen: string[] = []
    for (let step = 0; step < 12; step++) { state = reviewsPageKey(state, "f", board).state; seen.push(state.filter.state) }
    expect(seen.slice(-3)).toEqual(["ready", "needs-work", "closed"])
    const ids = (filter: ReviewsPageState["filter"]["state"]) => filterJobs(jobs, { text: "", state: filter }).map((entry) => entry.id).sort()
    expect(ids("ready")).toEqual(["ready"])
    expect(ids("needs-work")).toEqual(["blocking", "ci", "conflict"])
    expect(ids("closed")).toEqual(["closed", "merged"])
    const prompt = screen(render({ status: "ready", dashboard: board, fetchedAt: NOW }, { ...createReviewsPageState(), filter: { text: "", state: "needs-work" } }, 120, 40))
    expect(prompt).toContain("· needs work")
    expect(reviewsPageKey(createReviewsPageState(), "F", board).state.filter.state).toBe("closed")
  })
})

describe("moving through the list and clearing finished reviews", () => {
  const data = dashboard(populated())
  const ids = listedJobs(data, createReviewsPageState().filter).map((entry) => entry.id)
  const at = (id: string): ReviewsPageState => ({ ...createReviewsPageState(), selectedId: id, selected: ids.indexOf(id) })
  test("down on the last row goes to the first and up on the first to the last; shift with an arrow moves five", () => {
    expect(reviewsPageKey(at(ids.at(-1)!), "\x1b[B", data).state.selectedId).toBe(ids[0])
    expect(reviewsPageKey(at(ids[0]!), "\x1b[A", data).state.selectedId).toBe(ids.at(-1))
    expect(reviewsPageKey(at(ids[0]!), "\x1b[1;2B", data).state.selectedId).toBe(ids[5])
    expect(reviewsPageKey(at(ids[5]!), "\x1b[1;2A", data).state.selectedId).toBe(ids[0])
  })
  test("d asks before removing a finished review and, confirmed, sends job-forget and keeps the selection on the next row", () => {
    const asked = reviewsPageKey(at("failed"), "d", data).state
    expect(asked.confirm).toEqual({ kind: "forget", jobId: "failed", number: 416 })
    expect(renderReviewsPage({ data: ready(), state: asked, width: 120, height: 40, now: NOW }).map(text).join("\n")).toContain("remove from the list #416?")
    const done = reviewsPageKey(asked, "d", data)
    expect(done.action).toEqual({ type: "job", action: "job-forget", jobId: "failed" })
    expect(done.state.selectedId).toBe(ids[ids.indexOf("failed") + 1])
    // A live job is cancelled first, never removed.
    expect(reviewsPageKey(at("pending"), "d", data).state.confirm).toBeUndefined()
  })
  test("cancelling keeps the selection where it was instead of following the job to the cancelled group at the bottom", () => {
    const asked = reviewsPageKey(at("checkpointed"), "x", data).state
    const done = reviewsPageKey(asked, "x", data)
    expect(done.action).toEqual({ type: "job", action: "job-cancel", jobId: "checkpointed" })
    expect(done.state.selectedId).toBe(ids[ids.indexOf("checkpointed") + 1])
  })
})
