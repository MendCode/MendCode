import { describe, expect, test } from "bun:test"
import type { PrReviewResult } from "@mendcode/protocol"
import type { CommandRun, ReviewProvider } from "../src/pr-review/contracts"
import { createEffectLedger } from "../src/pr-review/effects"
import { createGiteaProvider } from "../src/pr-review/providers/gitea"
import { createGitlabProvider } from "../src/pr-review/providers/gitlab"
import { DAEMON_FEATURES, gatedOff, PROVIDER_CAPABILITIES } from "../src/pr-review/providers/index"
import { publishThroughProvider } from "../src/pr-review/publish"
import { emptyState, findingMarker } from "../src/pr-review/state"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * The adapter methods the daemon uses beyond a review post (comments with authors, replies, edited claim comments, posts with
 * the head they reviewed, push targets, the login, changed files, thread resolution) and the provider publish path with the
 * effects ledger. Request shapes are the ones scripts/live-forges.ts ran against GitLab CE 19.5.3 and Gitea 28.2.0; the fakes
 * here are contract evidence only.
 */

const HEAD = "a".repeat(40), BASE = "b".repeat(40)

// ── GitLab ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ORIGIN_GL = "http://127.0.0.1:8929"
const PROJECT = "projects/grp%2Fdemo"
function fakeGlab(answer: (endpoint: string, method: string, body: any) => unknown) {
  const calls: Array<{ endpoint: string; method: string; body: any }> = []
  const run: CommandRun = async ({ argv, stdin }) => {
    const endpoint = argv[1]!.slice(`${ORIGIN_GL}/api/v4/`.length)
    const method = argv[argv.indexOf("--method") + 1] ?? "GET"
    const body = stdin ? JSON.parse(stdin) : undefined
    calls.push({ endpoint, method, body })
    const value = answer(endpoint, method, body)
    return value === undefined ? { code: 1, out: "", err: "glab: 404 Not Found" } : { code: 0, out: JSON.stringify(value), err: "" }
  }
  return { run, calls }
}
const note = (id: number, username: string, body: string, extra: Record<string, unknown> = {}) => ({ id, body, author: { username }, system: false, type: null, created_at: "2026-10-30T10:00:00Z", updated_at: "2026-10-30T10:00:00Z", ...extra })

describe("GitLab adapter for the daemon", () => {
  test("comments: system notes left out, diff notes are review comments answering their discussion's first note", async () => {
    const fake = fakeGlab((endpoint) => endpoint.startsWith(`${PROJECT}/merge_requests/3/discussions?`) ? [
      { id: "d1", individual_note: true, notes: [note(1, "ana", "@mendcode pause")] },
      { id: "d2", individual_note: false, notes: [note(2, "mendbot", `finding ${findingMarker("f".repeat(40))}`, { type: "DiffNote", position: { new_path: "a.ts", new_line: 4 } }), note(3, "ana", "@mendcode explain why", { type: "DiffNote", position: { new_path: "a.ts", new_line: 4 } })] },
      { id: "d3", individual_note: true, notes: [note(4, "root", "added 1 commit", { system: true })] },
    ] : undefined)
    const provider = createGitlabProvider({ run: fake.run, baseUrl: ORIGIN_GL })
    const read = await provider.comments({ repo: "grp/demo", number: 3 })
    expect(read.ok && read.comments.map(({ id, author, surface, discussion, inReplyTo, path, line }) => ({ id, author, surface, discussion, inReplyTo, path, line }))).toEqual([
      { id: 1, author: "ana", surface: "issue", discussion: undefined, inReplyTo: undefined, path: undefined, line: undefined },
      { id: 2, author: "mendbot", surface: "review", discussion: "d2", inReplyTo: undefined, path: "a.ts", line: 4 },
      { id: 3, author: "ana", surface: "review", discussion: "d2", inReplyTo: 2, path: "a.ts", line: 4 },
    ])
  })

  test("reply goes to the comment's discussion; a lone note is answered with a new note; comment posts and edits in place", async () => {
    const fake = fakeGlab((endpoint, method) => method === "POST" && endpoint.endsWith("/discussions/d2/notes") ? { id: 10 } : method === "POST" && endpoint === `${PROJECT}/merge_requests/3/notes` ? { id: 11 } : method === "PUT" && endpoint === `${PROJECT}/merge_requests/3/notes/11` ? { id: 11 } : undefined)
    const provider = createGitlabProvider({ run: fake.run, baseUrl: ORIGIN_GL })
    expect(await provider.reply({ repo: "grp/demo", number: 3, to: { id: 3, surface: "review", discussion: "d2" }, body: "R" })).toEqual({ ok: true, id: 10 })
    expect(await provider.reply({ repo: "grp/demo", number: 3, to: { id: 1, surface: "issue" }, body: "R" })).toEqual({ ok: true, id: 11 })
    expect(await provider.comment({ repo: "grp/demo", number: 3, body: "claim" })).toEqual({ ok: true, id: 11 })
    expect(await provider.comment({ repo: "grp/demo", number: 3, body: "claim 2", edit: 11 })).toEqual({ ok: true, id: 11 })
    expect(fake.calls.map((call) => `${call.method} ${call.endpoint} ${call.body?.body}`)).toEqual([
      `POST ${PROJECT}/merge_requests/3/discussions/d2/notes R`, `POST ${PROJECT}/merge_requests/3/notes R`, `POST ${PROJECT}/merge_requests/3/notes claim`, `PUT ${PROJECT}/merge_requests/3/notes/11 claim 2`,
    ])
  })

  test("self, files, markers, threads, and a fork's push target with allow_collaboration", async () => {
    const mr = { iid: 3, title: "T", description: "Corrige la validación.", author: { username: "bob" }, source_branch: "feat", target_branch: "main", sha: HEAD, diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: HEAD }, source_project_id: 9, target_project_id: 2, allow_collaboration: true, labels: [], reviewers: [], assignees: [], state: "opened" }
    const fake = fakeGlab((endpoint) =>
      endpoint === "user" ? { username: "mendbot" }
      : endpoint.startsWith(`${PROJECT}/merge_requests/3/diffs?`) ? [{ old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-x\n+y\n" }, { old_path: "gone.ts", new_path: "gone.ts", diff: "", deleted_file: true }]
      : endpoint.startsWith(`${PROJECT}/merge_requests/3/notes?`) ? [note(5, "mendbot", "## MendCode review\n\n<!-- mendcode:review head=aaaaaaa -->"), note(6, "mendbot", "inline", { type: "DiffNote" })]
      : endpoint.startsWith(`${PROJECT}/merge_requests/3/discussions?`) ? [{ id: "d9", individual_note: false, notes: [note(7, "mendbot", findingMarker("f".repeat(40)), { type: "DiffNote", resolved: false })] }]
      : endpoint === `${PROJECT}/merge_requests/3` ? mr
      : endpoint === "projects/9" ? { path_with_namespace: "mallory/demo" } : undefined)
    const provider = createGitlabProvider({ run: fake.run, baseUrl: ORIGIN_GL })
    expect(await provider.self()).toBe("mendbot")
    expect(await provider.files({ repo: "grp/demo", number: 3 })).toEqual(["a.ts", "gone.ts"])
    expect(await provider.markers({ repo: "grp/demo", number: 3 })).toEqual({ ok: true, posts: [{ id: 5, author: "mendbot", body: "## MendCode review\n\n<!-- mendcode:review head=aaaaaaa -->" }] })
    expect(await provider.threads({ repo: "grp/demo", number: 3 })).toEqual([{ id: "d9", resolved: false, body: findingMarker("f".repeat(40)) }])
    expect(await provider.pushTarget({ repo: "grp/demo", number: 3 })).toEqual({ branch: "feat", head: HEAD, base: BASE, baseRef: "main", repo: "mallory/demo", fork: true, pushable: true })
    expect((await provider.view({ directory: "", repo: "grp/demo", number: 3 })).open).toBe(true)
    // The MR's description, which `template.language: auto` reads with the title.
    expect((await provider.view({ directory: "", repo: "grp/demo", number: 3 })).body).toBe("Corrige la validación.")
  })
})

// ── Gitea ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ORIGIN_GT = "http://127.0.0.1:3917"
function fakeFetch(answer: (path: string, method: string, body: any) => { status?: number; body?: unknown } | undefined) {
  const requests: Array<{ path: string; method: string; body: any }> = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const pathname = String(input).slice(`${ORIGIN_GT}/api/v1/`.length)
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    requests.push({ path: pathname, method, body })
    const given = answer(pathname, method, body) ?? { status: 404, body: { message: "not found" } }
    return new Response(JSON.stringify(given.body ?? null), { status: given.status ?? 200 })
  }) as unknown as typeof fetch
  return { fetcher, requests }
}
const user = (login: string) => ({ id: 1, login })

describe("Gitea adapter for the daemon", () => {
  test("comments: the conversation, then each review's comments; a reply on the same line answers the conversation's first comment", async () => {
    const fake = fakeFetch((p) =>
      p === "repos/acme/app/issues/5/comments" ? { body: [{ id: 1, body: "@mendcode pause", user: user("ana"), created_at: "2026-10-30T10:00:00Z" }] }
      : p.startsWith("repos/acme/app/pulls/5/reviews?") ? { body: [{ id: 40, body: "summary", user: user("mendbot"), commit_id: HEAD, state: "COMMENT" }] }
      : p === "repos/acme/app/pulls/5/reviews/40/comments" ? { body: [{ id: 2, body: "finding", user: user("mendbot"), path: "a.ts", position: 4 }, { id: 3, body: "@mendcode explain", user: user("ana"), path: "a.ts", position: 4 }] }
      : undefined)
    const provider = createGiteaProvider({ baseUrl: ORIGIN_GT, fetch: fake.fetcher, token: () => "t" })
    const read = await provider.comments({ repo: "acme/app", number: 5 })
    expect(read.ok && read.comments.map(({ id, author, surface, inReplyTo, path, line }) => ({ id, author, surface, inReplyTo, path, line }))).toEqual([
      { id: 1, author: "ana", surface: "issue", inReplyTo: undefined, path: undefined, line: undefined },
      { id: 2, author: "mendbot", surface: "review", inReplyTo: undefined, path: "a.ts", line: 4 },
      { id: 3, author: "ana", surface: "review", inReplyTo: 2, path: "a.ts", line: 4 },
    ])
    expect(await provider.markers({ repo: "acme/app", number: 5 })).toEqual({ ok: true, posts: [{ id: 40, author: "mendbot", body: "summary", commit: HEAD, state: "COMMENT" }] })
  })

  test("reply in the review conversation, falling back to the conversation where the endpoint is missing (Forgejo); comment edits with PATCH", async () => {
    let replies = 201
    const fake = fakeFetch((p, method) =>
      method === "POST" && p === "repos/acme/app/pulls/5/comments/2/replies" ? { status: replies, body: { id: 50 } }
      : method === "POST" && p === "repos/acme/app/issues/5/comments" ? { status: 201, body: { id: 51 } }
      : method === "PATCH" && p === "repos/acme/app/issues/comments/51" ? { body: { id: 51 } } : undefined)
    const provider = createGiteaProvider({ baseUrl: ORIGIN_GT, fetch: fake.fetcher, token: () => "t" })
    expect(await provider.reply({ repo: "acme/app", number: 5, to: { id: 3, surface: "review", inReplyTo: 2 }, body: "R" })).toEqual({ ok: true, id: 50 })
    replies = 404
    expect(await provider.reply({ repo: "acme/app", number: 5, to: { id: 3, surface: "review", inReplyTo: 2 }, body: "R" })).toEqual({ ok: true, id: 51 })
    expect(await provider.comment({ repo: "acme/app", number: 5, body: "claim", edit: 51 })).toEqual({ ok: true, id: 51 })
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST repos/acme/app/pulls/5/comments/2/replies", "POST repos/acme/app/pulls/5/comments/2/replies", "POST repos/acme/app/issues/5/comments", "PATCH repos/acme/app/issues/comments/51"])
  })

  test("without a token nothing is written and no login is claimed; a fork's push target needs allow_maintainer_edit", async () => {
    const pr = { number: 5, title: "T", body: "Corrige la validación.", state: "open", user: user("bob"), head: { ref: "feat", sha: HEAD, repo_id: 11, repo: { full_name: "mallory/app" } }, base: { ref: "main", sha: BASE, repo_id: 10 }, allow_maintainer_edit: false }
    const fake = fakeFetch((p) => p === "repos/acme/app/pulls/5" ? { body: pr } : p === "user" ? { body: user("mendbot") } : undefined)
    const anonymous = createGiteaProvider({ baseUrl: ORIGIN_GT, fetch: fake.fetcher, token: () => undefined })
    expect(await anonymous.self()).toBeUndefined()
    expect((await anonymous.comment({ repo: "acme/app", number: 5, body: "x" })).ok).toBe(false)
    expect(fake.requests).toEqual([])
    const provider = createGiteaProvider({ baseUrl: ORIGIN_GT, fetch: fake.fetcher, token: () => "t" })
    expect(await provider.self()).toBe("mendbot")
    expect(await provider.pushTarget({ repo: "acme/app", number: 5 })).toEqual({ branch: "feat", head: HEAD, base: BASE, baseRef: "main", repo: "mallory/app", fork: true, pushable: false })
    // The PR's description, which `template.language: auto` reads with the title.
    expect((await provider.view({ directory: "", repo: "acme/app", number: 5 })).body).toBe("Corrige la validación.")
  })
})

// ── The provider publish path and the per-forge feature matrix ──────────────────────────────────────────────────────────

describe("publishThroughProvider", () => {
  const finding = { id: "f".repeat(40), path: "a.ts", line: 2, side: "RIGHT" as const, severity: "major" as const, category: "correctness" as const, summary: "s", detail: "d", evidence: ["a.ts:2"], verdict: "confirmed" as const }
  const result = (findings = [finding]): PrReviewResult => ({ head: HEAD, base: BASE, findings, dropped: 0, summary: "One.", tokens: { input: 1, output: 1 }, budgetHit: false })
  function fake(kind: "gitlab" | "gitea", outcome: Awaited<ReturnType<ReviewProvider["publish"]>> = { ok: true, remote: "note:77", comments: 1, movedToBody: 0 }) {
    const sent: Array<{ body: string; comments: unknown[]; marker: string }> = []
    const resolved: string[] = []
    const provider: ReviewProvider = {
      kind, capabilities: PROVIDER_CAPABILITIES[kind], repoOf: async () => "acme/app", headRef: () => "", listOpen: async () => ({ ok: true, prs: [] }),
      view: async () => { throw new Error("unused") }, findMarker: async () => ({ found: false }), permission: async () => "admin",
      publish: async (input) => { sent.push(input); return outcome },
      threads: async () => [{ id: "d1", resolved: false, body: findingMarker(finding.id) }],
      resolve: async ({ discussion }) => { resolved.push(discussion); return true },
    }
    return { provider, sent, resolved }
  }
  const ledger = () => { const dir = mkdtempSync(path.join(tmpdir(), "effects-")); const effects = createEffectLedger({ file: path.join(dir, "effects.json") }); return { effects, done: () => rmSync(dir, { recursive: true, force: true }) } }

  test("one post with the reviewer marker, recorded in the ledger; the same key is never sent again", async () => {
    const { effects, done } = ledger()
    try {
      const forge = fake("gitlab")
      const input = { provider: forge.provider, repo: "acme/app", number: 3, result: result(), previous: emptyState(), effects, reviewer: "global", configKey: "k", jobId: "j1" }
      const first = await publishThroughProvider(input)
      expect(first).toMatchObject({ posted: true, reviewId: 77, comments: 1 })
      expect(first.state.published[finding.id]).toBeDefined()
      expect(forge.sent[0]!.body).toContain(forge.sent[0]!.marker)
      expect(forge.sent[0]!.body).toContain(`<!-- mendcode:review head=${HEAD} -->`)
      const again = await publishThroughProvider(input)
      expect(again).toMatchObject({ posted: false, duplicate: true })
      expect(forge.sent).toHaveLength(1)
    } finally { done() }
  })

  test("a stale head posts nothing; an unconfirmed post stays pending; a refusal names the forge", async () => {
    const stale = fake("gitea")
    expect(await publishThroughProvider({ provider: stale.provider, repo: "acme/app", number: 3, result: result(), previous: emptyState(), isCurrent: () => false })).toMatchObject({ posted: false, stale: true })
    expect(stale.sent).toEqual([])
    const unsure = fake("gitea", { ok: false, reason: "HTTP 502", retryable: true })
    expect(await publishThroughProvider({ provider: unsure.provider, repo: "acme/app", number: 3, result: result(), previous: emptyState() })).toMatchObject({ posted: false, uncertain: true })
    const refused = fake("gitea", { ok: false, reason: "HTTP 403: forbidden", retryable: false })
    expect((await publishThroughProvider({ provider: refused.provider, repo: "acme/app", number: 3, result: result(), previous: emptyState() })).reason).toStartWith("Gitea refused the review")
  })

  test("a fixed finding's thread is resolved on GitLab; Gitea has no thread resolution and resolves nothing", async () => {
    const previous = { ...emptyState(), lastHead: "c".repeat(40), published: { [finding.id]: { finding } } }
    const gitlab = fake("gitlab")
    expect(await publishThroughProvider({ provider: gitlab.provider, repo: "acme/app", number: 3, result: result([]), previous, resolve: [finding.id] })).toMatchObject({ posted: false, resolved: 1 })
    expect(gitlab.resolved).toEqual(["d1"])
    const gitea = fake("gitea")
    expect(await publishThroughProvider({ provider: gitea.provider, repo: "acme/app", number: 3, result: result([]), previous, resolve: [finding.id] })).toMatchObject({ resolved: 0 })
    expect(gitea.resolved).toEqual([])
  })

  test("the daemon's matrix: GitHub runs everything; GitLab and Gitea gate off check follow-ups and the hosted runner with a reason", () => {
    expect(Object.values(DAEMON_FEATURES.github).every(Boolean)).toBe(true)
    expect(gatedOff("github")).toEqual([])
    expect(gatedOff("gitlab")).toHaveLength(2)
    expect(gatedOff("gitea")).toHaveLength(3)
    expect(gatedOff("gitea").join("\n")).toContain("Forgejo has no API")
  })
})
