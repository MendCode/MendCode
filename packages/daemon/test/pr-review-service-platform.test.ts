import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PrFinding, PrReviewResult } from "@mendcode/protocol"
import type { GhRun } from "../src/pr-watch"
import type { AuditRun } from "../src/pr-review/audit"
import { parseReviewConfig } from "../src/pr-review/config"
import { gitRun } from "../src/pr-review/context"
import type { JobCheckpoint } from "../src/pr-review/contracts"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { createJobLedger } from "../src/pr-review/jobs"
import type { GhCall } from "../src/pr-review/publish"
import type { ReviewRun, RunPrReviewInput } from "../src/pr-review/run"
import { createPrReviewService } from "../src/pr-review/service"
import { emptyState } from "../src/pr-review/state"

/**
 * The service's platform wiring (wave 2): durable job lifecycle, eligibility and routing in the poll, stacks, quota waits and
 * checkpoint resume, fix push gating and the audit. The review run itself (run.ts) is stood in for through the `review` seam, so
 * these tests see exactly what the service hands a run and what it does with each answer. Git is real (temp repositories); gh is
 * a fake that never reaches the network.
 */

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const until = async (check: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await Bun.sleep(10) } }

const git = async (cwd: string, ...args: string[]) => { const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd); if (done.code) throw new Error(`git ${args.join(" ")}: ${done.out}`); return done.out.trim() }

type Pr = { number: number; branch: string; baseRef: string; labels?: string[]; requested?: string[] }

/** A bare origin and a clone; PRs are branches pushed to `refs/heads/<branch>` and `refs/pull/<n>/head`, as GitHub keeps them. */
async function repository(yaml: string) {
  const origin = temp("svc-origin-"), dir = temp("svc-clone-")
  await git(origin, "init", "-q", "--bare", "-b", "main")
  await git(dir, "init", "-q", "-b", "main")
  await git(dir, "config", "user.name", "t")
  await git(dir, "config", "user.email", "t@example.invalid")
  await git(dir, "config", "commit.gpgsign", "false")
  mkdirSync(path.join(dir, ".mendcode"))
  writeFileSync(path.join(dir, ".mendcode", "review.yaml"), yaml)
  writeFileSync(path.join(dir, "a.ts"), "export const one = 1\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  const main = await git(dir, "rev-parse", "HEAD")
  await git(dir, "remote", "add", "origin", origin)
  await git(dir, "push", "-q", "origin", "main")
  /** Commits `content` on `branch` (created from `from` the first time) and pushes it as PR `number`'s head. */
  async function push(number: number, branch: string, content: string, from = "main") {
    const exists = (await gitRun(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], dir)).code === 0
    await git(dir, "checkout", "-q", ...(exists ? [branch] : ["-b", branch, from]))
    writeFileSync(path.join(dir, `${branch}.ts`), content)
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", `${branch}: ${content.trim()}`)
    await git(dir, "push", "-q", "-f", "origin", `${branch}:refs/heads/${branch}`, `${branch}:refs/pull/${number}/head`)
    const sha = await git(dir, "rev-parse", "HEAD")
    await git(dir, "checkout", "-q", "main")
    return sha
  }
  return { origin, dir, main, push }
}

/** A fake gh over the temp origin: heads are read from the origin's branches, so a push (a fix included) is what gh reports. */
function fakeGh({ origin, main }: { origin: string; main: string }) {
  const prs: Pr[] = []
  const posts: string[][] = []
  const calls: string[][] = []
  const tip = async (branch: string) => (await gitRun(["rev-parse", `refs/heads/${branch}`], origin)).out.trim()
  const shape = async (pr: Pr) => ({
    number: pr.number, headRefOid: await tip(pr.branch), baseRefOid: pr.baseRef === "main" ? main : await tip(pr.baseRef), baseRefName: pr.baseRef, headRefName: pr.branch,
    url: `https://github.com/acme/app/pull/${pr.number}`, title: `PR ${pr.number}`, author: { login: "bob" }, labels: (pr.labels ?? []).map((name) => ({ name })),
    reviewRequests: (pr.requested ?? []).map((login) => ({ login })), assignees: [], isDraft: false, isCrossRepository: false, maintainerCanModify: true,
  })
  const run: GhRun = async ({ argv }) => {
    calls.push(argv)
    if (argv[0] === "repo") return { code: 0, out: "acme/app", err: "" }
    if (argv.join(" ") === "api user --jq .login") return { code: 0, out: "ana", err: "" }
    if (argv[0] === "pr" && argv[1] === "list") return { code: 0, out: JSON.stringify(await Promise.all(prs.map(shape))), err: "" }
    if (argv[0] === "pr" && argv[1] === "view") {
      const pr = prs.find((item) => item.number === Number(argv[2]))
      if (!pr) return { code: 1, out: "", err: "no pull request" }
      return { code: 0, out: JSON.stringify({ ...await shape(pr), body: "", files: [{ path: `${pr.branch}.ts` }] }), err: "" }
    }
    if (argv[0] === "api" && /comments\?since=/.test(argv[1] ?? "")) return { code: 0, out: "", err: "" }
    return { code: 1, out: "", err: "unexpected" }
  }
  const call: GhCall = async ({ argv }) => {
    calls.push(argv)
    if (argv.includes("POST")) { posts.push(argv); return { code: 0, out: JSON.stringify({ id: posts.length }) } }
    if (argv[1]?.endsWith("/permission")) return { code: 0, out: JSON.stringify({ permission: "write" }) }
    if (/^repos\/acme\/app\/pulls\/\d+$/.test(argv[1] ?? "") && argv.includes(".state")) return { code: 0, out: "open" }
    return { code: 0, out: "[]" }
  }
  return { prs, posts, calls, run, call, tip }
}

const finding = (summary = "one is now 2"): PrFinding => ({ id: "a".repeat(40), path: "feature.ts", line: 1, side: "RIGHT", severity: "major", category: "correctness", summary, detail: "Callers expect 1.", evidence: ["feature.ts:1"], verdict: "confirmed" })
const result = (head: string, base: string, findings: PrFinding[] = []): PrReviewResult => ({ head, base, findings, dropped: 0, summary: findings.length ? "One finding." : "No findings.", tokens: { input: 100, output: 10 }, budgetHit: false })
const checkpointOf = (head: string, base: string, extra: Partial<JobCheckpoint> = {}): JobCheckpoint => ({ completedPhases: ["discovery"], candidates: [], verified: [], result: result(head, base), rounds: [], decisions: [{ phase: "discovery", action: "kept", reason: "preset" }], ...extra })

type Answer = (input: RunPrReviewInput, call: number) => Partial<ReviewRun> & Pick<ReviewRun, "status">

function harness({ repo, yaml, answer, now, audit }: { repo: Awaited<ReturnType<typeof repository>>; yaml: string; answer: Answer; now?: () => number; audit?: (input: { directory: string; head?: string }) => Promise<AuditRun> }) {
  const gh = fakeGh(repo)
  const data = temp("svc-data-")
  const notices: string[] = []
  const inputs: RunPrReviewInput[] = []
  const config = parseReviewConfig(yaml).config
  const sessions = (): ReviewSessionFactory => async () => ({ async send() { return { text: "{}", tokens: { input: 1, output: 1 } } }, async close() {} })
  /** The fix session: edits the worktree it is given, as a real agent would. */
  const editor = (_owner: string, worktree: string): ReviewSessionFactory => async () => ({ id: "ses_fix", async send() { writeFileSync(path.join(worktree, "feature.ts"), "export const one = 1\n"); return { text: "fixed", tokens: { input: 5, output: 5 } } }, async close() {} }) as never
  const service = createPrReviewService({
    dir: data, run: gh.run, call: gh.call, intervalMs: 3_600_000, ...(now ? { now } : {}), enabled: () => true, graphOn: () => false,
    sessionDirectory: () => repo.dir, sessionExists: () => true, notify: (_session, text) => notices.push(text), sessions, editor,
    schedule: async (job) => { await job() }, random: () => 0.5,
    review: async (input) => { inputs.push(input); const reply = answer(input, inputs.length); return { state: emptyState(), incremental: false, config, ...reply } as ReviewRun },
    ...(audit ? { audit: audit as never } : {}),
  })
  cleanups.push(() => service.stop())
  const jobs = () => service.platform.jobs.all()
  return { service, gh, data, notices, inputs, jobs }
}

describe("review jobs through the service", () => {
  test("a new PR is routed (reason on the job), reviewed once as a durable job with its owner, publish identity, tokens and checkpoint, and ends done", async () => {
    const repo = await repository("enabled: true\n")
    const h = harness({ repo, yaml: "enabled: true\n", answer: (input) => { input.account?.({ purpose: "review", tokens: { input: 100, output: 10 } }); return { status: "reviewed", configKey: "k", checkpoint: checkpointOf(input.head, input.base) } } })
    expect((await h.service.control({ sessionId: "ses_a", action: "watch-repo" })).ok).toBe(true)
    await repo.push(12, "feature", "export const one = 2\n")
    h.gh.prs.push({ number: 12, branch: "feature", baseRef: "main" })
    await h.service.tick()
    await until(() => h.jobs().some((job) => job.state === "done"))
    const [job] = h.jobs()
    expect(job).toMatchObject({ number: 12, reviewer: "global", scope: "global", trigger: "opened", assignment: "the repository's global reviewer", owner: h.service.platform.device(), state: "done", tokens: { input: 100, output: 10 } })
    expect(job!.checkpoint.decisions).toEqual([{ phase: "discovery", action: "kept", reason: "preset" }])
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]!.reviewer).toEqual({ id: "global", scope: "global", login: "ana" })
    expect(h.inputs[0]!.publishAs).toMatchObject({ reviewer: "global", jobId: job!.id, self: "ana" })
    expect(h.inputs[0]!.checkpoint).toBeUndefined()
    expect(h.service.platform.accounting.totals({ repo: "acme/app", number: 12, head: job!.head, reviewer: "global" })?.tokens).toMatchObject({ input: 100, output: 10 })
    // An idle poll after the review queues nothing new.
    await h.service.tick()
    expect(h.jobs()).toHaveLength(1)
  })

  test("a job a stopped daemon left running is recovered by the next service and reviewed exactly once", async () => {
    const repo = await repository("enabled: true\n")
    const head = await repo.push(12, "feature", "export const one = 2\n")
    const data = temp("svc-recover-")
    const ledger = createJobLedger({ file: path.join(data, "pr-review", "jobs.json") })
    const left = ledger.upsert({ provider: "github", repo: "acme/app", directory: repo.dir, number: 12, sessionId: "ses_a", reviewer: "global", scope: "global", trigger: "synchronize", coverage: "incremental", base: repo.main, head, configKey: "", state: "running" })
    const gh = fakeGh(repo)
    gh.prs.push({ number: 12, branch: "feature", baseRef: "main" })
    let calls = 0
    const sessions = (): ReviewSessionFactory => async () => ({ async send() { return { text: "{}", tokens: { input: 1, output: 1 } } }, async close() {} })
    const service = createPrReviewService({
      dir: data, run: gh.run, call: gh.call, intervalMs: 3_600_000, enabled: () => true, graphOn: () => false, sessionDirectory: () => repo.dir, sessionExists: () => true,
      notify: () => undefined, sessions, editor: sessions, schedule: async (job) => { await job() },
      review: async () => { calls++; return { status: "reviewed", state: emptyState(), incremental: false } },
    })
    cleanups.push(() => service.stop())
    await until(() => service.platform.jobs.get(left.id)?.state === "done")
    expect(service.platform.jobs.get(left.id)).toMatchObject({ state: "done", attempts: 1 })
    await service.tick()
    expect(calls).toBe(1)
  })

  test("a job whose PR moved to a newer head before it ran ends stale: nothing is reviewed or posted for the old head", async () => {
    const repo = await repository("enabled: true\n")
    const old = await repo.push(12, "feature", "export const one = 2\n")
    await repo.push(12, "feature", "export const one = 3\n")
    const h = harness({ repo, yaml: "enabled: true\n", answer: () => ({ status: "reviewed" }) })
    h.gh.prs.push({ number: 12, branch: "feature", baseRef: "main" })
    const job = h.service.platform.jobs.upsert({ provider: "github", repo: "acme/app", directory: repo.dir, number: 12, sessionId: "ses_a", reviewer: "global", scope: "global", trigger: "synchronize", coverage: "incremental", base: repo.main, head: old, configKey: "" })
    await h.service.tick()
    await until(() => h.service.platform.jobs.get(job.id)?.state === "stale")
    expect(h.service.platform.jobs.get(job.id)!.stop).toMatchObject({ kind: "superseded", resumable: false })
    expect(h.inputs).toHaveLength(0)
    expect(h.gh.posts).toEqual([])
  })

  test("a failure the run marks retryable backs off; any other failure fails the job at once", async () => {
    const repo = await repository("enabled: true\n")
    await repo.push(12, "feature", "export const one = 2\n")
    await repo.push(13, "other", "export const two = 2\n")
    const h = harness({ repo, yaml: "enabled: true\n", answer: (input) => input.number === 12 ? { status: "failed", reason: "GitHub did not confirm the review", retryable: true } : { status: "failed", reason: "verification failed; nothing was published" } })
    h.gh.prs.push({ number: 12, branch: "feature", baseRef: "main" }, { number: 13, branch: "other", baseRef: "main" })
    expect((await h.service.control({ sessionId: "ses_a", action: "review", pr: "12" })).ok).toBe(true)
    expect((await h.service.control({ sessionId: "ses_a", action: "review", pr: "13" })).ok).toBe(true)
    await until(() => h.jobs().every((job) => job.state === "waiting" || job.state === "failed") && h.jobs().length === 2)
    const byNumber = (number: number) => h.jobs().find((job) => job.number === number)!
    expect(byNumber(12)).toMatchObject({ state: "waiting", attempts: 1, error: "GitHub did not confirm the review" })
    expect(byNumber(12).notBefore).toBeGreaterThan(Date.now())
    expect(byNumber(13)).toMatchObject({ state: "failed", error: "verification failed; nothing was published" })
  })
})

describe("held reviews", () => {
  test("a review held for /pr publish on is not posted once the PR moved past its head", async () => {
    const repo = await repository("enabled: true\n")
    await repo.push(12, "feature", "export const one = 2\n")
    const h = harness({ repo, yaml: "enabled: true\n", answer: (input) => ({ status: "reviewed", outcome: { result: result(input.head, input.base, [finding()]) } as never, checkpoint: checkpointOf(input.head, input.base) }) })
    h.gh.prs.push({ number: 12, branch: "feature", baseRef: "main" })
    await h.service.control({ sessionId: "ses_a", action: "review", pr: "12" })
    await until(() => h.notices.some((text) => text.includes("never posted a review to acme/app")))
    await repo.push(12, "feature", "export const one = 3\n")
    const yes = await h.service.control({ sessionId: "ses_a", action: "publish-on" })
    expect(yes.ok && yes.text).toContain("posting 1 held review")
    await until(() => h.notices.some((text) => text.startsWith("The held review")))
    expect(h.notices.find((text) => text.startsWith("The held review"))).toContain("was not posted: the pull request moved past")
    expect(h.gh.posts).toEqual([])
  })
})

describe("stops, quota waits and checkpoints", () => {
  test("a quota stop keeps the checkpoint, waits for the reset with the reason in the session, and resumes from the checkpoint", async () => {
    let clock = Date.parse("2026-10-30T10:00:00Z")
    const repo = await repository("enabled: true\n")
    const head = await repo.push(12, "feature", "export const one = 2\n")
    const kept = checkpointOf(head, repo.main, { completedPhases: ["discovery", "analysis"], candidates: [{ ...finding(), verdict: undefined }] })
    const resetsAt = clock + 30 * 60_000
    const h = harness({
      repo, yaml: "enabled: true\n", now: () => clock,
      answer: (_input, call) => call === 1
        ? { status: "reviewed", reason: "review incomplete (quota); nothing was published", stop: { kind: "quota", detail: "You've hit your usage limit", resetsAt, resumable: true }, checkpoint: kept }
        : { status: "reviewed", checkpoint: checkpointOf(head, repo.main) },
    })
    h.gh.prs.push({ number: 12, branch: "feature", baseRef: "main" })
    await h.service.control({ sessionId: "ses_a", action: "review", pr: "12" })
    await until(() => h.jobs()[0]?.state === "waiting")
    const waiting = h.jobs()[0]!
    expect(waiting.stop).toMatchObject({ kind: "quota", resumable: true })
    expect(waiting.notBefore).toBe(resetsAt + 3_000)
    expect(waiting.checkpoint.candidates).toHaveLength(1)
    const notice = h.notices.find((text) => text.includes("waits"))!
    expect(notice).toContain("Stopped at the provider's usage limit")
    expect(notice).toContain("Waiting for the quota reset at 2026-10-30 10:30 UTC")
    // Before the reset nothing runs; after it the job resumes with what it had found.
    await h.service.tick()
    expect(h.inputs).toHaveLength(1)
    clock = resetsAt + 5_000
    await h.service.tick()
    await until(() => h.jobs()[0]?.state === "done")
    expect(h.inputs).toHaveLength(2)
    expect(h.inputs[1]!.checkpoint).toEqual(kept)
  })

  test("a budget stop is checkpointed (no wait), and a retry from the reviews page hands the checkpoint back to the run", async () => {
    const repo = await repository("enabled: true\n")
    const head = await repo.push(12, "feature", "export const one = 2\n")
    const kept = checkpointOf(head, repo.main, { candidates: [{ ...finding(), verdict: undefined }] })
    const h = harness({
      repo, yaml: "enabled: true\n",
      answer: (_input, call) => call === 1 ? { status: "reviewed", stop: { kind: "budget", detail: "token budget reached", unit: "tokens", used: 1_000_000, limit: 1_000_000, resumable: true }, checkpoint: kept } : { status: "reviewed" },
    })
    h.gh.prs.push({ number: 12, branch: "feature", baseRef: "main" })
    await h.service.control({ sessionId: "ses_a", action: "review", pr: "12" })
    await until(() => h.jobs()[0]?.state === "checkpointed")
    expect(h.jobs()[0]!.notBefore).toBeUndefined()
    expect(h.notices.some((text) => text.includes("Stopped at MendCode's token budget"))).toBe(true)
    const retried = await h.service.control({ sessionId: "ses_a", action: "job-retry", jobId: h.jobs()[0]!.id, reason: "raised the budget" })
    expect(retried.ok && retried.text).toContain("continuing from its checkpoint")
    await until(() => h.jobs()[0]?.state === "done")
    expect(h.inputs[1]!.checkpoint).toEqual(kept)
  })
})

describe("eligibility and routing in the poll", () => {
  test("a PR the repository's mode does not take is not queued; the reason is kept for /pr list, not sent as a notice", async () => {
    const yaml = "enabled: true\nmode: labels\nfilters:\n  labels:\n    include: [review-me]\n"
    const repo = await repository(yaml)
    const h = harness({ repo, yaml, answer: () => ({ status: "reviewed" }) })
    await h.service.control({ sessionId: "ses_a", action: "watch-repo" })
    await repo.push(12, "feature", "export const one = 2\n")
    await repo.push(13, "other", "export const two = 2\n")
    h.gh.prs.push({ number: 12, branch: "feature", baseRef: "main" }, { number: 13, branch: "other", baseRef: "main", labels: ["review-me"] })
    const before = h.notices.length
    await h.service.tick()
    await until(() => h.jobs().some((job) => job.state === "done"))
    expect(h.jobs().map((job) => job.number)).toEqual([13])
    expect(h.notices.slice(before).some((text) => text.includes("#12"))).toBe(false)
    const list = await h.service.control({ sessionId: "ses_a", action: "list" })
    expect(list.ok && list.text).toContain("1 not reviewed (#12: labels: none of `review-me` is on the pull request)")
  })

  test("a requested watch is its login's personal reviewer: at start it catches up on a PR already requesting it, routed with the reason", async () => {
    const repo = await repository("enabled: true\n")
    await repo.push(12, "feature", "export const one = 2\n")
    await repo.push(13, "other", "export const two = 2\n")
    const h = harness({ repo, yaml: "enabled: true\n", answer: () => ({ status: "reviewed" }) })
    h.gh.prs.push({ number: 12, branch: "feature", baseRef: "main", requested: ["ana"] }, { number: 13, branch: "other", baseRef: "main", requested: ["carol"] })
    expect((await h.service.control({ sessionId: "ses_a", action: "watch-repo", role: "requested" })).ok).toBe(true)
    await h.service.tick()
    await until(() => h.jobs().some((job) => job.state === "done"))
    expect(h.jobs()).toHaveLength(1)
    expect(h.jobs()[0]).toMatchObject({ number: 12, reviewer: "personal:ana", scope: "personal", trigger: "requested" })
    expect(h.jobs()[0]!.assignment).toContain("review requested from @ana")
    expect(h.jobs()[0]!.assignment).toContain("not reviewed yet")
    expect(h.inputs[0]!.reviewer).toEqual({ id: "personal:ana", scope: "personal", login: "ana" })
    // Caught up once: the next poll does not queue it again.
    await h.service.tick()
    expect(h.jobs()).toHaveLength(1)
  })

  test("reviewers.yaml routes by area: the reason names the area, and a PR routed only to someone else's personal reviewer is not this watch's", async () => {
    const yaml = "enabled: true\n"
    const repo = await repository(yaml)
    writeFileSync(path.join(repo.dir, ".mendcode", "reviewers.yaml"), "reviewers:\n  - id: backend\n    scope: global\n    areas: [\"feature.ts\"]\n  - id: carol\n    scope: personal\n    login: carol\nrouting:\n  global: personal-only\n  fallback: backend\n")
    await git(repo.dir, "add", "-A")
    await git(repo.dir, "commit", "-q", "-m", "reviewers")
    const h = harness({ repo, yaml, answer: () => ({ status: "reviewed" }) })
    await h.service.control({ sessionId: "ses_a", action: "watch-repo" })
    await repo.push(12, "feature", "export const one = 2\n")
    await repo.push(13, "other", "export const two = 2\n")
    h.gh.prs.push({ number: 12, branch: "feature", baseRef: "main" }, { number: 13, branch: "other", baseRef: "main", requested: ["carol"] })
    await h.service.tick()
    await until(() => h.jobs().some((job) => job.state === "done"))
    // carol's PR is not run here: it is recorded as waiting for carol's own MendCode (R02), never run or failed.
    expect(h.jobs().map((job) => [job.number, job.reviewer, job.state])).toEqual([[12, "backend", "done"], [13, "carol", "waiting"]])
    expect(h.jobs()[0]!.assignment).toContain("touches feature.ts (backend)")
    expect(h.jobs()[1]!.assignment).toBe("waiting for @carol's MendCode (offline or another device); it reviews when that daemon runs · assigned: review requested from @carol")
    expect(h.inputs.map((input) => input.number)).toEqual([12])
    const list = await h.service.control({ sessionId: "ses_a", action: "list" })
    expect(list.ok && list.text).toContain("#13: routed to carol (review requested from @carol), not to this daemon")
  })
})

describe("stacks", () => {
  test("a parent's new head revalidates its stacked child (trigger stack), whose run starts at the parent's head", async () => {
    // The PRs open at the start stay the baseline (no backlog), so only the stack event queues a review.
    const repo = await repository("enabled: true\nbacklog:\n  max_prs: 0\n")
    await repo.push(12, "feature", "export const one = 2\n")
    await repo.push(13, "child", "export const two = 2\n", "feature")
    const h = harness({ repo, yaml: "enabled: true\ncooldown:\n  pr_minutes: 0\nbacklog:\n  max_prs: 0\n", answer: () => ({ status: "reviewed" }) })
    h.gh.prs.push({ number: 12, branch: "feature", baseRef: "main" }, { number: 13, branch: "child", baseRef: "feature" })
    await h.service.control({ sessionId: "ses_a", action: "watch-repo" })
    await h.service.tick()
    expect(h.jobs()).toHaveLength(0)
    const moved = await repo.push(12, "feature", "export const one = 3\n")
    await h.service.tick()
    await until(() => h.jobs().length === 2 && h.jobs().every((job) => job.state === "done"))
    const child = h.jobs().find((job) => job.number === 13)!
    expect(child).toMatchObject({ trigger: "stack", stack: { parent: 12, children: [], depth: 1 } })
    expect(child.assignment).toContain("stack: #12 head")
    const run = h.inputs.find((input) => input.number === 13)!
    expect(run.stack).toEqual({ base: moved, parentFindings: [], parent: 12 })
    expect(run.onlyIfPublishable).toBe(true)
  })
})

describe("fix modes", () => {
  // No backlog: the open PR is reviewed only by the `/pr review` each test asks for.
  const yaml = (push: boolean) => `enabled: true\nfixes: true\nfix:\n  mode: fix-once\n  push: ${push}\nbacklog:\n  max_prs: 0\n`
  const reviewWithFinding: Answer = (input, call) => call === 1
    ? { status: "reviewed", config: parseReviewConfig(yaml(false)).config, outcome: { result: result(input.head, input.base, [finding()]) } as never }
    : { status: "reviewed", outcome: { result: result(input.head, input.base) } as never }

  test("fix.push off: the automatic fix is committed and kept on a local ref, the branch is not pushed", async () => {
    const repo = await repository(yaml(false))
    const head = await repo.push(12, "feature", "export const one = 2\n")
    const h = harness({ repo, yaml: yaml(false), answer: reviewWithFinding })
    h.gh.prs.push({ number: 12, branch: "feature", baseRef: "main" })
    await h.service.control({ sessionId: "ses_a", action: "publish-on" })
    await h.service.control({ sessionId: "ses_a", action: "review", pr: "12" })
    await until(() => h.notices.some((text) => text.includes("fix mode ended")), 10_000)
    expect(await h.gh.tip("feature")).toBe(head)
    expect((await gitRun(["for-each-ref", "--format=%(refname)", "refs/mendcode/fix/12/"], repo.dir)).out.trim()).not.toBe("")
    expect(h.notices.find((text) => text.includes("fix mode fix-once"))).toContain("`fix.push` is off")
    expect(h.jobs()[0]).toMatchObject({ state: "done", stop: { kind: "permission" }, fixSessionId: "ses_fix" })
    expect(h.inputs).toHaveLength(1)
  })

  test("fix.push on with posting allowed: the fix is pushed once, the job follows the new head, and the watch does not queue a second review of it", async () => {
    const repo = await repository(yaml(true))
    const head = await repo.push(12, "feature", "export const one = 2\n")
    const answer: Answer = (input, call) => call === 1
      ? { status: "reviewed", config: parseReviewConfig(yaml(true)).config, outcome: { result: result(input.head, input.base, [finding()]) } as never }
      : { status: "reviewed", config: parseReviewConfig(yaml(true)).config, outcome: { result: result(input.head, input.base) } as never }
    const h = harness({ repo, yaml: yaml(true), answer })
    h.gh.prs.push({ number: 12, branch: "feature", baseRef: "main" })
    await h.service.control({ sessionId: "ses_a", action: "watch-repo" })
    await h.service.control({ sessionId: "ses_a", action: "publish-on" })
    await h.service.control({ sessionId: "ses_a", action: "review", pr: "12" })
    await until(() => h.notices.some((text) => text.includes("fix mode ended")), 10_000)
    const pushed = await h.gh.tip("feature")
    expect(pushed).not.toBe(head)
    expect(await git(repo.dir, "rev-parse", `${pushed}^`)).toBe(head)
    expect(h.jobs()[0]).toMatchObject({ state: "done", head: pushed })
    // The second review looked at the pushed head; the next poll sees that head as already seen.
    expect(h.inputs.map((input) => input.head)).toEqual([head, pushed])
    // The user's own `/pr review` keeps its result in the session; the fix round's re-review asks whether it can post before any model call.
    expect(h.inputs.map((input) => input.onlyIfPublishable)).toEqual([false, true])
    await h.service.tick()
    expect(h.jobs()).toHaveLength(1)
  })
})

describe("audit", () => {
  test("an audit runs as a job and its findings stay in the session: nothing is posted, no pull request is read", async () => {
    const repo = await repository("enabled: true\n")
    const audited: Array<{ directory: string; head?: string }> = []
    const h = harness({
      repo, yaml: "enabled: true\n", answer: () => ({ status: "reviewed" }),
      audit: async (input) => { audited.push(input); return { status: "reviewed", coverage: "audit", base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", head: input.head!, files: 2, cut: [], text: "Audit of the checkout: kept in this session, never posted.\n- a.ts:1 major correctness: something" } },
    })
    const started = await h.service.control({ sessionId: "ses_a", action: "audit" })
    expect(started.ok).toBe(true)
    await until(() => h.jobs()[0]?.state === "done")
    expect(audited).toEqual([expect.objectContaining({ directory: repo.dir, head: repo.main })])
    expect(h.jobs()[0]).toMatchObject({ coverage: "audit", state: "done" })
    expect(h.notices.some((text) => text.startsWith("Audit of the checkout: kept in this session, never posted."))).toBe(true)
    expect(h.gh.posts).toEqual([])
    expect(h.gh.calls.some((argv) => argv[0] === "pr")).toBe(false)
    expect(h.inputs).toHaveLength(0)
  })
})

// GitLab and Gitea checkouts go through their adapters, never gh: pr-review-forges.test.ts.
