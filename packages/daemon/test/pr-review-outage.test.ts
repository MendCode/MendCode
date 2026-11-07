import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { GhRun } from "../src/pr-watch"
import { MAX_JOB_ATTEMPTS, TRANSIENT_BACKOFF_CAP_MS, TRANSIENT_RETRY_WINDOW_MS } from "../src/pr-review/jobs"
import { elapsed, failureKind, OUTAGE_BACKOFF_CAP_MS, OUTAGE_LIMIT_MS, SLEEP_GAP_MS } from "../src/pr-review/outage"
import { createRepoWatch, type JobOutcome, type RepoWatchJob } from "../src/pr-review/repo-watch"

/**
 * O3 of the live re-verification of 8c21523f: the laptop slept about four hours with its lid closed and woke in the dark without
 * network every so often. 15 wall-clock minutes of failed `gh pr list` ended both watches for good ("could not list its pull
 * requests for 15 minutes"), and a job spent its five attempts on "gh could not name the GitHub repository" and failed; nothing was
 * reviewed again until someone ran `/pr watch-repo`. Here an injected wall clock and monotonic clock (it stops while the machine
 * sleeps) and a fake gh that fails with network errors for hours, then recovers. Temp directories only, no network.
 */

const cleanups: Array<() => unknown> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pr-outage-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const sha = (n: number) => n.toString(16).padStart(40, "0")
const MINUTE = 60_000, HOUR = 60 * MINUTE
const OFFLINE = "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com"

/**
 * A fake gh: the open PRs the test sets, `gh api rate_limit` for the reachability probe, and a failure mode (`fail`: every call
 * answers it) for the outage. Every `pr list` is counted.
 */
function fakeGh() {
  const state = { prs: [] as Array<{ number: number; headRefOid: string }>, fail: undefined as string | undefined, lists: 0, probes: 0 }
  const run: GhRun = async ({ argv }) => {
    if (argv[0] === "pr" && argv[1] === "list") state.lists++
    if (argv[0] === "api" && argv[1] === "rate_limit") state.probes++
    if (state.fail) return { code: 1, out: "", err: state.fail }
    if (argv[0] === "pr" && argv[1] === "list") return { code: 0, out: JSON.stringify(state.prs), err: "" }
    if (argv[0] === "api" && argv[1] === "user") return { code: 0, out: "dev-ana\n", err: "" }
    if (argv[0] === "api" && argv[1] === "rate_limit") return { code: 0, out: "4999\n", err: "" }
    if (argv[0] === "api" && /comments\?since=/.test(argv[1] ?? "")) return { code: 0, out: "", err: "" }
    return { code: 1, out: "", err: "unexpected" }
  }
  return { run, state }
}

/** Two clocks: `awake` moves both, `sleep` only the wall clock (a suspended machine), as macOS and Linux keep them. */
function clocks() {
  const clock = { wall: 1_800_000_000_000, mono: 5_000 }
  return { clock, awake: (ms: number) => { clock.wall += ms; clock.mono += ms }, sleep: (ms: number) => { clock.wall += ms } }
}

function watcher({ outcome = () => undefined }: { outcome?: (job: RepoWatchJob) => JobOutcome } = {}) {
  const gh = fakeGh()
  const time = clocks()
  const notices: string[] = []
  const started: RepoWatchJob[] = []
  const watch = createRepoWatch({
    dir: temp(), run: gh.run, intervalMs: MINUTE, now: () => time.clock.wall, monotonic: () => time.clock.mono, random: () => 0.5,
    enabled: () => true, sessionExists: () => true, notify: (_session, text) => notices.push(text),
    triggers: async () => ({ opened: true, synchronize: true, ready_for_review: true, drafts: false }),
    start: async (job) => { started.push(job); return outcome(job) },
  })
  cleanups.push(() => watch.stop())
  /** A tick, then the jobs it started settled (a failed job's reachability probe is one more gh call). */
  const tick = async () => { await watch.tick(); await Bun.sleep(5) }
  return { watch, gh, notices, started, tick, ...time }
}

describe("what a failure says", () => {
  test("network, DNS, timeouts, 5xx and rate limits are transient; a missing repository or revoked access is permanent", () => {
    for (const reason of [OFFLINE, "dial tcp: lookup api.github.com: no such host", "Post \"https://api.github.com/graphql\": net/http: TLS handshake timeout", "HTTP 502: Bad Gateway (https://api.github.com/graphql)", "HTTP 503: Service Unavailable", "API rate limit exceeded for user ID 1. HTTP 403", "connect ENETUNREACH 140.82.112.6:443", "read: connection reset by peer", "gh timed out after 15 s waiting for GitHub"]) expect(failureKind(reason)).toBe("transient")
    for (const reason of ["GraphQL: Could not resolve to a Repository with the name 'acme/app'. (repository)", "HTTP 404: Not Found (https://api.github.com/repos/acme/app/pulls)", "HTTP 403: Resource not accessible by integration", "none of the git remotes configured for this repository point to a known GitHub host"]) expect(failureKind(reason)).toBe("permanent")
    expect(failureKind("git fetch of pull request #8 failed")).toBe("unknown")
  })
  test("sleep is wall time the monotonic clock did not see, or far past the expected gap; awake time never counts it", () => {
    expect(elapsed({ wall: 0, mono: 0 }, { wall: 4 * HOUR, mono: 30_000 })).toEqual({ wall: 4 * HOUR, awake: 30_000, slept: true })
    expect(elapsed({ wall: 0, mono: 0 }, { wall: MINUTE, mono: MINUTE })).toEqual({ wall: MINUTE, awake: MINUTE, slept: false })
    // No monotonic clock: a tick hours after the expected one was not hours of work either.
    expect(elapsed({ wall: 0 }, { wall: 4 * HOUR }, 2 * MINUTE)).toEqual({ wall: 4 * HOUR, awake: 2 * MINUTE, slept: true })
    expect(elapsed({ wall: 0 }, { wall: MINUTE + SLEEP_GAP_MS / 2 }, 2 * MINUTE).slept).toBe(false)
  })
})

describe("O3: a watch through a night asleep without network", () => {
  test("four hours of sleep with dark wakes offline never end the watch: it backs off, tells the session once, resumes by itself and reviews what was opened meanwhile", async () => {
    const w = watcher()
    w.gh.state.prs = [{ number: 1, headRefOid: sha(1) }]
    expect((await w.watch.watchRepo("ses_a", "/repo")).ok).toBe(true)
    await w.tick()
    // The lid closes; the network is gone from now on.
    w.gh.state.fail = OFFLINE
    // Ten awake minutes of failing, ticked every minute: the listings back off (1, 2, 4, 8 minutes apart).
    const before = w.gh.state.lists
    for (let minute = 0; minute < 10; minute++) { w.awake(MINUTE); await w.tick() }
    expect(w.gh.state.lists - before).toBeLessThan(6)
    // Four hours asleep, with a dark wake (30 s awake, no network) every 15 minutes, as pmset showed.
    for (let wake = 0; wake < 16; wake++) { w.sleep(15 * MINUTE - 30_000); w.awake(30_000); await w.tick() }
    // A PR opened while the laptop slept.
    w.gh.state.prs.push({ number: 2, headRefOid: sha(2) })
    expect(w.notices.some((text) => text.includes("ended"))).toBe(false)
    expect(w.watch.describe()).toContain("watching")
    // The session heard of the outage once, never that the watch ended.
    for (let minute = 0; minute < 20; minute++) { w.awake(MINUTE); await w.tick() }
    expect(w.notices.filter((text) => text.includes("could not list its pull requests"))).toHaveLength(1)
    expect(w.notices[0]).toContain("resumes by itself")
    expect(w.started).toEqual([])
    // Full wake, network back: the next due listing resumes the watch and reviews the PR opened during the outage.
    w.gh.state.fail = undefined
    for (let minute = 0; minute < 16 && !w.started.length; minute++) { w.awake(MINUTE); await w.tick() }
    expect(w.started.map((job) => job.kind === "review" ? [job.number, job.trigger] : [])).toEqual([[2, "opened"]])
    expect(w.notices.at(-1)).toContain("lists its pull requests again after")
    expect(w.watch.describe()).toContain("watching")
  })

  test("while it fails the watch lists again at most 15 minutes apart, and at once after the first failure", async () => {
    const w = watcher()
    await w.watch.watchRepo("ses_a", "/repo")
    w.gh.state.fail = OFFLINE
    const at: number[] = []
    for (let minute = 0; minute < 90; minute++) {
      const lists = w.gh.state.lists
      await w.tick()
      if (w.gh.state.lists > lists) at.push(minute)
      w.awake(MINUTE)
    }
    const gaps = at.slice(1).map((minute, index) => minute - at[index]!)
    expect(gaps.slice(0, 4)).toEqual([1, 2, 4, 8])
    expect(Math.max(...gaps)).toBe(OUTAGE_BACKOFF_CAP_MS / MINUTE)
  })

  test("only a permanent error for 15 awake minutes ends the watch, with its reason; a sleep between two such errors does not count", async () => {
    const w = watcher()
    await w.watch.watchRepo("ses_a", "/repo")
    w.gh.state.fail = "GraphQL: Could not resolve to a Repository with the name 'acme/app'. (repository)"
    await w.tick()
    w.sleep(4 * HOUR)
    w.awake(MINUTE)
    await w.tick()
    expect(w.watch.describe()).toContain("watching")
    for (let minute = 0; minute < OUTAGE_LIMIT_MS / MINUTE + 16 && !w.notices.length; minute++) { w.awake(MINUTE); await w.tick() }
    expect(w.notices).toHaveLength(1)
    expect(w.notices[0]).toContain("ended: gh could not list its pull requests for 15 minutes (GraphQL: Could not resolve to a Repository")
    expect(w.watch.describe()).toContain("ended (unreadable)")
  })

  test("the outage notice says the watch is waiting, not stopped (seen live: a session read it as \"stopped after 15 minutes\")", async () => {
    const w = watcher()
    await w.watch.watchRepo("ses_a", "/repo")
    w.gh.state.fail = OFFLINE
    for (let minute = 0; minute < 40 && !w.notices.length; minute++) { w.awake(MINUTE); await w.tick() }
    expect(w.notices).toHaveLength(1)
    expect(w.notices[0]).toContain("is waiting for GitHub: it could not list its pull requests for")
    expect(w.notices[0]).toContain("The watch has not stopped and needs nothing from you")
    expect(w.notices[0]).not.toMatch(/\b(ended|stopped after)\b/)
  })

  test("a push made during the outage is reviewed exactly once when GitHub answers again, at its newest head", async () => {
    const w = watcher()
    w.gh.state.prs = [{ number: 1, headRefOid: sha(1) }]
    await w.watch.watchRepo("ses_a", "/repo")
    await w.tick()
    const before = w.started.length
    w.gh.state.fail = OFFLINE
    for (let minute = 0; minute < 30; minute++) { w.awake(MINUTE); await w.tick() }
    // Two pushes while GitHub could not be reached: only the newest head is the work.
    w.gh.state.prs = [{ number: 1, headRefOid: sha(3) }]
    w.gh.state.fail = undefined
    for (let minute = 0; minute < 40; minute++) { w.awake(MINUTE); await w.tick() }
    const reviews = w.started.slice(before).flatMap((job) => job.kind === "review" ? [[job.number, job.head, job.trigger]] : [])
    expect(reviews).toEqual([[1, sha(3), "synchronize"]])
    expect(w.watch.describe()).toContain("watching")
  })
})

describe("O3: jobs through an outage", () => {
  const offlineError = "gh could not name the GitHub repository of /repo (error connecting to api.github.com)"
  /** A watch with one PR whose review fails while `down.now` is set, with `error` (offline in the live run). */
  async function failing(error: string) {
    const down = { now: true }
    const w = watcher({ outcome: () => down.now ? { error } : undefined })
    await w.watch.watchRepo("ses_a", "/repo")
    w.gh.state.prs = [{ number: 12, headRefOid: sha(12) }]
    await w.tick()
    const id = w.started[0]?.kind === "review" ? w.started[0].jobId! : ""
    return { w, down, id, job: () => w.watch.jobs.get(id)! }
  }

  test("a job failing on network errors for hours spends no attempt: it waits at most 15 minutes between tries and is done once the network is back", async () => {
    const { w, down, job } = await failing(offlineError)
    expect(job()).toMatchObject({ state: "waiting", attempts: 0, transient: { waits: 1 } })
    for (let hour = 0; hour < 6 * 4; hour++) {
      w.sleep(15 * MINUTE - 30_000)
      w.awake(30_000)
      await w.tick()
      const current = job()
      expect(current.attempts).toBe(0)
      if (current.state === "waiting") expect(current.notBefore! - w.clock.wall).toBeLessThanOrEqual(TRANSIENT_BACKOFF_CAP_MS)
    }
    expect(w.started.length).toBeGreaterThan(MAX_JOB_ATTEMPTS)
    expect(job().state).toBe("waiting")
    down.now = false
    w.awake(TRANSIENT_BACKOFF_CAP_MS)
    await w.tick()
    expect(job()).toMatchObject({ state: "done", attempts: 0 })
    expect(job().transient).toBeUndefined()
  })

  test("an unclear error while the forge cannot be reached is transient; the same error with the forge reachable spends an attempt", async () => {
    const { w, job } = await failing("git fetch of pull request #12 failed")
    // The fake gh answered the probe: the forge is reachable, so the failure is the job's own.
    expect(job()).toMatchObject({ state: "waiting", attempts: 1 })
    expect(w.gh.state.probes).toBe(1)
    w.gh.state.fail = OFFLINE
    w.awake(HOUR)
    await w.tick()
    expect(job()).toMatchObject({ state: "waiting", attempts: 1, transient: { waits: 1 } })
  })

  test("an unclear error from an attempt the machine slept through is transient", async () => {
    const down = { now: true }
    const time: { sleep?: (ms: number) => void } = {}
    const w = watcher({ outcome: () => { if (!down.now) return undefined; time.sleep?.(2 * HOUR); return { error: "git fetch of pull request #12 failed" } } })
    time.sleep = w.sleep
    await w.watch.watchRepo("ses_a", "/repo")
    w.gh.state.prs = [{ number: 12, headRefOid: sha(12) }]
    await w.tick()
    const id = w.started[0]?.kind === "review" ? w.started[0].jobId! : ""
    expect(w.watch.jobs.get(id)).toMatchObject({ state: "waiting", attempts: 0, transient: { waits: 1 } })
    // Not even asked: the sleep alone says the attempt did not fail on its own.
    expect(w.gh.state.probes).toBe(0)
  })

  test("past 24 hours of transient failures, attempts count again and the job fails after MAX_JOB_ATTEMPTS", async () => {
    const { w, job } = await failing(offlineError)
    const since = job().transient!.since
    while (w.clock.wall - since < TRANSIENT_RETRY_WINDOW_MS) { w.sleep(TRANSIENT_BACKOFF_CAP_MS); await w.tick() }
    for (let attempt = 0; attempt < MAX_JOB_ATTEMPTS + 2 && job().state !== "failed"; attempt++) { w.sleep(HOUR); await w.tick() }
    expect(job()).toMatchObject({ state: "failed", attempts: MAX_JOB_ATTEMPTS })
    // The session heard three times, each naming the PR and head and what happens next: the outage's first wait, the first
    // counted failure, and the end; the retries between are quiet.
    const told = w.notices.filter((text) => text.includes(`#12 at ${sha(12).slice(0, 12)}`))
    expect(told).toHaveLength(3)
    expect(told[0]).toMatch(/could not finish: .*it waits for the network and is tried again at \d{4}-\d\d-\d\d \d\d:\d\d UTC without spending an attempt \(5 attempts left\)\.$/)
    expect(told[1]).toMatch(/failed: .*It is tried again at \d{4}-\d\d-\d\d \d\d:\d\d UTC \(4 attempts left\)\.$/)
    expect(told[2]).toMatch(/failed: .*It is not tried again \(all 5 attempts spent\); \/reviews retries it\.$/)
  })
})
