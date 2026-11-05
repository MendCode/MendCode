import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { GhRun } from "../src/pr-watch"
import { MAINTAINERS_ONLY } from "../src/pr-review/commands"
import { gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { findingId } from "../src/pr-review/findings"
import type { GhCall } from "../src/pr-review/publish"
import { createPrReviewService } from "../src/pr-review/service"
import { readReviewState } from "../src/pr-review/state"

/**
 * Platform scenarios end to end through `createPrReviewService` with the real review run (run.ts, the engine, publishing through
 * the effects ledger): no `review` seam. Git is real (a bare origin and a clone in temp dirs); GitHub is a fake shared by every
 * daemon of a test, each with its own gh login and data directory; the model is scripted children that answer by purpose and
 * record every turn. Nothing reaches the network, and nothing here is live evidence.
 */

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const until = async (check: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await Bun.sleep(10) } }
const git = async (cwd: string, ...args: string[]) => { const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd); if (done.code) throw new Error(`git ${args.join(" ")}: exit ${done.code}`); return done.out.trim() }

/** A bare origin and a clone with `.mendcode/review.yaml` (and `reviewers.yaml`) on main. */
async function repository(yaml: string, reviewers?: string) {
  const origin = temp("e2e-origin-"), dir = temp("e2e-clone-")
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
  /** Commits `content` as `<branch>.ts` and pushes it as PR `number`'s head (branch and `refs/pull/<n>/head`). */
  async function push(number: number, branch: string, content: string) {
    const exists = (await gitRun(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], dir)).code === 0
    await git(dir, "checkout", "-q", ...(exists ? [branch] : ["-b", branch, "main"]))
    writeFileSync(path.join(dir, `${branch}.ts`), content)
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", `${branch}: ${content.trim()}`)
    await git(dir, "push", "-q", "-f", "origin", `${branch}:refs/heads/${branch}`, `${branch}:refs/pull/${number}/head`)
    const sha = await git(dir, "rev-parse", "HEAD")
    await git(dir, "checkout", "-q", "main")
    return sha
  }
  /** Changes the repository's review.yaml on main (the base-controlled policy every later run reads). */
  async function policy(next: string) {
    writeFileSync(path.join(dir, ".mendcode", "review.yaml"), next)
    await git(dir, "commit", "-q", "-am", "policy")
    await git(dir, "push", "-q", "origin", "main")
  }
  return { origin, dir, main, push, policy }
}

type Pr = { number: number; branch: string; requested?: string[]; fork?: boolean }
type Comment = { id: number; body: string; user: { login: string } }
type Review = { id: number; commit_id: string; state: string; body: string; user: { login: string; type: string }; author_association: string; comments: unknown[] }

/** GitHub as every daemon sees it: PRs from the origin's branches, issue comments, submitted reviews, collaborator permissions. */
function github(repo: Awaited<ReturnType<typeof repository>>, writers: readonly string[]) {
  const prs: Pr[] = []
  const comments = new Map<number, Comment[]>()
  const reviews = new Map<number, Review[]>()
  const posts: Array<{ login: string; endpoint: string }> = []
  let ids = 5000
  const tip = async (branch: string) => (await gitRun(["rev-parse", `refs/heads/${branch}`], repo.origin)).out.trim()
  const shape = async (pr: Pr) => ({
    number: pr.number, headRefOid: await tip(pr.branch), baseRefOid: repo.main, baseRefName: "main", headRefName: pr.branch,
    url: `https://github.com/acme/app/pull/${pr.number}`, title: `PR ${pr.number}`, author: { login: "bob" }, labels: [],
    reviewRequests: (pr.requested ?? []).map((login) => ({ login })), assignees: [], isDraft: false,
    isCrossRepository: pr.fork === true, maintainerCanModify: pr.fork !== true, headRepository: { name: "app" }, headRepositoryOwner: { login: pr.fork ? "mallory" : "acme" },
  })
  const level = (login: string) => writers.includes(login) ? "write" : "read"
  /** An issue comment someone else writes on PR `number` (an `@mendcode` command the watches poll). */
  function comment(number: number, login: string, body: string) {
    const item = { id: ++ids, body, user: { login } }
    comments.set(number, [...comments.get(number) ?? [], item])
    return item
  }
  function as(login: string) {
    const run: GhRun = async ({ argv }) => {
      if (argv[0] === "repo") return { code: 0, out: "acme/app", err: "" }
      if (argv.join(" ") === "api user --jq .login") return { code: 0, out: login, err: "" }
      if (argv[0] === "pr" && argv[1] === "list") return { code: 0, out: JSON.stringify(await Promise.all(prs.map(shape))), err: "" }
      if (argv[0] === "pr" && argv[1] === "view") {
        const pr = prs.find((item) => item.number === Number(argv[2]))
        if (!pr) return { code: 1, out: "", err: "no pull request" }
        return { code: 0, out: JSON.stringify({ ...await shape(pr), body: "", files: [{ path: `${pr.branch}.ts` }] }), err: "" }
      }
      if (argv[0] === "api" && argv[1]?.startsWith("repos/{owner}/{repo}/issues/comments?since=")) {
        const lines = [...comments].flatMap(([number, list]) => list.map((item) => JSON.stringify({ id: item.id, body: item.body, user: item.user.login, association: writers.includes(item.user.login) ? "MEMBER" : "NONE", html_url: `https://github.com/acme/app/pull/${number}#issuecomment-${item.id}` })))
        return { code: 0, out: lines.join("\n"), err: "" }
      }
      if (argv[0] === "api" && /comments\?since=/.test(argv[1] ?? "")) return { code: 0, out: "", err: "" }
      return { code: 1, out: "", err: "unexpected" }
    }
    const call: GhCall = async ({ argv, stdin }) => {
      const endpoint = argv[1] ?? ""
      const issue = /^repos\/acme\/app\/issues\/(\d+)\/comments/.exec(endpoint)
      const pull = /^repos\/acme\/app\/pulls\/(\d+)\/reviews(?:\?|$)/.exec(endpoint)
      if (argv.includes("POST")) {
        posts.push({ login, endpoint })
        const body = JSON.parse(stdin ?? "{}") as { body?: string; commit_id?: string; comments?: unknown[] }
        if (issue) { const item = { id: ++ids, body: body.body ?? "", user: { login } }; comments.set(Number(issue[1]), [...comments.get(Number(issue[1])) ?? [], item]); return { code: 0, out: JSON.stringify({ id: item.id }) } }
        if (pull) {
          const review: Review = { id: ++ids, commit_id: body.commit_id ?? "", state: "COMMENTED", body: body.body ?? "", user: { login, type: "User" }, author_association: "MEMBER", comments: body.comments ?? [] }
          reviews.set(Number(pull[1]), [...reviews.get(Number(pull[1])) ?? [], review])
          return { code: 0, out: JSON.stringify({ id: review.id, commit_id: review.commit_id }) }
        }
        return { code: 1, out: "", err: `unexpected post ${endpoint}` }
      }
      if (issue) return { code: 0, out: JSON.stringify(comments.get(Number(issue[1])) ?? []) }
      if (pull) return { code: 0, out: JSON.stringify(reviews.get(Number(pull[1])) ?? []) }
      const permission = /^repos\/acme\/app\/collaborators\/([^/]+)\/permission$/.exec(endpoint)
      if (permission) return { code: 0, out: argv.includes("--jq") ? level(decodeURIComponent(permission[1]!)) : JSON.stringify({ permission: level(decodeURIComponent(permission[1]!)) }) }
      if (endpoint === "repos/acme/app") return { code: 0, out: String(writers.includes(login)) }
      if (/^repos\/acme\/app\/pulls\/\d+$/.test(endpoint) && argv.includes(".state")) return { code: 0, out: "open" }
      if (endpoint === "graphql") return { code: 0, out: "{}" }
      return { code: 0, out: "[]" }
    }
    return { run, call }
  }
  return { prs, comments, reviews, posts, tip, comment, as }
}

const FINDING = { path: "feature.ts", line: 1, severity: "major", category: "correctness", summary: "one is now 2", detail: "Callers expect 1.", evidence: ["feature.ts:1"] }
const FINDING_ID = findingId({ path: FINDING.path, line: FINDING.line, category: FINDING.category, summary: FINDING.summary })

/**
 * Scripted review children: a review turn reports `FINDING`, a verify turn confirms it; every turn's purpose is recorded and costs
 * `tokens` input tokens. `before` runs inside a turn first (a push mid-review); `hang` makes review turns never answer (a daemon
 * stopped mid-job).
 */
function model({ tokens = 1_000, before, hang = false }: { tokens?: number; before?: (purpose: string) => Promise<void>; hang?: boolean } = {}) {
  const asked: string[] = []
  let started = false
  const factory = (): ReviewSessionFactory => async ({ purpose }) => ({
    id: `ses_${purpose}`,
    async send() {
      asked.push(purpose)
      started = true
      await before?.(purpose)
      if (hang && purpose === "review") await new Promise(() => undefined)
      const text = purpose === "review"
        ? JSON.stringify({ summary: "Changes one.", findings: [FINDING] })
        : JSON.stringify({ verdicts: [{ id: FINDING_ID, verdict: "confirmed", evidence: ["feature.ts:1 exports 2"] }] })
      return { text, tokens: { input: tokens, output: 100 } }
    },
    async close() {},
  }) as never
  return { factory, asked, started: () => started }
}

/** The fix session: edits the worktree it is given, as a real agent would. */
const fixer = (_owner: string, worktree: string): ReviewSessionFactory => async () => ({ id: "ses_fix", async send() { writeFileSync(path.join(worktree, "feature.ts"), "export const one = 1\n"); return { text: "fixed", tokens: { input: 5, output: 5 } } }, async close() {} }) as never

/** One daemon: a service on its own data directory (its own device id) with `login`'s gh and the real review run. */
function daemon({ repo, hub, login, brain, data = temp(`e2e-${login}-`), now }: { repo: Awaited<ReturnType<typeof repository>>; hub: ReturnType<typeof github>; login: string; brain: ReturnType<typeof model>; data?: string; now?: () => number }) {
  const gh = hub.as(login)
  const notices: string[] = []
  const service = createPrReviewService({
    dir: data, run: gh.run, call: gh.call, intervalMs: 3_600_000, ...(now ? { now } : {}), enabled: () => true, graphOn: () => false,
    sessionDirectory: () => repo.dir, sessionExists: () => true, notify: (_session, text) => notices.push(text),
    sessions: brain.factory, editor: fixer, schedule: async (job) => { await job() }, random: () => 0.5,
  })
  cleanups.push(() => service.stop())
  return { service, data, notices, jobs: () => service.platform.jobs.all(), device: () => service.platform.device() }
}
const reviewsBy = (hub: ReturnType<typeof github>, number: number, login: string) => (hub.reviews.get(number) ?? []).filter((review) => review.user.login === login)

describe("budget stop, checkpoint and retry through the service", () => {
  test("a review pass that alone passes the cap is closed by one short check and posted whole: nothing is left checkpointed", async () => {
    const repo = await repository("enabled: true\nbudget:\n  tokens_per_pr: 10000\n")
    const head = await repo.push(12, "feature", "export const one = 2\n")
    const hub = github(repo, ["ana"])
    hub.prs.push({ number: 12, branch: "feature" })
    const brain = model({ tokens: 12_000 })
    const ana = daemon({ repo, hub, login: "ana", brain })
    await ana.service.control({ sessionId: "ses_a", action: "publish-on" })
    expect((await ana.service.control({ sessionId: "ses_a", action: "review", pr: "12" })).ok).toBe(true)
    await until(() => ana.jobs()[0]?.state === "done")
    expect(brain.asked).toEqual(["review", "verify"])
    const posted = reviewsBy(hub, 12, "ana")
    expect(posted).toHaveLength(1)
    expect(posted[0]!).toMatchObject({ commit_id: head })
    expect(posted[0]!.body).toContain("## MendCode review")
    expect(ana.service.platform.effects.pending()).toEqual([])
  })
})

describe("a review that reaches the cap through the service", () => {
  /** Four large new files as PR `number`'s head: with `context_tokens: 8000` each is its own part of the diff. */
  async function pushFour(repo: Awaited<ReturnType<typeof repository>>, number: number) {
    await git(repo.dir, "checkout", "-q", "-b", "big", "main")
    for (const file of FOUR) writeFileSync(path.join(repo.dir, file), Array.from({ length: 150 }, (_, i) => `export const ${file.replace(/\W/g, "_")}_${i} = ${i} // padding that makes this file about the size of one review part`).join("\n") + "\n")
    await git(repo.dir, "add", "-A")
    await git(repo.dir, "commit", "-q", "-m", "four big files")
    await git(repo.dir, "push", "-q", "-f", "origin", `big:refs/heads/big`, `big:refs/pull/${number}/head`)
    const sha = await git(repo.dir, "rev-parse", "HEAD")
    await git(repo.dir, "checkout", "-q", "main")
    return sha
  }
  const FOUR = ["p1.ts", "p2.ts", "p3.ts", "p4.ts"]

  /** Children that report one defect per file of the part they are shown and confirm what a verify turn names; the first review costs 12,000 tokens, the others 1,000. */
  function parts() {
    const asked: string[] = []
    const reviewed: string[][] = []
    const factory = (): ReviewSessionFactory => async ({ purpose }) => ({
      id: `ses_${purpose}`,
      async send(prompt: string) {
        asked.push(purpose)
        if (purpose === "review") {
          const files = [...new Set([...prompt.matchAll(/^diff --git a\/(\S+) /gm)].map((match) => match[1]!))]
          reviewed.push(files)
          const findings = files.map((file) => ({ path: file, line: 1, severity: "major", category: "correctness", summary: `unchecked shape in ${file}`, detail: "d", evidence: [`${file}:1`] }))
          return { text: JSON.stringify({ summary: `Adds ${files.join(", ")}.`, findings }), tokens: { input: reviewed.length === 1 ? 12_000 : 1_000, output: 0 } }
        }
        const ids = [...prompt.matchAll(/"id":"([0-9a-f]{40})"/g)].map((match) => match[1]!)
        return { text: JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: "confirmed", evidence: ["a.ts:1"] })) }), tokens: { input: 500, output: 0 } }
      },
      async close() {},
    }) as never
    return { factory, asked, reviewed, started: () => asked.length > 0 }
  }

  test("a partial review is posted and is not a review of the head: the next /pr review continues the same job with the missing parts, and only then is the head answered as reviewed", async () => {
    const repo = await repository("enabled: true\nbudget:\n  tokens_per_pr: 40000\n  context_tokens: 8000\n")
    const head = await pushFour(repo, 12)
    const hub = github(repo, ["ana"])
    hub.prs.push({ number: 12, branch: "big" })
    const brain = parts()
    const ana = daemon({ repo, hub, login: "ana", brain })
    await ana.service.control({ sessionId: "ses_a", action: "publish-on" })
    expect((await ana.service.control({ sessionId: "ses_a", action: "review", pr: "12" })).ok).toBe(true)
    await until(() => ana.jobs()[0]?.state === "checkpointed")
    const stopped = ana.jobs()[0]!
    expect(brain.reviewed).toEqual([["p1.ts"]])
    expect(stopped).toMatchObject({ head, stop: { kind: "budget", resumable: true }, checkpoint: { phase: "analysis 1/4" } })
    const partial = reviewsBy(hub, 12, "ana")
    expect(partial).toHaveLength(1)
    expect(partial[0]!.body).toContain("## MendCode partial review")
    expect(partial[0]!.body).toContain("`p2.ts`, `p3.ts`, `p4.ts`")
    expect(partial[0]!.comments).toHaveLength(1)
    expect(readReviewState(ana.data, "acme/app", 12).lastHead).toBeUndefined()
    expect(ana.notices.join("\n")).toContain("Partial review: 1 of 4 files reviewed")

    // Not "already reviewed": the same job continues from its checkpoint with parts 2 to 4.
    const again = await ana.service.control({ sessionId: "ses_a", action: "review", pr: "12" })
    expect(again.ok && again.text).toContain("continuing from its checkpoint")
    await until(() => ana.jobs()[0]?.state === "done")
    expect(ana.jobs()).toHaveLength(1)
    expect(brain.reviewed).toEqual([["p1.ts"], ["p2.ts"], ["p3.ts"], ["p4.ts"]])
    const posted = reviewsBy(hub, 12, "ana")
    expect(posted).toHaveLength(2)
    expect(posted[1]!.body).toContain("## MendCode review")
    expect(posted[1]!.comments).toHaveLength(3)
    expect(readReviewState(ana.data, "acme/app", 12).lastHead).toBe(head)

    // Now the head is reviewed whole: asking again is answered at once, no model call.
    const calls = brain.asked.length
    const third = await ana.service.control({ sessionId: "ses_a", action: "review", pr: "12" })
    expect(third.ok && third.text).toContain("was already reviewed")
    expect(brain.asked).toHaveLength(calls)
  })

  test("/pr review full after a partial review drops its checkpoint and reviews the whole diff again", async () => {
    const repo = await repository("enabled: true\nbudget:\n  tokens_per_pr: 40000\n  context_tokens: 8000\n")
    await pushFour(repo, 12)
    const hub = github(repo, ["ana"])
    hub.prs.push({ number: 12, branch: "big" })
    const brain = parts()
    const ana = daemon({ repo, hub, login: "ana", brain })
    await ana.service.control({ sessionId: "ses_a", action: "publish-on" })
    await ana.service.control({ sessionId: "ses_a", action: "review", pr: "12" })
    await until(() => ana.jobs()[0]?.state === "checkpointed")
    const first = ana.jobs()[0]!
    await ana.service.control({ sessionId: "ses_a", action: "review", pr: "12", full: true })
    await until(() => ana.jobs().length === 2 && ana.jobs().every((job) => job.state !== "pending" && job.state !== "running"))
    expect(ana.jobs().find((job) => job.id === first.id)!.state).toBe("cancelled")
    // The whole diff is reviewed again from part 1 (the first run's part, then the full run's parts).
    expect(brain.reviewed[1]).toEqual(["p1.ts"])
  })
})

describe("a head that moves during the review", () => {
  test("the PR is pushed while the review pass runs: the finished review is not posted, the job ends stale with the reason", async () => {
    const repo = await repository("enabled: true\n")
    const old = await repo.push(12, "feature", "export const one = 2\n")
    const hub = github(repo, ["ana"])
    hub.prs.push({ number: 12, branch: "feature" })
    let pushed = ""
    const brain = model({ before: async (purpose) => { if (purpose === "review" && !pushed) pushed = await repo.push(12, "feature", "export const one = 3\n") } })
    const ana = daemon({ repo, hub, login: "ana", brain })
    await ana.service.control({ sessionId: "ses_a", action: "publish-on" })
    await ana.service.control({ sessionId: "ses_a", action: "review", pr: "12" })
    await until(() => ["stale", "done", "failed"].includes(ana.jobs()[0]?.state ?? ""))
    expect(pushed).not.toBe(old)
    expect(brain.asked).toEqual(["review", "verify"])
    expect(ana.jobs()[0]).toMatchObject({ head: old, state: "stale", stop: { kind: "superseded", resumable: false } })
    expect(hub.posts).toEqual([])
    expect(hub.reviews.get(12) ?? []).toEqual([])
    expect(ana.service.platform.effects.pending()).toEqual([])
  })
})

describe("a daemon stopped mid-job", () => {
  test("the next daemon on the same data directory recovers the running job, reviews it once more as attempt 2 and posts exactly one review", async () => {
    const repo = await repository("enabled: true\n")
    const head = await repo.push(12, "feature", "export const one = 2\n")
    const hub = github(repo, ["ana"])
    hub.prs.push({ number: 12, branch: "feature" })
    const stuck = model({ hang: true })
    const first = daemon({ repo, hub, login: "ana", brain: stuck })
    await first.service.control({ sessionId: "ses_a", action: "publish-on" })
    void first.service.control({ sessionId: "ses_a", action: "review", pr: "12" })
    await until(() => stuck.started() && first.jobs()[0]?.state === "running")
    const id = first.jobs()[0]!.id
    first.service.stop()

    const brain = model()
    const second = daemon({ repo, hub, login: "ana", brain, data: first.data })
    await until(() => second.service.platform.jobs.get(id)?.state === "done")
    expect(second.service.platform.jobs.get(id)).toMatchObject({ head, state: "done", attempts: 1 })
    expect(brain.asked).toEqual(["review", "verify"])
    expect(reviewsBy(hub, 12, "ana")).toHaveLength(1)
    expect(second.service.platform.effects.pending()).toEqual([])
    // Another poll and a third start queue nothing: the head is reviewed.
    await second.service.tick()
    second.service.stop()
    const third = daemon({ repo, hub, login: "ana", brain, data: first.data })
    await third.service.tick()
    await Bun.sleep(30)
    expect(brain.asked).toEqual(["review", "verify"])
    expect(reviewsBy(hub, 12, "ana")).toHaveLength(1)
  })
})

describe("a personal reviewer whose MendCode is offline", () => {
  test("the VPS records the PR as waiting with the reason; alice's laptop starts later, claims it and posts one real review; the VPS then closes its waiting job as done there", async () => {
    const repo = await repository("enabled: true\n", "reviewers:\n  - id: global\n    scope: global\n  - id: alice\n    scope: personal\n    login: alice\n")
    const head = await repo.push(12, "feature", "export const one = 2\n")
    const hub = github(repo, ["ana", "alice"])
    let shift = 0
    const vpsBrain = model()
    const vps = daemon({ repo, hub, login: "ana", brain: vpsBrain, now: () => Date.now() + shift })
    expect((await vps.service.control({ sessionId: "ses_vps", action: "watch-repo" })).ok).toBe(true)
    hub.prs.push({ number: 12, branch: "feature", requested: ["alice"] })
    await vps.service.tick()
    await until(() => vps.jobs().some((job) => job.reviewer === "global" && job.state === "done"))
    const waiting = vps.jobs().find((job) => job.reviewer === "alice")!
    expect(waiting).toMatchObject({ head, scope: "personal", state: "waiting", attempts: 0 })
    expect(waiting.assignment).toContain("waiting for @alice's MendCode (offline or another device)")
    // The VPS ran only its global reviewer, and posted nothing (no /pr publish on there).
    expect(vpsBrain.asked).toEqual(["review", "verify"])
    expect(hub.posts.filter((post) => post.login === "ana")).toEqual([])

    const laptopBrain = model()
    const laptop = daemon({ repo, hub, login: "alice", brain: laptopBrain })
    await laptop.service.control({ sessionId: "ses_alice", action: "publish-on" })
    expect((await laptop.service.control({ sessionId: "ses_alice", action: "watch-repo", role: "requested" })).ok).toBe(true)
    await laptop.service.tick()
    await until(() => laptop.jobs().some((job) => job.state === "done"))
    expect(laptop.jobs()).toHaveLength(1)
    expect(laptop.jobs()[0]).toMatchObject({ head, reviewer: "alice", scope: "personal", state: "done", owner: laptop.device() })
    const posted = reviewsBy(hub, 12, "alice")
    expect(posted).toHaveLength(1)
    expect(posted[0]!.body).toContain("mendcode:reviewer=alice")
    expect((hub.comments.get(12) ?? []).filter((item) => item.user.login === "alice" && item.body.includes("mendcode:claim"))).toHaveLength(1)

    shift = 11 * 60_000
    await vps.service.tick()
    const closed = vps.jobs().find((job) => job.reviewer === "alice")!
    expect(closed).toMatchObject({ state: "done", owner: laptop.device() })
    expect(vpsBrain.asked).toEqual(["review", "verify"])
    expect(reviewsBy(hub, 12, "alice")).toHaveLength(1)
  })
})

describe("an @mendcode command from someone without write access", () => {
  test("it is refused with one reply, starts no job and no model turn, and is not answered again on the next poll", async () => {
    // No backlog: only the refused comment could start work on the open PR.
    const repo = await repository("enabled: true\nbacklog:\n  max_prs: 0\n")
    const head = await repo.push(12, "feature", "export const one = 2\n")
    const hub = github(repo, ["ana"])
    const brain = model()
    const ana = daemon({ repo, hub, login: "ana", brain })
    await ana.service.control({ sessionId: "ses_a", action: "publish-on" })
    // The PR was open before the watch started: the first poll takes it as seen and reviews nothing, so its head is unreviewed.
    hub.prs.push({ number: 12, branch: "feature" })
    await ana.service.control({ sessionId: "ses_a", action: "watch-repo" })
    await ana.service.tick()
    expect(ana.jobs()).toEqual([])
    hub.comment(12, "mallory", "@mendcode review")
    hub.comment(12, "mallory", "@mendcode fix")
    await ana.service.tick()
    await until(() => ana.notices.filter((text) => text.includes("refused (no write access)")).length === 2)
    const replies = (hub.comments.get(12) ?? []).filter((item) => item.user.login === "ana" && item.body.startsWith(MAINTAINERS_ONLY))
    expect(replies).toHaveLength(2)
    expect(ana.jobs()).toEqual([])
    expect(brain.asked).toEqual([])
    expect(hub.reviews.get(12) ?? []).toEqual([])
    expect(await hub.tip("feature")).toBe(head)
    await ana.service.tick()
    await Bun.sleep(30)
    expect((hub.comments.get(12) ?? []).filter((item) => item.user.login === "ana" && item.body.startsWith(MAINTAINERS_ONLY))).toHaveLength(2)
  })
})

describe("an automatic fix on a fork", () => {
  test("fix.push on and posting allowed, but the fork does not let maintainers modify it: the fix is committed and kept on a local ref, the fork is never pushed", async () => {
    const yaml = "enabled: true\nfix:\n  mode: fix-once\n  push: true\n"
    const repo = await repository(yaml)
    const head = await repo.push(12, "feature", "export const one = 2\n")
    const hub = github(repo, ["ana"])
    hub.prs.push({ number: 12, branch: "feature", fork: true })
    const brain = model()
    const ana = daemon({ repo, hub, login: "ana", brain })
    await ana.service.control({ sessionId: "ses_a", action: "publish-on" })
    await ana.service.control({ sessionId: "ses_a", action: "review", pr: "12" })
    await until(() => ana.notices.some((text) => text.includes("fix mode ended")), 15_000)
    expect(await hub.tip("feature")).toBe(head)
    expect((await gitRun(["for-each-ref", "--format=%(refname)", "refs/mendcode/fix/12/"], repo.dir)).out.trim()).not.toBe("")
    const fork = "the branch lives in a fork that does not let maintainers push"
    expect(ana.notices.find((text) => text.includes("fix mode fix-once"))).toContain(fork)
    expect(ana.notices.find((text) => text.includes("fix mode fix-once"))).not.toContain("fixes are pushed to the branch")
    expect(ana.notices.find((text) => text.includes("fix mode ended"))).toContain("kept")
    expect(ana.jobs()[0]).toMatchObject({ head, state: "done", fixSessionId: "ses_fix" })
    expect(ana.jobs()[0]!.stop?.detail).toContain(fork)
    expect(ana.jobs()[0]!.stop?.detail).not.toContain("`fix.push` is off")
    // The review itself was posted once; nothing else went to GitHub for the fix.
    expect(reviewsBy(hub, 12, "ana")).toHaveLength(1)
    expect(hub.posts.filter((post) => !post.endpoint.endsWith("/reviews"))).toEqual([])
  })
})
