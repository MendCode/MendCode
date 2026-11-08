import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PrReviewConfigView, PrReviewDashboard, type PrReviewerSummary } from "@mendcode/protocol"
import { createConfigControl } from "../src/pr-review/config-control"
import { gitRun } from "../src/pr-review/context"
import type { JobState, PlatformControlInput, PlatformHandle } from "../src/pr-review/contracts"
import { createPlatformControl } from "../src/pr-review/control"
import { createJobLedger } from "../src/pr-review/jobs"
import { release, takeOver } from "../src/pr-review/takeover"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); temps.push(dir); return dir }
const NOW = 1_800_000_000_000

const git = async (dir: string, ...args: string[]) => {
  const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], dir)
  if (done.code) throw new Error(`git ${args.join(" ")}`)
}

async function setup(options: { login?: string; reviewers?: PrReviewerSummary[]; tokens24h?: boolean; hungReviewers?: boolean } = {}) {
  const dataDir = temp("pr-control-data-")
  const checkout = temp("pr-control-repo-")
  await git(checkout, "init", "-q", "-b", "main")
  writeFileSync(path.join(checkout, "README.md"), "x\n")
  await git(checkout, "add", "-A")
  await git(checkout, "commit", "-q", "-m", "init")
  const jobs = createJobLedger({ file: path.join(dataDir, "pr-review", "jobs.json"), now: () => NOW })
  const retries: Array<{ jobId: string; reason: string }> = []
  const audits: Array<{ sessionId: string; directory: string }> = []
  const handle: PlatformHandle = {
    dataDir,
    jobs,
    device: () => "dev-here",
    rows: () => [{ directory: checkout, state: "watching", open: 3, publish: "allowed" }],
    concurrency: 2,
    repoOf: async () => "acme/app",
    loginOf: async () => options.login,
    reviewers: async () => options.hungReviewers ? await new Promise<never>(() => {}) : options.reviewers ?? [{ id: "global", scope: "global", areas: [], availability: "online" }],
    async retry(jobId, reason) {
      retries.push({ jobId, reason })
      jobs.transition(jobId, "pending")
      return { ok: true, text: `Retrying ${jobId}: ${reason}` }
    },
    async audit(input) { audits.push(input); return { ok: true, text: "Auditing the repository at HEAD.", jobId: "job_audit" } },
  }
  const configControl = createConfigControl({ dataDir, git: gitRun, now: () => NOW, repo: async () => "acme/app", login: async () => options.login })
  const control = createPlatformControl(handle, { configControl, takeover: { takeOver, release }, now: () => NOW, ...(options.tokens24h ? { tokens24h: () => ({ input: 7, output: 3, cached: 2 }) } : {}), reviewersMs: 50 })
  const add = (state: JobState = "pending", number = 12, directory = checkout) => jobs.upsert({ provider: "github", repo: "acme/app", directory, number, sessionId: "ses_watch", reviewer: "global", scope: "global", trigger: "opened", coverage: "full", base: "b".repeat(40), head: `${number}`.padEnd(40, "c"), configKey: "k", state, fixSessionId: "ses_fix" }).id
  const run = (input: Omit<PlatformControlInput, "sessionId" | "directory"> & { directory?: string }) => control.run({ sessionId: "ses_page", directory: checkout, ...input })
  return { checkout, dataDir, jobs, run, add, retries, audits }
}

describe("status", () => {
  test("answers the reviews page's dashboard: schema-valid, the watch's repository from its jobs, reviewers and concurrency", async () => {
    const { run, add } = await setup()
    add("running", 1)
    add("pending", 2)
    const done = await run({ action: "status" })
    if (!done.ok || !done.dashboard) throw new Error("no dashboard")
    expect(PrReviewDashboard.parse(done.dashboard)).toEqual(done.dashboard)
    expect(done.dashboard.watches[0]).toMatchObject({ repo: "acme/app", state: "watching", open: 3, provider: "github" })
    expect(done.dashboard.reviewers.map((reviewer) => reviewer.id)).toEqual(["global"])
    expect(done.dashboard.metrics).toMatchObject({ running: 1, queued: 1, concurrency: 2 })
    expect(done.dashboard.jobs).toHaveLength(2)
    expect(done.text).toContain("1 running, 1 queued")
    expect(done.text).toContain("at most 2 at once on this device (prReview.concurrency)")
  })

  test("the 24-hour tokens come from the accounting ledger when it is given, not from job totals", async () => {
    const { run, add } = await setup({ tokens24h: true })
    add("running")
    const done = await run({ action: "status" })
    expect(done.ok && done.dashboard?.metrics.tokens24h).toEqual({ input: 7, output: 3, cached: 2 })
  })

  test("a job this daemon owns says this device, never the device id; another device's id stays", async () => {
    const { run, jobs, checkout } = await setup()
    const base = { provider: "github" as const, repo: "acme/app", directory: checkout, sessionId: "ses_watch", reviewer: "global", scope: "global" as const, trigger: "opened" as const, coverage: "full" as const, base: "b".repeat(40), configKey: "k", state: "pending" as const }
    jobs.upsert({ ...base, number: 1, head: "1".padEnd(40, "c"), owner: "dev-here" })
    jobs.upsert({ ...base, number: 2, head: "2".padEnd(40, "c"), owner: "dev-other" })
    const done = await run({ action: "status" })
    if (!done.ok || !done.dashboard) throw new Error("no dashboard")
    expect(done.dashboard.jobs.map((job) => job.owner).sort()).toEqual(["dev-other", "this device"])
  })

  test("a checkout whose reviewers never answer does not hold the page: the jobs come back and the text names what is missing", async () => {
    const { run, add, checkout } = await setup({ hungReviewers: true })
    add("running")
    const done = await run({ action: "status" })
    if (!done.ok || !done.dashboard) throw new Error("no dashboard")
    expect(done.dashboard.jobs).toHaveLength(1)
    expect(done.dashboard.reviewers).toEqual([])
    expect(done.text).toContain(`Reviewers not read yet (the checkout did not answer in time): ${checkout}.`)
  })
})

describe("job actions", () => {
  test("pause keeps the reviewer in control and records who paused; resume queues it again", async () => {
    const { run, add, jobs } = await setup()
    const id = add("running")
    const paused = await run({ action: "job-pause", jobId: id })
    expect(paused).toMatchObject({ ok: true })
    expect(jobs.get(id)).toMatchObject({ state: "paused", control: "reviewer", stop: { kind: "user", resumable: true } })
    expect(await run({ action: "job-pause", jobId: id })).toMatchObject({ ok: false, message: expect.stringContaining("already paused") })
    expect(await run({ action: "job-resume", jobId: id })).toMatchObject({ ok: true })
    expect(jobs.get(id)).toMatchObject({ state: "pending", control: "reviewer" })
    expect(jobs.get(id)?.stop).toBeUndefined()
  })

  test("a job that does not exist, a missing jobId and a move the table forbids are refused with a clear text", async () => {
    const { run, add } = await setup()
    expect(await run({ action: "job-cancel", jobId: "job_nope" })).toMatchObject({ ok: false, message: expect.stringContaining("no job job_nope") })
    expect(await run({ action: "job-pause" })).toMatchObject({ ok: false, message: expect.stringContaining("needs jobId") })
    const done = add("done")
    expect(await run({ action: "job-pause", jobId: done })).toMatchObject({ ok: false, message: expect.stringContaining("is done; it cannot become paused") })
    expect(await run({ action: "job-resume", jobId: done })).toMatchObject({ ok: false, message: expect.stringContaining("not paused") })
    expect(await run({ action: "job-cancel", jobId: done })).toMatchObject({ ok: false, message: expect.stringContaining("already done") })
  })

  test("job-forget removes a finished review from the list and refuses a live one", async () => {
    const { run, add, jobs } = await setup()
    const live = add("waiting", 20)
    expect(await run({ action: "job-forget", jobId: live })).toMatchObject({ ok: false, message: expect.stringContaining("cancel it first") })
    const failed = add("failed", 21)
    expect(await run({ action: "job-forget", jobId: failed })).toMatchObject({ ok: true, text: expect.stringContaining("Removed") })
    expect(jobs.get(failed)).toBeUndefined()
  })

  test("cancel stops a live job for good (not resumable) and names the PR", async () => {
    const { run, add, jobs } = await setup()
    const id = add("waiting")
    const done = await run({ action: "job-cancel", jobId: id })
    expect(done).toMatchObject({ ok: true, text: expect.stringContaining("#12 of acme/app") })
    expect(jobs.get(id)).toMatchObject({ state: "cancelled", stop: { kind: "user", resumable: false } })
  })

  test("retry needs a reason and a finished-but-retryable job, then goes through the handle", async () => {
    const { run, add, retries } = await setup()
    const failed = add("failed")
    expect(await run({ action: "job-retry", jobId: failed })).toMatchObject({ ok: false, message: expect.stringContaining("needs a reason") })
    expect(await run({ action: "job-retry", jobId: failed, reason: "  " })).toMatchObject({ ok: false, message: expect.stringContaining("needs a reason") })
    expect(await run({ action: "job-retry", jobId: failed, reason: "gh was down" })).toMatchObject({ ok: true, text: expect.stringContaining("gh was down") })
    expect(retries).toEqual([{ jobId: failed, reason: "gh was down" }])
    const running = add("running", 13)
    expect(await run({ action: "job-retry", jobId: running, reason: "again" })).toMatchObject({ ok: false, message: expect.stringContaining("only a failed, cancelled, stale or checkpointed job") })
    expect(retries).toHaveLength(1)
  })

  test("a job of another checkout than the session's is acted on (local-only command, the page lists every watch's jobs)", async () => {
    const { run, add, jobs } = await setup()
    const elsewhere = temp("pr-control-other-")
    const id = add("pending", 30, elsewhere)
    expect(await run({ action: "job-pause", jobId: id })).toMatchObject({ ok: true })
    expect(jobs.get(id)?.state).toBe("paused")
  })
})

describe("take-over", () => {
  test("a single writer: the holder is named, pause/resume/second take-over are refused, only release hands it back", async () => {
    const { run, add, jobs } = await setup({ login: "nora" })
    const id = add("fixing")
    const taken = await run({ action: "take-over", jobId: id })
    // Bun's toMatchObject with an asymmetric matcher replaces the matched value in the received object: plain checks first.
    expect(taken.ok && taken.text).toContain("ses_fix")
    expect(taken.ok && taken.text).toContain("You (nora) hold")
    expect(jobs.get(id)).toMatchObject({ state: "paused", control: "user" })
    expect(await run({ action: "take-over", jobId: id })).toMatchObject({ ok: false, message: expect.stringContaining("already taken over by nora") })
    expect(await run({ action: "job-resume", jobId: id })).toMatchObject({ ok: false, message: expect.stringContaining("taken over by nora; release it") })
    expect(await run({ action: "job-pause", jobId: id })).toMatchObject({ ok: false, message: expect.stringContaining("taken over by nora") })
    expect(await run({ action: "release", jobId: id })).toMatchObject({ ok: true })
    expect(jobs.get(id)).toMatchObject({ state: "pending", control: "reviewer" })
    expect(await run({ action: "release", jobId: id })).toMatchObject({ ok: false, message: expect.stringContaining("not taken over") })
  })

  test("someone else's hold is not released", async () => {
    const { run, add, jobs } = await setup({ login: "omar" })
    const id = add("running")
    takeOver({ ledger: jobs, jobId: id, now: () => NOW, by: "nora" })
    expect(await run({ action: "release", jobId: id })).toMatchObject({ ok: false, message: expect.stringContaining("held by nora, not omar") })
    expect(jobs.get(id)?.control).toBe("user")
  })

  test("a finished job has nothing to take over", async () => {
    const { run, add } = await setup()
    expect(await run({ action: "take-over", jobId: add("done") })).toMatchObject({ ok: false, message: expect.stringContaining("open its session directly") })
  })
})

describe("audit and config", () => {
  test("audit goes to the handle with the session and its checkout", async () => {
    const { run, audits, checkout } = await setup()
    expect(await run({ action: "audit" })).toMatchObject({ ok: true, text: "Auditing the repository at HEAD." })
    expect(audits).toEqual([{ sessionId: "ses_page", directory: checkout }])
  })

  test("without scope the answer names both targets and changes nothing; it is never read as either", async () => {
    const { run } = await setup({ login: "alice" })
    const done = await run({ action: "config-apply", patch: { cap: 3 } })
    expect(done.ok).toBe(false)
    expect(done.ok ? "" : done.message).toContain("Which reviewer's config?")
    expect(done.ok ? "" : done.message).toContain("- global:")
    expect(done.ok ? "" : done.message).toContain("- personal:")
  })

  test("with scope the config view comes back, and a jobId reads that job's checkout", async () => {
    const { run, add } = await setup({ login: "alice" })
    const other = temp("pr-control-cfg-")
    await git(other, "init", "-q", "-b", "main")
    const shown = await run({ action: "config-show", scope: "global" })
    if (!shown.ok || !shown.config) throw new Error("no config view")
    expect(PrReviewConfigView.parse(shown.config).scope).toBe("global")
    const id = add("pending", 40, other)
    const viaJob = await run({ action: "config-show", scope: "global", jobId: id })
    expect(viaJob.ok && viaJob.config?.target).toBe(path.join(other, ".mendcode", "review.yaml"))
    const personal = await run({ action: "config-show", scope: "personal" })
    expect(personal.ok && personal.config).toMatchObject({ scope: "personal", repo: "acme/app", login: "alice" })
  })

  test("a watch action is not a platform action", async () => {
    const { run } = await setup()
    expect(await run({ action: "watch-repo" })).toMatchObject({ ok: false, message: expect.stringContaining("not a review platform action") })
  })
})
