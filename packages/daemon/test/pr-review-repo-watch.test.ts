import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, PrReviewControl, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import type { GhRun } from "../src/pr-watch"
import { gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import type { GhCall } from "../src/pr-review/publish"
import { createRepoWatch, MAX_CONCURRENT_REVIEWS, type RepoWatchJob } from "../src/pr-review/repo-watch"
import { createPrReviewService } from "../src/pr-review/service"
import { createReviewSessions } from "../src/pr-review/sessions"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const sha = (n: number) => n.toString(16).padStart(40, "0")

/** A fake `gh pr list`: the open PRs are whatever the test sets; every call is counted. */
function fakeList() {
  const state = { prs: [] as Array<{ number: number; headRefOid: string; isDraft?: boolean; reviewRequests?: Array<{ login?: string }>; assignees?: Array<{ login: string }> }>, comments: [] as Array<Record<string, unknown>>, calls: 0, fail: undefined as { code: number; err: string } | undefined }
  const run: GhRun = async ({ argv }) => {
    state.calls++
    if (state.fail) return { code: state.fail.code, out: "", err: state.fail.err }
    if (argv[0] === "pr" && argv[1] === "list") return { code: 0, out: JSON.stringify(state.prs), err: "" }
    if (argv[0] === "api" && argv[1] === "user") return { code: 0, out: "dev-ana\n", err: "" }
    if (argv[0] === "api" && /^repos\/\{owner\}\/\{repo\}\/(issues|pulls)\/comments\?since=/.test(argv[1]!)) return { code: 0, out: state.comments.filter((comment) => argv[1]!.startsWith("repos/{owner}/{repo}/issues") === ("html_url" in comment)).map((comment) => JSON.stringify(comment)).join("\n"), err: "" }
    return { code: 1, out: "", err: "unexpected" }
  }
  return { run, state }
}

function watcher(extra: { drafts?: boolean; hold?: boolean; now?: () => number; limits?: import("../src/pr-review/repo-watch").RepoLimits } = {}) {
  const gh = fakeList()
  const jobs: RepoWatchJob[] = []
  const notices: string[] = []
  const releases: Array<() => void> = []
  const watch = createRepoWatch({
    dir: temp("pr-review-watch-"), run: gh.run, intervalMs: 3_600_000, ...(extra.now ? { now: extra.now } : {}),
    enabled: () => true, sessionExists: () => true, notify: (_session, text) => notices.push(text),
    triggers: async () => ({ opened: true, synchronize: true, ready_for_review: true, drafts: extra.drafts ?? false }),
    ...(extra.limits ? { limits: async () => extra.limits! } : {}),
    start: (job) => { jobs.push(job); return extra.hold ? new Promise<void>((resolve) => releases.push(resolve)) : Promise.resolve() },
  })
  cleanups.push(() => watch.stop())
  return { watch, gh, jobs, notices, releases }
}

describe("repo watch", () => {
  test("a maintainer's @mendcode comment on an open PR queues one command job; quoted, closed-PR and MendCode's own comments queue none", async () => {
    const { watch, gh, jobs } = watcher()
    gh.state.prs = [{ number: 12, headRefOid: sha(12) }]
    await watch.watchRepo("ses_a", "/repo")
    gh.state.comments = [
      { id: 1, body: "@mendcode pause", user: "maintainer", html_url: "https://github.com/acme/app/pull/12#issuecomment-1" },
      { id: 2, body: "> @mendcode pause\nno thanks", user: "someone", html_url: "https://github.com/acme/app/pull/12#issuecomment-2" },
      { id: 3, body: "@mendcode review", user: "maintainer", html_url: "https://github.com/acme/app/pull/99#issuecomment-3" },
      { id: 4, body: "Paused.\n\n<!-- mendcode:reply -->", user: "me", html_url: "https://github.com/acme/app/pull/12#issuecomment-4" },
      { id: 5, body: "@mendcode explain why?", user: "maintainer", pull_request_url: "https://api.github.com/repos/acme/app/pulls/12", in_reply_to_id: 77, diff_hunk: "@@ -1 +1 @@" },
    ]
    await watch.tick()
    expect(jobs).toEqual([
      { kind: "command", directory: "/repo", sessionId: "ses_a", number: 12, head: sha(12), trigger: "comment", command: { kind: "pause" }, comment: { id: 1, surface: "issue", actor: "maintainer", body: "@mendcode pause" } },
      { kind: "command", directory: "/repo", sessionId: "ses_a", number: 12, head: sha(12), trigger: "comment", command: { kind: "explain", arg: "why?" }, comment: { id: 5, surface: "review", actor: "maintainer", body: "@mendcode explain why?", inReplyTo: 77, diffHunk: "@@ -1 +1 @@" } },
    ])
    // The same comments read again (an edit moves updated_at) run once.
    await watch.tick()
    expect(jobs).toHaveLength(2)
  })
  test("open PRs are the baseline; a new PR #12 queues one review, a push to it an incremental one, nothing changing queues none", async () => {
    const { watch, gh, jobs } = watcher()
    gh.state.prs = [{ number: 3, headRefOid: sha(3) }]
    expect((await watch.watchRepo("ses_a", "/repo")).ok).toBe(true)
    await watch.tick()
    expect(jobs).toEqual([])
    gh.state.prs.push({ number: 12, headRefOid: sha(12) })
    await watch.tick()
    expect(jobs).toEqual([{ kind: "review", directory: "/repo", sessionId: "ses_a", number: 12, head: sha(12), trigger: "opened" }])
    gh.state.prs[1]!.headRefOid = sha(13)
    await watch.tick()
    expect(jobs.at(-1)).toMatchObject({ number: 12, head: sha(13), trigger: "synchronize" })
    const calls = gh.state.calls
    await watch.tick()
    await watch.tick()
    expect(jobs).toHaveLength(2)
    // Each idle tick: one `gh pr list` and two comment reads, no model call.
    expect(gh.state.calls).toBe(calls + 6)
  })
  test("drafts are not reviewed by default, are reviewed once ready, and are reviewed at once with triggers.drafts", async () => {
    const quiet = watcher()
    await quiet.watch.watchRepo("ses_a", "/repo")
    quiet.gh.state.prs = [{ number: 5, headRefOid: sha(5), isDraft: true }]
    await quiet.watch.tick()
    expect(quiet.jobs).toEqual([])
    quiet.gh.state.prs[0]!.isDraft = false
    await quiet.watch.tick()
    expect(quiet.jobs.map((job) => job.trigger)).toEqual(["ready_for_review"])
    const eager = watcher({ drafts: true })
    await eager.watch.watchRepo("ses_a", "/repo")
    eager.gh.state.prs = [{ number: 6, headRefOid: sha(6), isDraft: true }]
    await eager.watch.tick()
    expect(eager.jobs.map((job) => job.trigger)).toEqual(["opened"])
  })
  test(`at most ${MAX_CONCURRENT_REVIEWS} reviews run at once; the others wait in order`, async () => {
    const { watch, gh, jobs, releases } = watcher({ hold: true })
    await watch.watchRepo("ses_a", "/repo")
    gh.state.prs = [1, 2, 3, 4].map((number) => ({ number, headRefOid: sha(number) }))
    await watch.tick()
    expect(jobs.map((job) => job.number)).toEqual([1, 2])
    expect(watch.pending()).toEqual({ running: 2, queued: 2 })
    releases[0]!()
    await Bun.sleep(1)
    expect(jobs.map((job) => job.number)).toEqual([1, 2, 3])
  })
  test("a logged-out gh pauses the watch with one notice and no more gh calls; 15 unreadable minutes end it", async () => {
    const { watch, gh, notices } = watcher()
    await watch.watchRepo("ses_a", "/repo")
    gh.state.fail = { code: 1, err: "To get started with GitHub CLI, please run: gh auth login" }
    await watch.tick()
    await watch.tick()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("paused")
    const calls = gh.state.calls
    await watch.tick()
    expect(gh.state.calls).toBe(calls)
    expect(watch.describe()).toContain("paused")
    let clock = 0
    const later = watcher({ now: () => clock })
    await later.watch.watchRepo("ses_a", "/repo")
    later.gh.state.fail = { code: 1, err: "HTTP 502: Bad Gateway" }
    await later.watch.tick()
    clock = 16 * 60_000
    await later.watch.tick()
    expect(later.notices[0]).toContain("ended")
    expect(later.watch.describe()).toContain("ended (unreadable)")
  })
  test("the first post to a repository is asked once: ask, then wait, then the answer holds", async () => {
    const { watch } = watcher()
    await watch.watchRepo("ses_a", "/repo")
    expect(watch.publishConsent("/repo")).toBe("ask")
    expect(watch.publishConsent("/repo")).toBe("wait")
    watch.setPublish("/repo", "ses_a", "allowed")
    expect(watch.publishConsent("/repo")).toBe("allowed")
  })
})

describe("PR review service", () => {
  /** A repository whose origin holds `refs/pull/12/head` and a base config with `enabled: true`. */
  async function repository() {
    const origin = temp("pr-review-origin-"), dir = temp("pr-review-clone-")
    const git = async (cwd: string, ...args: string[]) => { const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd); if (done.code) throw new Error(args.join(" ")); return done.out.trim() }
    await git(origin, "init", "-q", "--bare", "-b", "main")
    await git(dir, "init", "-q", "-b", "main")
    mkdirSync(path.join(dir, ".mendcode"))
    writeFileSync(path.join(dir, ".mendcode", "review.yaml"), "enabled: true\n")
    writeFileSync(path.join(dir, "a.ts"), "export const one = 1\n")
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", "base")
    const base = await git(dir, "rev-parse", "HEAD")
    await git(dir, "checkout", "-q", "-b", "feature")
    writeFileSync(path.join(dir, "a.ts"), "export const one = 2\n")
    await git(dir, "commit", "-q", "-am", "feature")
    const head = await git(dir, "rev-parse", "HEAD")
    await git(dir, "remote", "add", "origin", origin)
    await git(dir, "push", "-q", "origin", "main", "feature:refs/pull/12/head")
    await git(dir, "checkout", "-q", "main")
    return { dir, base, head }
  }
  async function service() {
    const { dir, base, head } = await repository()
    const notices: string[] = []
    const posts: unknown[] = []
    let turns = 0
    const run: GhRun = async ({ argv }) => {
      if (argv[0] === "repo") return { code: 0, out: "acme/app", err: "" }
      if (argv[0] === "pr" && argv[1] === "view") return { code: 0, out: JSON.stringify({ number: 12, headRefOid: head, baseRefOid: base, baseRefName: "main", url: "https://github.com/acme/app/pull/12" }), err: "" }
      if (argv[0] === "pr" && argv[1] === "list") return { code: 0, out: "[]", err: "" }
      return { code: 1, out: "", err: "unexpected" }
    }
    const call: GhCall = async ({ argv, stdin }) => {
      if (argv[1]?.endsWith("/reviews") && argv.includes("POST")) { posts.push(JSON.parse(stdin!)); return { code: 0, out: JSON.stringify({ id: 1 }) } }
      return { code: 0, out: "[]" }
    }
    const finding = { path: "a.ts", line: 1, severity: "major", category: "correctness", summary: "one is now 2", detail: "Callers expect 1.", evidence: ["a.ts:1"] }
    const sessions = (): ReviewSessionFactory => async ({ purpose }) => ({
      async send(prompt) {
        turns++
        if (purpose === "review") return { text: JSON.stringify({ summary: "Changes one.", findings: [finding] }), tokens: { input: 100, output: 10 } }
        const id = /"id":"([0-9a-f]{40})"/.exec(prompt)![1]
        return { text: JSON.stringify({ verdicts: [{ id, verdict: "confirmed" }] }), tokens: { input: 50, output: 5 } }
      },
      async close() {},
    })
    const data = temp("pr-review-data-")
    const reviewer = createPrReviewService({
      dir: data, run, call, intervalMs: 3_600_000, enabled: () => true, graphOn: () => false,
      sessionDirectory: () => dir, sessionExists: () => true, notify: (_session, text) => notices.push(text),
      sessions, editor: sessions, schedule: async (job) => { await job() },
    })
    cleanups.push(() => reviewer.stop())
    return { reviewer, notices, posts, dir, data, turns: () => turns }
  }

  test("/pr review reviews in a throwaway worktree, asks once before the first post, and posts the held review on yes without a second model call", async () => {
    const { reviewer, notices, posts, dir, data, turns } = await service()
    const started = await reviewer.control({ sessionId: "ses_a", action: "review", pr: "12" })
    expect(started.ok).toBe(true)
    await Bun.sleep(50)
    for (let i = 0; i < 100 && notices.length < 2; i++) await Bun.sleep(20)
    expect(notices[0]).toContain("PR review of acme/app#12: reviewed")
    expect(notices[0]).toContain("a.ts:1 major correctness: one is now 2")
    expect(notices[1]).toContain("never posted a review to acme/app")
    expect(posts).toEqual([])
    expect(turns()).toBe(2)
    // The user's checkout is untouched: same branch, no extra worktree left.
    expect((await gitRun(["rev-parse", "--abbrev-ref", "HEAD"], dir)).out.trim()).toBe("main")
    expect((await gitRun(["worktree", "list"], dir)).out.trim().split("\n")).toHaveLength(1)
    const yes = await reviewer.control({ sessionId: "ses_a", action: "publish-on" })
    expect(yes.ok && yes.text).toContain("posting 1 held review")
    for (let i = 0; i < 100 && !posts.length; i++) await Bun.sleep(20)
    expect(posts).toHaveLength(1)
    expect((posts[0] as { event: string }).event).toBe("COMMENT")
    expect(turns()).toBe(2)
    for (let i = 0; i < 100 && notices.length < 3; i++) await Bun.sleep(20)
    expect(notices.at(-1)).toContain("Posted the held review")
    // The second review of the same head posts nothing new.
    await reviewer.control({ sessionId: "ses_a", action: "review", pr: "12" })
    for (let i = 0; i < 100 && notices.length < 4; i++) await Bun.sleep(20)
    expect(posts).toHaveLength(1)
    expect(path.join(data, "pr-review", "acme", "app", "12.json")).toBeTruthy()
  })
})

describe("daemon", () => {
  test("pr.review is refused while experimental.pr_review is off, and parses only its own actions", async () => {
    const ids = createIdFactory()
    const base = { id: ids("command"), clientId: ids("client"), type: "pr.review", sessionId: ids("session") }
    expect(PrReviewControl.safeParse({ ...base, action: "watch-repo" }).success).toBe(true)
    expect(PrReviewControl.safeParse({ ...base, action: "merge" }).success).toBe(false)
    const dir = temp("mendd-prreview-")
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), prReview: { run: async () => ({ code: 1, out: "", err: "no gh in tests" }) }, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "prreview" })
    await client.connect()
    cleanups.push(() => client.close())
    const created = await client.send({ type: "session.create", directory: dir, title: "t" })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    const off = await client.send({ type: "pr.review", sessionId, action: "watch-repo" })
    expect(off.ok).toBe(false)
    expect(!off.ok && off.error.message).toContain("/experimental pr_review on")
  })
})

describe("review children", () => {
  test("a child runs in plan mode, refuses approvals, answers with its last message and the reported tokens, and is removed", async () => {
    const log: string[] = []
    let observe: (event: never) => void = () => undefined
    const sessions = createReviewSessions({
      create: ({ title }) => { log.push(`create ${title}`); return "ses_child" as SessionId },
      submit: async (id, text) => {
        log.push(`submit ${text}`)
        queueMicrotask(() => {
          const at = { sessionId: id, seq: 1, at: 1 }
          for (const event of [
            { ...at, type: "server.request", requestId: "req_1" },
            { ...at, type: "item.started", itemId: "itm_1", kind: "agent_message" },
            { ...at, type: "item.completed", itemId: "itm_1", status: "ok", text: "{\"findings\": []}" },
            { ...at, type: "usage.recorded", input: 900, output: 40, reasoning: 0, cacheRead: 100, cacheWrite: 0 },
            { ...at, type: "turn.completed" },
          ]) observe(event as never)
        })
      },
      deny: (_id, requestId) => log.push(`deny ${requestId}`),
      cancel: async () => { log.push("cancel") },
      remove: (id) => log.push(`remove ${id}`),
    })
    observe = sessions.observe as never
    const child = await sessions.factory({ owner: "ses_owner", directory: "/repo" })({ purpose: "review" })
    expect(await child.send("review this")).toEqual({ text: "{\"findings\": []}", tokens: { input: 1000, output: 40 } })
    await child.close()
    expect(log).toEqual(["create PR review", "submit review this", "deny req_1", "remove ses_child"])
  })
})

describe("cooldown and roles", () => {
  const limits = (pr_minutes: number, repo_per_hour: number, reviewers: "all" | "requested" = "all") => ({ cooldown: { pr_minutes, repo_per_hour }, reviewers })

  test("pushes during the cooldown are one review, at the newest head, once the cooldown is over", async () => {
    let clock = 1_000_000
    const { watch, gh, jobs } = watcher({ now: () => clock, limits: limits(10, 20) })
    await watch.watchRepo("ses_a", "/repo")
    gh.state.prs = [{ number: 12, headRefOid: sha(12) }]
    await watch.tick()
    expect(jobs.map((job) => [job.trigger, job.head])).toEqual([["opened", sha(12)]])
    for (const head of [13, 14, 15]) { clock += 60_000; gh.state.prs[0]!.headRefOid = sha(head); await watch.tick() }
    expect(jobs).toHaveLength(1)
    expect(watch.describe()).toContain("1 waiting for the cooldown")
    clock += 7 * 60_000
    await watch.tick()
    expect(jobs.map((job) => [job.trigger, job.head])).toEqual([["opened", sha(12)], ["synchronize", sha(15)]])
    clock += 60 * 60_000
    await watch.tick()
    expect(jobs).toHaveLength(2)
  })

  test("a repository starts at most repo_per_hour automatic reviews; it says so once, and the rest run as the hour frees up", async () => {
    let clock = 1_000_000
    const { watch, gh, jobs, notices } = watcher({ now: () => clock, limits: limits(0, 2) })
    await watch.watchRepo("ses_a", "/repo")
    gh.state.prs = [1, 2, 3, 4].map((number) => ({ number, headRefOid: sha(number) }))
    await watch.tick()
    await watch.tick()
    expect(jobs.map((job) => job.number)).toEqual([1, 2])
    expect(notices.filter((text) => text.includes("reached 2 automatic reviews this hour"))).toHaveLength(1)
    clock += 61 * 60_000
    await watch.tick()
    expect(jobs.map((job) => job.number)).toEqual([1, 2, 3, 4])
  })

  test("a requested reviewer takes only PRs that request its gh login or are assigned to it, and a new request is a trigger", async () => {
    const { watch, gh, jobs } = watcher({ limits: limits(0, 20) })
    gh.state.prs = [{ number: 1, headRefOid: sha(1), reviewRequests: [{ login: "dev-ana" }] }]
    const started = await watch.watchRepo("ses_a", "/repo", "requested")
    expect(started).toMatchObject({ ok: true, text: expect.stringContaining("Only PRs that request a review from @dev-ana") })
    gh.state.prs.push({ number: 2, headRefOid: sha(2), reviewRequests: [{ login: "dev-luis" }] }, { number: 3, headRefOid: sha(3), assignees: [{ login: "Dev-Ana" }] })
    await watch.tick()
    expect(jobs.map((job) => [job.number, job.trigger])).toEqual([[3, "opened"]])
    gh.state.prs[1]!.reviewRequests!.push({ login: "dev-ana" })
    await watch.tick()
    expect(jobs.map((job) => [job.number, job.trigger])).toEqual([[3, "opened"], [2, "requested"]])
    // A push to a PR that requests someone else starts nothing here.
    gh.state.prs.push({ number: 4, headRefOid: sha(4), reviewRequests: [{ login: "dev-luis" }] })
    await watch.tick()
    gh.state.prs[3]!.headRefOid = sha(40)
    await watch.tick()
    expect(jobs).toHaveLength(2)
    expect(watch.describe()).toContain("only PRs that request @dev-ana")
  })

  test("the repo config's reviewers: requested is the role of a watch that names none; /pr watch-repo all overrides it", async () => {
    const { watch, gh, jobs } = watcher({ limits: limits(0, 20, "requested") })
    await watch.watchRepo("ses_a", "/repo")
    gh.state.prs = [{ number: 5, headRefOid: sha(5) }]
    await watch.tick()
    expect(jobs).toEqual([])
    expect((await watch.watchRepo("ses_a", "/repo", "all"))).toMatchObject({ ok: true, text: expect.stringContaining("every PR from now on") })
    gh.state.prs.push({ number: 6, headRefOid: sha(6) })
    await watch.tick()
    expect(jobs.map((job) => job.number)).toEqual([6])
  })
})
