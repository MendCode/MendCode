import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PrFinding, PrReviewResult } from "@mendcode/protocol"
import type { GhRun } from "../src/pr-watch"
import { parseReviewConfig } from "../src/pr-review/config"
import { gitRun } from "../src/pr-review/context"
import type { JobCheckpoint } from "../src/pr-review/contracts"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { ReviewTurnError } from "../src/pr-review/sessions"
import { findingId } from "../src/pr-review/findings"
import { fixCommitMessage, subjectLine, SUBJECT_MAX } from "../src/pr-review/fix"
import type { GhCall } from "../src/pr-review/publish"
import type { ReviewRun, RunPrReviewInput } from "../src/pr-review/run"
import { createPrReviewService, HEAD_CONFIRM_DELAYS_MS } from "../src/pr-review/service"
import { emptyState, type ReviewState } from "../src/pr-review/state"

/**
 * What the live end-to-end run of the frozen binary (d885302d, claude-opus, a private test repository) found around automatic fixes,
 * take-overs, claims and comments, reproduced through `createPrReviewService` under the same conditions:
 * - D1: GitHub reports a pushed head a few seconds late. The fix job read the old head right after its push, took its review as
 *   skipped, ended `done` with nothing open, and the watch had adopted the new head: the fix was never reviewed, its threads stayed.
 * - D5: a take-over during a fix-once round, then the release: the interrupted round used the only round (`max_rounds`), and the
 *   release announced the review as published again and "fixes are pushed" without pushing anything.
 * - D2: the automatic fix's commit subject was cut mid-word and its body claimed an `@mendcode fix` comment nobody wrote.
 * - O1: a waiting job of another device did not notice the holder released its claim; it waited the claim's full two hours.
 * - `@mendcode review` on a head reviewed before anyone asked: only the daemon owner's session heard of it, never the asker.
 * - A draft skipped with no reason in `/pr list`.
 * Real git (a bare origin and its clones in temp directories), a fake GitHub that never reaches the network, scripted model turns.
 */

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const until = async (check: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await Bun.sleep(10) } }
const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]
const git = async (cwd: string, ...args: string[]) => { const done = await gitRun([...GIT_ID, ...args], cwd); if (done.code) throw new Error(`git ${args.join(" ")}: exit ${done.code}`); return done.out.trim() }
const latch = () => { let open!: () => void; const shut = new Promise<void>((resolve) => { open = resolve }); return { shut, open } }

async function repository(yaml: string, reviewers?: string) {
  const origin = temp("ff-origin-"), dir = temp("ff-clone-")
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
  async function push(number: number, branch: string, content: string) {
    await git(dir, "checkout", "-q", "-b", branch, "main")
    writeFileSync(path.join(dir, "feature.ts"), content)
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", branch)
    await git(dir, "push", "-q", "-f", "origin", `${branch}:refs/heads/${branch}`, `${branch}:refs/pull/${number}/head`)
    const sha = await git(dir, "rev-parse", "HEAD")
    await git(dir, "checkout", "-q", "main")
    return sha
  }
  async function clone() {
    const other = temp("ff-device-")
    await git(path.dirname(other), "clone", "-q", origin, other)
    for (const [key, value] of [["user.name", "t"], ["user.email", "t@example.invalid"], ["commit.gpgsign", "false"]] as const) await git(other, "config", key, value)
    return other
  }
  return { origin, dir, main, push, clone }
}

type Comment = { id: number; body: string; user: { login: string }; updatedAt: number; author_association: string }
type Review = { id: number; commit_id: string; state: string; body: string; user: { login: string; type: string }; author_association: string }
type Thread = { id: string; body: string; resolved: boolean }

/**
 * GitHub as every daemon sees it: PR heads are the origin's branch tips, comments (the repository's `since` listing reads edits
 * too), reviews with their inline comments, and review threads (GraphQL) that can be resolved. `lag` is GitHub reporting a pushed
 * head late: `views` more `gh pr view` reads (or every read, listings included, while `stuck`) still report `head`.
 */
function github(repo: Awaited<ReturnType<typeof repository>>) {
  const prs: Array<{ number: number; branch: string; draft?: boolean }> = []
  const comments = new Map<number, Comment[]>()
  const reviews = new Map<number, Review[]>()
  const threads = new Map<number, Thread[]>()
  const lag: { head?: string | undefined; views: number; stuck: boolean } = { views: 0, stuck: false }
  /** Each login's permission on the repository; unset is write. */
  const permissions = new Map<string, "admin" | "write" | "read" | "none">()
  let ids = 9000
  const tip = async (branch: string) => (await gitRun(["rev-parse", `refs/heads/${branch}`], repo.origin)).out.trim()
  const headOf = async (branch: string, view: boolean) => {
    const actual = await tip(branch)
    if (lag.head && actual !== lag.head && (lag.stuck || view && lag.views-- > 0)) return lag.head
    return actual
  }
  const shape = async (pr: (typeof prs)[number], view: boolean) => ({
    number: pr.number, headRefOid: await headOf(pr.branch, view), baseRefOid: repo.main, baseRefName: "main", headRefName: pr.branch,
    url: `https://github.com/acme/app/pull/${pr.number}`, title: `PR ${pr.number}`, author: { login: "bob" }, labels: [],
    reviewRequests: [], assignees: [], isDraft: pr.draft === true, isCrossRepository: false, maintainerCanModify: true,
    headRepository: { name: "app" }, headRepositoryOwner: { login: "acme" },
  })
  const comment = (number: number, login: string, body: string, association = "MEMBER") => {
    const item: Comment = { id: ++ids, body, user: { login }, updatedAt: Date.now(), author_association: association }
    comments.set(number, [...comments.get(number) ?? [], item])
    return item
  }
  function as(login: string) {
    const run: GhRun = async ({ argv }) => {
      if (argv[0] === "repo") return { code: 0, out: "acme/app", err: "" }
      if (argv.join(" ") === "api user --jq .login") return { code: 0, out: login, err: "" }
      if (argv[0] === "pr" && argv[1] === "list") return { code: 0, out: JSON.stringify(await Promise.all(prs.map((pr) => shape(pr, false)))), err: "" }
      if (argv[0] === "pr" && argv[1] === "view") {
        const pr = prs.find((item) => item.number === Number(argv[2]))
        if (!pr) return { code: 1, out: "", err: "no pull request" }
        return { code: 0, out: JSON.stringify({ ...await shape(pr, true), body: "", files: [{ path: "feature.ts" }] }), err: "" }
      }
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
      const body = JSON.parse(stdin ?? "{}") as { body?: string; commit_id?: string; comments?: Array<{ body?: string }>; query?: string; variables?: { thread?: string; number?: number } }
      if (endpoint === "graphql") {
        if (body.query?.includes("resolveReviewThread")) {
          for (const list of threads.values()) for (const thread of list) if (thread.id === body.variables?.thread) thread.resolved = true
          return { code: 0, out: JSON.stringify({ data: { resolveReviewThread: { thread: { id: body.variables?.thread, isResolved: true } } } }) }
        }
        if (body.query?.includes("reviewThreads")) {
          const nodes = (threads.get(body.variables?.number ?? 0) ?? []).map((thread) => ({ id: thread.id, isResolved: thread.resolved, comments: { nodes: [{ body: thread.body }] } }))
          return { code: 0, out: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } }) }
        }
        return { code: 0, out: "{}" }
      }
      if (argv.includes("PATCH") && edit) {
        for (const list of comments.values()) for (const item of list) if (item.id === Number(edit[1]) && item.user.login === login) { item.body = body.body ?? ""; item.updatedAt = Date.now(); return { code: 0, out: JSON.stringify({ id: item.id }) } }
        return { code: 1, out: "", err: "HTTP 404" }
      }
      if (argv.includes("POST") && issue) return { code: 0, out: JSON.stringify({ id: comment(Number(issue[1]), login, body.body ?? "").id }) }
      if (argv.includes("POST") && pull) {
        const number = Number(pull[1])
        const review: Review = { id: ++ids, commit_id: body.commit_id ?? "", state: "COMMENTED", body: body.body ?? "", user: { login, type: "User" }, author_association: "MEMBER" }
        reviews.set(number, [...reviews.get(number) ?? [], review])
        for (const inline of body.comments ?? []) threads.set(number, [...threads.get(number) ?? [], { id: `T_${++ids}`, body: inline.body ?? "", resolved: false }])
        return { code: 0, out: JSON.stringify({ id: review.id, commit_id: review.commit_id }) }
      }
      if (argv.includes("POST")) return { code: 1, out: "", err: `unexpected post ${endpoint}` }
      if (issue) return { code: 0, out: JSON.stringify(comments.get(Number(issue[1])) ?? []) }
      if (pull) return { code: 0, out: JSON.stringify(reviews.get(Number(pull[1])) ?? []) }
      const asker = /\/collaborators\/([^/]+)\/permission$/.exec(endpoint)
      if (asker) { const level = permissions.get(decodeURIComponent(asker[1]!)) ?? "write"; return { code: 0, out: argv.includes("--jq") ? level : JSON.stringify({ permission: level }) } }
      if (endpoint === "repos/acme/app") return { code: 0, out: "true" }
      if (/^repos\/acme\/app\/pulls\/\d+$/.test(endpoint) && argv.includes(".state")) return { code: 0, out: "open" }
      return { code: 0, out: "[]" }
    }
    return { run, call }
  }
  const replies = (number: number, to: number) => (comments.get(number) ?? []).filter((item) => item.body.includes(`<!-- mendcode:answers=${to} -->`))
  return { prs, comments, reviews, threads, lag, permissions, as, tip, comment, replies }
}

const FINDING = { path: "feature.ts", line: 1, severity: "major", category: "correctness", summary: "The exported constant one is now 2, while every caller in this repository compares it with 1", detail: "Callers expect 1.", evidence: ["feature.ts:1"] }
const FINDING_ID = findingId({ path: FINDING.path, line: FINDING.line, category: FINDING.category, summary: FINDING.summary })

/**
 * Scripted model turns for the real review run: the first review finds FINDING and its verification confirms it; a later review
 * (the pushed fix's) finds nothing new, and the re-check of the earlier finding on the rewritten line rejects it (it was fixed).
 */
function model(gate?: Promise<void>, recheck: "confirmed" | "rejected" = "rejected") {
  const asked: string[] = []
  let reviews = 0, verifies = 0
  const factory = (): ReviewSessionFactory => async ({ purpose }) => ({
    id: `ses_${purpose}`,
    async send() {
      asked.push(purpose)
      if (purpose === "review") {
        await gate
        reviews++
        return { text: JSON.stringify(reviews === 1 ? { summary: "Changes one.", findings: [FINDING] } : { summary: "Restores one.", findings: [] }), tokens: { input: 1_000, output: 100 } }
      }
      verifies++
      return { text: JSON.stringify({ verdicts: [{ id: FINDING_ID, verdict: verifies === 1 ? "confirmed" : recheck, evidence: ["feature.ts:1 exports 1 again"] }] }), tokens: { input: 500, output: 50 } }
    },
    async close() {},
  }) as never
  return { factory, asked }
}
/** The fix session: waits for `gate` (a take-over happens meanwhile), then edits the worktree it is given. */
function fixer(gate?: Promise<void>, content?: string) {
  let sessions = 0
  const prompts: string[] = []
  const languages: Array<string | undefined> = []
  const editor = (_owner: string, worktree: string): ReviewSessionFactory => async ({ language }) => { languages.push(language); return { id: "ses_fix", async send(prompt: string) { sessions++; prompts.push(prompt); await gate; writeFileSync(path.join(worktree, "feature.ts"), content ?? `export const one = 1\n${sessions > 1 ? `// fix ${sessions}\n` : ""}`); return { text: "fixed", tokens: { input: 5, output: 5 } } }, async close() {} } as never }
  return { editor, sessions: () => sessions, prompts, languages }
}

type Answer = (input: RunPrReviewInput, call: number) => Partial<ReviewRun> & Pick<ReviewRun, "status">

function daemon({ hub, login, checkout, brain, fix, answer, claimTtlMs, data = temp(`ff-${login}-`), now }: { hub: ReturnType<typeof github>; login: string; checkout: string; brain?: ReturnType<typeof model>; fix?: ReturnType<typeof fixer>; answer?: Answer; claimTtlMs?: number; data?: string; now?: () => number }) {
  const gh = hub.as(login)
  const notices: string[] = []
  const inputs: RunPrReviewInput[] = []
  const slept: number[] = []
  const service = createPrReviewService({
    dir: data, ...(now ? { now } : {}), run: gh.run, call: gh.call, intervalMs: 3_600_000, enabled: () => true, graphOn: () => false,
    sessionDirectory: () => checkout, sessionExists: () => true, notify: (_session, text) => notices.push(text),
    sessions: (brain ?? model()).factory, editor: (fix ?? fixer()).editor, schedule: async (job) => { await job() }, random: () => 0.5,
    sleep: async (ms) => { slept.push(ms) }, ...(claimTtlMs ? { claimTtlMs } : {}),
    ...(answer ? { review: async (input: RunPrReviewInput) => { inputs.push(input); return { state: emptyState(), incremental: false, ...answer(input, inputs.length) } as ReviewRun } } : {}),
  })
  cleanups.push(() => service.stop())
  const job = (number: number) => service.platform.jobs.all().filter((item) => item.number === number).toSorted((a, b) => b.createdAt - a.createdAt)[0]
  return { service, notices, inputs, slept, job, data, jobs: () => service.platform.jobs.all(), device: () => service.platform.device() }
}
const start = async (d: ReturnType<typeof daemon>) => {
  await d.service.control({ sessionId: "ses", action: "publish-on" })
  expect((await d.service.control({ sessionId: "ses", action: "watch-repo", role: "all" })).ok).toBe(true)
}
const FIX_ONCE = "enabled: true\ncooldown:\n  pr_minutes: 0\nfix:\n  mode: fix-once\n  push: true\n"

describe("D1: a pushed fix is reviewed at the head it pushed", () => {
  test("GitHub reports the pushed head two reads late: the job waits for it, reviews only the fix's commits, resolves the fixed finding's thread, and ends done", async () => {
    const repo = await repository(FIX_ONCE)
    const hub = github(repo)
    const brain = model()
    const d = daemon({ hub, login: "ana", checkout: repo.dir, brain })
    await start(d)
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    // As live: right after the push, `gh pr view` still answers with the reviewed head.
    hub.lag.head = head
    hub.lag.views = 2
    await d.service.tick()
    await until(() => d.notices.some((text) => text.includes("fix mode ended")), 20_000)

    const pushed = await hub.tip("feature")
    expect(pushed).not.toBe(head)
    expect(await git(repo.origin, "rev-parse", `${pushed}^`)).toBe(head)
    // The pushed head was reviewed: a second review and re-check turn, metered on that head.
    expect(brain.asked).toEqual(["review", "verify", "review", "verify"])
    expect(d.service.platform.accounting.totals({ repo: "acme/app", number: 12, head: pushed, reviewer: "global" })?.tokens.input).toBeGreaterThan(0)
    const job = d.job(12)!
    expect(job).toMatchObject({ state: "done", head: pushed })
    expect(job.checkpoint.rounds).toEqual([expect.objectContaining({ open: [], commit: pushed })])
    // The fix's review closed the thread of the finding it fixed; it posted no second review for a head with nothing new.
    expect(hub.threads.get(12)?.map((thread) => [thread.body.includes(FINDING_ID), thread.resolved])).toEqual([[true, true]])
    expect(hub.reviews.get(12)).toHaveLength(1)
    expect(d.notices.find((text) => text.includes("fix mode ended"))).toBe("acme/app#12: fix mode ended done after 1 round.")
    // The two late reads were waited out with the first two delays.
    expect(d.slept).toEqual(HEAD_CONFIRM_DELAYS_MS.slice(0, 2))
  }, 40_000)

  test("GitHub never reports the pushed head in time: the job says the fix was not reviewed (not done), and the watch reviews that head once GitHub reports it", async () => {
    const repo = await repository(FIX_ONCE)
    const hub = github(repo)
    const brain = model()
    const d = daemon({ hub, login: "ana", checkout: repo.dir, brain })
    await start(d)
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    hub.lag.head = head
    hub.lag.stuck = true
    await d.service.tick()
    await until(() => d.notices.some((text) => text.includes("fix mode ended")), 20_000)
    const pushed = await hub.tip("feature")
    const fixJob = d.job(12)!
    expect(fixJob.state).toBe("failed")
    expect(brain.asked).toEqual(["review", "verify"])
    expect(d.slept).toEqual([...HEAD_CONFIRM_DELAYS_MS])
    expect(fixJob.stop).toMatchObject({ kind: "error", resumable: false, remaining: "1 confirmed finding not checked again after the fix" })
    expect(fixJob.stop!.detail).toBe(`the fix ${pushed.slice(0, 12)} was pushed but not reviewed: GitHub still reported ${head.slice(0, 12)} as the head after 30 s, so it was not reviewed here; the watch reviews it once GitHub reports it`)
    // The round is recorded with the finding it set out to fix still listed: nothing claims it resolved.
    expect(fixJob.checkpoint.rounds).toEqual([expect.objectContaining({ open: [FINDING_ID], commit: pushed })])
    expect(d.notices.find((text) => text.includes("fix mode ended"))).toContain("1 confirmed finding not checked again after the fix")
    expect(hub.threads.get(12)?.[0]?.resolved).toBe(false)

    // While GitHub still lists the old head nothing new is queued; once it reports the pushed head, the watch reviews it.
    await d.service.tick()
    expect(d.jobs()).toHaveLength(1)
    hub.lag.stuck = false
    await d.service.tick()
    await until(() => d.jobs().length === 2 && d.job(12)!.state === "done", 20_000)
    expect(d.job(12)).toMatchObject({ head: pushed, trigger: "synchronize", state: "done" })
    expect(brain.asked).toEqual(["review", "verify", "review", "verify"])
    expect(hub.threads.get(12)?.[0]?.resolved).toBe(true)
  }, 40_000)
})

describe("D2: the automatic fix's commit message", () => {
  test("the pushed commit of fix.mode has a whole-word subject of at most 72 characters and a body naming the fix mode, not a comment", async () => {
    const repo = await repository(FIX_ONCE)
    const hub = github(repo)
    const d = daemon({ hub, login: "ana", checkout: repo.dir })
    await start(d)
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    await d.service.tick()
    await until(() => d.notices.some((text) => text.includes("fix mode ended")), 20_000)
    const pushed = await hub.tip("feature")
    expect(pushed).not.toBe(head)
    const subject = await git(repo.origin, "log", "-1", "--format=%s", pushed)
    const body = await git(repo.origin, "log", "-1", "--format=%b", pushed)
    expect(subject.length).toBeLessThanOrEqual(SUBJECT_MAX)
    expect(subject).toBe("fix: The exported constant one is now 2, while every caller in this")
    expect(FINDING.summary.startsWith(subject.slice("fix: ".length) + " ")).toBe(true)
    expect(body).toContain("Automatic fix by MendCode's fix mode (fix.mode: fix-once) for the confirmed findings of its review of #12")
    expect(body).toContain("- feature.ts:1 The exported constant one is now 2")
    expect(body).not.toContain("@mendcode fix")
  }, 40_000)

  test("fix sessions are told the repository's review language: the automatic fix (said to be the fix mode) and an @mendcode fix (whose commit links the comment)", async () => {
    const yaml = `${FIX_ONCE}fixes: true\ntemplate:\n  language: Español\n`
    const repo = await repository(yaml)
    const hub = github(repo)
    const fix = fixer()
    const d = daemon({ hub, login: "ana", checkout: repo.dir, fix })
    await start(d)
    await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    await d.service.tick()
    await until(() => d.notices.some((text) => text.includes("fix mode ended")), 20_000)
    expect(fix.languages).toEqual(["Español"])
    expect(fix.prompts[0]).toStartWith("MendCode's review of this pull request confirmed the findings below, and the repository's automatic fix mode (`fix.mode: fix-once`) fixes them")
    expect(fix.prompts[0]).toEndWith("Write all of your prose in Español: summaries, details, explanations, evidence notes and any text meant for people, even when the pull request, its comments or your own settings use another language. Code, identifiers, file paths and quoted text stay exactly as they are.")

    // A maintainer's @mendcode fix on the same PR: the same language, the comment's own wording, and a commit that links the comment.
    const before = await hub.tip("feature")
    const asked = hub.comment(12, "carol", "@mendcode fix make one 1 again")
    await d.service.tick()
    await until(() => hub.replies(12, asked.id).length === 1, 20_000)
    expect(fix.languages).toEqual(["Español", "Español"])
    expect(fix.prompts[1]).toStartWith("A maintainer asked for a fix on this pull request (`@mendcode fix`).")
    expect(fix.prompts[1]).toContain("Write all of your prose in Español")
    const pushed = await hub.tip("feature")
    expect(await git(repo.origin, "rev-parse", `${pushed}^`)).toBe(before)
    expect(await git(repo.origin, "log", "-1", "--format=%s", pushed)).toBe("fix: make one 1 again")
    expect(await git(repo.origin, "log", "-1", "--format=%b", pushed)).toBe(`Requested by @carol with @mendcode fix on #12: https://github.com/acme/app/pull/12#issuecomment-${asked.id}`)
  }, 40_000)

  test("subjects are cut at a word; an @mendcode fix names the commenter and links the comment", () => {
    expect(subjectLine("fix: ", "make placeOrder return undefined when line.quantity is not a positive integer, before charging")).toBe("fix: make placeOrder return undefined when line.quantity is not a")
    expect(subjectLine("fix: ", "short and done.")).toBe("fix: short and done")
    expect(subjectLine("fix: ", `${"x".repeat(100)} tail`)).toBe(`fix: ${"x".repeat(67)}`)
    expect(subjectLine("fix: ", "\n\n")).toBe("fix: requested change")
    const two = fixCommitMessage({ instructions: "Fix the 2 confirmed findings", number: 2, findings: [{ ...FINDING, id: "a".repeat(40), side: "RIGHT", verdict: "confirmed" } as PrFinding, { ...FINDING, id: "b".repeat(40), line: 3, side: "RIGHT", verdict: "confirmed" } as PrFinding], source: { kind: "mode", mode: "fix-loop" } })
    expect(two.subject).toBe("fix: address 2 confirmed findings of MendCode's review")
    expect(two.body).toStartWith("Automatic fix by MendCode's fix mode (fix.mode: fix-loop)")
    const asked = fixCommitMessage({ instructions: "make placeOrder return undefined when line.quantity is not a positive integer", number: 2, source: { kind: "comment", actor: "Obed0101", url: "https://github.com/acme/app/pull/2#issuecomment-6533807446" } })
    expect(asked.body).toBe("Requested by @Obed0101 with @mendcode fix on #2: https://github.com/acme/app/pull/2#issuecomment-6533807446")
    expect(asked.subject.length).toBeLessThanOrEqual(SUBJECT_MAX)
  })
})

describe("D5: a take-over during a fix-once round, then the release", () => {
  // As the live repository had it: one round.
  const yaml = `${FIX_ONCE}  max_rounds: 1\n`
  const finding: PrFinding = { ...FINDING, id: FINDING_ID, side: "RIGHT", verdict: "confirmed" } as PrFinding
  const result = (head: string, base: string, findings: PrFinding[]): PrReviewResult => ({ head, base, findings, dropped: 0, summary: findings.length ? "One finding." : "No findings.", tokens: { input: 100, output: 10 }, budgetHit: false })
  const published = (head: string): ReviewState => ({ version: 1, lastHead: head, published: { [FINDING_ID]: { commentId: 1, finding } } })

  test("the interrupted round is not counted: the release pushes the kept fix (no second fix session), reviews the pushed head, ends done, and does not announce the review again", async () => {
    const repo = await repository(yaml)
    const hub = github(repo)
    const config = parseReviewConfig(yaml).config
    let firstHead = ""
    // The review run as the service sees it: the first review publishes one finding; the run after the release resumes from the
    // checkpoint (no model call, the post already done); the pushed fix's review finds nothing open.
    const answer: Answer = (input) => {
      const rounds = input.checkpoint?.rounds ?? []
      if (input.head !== firstHead) return { status: "published", config, state: published(input.head), outcome: { result: result(input.head, input.base, []) } as never, incremental: true }
      const checkpoint: JobCheckpoint = { completedPhases: ["analysis", "corroboration"], candidates: [], verified: [finding], result: result(input.head, input.base, [finding]), rounds, decisions: [] }
      return { status: "published", config, state: published(input.head), outcome: { result: result(input.head, input.base, [finding]) } as never, checkpoint }
    }
    const gate = latch()
    const fix = fixer(gate.shut)
    const d = daemon({ hub, login: "ana", checkout: repo.dir, fix, answer })
    await start(d)
    firstHead = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    await d.service.tick()
    await until(() => d.job(12)?.fixSessionId !== undefined && d.job(12)?.state === "fixing", 20_000)
    const jobId = d.job(12)!.id
    const taken = await d.service.control({ sessionId: "ses", action: "take-over", jobId })
    expect(taken.ok).toBe(true)
    gate.open()
    await until(() => d.notices.some((text) => text.includes("fix mode ended paused")), 20_000)
    expect(await hub.tip("feature")).toBe(firstHead)
    // The round's commit, kept on its local ref while the user holds the job.
    const [keptRef, keptCommit] = (await gitRun(["for-each-ref", "--format=%(refname) %(objectname)", "refs/mendcode/fix/12/"], repo.dir)).out.trim().split(" ") as [string, string]

    const released = await d.service.control({ sessionId: "ses", action: "release", jobId })
    expect(released.ok).toBe(true)
    await d.service.tick()
    await until(() => d.notices.join("\n\n").split("fix mode ended").length - 1 === 2, 20_000)

    // The kept commit itself went to the branch: no second fix session, no second commit.
    expect(await hub.tip("feature")).toBe(keptCommit)
    expect(fix.sessions()).toBe(1)
    expect((await gitRun(["for-each-ref", "--format=%(refname)", "refs/mendcode/fix/12/"], repo.dir)).out.trim()).toBe("")
    const job = d.job(12)!
    expect(job).toMatchObject({ id: jobId, state: "done", head: keptCommit, control: "reviewer" })
    // Reviewed three times: the head, its resume after the release, and the pushed fix (its own range: the state's last head).
    expect(d.inputs.map((input) => input.head)).toEqual([firstHead, firstHead, keptCommit])
    expect(d.inputs[2]!.state.lastHead).toBe(firstHead)
    expect(d.inputs[2]!.checkpoint).toBeUndefined()
    // Notices: the review once; the release continues from the kept fix; the end names one round.
    // Notices that came while one was being delivered arrive as one message: each is read on its own.
    const each = d.notices.flatMap((text) => /^\d+ PR review notices arrived while this session was busy:/.test(text) ? text.split("\n\n").slice(1) : [text])
    expect(each.filter((text) => /^PR review of acme\/app#12(?: at [0-9a-f]{12})?: published/.test(text))).toHaveLength(1)
    expect(each.filter((text) => text.includes("fixes are pushed to the branch"))).toHaveLength(1)
    expect(each).toContain(`acme/app#12: fix mode fix-once continues after the take-over was released: the kept fix ${keptCommit.slice(0, 12)} (${keptRef}) is pushed to the branch; the interrupted round is not counted.`)
    expect(each.filter((text) => text.includes("fix mode ended")).at(-1)).toBe("acme/app#12: fix mode ended done after 1 round.")
    // The checkpoint keeps the interrupted round apart from the one that counted.
    expect(job.checkpoint.rounds).toEqual([expect.objectContaining({ interrupted: true, kept: keptRef, commit: keptCommit }), expect.objectContaining({ open: [], commit: keptCommit })])
    expect(job.checkpoint.rounds[1]!.interrupted).toBeUndefined()
  }, 40_000)
})

describe("D1b: a fix that inserts a line next to the flagged one", () => {
  // As live on PR #8: the fix adds a line above the flagged one and leaves that line as it was (now one line lower).
  const INSERTED = "export const callers = \"compare with 2\"\nexport const one = 2\n"
  test("the review of the pushed fix re-checks the finding whose line only moved: its thread is resolved and the job ends done", async () => {
    const repo = await repository(FIX_ONCE)
    const hub = github(repo)
    const brain = model()
    const d = daemon({ hub, login: "ana", checkout: repo.dir, brain, fix: fixer(undefined, INSERTED) })
    await start(d)
    await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    await d.service.tick()
    await until(() => d.notices.some((text) => text.includes("fix mode ended")), 20_000)
    // Asked again about the finding: the fourth turn is its re-check on the pushed head.
    expect(brain.asked).toEqual(["review", "verify", "review", "verify"])
    expect(hub.threads.get(12)?.map((thread) => [thread.body.includes(FINDING_ID), thread.resolved])).toEqual([[true, true]])
    expect(d.job(12)).toMatchObject({ state: "done" })
    expect(d.notices.find((text) => text.includes("fix mode ended"))).toBe("acme/app#12: fix mode ended done after 1 round.")
  }, 40_000)
  test("the re-check still finds it: the thread stays open and fix-once ends failed naming the finding, never done", async () => {
    const repo = await repository(FIX_ONCE)
    const hub = github(repo)
    const d = daemon({ hub, login: "ana", checkout: repo.dir, brain: model(undefined, "confirmed"), fix: fixer(undefined, INSERTED) })
    await start(d)
    await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    await d.service.tick()
    await until(() => d.notices.some((text) => text.includes("fix mode ended")), 20_000)
    expect(hub.threads.get(12)?.map((thread) => thread.resolved)).toEqual([false])
    const job = d.job(12)!
    expect(job).toMatchObject({ state: "failed", stop: { kind: "max_rounds", remaining: "1 confirmed finding still open (feature.ts:1)" } })
    expect(job.checkpoint.rounds.map((round) => round.open)).toEqual([[FINDING_ID]])
    expect(d.notices.find((text) => text.includes("fix mode ended"))).toStartWith("acme/app#12: fix mode ended failed after 1 round, 1 confirmed finding still open (feature.ts:1)")
  }, 40_000)
})

describe("fix-once is one round", () => {
  test("with fix.max_rounds 3 and the finding still open after the pushed fix, fix-once stops after its one round (max_rounds 1), one fix session", async () => {
    const yaml = `${FIX_ONCE}  max_rounds: 3\n`
    const repo = await repository(yaml)
    const hub = github(repo)
    const config = parseReviewConfig(yaml).config
    const finding: PrFinding = { ...FINDING, id: FINDING_ID, side: "RIGHT", verdict: "confirmed" } as PrFinding
    const answer: Answer = (input) => ({ status: "published", config, state: { version: 1, lastHead: input.head, published: {} }, outcome: { result: { head: input.head, base: input.base, findings: [finding], dropped: 0, summary: "One finding.", tokens: { input: 1, output: 1 }, budgetHit: false } } as never })
    const fix = fixer()
    const d = daemon({ hub, login: "ana", checkout: repo.dir, fix, answer })
    await start(d)
    await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    await d.service.tick()
    await until(() => d.notices.some((text) => text.includes("fix mode ended")), 20_000)
    expect(fix.sessions()).toBe(1)
    expect(d.job(12)).toMatchObject({ state: "failed", stop: { kind: "max_rounds", used: 1, limit: 1 } })
  }, 30_000)
})

describe("O1: a released claim is noticed at the next poll", () => {
  test("the VPS waits for the PC's two-hour claim; the PC's release edits the claim comment, and the VPS's next poll settles its job as done there without a model call", async () => {
    const repo = await repository("enabled: true\n")
    const hub = github(repo)
    const pcTurn = latch()
    const pcBrain = model(pcTurn.shut), vpsBrain = model()
    const pc = daemon({ hub, login: "ana", checkout: repo.dir, brain: pcBrain })
    const vps = daemon({ hub, login: "ana", checkout: await repo.clone(), brain: vpsBrain })
    await start(pc)
    await start(vps)
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    await pc.service.tick()
    await until(() => pcBrain.asked.includes("review"))
    await vps.service.tick()
    await until(() => vps.job(12)?.state === "waiting")
    // Held for the claim's lifetime: two hours from now.
    expect(vps.job(12)!.notBefore).toBeGreaterThan(Date.now() + 60 * 60_000)
    pcTurn.open()
    await until(() => pc.job(12)?.state === "done")
    expect((hub.comments.get(12) ?? []).find((item) => item.body.includes("mendcode:claim"))?.body).toContain("released")

    await vps.service.tick()
    await until(() => vps.job(12)?.state === "done", 5_000)
    const posted = hub.reviews.get(12)!
    expect(posted).toHaveLength(1)
    expect(posted[0]!.commit_id).toBe(head)
    expect(vps.job(12)!.assignment).toStartWith(`reviewed by @ana's MendCode on device ${pc.device()} (review ${posted[0]!.id})`)
    expect(vpsBrain.asked).toEqual([])
  }, 30_000)
})

/** One more commit on PR 12's branch, pushed as its new head. */
const pushMore = async (repo: Awaited<ReturnType<typeof repository>>, content: string) => {
  await git(repo.dir, "checkout", "-q", "feature")
  writeFileSync(path.join(repo.dir, "feature.ts"), content)
  await git(repo.dir, "commit", "-qam", "more")
  await git(repo.dir, "push", "-q", "-f", "origin", "feature:refs/heads/feature", "feature:refs/pull/12/head")
  const sha = await git(repo.dir, "rev-parse", "HEAD")
  await git(repo.dir, "checkout", "-q", "main")
  return sha
}
/** The kept request of PR 12 in the watch's saved state (the file a restart reads). */
const savedAsk = (data: string) => (JSON.parse(readFileSync(path.join(data, "pr-review", "watches.json"), "utf8")) as { watches: Array<{ ended?: unknown; seen: Record<string, { asked?: unknown }> }> }).watches.find((watch) => !watch.ended)!.seen["12"]?.asked

describe("@mendcode review on a head reviewed before anyone asked", () => {
  test("one reply on the PR links the existing review of that head; nothing is reviewed again, and a second poll does not answer twice", async () => {
    const repo = await repository("enabled: true\n")
    const hub = github(repo)
    const d = daemon({ hub, login: "ana", checkout: repo.dir, answer: () => ({ status: "reviewed" }) })
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    hub.reviews.set(12, [{ id: 5718941081, commit_id: head, state: "COMMENTED", body: "## MendCode review", user: { login: "ana", type: "User" }, author_association: "MEMBER" }])
    await start(d)
    await d.service.tick()
    const asked = hub.comment(12, "carol", "@mendcode review")
    await d.service.tick()
    await until(() => d.notices.some((text) => text.includes("already reviewed this head")))
    const replies = hub.replies(12, asked.id)
    expect(replies).toHaveLength(1)
    expect(replies[0]!.body).toContain("https://github.com/acme/app/pull/12#pullrequestreview-5718941081")
    expect(replies[0]!.body).toContain(`@ana already reviewed this head (${head.slice(0, 12)})`)
    expect(replies[0]!.body).toContain("It is not reviewed again; the next push will be reviewed.")
    expect(d.notices.find((text) => text.includes("already reviewed this head"))).toBe("@mendcode review from carol on acme/app#12: @ana already reviewed this head (review 5718941081), so it is not reviewed again; the next push will be reviewed; one reply on GitHub links it.")
    await d.service.tick()
    expect(hub.replies(12, asked.id)).toHaveLength(1)
    expect(d.inputs).toHaveLength(0)
    expect(d.jobs()).toHaveLength(0)
  }, 30_000)

  for (const synchronize of [false, true]) {
    test(`PR #18: the owner's @MendCode review before pushing the fix is kept across a restart, and the fix's head is reviewed once (triggers.synchronize ${synchronize ? "on" : "off"})`, async () => {
      const repo = await repository(`enabled: true\ntriggers:\n  synchronize: ${synchronize}\n`)
      const hub = github(repo)
      const answer: Answer = () => ({ status: "reviewed" })
      const d = daemon({ hub, login: "ana", checkout: repo.dir, answer })
      const head = await repo.push(12, "feature", "export const one = 2\n")
      hub.prs.push({ number: 12, branch: "feature" })
      hub.reviews.set(12, [{ id: 777, commit_id: head, state: "COMMENTED", body: "## MendCode review", user: { login: "ana", type: "User" }, author_association: "MEMBER" }])
      await start(d)
      await d.service.tick()
      const asked = hub.comment(12, "owner", "Both findings are fixed in my branch, pushing soon.\n\n@MendCode review")
      await d.service.tick()
      await until(() => hub.replies(12, asked.id).length === 1)
      expect(hub.replies(12, asked.id)[0]!.body).toContain("the next push will be reviewed")
      expect(d.jobs()).toEqual([])
      expect(savedAsk(d.data)).toMatchObject({ head, by: "owner", comment: asked.id })
      // Four hours later (a restart between), the fix is pushed: its head is reviewed, as the asked review.
      d.service.stop()
      const again = daemon({ hub, login: "ana", checkout: repo.dir, answer, data: d.data })
      const fixed = await pushMore(repo, "export const one = 1\n")
      await again.service.tick()
      await until(() => again.jobs().some((job) => job.state === "done"))
      expect(again.jobs().map((job) => [job.head, job.trigger, job.state])).toEqual([[fixed, "comment", "done"]])
      expect(again.inputs.map((input) => input.head)).toEqual([fixed])
      expect(savedAsk(again.data)).toBeUndefined()
      // Answered once: another poll, and (with the switch off) a later push, start nothing for that request.
      await again.service.tick()
      expect(again.jobs()).toHaveLength(1)
      if (!synchronize) {
        await pushMore(repo, "export const one = 1 // again\n")
        await again.service.tick()
        await Bun.sleep(30)
        expect(again.jobs()).toHaveLength(1)
      }
      expect(hub.replies(12, asked.id)).toHaveLength(1)
    }, 40_000)
  }

  test("a kept request goes with its pull request: closed, the request is dropped", async () => {
    const repo = await repository("enabled: true\ntriggers:\n  synchronize: false\n")
    const hub = github(repo)
    const d = daemon({ hub, login: "ana", checkout: repo.dir, answer: () => ({ status: "reviewed" }) })
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    hub.reviews.set(12, [{ id: 778, commit_id: head, state: "COMMENTED", body: "## MendCode review", user: { login: "ana", type: "User" }, author_association: "MEMBER" }])
    await start(d)
    await d.service.tick()
    hub.comment(12, "owner", "@mendcode review")
    await d.service.tick()
    await until(() => savedAsk(d.data) !== undefined)
    hub.prs.splice(0)
    await d.service.tick()
    expect(savedAsk(d.data)).toBeUndefined()
  }, 30_000)
})

describe("one order for every @mendcode command: permission, filters, then the reviewed head", () => {
  const reviewedRepo = async (yaml = "enabled: true\n") => {
    const repo = await repository(yaml)
    const hub = github(repo)
    const d = daemon({ hub, login: "ana", checkout: repo.dir, answer: () => ({ status: "reviewed" }) })
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    return { repo, hub, d, head }
  }

  test("PR #2: a reader's @mendcode review on a head already reviewed gets the one maintainers-only refusal, not the link, and no request is kept", async () => {
    const { hub, d, head } = await reviewedRepo()
    hub.reviews.set(12, [{ id: 779, commit_id: head, state: "COMMENTED", body: "## MendCode review", user: { login: "ana", type: "User" }, author_association: "MEMBER" }])
    hub.permissions.set("reader", "read")
    await start(d)
    await d.service.tick()
    const asked = hub.comment(12, "reader", "@mendcode review", "NONE")
    await d.service.tick()
    await until(() => hub.replies(12, asked.id).length === 1)
    const reply = hub.replies(12, asked.id)[0]!.body
    expect(reply).toStartWith("Only maintainers (write access to this repository) can run @mendcode commands.")
    expect(reply).not.toContain("already reviewed")
    expect(d.notices.join("\n")).toContain("@mendcode review from reader on acme/app#12: refused (no write access).")
    expect(savedAsk(d.data)).toBeUndefined()
    expect(d.jobs()).toEqual([])
  }, 30_000)

  test("a reader is refused the same way on a head nobody reviewed, and before the filters: an excluded label is never named to them", async () => {
    // No backlog: the head nobody reviewed waits for a request.
    const { hub, d } = await reviewedRepo("enabled: true\nfilters:\n  labels:\n    exclude: [blocked]\nbacklog:\n  max_prs: 0\n")
    hub.permissions.set("reader", "read")
    await start(d)
    await d.service.tick()
    const asked = hub.comment(12, "reader", "@mendcode review", "NONE")
    await d.service.tick()
    await until(() => hub.replies(12, asked.id).length === 1)
    expect(hub.replies(12, asked.id)[0]!.body).toStartWith("Only maintainers (write access to this repository) can run @mendcode commands.")
    expect(d.jobs()).toEqual([])
  }, 30_000)

  test("PR #18: the daemon's own login (read access only) is the owner: its @MendCode review runs as /pr review, its @mendcode fix is refused in the session only; nothing is posted to it", async () => {
    const { hub, d, head } = await reviewedRepo()
    hub.reviews.set(12, [{ id: 780, commit_id: head, state: "COMMENTED", body: "## MendCode review", user: { login: "ana", type: "User" }, author_association: "MEMBER" }])
    hub.permissions.set("ana", "read")
    await start(d)
    await d.service.tick()
    const review = hub.comment(12, "ana", "@MendCode review", "NONE")
    await d.service.tick()
    await until(() => d.jobs().some((job) => job.state === "done"))
    expect(d.jobs().map((job) => [job.number, job.trigger, job.state])).toEqual([[12, "manual", "done"]])
    expect(d.notices.join("\n")).toContain("@mendcode review from ana on acme/app#12 (this daemon's own login): run as your own /pr review")
    const fix = hub.comment(12, "ana", "@mendcode fix make one 1 again", "NONE")
    await d.service.tick()
    await until(() => d.notices.join("\n").includes("@mendcode fix from ana"))
    expect(d.notices.join("\n")).toContain("@mendcode fix from ana on acme/app#12 (this daemon's own login): not run, @ana has no write access to acme/app; nothing is posted on the pull request.")
    // Nothing on the pull request answers the owner: no "Only maintainers" from the very account that asked.
    expect(hub.replies(12, review.id)).toEqual([])
    expect(hub.replies(12, fix.id)).toEqual([])
    expect((hub.comments.get(12) ?? []).some((item) => item.body.includes("Only maintainers"))).toBe(false)
  }, 30_000)
})

describe("failure notices say where and what happens next", () => {
  test("a review turn that times out is retried with backoff: the job waits (not failed) after its first attempt, and the notice names the repository, PR, head, reason and retry time", async () => {
    const repo = await repository("enabled: true\n")
    const hub = github(repo)
    const at = Date.parse("2026-10-31T12:00:00Z")
    // The real review run, whose model turn never answers in time (sessions.ts gives up with this error).
    let turns = 0
    const brain = { asked: [] as string[], factory: (): ReviewSessionFactory => async () => ({ id: "ses_review", async send() { turns++; throw new ReviewTurnError("[PR_REVIEW]: the review turn timed out", "error") }, async close() {} }) as never }
    const d = daemon({ hub, login: "ana", checkout: repo.dir, now: () => at, brain })
    await start(d)
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    await d.service.tick()
    await until(() => d.job(12)?.state === "waiting" || d.job(12)?.state === "failed" || d.job(12)?.state === "checkpointed")
    const job = d.job(12)!
    expect(turns).toBeGreaterThan(0)
    // Not ended on its first attempt: it waits for a retry later, with no attempt spent on the timeout.
    expect(job.state).toBe("waiting")
    expect(job.attempts).toBe(0)
    expect(job.notBefore).toBeGreaterThan(at)
    const said = d.notices.join("\n")
    expect(said).toContain(`PR review of acme/app#12 at ${head.slice(0, 12)} could not finish: `)
    expect(said).toContain("the review turn timed out")
    expect(said).toMatch(/it waits for the network and is tried again at 2026-10-31 12:\d\d UTC without spending an attempt \(5 attempts left\)\./)
  }, 30_000)

  test("a failure retrying cannot fix ends the job at once, and its notice names the repository, PR, head, reason and that it is not tried again", async () => {
    const repo = await repository("enabled: true\n")
    const hub = github(repo)
    const at = Date.parse("2026-10-31T12:00:00Z")
    const d = daemon({ hub, login: "ana", checkout: repo.dir, now: () => at, answer: () => ({ status: "failed", reason: "the model answered with something that is not a review" }) })
    await start(d)
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    await d.service.tick()
    await until(() => d.job(12)?.state === "waiting" || d.job(12)?.state === "failed")
    const said = d.notices.join("\n")
    expect(said).toContain(`PR review of acme/app#12 at ${head.slice(0, 12)} failed: the model answered with something that is not a review.`)
    expect(said).toContain("It is not tried again (this error does not go away by retrying); /reviews retries it.")
    expect(d.job(12)).toMatchObject({ state: "failed", attempts: 1 })
    expect(said).not.toContain("PR review of #12")
  }, 30_000)
})

describe("reviewers.yaml capabilities are enforced", () => {
  test("a reviewer without fix and publish: its review stays in the session (no post, no claim), no fix mode runs, and @mendcode fix gets one reply naming why", async () => {
    const repo = await repository(`${FIX_ONCE}fixes: true\n`, "reviewers:\n  - id: global\n    scope: global\n    capabilities: [review]\n")
    const hub = github(repo)
    const fix = fixer()
    const d = daemon({ hub, login: "ana", checkout: repo.dir, fix })
    await start(d)
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    await d.service.tick()
    await until(() => d.notices.some((text) => text.includes("fix mode fix-once is not run")), 20_000)
    const lacks = (capability: string) => `reviewer \`global\` has no \`${capability}\` capability in \`.mendcode/reviewers.yaml\` on the base branch`
    // Notices that arrive together are delivered as one: read them as the session does.
    const said = () => d.notices.join("\n\n")
    expect(said()).toContain(`PR review of acme/app#12 stays in this session: ${lacks("publish")}, so nothing is posted to the pull request and its claim stays on this device.`)
    expect(said()).toContain(`acme/app#12: fix mode fix-once is not run on 1 confirmed finding: ${lacks("fix")}.`)
    expect(hub.reviews.get(12) ?? []).toEqual([])
    expect(hub.comments.get(12) ?? []).toEqual([])
    expect(await hub.tip("feature")).toBe(head)
    expect(fix.sessions()).toBe(0)
    expect(d.job(12)).toMatchObject({ reviewer: "global", state: "done" })

    // A maintainer asks for a fix anyway: one reply says why, no fix session starts, and a second poll does not answer twice.
    const asked = hub.comment(12, "carol", "@mendcode fix make one 1 again")
    await d.service.tick()
    await until(() => hub.replies(12, asked.id).length === 1, 20_000)
    expect(hub.replies(12, asked.id)[0]!.body).toStartWith(`\`@mendcode fix\` is not run here: ${lacks("fix")}. Add \`fix\` to its \`capabilities\` there to let it fix.`)
    await until(() => said().includes("@mendcode fix from carol on acme/app#12: not run"))
    expect(said()).toContain(`@mendcode fix from carol on acme/app#12: not run, ${lacks("fix")}; one reply says why.`)
    await d.service.tick()
    expect(hub.replies(12, asked.id)).toHaveLength(1)
    expect(fix.sessions()).toBe(0)
    expect(await hub.tip("feature")).toBe(head)
  }, 40_000)

  test("a reviewer with publish but without fix posts its review; the fix mode does not run", async () => {
    const repo = await repository(FIX_ONCE, "reviewers:\n  - id: global\n    scope: global\n    capabilities: [review, publish]\n")
    const hub = github(repo)
    const fix = fixer()
    const d = daemon({ hub, login: "ana", checkout: repo.dir, fix })
    await start(d)
    const head = await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    await d.service.tick()
    await until(() => d.notices.some((text) => text.includes("fix mode fix-once is not run")), 20_000)
    expect(hub.reviews.get(12)).toHaveLength(1)
    expect(hub.reviews.get(12)![0]!.commit_id).toBe(head)
    expect(d.notices.some((text) => text.includes("stays in this session"))).toBe(false)
    expect(fix.sessions()).toBe(0)
    expect(await hub.tip("feature")).toBe(head)
  }, 40_000)
})

describe("drafts in /pr list", () => {
  test("a draft opened during the watch is not reviewed and /pr list says why; once ready it is reviewed and the reason is gone", async () => {
    const repo = await repository("enabled: true\n")
    const hub = github(repo)
    const d = daemon({ hub, login: "ana", checkout: repo.dir, answer: () => ({ status: "reviewed" }) })
    await start(d)
    await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature", draft: true })
    await d.service.tick()
    expect(d.jobs()).toHaveLength(0)
    const list = await d.service.control({ sessionId: "ses", action: "list" })
    expect(list.ok && list.text).toContain("1 not reviewed (#12: draft: waits for ready for review)")
    hub.prs[0]!.draft = false
    await d.service.tick()
    await until(() => d.jobs().some((job) => job.state === "done"))
    expect(d.jobs()[0]).toMatchObject({ number: 12, trigger: "ready_for_review" })
    const after = await d.service.control({ sessionId: "ses", action: "list" })
    expect(after.ok && after.text).not.toContain("not reviewed")
  }, 30_000)
})
