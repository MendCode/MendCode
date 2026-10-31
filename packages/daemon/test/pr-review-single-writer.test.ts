import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { GhRun } from "../src/pr-watch"
import { gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { findingId } from "../src/pr-review/findings"
import { parseClaims } from "../src/pr-review/ownership"
import type { GhCall } from "../src/pr-review/publish"
import { createPrReviewService } from "../src/pr-review/service"

/**
 * One writer per pull request across daemons (R04, decision 5): two daemons of one reviewer (a desk and a laptop of alice), or two
 * daemons that both watch a repository as its global reviewer (a PC and a VPS of ana), share one fake GitHub. A running job renews
 * its claim every half of its TTL (here 400 ms), releases it when it ends, and checks it right before every write; a daemon whose
 * claim lapsed mid-run (a network cut kept it from renewing the marker) and was taken over at a higher fence does not post and does
 * not push. Real review run (run.ts, publishing through the effects ledger), real git (a bare origin and one clone per daemon),
 * scripted model turns. Nothing reaches the network; this is contract evidence, not live evidence.
 */

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const until = async (check: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await Bun.sleep(10) } }
const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]
const git = async (cwd: string, ...args: string[]) => { const done = await gitRun([...GIT_ID, ...args], cwd); if (done.code) throw new Error(`git ${args.join(" ")}: exit ${done.code}`); return done.out.trim() }
const TTL = 400

async function repository(yaml: string) {
  const origin = temp("one-origin-"), dir = temp("one-clone-")
  await git(origin, "init", "-q", "--bare", "-b", "main")
  await git(dir, "init", "-q", "-b", "main")
  mkdirSync(path.join(dir, ".mendcode"))
  writeFileSync(path.join(dir, ".mendcode", "review.yaml"), yaml)
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
  /** Another device's own checkout of the same origin. */
  async function clone() {
    const other = temp("one-device-")
    await git(path.dirname(other), "clone", "-q", origin, other)
    for (const [key, value] of [["user.name", "t"], ["user.email", "t@example.invalid"], ["commit.gpgsign", "false"]] as const) await git(other, "config", key, value)
    return other
  }
  return { origin, dir, main, push, clone }
}

type Comment = { id: number; body: string; user: { login: string } }
type Review = { id: number; commit_id: string; state: string; body: string; user: { login: string; type: string }; author_association: string }

/** GitHub as every daemon sees it. `net.cutEdits` makes this daemon's comment edits fail (a network cut for its claim renewals). */
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
  function as(login: string, net: { cutEdits: boolean }) {
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
        if (net.cutEdits) return { code: 1, out: "", err: "error connecting to api.github.com" }
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
  const claimComments = (number: number) => (comments.get(number) ?? []).filter((item) => item.body.includes("mendcode:claim"))
  return { prs, comments, reviews, as, claims, claimComments, tip }
}

const FINDING = { path: "feature.ts", line: 1, severity: "major", category: "correctness", summary: "one is now 2", detail: "Callers expect 1.", evidence: ["feature.ts:1"] }
const FINDING_ID = findingId({ path: FINDING.path, line: FINDING.line, category: FINDING.category, summary: FINDING.summary })
/** A promise and the function that settles it: a step a test lets go of. */
const latch = () => { let open!: () => void; const shut = new Promise<void>((resolve) => { open = resolve }); return { shut, open } }

/** Scripted review children; the review turn waits for `gate` first (a long review). */
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
/** The fix session: waits for `gate`, then edits the worktree it is given. */
const fixer = (gate?: Promise<void>) => (_owner: string, worktree: string): ReviewSessionFactory => async () => ({ id: "ses_fix", async send() { await gate; writeFileSync(path.join(worktree, "feature.ts"), "export const one = 1\n"); return { text: "fixed", tokens: { input: 5, output: 5 } } }, async close() {} }) as never

function daemon({ hub, login, brain, checkout, cutEdits = false, fixGate }: { hub: ReturnType<typeof github>; login: string; brain: ReturnType<typeof model>; checkout: string; cutEdits?: boolean; fixGate?: Promise<void> }) {
  const net = { cutEdits }
  const gh = hub.as(login, net)
  const notices: string[] = []
  const service = createPrReviewService({
    dir: temp(`one-${login}-`), run: gh.run, call: gh.call, intervalMs: 3_600_000, enabled: () => true, graphOn: () => false,
    sessionDirectory: () => checkout, sessionExists: () => true, notify: (_session, text) => notices.push(text),
    sessions: brain.factory, editor: fixer(fixGate), schedule: async (job) => { await job() }, random: () => 0.5, claimTtlMs: TTL,
  })
  cleanups.push(() => service.stop())
  const job = (number: number) => service.platform.jobs.all().find((item) => item.number === number)
  return { service, notices, net, job, device: () => service.platform.device() }
}
const start = async (d: ReturnType<typeof daemon>, role: "all" | "requested") => {
  await d.service.control({ sessionId: "ses", action: "publish-on" })
  expect((await d.service.control({ sessionId: "ses", action: "watch-repo", role })).ok).toBe(true)
}

describe("two daemons of one reviewer: a claim that lapses mid-run", () => {
  test("the desk's claim lapses during its review and the laptop takes over at fence 2: the desk's post is withheld with the reason, the laptop posts once, and the desk's job ends done there", async () => {
    const repo = await repository("enabled: true\n")
    const head = await repo.push(12, "feature", "export const one = 2\n")
    const hub = github(repo)
    hub.prs.push({ number: 12, branch: "feature", requested: ["alice"] })
    const deskTurn = latch(), laptopTurn = latch()
    const deskBrain = model(deskTurn.shut), laptopBrain = model(laptopTurn.shut)
    // The desk's renewals of the marker fail (a network cut), so its claim on the PR lapses while its review still runs.
    const desk = daemon({ hub, login: "alice", brain: deskBrain, checkout: repo.dir, cutEdits: true })
    await start(desk, "requested")
    await desk.service.tick()
    await until(() => deskBrain.asked.includes("review"))
    const first = hub.claims(12)
    expect(first).toEqual([expect.objectContaining({ owner: desk.device(), fence: 1, reviewer: "personal.alice" })])
    await until(() => Date.now() > first[0]!.expiresAt + 50)
    // Locally the desk still renews its lease: only the marker on the PR lapsed.
    expect(desk.service.platform.ownership.current("pr/acme/app/12/personal.alice")).toMatchObject({ owner: desk.device(), fence: 1 })

    const laptop = daemon({ hub, login: "alice", brain: laptopBrain, checkout: await repo.clone() })
    await start(laptop, "requested")
    await laptop.service.tick()
    await until(() => laptopBrain.asked.includes("review"))
    const taken = hub.claims(12).find((claim) => claim.owner === laptop.device())!
    expect(taken.fence).toBe(2)

    // The desk's review finishes first: right before the post it reads the claims, sees the laptop's, and posts nothing.
    deskTurn.open()
    await until(() => desk.job(12)?.state === "waiting")
    expect(hub.reviews.get(12) ?? []).toEqual([])
    const parked = desk.job(12)!
    expect(parked.assignment).toStartWith(`device ${laptop.device()} took this pull request over (claim fence 2, this job's 1) while this job ran`)
    expect(parked.checkpoint.result?.findings.map((finding) => finding.id)).toEqual([FINDING_ID])
    expect(desk.notices.some((text) => text.includes("not posted from this device, device") && text.includes("took this pull request over"))).toBe(true)
    expect(desk.service.platform.effects.ofJob(parked.id).filter((effect) => effect.kind === "review")).toEqual([])

    // The laptop's review finishes: one post, then its claim is released (local lease gone, marker edited to say so).
    laptopTurn.open()
    await until(() => laptop.job(12)?.state === "done")
    const posted = (hub.reviews.get(12) ?? []).filter((review) => review.commit_id === head)
    expect(posted).toHaveLength(1)
    expect(posted[0]!.body).toContain("mendcode:reviewer=personal:alice")
    expect(laptop.service.platform.ownership.current("pr/acme/app/12/personal.alice")).toBeUndefined()
    const released = hub.claimComments(12).find((item) => item.body.includes(laptop.device()))!
    expect(released.body).toContain("released")
    expect(hub.claims(12).find((claim) => claim.owner === laptop.device())!.expiresAt).toBeLessThanOrEqual(Date.now())

    // The desk's parked job comes back when the laptop's claim time is up, finds that review of the head, and ends done.
    await until(() => desk.job(12)?.state === "done")
    expect(desk.job(12)!.assignment).toStartWith(`reviewed by @alice's MendCode on device ${laptop.device()} (review ${posted[0]!.id})`)
    expect(hub.reviews.get(12)).toHaveLength(1)
    expect(deskBrain.asked).toEqual(["review", "verify"])
  }, 30_000)

  test("a fix push is fenced the same way: the desk, taken over mid-fix, keeps its commit on a local ref; only the laptop pushes, once", async () => {
    const repo = await repository("enabled: false\nfix:\n  mode: fix-once\n  push: true\n  personal: true\n")
    const head = await repo.push(12, "feature", "export const one = 2\n")
    const hub = github(repo)
    hub.prs.push({ number: 12, branch: "feature", requested: ["alice"] })
    const deskFix = latch(), laptopFix = latch()
    const desk = daemon({ hub, login: "alice", brain: model(), checkout: repo.dir, cutEdits: true, fixGate: deskFix.shut })
    await start(desk, "requested")
    await desk.service.tick()
    await until(() => desk.job(12)?.fixSessionId !== undefined)
    const first = hub.claims(12)[0]!
    await until(() => Date.now() > first.expiresAt + 50)

    const laptopCheckout = await repo.clone()
    const laptop = daemon({ hub, login: "alice", brain: model(), checkout: laptopCheckout, fixGate: laptopFix.shut })
    await start(laptop, "requested")
    await laptop.service.tick()
    await until(() => laptop.job(12)?.fixSessionId !== undefined)
    expect(hub.claims(12).find((claim) => claim.owner === laptop.device())!.fence).toBe(2)

    // The desk's fix is committed first, but right before the push its claim is no longer the winner: nothing is pushed from it.
    deskFix.open()
    await until(() => desk.notices.some((text) => text.includes("fix mode ended")))
    expect(await hub.tip("feature")).toBe(head)
    expect(desk.notices.find((text) => text.includes("fix mode ended"))).toContain(`device ${laptop.device()} took this pull request over (claim fence 2, this job's 1) while this job ran`)
    const kept = await git(repo.dir, "for-each-ref", "--format=%(refname)", "refs/mendcode/fix/")
    expect(kept.split("\n").filter(Boolean)).toHaveLength(1)

    // The laptop's fix goes to the branch: one new commit on top of the reviewed head.
    laptopFix.open()
    await until(() => laptop.notices.some((text) => text.includes("fix mode ended")))
    const pushed = await hub.tip("feature")
    expect(pushed).not.toBe(head)
    expect(await git(repo.origin, "rev-list", "--count", `${head}..${pushed}`)).toBe("1")
    expect(await git(repo.origin, "rev-parse", `${pushed}^`)).toBe(head)
  }, 30_000)
})

describe("two daemons watching one repository as its global reviewer (a PC and a VPS)", () => {
  test("the PC claims and renews in place while it reviews; the VPS waits naming it, never asks its model, and closes as done once the PC's review of the head is posted", async () => {
    const repo = await repository("enabled: true\n")
    const hub = github(repo)
    const pcTurn = latch()
    const pcBrain = model(pcTurn.shut), vpsBrain = model()
    const pc = daemon({ hub, login: "ana", brain: pcBrain, checkout: repo.dir })
    const vps = daemon({ hub, login: "ana", brain: vpsBrain, checkout: await repo.clone() })
    await start(pc, "all")
    await start(vps, "all")
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    await pc.service.tick()
    await until(() => pcBrain.asked.includes("review"))
    const claimed = hub.claims(12)
    expect(claimed).toEqual([expect.objectContaining({ reviewer: "global", owner: pc.device(), fence: 1, author: "ana" })])

    await vps.service.tick()
    await until(() => vps.job(12)?.state === "waiting")
    expect(vps.job(12)!.assignment).toStartWith(`waiting: @ana's MendCode on device ${pc.device()} claimed this pull request until `)
    expect(vpsBrain.asked).toEqual([])

    // The PC's review runs past the claim's TTL: its heartbeat edits the same marker comment with a later expiry.
    await until(() => (hub.claims(12)[0]?.expiresAt ?? 0) > claimed[0]!.expiresAt + TTL)
    expect(hub.claimComments(12)).toHaveLength(1)
    expect(hub.claims(12)[0]).toMatchObject({ owner: pc.device(), fence: 1 })
    pcTurn.open()
    await until(() => pc.job(12)?.state === "done")
    expect(hub.reviews.get(12)).toHaveLength(1)
    expect(hub.reviews.get(12)![0]!.commit_id).toBe(head)
    expect(pc.service.platform.ownership.current("pr/acme/app/12/global")).toBeUndefined()

    // The VPS's job comes back when the PC's claim time is up, finds the PC's review of the head, and ends done without a model call.
    await until(() => vps.job(12)?.state === "done")
    expect(vps.job(12)!.assignment).toStartWith(`reviewed by @ana's MendCode on device ${pc.device()} (review ${hub.reviews.get(12)![0]!.id})`)
    expect(vpsBrain.asked).toEqual([])
    expect(hub.reviews.get(12)).toHaveLength(1)
    expect(hub.claimComments(12)).toHaveLength(1)
  }, 30_000)
})
