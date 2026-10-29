import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PrFinding } from "@mendcode/protocol"
import { failingKey, failureExcerpt, failureFollowUp, learningBullet, MAINTAINERS_ONLY, parsePrCommand, pausedFromComments, runPrCommand, type CommandComment, type CommandDeps } from "../src/pr-review/commands"
import { gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { runFix } from "../src/pr-review/fix"
import { commentBody, type GhCall } from "../src/pr-review/publish"
import { createPrReviewService } from "../src/pr-review/service"
import { emptyState, readReviewState } from "../src/pr-review/state"
import type { GhRun } from "../src/pr-watch"

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const finding: PrFinding = { id: "a".repeat(40), path: "a.ts", line: 1, side: "RIGHT", severity: "major", category: "correctness", summary: "one is now 2", detail: "Callers expect 1.", evidence: ["a.ts:1"] }

/** GitHub for one PR: who may write, what MendCode posted, and the finding comment #77. */
function fakeGh() {
  const posts: Array<{ endpoint: string; body: string }> = []
  const writers = new Set(["maintainer"])
  const calls: string[][] = []
  const gh: GhCall = async ({ argv, stdin }) => {
    calls.push(argv)
    const endpoint = argv[1] ?? ""
    if (endpoint.endsWith("/permission")) return { code: 0, out: writers.has(endpoint.split("/")[4]!) ? "write" : "read" }
    if (endpoint === "repos/acme/app/pulls/comments/77") return { code: 0, out: JSON.stringify({ id: 77, path: "a.ts", line: 1, body: commentBody(finding) }) }
    if (argv.includes("POST")) { posts.push({ endpoint, body: JSON.parse(stdin!).body }); return { code: 0, out: "{}" } }
    return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` }
  }
  return { gh, posts, writers, calls }
}
const issue = (body: string, actor = "maintainer"): CommandComment => ({ id: 5, surface: "issue", actor, body })
const thread = (body: string): CommandComment => ({ id: 6, surface: "review", actor: "maintainer", body, inReplyTo: 77, diffHunk: "@@ -1 +1 @@\n-export const one = 1\n+export const one = 2" })

function deps(gh: GhCall, comment: CommandComment, extra: Partial<CommandDeps> = {}): CommandDeps & { log: string[] } {
  const log: string[] = []
  return {
    gh, repo: "acme/app", number: 12, comment, state: emptyState(), log,
    review: async () => { log.push("review"); return { status: "published", posted: true } },
    explain: async ({ finding: about, question }) => { log.push(`explain ${about.id.slice(0, 4)} ${question}`); return "Because callers compare with 1 (a.ts:1)." },
    fixesAllowed: async () => true,
    pushable: async () => true,
    fix: async ({ instructions }) => { log.push(`fix ${instructions}`); return { ok: true, commit: "c".repeat(40) } },
    ...extra,
  }
}

describe("parsePrCommand", () => {
  test("a mention at the start of a line and a command word; its argument is the rest of the comment", () => {
    expect(parsePrCommand("@mendcode review")).toEqual({ kind: "review" })
    expect(parsePrCommand("Thanks!\n@MendCode Pause")).toEqual({ kind: "pause" })
    expect(parsePrCommand("@mendcode learn prefer early returns\nin handlers")).toEqual({ kind: "learn", arg: "prefer early returns\nin handlers" })
    expect(parsePrCommand("/mc fix the null check", ["/mc"])).toEqual({ kind: "fix", arg: "the null check" })
  })
  test("quotes, code blocks, unknown words, mid-sentence mentions and MendCode's own replies run nothing", () => {
    for (const body of ["> @mendcode pause", "```\n@mendcode fix\n```", "@mendcode merge", "ask @mendcode review later", "@mendcode review\n\n<!-- mendcode:reply -->", "@mendcodereview"]) expect(parsePrCommand(body)).toBeUndefined()
  })
})

describe("runPrCommand", () => {
  test("someone without write access gets one refusal and nothing runs", async () => {
    const { gh, posts } = fakeGh()
    for (const word of ["review", "pause", "fix", "learn x"]) {
      const d = deps(gh, issue(`@mendcode ${word}`, "drive-by"))
      const outcome = await runPrCommand(parsePrCommand(`@mendcode ${word}`)!, d)
      expect(outcome).toMatchObject({ kind: "denied", posted: true })
      expect(d.log).toEqual([])
    }
    expect(posts.map((post) => post.body.split("\n")[0])).toEqual(Array(4).fill(MAINTAINERS_ONLY))
  })
  test("review runs the full review; when it posts nothing new it says so", async () => {
    const { gh, posts } = fakeGh()
    const d = deps(gh, issue("@mendcode review"))
    expect(await runPrCommand({ kind: "review" }, d)).toMatchObject({ kind: "review", posted: true })
    expect(d.log).toEqual(["review"])
    expect(posts).toEqual([])
    const quiet = deps(gh, issue("@mendcode review"), { review: async () => ({ status: "skipped", reason: "no new findings on this head", posted: false }) })
    await runPrCommand({ kind: "review" }, quiet)
    expect(posts.at(-1)!.body).toContain("Reviewed the current head: skipped (no new findings on this head).")
  })
  test("pause and resume set the flag and leave a marker GitHub can be read back from", async () => {
    const { gh, posts } = fakeGh()
    const paused = await runPrCommand({ kind: "pause" }, deps(gh, issue("@mendcode pause")))
    expect(paused.state.paused).toBe(true)
    expect(posts[0]).toMatchObject({ endpoint: "repos/acme/app/issues/12/comments" })
    expect(posts[0]!.body).toContain("<!-- mendcode:paused=1 -->")
    const resumed = await runPrCommand({ kind: "resume" }, deps(gh, issue("@mendcode resume")))
    expect(resumed.state.paused).toBe(false)
    expect(pausedFromComments([{ body: posts[0]!.body, created_at: "2026-10-28T01:00:00Z" }, { body: posts[1]!.body, created_at: "2026-10-28T02:00:00Z" }])).toBe(false)
    expect(pausedFromComments([{ body: posts[1]!.body, created_at: "2026-10-28T01:00:00Z" }, { body: posts[0]!.body, created_at: "2026-10-28T02:00:00Z" }])).toBe(true)
  })
  test("explain answers in the thread of MendCode's comment, about the finding read back from it", async () => {
    const { gh, posts } = fakeGh()
    const d = deps(gh, thread("@mendcode explain is this real?"))
    expect(await runPrCommand(parsePrCommand("@mendcode explain is this real?")!, d)).toMatchObject({ kind: "explain", posted: true })
    expect(d.log).toEqual(["explain aaaa is this real?"])
    expect(posts[0]).toMatchObject({ endpoint: "repos/acme/app/pulls/12/comments/77/replies" })
    expect(posts[0]!.body).toContain("Because callers compare with 1")
    const loose = deps(gh, issue("@mendcode explain"))
    await runPrCommand({ kind: "explain" }, loose)
    expect(loose.log).toEqual([])
    expect(posts.at(-1)!.body).toContain("works as a reply to one of MendCode's review comments")
  })
  test("fix needs fixes: true, a branch it may push to, and says what it pushed or why it pushed nothing", async () => {
    const { gh, posts } = fakeGh()
    const off = deps(gh, thread("@mendcode fix"), { fixesAllowed: async () => false })
    await runPrCommand({ kind: "fix" }, off)
    expect(off.log).toEqual([])
    expect(posts.at(-1)!.body).toContain("fixes: true")
    const fork = deps(gh, thread("@mendcode fix"), { pushable: async () => false })
    await runPrCommand({ kind: "fix" }, fork)
    expect(fork.log).toEqual([])
    expect(posts.at(-1)!.body).toContain("fork that does not allow edits from maintainers")
    const fixed = deps(gh, thread("@mendcode fix"))
    await runPrCommand({ kind: "fix" }, fixed)
    expect(fixed.log).toEqual(["fix Fix this finding: one is now 2"])
    expect(posts.at(-1)!.body).toContain(`Pushed ${"c".repeat(12)}`)
    const failing = deps(gh, issue("@mendcode fix the parser"), { fix: async () => ({ ok: false, reason: "`bun test` exited with 1, so the fix was not pushed" }) })
    await runPrCommand(parsePrCommand("@mendcode fix the parser")!, failing)
    expect(posts.at(-1)!.body).toContain("Nothing was pushed: `bun test` exited with 1")
    const hosted = deps(gh, issue("@mendcode fix it"), { fix: undefined, fixUnavailable: "not on this runner" })
    await runPrCommand({ kind: "fix", arg: "it" }, hosted)
    expect(posts.at(-1)!.body).toContain("not on this runner")
  })
  test("learn proposes the line as a commit to the base branch and writes nothing itself", async () => {
    const { gh, posts } = fakeGh()
    await runPrCommand(parsePrCommand("@mendcode learn a missing `await` on store.flush is intended")!, deps(gh, issue("x")))
    expect(posts[0]!.body).toContain("- a missing 'await' on store.flush is intended\nLEARNING")
    expect(posts[0]!.body).toContain("on the base branch")
    expect(learningBullet("  \n ")).toBe("")
  })
})

describe("follow-ups", () => {
  function checks(runs: Array<Record<string, unknown>>) {
    const posts: string[] = []
    const gh: GhCall = async ({ argv, stdin }) => {
      if (argv[1]?.includes("/check-runs")) return { code: 0, out: runs.map((run) => JSON.stringify(run)).join("\n") }
      if (argv[0] === "run" && argv[1] === "view") return { code: 0, out: "test\tStep\t2026-10-28T00:00:00.0000000Z ok 1\ntest\tStep\t2026-10-28T00:00:01.0000000Z error: expected 1, got 2\n" }
      if (argv.includes("POST")) { posts.push(JSON.parse(stdin!).body); return { code: 0, out: "{}" } }
      return { code: 1, out: "" }
    }
    return { gh, posts }
  }
  const head = "b".repeat(40)
  test("a failed check on the reviewed head gets one comment with its cause; the same failing set is explained once", async () => {
    const { gh, posts } = checks([{ id: 1, name: "test", conclusion: "failure", details_url: "https://github.com/acme/app/actions/runs/10/job/20" }, { id: 2, name: "lint", conclusion: "success" }])
    const first = await failureFollowUp({ gh, repo: "acme/app", number: 12, head, state: emptyState() })
    expect(first.posted).toBe(true)
    expect(posts[0]).toContain("1 check failed")
    expect(posts[0]).toContain("error: expected 1, got 2")
    expect(first.state.explainedFailures).toBe(failingKey(head, ["test"]))
    const again = await failureFollowUp({ gh, repo: "acme/app", number: 12, head, state: first.state })
    expect(again.posted).toBe(false)
    expect(posts).toHaveLength(1)
    const moved = await failureFollowUp({ gh, repo: "acme/app", number: 12, head: "c".repeat(40), state: first.state })
    expect(moved.posted).toBe(true)
  })
  test("green checks post nothing, and a log is cut to its error lines", async () => {
    const { gh, posts } = checks([{ id: 2, name: "lint", conclusion: "success" }])
    expect((await failureFollowUp({ gh, repo: "acme/app", number: 12, head, state: emptyState() })).posted).toBe(false)
    expect(posts).toEqual([])
    expect(failureExcerpt(["step 1", "\x1b[31mFAIL src/a.test.ts\x1b[0m", "done"].join("\n"))).toBe("FAIL src/a.test.ts")
  })
})

describe("runFix", () => {
  async function repository() {
    const origin = temp("fix-origin-"), dir = temp("fix-clone-"), root = temp("fix-root-")
    const git = async (cwd: string, ...args: string[]) => { const done = await gitRun(args, cwd); if (done.code) throw new Error(args.join(" ")); return done.out.trim() }
    await git(origin, "init", "-q", "--bare", "-b", "main")
    await git(dir, "init", "-q", "-b", "main")
    await git(dir, "config", "user.name", "t")
    await git(dir, "config", "user.email", "t@example.invalid")
    await git(dir, "config", "commit.gpgsign", "false")
    writeFileSync(path.join(dir, "a.ts"), "export const one = 2\n")
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", "feature")
    await git(dir, "remote", "add", "origin", origin)
    await git(dir, "push", "-q", "origin", "main:feature")
    return { origin, dir, root, head: await git(dir, "rev-parse", "HEAD"), git }
  }
  /** A fix session that writes `text` into a.ts of the worktree it runs in, and records that directory. */
  const editor = (text: string, seen: string[]) => (worktree: string): ReviewSessionFactory => async () => ({
    async send() { seen.push(worktree); writeFileSync(path.join(worktree, "a.ts"), text); return { text: "Changed one back to 1.", tokens: { input: 0, output: 0 } } },
    async close() {},
  })
  test("a fix whose checks pass is one commit pushed to the PR's branch; one whose checks fail pushes nothing", async () => {
    const repo = await repository()
    const seen: string[] = []
    const base = { directory: repo.dir, root: repo.root, number: 12, head: repo.head, branch: "feature", pushUrl: "origin", instructions: "restore one", checks: ["bun test"], sessions: editor("export const one = 1\n", seen) }
    const failed = await runFix({ ...base, runChecks: async (_directory, commands) => commands.map((command) => ({ command, code: 1, output: "1 fail" })) })
    expect(failed).toEqual({ ok: false, reason: "`bun test` exited with 1, so the fix was not pushed:\n\n```text\n1 fail\n```" })
    expect(await repo.git(repo.origin, "rev-parse", "feature")).toBe(repo.head)
    const pushed = await runFix({ ...base, runChecks: async (_directory, commands) => commands.map((command) => ({ command, code: 0, output: "ok" })) })
    expect(pushed.ok).toBe(true)
    // The session edited the throwaway worktree, never the user's checkout.
    expect(seen.every((worktree) => worktree.startsWith(path.join(repo.root, "worktrees")))).toBe(true)
    expect(readFileSync(path.join(repo.dir, "a.ts"), "utf8")).toBe("export const one = 2\n")
    const tip = await repo.git(repo.origin, "rev-parse", "feature")
    expect(pushed.ok && pushed.commit).toBe(tip)
    expect(await repo.git(repo.origin, "rev-list", "--count", `${repo.head}..feature`)).toBe("1")
    expect(await repo.git(repo.origin, "show", "feature:a.ts")).toBe("export const one = 1")
    // The throwaway worktree is gone and the user's checkout did not move.
    expect((await repo.git(repo.dir, "worktree", "list")).split("\n")).toHaveLength(1)
    expect(await repo.git(repo.dir, "rev-parse", "HEAD")).toBe(repo.head)
  })
  test("a session that changed nothing pushes nothing", async () => {
    const repo = await repository()
    const done = await runFix({ directory: repo.dir, root: repo.root, number: 12, head: repo.head, branch: "feature", pushUrl: "origin", instructions: "x", checks: [], runChecks: async () => [], sessions: () => async () => ({ async send() { return { text: "It is already right.", tokens: { input: 0, output: 0 } } }, async close() {} }) })
    expect(done).toEqual({ ok: false, reason: "the fix session changed nothing: It is already right." })
    expect(await repo.git(repo.origin, "rev-parse", "feature")).toBe(repo.head)
  })
})

describe("the watch answers commands", () => {
  test("@mendcode pause from a maintainer is answered with the user's gh once posting is allowed, and the next push is not reviewed", async () => {
    const dir = temp("cmd-data-"), project = temp("cmd-project-")
    mkdirSync(path.join(project, ".mendcode"))
    const { gh, posts } = fakeGh()
    const notices: string[] = []
    const run: GhRun = async ({ argv }) => argv[0] === "repo" ? { code: 0, out: "acme/app", err: "" } : { code: 1, out: "", err: "unexpected" }
    const service = createPrReviewService({
      dir, run, call: gh, intervalMs: 3_600_000, enabled: () => true, graphOn: () => false, sessionDirectory: () => project, sessionExists: () => true,
      notify: (_session, text) => notices.push(text), sessions: () => { throw new Error("no model call") }, editor: () => { throw new Error("no model call") }, schedule: async (job) => { await job() },
    })
    cleanups.push(() => service.stop())
    const job = { kind: "command" as const, directory: project, sessionId: "ses_a", number: 12, head: "d".repeat(40), trigger: "comment" as const, command: { kind: "pause" as const }, comment: issue("@mendcode pause") }
    await service.command(job)
    expect(posts).toEqual([])
    expect(notices.at(-1)).toContain("only after /pr publish on")
    await service.control({ sessionId: "ses_a", action: "publish-on" })
    await service.command(job)
    expect(posts).toHaveLength(1)
    expect(readReviewState(dir, "acme/app", 12).paused).toBe(true)
    expect(notices.at(-1)).toBe("@mendcode pause from maintainer on acme/app#12: answered on GitHub.")
  })
})
