import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PrReviewDashboard } from "@mendcode/protocol"
import type { ConfigControl } from "../src/pr-review/config-control"
import type { PlatformHandle } from "../src/pr-review/contracts"
import { createPlatformControl } from "../src/pr-review/control"
import { createJobLedger } from "../src/pr-review/jobs"
import { createPrStates, parsePrStates } from "../src/pr-review/pr-states"
import { writeReviewState } from "../src/pr-review/state"
import { release, takeOver } from "../src/pr-review/takeover"
import type { GhRun } from "../src/pr-watch"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pr-states-"))); temps.push(dir); return dir }

const LIST = JSON.stringify([
  { number: 1, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] },
  { number: 2, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", statusCheckRollup: [
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "StatusContext", context: "ci/build", state: "ERROR" },
    { __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "TIMED_OUT" },
    { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "CANCELLED" },
  ] },
  { number: 3, state: "OPEN", isDraft: false, mergeable: "CONFLICTING", statusCheckRollup: [] },
  { number: 4, state: "MERGED", isDraft: false, mergeable: "UNKNOWN", statusCheckRollup: null },
  { number: 5, state: "OPEN", isDraft: true, mergeable: "MERGEABLE", statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS" }] },
  { number: 6, state: "CLOSED" },
])

function fakeGh(out = LIST) {
  const calls: Array<{ argv: string[]; cwd: string }> = []
  let fail = false
  const run: GhRun = async (input) => {
    calls.push(input)
    return fail ? { code: 1, out: "", err: "HTTP 502" } : { code: 0, out, err: "" }
  }
  return { run, calls, failNext: (value: boolean) => { fail = value } }
}

describe("pull request states from one gh pr list", () => {
  test("parses open, merged, closed, draft, conflicts and checks, naming at most three failing checks", () => {
    const states = parsePrStates(LIST)!
    expect(states.get(1)).toEqual({ state: "open", draft: false, mergeable: "mergeable", checks: "passing" })
    expect(states.get(2)).toEqual({ state: "open", draft: false, mergeable: "mergeable", checks: "failing", failing: ["lint", "ci/build", "e2e"] })
    expect(states.get(3)).toMatchObject({ mergeable: "conflicting", checks: "none" })
    expect(states.get(4)).toMatchObject({ state: "merged" })
    expect(states.get(5)).toMatchObject({ draft: true, checks: "pending" })
    expect(states.get(6)).toMatchObject({ state: "closed", mergeable: "unknown" })
    expect(parsePrStates("not json")).toBeUndefined()
    expect(parsePrStates("{}")).toBeUndefined()
  })

  test("one call per repository with --repo, --state all and a bounded limit; a fresh read is reused, refresh reads again", async () => {
    let clock = 1_000
    const gh = fakeGh()
    const states = createPrStates({ run: gh.run, now: () => clock, ttlMs: 60_000 })
    await Promise.all([states.fetch("acme/app", "/tmp/a", false), states.fetch("acme/app", "/tmp/a", false)])
    expect(gh.calls).toHaveLength(1)
    expect(gh.calls[0]!.argv).toEqual(["pr", "list", "--repo", "acme/app", "--state", "all", "--limit", "100", "--json", "number,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup"])
    clock += 30_000
    await states.fetch("acme/app", "/tmp/a", false)
    expect(gh.calls).toHaveLength(1)
    await states.fetch("acme/app", "/tmp/a", true)
    expect(gh.calls).toHaveLength(2)
    clock += 61_000
    await states.fetch("acme/app", "/tmp/a", false)
    expect(gh.calls).toHaveLength(3)
    expect(states.cached("acme/app")?.size).toBe(6)
  })

  test("a failed read keeps the last good states and a repository name that could be an option is never passed to gh", async () => {
    const gh = fakeGh()
    const states = createPrStates({ run: gh.run, ttlMs: 0 })
    gh.failNext(true)
    await states.fetch("acme/app", "/tmp/a", false)
    expect(states.cached("acme/app")).toBeUndefined()
    gh.failNext(false)
    await states.fetch("acme/app", "/tmp/a", false)
    gh.failNext(true)
    await states.fetch("acme/app", "/tmp/a", true)
    expect(states.cached("acme/app")?.get(1)?.checks).toBe("passing")
    await states.fetch("--help", "/tmp/a", true)
    expect(gh.calls.every((call) => call.argv[3] === "acme/app")).toBe(true)
  })
})

describe("status attaches the states", () => {
  async function setup(gh: ReturnType<typeof fakeGh>) {
    const dataDir = temp()
    const jobs = createJobLedger({ file: path.join(dataDir, "jobs.json"), now: () => 1_000 })
    const handle: PlatformHandle = {
      dataDir, jobs, device: () => "dev", rows: () => [], concurrency: 1, repoOf: async () => "acme/app", loginOf: async () => undefined,
      reviewers: async () => [], retry: async () => ({ ok: true, text: "" }), audit: async () => ({ ok: true, text: "", jobId: "x" }),
    }
    const control = createPlatformControl(handle, { configControl: {} as ConfigControl, takeover: { takeOver, release }, now: () => 1_000, pullRequests: createPrStates({ run: gh.run }) })
    const add = (repo: string, number: number, provider: "github" | "gitlab" = "github") => jobs.upsert({ provider, repo, directory: dataDir, number, sessionId: "ses_w", reviewer: "global", scope: "global", trigger: "opened", coverage: "full", base: "b".repeat(40), head: `${number}`.padEnd(40, "c"), configKey: "k" })
    const status = (pullRequests?: "cached" | "refresh") => control.run({ sessionId: "ses_p", action: "status", directory: dataDir, ...(pullRequests ? { pullRequests } : {}) })
    return { add, status, dataDir }
  }

  test("several PRs of a repository cost one gh call; GitLab jobs and the plain poll fetch nothing; the answer stays schema-valid", async () => {
    const gh = fakeGh()
    const { add, status } = await setup(gh)
    for (const number of [1, 2, 3, 4]) add("acme/app", number)
    add("group/lab", 1, "gitlab")
    const plain = await status()
    expect(gh.calls).toHaveLength(0)
    expect(plain.ok && plain.dashboard?.jobs.some((job) => job.pullRequest)).toBe(false)
    const read = await status("cached")
    if (!read.ok || !read.dashboard) throw new Error("no dashboard")
    expect(gh.calls).toHaveLength(1)
    expect(PrReviewDashboard.parse(read.dashboard)).toEqual(read.dashboard)
    const byNumber = (repo: string, number: number) => read.dashboard!.jobs.find((job) => job.repo === repo && job.number === number)
    expect(byNumber("acme/app", 2)?.pullRequest?.checks).toBe("failing")
    expect(byNumber("acme/app", 3)?.pullRequest?.mergeable).toBe("conflicting")
    expect(byNumber("group/lab", 1)?.pullRequest).toBeUndefined()
    // The 5 s poll gets the cached state without a call.
    const polled = await status()
    expect(gh.calls).toHaveLength(1)
    expect(polled.ok && polled.dashboard?.jobs.find((job) => job.number === 4 && job.repo === "acme/app")?.pullRequest?.state).toBe("merged")
  })

  test("a job whose own run found nothing still carries the blocker an earlier review published and nobody resolved", async () => {
    const gh = fakeGh()
    const { add, status, dataDir } = await setup(gh)
    add("acme/app", 1)
    add("acme/app", 2)
    const finding = (id: string, severity: "critical" | "major" | "minor", verdict: "confirmed" | "plausible" = "confirmed") =>
      ({ id, path: "a.ts", line: 1, side: "RIGHT" as const, severity, category: "correctness" as const, summary: `s ${id}`, detail: "d", evidence: ["a.ts:1"], verdict })
    writeReviewState(dataDir, "acme/app", 1, { version: 1, lastHead: "1".padEnd(40, "c"), published: {
      ["a".repeat(40)]: { commentId: 1, finding: finding("a".repeat(40), "critical") },
      ["b".repeat(40)]: { commentId: 2, finding: finding("b".repeat(40), "minor") },
      ["c".repeat(40)]: { commentId: 3, finding: finding("c".repeat(40), "major"), resolved: true },
    } } as never)
    const read = await status("cached")
    if (!read.ok || !read.dashboard) throw new Error("no dashboard")
    expect(PrReviewDashboard.parse(read.dashboard)).toEqual(read.dashboard)
    const byNumber = (number: number) => read.dashboard!.jobs.find((job) => job.number === number)!
    expect(byNumber(1).findings.blocking).toBeUndefined()
    expect(byNumber(1).unresolved).toEqual({ open: 2, blocking: 1 })
    expect(byNumber(2).unresolved).toEqual({ open: 0, blocking: 0 })
    // The 5 s poll reads no state file.
    const polled = await status()
    expect(polled.ok && polled.dashboard?.jobs.some((job) => job.unresolved)).toBe(false)
  })

  test("gh failing leaves the state unknown and the page still gets its jobs", async () => {
    const gh = fakeGh()
    gh.failNext(true)
    const { add, status } = await setup(gh)
    add("acme/app", 1)
    const done = await status("refresh")
    if (!done.ok || !done.dashboard) throw new Error("no dashboard")
    expect(done.dashboard.jobs).toHaveLength(1)
    expect(done.dashboard.jobs[0]!.pullRequest).toBeUndefined()
  })
})

test("concurrent first reads of PR states share one cache: the loader runs once and every caller gets the same instance", async () => {
  const { sharedLoad } = await import("../src/pr-review/service")
  let made = 0
  const load = sharedLoad(async () => { await Bun.sleep(5); made++; return { id: made } })
  const [a, b, c] = await Promise.all([load(), load(), load()])
  expect(made).toBe(1)
  expect(b).toBe(a)
  expect(c).toBe(a)
  expect(await load()).toBe(a)
})
