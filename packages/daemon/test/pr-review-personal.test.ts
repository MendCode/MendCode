import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { GhRun } from "../src/pr-watch"
import { parseReviewConfig } from "../src/pr-review/config"
import { gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { parseClaims } from "../src/pr-review/ownership"
import type { GhCall } from "../src/pr-review/publish"
import type { ReviewRun, RunPrReviewInput } from "../src/pr-review/run"
import { CLAIM_TTL_MS, createPrReviewService } from "../src/pr-review/service"
import { emptyState } from "../src/pr-review/state"

/**
 * Personal reviewers across daemons and devices (R02, R04): a PR routed to a reviewer whose MendCode is another daemon waits with
 * its reason and is reviewed once by that daemon when it runs; two devices of one reviewer settle a PR claim (best-effort, the
 * claim posted only with permission to post); `@mendcode review` is a ledger job answered once across a restart; a personal
 * profile narrows eligibility and cannot widen it. Each daemon is a service on its own temp data directory (its own device id)
 * with its own gh login, over one fake GitHub shared by all of them: nothing reaches the network, the review run is stood in for.
 */

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const until = async (check: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await Bun.sleep(10) } }
const git = async (cwd: string, ...args: string[]) => { const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd); if (done.code) throw new Error(`git ${args.join(" ")}: ${done.out}`); return done.out.trim() }

/** A bare origin and a clone with `.mendcode/review.yaml` (and `reviewers.yaml` when given) on main. */
async function repository(yaml: string, reviewers?: string) {
  const origin = temp("pers-origin-"), dir = temp("pers-clone-")
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
  async function push(number: number, branch: string, content: string) {
    await git(dir, "checkout", "-q", "-b", branch, "main")
    writeFileSync(path.join(dir, `${branch}.ts`), content)
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", branch)
    await git(dir, "push", "-q", "-f", "origin", `${branch}:refs/heads/${branch}`, `${branch}:refs/pull/${number}/head`)
    const sha = await git(dir, "rev-parse", "HEAD")
    await git(dir, "checkout", "-q", "main")
    return sha
  }
  return { origin, dir, main, push }
}

type Pr = { number: number; branch: string; requested?: string[]; labels?: string[] }
type Comment = { id: number; body: string; user: { login: string }; author_association?: string; html_url?: string }
type Review = { id: number; commit_id: string; state: string; body: string; user: { login: string; type: string }; author_association: string }

/** GitHub as every daemon sees it: PRs, issue comments (claims, replies), reviews, and the `@mendcode` comments the watches poll. */
function github(repo: Awaited<ReturnType<typeof repository>>) {
  const prs: Pr[] = []
  const comments = new Map<number, Comment[]>()
  const reviews = new Map<number, Review[]>()
  const polled: Array<{ number: number; id: number; body: string; user: string }> = []
  let ids = 1000
  const tip = async (branch: string) => (await gitRun(["rev-parse", `refs/heads/${branch}`], repo.origin)).out.trim()
  const shape = async (pr: Pr) => ({
    number: pr.number, headRefOid: await tip(pr.branch), baseRefOid: repo.main, baseRefName: "main", headRefName: pr.branch,
    url: `https://github.com/acme/app/pull/${pr.number}`, title: `PR ${pr.number}`, author: { login: "bob" }, labels: (pr.labels ?? []).map((name) => ({ name })),
    reviewRequests: (pr.requested ?? []).map((login) => ({ login })), assignees: [], isDraft: false, isCrossRepository: false, maintainerCanModify: true,
  })
  /** One daemon's gh: the same GitHub, its own login. */
  function as(login: string) {
    const calls: string[][] = []
    const run: GhRun = async ({ argv }) => {
      calls.push(argv)
      if (argv[0] === "repo") return { code: 0, out: "acme/app", err: "" }
      if (argv.join(" ") === "api user --jq .login") return { code: 0, out: login, err: "" }
      if (argv[0] === "pr" && argv[1] === "list") return { code: 0, out: JSON.stringify(await Promise.all(prs.map(shape))), err: "" }
      if (argv[0] === "pr" && argv[1] === "view") {
        const pr = prs.find((item) => item.number === Number(argv[2]))
        if (!pr) return { code: 1, out: "", err: "no pull request" }
        return { code: 0, out: JSON.stringify({ ...await shape(pr), body: "", files: [{ path: `${pr.branch}.ts` }] }), err: "" }
      }
      if (argv[0] === "api" && argv[1]?.startsWith("repos/{owner}/{repo}/issues/comments?since=")) return { code: 0, out: polled.map((item) => JSON.stringify({ id: item.id, body: item.body, user: item.user, association: "MEMBER", html_url: `https://github.com/acme/app/pull/${item.number}#issuecomment-${item.id}` })).join("\n"), err: "" }
      if (argv[0] === "api" && /comments\?since=/.test(argv[1] ?? "")) return { code: 0, out: "", err: "" }
      return { code: 1, out: "", err: "unexpected" }
    }
    const call: GhCall = async ({ argv, stdin }) => {
      calls.push(argv)
      const endpoint = argv[1] ?? ""
      const issue = /^repos\/acme\/app\/issues\/(\d+)\/comments/.exec(endpoint)
      if (argv.includes("POST") && issue) {
        const comment = { id: ++ids, body: JSON.parse(stdin!).body as string, user: { login } }
        comments.set(Number(issue[1]), [...comments.get(Number(issue[1])) ?? [], comment])
        return { code: 0, out: JSON.stringify({ id: comment.id }) }
      }
      if (argv.includes("POST")) return { code: 1, out: "", err: `unexpected post ${endpoint}` }
      if (issue) return { code: 0, out: JSON.stringify(comments.get(Number(issue[1])) ?? []) }
      const reviewed = /^repos\/acme\/app\/pulls\/(\d+)\/reviews\?/.exec(endpoint)
      if (reviewed) return { code: 0, out: JSON.stringify(reviews.get(Number(reviewed[1])) ?? []) }
      if (endpoint.endsWith("/permission")) return { code: 0, out: "write" }
      if (endpoint === "repos/acme/app") return { code: 0, out: "true" }
      if (/^repos\/acme\/app\/pulls\/\d+$/.test(endpoint) && argv.includes(".state")) return { code: 0, out: "open" }
      return { code: 0, out: "[]" }
    }
    /** Stands in for a review run: with `publish` it submits a review of the head as this login, as run.ts would. */
    const review = (inputs: RunPrReviewInput[]) => async (input: RunPrReviewInput): Promise<ReviewRun> => {
      inputs.push(input)
      if (!input.publish) return { status: "reviewed", state: emptyState(), incremental: false }
      const posted: Review = { id: ++ids, commit_id: input.head, state: "COMMENTED", body: "## MendCode review", user: { login, type: "User" }, author_association: "MEMBER" }
      reviews.set(input.number, [...reviews.get(input.number) ?? [], posted])
      return { status: "published", state: emptyState(), incremental: false, report: { posted: true, comments: 0 } as never }
    }
    return { run, call, calls, review }
  }
  const claims = (number: number) => parseClaims((comments.get(number) ?? []).map((comment) => ({ body: comment.body, author: comment.user.login })))
  return { prs, comments, reviews, polled, as, claims, tip }
}

/** One daemon: a service on its own data directory (so its own device id) with `login`'s gh. */
function daemon({ repo, hub, login, data = temp(`pers-${login}-`), now }: { repo: Awaited<ReturnType<typeof repository>>; hub: ReturnType<typeof github>; login: string; data?: string; now?: () => number }) {
  const gh = hub.as(login)
  const notices: string[] = []
  const inputs: RunPrReviewInput[] = []
  const sessions = (): ReviewSessionFactory => async () => ({ async send() { return { text: "{}", tokens: { input: 1, output: 1 } } }, async close() {} })
  const service = createPrReviewService({
    dir: data, run: gh.run, call: gh.call, intervalMs: 3_600_000, ...(now ? { now } : {}), enabled: () => true, graphOn: () => false,
    sessionDirectory: () => repo.dir, sessionExists: () => true, notify: (_session, text) => notices.push(text), sessions, editor: sessions,
    schedule: async (job) => { await job() }, random: () => 0.5, review: gh.review(inputs),
  })
  cleanups.push(() => service.stop())
  return { service, data, notices, inputs, gh, jobs: () => service.platform.jobs.all(), device: () => service.platform.device() }
}

const POSTED_CLAIM = /mendcode:claim/
/** The comments on PR `number` that are not claim markers (replies, answers). */
const replies = (hub: ReturnType<typeof github>, number: number) => (hub.comments.get(number) ?? []).filter((comment) => !POSTED_CLAIM.test(comment.body))

describe("a personal reviewer whose MendCode is another daemon", () => {
  test("the PR waits on this daemon with the reason, never fails; alice's daemon finds it from GitHub when it starts and reviews it once; the waiting job then closes as done there", async () => {
    const yaml = "enabled: true\n"
    const repo = await repository(yaml, "reviewers:\n  - id: global\n    scope: global\n  - id: alice\n    scope: personal\n    login: alice\n")
    const hub = github(repo)
    // The VPS's clock can be moved past CLAIM_REFRESH_MS (a waiting job reads its PR again at most that often).
    let shift = 0
    const vps = daemon({ repo, hub, login: "ana", now: () => Date.now() + shift })
    expect((await vps.service.control({ sessionId: "ses_vps", action: "watch-repo" })).ok).toBe(true)
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature", requested: ["alice"] })
    await vps.service.tick()
    await until(() => vps.jobs().some((job) => job.reviewer === "global" && job.state === "done"))
    const waiting = vps.jobs().find((job) => job.reviewer === "alice")!
    expect(waiting).toMatchObject({ number: 12, head, scope: "personal", state: "waiting", attempts: 0 })
    expect(waiting.notBefore).toBeUndefined()
    expect(waiting.error).toBeUndefined()
    expect(waiting.assignment).toBe("waiting for @alice's MendCode (offline or another device); it reviews when that daemon runs · assigned: review requested from @alice")
    // Only the global reviewer ran here; alice's reviewer is unknown to this device until it sees a claim of it.
    expect(vps.inputs.map((input) => input.reviewer?.id)).toEqual(["global"])
    expect((await vps.service.platform.handle.reviewers(repo.dir)).find((entry) => entry.id === "alice")).toMatchObject({ availability: "unknown" })
    await vps.service.tick()
    expect(vps.jobs().find((job) => job.reviewer === "alice")!.state).toBe("waiting")

    // Alice's laptop starts later, with its own data directory and device: the work comes from GitHub's current state.
    const laptop = daemon({ repo, hub, login: "alice" })
    await laptop.service.control({ sessionId: "ses_alice", action: "publish-on" })
    expect((await laptop.service.control({ sessionId: "ses_alice", action: "watch-repo", role: "requested" })).ok).toBe(true)
    await laptop.service.tick()
    await until(() => laptop.jobs().some((job) => job.state === "done"))
    expect(laptop.jobs()).toHaveLength(1)
    expect(laptop.jobs()[0]).toMatchObject({ number: 12, head, reviewer: "alice", scope: "personal", trigger: "requested", state: "done", owner: laptop.device() })
    expect(laptop.jobs()[0]!.assignment).toContain("review requested from @alice")
    expect(laptop.inputs).toHaveLength(1)
    // It claimed the PR before it ran: one hidden marker, posted as alice, naming the laptop's device.
    expect(hub.claims(12)).toEqual([expect.objectContaining({ reviewer: "alice", owner: laptop.device(), author: "alice", repo: "acme/app", number: 12 })])
    expect(laptop.service.platform.effects.pending()).toEqual([])
    // Once: another poll, and a restart of the laptop's daemon, queue nothing more.
    await laptop.service.tick()
    laptop.service.stop()
    const restarted = daemon({ repo, hub, login: "alice", data: laptop.data })
    await restarted.service.tick()
    await Bun.sleep(30)
    expect(laptop.inputs).toHaveLength(1)
    expect(restarted.inputs).toHaveLength(0)
    expect(restarted.jobs()).toHaveLength(1)
    expect(hub.reviews.get(12)?.filter((review) => review.user.login === "alice")).toHaveLength(1)

    // The VPS reads the PR again: alice reviewed this head on the laptop, so its waiting job is done there, not here.
    shift = 11 * 60_000
    await vps.service.tick()
    const closed = vps.jobs().find((job) => job.reviewer === "alice")!
    expect(closed.state).toBe("done")
    expect(closed.owner).toBe(laptop.device())
    expect(closed.assignment).toStartWith(`reviewed by @alice's MendCode on device ${laptop.device()} (review `)
    expect(vps.inputs).toHaveLength(1)
    expect((await vps.service.platform.handle.reviewers(repo.dir)).find((entry) => entry.id === "alice")).toMatchObject({ availability: "online", device: laptop.device() })
  })

  test("a personal reviewer pinned to another device waits on its own login's daemon too, naming the device", async () => {
    const repo = await repository("enabled: true\n", "reviewers:\n  - id: alice\n    scope: personal\n    login: alice\n    device: alice-vps\n")
    const hub = github(repo)
    const laptop = daemon({ repo, hub, login: "alice" })
    await laptop.service.control({ sessionId: "ses_alice", action: "watch-repo" })
    await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature", requested: ["alice"] })
    await laptop.service.tick()
    await until(() => laptop.jobs().length === 1)
    expect(laptop.jobs()[0]).toMatchObject({ reviewer: "alice", state: "waiting" })
    expect(laptop.jobs()[0]!.assignment).toStartWith("waiting for @alice's MendCode (offline or another device; pinned to device alice-vps); it reviews when that daemon runs")
    await laptop.service.tick()
    expect(laptop.inputs).toHaveLength(0)
    expect(hub.claims(12)).toEqual([])
    // Closed meanwhile: nothing is left to wait for.
    hub.prs.splice(0)
    await laptop.service.tick()
    expect(laptop.jobs()[0]).toMatchObject({ state: "cancelled", error: "the pull request is no longer open" })
  })
})

describe("two devices of one reviewer", () => {
  test("one runs; the other waits naming the holder, whether it learns of the claim at its catch-up or when its own queued job starts", async () => {
    const repo = await repository("enabled: true\n")
    const hub = github(repo)
    await repo.push(12, "feature", "export const one = 2\n")
    await repo.push(13, "other", "export const two = 2\n")
    // #13 requests nobody, so neither watch queues it by itself: the race below queues it by hand on both devices.
    hub.prs.push({ number: 12, branch: "feature", requested: ["alice"] }, { number: 13, branch: "other" })
    const desk = daemon({ repo, hub, login: "alice" })
    const laptop = daemon({ repo, hub, login: "alice" })
    expect(desk.device()).not.toBe(laptop.device())
    for (const device of [desk, laptop]) await device.service.control({ sessionId: "ses_alice", action: "publish-on" })

    // The desk starts first: it claims #12 and reviews it.
    await desk.service.control({ sessionId: "ses_alice", action: "watch-repo", role: "requested" })
    await desk.service.tick()
    await until(() => desk.jobs().some((job) => job.state === "done"))
    expect(desk.jobs()[0]).toMatchObject({ number: 12, reviewer: "personal:alice", state: "done" })
    const held = hub.claims(12)
    expect(held).toEqual([expect.objectContaining({ reviewer: "personal.alice", owner: desk.device(), author: "alice" })])

    // The laptop starts while the desk's claim is live: #12 is recorded as waiting for the desk, until the claim expires.
    await laptop.service.control({ sessionId: "ses_alice", action: "watch-repo", role: "requested" })
    await laptop.service.tick()
    await until(() => laptop.jobs().length === 1)
    const parked = laptop.jobs()[0]!
    expect(parked).toMatchObject({ number: 12, reviewer: "personal:alice", state: "waiting", notBefore: held[0]!.expiresAt + 1_000 })
    expect(parked.assignment).toStartWith(`waiting: @alice's MendCode on device ${desk.device()} claimed this pull request until `)
    expect(parked.assignment).toContain("; it reviews there")
    expect(laptop.inputs).toHaveLength(0)

    // A race: both queued #13 before either claimed it. The desk's job claims and runs; the laptop's, starting after, reads the
    // desk's claim at its start and waits instead of reviewing #13 a second time.
    const head = await hub.tip("other")
    const queue = (device: typeof desk) => device.service.platform.jobs.upsert({ provider: "github", repo: "acme/app", directory: repo.dir, number: 13, sessionId: "ses_alice", reviewer: "personal:alice", scope: "personal", trigger: "requested", coverage: "full", base: repo.main, head, configKey: "" })
    const mine = queue(desk), theirs = queue(laptop)
    await desk.service.tick()
    await until(() => desk.service.platform.jobs.get(mine.id)?.state === "done")
    await laptop.service.tick()
    await until(() => laptop.service.platform.jobs.get(theirs.id)?.state === "waiting")
    const loser = laptop.service.platform.jobs.get(theirs.id)!
    expect(loser.assignment).toStartWith(`waiting: @alice's MendCode on device ${desk.device()} claimed this pull request until `)
    expect(loser.notBefore).toBe(hub.claims(13)[0]!.expiresAt + 1_000)
    expect(loser.error).toBeUndefined()
    expect(laptop.inputs).toHaveLength(0)
    expect(desk.inputs.map((input) => input.number)).toEqual([12, 13])
    expect((await laptop.service.platform.handle.reviewers(repo.dir)).find((entry) => entry.id === "personal:alice")).toMatchObject({ availability: "online" })
  })

  test("an expired claim no longer holds: the waiting device claims above its fence and runs", async () => {
    const repo = await repository("enabled: true\n")
    const hub = github(repo)
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature", requested: ["alice"] })
    // A claim of a device that went away, expired an hour ago, with fence 7.
    const at = Date.now() - 3 * 60 * 60_000
    hub.comments.set(12, [{ id: 1, user: { login: "alice" }, body: `<!-- mendcode:claim key=${encodeURIComponent("pr/acme/app/12/personal.alice")} reviewer=personal.alice owner=old-desk fence=7 acquired=${at} expires=${at + CLAIM_TTL_MS} -->` }])
    const laptop = daemon({ repo, hub, login: "alice" })
    await laptop.service.control({ sessionId: "ses_alice", action: "publish-on" })
    await laptop.service.control({ sessionId: "ses_alice", action: "watch-repo", role: "requested" })
    await laptop.service.tick()
    await until(() => laptop.jobs().some((job) => job.state === "done"))
    expect(laptop.jobs()[0]).toMatchObject({ head, state: "done" })
    const live = hub.claims(12).find((claim) => claim.owner === laptop.device())!
    expect(live.fence).toBe(8)
  })
})

describe("claims and consent", () => {
  test("without /pr publish on the claim is kept local: no comment is posted, nothing is pending, and the review still runs", async () => {
    const repo = await repository("enabled: true\n")
    const hub = github(repo)
    await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature", requested: ["alice"] })
    const laptop = daemon({ repo, hub, login: "alice" })
    await laptop.service.control({ sessionId: "ses_alice", action: "watch-repo", role: "requested" })
    await laptop.service.tick()
    await until(() => laptop.jobs().some((job) => job.state === "done"))
    expect(laptop.inputs).toHaveLength(1)
    expect(hub.comments.get(12) ?? []).toEqual([])
    expect(laptop.gh.calls.some((argv) => argv.includes("POST"))).toBe(false)
    expect(laptop.service.platform.effects.pending()).toEqual([])
    // The local lease held the key with fence 1 while the job ran and was released when it ended; the fence stays, so the next
    // claim of the key is above it.
    expect(laptop.service.platform.ownership.current("pr/acme/app/12/personal.alice")).toBeUndefined()
    const next = laptop.service.platform.ownership.claim("pr/acme/app/12/personal.alice", laptop.device(), 60_000)
    expect(next.ok && next.lease.fence).toBe(2)
  })

  test("a repository whose publishers do not list this login gets no claim either, even with /pr publish on", async () => {
    const repo = await repository("enabled: true\npublishers: [ana]\n")
    const hub = github(repo)
    await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature", requested: ["alice"] })
    const laptop = daemon({ repo, hub, login: "alice" })
    await laptop.service.control({ sessionId: "ses_alice", action: "publish-on" })
    await laptop.service.control({ sessionId: "ses_alice", action: "watch-repo", role: "requested" })
    await laptop.service.tick()
    await until(() => laptop.jobs().some((job) => job.state === "done"))
    expect((hub.comments.get(12) ?? []).some((comment) => POSTED_CLAIM.test(comment.body))).toBe(false)
  })
})

describe("@mendcode review as a ledger job", () => {
  test("it runs as a job with trigger comment, is answered by the review it posts, and is answered once across a restart and a crash mid-run", async () => {
    // No backlog: the open PR waits for the comment that asks for it.
    const repo = await repository("enabled: true\nbacklog:\n  max_prs: 0\n")
    const hub = github(repo)
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    const data = temp("pers-ana-")
    const first = daemon({ repo, hub, login: "ana", data })
    await first.service.control({ sessionId: "ses_a", action: "publish-on" })
    await first.service.control({ sessionId: "ses_a", action: "watch-repo" })
    hub.polled.push({ number: 12, id: 501, body: "@mendcode review", user: "carol" })
    await first.service.tick()
    await until(() => first.jobs().some((job) => job.state === "done"))
    expect(first.jobs()).toHaveLength(1)
    const [job] = first.jobs()
    expect(job).toMatchObject({ number: 12, head, reviewer: "global", trigger: "comment", state: "done", coverage: "full", owner: first.device() })
    expect(job!.assignment).toBe("@mendcode review from @carol")
    expect(first.inputs).toHaveLength(1)
    expect(first.inputs[0]!.publishAs).toMatchObject({ jobId: job!.id, reviewer: "global" })
    // Answered by the review itself: no reply comment, one review. The global reviewer claimed the PR too (one marker comment).
    expect(replies(hub, 12)).toEqual([])
    expect(hub.claims(12)).toEqual([expect.objectContaining({ reviewer: "global", owner: first.device(), author: "ana" })])
    expect(hub.reviews.get(12)).toHaveLength(1)
    const watchesFile = path.join(data, "pr-review", "watches.json")
    /** The running watch's record (`/pr publish on` before the watch left a stopped one first). */
    const running = (file: { watches: Array<{ ended?: unknown; commands?: unknown[] }> }) => file.watches.find((watch) => !watch.ended)!
    const kept = () => running(JSON.parse(readFileSync(watchesFile, "utf8"))).commands ?? []
    await until(() => kept().length === 0)
    first.service.stop()

    // A restart: the comment is not taken again.
    const second = daemon({ repo, hub, login: "ana", data })
    await second.service.tick()
    await Bun.sleep(30)
    expect(second.inputs).toHaveLength(0)
    expect(second.jobs()).toHaveLength(1)
    second.service.stop()

    // A crash mid-run: the job is still running on disk and the command still kept. The next start recovers the job (the only
    // review run), and the kept command finds that review on the PR instead of reviewing or replying again.
    hub.reviews.delete(12)
    const jobsFile = path.join(data, "pr-review", "jobs.json")
    const ledger = JSON.parse(readFileSync(jobsFile, "utf8"))
    ledger.jobs[0].state = "running"
    writeFileSync(jobsFile, JSON.stringify(ledger))
    const watches = JSON.parse(readFileSync(watchesFile, "utf8"))
    running(watches).commands = [{ comment: { id: 501, surface: "issue", actor: "carol", body: "@mendcode review", association: "MEMBER" }, number: 12 }]
    writeFileSync(watchesFile, JSON.stringify(watches))
    const third = daemon({ repo, hub, login: "ana", data })
    await until(() => third.jobs()[0]?.state === "done")
    await third.service.tick()
    await until(() => kept().length === 0)
    expect(third.inputs).toHaveLength(1)
    expect(third.jobs()).toHaveLength(1)
    expect(third.jobs()[0]).toMatchObject({ trigger: "comment", state: "done", attempts: 1 })
    expect(hub.reviews.get(12)).toHaveLength(1)
    expect(replies(hub, 12)).toEqual([])
    expect(third.notices.some((text) => text.includes("@ana already reviewed this head"))).toBe(true)
  })

  test("a pending job of the same reviewer and head is reused, not doubled; a running one makes the comment wait for its review", async () => {
    const repo = await repository("enabled: true\n")
    const hub = github(repo)
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    const ana = daemon({ repo, hub, login: "ana" })
    await ana.service.control({ sessionId: "ses_a", action: "publish-on" })
    const queued = ana.service.platform.jobs.upsert({ provider: "github", repo: "acme/app", directory: repo.dir, number: 12, sessionId: "ses_a", reviewer: "global", scope: "global", trigger: "opened", coverage: "full", base: repo.main, head, configKey: "", notBefore: Date.now() + 3_600_000, assignment: "the repository's global reviewer" })
    const command = { kind: "command" as const, directory: repo.dir, sessionId: "ses_a", number: 12, head, trigger: "comment" as const, command: { kind: "review" as const }, comment: { id: 601, surface: "issue" as const, actor: "carol", body: "@mendcode review", association: "MEMBER" } }
    expect(await ana.service.command(command)).toBeUndefined()
    expect(ana.jobs()).toHaveLength(1)
    expect(ana.jobs()[0]).toMatchObject({ id: queued.id, trigger: "comment", state: "done", assignment: "@mendcode review from @carol; the repository's global reviewer" })
    expect(ana.inputs).toHaveLength(1)

    // A job of the next head runs now (here, or recovered after a crash): the comment waits for it, without a reply.
    const next = await repo.push(12, "feature-2", "export const one = 3\n")
    const running = ana.service.platform.jobs.upsert({ provider: "github", repo: "acme/app", directory: repo.dir, number: 12, sessionId: "ses_a", reviewer: "global", scope: "global", trigger: "synchronize", coverage: "incremental", base: repo.main, head: next, configKey: "", state: "running" })
    expect(await ana.service.command({ ...command, head: next, comment: { ...command.comment, id: 602 } })).toEqual({ blocked: "job" })
    expect(ana.notices.at(-1)).toContain(`waits: job ${running.id} reviews this head now`)
    expect(ana.jobs()).toHaveLength(2)
    expect(ana.inputs).toHaveLength(1)
    expect(replies(hub, 12)).toEqual([])
  })
})

describe("a personal profile and eligibility", () => {
  test("the personal layer narrows what the personal reviewer takes; a wider value is refused and changes nothing", async () => {
    const yaml = "enabled: true\nfilters:\n  labels:\n    exclude: [blocked]\n"
    const repo = await repository(yaml)
    const hub = github(repo)
    await repo.push(12, "wip", "export const one = 2\n")
    await repo.push(13, "ready", "export const two = 2\n")
    await repo.push(14, "blocked", "export const three = 3\n")
    hub.prs.push({ number: 12, branch: "wip", requested: ["ana"], labels: ["wip"] }, { number: 13, branch: "ready", requested: ["ana"] }, { number: 14, branch: "blocked", requested: ["ana"], labels: ["blocked"] })
    const ana = daemon({ repo, hub, login: "ana" })
    // Narrower: the label wip is excluded too. Wider: an empty exclude list and every author's bots, which the repository has off.
    ana.service.platform.profiles.save({ provider: "github", repo: "acme/app", login: "ana" }, { config: { filters: { labels: { exclude: ["wip"] }, authors: { bots: true } } }, summary: "skip my drafts" })
    await ana.service.control({ sessionId: "ses_a", action: "watch-repo", role: "requested" })
    await ana.service.tick()
    await until(() => ana.jobs().some((job) => job.state === "done"))
    await ana.service.tick()
    expect(ana.jobs().map((job) => [job.number, job.reviewer, job.state])).toEqual([[13, "personal:ana", "done"]])
    const list = await ana.service.control({ sessionId: "ses_a", action: "list" })
    expect(list.ok && list.text).toContain("#12: personal:ana: personal profile: label `wip` excluded")
    // The repository's own exclusion still holds: the profile cannot take it back.
    expect(list.ok && list.text).toContain("#14: label `blocked` excluded")
    expect(ana.inputs.map((input) => input.number)).toEqual([13])
  })

  test("a profile mode wider than the repository's is refused: on-request stays on-request for the personal reviewer", async () => {
    const yaml = "enabled: true\nmode: on-request\n"
    const repo = await repository(yaml, "reviewers:\n  - id: ana-backend\n    scope: personal\n    login: ana\n    areas: [\"api.ts\"]\nrouting:\n  global: personal-only\n  fallback: none\n")
    const hub = github(repo)
    const ana = daemon({ repo, hub, login: "ana" })
    ana.service.platform.profiles.save({ provider: "github", repo: "acme/app", login: "ana" }, { config: { mode: "auto" }, summary: "review everything" })
    expect(parseReviewConfig(yaml).config.mode).toBe("on-request")
    await ana.service.control({ sessionId: "ses_a", action: "watch-repo" })
    await repo.push(12, "api", "export const api = 1\n")
    hub.prs.push({ number: 12, branch: "api" })
    await ana.service.tick()
    await Bun.sleep(30)
    expect(ana.jobs()).toEqual([])
    const list = await ana.service.control({ sessionId: "ses_a", action: "list" })
    expect(list.ok && list.text).toContain("#12: on-request: not requested")
  })
})

describe("a requested watch and area routing", () => {
  test("a requested watch also takes a PR that routing gives its login's personal reviewer by area, never the global reviewer's work or another login's area", async () => {
    const reviewers = "reviewers:\n  - id: global\n    scope: global\n  - id: alice-api\n    scope: personal\n    login: alice\n    areas: [\"api-*.ts\"]\n  - id: bob-web\n    scope: personal\n    login: bob\n    areas: [\"web-*.ts\"]\n"
    const repo = await repository("enabled: true\n", reviewers)
    const hub = github(repo)
    const laptop = daemon({ repo, hub, login: "alice" })
    const started = await laptop.service.control({ sessionId: "ses_alice", action: "watch-repo", role: "requested" })
    expect(started.ok && started.text).toContain("routes to @alice's personal reviewer by area or label")
    const api = await repo.push(12, "api-users", "export const users = 1\n")
    await repo.push(13, "web-page", "export const page = 1\n")
    await repo.push(14, "docs", "export const docs = 1\n")
    hub.prs.push({ number: 12, branch: "api-users" }, { number: 13, branch: "web-page" }, { number: 14, branch: "docs" })
    await laptop.service.tick()
    await until(() => laptop.jobs().some((job) => job.state === "done"))
    await laptop.service.tick()
    // Only alice's area: not bob's (#13), not the global reviewer's (#14, and #12's global share), and nothing kept waiting for them.
    expect(laptop.jobs().map((job) => [job.number, job.reviewer, job.scope, job.trigger, job.state])).toEqual([[12, "alice-api", "personal", "opened", "done"]])
    expect(laptop.jobs()[0]).toMatchObject({ head: api })
    expect(laptop.jobs()[0]!.assignment).toContain("touches api-*.ts (alice-api: @alice)")
    expect(laptop.inputs.map((input) => [input.number, input.reviewer?.id])).toEqual([[12, "alice-api"]])
    const list = await laptop.service.control({ sessionId: "ses_alice", action: "list" })
    expect(list.ok && list.text).not.toContain("no reviewer of this daemon is assigned")
  })

  test("an @mendcode review addressed to no one is taken on a PR only area routing gives the login, not on another login's area or the global reviewer's PR", async () => {
    const reviewers = "reviewers:\n  - id: global\n    scope: global\n  - id: alice-api\n    scope: personal\n    login: alice\n    areas: [\"api-*.ts\"]\n  - id: bob-web\n    scope: personal\n    login: bob\n    areas: [\"web-*.ts\"]\n"
    // No backlog and no automatic reviews: only the comments start anything.
    const repo = await repository("enabled: true\nbacklog:\n  max_prs: 0\ntriggers:\n  opened: false\n  synchronize: false\n", reviewers)
    const hub = github(repo)
    const api = await repo.push(12, "api-users", "export const users = 1\n")
    await repo.push(13, "web-page", "export const page = 1\n")
    await repo.push(14, "docs", "export const docs = 1\n")
    hub.prs.push({ number: 12, branch: "api-users" }, { number: 13, branch: "web-page" }, { number: 14, branch: "docs" })
    const laptop = daemon({ repo, hub, login: "alice" })
    await laptop.service.control({ sessionId: "ses_alice", action: "publish-on" })
    expect((await laptop.service.control({ sessionId: "ses_alice", action: "watch-repo", role: "requested" })).ok).toBe(true)
    await laptop.service.tick()
    expect(laptop.jobs()).toEqual([])
    hub.polled.push({ number: 12, id: 701, body: "@mendcode review", user: "carol" }, { number: 13, id: 702, body: "@mendcode review", user: "carol" }, { number: 14, id: 703, body: "@mendcode review", user: "carol" })
    await laptop.service.tick()
    await until(() => laptop.jobs().some((job) => job.state === "done"))
    await laptop.service.tick()
    await Bun.sleep(30)
    // #12 routes to alice-api by area: hers. #13 is bob's area and #14 the global reviewer's: not hers, and nothing is said on them.
    expect(laptop.jobs().map((job) => [job.number, job.reviewer, job.trigger, job.state])).toEqual([[12, "alice-api", "comment", "done"]])
    expect(laptop.jobs()[0]).toMatchObject({ head: api })
    expect(laptop.inputs.map((input) => input.number)).toEqual([12])
    expect(replies(hub, 13)).toEqual([])
    expect(replies(hub, 14)).toEqual([])
  })

  test("without an area or label route the login's requested watch reads no files for an unaddressed comment and leaves it", async () => {
    const reviewers = "reviewers:\n  - id: global\n    scope: global\n  - id: alice\n    scope: personal\n    login: alice\n"
    const repo = await repository("enabled: true\nbacklog:\n  max_prs: 0\ntriggers:\n  opened: false\n", reviewers)
    const hub = github(repo)
    await repo.push(12, "api-users", "export const users = 1\n")
    hub.prs.push({ number: 12, branch: "api-users" })
    const laptop = daemon({ repo, hub, login: "alice" })
    expect((await laptop.service.control({ sessionId: "ses_alice", action: "watch-repo", role: "requested" })).ok).toBe(true)
    await laptop.service.tick()
    hub.polled.push({ number: 12, id: 801, body: "@mendcode review", user: "carol" })
    await laptop.service.tick()
    await Bun.sleep(50)
    expect(laptop.jobs()).toEqual([])
    expect(laptop.gh.calls.filter((argv) => argv[0] === "pr" && argv[1] === "view" && argv.includes("files"))).toEqual([])
  })
})
