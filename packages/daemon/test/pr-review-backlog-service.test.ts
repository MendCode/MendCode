import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { GhRun } from "../src/pr-watch"
import { gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import type { GhCall } from "../src/pr-review/publish"
import type { ReviewRun, RunPrReviewInput } from "../src/pr-review/run"
import { createPrReviewService } from "../src/pr-review/service"
import { emptyState, reviewMarker } from "../src/pr-review/state"

/**
 * The backlog through `createPrReviewService` (backlog.ts): open PRs whose current head has no review are reviewed when a watch
 * starts and at every catch-up, bounded, and said in `/pr watch-repo`'s answer. The incident it reproduces (NotchNull, an older
 * binary): the watch ended during a network outage, #23 was opened in the gap, `/pr watch-repo` took it as the baseline, and it was
 * reviewed only once someone wrote `@mendcode review`. Real git (a bare origin and its clones in temp directories), a fake GitHub
 * that never reaches the network, and either a scripted review run or scripted model turns.
 */

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const until = async (check: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await Bun.sleep(10) } }
const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]
const git = async (cwd: string, ...args: string[]) => { const done = await gitRun([...GIT_ID, ...args], cwd); if (done.code) throw new Error(`git ${args.join(" ")}: exit ${done.code}`); return done.out.trim() }
const latch = () => { let open!: () => void; const shut = new Promise<void>((resolve) => { open = resolve }); return { shut, open } }
const DAY = 86_400_000

async function repository(yaml: string, reviewers?: string) {
  const origin = temp("bl-origin-"), dir = temp("bl-clone-")
  await git(origin, "init", "-q", "--bare", "-b", "main")
  await git(dir, "init", "-q", "-b", "main")
  mkdirSync(path.join(dir, ".mendcode"))
  writeFileSync(path.join(dir, ".mendcode", "review.yaml"), yaml)
  if (reviewers) writeFileSync(path.join(dir, ".mendcode", "reviewers.yaml"), reviewers)
  writeFileSync(path.join(dir, "a.ts"), "export const one = 1\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  const main = await git(dir, "rev-parse", "HEAD")
  await git(dir, "remote", "add", "origin", origin)
  await git(dir, "push", "-q", "origin", "main")
  for (const [key, value] of [["user.name", "t"], ["user.email", "t@example.invalid"], ["commit.gpgsign", "false"]] as const) await git(dir, "config", key, value)
  async function push(number: number, content = `export const pr = ${number}\n`) {
    const branch = `feature-${number}`
    const exists = (await gitRun(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], dir)).code === 0
    await git(dir, "checkout", "-q", ...(exists ? [branch] : ["-b", branch, "main"]))
    writeFileSync(path.join(dir, `feature-${number}.ts`), content)
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", branch)
    await git(dir, "push", "-q", "-f", "origin", `${branch}:refs/heads/${branch}`, `${branch}:refs/pull/${number}/head`)
    const sha = await git(dir, "rev-parse", "HEAD")
    await git(dir, "checkout", "-q", "main")
    return sha
  }
  async function clone() {
    const other = temp("bl-device-")
    await git(path.dirname(other), "clone", "-q", origin, other)
    return other
  }
  return { origin, dir, main, push, clone }
}

type Pr = { number: number; draft?: boolean; labels?: string[]; updatedAt?: string }
type Comment = { id: number; body: string; user: { login: string }; updatedAt: number; author_association: string }
type Review = { id: number; commit_id: string; state: string; body: string; user: { login: string; type: string }; author_association: string }

/** GitHub as every daemon sees it: PR heads are the origin's branch tips; `down` makes every listing fail with that error. */
function github(repo: Awaited<ReturnType<typeof repository>>) {
  const prs: Pr[] = []
  const comments = new Map<number, Comment[]>()
  const reviews = new Map<number, Review[]>()
  const state: { down?: string | undefined } = {}
  let ids = 5000
  const tip = async (number: number) => (await gitRun(["rev-parse", `refs/heads/feature-${number}`], repo.origin)).out.trim()
  const shape = async (pr: Pr) => ({
    number: pr.number, headRefOid: await tip(pr.number), baseRefOid: repo.main, baseRefName: "main", headRefName: `feature-${pr.number}`,
    url: `https://github.com/acme/app/pull/${pr.number}`, title: `PR ${pr.number}`, author: { login: "bob" }, labels: (pr.labels ?? []).map((name) => ({ name })),
    reviewRequests: [], assignees: [], isDraft: pr.draft === true, isCrossRepository: false, maintainerCanModify: true, updatedAt: pr.updatedAt ?? new Date().toISOString(),
  })
  const comment = (number: number, login: string, body: string) => {
    const item: Comment = { id: ++ids, body, user: { login }, updatedAt: Date.now(), author_association: "MEMBER" }
    comments.set(number, [...comments.get(number) ?? [], item])
    return item
  }
  function as(login: string) {
    const run: GhRun = async ({ argv }) => {
      if (argv[0] === "repo") return { code: 0, out: "acme/app", err: "" }
      if (argv.join(" ") === "api user --jq .login") return { code: 0, out: login, err: "" }
      if (argv[0] === "pr" && argv[1] === "list") return state.down ? { code: 1, out: "", err: state.down } : { code: 0, out: JSON.stringify(await Promise.all(prs.map(shape))), err: "" }
      if (argv[0] === "pr" && argv[1] === "view") {
        const pr = prs.find((item) => item.number === Number(argv[2]))
        if (!pr) return { code: 1, out: "", err: "no pull request" }
        return { code: 0, out: JSON.stringify({ ...await shape(pr), body: "", files: [{ path: `feature-${pr.number}.ts` }] }), err: "" }
      }
      // The repository's comments updated since a time: how a device sees another's claim posted, renewed or released.
      const since = /^repos\/\{owner\}\/\{repo\}\/issues\/comments\?since=([^&]+)/.exec(argv[1] ?? "")
      if (argv[0] === "api" && since) {
        const after = Date.parse(since[1]!)
        const lines = [...comments.entries()].flatMap(([number, list]) => list.filter((item) => !(item.updatedAt < after)).map((item) => JSON.stringify({ id: item.id, body: item.body, user: item.user.login, association: item.author_association, html_url: `https://github.com/acme/app/pull/${number}#issuecomment-${item.id}` })))
        return { code: 0, out: lines.join("\n"), err: "" }
      }
      if (argv[0] === "api" && /comments\?since=/.test(argv[1] ?? "")) return { code: 0, out: "", err: "" }
      return { code: 1, out: "", err: "unexpected" }
    }
    const call: GhCall = async ({ argv, stdin }) => {
      const endpoint = argv[1] ?? ""
      const issue = /^repos\/acme\/app\/issues\/(\d+)\/comments/.exec(endpoint)
      const edit = /^repos\/acme\/app\/issues\/comments\/(\d+)$/.exec(endpoint)
      const pull = /^repos\/acme\/app\/pulls\/(\d+)\/reviews(?:\?|$)/.exec(endpoint)
      const body = JSON.parse(stdin ?? "{}") as { body?: string; commit_id?: string }
      if (endpoint === "graphql") return { code: 0, out: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }) }
      if (argv.includes("PATCH") && edit) {
        for (const list of comments.values()) for (const item of list) if (item.id === Number(edit[1]) && item.user.login === login) { item.body = body.body ?? ""; item.updatedAt = Date.now(); return { code: 0, out: JSON.stringify({ id: item.id }) } }
        return { code: 1, out: "", err: "HTTP 404" }
      }
      if (argv.includes("POST") && issue) return { code: 0, out: JSON.stringify({ id: comment(Number(issue[1]), login, body.body ?? "").id }) }
      if (argv.includes("POST") && pull) {
        const number = Number(pull[1])
        const review: Review = { id: ++ids, commit_id: body.commit_id ?? "", state: "COMMENTED", body: body.body ?? "", user: { login, type: "User" }, author_association: "MEMBER" }
        reviews.set(number, [...reviews.get(number) ?? [], review])
        return { code: 0, out: JSON.stringify({ id: review.id, commit_id: review.commit_id }) }
      }
      if (argv.includes("POST")) return { code: 1, out: "", err: `unexpected post ${endpoint}` }
      if (issue) return { code: 0, out: JSON.stringify(comments.get(Number(issue[1])) ?? []) }
      if (pull) return { code: 0, out: JSON.stringify(reviews.get(Number(pull[1])) ?? []) }
      if (/\/collaborators\/[^/]+\/permission$/.test(endpoint)) return { code: 0, out: argv.includes("--jq") ? "write" : JSON.stringify({ permission: "write" }) }
      if (endpoint === "repos/acme/app") return { code: 0, out: "true" }
      if (/^repos\/acme\/app\/pulls\/\d+$/.test(endpoint) && argv.includes(".state")) return { code: 0, out: "open" }
      return { code: 0, out: "[]" }
    }
    return { run, call }
  }
  return { prs, comments, reviews, state, as, tip }
}

/** Scripted model turns for the real review run: every review finds nothing (one summary), `gate` holds the first one. */
function model(gate?: Promise<void>) {
  const asked: string[] = []
  const factory = (): ReviewSessionFactory => async ({ purpose }) => ({
    id: `ses_${purpose}`,
    async send() { asked.push(purpose); if (purpose === "review") await gate; return { text: JSON.stringify(purpose === "review" ? { summary: "Looks fine.", findings: [] } : { verdicts: [] }), tokens: { input: 100, output: 10 } } },
    async close() {},
  }) as never
  return { factory, reviews: () => asked.filter((purpose) => purpose === "review").length }
}

type Clock = { wall: number; mono: number }
function daemon({ hub, checkout, brain, scripted = false, data = temp("bl-data-"), clock }: { hub: ReturnType<typeof github>; checkout: string; brain?: ReturnType<typeof model>; scripted?: boolean | ((input: RunPrReviewInput) => Promise<ReviewRun>); data?: string; clock?: Clock }) {
  const gh = hub.as("ana")
  const notices: string[] = []
  const inputs: RunPrReviewInput[] = []
  const service = createPrReviewService({
    dir: data, run: gh.run, call: gh.call, intervalMs: 3_600_000, enabled: () => true, graphOn: () => false,
    ...(clock ? { now: () => clock.wall, monotonic: () => clock.mono } : {}),
    sessionDirectory: () => checkout, sessionExists: () => true, notify: (_session, text) => notices.push(text),
    sessions: (brain ?? model()).factory, editor: () => (async () => { throw new Error("no fix session in these tests") }) as never, schedule: async (job) => { await job() }, random: () => 0.5, sleep: async () => {},
    ...(scripted ? { review: async (input: RunPrReviewInput) => { inputs.push(input); return typeof scripted === "function" ? scripted(input) : { state: emptyState(), incremental: false, status: "reviewed" } as ReviewRun } } : {}),
  })
  cleanups.push(() => service.stop())
  const jobs = () => service.platform.jobs.all()
  const watchRepo = async () => {
    const answer = await service.control({ sessionId: "ses", action: "watch-repo", role: "all" })
    expect(answer.ok).toBe(true)
    return answer.ok ? answer.text : ""
  }
  return { service, notices, inputs, jobs, data, watchRepo, device: () => service.platform.device(), reviewed: (number: number) => inputs.filter((input) => input.number === number).length }
}
const done = (d: ReturnType<typeof daemon>) => d.jobs().filter((job) => job.state === "done")

describe("the backlog through the service: open PRs without a review when a watch starts", () => {
  test("NotchNull #23: the watch ends, #23 is opened in the gap, /pr watch-repo again reviews it exactly once, with no comment on GitHub", async () => {
    const repo = await repository("enabled: true\n")
    const hub = github(repo)
    const clock: Clock = { wall: Date.now(), mono: 1_000_000 }
    const d = daemon({ hub, checkout: repo.dir, scripted: true, clock })
    await d.service.control({ sessionId: "ses", action: "publish-on" })
    // #20 is reviewed under the first watch, as a new PR.
    expect(await d.watchRepo()).toContain("0 open PRs")
    await repo.push(20)
    hub.prs.push({ number: 20 })
    await d.service.tick()
    await until(() => done(d).length === 1)
    // The listing fails until the watch ends (an older binary ended it on a network outage; here a permanent error does).
    hub.state.down = "HTTP 404: Not Found (https://api.github.com/graphql)"
    await d.service.tick()
    clock.wall += 16 * 60_000
    clock.mono += 16 * 60_000
    await d.service.tick()
    await until(() => d.notices.some((text) => text.includes("ended")))
    expect((await d.service.control({ sessionId: "ses", action: "list" }))).toMatchObject({ ok: true, text: expect.stringContaining("ended (unreadable)") })
    // #23 is opened while no watch runs; GitHub answers again.
    await repo.push(23)
    hub.prs.push({ number: 23 })
    hub.state.down = undefined
    await d.service.tick()
    expect(d.reviewed(23)).toBe(0)
    const answer = await d.watchRepo()
    expect(answer).toContain("2 open PRs. Queued 1 open PR without a review of the current head (#23). 1 already reviewed at the current head stays as it is.")
    await until(() => d.reviewed(23) === 1)
    await until(() => d.jobs().some((job) => job.number === 23 && job.state === "done"))
    expect(d.jobs().find((job) => job.number === 23)).toMatchObject({ trigger: "backlog", reviewer: "global", coverage: "full" })
    // More polls and a daemon restart (a catch-up of its own) leave it reviewed once.
    await d.service.tick()
    await d.service.stop()
    const again = daemon({ hub, checkout: repo.dir, scripted: true, data: d.data, clock })
    await again.service.tick()
    await again.service.tick()
    expect(d.reviewed(23) + again.reviewed(23)).toBe(1)
    expect(d.reviewed(20) + again.reviewed(20)).toBe(1)
    expect(again.notices.some((text) => text.includes("caught up"))).toBe(false)
    expect([...hub.comments.values()].flat().some((item) => item.body.includes("@mendcode"))).toBe(false)
  }, 30_000)

  test("a head with a review already (posted from a session, by this login) stays the baseline; a push after it is reviewed as usual", async () => {
    const repo = await repository("enabled: true\ncooldown:\n  pr_minutes: 0\n")
    const hub = github(repo)
    const head = await repo.push(5)
    hub.prs.push({ number: 5 })
    hub.reviews.set(5, [{ id: 77, commit_id: head, state: "COMMENTED", body: "## Review", user: { login: "ana", type: "User" }, author_association: "MEMBER" }])
    const d = daemon({ hub, checkout: repo.dir, scripted: true })
    await d.service.control({ sessionId: "ses", action: "publish-on" })
    expect(await d.watchRepo()).toContain("1 open PR. 1 already reviewed at the current head stays as it is.")
    await d.service.tick()
    expect(d.jobs()).toEqual([])
    await repo.push(5, "export const pr = 55\n")
    await d.service.tick()
    await until(() => d.reviewed(5) === 1)
    expect(d.jobs()[0]).toMatchObject({ trigger: "synchronize" })
  }, 30_000)

  test("at most backlog.max_prs, newest first; older than backlog.window_days is not queued; the answer names each one skipped and why", async () => {
    const repo = await repository("enabled: true\nbacklog:\n  max_prs: 2\n  window_days: 30\n")
    const hub = github(repo)
    for (const [number, ago] of [[1, 3], [2, 1], [3, 2], [4, 5], [9, 45]] as const) {
      await repo.push(number)
      hub.prs.push({ number, updatedAt: new Date(Date.now() - ago * DAY).toISOString() })
    }
    const gate = latch()
    const d = daemon({ hub, checkout: repo.dir, brain: model(gate.shut) })
    await d.service.control({ sessionId: "ses", action: "publish-on" })
    const answer = await d.watchRepo()
    expect(answer).toContain("5 open PRs. Queued 2 open PRs without a review of the current head (#2, #3).")
    expect(answer).toContain("Not queued: #1 (cap: 2 newer PRs were queued first (backlog.max_prs)); #4 (cap: 2 newer PRs were queued first (backlog.max_prs)); #9 (window: last updated 45 days ago, outside the 30-day backlog.window_days). /pr review N reviews one now.")
    expect(d.jobs().map((job) => job.number).toSorted()).toEqual([2, 3])
    expect(d.jobs().every((job) => job.trigger === "backlog")).toBe(true)
    gate.open()
  }, 30_000)

  test("drafts and the repository's filters keep a PR out of the backlog, each named with eligibility's reason", async () => {
    const repo = await repository("enabled: true\nfilters:\n  labels:\n    exclude: [blocked]\n")
    const hub = github(repo)
    for (const number of [1, 2, 3]) await repo.push(number)
    hub.prs.push({ number: 1, draft: true }, { number: 2, labels: ["blocked"] }, { number: 3 })
    const d = daemon({ hub, checkout: repo.dir, scripted: true })
    await d.service.control({ sessionId: "ses", action: "publish-on" })
    const answer = await d.watchRepo()
    expect(answer).toContain("Queued 1 open PR without a review of the current head (#3).")
    expect(answer).toContain("#2 (label `blocked` excluded)")
    expect(answer).toContain("#1 (draft: waits for ready for review)")
    await until(() => d.reviewed(3) === 1)
    expect(d.jobs().map((job) => job.number)).toEqual([3])
  }, 30_000)

  test("backlog.max_prs 0 is today's baseline: nothing is queued, and the answer says the open PRs are the baseline", async () => {
    const repo = await repository("enabled: true\nbacklog:\n  max_prs: 0\n")
    const hub = github(repo)
    await repo.push(23)
    hub.prs.push({ number: 23 })
    const d = daemon({ hub, checkout: repo.dir, scripted: true })
    await d.service.control({ sessionId: "ses", action: "publish-on" })
    expect(await d.watchRepo()).toContain("1 open PR is the baseline.")
    await d.service.tick()
    expect(d.jobs()).toEqual([])
    expect(d.reviewed(23)).toBe(0)
  }, 30_000)

  test("an area reviewer's catch-up reads the changed files the listing lacks: a PR in its area is found even with the backlog off", async () => {
    const repo = await repository("enabled: true\nbacklog:\n  max_prs: 0\n", "reviewers:\n  - id: ana-api\n    scope: personal\n    login: ana\n    areas: [\"feature-7.ts\"]\nrouting:\n  global: personal-only\n  fallback: none\n")
    const hub = github(repo)
    for (const number of [7, 8]) { await repo.push(number); hub.prs.push({ number }) }
    const d = daemon({ hub, checkout: repo.dir, scripted: true })
    await d.service.control({ sessionId: "ses", action: "publish-on" })
    await d.watchRepo()
    await until(() => d.reviewed(7) === 1)
    expect(d.jobs().map((job) => [job.number, job.reviewer, job.trigger])).toEqual([[7, "ana-api", "routed"]])
    expect(d.jobs()[0]!.assignment).toContain("feature-7.ts")
  }, 30_000)

  test("two daemons of one login start their watches on the same unreviewed PR: it is reviewed once, the second settles on the first's review", async () => {
    const repo = await repository("enabled: true\n")
    const hub = github(repo)
    const head = await repo.push(23)
    hub.prs.push({ number: 23 })
    const pcTurn = latch()
    const pcBrain = model(pcTurn.shut), vpsBrain = model()
    const pc = daemon({ hub, checkout: repo.dir, brain: pcBrain })
    const vps = daemon({ hub, checkout: await repo.clone(), brain: vpsBrain })
    await pc.service.control({ sessionId: "ses", action: "publish-on" })
    await vps.service.control({ sessionId: "ses", action: "publish-on" })
    expect(await pc.watchRepo()).toContain("Queued 1 open PR")
    await until(() => pcBrain.reviews() === 1)
    // The PC's review runs (its claim is on the PR); the VPS's backlog queues the PR too, and its claim gate makes it wait.
    expect(await vps.watchRepo()).toContain("Queued 1 open PR")
    await until(() => vps.jobs().some((job) => job.number === 23 && job.state === "waiting"))
    pcTurn.open()
    await until(() => pc.jobs().some((job) => job.number === 23 && job.state === "done"))
    await vps.service.tick()
    await until(() => vps.jobs().some((job) => job.number === 23 && job.state === "done"))
    expect(hub.reviews.get(23)).toHaveLength(1)
    expect(hub.reviews.get(23)![0]!.commit_id).toBe(head)
    expect(vpsBrain.reviews()).toBe(0)
    // A third start of the VPS's watch (a restart) finds the review and leaves the PR as the baseline.
    await vps.service.control({ sessionId: "ses", action: "unwatch-repo" })
    expect(await vps.watchRepo()).toContain("1 already reviewed at the current head stays as it is.")
  }, 40_000)
})

describe("a push after a review the saved state does not know, and a failure that does not go away", () => {
  test("this login's published review is the last reviewed head when no state was saved: a push reviews from it, and says where", async () => {
    const repo = await repository("enabled: true\ncooldown:\n  pr_minutes: 0\n")
    const hub = github(repo)
    const old = await repo.push(5)
    hub.prs.push({ number: 5 })
    hub.reviews.set(5, [{ id: 77, commit_id: old, state: "COMMENTED", body: `## MendCode review\n${reviewMarker(old)}`, user: { login: "ana", type: "User" }, author_association: "MEMBER" }])
    const d = daemon({ hub, checkout: repo.dir, scripted: true })
    await d.service.control({ sessionId: "ses", action: "publish-on" })
    expect(await d.watchRepo()).toContain("1 already reviewed at the current head stays as it is.")
    const head = await repo.push(5, "export const pr = 55\n")
    await d.service.tick()
    await until(() => d.reviewed(5) === 1)
    expect(d.inputs[0]!.head).toBe(head)
    expect(d.inputs[0]!.state.lastHead).toBe(old)
  }, 30_000)

  test("a review that fails for good is told once: a daemon restart does not queue or announce it again, /reviews keeps it and a retry runs it", async () => {
    const repo = await repository("enabled: true\n")
    const hub = github(repo)
    await repo.push(23)
    hub.prs.push({ number: 23 })
    const clock: Clock = { wall: Date.now(), mono: 1_000_000 }
    const failing = async () => ({ status: "failed", reason: "[PR_REVIEW]: the reviewable part of the diff is 9.0 MiB, more than a review reads", state: emptyState(), incremental: false }) as ReviewRun
    const d = daemon({ hub, checkout: repo.dir, scripted: failing, clock })
    await d.service.control({ sessionId: "ses", action: "publish-on" })
    await d.watchRepo()
    await until(() => d.jobs().some((job) => job.number === 23 && job.state === "failed"))
    expect(d.notices.filter((text) => text.includes("failed")).length).toBe(1)
    await d.service.stop()
    const again = daemon({ hub, checkout: repo.dir, scripted: failing, data: d.data, clock })
    await again.service.tick()
    await again.service.tick()
    expect(again.reviewed(23)).toBe(0)
    expect(again.notices.filter((text) => /failed|caught up/.test(text))).toEqual([])
    const job = again.jobs().find((item) => item.number === 23)!
    expect(job.state).toBe("failed")
    expect(await again.service.control({ sessionId: "ses", action: "list" })).toMatchObject({ ok: true })
    const retried = await again.service.platform.handle.retry(job.id, "the PR was split")
    expect(retried.ok).toBe(true)
    await until(() => again.reviewed(23) === 1)
  }, 30_000)

  test("a catch-up after a restart reads the network by listing, not by PR: a permanently failed head costs no review read, and the listing is one call", async () => {
    const repo = await repository("enabled: true\n")
    const hub = github(repo)
    for (const number of [21, 22, 23]) { await repo.push(number); hub.prs.push({ number }) }
    const clock: Clock = { wall: Date.now(), mono: 1_000_000 }
    const failing = async () => ({ status: "failed", reason: "[PR_REVIEW]: the reviewable part of the diff is 9.0 MiB, more than a review reads", state: emptyState(), incremental: false }) as ReviewRun
    const d = daemon({ hub, checkout: repo.dir, scripted: failing, clock })
    await d.service.control({ sessionId: "ses", action: "publish-on" })
    await d.watchRepo()
    await until(() => d.jobs().filter((job) => job.state === "failed").length === 3)
    await d.service.stop()
    const calls: string[] = []
    const as = hub.as
    hub.as = (login: string) => { const inner = as(login); return { run: async (input) => { calls.push(input.argv.join(" ")); return inner.run(input) }, call: async (input) => { calls.push(input.argv.join(" ")); return inner.call(input) } } }
    const again = daemon({ hub, checkout: repo.dir, scripted: failing, data: d.data, clock })
    await again.service.tick()
    expect(calls.filter((call) => call.startsWith("pr list")).length).toBeLessThanOrEqual(1)
    expect(calls.filter((call) => /pulls\/\d+\/reviews/.test(call))).toEqual([])
    expect(again.inputs).toEqual([])
  }, 30_000)
})
