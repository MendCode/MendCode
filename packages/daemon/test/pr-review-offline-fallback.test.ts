import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { GhRun } from "../src/pr-watch"
import { gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { findingId } from "../src/pr-review/findings"
import { claimMarker, parseClaims, prClaimKey } from "../src/pr-review/ownership"
import type { GhCall } from "../src/pr-review/publish"
import { parseRegistry } from "../src/pr-review/registry"
import { createPrReviewService } from "../src/pr-review/service"

/**
 * `routing.offline_fallback` (R02, docs/pr-review.md "Offline fallback"): a PR routed only to a personal reviewer whose laptop is
 * off waits for it; with the fallback set, the repository's global reviewer reviews it after the configured time, says why and for
 * whom, and marks its claim so the personal reviewer, when it comes back, finds that review and posts nothing. Without the key
 * nothing changes. Two daemons (a VPS as `ana`, the global reviewer; alice's laptop) share one fake GitHub; real git and the real
 * review run with scripted model turns. A shared fake clock stands in for the minutes. Contract evidence, not live.
 */

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const until = async (check: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await Bun.sleep(10) } }
const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]
const git = async (cwd: string, ...args: string[]) => { const done = await gitRun([...GIT_ID, ...args], cwd); if (done.code) throw new Error(`git ${args.join(" ")}: exit ${done.code}`); return done.out.trim() }
const MINUTE = 60_000

const registry = (fallback: string) => `reviewers:
  - id: team
    scope: global
    login: ana
  - id: alice-backend
    scope: personal
    login: alice
routing:
  global: personal-only
${fallback}`
const FALLBACK = "  offline_fallback:\n    after_minutes: 30\n"

async function repository(reviewers: string) {
  const origin = temp("off-origin-"), dir = temp("off-clone-")
  await git(origin, "init", "-q", "--bare", "-b", "main")
  await git(dir, "init", "-q", "-b", "main")
  mkdirSync(path.join(dir, ".mendcode"))
  writeFileSync(path.join(dir, ".mendcode", "review.yaml"), "enabled: true\n")
  writeFileSync(path.join(dir, ".mendcode", "reviewers.yaml"), reviewers)
  writeFileSync(path.join(dir, "a.ts"), "export const one = 1\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  const main = await git(dir, "rev-parse", "HEAD")
  await git(dir, "remote", "add", "origin", origin)
  await git(dir, "push", "-q", "origin", "main")
  for (const [key, value] of [["user.name", "t"], ["user.email", "t@example.invalid"], ["commit.gpgsign", "false"]] as const) await git(dir, "config", key, value)
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
  async function clone() {
    const other = temp("off-device-")
    await git(path.dirname(other), "clone", "-q", origin, other)
    for (const [key, value] of [["user.name", "t"], ["user.email", "t@example.invalid"], ["commit.gpgsign", "false"]] as const) await git(other, "config", key, value)
    return other
  }
  return { origin, dir, main, push, clone }
}

type Comment = { id: number; body: string; user: { login: string } }
type Review = { id: number; commit_id: string; state: string; body: string; user: { login: string; type: string }; author_association: string }

function github(repo: Awaited<ReturnType<typeof repository>>) {
  const prs: Array<{ number: number; branch: string; requested?: string[] }> = []
  const comments = new Map<number, Comment[]>()
  const reviews = new Map<number, Review[]>()
  let ids = 7000
  const tip = async (branch: string) => (await gitRun(["rev-parse", `refs/heads/${branch}`], repo.origin)).out.trim()
  const shape = async (pr: (typeof prs)[number]) => ({
    number: pr.number, headRefOid: await tip(pr.branch), baseRefOid: repo.main, baseRefName: "main", headRefName: pr.branch,
    url: `https://github.com/acme/app/pull/${pr.number}`, title: `PR ${pr.number}`, author: { login: "bob" }, labels: [],
    reviewRequests: (pr.requested ?? []).map((login) => ({ login })), assignees: [], isDraft: false, isCrossRepository: false, maintainerCanModify: true,
    headRepository: { name: "app" }, headRepositoryOwner: { login: "acme" },
  })
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
      if (argv[0] === "api" && /comments\?since=/.test(argv[1] ?? "")) return { code: 0, out: "", err: "" }
      return { code: 1, out: "", err: "unexpected" }
    }
    const call: GhCall = async ({ argv, stdin }) => {
      const endpoint = argv[1] ?? ""
      const issue = /^repos\/acme\/app\/issues\/(\d+)\/comments/.exec(endpoint)
      const edit = /^repos\/acme\/app\/issues\/comments\/(\d+)$/.exec(endpoint)
      const pull = /^repos\/acme\/app\/pulls\/(\d+)\/reviews(?:\?|$)/.exec(endpoint)
      const body = JSON.parse(stdin ?? "{}") as { body?: string; commit_id?: string }
      if (argv.includes("PATCH") && edit) {
        for (const list of comments.values()) for (const item of list) if (item.id === Number(edit[1]) && item.user.login === login) { item.body = body.body ?? ""; return { code: 0, out: JSON.stringify({ id: item.id }) } }
        return { code: 1, out: "", err: "HTTP 404" }
      }
      if (argv.includes("POST") && issue) { const item = { id: ++ids, body: body.body ?? "", user: { login } }; comments.set(Number(issue[1]), [...comments.get(Number(issue[1])) ?? [], item]); return { code: 0, out: JSON.stringify({ id: item.id }) } }
      if (argv.includes("POST") && pull) {
        const review: Review = { id: ++ids, commit_id: body.commit_id ?? "", state: "COMMENTED", body: body.body ?? "", user: { login, type: "User" }, author_association: "MEMBER" }
        reviews.set(Number(pull[1]), [...reviews.get(Number(pull[1])) ?? [], review])
        return { code: 0, out: JSON.stringify({ id: review.id, commit_id: review.commit_id }) }
      }
      if (argv.includes("POST")) return { code: 1, out: "", err: `unexpected post ${endpoint}` }
      if (issue) return { code: 0, out: JSON.stringify((comments.get(Number(issue[1])) ?? []).map((item) => ({ ...item, author_association: "MEMBER" }))) }
      if (pull) return { code: 0, out: JSON.stringify(reviews.get(Number(pull[1])) ?? []) }
      if (/\/collaborators\/[^/]+\/permission$/.test(endpoint)) return { code: 0, out: argv.includes("--jq") ? "write" : JSON.stringify({ permission: "write" }) }
      if (endpoint === "repos/acme/app") return { code: 0, out: "true" }
      if (/^repos\/acme\/app\/pulls\/\d+$/.test(endpoint) && argv.includes(".state")) return { code: 0, out: "open" }
      if (endpoint === "graphql") return { code: 0, out: "{}" }
      return { code: 0, out: "[]" }
    }
    return { run, call }
  }
  const claims = (number: number) => parseClaims((comments.get(number) ?? []).map((item) => ({ body: item.body, author: item.user.login })))
  return { prs, comments, reviews, as, claims, tip }
}

const FINDING = { path: "feature.ts", line: 1, severity: "major", category: "correctness", summary: "one is now 2", detail: "Callers expect 1.", evidence: ["feature.ts:1"] }
const FINDING_ID = findingId({ path: FINDING.path, line: FINDING.line, category: FINDING.category, summary: FINDING.summary })
const latch = () => { let open!: () => void; const shut = new Promise<void>((resolve) => { open = resolve }); return { shut, open } }
function model(gate?: Promise<void>) {
  const asked: string[] = []
  const factory = (): ReviewSessionFactory => async ({ purpose }) => ({
    id: `ses_${purpose}`,
    async send() {
      asked.push(purpose)
      if (purpose === "review") await gate
      const text = purpose === "review" ? JSON.stringify({ summary: "Changes one.", findings: [FINDING] }) : JSON.stringify({ verdicts: [{ id: FINDING_ID, verdict: "confirmed", evidence: ["feature.ts:1 exports 2"] }] })
      return { text, tokens: { input: 1_000, output: 100 } }
    },
    async close() {},
  }) as never
  return { factory, asked }
}

function daemon({ hub, login, brain, checkout, clock }: { hub: ReturnType<typeof github>; login: string; brain: ReturnType<typeof model>; checkout: string; clock: { now: number } }) {
  const gh = hub.as(login)
  const notices: string[] = []
  const service = createPrReviewService({
    dir: temp(`off-${login}-`), run: gh.run, call: gh.call, intervalMs: 3_600_000, enabled: () => true, graphOn: () => false, now: () => clock.now,
    sessionDirectory: () => checkout, sessionExists: () => true, notify: (_session, text) => notices.push(text),
    sessions: brain.factory, editor: () => (async () => { throw new Error("no fix session in these tests") }) as never, schedule: async (job) => { await job() }, random: () => 0.5, sleep: async () => {},
  })
  cleanups.push(() => service.stop())
  const jobs = (number: number) => service.platform.jobs.all().filter((item) => item.number === number)
  const job = (number: number, reviewer: string) => jobs(number).find((item) => item.reviewer === reviewer)
  return { service, notices, jobs, job, device: () => service.platform.device() }
}
const start = async (d: ReturnType<typeof daemon>) => {
  await d.service.control({ sessionId: "ses", action: "publish-on" })
  expect((await d.service.control({ sessionId: "ses", action: "watch-repo", role: "all" })).ok).toBe(true)
}

describe("routing.offline_fallback: the registry key", () => {
  test("it resolves to a global reviewer with its time; a personal or unknown stand-in is a problem, and unset changes nothing", () => {
    const set = parseRegistry(registry(FALLBACK))
    expect(set.problems).toEqual([])
    expect(set.registry.routing.offlineFallback).toEqual({ reviewer: "team", afterMs: 30 * MINUTE })
    expect(parseRegistry(registry("")).registry.routing.offlineFallback).toBeUndefined()
    expect(parseRegistry(registry("  offline_fallback:\n    after_minutes: 5\n    reviewer: alice-backend\n")).problems.join("\n")).toContain("is a personal reviewer; the fallback must be global")
    expect(parseRegistry(registry("  offline_fallback:\n    after_minutes: 5\n    reviewer: nobody\n")).problems.join("\n")).toContain('routing.offline_fallback.reviewer: unknown reviewer "nobody"')
    expect(parseRegistry(registry("  offline_fallback:\n    after_minutes: 0\n")).problems.join("\n")).toContain("after_minutes")
  })

  test("a stand-in's claim names whom it covers; a reader of an older marker sees no covers", () => {
    const key = prClaimKey({ repo: "acme/app", number: 12, reviewer: "team" })
    const marker = claimMarker({ key, owner: "vps", fence: 1, acquiredAt: 1, expiresAt: 1 + MINUTE }, "team", ["alice-backend"])
    expect(marker).toContain("covers=alice-backend")
    expect(parseClaims([marker])[0]!.covers).toEqual(["alice-backend"])
    expect(parseClaims([claimMarker({ key, owner: "vps", fence: 1, acquiredAt: 1, expiresAt: 1 + MINUTE }, "team")])[0]!.covers).toBeUndefined()
  })
})

describe("routing.offline_fallback through two daemons", () => {
  test("default unchanged: without the key a PR routed to alice's offline laptop only waits, however long", async () => {
    const repo = await repository(registry(""))
    const hub = github(repo)
    const clock = { now: Date.now() }
    const brain = model()
    const vps = daemon({ hub, login: "ana", brain, checkout: repo.dir, clock })
    await start(vps)
    await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature", requested: ["alice"] })
    await vps.service.tick()
    await until(() => vps.jobs(12).length > 0)
    clock.now += 6 * 60 * MINUTE
    await vps.service.tick()
    await Bun.sleep(50)
    expect(vps.jobs(12).map((job) => [job.reviewer, job.state])).toEqual([["alice-backend", "waiting"]])
    expect(brain.asked).toEqual([])
    expect(hub.reviews.get(12) ?? []).toEqual([])
  }, 30_000)

  test("alice stays offline: after 30 minutes the global reviewer reviews it once, naming why and for whom; when her laptop comes back it posts nothing", async () => {
    const repo = await repository(registry(FALLBACK))
    const hub = github(repo)
    const clock = { now: Date.now() }
    const vpsBrain = model()
    const vps = daemon({ hub, login: "ana", brain: vpsBrain, checkout: repo.dir, clock })
    await start(vps)
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature", requested: ["alice"] })
    await vps.service.tick()
    await until(() => vps.job(12, "team") !== undefined)
    // Before its time the stand-in only waits, with the reason and the recipient on the job.
    const armed = vps.job(12, "team")!
    expect(armed.state).toBe("waiting")
    expect(armed.covers).toEqual(["alice-backend"])
    expect(armed.assignment).toStartWith("offline fallback: team reviews this pull request at ")
    expect(armed.assignment).toContain("unless @alice's MendCode (alice-backend) claims or reviews its head first")
    expect(armed.assignment).toContain("assigned: offline fallback for alice-backend after 30 min (routing.offline_fallback)")
    expect(vps.job(12, "alice-backend")?.state).toBe("waiting")
    clock.now += 10 * MINUTE
    await vps.service.tick()
    await Bun.sleep(50)
    expect(vpsBrain.asked).toEqual([])

    clock.now += 21 * MINUTE
    await vps.service.tick()
    await until(() => vps.job(12, "team")?.state === "done")
    const posted = hub.reviews.get(12) ?? []
    expect(posted).toHaveLength(1)
    expect(posted[0]!.commit_id).toBe(head)
    expect(posted[0]!.body).toContain("mendcode:reviewer=team")
    expect(vps.job(12, "team")!.assignment).toBe(`offline fallback: @alice's MendCode (alice-backend) did not claim or review head ${head.slice(0, 12)} within 30 min, so team reviews it`)
    expect(vps.notices.some((text) => text.includes("PR review of acme/app#12: offline fallback: @alice's MendCode (alice-backend) did not claim or review head") && text.includes("routing.offline_fallback"))).toBe(true)
    const standIn = hub.claims(12).find((claim) => claim.reviewer === "team")!
    expect(standIn.covers).toEqual(["alice-backend"])
    expect((hub.comments.get(12) ?? []).some((item) => item.body.includes("as the offline fallback for alice-backend"))).toBe(true)
    // The record kept for alice on the VPS ends done at the next poll: her reviewer was covered here.
    await vps.service.tick()
    await until(() => vps.job(12, "alice-backend")?.state === "done")
    expect(vps.job(12, "alice-backend")!.assignment).toStartWith("reviewed on this device by team, the offline fallback")

    // Alice's laptop comes back (a minute later: the released claim ended at the release): its catch-up routes #12 to her, finds
    // the stand-in's review of the head, and posts nothing.
    clock.now += MINUTE
    const laptopBrain = model()
    const laptop = daemon({ hub, login: "alice", brain: laptopBrain, checkout: await repo.clone(), clock })
    await start(laptop)
    await laptop.service.tick()
    await until(() => laptop.job(12, "alice-backend")?.state === "done")
    expect(laptop.job(12, "alice-backend")!.assignment).toStartWith(`reviewed by @ana's MendCode as the offline fallback (review ${posted[0]!.id}); not reviewed again here`)
    expect(laptopBrain.asked).toEqual([])
    expect(hub.reviews.get(12)).toHaveLength(1)
  }, 30_000)

  test("alice comes back in time and is still reviewing when the fallback is due: the stand-in waits for her claim, then finds her review and posts nothing", async () => {
    const repo = await repository(registry(FALLBACK))
    const hub = github(repo)
    const clock = { now: Date.now() }
    const vpsBrain = model()
    const vps = daemon({ hub, login: "ana", brain: vpsBrain, checkout: repo.dir, clock })
    await start(vps)
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature", requested: ["alice"] })
    await vps.service.tick()
    await until(() => vps.job(12, "team") !== undefined)

    const turn = latch()
    const laptopBrain = model(turn.shut)
    const laptop = daemon({ hub, login: "alice", brain: laptopBrain, checkout: await repo.clone(), clock })
    await start(laptop)
    await laptop.service.tick()
    await until(() => laptopBrain.asked.includes("review"))
    expect(hub.claims(12).some((claim) => claim.reviewer === "alice-backend")).toBe(true)

    clock.now += 31 * MINUTE
    await vps.service.tick()
    await until(() => (vps.job(12, "team")?.assignment ?? "").startsWith("offline fallback not needed now: @alice's MendCode is back"))
    expect(vps.job(12, "team")!.state).toBe("waiting")
    expect(vpsBrain.asked).toEqual([])

    turn.open()
    await until(() => laptop.job(12, "alice-backend")?.state === "done")
    const posted = hub.reviews.get(12) ?? []
    expect(posted).toHaveLength(1)
    expect(posted[0]!.body).toContain("mendcode:reviewer=alice-backend")
    // The stand-in asks again when her claim's time is up (live, the edit of her released claim wakes it at the next comment poll;
    // this fake GitHub has no comment feed), finds her review of the head, and ends done.
    clock.now += 2 * 60 * MINUTE + 2_000
    await vps.service.tick()
    await until(() => vps.job(12, "team")?.state === "done")
    expect(vps.job(12, "team")!.assignment).toStartWith(`offline fallback not needed: reviewed by @alice's MendCode (review ${posted[0]!.id})`)
    expect(vpsBrain.asked).toEqual([])
    expect(hub.reviews.get(12)).toHaveLength(1)
    expect(posted[0]!.commit_id).toBe(head)
  }, 30_000)
})

describe("/pr review on an all watch", () => {
  test("it reviews as the repository's default global reviewer (team), so a head the watch already posted as team is not posted again as global (live e2e4 #14)", async () => {
    const repo = await repository(registry(""))
    const hub = github(repo)
    const clock = { now: Date.now() }
    const brain = model()
    const vps = daemon({ hub, login: "ana", brain, checkout: repo.dir, clock })
    await start(vps)
    const head = await repo.push(14, "feature", "export const one = 2\n")
    hub.prs.push({ number: 14, branch: "feature" })
    await vps.service.tick()
    await until(() => vps.job(14, "team")?.state === "done")
    expect(hub.reviews.get(14)).toHaveLength(1)
    clock.now += MINUTE
    expect((await vps.service.control({ sessionId: "ses", action: "review", pr: "14" })).ok).toBe(true)
    await until(() => vps.jobs(14).length === 2 && vps.jobs(14).every((job) => ["done", "failed", "stale"].includes(job.state)))
    expect(vps.jobs(14).map((job) => job.reviewer)).toEqual(["team", "team"])
    expect(vps.jobs(14).some((job) => job.reviewer === "global")).toBe(false)
    const posted = hub.reviews.get(14) ?? []
    expect(posted).toHaveLength(1)
    expect(posted[0]!.commit_id).toBe(head)
  }, 30_000)
})
