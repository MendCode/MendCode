import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { GhRun } from "../src/pr-watch"
import { MAINTAINERS_ONLY } from "../src/pr-review/commands"
import { gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import type { GhCall } from "../src/pr-review/publish"
import type { ReviewRun, RunPrReviewInput } from "../src/pr-review/run"
import { createPrReviewService } from "../src/pr-review/service"
import { emptyState } from "../src/pr-review/state"

/**
 * `@mendcode review` and `@mendcode fix` are held to the repository's filters (labels, branches, authors and bots, paths, the
 * draft rule) and to a personal reviewer's profile, as automatic reviews are: an excluded PR gets one reply naming the filter, once
 * (the effects ledger and the answer marker), and no job or model turn. A comment never overrides a filter; the mode does not apply
 * to it (someone asked). `/pr review` keeps the repository's exclusions, and a `requested` watch's `/pr review` runs under the
 * reviewer id reviewers.yaml gives its login. Services on temp data directories over one fake GitHub; the review run is stood in for.
 */

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const until = async (check: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await Bun.sleep(10) } }
const git = async (cwd: string, ...args: string[]) => { const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd); if (done.code) throw new Error(`git ${args.join(" ")}: ${done.out}`); return done.out.trim() }

async function repository(yaml: string, reviewers?: string) {
  const origin = temp("mention-origin-"), dir = temp("mention-clone-")
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

type Pr = { number: number; branch: string; requested?: string[]; labels?: string[]; draft?: boolean; author?: string }
type Comment = { id: number; body: string; user: { login: string } }

/** GitHub for these daemons: PRs, issue comments (replies, claims), reviews, the polled `@mendcode` comments; `writers` may write. */
function github(repo: Awaited<ReturnType<typeof repository>>, writers: readonly string[]) {
  const prs: Pr[] = []
  const comments = new Map<number, Comment[]>()
  const polled: Array<{ number: number; id: number; body: string; user: string }> = []
  let ids = 1000
  const tip = async (branch: string) => (await gitRun(["rev-parse", `refs/heads/${branch}`], repo.origin)).out.trim()
  const shape = async (pr: Pr) => ({
    number: pr.number, headRefOid: await tip(pr.branch), baseRefOid: repo.main, baseRefName: "main", headRefName: pr.branch,
    url: `https://github.com/acme/app/pull/${pr.number}`, title: `PR ${pr.number}`, author: { login: pr.author ?? "bob" }, labels: (pr.labels ?? []).map((name) => ({ name })),
    reviewRequests: (pr.requested ?? []).map((login) => ({ login })), assignees: [], isDraft: pr.draft === true, isCrossRepository: false, maintainerCanModify: true,
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
      if (argv[0] === "api" && argv[1]?.startsWith("repos/{owner}/{repo}/issues/comments?since=")) return { code: 0, out: polled.map((item) => JSON.stringify({ id: item.id, body: item.body, user: item.user, association: writers.includes(item.user) ? "MEMBER" : "NONE", html_url: `https://github.com/acme/app/pull/${item.number}#issuecomment-${item.id}` })).join("\n"), err: "" }
      if (argv[0] === "api" && /comments\?since=/.test(argv[1] ?? "")) return { code: 0, out: "", err: "" }
      return { code: 1, out: "", err: "unexpected" }
    }
    const call: GhCall = async ({ argv, stdin }) => {
      const endpoint = argv[1] ?? ""
      const issue = /^repos\/acme\/app\/issues\/(\d+)\/comments/.exec(endpoint)
      if (argv.includes("POST") && issue) {
        const comment = { id: ++ids, body: JSON.parse(stdin!).body as string, user: { login } }
        comments.set(Number(issue[1]), [...comments.get(Number(issue[1])) ?? [], comment])
        return { code: 0, out: JSON.stringify({ id: comment.id }) }
      }
      if (argv.includes("POST")) return { code: 1, out: "", err: `unexpected post ${endpoint}` }
      if (issue) return { code: 0, out: JSON.stringify((comments.get(Number(issue[1])) ?? []).map((item) => ({ ...item, author_association: "MEMBER" }))) }
      const permission = /^repos\/acme\/app\/collaborators\/([^/]+)\/permission$/.exec(endpoint)
      if (permission) return { code: 0, out: writers.includes(permission[1]!) ? "write" : "read" }
      if (endpoint === "repos/acme/app") return { code: 0, out: "true" }
      if (/^repos\/acme\/app\/pulls\/\d+$/.test(endpoint) && argv.includes(".state")) return { code: 0, out: "open" }
      return { code: 0, out: "[]" }
    }
    const review = (inputs: RunPrReviewInput[]) => async (input: RunPrReviewInput): Promise<ReviewRun> => { inputs.push(input); return { status: "reviewed", state: emptyState(), incremental: false } }
    return { run, call, review }
  }
  /** The replies on PR `number` (claim markers aside). */
  const replies = (number: number) => (comments.get(number) ?? []).filter((comment) => !comment.body.includes("mendcode:claim"))
  return { prs, comments, polled, as, replies }
}

function daemon({ repo, hub, login, data = temp(`mention-${login}-`), sessionDirectory = repo.dir }: { repo: Awaited<ReturnType<typeof repository>>; hub: ReturnType<typeof github>; login: string; data?: string; sessionDirectory?: string }) {
  const gh = hub.as(login)
  const notices: string[] = []
  const inputs: RunPrReviewInput[] = []
  const sessions = (): ReviewSessionFactory => async () => ({ async send() { return { text: "{}", tokens: { input: 1, output: 1 } } }, async close() {} })
  const service = createPrReviewService({
    dir: data, run: gh.run, call: gh.call, intervalMs: 3_600_000, enabled: () => true, graphOn: () => false,
    sessionDirectory: () => sessionDirectory, sessionExists: () => true, notify: (_session, text) => notices.push(text), sessions, editor: sessions,
    schedule: async (job) => { await job() }, random: () => 0.5, review: gh.review(inputs),
  })
  cleanups.push(() => service.stop())
  return { service, data, notices, inputs, jobs: () => service.platform.jobs.all() }
}

/** One watching daemon of `login` with posting allowed, and a helper that writes a comment and runs one poll. */
async function watching(yaml: string, { login = "ana", role, reviewers, writers = ["ana", "carol"] }: { login?: string; role?: "all" | "requested"; reviewers?: string; writers?: string[] } = {}) {
  const repo = await repository(yaml, reviewers)
  const hub = github(repo, writers)
  const d = daemon({ repo, hub, login })
  await d.service.control({ sessionId: "ses_a", action: "publish-on" })
  expect((await d.service.control({ sessionId: "ses_a", action: "watch-repo", ...(role ? { role } : {}) })).ok).toBe(true)
  let id = 500
  const say = async (number: number, body: string, user = "carol") => {
    hub.polled.push({ number, id: ++id, body, user })
    await d.service.tick()
    await until(() => !d.service.pending().running)
    await Bun.sleep(20)
    return id
  }
  return { repo, hub, d, say }
}

describe("a mention is held to the repository's filters", () => {
  test("an excluded label: one reply naming the filter, no job and no model turn; the session hears why; a restart answers it no second time", async () => {
    const { repo, hub, d, say } = await watching("enabled: true\nfilters:\n  labels:\n    exclude: [skip-review]\n")
    await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature", labels: ["skip-review"] })
    await d.service.tick()
    const asked = await say(12, "@mendcode review")
    expect(d.jobs()).toEqual([])
    expect(d.inputs).toEqual([])
    const replies = hub.replies(12)
    expect(replies).toHaveLength(1)
    expect(replies[0]!.body).toStartWith("MendCode does not review this pull request: label `skip-review` excluded. A comment does not override the repository's filters")
    expect(replies[0]!.body).toContain(`<!-- mendcode:answers=${asked} -->`)
    expect(d.notices.at(-1)).toBe("@mendcode review from carol on acme/app#12: not run, the repository's filters keep it off this pull request; one reply says which.")
    // The reply went through the effects ledger: one done reply effect, nothing pending.
    expect(d.service.platform.effects.pending()).toEqual([])
    // A crash after the reply, before the command was dropped: the next daemon runs it again and finds it answered.
    d.service.stop()
    const file = path.join(d.data, "pr-review", "watches.json")
    const saved = JSON.parse(readFileSync(file, "utf8"))
    const running = saved.watches.find((watch: { ended?: unknown }) => !watch.ended)
    running.commands = [{ comment: { id: asked, surface: "issue", actor: "carol", body: "@mendcode review", association: "MEMBER" }, number: 12 }]
    writeFileSync(file, JSON.stringify(saved))
    const again = daemon({ repo, hub, login: "ana", data: d.data })
    await again.service.tick()
    await until(() => !again.service.pending().running)
    await Bun.sleep(20)
    expect(hub.replies(12)).toHaveLength(1)
    expect(again.inputs).toEqual([])
  })

  test("@mendcode fix on an excluded base branch is refused the same way; the draft rule and filters.paths hold for a mention too", async () => {
    const yaml = "enabled: true\nfixes: true\nfilters:\n  branches:\n    exclude: [main]\n"
    const { repo, hub, d, say } = await watching(yaml)
    await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    await d.service.tick()
    await say(12, "@mendcode fix the null check")
    expect(hub.replies(12).map((reply) => reply.body.split("\n")[0])).toEqual(["MendCode does not fix this pull request: base branch `main` excluded by `main`. A comment does not override the repository's filters (`filters` and `triggers.drafts` in `.mendcode/review.yaml` on the base branch, narrowed by the reviewer's personal profile); change the filter there, or remove the label, to have it fixed."])
    expect(d.jobs()).toEqual([])

    const drafts = await watching("enabled: true\n")
    await drafts.repo.push(13, "draft", "export const two = 2\n")
    drafts.hub.prs.push({ number: 13, branch: "draft", draft: true })
    await drafts.d.service.tick()
    await drafts.say(13, "@mendcode review")
    expect(drafts.hub.replies(13)[0]!.body).toStartWith("MendCode does not review this pull request: draft: waits for ready for review.")
    expect(drafts.d.inputs).toEqual([])

    const paths = await watching("enabled: true\nfilters:\n  paths: [\"src/**\"]\n")
    await paths.repo.push(14, "docs", "export const three = 3\n")
    paths.hub.prs.push({ number: 14, branch: "docs" })
    await paths.d.service.tick()
    await paths.say(14, "@mendcode review")
    expect(paths.hub.replies(14)[0]!.body).toStartWith("MendCode does not review this pull request: paths: no changed file matches `src/**`.")
    expect(paths.d.jobs()).toEqual([])
  })

  test("a bot author excluded by default stays excluded for a mention; the mode does not apply to one (on-request, labels)", async () => {
    const { repo, hub, d, say } = await watching("enabled: true\nmode: labels\nfilters:\n  labels:\n    include: [review-me]\n")
    await repo.push(12, "deps", "export const one = 2\n")
    await repo.push(13, "feature", "export const two = 2\n")
    hub.prs.push({ number: 12, branch: "deps", author: "dependabot[bot]" }, { number: 13, branch: "feature" })
    await d.service.tick()
    await say(12, "@mendcode review")
    expect(hub.replies(12)[0]!.body).toStartWith("MendCode does not review this pull request: author @dependabot[bot] is a bot (filters.authors.bots is off).")
    // #13 has no `review-me` label, so the mode would not review it by itself: asked, it is reviewed.
    await say(13, "@mendcode review")
    expect(d.inputs.map((input) => input.number)).toEqual([13])
    expect(d.jobs().map((job) => [job.number, job.trigger])).toEqual([[13, "comment"]])
  })

  test("a personal reviewer's profile narrows mentions too; someone without write access gets the maintainers-only reply, not the filter", async () => {
    const { repo, hub, d, say } = await watching("enabled: true\n", { login: "alice", role: "requested", writers: ["alice", "carol"] })
    d.service.platform.profiles.save({ provider: "github", repo: "acme/app", login: "alice" }, { config: { filters: { labels: { exclude: ["wip"] } } }, summary: "not my drafts" })
    await repo.push(12, "wip", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "wip", labels: ["wip"], requested: ["alice"] })
    await d.service.tick()
    await say(12, "@mendcode review")
    expect(hub.replies(12)[0]!.body).toStartWith("MendCode does not review this pull request: your personal profile: label `wip` excluded.")
    expect(d.inputs).toEqual([])
    await say(12, "@mendcode review", "mallory")
    expect(hub.replies(12).map((reply) => reply.body.split("\n")[0])).toEqual([expect.stringContaining("your personal profile"), MAINTAINERS_ONLY])
  })
})

describe("/pr review", () => {
  test("the repository's exclusions hold for it; a draft or a narrowing filter does not stop the owner's own request", async () => {
    const { repo, hub, d } = await watching("enabled: true\nfilters:\n  labels:\n    exclude: [skip-review]\n  paths: [\"src/**\"]\n")
    await repo.push(12, "feature", "export const one = 2\n")
    await repo.push(13, "draft", "export const two = 2\n")
    hub.prs.push({ number: 12, branch: "feature", labels: ["skip-review"] }, { number: 13, branch: "draft", draft: true })
    const refused = await d.service.control({ sessionId: "ses_a", action: "review", pr: "12" })
    expect(refused).toEqual({ ok: false, message: "#12 is not reviewed: label `skip-review` excluded (filters in .mendcode/review.yaml on the base branch)" })
    expect((await d.service.control({ sessionId: "ses_a", action: "review", pr: "13" })).ok).toBe(true)
    await until(() => d.inputs.length === 1)
    expect(d.inputs[0]!.number).toBe(13)
  })

  test("on a requested watch it runs under the reviewer id reviewers.yaml gives the login, so its claims match the watch's", async () => {
    const reviewers = "reviewers:\n  - id: global\n    scope: global\n  - id: alice-dev\n    scope: personal\n    login: alice\n"
    const { repo, hub, d } = await watching("enabled: true\n", { login: "alice", role: "requested", reviewers, writers: ["alice"] })
    await repo.push(12, "feature", "export const one = 2\n")
    hub.prs.push({ number: 12, branch: "feature" })
    expect((await d.service.control({ sessionId: "ses_a", action: "review", pr: "12" })).ok).toBe(true)
    await until(() => d.jobs().some((job) => job.state === "done"))
    expect(d.jobs().map((job) => [job.reviewer, job.scope, job.trigger])).toEqual([["alice-dev", "personal", "manual"]])
    expect(d.inputs[0]!.reviewer).toMatchObject({ id: "alice-dev", scope: "personal" })
  })
})
