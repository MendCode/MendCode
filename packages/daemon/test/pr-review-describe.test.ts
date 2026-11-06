import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PrFinding, PrReviewResult, PrWalkthrough } from "@mendcode/protocol"
import { MAINTAINERS_ONLY, parsePrCommand, runPrCommand, type CommandComment, type CommandDeps } from "../src/pr-review/commands"
import { DESCRIBE_END, DESCRIBE_START, describeSection, describeTitle, labelFor, mergeDescription, withoutDescribeSection, type PrEditor, type ReviewSnapshot } from "../src/pr-review/describe"
import { githubEditor } from "../src/pr-review/editors"
import { fixedMarker, type GhCall } from "../src/pr-review/publish"
import { createPrReviewService } from "../src/pr-review/service"
import { emptyState, type ReviewState } from "../src/pr-review/state"
import { APPROVE_OFF } from "../src/pr-review/signoff"
import type { GhRun } from "../src/pr-watch"

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

const HEAD = "d".repeat(40)
const walkthrough: PrWalkthrough = {
  overview: "Adds a retry to the sync client. Failures back off.", changes: [{ layer: "Sync", files: ["src/sync.ts", "src/retry.ts"], summary: "Retries a failed request with backoff." }],
  type: "bug fix", risk: { level: "low", reason: "Small and covered by tests." }, checks: [],
}
const finding = (id: string, verdict: "confirmed" | "plausible"): PrFinding => ({ id: id.repeat(40).slice(0, 40), path: "a.ts", line: 3, side: "RIGHT", severity: "major", category: "correctness", summary: `problem ${id}`, detail: "d", evidence: ["a.ts:3"], verdict })
const result = (findings: PrFinding[] = [], wt: PrWalkthrough | null = walkthrough, head = HEAD): PrReviewResult => ({ head, base: "b".repeat(40), findings, dropped: 0, summary: "ok", tokens: { input: 1, output: 1 }, budgetHit: false, ...(wt ? { walkthrough: wt } : {}) })
const review = (findings: PrFinding[] = [], wt: PrWalkthrough | null = walkthrough): ReviewSnapshot => ({ head: HEAD, result: result(findings, wt) })

describe("the description's MendCode section", () => {
  const section = describeSection({ walkthrough, head: HEAD })
  test("is between the two markers and carries the overview, change type, risk and layers", () => {
    expect(section.startsWith(DESCRIBE_START)).toBe(true)
    expect(section.endsWith(DESCRIBE_END)).toBe(true)
    expect(section).toContain("Adds a retry to the sync client.")
    expect(section).toContain("**Change:** Bug fix")
    expect(section).toContain("`src/sync.ts`, `src/retry.ts`")
  })
  test("an empty description becomes the section alone; a person's text is kept and the section is added after it", () => {
    expect(mergeDescription("", section)).toBe(`${section}\n`)
    const mine = "Fixes the flaky sync.\n\n- [ ] tested on staging"
    expect(mergeDescription(mine, section)).toBe(`${mine}\n\n${section}\n`)
  })
  test("a later run replaces only what is between the markers; text before and after them stays byte for byte", () => {
    const first = mergeDescription("Intro by a person.", section)
    const edited = first.replace(DESCRIBE_END, `${DESCRIBE_END}\n\nFooter written later.`)
    const next = describeSection({ walkthrough: { ...walkthrough, overview: "New overview." }, head: "e".repeat(40) })
    const merged = mergeDescription(edited, next)
    expect(merged.startsWith("Intro by a person.\n\n")).toBe(true)
    expect(merged.endsWith(`${DESCRIBE_END}\n\nFooter written later.\n`)).toBe(true)
    expect(merged).toContain("New overview.")
    expect(merged).not.toContain("Adds a retry")
    expect(merged.split(DESCRIBE_START)).toHaveLength(2)
    expect(mergeDescription(merged, next)).toBe(merged)
  })
  test("a stray start marker without its end is left alone: a new section is appended and only that one is replaced later", () => {
    const damaged = `Text.\n${DESCRIBE_START}\nmore of a person's text`
    const once = mergeDescription(damaged, section)
    expect(once.startsWith(damaged)).toBe(true)
    const twice = mergeDescription(once, describeSection({ walkthrough: { ...walkthrough, overview: "Second." }, head: HEAD }))
    expect(twice.startsWith(damaged)).toBe(true)
    expect(twice).toContain("Second.")
  })
  test("the review reads the author's description without the section", () => {
    expect(withoutDescribeSection(mergeDescription("Mine.", section))).toBe("Mine.")
    expect(withoutDescribeSection("No section here.")).toBe("No section here.")
  })
})

describe("title and label", () => {
  test("the title is the change type and the overview's first sentence, within 72 characters", () => {
    expect(describeTitle(walkthrough)).toBe("fix: adds a retry to the sync client")
    const long = describeTitle({ ...walkthrough, type: "feature", overview: "Adds a very long description of what this change does to the synchronisation client across layers. More." })
    expect(long.length).toBeLessThanOrEqual(72)
    expect(long.startsWith("feat: adds a very long")).toBe(true)
    expect(long.endsWith("…")).toBe(true)
  })
  test("a label is added only if the repository has one for the type, in the repository's spelling, and not when the PR already has one", () => {
    expect(labelFor({ type: "bug fix", repoLabels: ["Bug", "docs"], onPullRequest: [] })).toBe("Bug")
    expect(labelFor({ type: "bug fix", repoLabels: ["frontend", "docs"], onPullRequest: [] })).toBeUndefined()
    expect(labelFor({ type: "docs", repoLabels: ["documentation"], onPullRequest: [] })).toBe("documentation")
    expect(labelFor({ type: "bug fix", repoLabels: ["bug", "fix"], onPullRequest: ["Fix"] })).toBeUndefined()
    expect(labelFor({ type: "bug fix", repoLabels: undefined, onPullRequest: [] })).toBeUndefined()
  })
})

describe("parsePrCommand", () => {
  test("describe, resolve and approve are commands", () => {
    for (const word of ["describe", "resolve", "approve"]) expect(parsePrCommand(`@mendcode ${word}`)).toEqual({ kind: word as never })
  })
})

/** GitHub for one PR: what it holds, the repository's labels, who may write, and every write made. */
function fakeGithub(start: { title?: string; body?: string; labels?: string[]; head?: string; repoLabels?: string[]; threads?: Array<{ id: string; finding: string; resolved?: boolean; fixedReply?: boolean }> } = {}) {
  const pr = { title: start.title ?? "Retry sync", body: start.body ?? "", labels: start.labels ?? [], head: start.head ?? HEAD }
  const writes: Array<{ endpoint: string; method: string; body: any }> = []
  const resolvedThreads: string[] = []
  const writers = new Set(["maintainer"])
  const threads = start.threads ?? []
  const gh: GhCall = async ({ argv, stdin }) => {
    const endpoint = argv[1] ?? ""
    const method = argv.includes("--method") ? argv[argv.indexOf("--method") + 1]! : "GET"
    if (endpoint.endsWith("/permission")) return { code: 0, out: writers.has(endpoint.split("/")[4]!) ? "write" : "read" }
    if (endpoint === "repos/acme/app") return { code: 0, out: "true" }
    if (endpoint === "repos/acme/app/pulls/12" && method === "GET") return { code: 0, out: JSON.stringify({ title: pr.title, body: pr.body, labels: pr.labels.map((name) => ({ name })), head: { sha: pr.head } }) }
    if (endpoint.startsWith("repos/acme/app/labels?")) return { code: 0, out: JSON.stringify((start.repoLabels ?? []).map((name) => ({ name }))) }
    if (/\/(comments|reviews)\?per_page=100$/.test(endpoint)) return { code: 0, out: "[]" }
    if (argv[1] === "graphql") {
      const request = JSON.parse(stdin!)
      if (/resolveReviewThread/.test(request.query)) { writes.push({ endpoint: "graphql:resolve", method: "POST", body: request.variables }); resolvedThreads.push(request.variables.thread); return { code: 0, out: "{}" } }
      return { code: 0, out: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads.map((thread) => ({
        id: thread.id, isResolved: thread.resolved === true,
        comments: { nodes: [{ body: `text\n<!-- mendcode:f=${thread.finding} -->` }] },
        replies: { nodes: thread.fixedReply ? [{ body: `Fixed in \`abc\`\n\n${fixedMarker(thread.finding)}` }] : [] },
      })) } } } } }) }
    }
    if (method !== "GET") {
      const body = stdin ? JSON.parse(stdin) : undefined
      writes.push({ endpoint, method, body })
      if (endpoint === "repos/acme/app/pulls/12" && method === "PATCH") { if (body.title !== undefined) pr.title = body.title; if (body.body !== undefined) pr.body = body.body }
      return { code: 0, out: "{}" }
    }
    return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` }
  }
  return { gh, pr, writes, resolvedThreads, writers, replies: () => writes.filter((write) => write.endpoint.endsWith("/comments")).map((write) => write.body.body as string) }
}

const issue = (body: string, actor = "maintainer"): CommandComment => ({ id: 5, surface: "issue", actor, body })
function deps(github: ReturnType<typeof fakeGithub>, comment: CommandComment, extra: Partial<CommandDeps> = {}): CommandDeps & { log: string[] } {
  const log: string[] = []
  return {
    gh: github.gh, repo: "acme/app", number: 12, comment, state: emptyState(), log,
    review: async () => { log.push("review"); return { status: "published", posted: true } },
    explain: async () => "x", fixesAllowed: async () => false, pushable: async () => false,
    editor: githubEditor({ gh: github.gh, repo: "acme/app", number: 12 }),
    lastReview: async (head) => head === HEAD ? review() : undefined,
    settings: { describeTitle: false, approve: false },
    ...extra,
  }
}

describe("@mendcode describe", () => {
  test("writes the section into an empty description, keeps the title (config off) and adds an existing label", async () => {
    const github = fakeGithub({ repoLabels: ["bug", "docs"] })
    const outcome = await runPrCommand({ kind: "describe" }, deps(github, issue("@mendcode describe")))
    expect(outcome).toMatchObject({ kind: "describe", posted: true })
    const patch = github.writes.find((write) => write.method === "PATCH")!
    expect(patch.body.title).toBeUndefined()
    expect(patch.body.body).toContain(DESCRIBE_START)
    expect(github.writes.find((write) => write.endpoint === "repos/acme/app/issues/12/labels")!.body).toEqual({ labels: ["bug"] })
    expect(github.pr.title).toBe("Retry sync")
    expect(outcome.reply).toContain("title kept (`commands.describe_title` is off)")
  })
  test("never touches a description a person wrote outside the markers, and a second run changes nothing", async () => {
    const github = fakeGithub({ body: "Written by a person.\n\n- [x] done" })
    await runPrCommand({ kind: "describe" }, deps(github, issue("@mendcode describe")))
    expect(github.pr.body.startsWith("Written by a person.\n\n- [x] done\n\n")).toBe(true)
    const patches = github.writes.filter((write) => write.method === "PATCH").length
    const again = await runPrCommand({ kind: "describe" }, deps(github, { ...issue("@mendcode describe"), id: 6 }))
    expect(github.writes.filter((write) => write.method === "PATCH")).toHaveLength(patches)
    expect(again.reply).toContain("the description is up to date")
  })
  test("the title changes only with commands.describe_title on", async () => {
    const off = fakeGithub()
    await runPrCommand({ kind: "describe" }, deps(off, issue("@mendcode describe")))
    expect(off.pr.title).toBe("Retry sync")
    const on = fakeGithub()
    const outcome = await runPrCommand({ kind: "describe" }, deps(on, issue("@mendcode describe"), { settings: { describeTitle: true, approve: false } }))
    expect(on.pr.title).toBe("fix: adds a retry to the sync client")
    expect(outcome.reply).toContain("title replaced")
  })
  test("a label the repository does not have is never added, and no label is created", async () => {
    const github = fakeGithub({ repoLabels: ["frontend"] })
    const outcome = await runPrCommand({ kind: "describe" }, deps(github, issue("@mendcode describe")))
    expect(github.writes.some((write) => write.endpoint.endsWith("/labels"))).toBe(false)
    expect(outcome.reply).toContain("no label added")
  })
  test("with no finished review of the head, the normal review runs first and describe goes on when it ends", async () => {
    const github = fakeGithub()
    let reviewed = false
    const d = deps(github, issue("@mendcode describe"), {
      lastReview: async () => reviewed ? review() : undefined,
      review: async () => { reviewed = true; return { status: "published", posted: true } },
    })
    await runPrCommand({ kind: "describe" }, d)
    expect(reviewed).toBe(true)
    expect(github.pr.body).toContain(DESCRIBE_START)
  })
  test("when the review still leaves nothing to write from, it says so and writes nothing", async () => {
    const github = fakeGithub()
    const outcome = await runPrCommand({ kind: "describe" }, deps(github, issue("@mendcode describe"), { lastReview: async () => undefined, review: async () => ({ status: "failed", reason: "quota", posted: false }) }))
    expect(outcome.reply).toContain("the review failed (quota)")
    expect(github.writes.filter((write) => write.method !== "GET")).toHaveLength(1) // only the reply
  })
  test("a review without a walkthrough (a stopped one) describes nothing", async () => {
    const github = fakeGithub()
    const outcome = await runPrCommand({ kind: "describe" }, deps(github, issue("@mendcode describe"), { lastReview: async () => review([], null) }))
    expect(outcome.reply).toContain("wrote no walkthrough")
    expect(github.pr.body).toBe("")
  })
  test("a forge that cannot edit a pull request says it is not supported", async () => {
    const github = fakeGithub()
    const editor: PrEditor = { name: "Gitea", read: async () => ({ title: "t", body: "", labels: [], head: HEAD }) }
    const outcome = await runPrCommand({ kind: "describe" }, deps(github, issue("@mendcode describe"), { editor }))
    expect(outcome.reply).toContain("is not supported on Gitea")
  })
  test("a runner without the daemon's saved reviews (hosted) says it cannot", async () => {
    const github = fakeGithub()
    const outcome = await runPrCommand({ kind: "describe" }, deps(github, issue("@mendcode describe"), { editor: undefined, lastReview: undefined, settings: undefined }))
    expect(outcome.reply).toContain("needs the MendCode daemon")
  })
})

const thread = (letter: string, extra: { resolved?: boolean; fixedReply?: boolean } = {}) => ({ id: `T_${letter}`, finding: letter.repeat(40), ...extra })
const stateWith = (resolved: Record<string, boolean | undefined>): ReviewState => ({ version: 1, published: Object.fromEntries(Object.entries(resolved).map(([letter, done]) => [letter.repeat(40), { finding: finding(letter, "confirmed"), ...(done ? { resolved: true } : {}) }])) })

describe("@mendcode resolve", () => {
  test("resolves only the threads whose findings the last review marked fixed", async () => {
    const github = fakeGithub({ threads: [
      thread("a", { fixedReply: true }), // fixed, could not be resolved by the account: has the "Fixed in" reply
      thread("b"), // still open
      thread("c", { resolved: true, fixedReply: true }), // already resolved
      thread("d"), // marked resolved in the state, left open by a person reopening it? no: state says fixed
    ] })
    const state = stateWith({ a: true, b: false, c: true, d: true })
    const outcome = await runPrCommand({ kind: "resolve" }, deps(github, issue("@mendcode resolve"), { state }))
    expect(github.resolvedThreads.sort()).toEqual(["T_a", "T_d"])
    expect(outcome.reply).toBe("Resolved 2 threads whose findings the last review marked fixed.")
    expect(outcome.state.published["b".repeat(40)]!.resolved).toBeUndefined()
    expect(outcome.state.published["a".repeat(40)]!.threadId).toBe("T_a")
  })
  test("a thread of an open finding, and a thread MendCode did not write, stay open", async () => {
    const github = fakeGithub({ threads: [thread("b")] })
    const outcome = await runPrCommand({ kind: "resolve" }, deps(github, issue("@mendcode resolve"), { state: stateWith({ b: false }) }))
    expect(github.resolvedThreads).toEqual([])
    expect(outcome.reply).toContain("No thread of MendCode is waiting")
  })
  test("a refusal from the forge is counted, not hidden", async () => {
    const github = fakeGithub({ threads: [thread("a", { fixedReply: true })] })
    const refuse: GhCall = async (input) => input.argv[1] === "graphql" && /resolveReviewThread/.test(JSON.parse(input.stdin!).query) ? { code: 1, out: "", err: "forbidden" } : github.gh(input)
    const outcome = await runPrCommand({ kind: "resolve" }, deps(github, issue("@mendcode resolve"), { editor: githubEditor({ gh: refuse, repo: "acme/app", number: 12 }), state: stateWith({ a: true }) }))
    expect(outcome.reply).toContain("1 thread could not be resolved")
  })
  test("a forge that cannot resolve threads says so", async () => {
    const github = fakeGithub()
    const editor: PrEditor = { name: "Gitea", read: async () => undefined }
    const outcome = await runPrCommand({ kind: "resolve" }, deps(github, issue("@mendcode resolve"), { editor }))
    expect(outcome.reply).toContain("is not supported on Gitea")
  })
})

describe("@mendcode approve", () => {
  const enabled = { describeTitle: false, approve: true }
  const approvals = (github: ReturnType<typeof fakeGithub>) => github.writes.filter((write) => write.endpoint === "repos/acme/app/pulls/12/reviews")
  test("is off by default: it answers how to turn it on and approves nothing", async () => {
    const github = fakeGithub()
    const outcome = await runPrCommand({ kind: "approve" }, deps(github, issue("@mendcode approve")))
    expect(outcome.reply).toContain(APPROVE_OFF)
    expect(approvals(github)).toEqual([])
  })
  test("is blocked while the last review of the head has a confirmed finding, and says which", async () => {
    const github = fakeGithub()
    const outcome = await runPrCommand({ kind: "approve" }, deps(github, issue("@mendcode approve"), { settings: enabled, lastReview: async () => review([finding("a", "confirmed"), finding("b", "plausible")]) }))
    expect(outcome.reply).toContain("Not approved: the last review of ddddddddddd")
    expect(outcome.reply).toContain("1 confirmed finding still open")
    expect(outcome.reply).toContain("problem a")
    expect(outcome.reply).not.toContain("problem b")
    expect(approvals(github)).toEqual([])
  })
  test("is blocked by a confirmed finding from an earlier review that is still unresolved", async () => {
    const github = fakeGithub()
    const outcome = await runPrCommand({ kind: "approve" }, deps(github, issue("@mendcode approve"), { settings: enabled, state: stateWith({ a: false }) }))
    expect(outcome.reply).toContain("1 confirmed finding still open")
    expect(approvals(github)).toEqual([])
  })
  test("is blocked when no review of this very head exists", async () => {
    const github = fakeGithub({ head: "e".repeat(40) })
    const outcome = await runPrCommand({ kind: "approve" }, deps(github, issue("@mendcode approve"), { settings: enabled }))
    expect(outcome.reply).toContain("no finished review of eeeeeeeeeeee")
    expect(approvals(github)).toEqual([])
  })
  test("is allowed when enabled and the last review of this head confirmed nothing (plausible findings and fixed ones do not block)", async () => {
    const github = fakeGithub()
    const outcome = await runPrCommand({ kind: "approve" }, deps(github, issue("@mendcode approve"), { settings: enabled, state: stateWith({ a: true }), lastReview: async () => review([finding("b", "plausible")]) }))
    expect(approvals(github)).toHaveLength(1)
    expect(approvals(github)[0]!.body).toMatchObject({ event: "APPROVE", commit_id: HEAD })
    expect(outcome.reply).toContain(`Approved ${HEAD.slice(0, 12)}`)
  })
  test("a forge that cannot approve says so; one that refuses is reported", async () => {
    const github = fakeGithub()
    const none: PrEditor = { name: "Gitea", read: async () => ({ title: "", body: "", labels: [], head: HEAD }) }
    expect((await runPrCommand({ kind: "approve" }, deps(github, issue("@mendcode approve"), { settings: enabled, editor: none }))).reply).toContain("is not supported on Gitea")
    const refusing: PrEditor = { ...none, approve: async () => ({ ok: false, reason: "cannot approve your own pull request" }) }
    expect((await runPrCommand({ kind: "approve" }, deps(github, issue("@mendcode approve"), { settings: enabled, editor: refusing }))).reply).toContain("refused the approval (cannot approve your own pull request)")
  })
})

describe("who may run them", () => {
  test("someone without write access gets the one refusal and nothing is read or written", async () => {
    for (const kind of ["describe", "resolve", "approve"] as const) {
      const github = fakeGithub({ repoLabels: ["bug"] })
      const d = deps(github, issue(`@mendcode ${kind}`, "drive-by"), { settings: { describeTitle: true, approve: true } })
      const outcome = await runPrCommand({ kind }, d)
      expect(outcome).toMatchObject({ kind: "denied", posted: true })
      expect(outcome.reply).toBe(MAINTAINERS_ONLY)
      expect(d.log).toEqual([])
      expect(github.writes.filter((write) => write.method !== "GET" && !write.endpoint.endsWith("/comments"))).toEqual([])
      expect(github.pr.body).toBe("")
    }
  })
})

describe("through the daemon", () => {
  const view = JSON.stringify({ number: 12, headRefOid: HEAD, baseRefOid: "b".repeat(40), baseRefName: "main", headRefName: "feature", isDraft: false, labels: [], author: { login: "bob" }, files: [{ path: "a.ts" }], reviewRequests: [], assignees: [], isCrossRepository: false })
  const run: GhRun = async ({ argv }) => argv[0] === "repo" ? { code: 0, out: "acme/app", err: "" } : argv.join(" ") === "api user --jq .login" ? { code: 0, out: "nora", err: "" } : argv[0] === "pr" && argv[1] === "view" ? { code: 0, out: view, err: "" } : { code: 1, out: "", err: "unexpected" }

  function start(github: ReturnType<typeof fakeGithub>) {
    const dir = temp("describe-data-"), project = temp("describe-project-")
    const notices: string[] = []
    const service = createPrReviewService({
      dir, run, call: github.gh, intervalMs: 3_600_000, enabled: () => true, graphOn: () => false, sessionDirectory: () => project, sessionExists: () => true,
      notify: (_session, text) => notices.push(text), sessions: () => { throw new Error("no model call") }, editor: () => { throw new Error("no model call") }, schedule: async (job) => { await job() },
    })
    cleanups.push(() => service.stop())
    // A finished review of HEAD, as the job ledger keeps it.
    const job = service.platform.jobs.upsert({ provider: "github", repo: "acme/app", directory: project, number: 12, sessionId: "ses_a", reviewer: "global", scope: "global", trigger: "comment", coverage: "full", base: "b".repeat(40), head: HEAD, configKey: "k", state: "running" })
    service.platform.jobs.checkpoint(job.id, { result: result([finding("a", "plausible")]) })
    service.platform.jobs.transition(job.id, "done")
    const command = (kind: "describe" | "resolve" | "approve", actor = "maintainer", id = 40) => ({ kind: "command" as const, directory: project, sessionId: "ses_a", number: 12, head: HEAD, trigger: "comment" as const, command: { kind }, comment: { id, surface: "issue" as const, actor, body: `@mendcode ${kind}`, association: "MEMBER" } })
    return { service, project, notices, command }
  }

  test("@mendcode describe writes the section from the saved review, with no model call, once posting is allowed", async () => {
    const github = fakeGithub({ repoLabels: ["bug"] })
    const { service, command, notices } = start(github)
    // Posting not allowed yet: held like every command, nothing is written.
    expect(await service.command(command("describe"))).toEqual({ blocked: "consent" })
    expect(github.pr.body).toBe("")
    await service.control({ sessionId: "ses_a", action: "publish-on" })
    expect(await service.command(command("describe", "maintainer", 41))).toBeUndefined()
    expect(github.pr.body).toContain("Adds a retry to the sync client.")
    expect(github.replies().at(-1)).toContain("Described ddddddddddd")
    expect(notices.at(-1)).toContain("@mendcode describe from maintainer on acme/app#12: answered on GitHub")
  })

  test("@mendcode approve and describe from someone without write access are refused and write nothing", async () => {
    const github = fakeGithub()
    const { service, command } = start(github)
    await service.control({ sessionId: "ses_a", action: "publish-on" })
    await service.command(command("describe", "drive-by", 42))
    await service.command(command("approve", "drive-by", 43))
    expect(github.pr.body).toBe("")
    expect(github.writes.filter((write) => !write.endpoint.endsWith("/comments"))).toEqual([])
    expect(github.replies()).toEqual([expect.stringContaining(MAINTAINERS_ONLY), expect.stringContaining(MAINTAINERS_ONLY)])
  })

  test("@mendcode approve stays off unless the repository's config enables it", async () => {
    const github = fakeGithub()
    const { service, command } = start(github)
    await service.control({ sessionId: "ses_a", action: "publish-on" })
    await service.command(command("approve", "maintainer", 44))
    expect(github.replies().at(-1)).toContain(APPROVE_OFF)
    expect(github.writes.some((write) => write.endpoint.endsWith("/reviews"))).toBe(false)
  })
})

describe("GitLab and Gitea", () => {
  const FINDING = "a".repeat(40)
  test("GitLab edits the merge request, lists labels, approves with the head's sha and resolves the fixed discussion only", async () => {
    const { createGitlabProvider } = await import("../src/pr-review/providers/gitlab")
    const { providerEditor } = await import("../src/pr-review/editors")
    const calls: Array<{ endpoint: string; method: string; body: any }> = []
    const run = async ({ argv, stdin }: { argv: string[]; stdin?: string | undefined }) => {
      const method = argv.includes("--method") ? argv[argv.indexOf("--method") + 1]! : "GET"
      const endpoint = argv[1]!
      calls.push({ endpoint, method, body: stdin ? JSON.parse(stdin) : undefined })
      if (endpoint.includes("/labels?")) return { code: 0, out: JSON.stringify([{ name: "bug" }, { name: "docs" }]), err: "" }
      if (endpoint.includes("/discussions?")) return { code: 0, out: JSON.stringify([
        { id: "d1", notes: [{ id: 1, type: "DiffNote", body: `x <!-- mendcode:f=${FINDING} -->`, resolved: false }] },
        { id: "d2", notes: [{ id: 2, type: "DiffNote", body: `x <!-- mendcode:f=${"b".repeat(40)} -->`, resolved: false }] },
      ]), err: "" }
      return { code: 0, out: "{}", err: "" }
    }
    const provider = createGitlabProvider({ run, hostname: "gitlab.example.com" })
    expect(await provider.repoLabels!({ repo: "grp/app" })).toEqual(["bug", "docs"])
    expect(await provider.edit!({ repo: "grp/app", number: 4, title: "t", body: "b", labels: ["bug"] })).toEqual({ ok: true })
    expect(calls.find((call) => call.method === "PUT")!.body).toEqual({ title: "t", description: "b", add_labels: "bug" })
    expect(await provider.approve!({ repo: "grp/app", number: 4, head: HEAD, body: "ok" })).toEqual({ ok: true })
    expect(calls.find((call) => call.endpoint.endsWith("/merge_requests/4/approve"))!.body).toEqual({ sha: HEAD })
    const state: ReviewState = { version: 1, published: { [FINDING]: { finding: finding("a", "confirmed"), resolved: true }, ["b".repeat(40)]: { finding: finding("b", "confirmed") } } }
    const report = await providerEditor({ provider, repo: "grp/app", number: 4 }).resolveFixed!({ state })
    expect(report).toMatchObject({ resolved: 1, failed: 0 })
    expect(calls.filter((call) => call.method === "PUT" && call.endpoint.includes("/discussions/")).map((call) => call.endpoint)).toEqual([expect.stringContaining("/discussions/d1?resolved=true")])
  })

  test("Gitea edits the pull request, adds labels by id, approves on the commit, and has no thread resolving", async () => {
    const { createGiteaProvider } = await import("../src/pr-review/providers/gitea")
    const { providerEditor } = await import("../src/pr-review/editors")
    const origin = "https://gitea.example.com"
    const requests: Array<{ path: string; method: string; body: any }> = []
    const fetcher = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
      const path = String(input).slice(`${origin}/api/v1/`.length)
      requests.push({ path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined })
      if (path.startsWith("repos/o/r/labels")) return new Response(JSON.stringify([{ id: 7, name: "bug" }, { id: 8, name: "docs" }]), { status: 200 })
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    const provider = createGiteaProvider({ baseUrl: origin, fetch: fetcher, token: () => "tok" })
    expect(await provider.repoLabels!({ repo: "o/r" })).toEqual(["bug", "docs"])
    expect(await provider.edit!({ repo: "o/r", number: 3, title: "t", body: "b", labels: ["bug", "nope"] })).toEqual({ ok: true })
    expect(requests.find((request) => request.method === "PATCH")!.body).toEqual({ title: "t", body: "b" })
    expect(requests.find((request) => request.path === "repos/o/r/issues/3/labels")!.body).toEqual({ labels: [7] })
    expect(await provider.approve!({ repo: "o/r", number: 3, head: HEAD, body: "ok" })).toEqual({ ok: true })
    expect(requests.find((request) => request.path === "repos/o/r/pulls/3/reviews")!.body).toMatchObject({ event: "APPROVED", commit_id: HEAD })
    // Gitea's API has no thread resolving: the editor leaves `resolveFixed` out and the command says it is not supported.
    expect(providerEditor({ provider, repo: "o/r", number: 3 }).resolveFixed).toBeUndefined()
    const none = createGiteaProvider({ baseUrl: origin, fetch: fetcher, token: () => undefined })
    expect(await none.approve!({ repo: "o/r", number: 3, head: HEAD, body: "ok" })).toMatchObject({ ok: false })
  })
})

describe("the commands config", () => {
  test("both switches are off by default and only the repository sets them", async () => {
    const { DEFAULT_REVIEW_CONFIG, parseReviewConfig } = await import("../src/pr-review/config")
    const { layeredConfig } = await import("../src/pr-review/run")
    expect(DEFAULT_REVIEW_CONFIG.commands).toEqual({ describe_title: false, approve: false })
    expect(parseReviewConfig("commands:\n  describe_title: true\n  approve: true\n").config.commands).toEqual({ describe_title: true, approve: true })
    const repository = parseReviewConfig("enabled: true\n").config
    const effective = layeredConfig(repository, { personal: { commands: { approve: true } } })
    expect(effective.config.commands.approve).toBe(false)
    expect(effective.problems.join("\n")).toContain("only the repository sets commands")
  })
})
