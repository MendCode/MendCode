import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CommandRun } from "../src/pr-review/contracts"
import { createGitlabProvider, gitlabFacts, gitlabIsBot, gitlabPermission, gitlabSuggestion, GitlabMergeRequest } from "../src/pr-review/providers/gitlab"
import { capabilityMatrixText, createProvider, detectProvider, parseRemoteUrl, PROVIDER_CAPABILITIES } from "../src/pr-review/providers/index"

/**
 * Provider detection, the capability matrix and the GitLab adapter (docs/pr-review.md, providers). GitLab fixtures follow the
 * documented shapes: merge requests https://docs.gitlab.com/api/merge_requests/ (list has no `diff_refs`, the single MR does),
 * discussions https://docs.gitlab.com/api/discussions/, notes https://docs.gitlab.com/api/notes/, members
 * https://docs.gitlab.com/api/project_members/. These are contract evidence only: no call reaches gitlab.com.
 */

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const HEAD = "e82eb4a098e32c796079ca3915e07487fc4db24c", BASE = "1162f719d711319a2efb2a35566f3bfdadee8bab", START = "c380d3acebd181f13629a25d2e2acca46ffe1e00"
const MARKER = "<!-- mendcode:review head=e82eb4a -->"

/** A merge request as the project list returns it (no diff_refs), overridable per test. */
const listed = (iid: number, extra: Record<string, unknown> = {}) => ({
  id: 1000 + iid, iid, project_id: 3, title: `MR ${iid}`, state: "opened", draft: false, work_in_progress: false,
  labels: ["Community contribution", "Manage"], author: { id: 1, username: "admin", name: "Administrator", bot: false },
  source_branch: `feature-${iid}`, target_branch: "main", source_project_id: 3, target_project_id: 3, sha: HEAD,
  reviewers: [{ id: 2, username: "reviewer-a" }], assignees: [{ id: 3, username: "assignee-b" }],
  web_url: `https://gitlab.example.com/group/sub/project/-/merge_requests/${iid}`, updated_at: "2026-10-29T10:00:00.000Z", ...extra,
})
const single = (iid: number, extra: Record<string, unknown> = {}) => listed(iid, { diff_refs: { base_sha: BASE, head_sha: HEAD, start_sha: START }, allow_collaboration: true, ...extra })

type Call = { argv: string[]; body: any; cwd?: string | undefined }
/** A fake `glab`: answers by endpoint and method, records every call with its parsed JSON body. No network. */
function fakeGlab(answer: (endpoint: string, method: string, body: any) => { code: number; out: string; err?: string } | undefined) {
  const calls: Call[] = []
  const run: CommandRun = async ({ argv, stdin, cwd }) => {
    const body = stdin ? JSON.parse(stdin) : undefined
    calls.push({ argv, body, cwd })
    const method = argv[argv.indexOf("--method") + 1] ?? "GET"
    const given = answer(argv[1]!, method, body)
    return given ? { err: "", ...given } : { code: 1, out: "", err: `glab: 404 Not Found (unexpected ${method} ${argv[1]})` }
  }
  return { run, calls, method: (call: Call) => call.argv[call.argv.indexOf("--method") + 1] }
}
const ok = (value: unknown) => ({ code: 0, out: JSON.stringify(value) })
const PROJECT = "projects/group%2Fsub%2Fproject"

describe("detecting the provider of a remote", () => {
  const cases: Array<[string, string | undefined, string | undefined]> = [
    ["https://github.com/octo/repo.git", "github", "octo/repo"],
    ["git@github.com:octo/repo.git", "github", "octo/repo"],
    ["ssh://git@ssh.github.com:443/octo/repo.git", "github", "octo/repo"],
    ["https://gitlab.com/group/sub/project.git", "gitlab", "group/sub/project"],
    ["git@gitlab.com:group/sub/deeper/project.git", "gitlab", "group/sub/deeper/project"],
    ["ssh://git@gitlab.internal.example:2222/team/app.git", "gitlab", "team/app"],
    ["https://codeberg.org/forgejo/forgejo.git", "gitea", "forgejo/forgejo"],
    ["git@gitea.example.com:owner/repo.git", "gitea", "owner/repo"],
    ["https://forgejo.example.net:3000/owner/repo", "gitea", "owner/repo"],
    ["https://git.example.org/owner/repo.git", undefined, undefined],
    ["/local/path/repo", undefined, undefined],
  ]
  for (const [url, kind, repo] of cases) test(`${url} → ${kind ?? "unknown"}`, () => {
    const found = detectProvider(url)
    expect(found.kind).toBe(kind as never)
    if (found.kind) expect(found.repo).toBe(repo!)
    else expect(found.reason.length).toBeGreaterThan(10)
  })

  test("a config override names a GitHub Enterprise host and wins over the host's name", () => {
    const enterprise = detectProvider("git@ghe.corp.example:platform/api.git", { hosts: { "GHE.corp.example": "github" } })
    expect(enterprise).toMatchObject({ kind: "github", repo: "platform/api", host: "ghe.corp.example", baseUrl: "https://ghe.corp.example" })
    expect(enterprise.reason).toContain("config")
    expect(detectProvider("https://gitlab-mirror.example/o/r", { hosts: { "gitlab-mirror.example": "gitea" } }).kind).toBe("gitea")
  })

  test("GitHub and Gitea need exactly owner/repo; an unknown host says how to name it", () => {
    const deep = detectProvider("https://github.com/octo/repo/extra")
    expect(deep.kind).toBeUndefined()
    expect(deep.reason).toContain("owner/repo")
    expect(detectProvider("https://git.example.org/owner/repo").reason).toContain("overrides")
  })

  test("the base URL keeps an https port, drops an ssh one, and never carries credentials", () => {
    expect(detectProvider("https://user:secret@gitea.example.com:3000/o/r.git")).toMatchObject({ kind: "gitea", baseUrl: "https://gitea.example.com:3000" })
    expect(JSON.stringify(detectProvider("https://user:secret@gitea.example.com:3000/o/r.git"))).not.toContain("secret")
    expect(detectProvider("ssh://git@gitea.example.com:2222/o/r.git")).toMatchObject({ baseUrl: "https://gitea.example.com" })
    expect(parseRemoteUrl("git@gitlab.com:g/p.git")).toEqual({ host: "gitlab.com", path: "g/p", scheme: "ssh" })
  })
})

describe("the capability matrix", () => {
  test("GitLab and Gitea are live (scripts/live-forges.ts --daemon passed against both); the GitHub adapter object stays contract", () => {
    expect(PROVIDER_CAPABILITIES.gitlab.verified).toBe("live")
    expect(PROVIDER_CAPABILITIES.gitea.verified).toBe("live")
    expect(PROVIDER_CAPABILITIES.github.verified).toBe("contract")
  })

  test("no thread resolution or suggestions are claimed for Gitea, no review event for GitLab, no ETag for either", () => {
    expect(PROVIDER_CAPABILITIES.gitea).toMatchObject({ resolveThreads: false, suggestions: false, conditionalRequests: false, inlineComments: true, reviewEvents: true })
    expect(PROVIDER_CAPABILITIES.gitlab).toMatchObject({ resolveThreads: true, suggestions: true, reviewEvents: false, conditionalRequests: false, inlineComments: true })
  })

  test("the Markdown table has one row per capability, the verification row, and a note per provider", () => {
    const text = capabilityMatrixText()
    const lines = text.split("\n")
    expect(lines[0]).toBe("| Capability | GitHub | GitLab | Gitea / Forgejo |")
    expect(lines.find((line) => line.startsWith("| Resolve a thread"))).toBe(`| Resolve a thread when fixed | ${PROVIDER_CAPABILITIES.github.resolveThreads ? "yes" : "no"} | yes | no |`)
    expect(lines.find((line) => line.startsWith("| Verified"))).toBe("| Verified | contract (fixtures, not live) | live | live |")
    expect(lines.filter((line) => line.startsWith("|")).length).toBe(2 + 9 + 1)
    expect(text).toContain("- GitLab: through `glab api`")
  })

  test("createProvider builds each adapter with the matrix's capabilities and refuses a missing dependency", () => {
    const run: CommandRun = async () => ({ code: 0, out: "[]", err: "" })
    expect(createProvider("gitlab", { run }).capabilities).toBe(PROVIDER_CAPABILITIES.gitlab)
    expect(createProvider("gitea", { baseUrl: "https://codeberg.org" }).kind).toBe("gitea")
    expect(() => createProvider("gitea", {})).toThrow(TypeError)
    expect(() => createProvider("gitlab", {})).toThrow(TypeError)
  })
})

describe("GitLab merge request facts", () => {
  test("a single MR maps draft, labels, author, branches, diff refs, fork, collaboration, reviewers and assignees", () => {
    const facts = gitlabFacts(GitlabMergeRequest.parse(single(7, { draft: true, source_project_id: 9 })))
    expect(facts).toEqual({
      number: 7, title: "MR 7", head: HEAD, base: START, baseRef: "main", headRef: "feature-7", draft: true, labels: ["Community contribution", "Manage"],
      author: "admin", authorIsBot: false, fork: true, maintainerCanModify: true, requested: ["reviewer-a"], assignees: ["assignee-b"],
      url: "https://gitlab.example.com/group/sub/project/-/merge_requests/7", updatedAt: "2026-10-29T10:00:00.000Z", open: true,
    })
  })

  test("the deprecated work_in_progress still marks a draft; a list item has no base sha", () => {
    const facts = gitlabFacts(GitlabMergeRequest.parse(listed(3, { draft: undefined, work_in_progress: true })))
    expect(facts.draft).toBe(true)
    expect(facts.base).toBe("")
    expect(facts.fork).toBe(false)
  })

  test("bots: GitLab's own flag, access-token bots and named bots", () => {
    expect(gitlabIsBot({ username: "someone", bot: true })).toBe(true)
    expect(gitlabIsBot({ username: "project_42_bot_3f9a" })).toBe(true)
    expect(gitlabIsBot({ username: "group_7_bot" })).toBe(true)
    expect(gitlabIsBot({ username: "renovate-bot" })).toBe(true)
    expect(gitlabIsBot({ username: "robotics-dev" })).toBe(false)
  })

  test("access levels map to permissions: Guest and Planner cannot read a private project's code", () => {
    expect([50, 40, 30, 25, 20, 15, 10, 5, 0].map(gitlabPermission)).toEqual(["admin", "admin", "write", "read", "read", "none", "none", "none", "none"])
  })

  test("a multi-line suggestion becomes GitLab's ```suggestion:-N+0; a single line stays as is", () => {
    const body = "Use the guard.\n\n```suggestion\nif (!x) return\n```"
    expect(gitlabSuggestion(body, 4, 6)).toContain("```suggestion:-2+0\n")
    expect(gitlabSuggestion(body, 4)).toBe(body)
  })
})

describe("GitLab adapter over glab api", () => {
  test("listOpen reads every page of opened merge requests and stops at a short page", async () => {
    const first = Array.from({ length: 100 }, (_, index) => listed(index + 1))
    const fake = fakeGlab((endpoint) => endpoint.startsWith(`${PROJECT}/merge_requests?`) ? ok(endpoint.endsWith("page=1") ? first : [listed(101, { author: { username: "dependabot", bot: false } })]) : undefined)
    const provider = createGitlabProvider({ run: fake.run, hostname: "gitlab.example.com" })
    const found = await provider.listOpen({ directory: "/checkout", repo: "group/sub/project" })
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.prs.length).toBe(101)
    expect(found.prs.at(-1)).toMatchObject({ number: 101, authorIsBot: true })
    expect(fake.calls.map((call) => call.argv[1])).toEqual([
      `${PROJECT}/merge_requests?state=opened&order_by=updated_at&with_labels_details=true&per_page=100&page=1`,
      `${PROJECT}/merge_requests?state=opened&order_by=updated_at&with_labels_details=true&per_page=100&page=2`,
    ])
    expect(fake.calls[0]!.argv).toContain("--hostname")
    expect(fake.calls[0]!.cwd).toBe("/checkout")
  })

  test("listOpen reports a logged-out glab as an auth failure and a missing glab as such", async () => {
    const out = await createGitlabProvider({ run: fakeGlab(() => ({ code: 1, out: "", err: "glab: 401 Unauthorized" })).run }).listOpen({ directory: "/c", repo: "g/p" })
    expect(out).toMatchObject({ ok: false, auth: true })
    const missing = await createGitlabProvider({ run: async () => ({ code: 127, out: "", err: "" }) }).listOpen({ directory: "/c", repo: "g/p" })
    expect(missing).toMatchObject({ ok: false, auth: true, reason: expect.stringContaining("not installed") })
  })

  test("headRef is the merge request's head ref", () => {
    expect(createGitlabProvider({ run: fakeGlab(() => undefined).run }).headRef(12)).toBe("refs/merge-requests/12/head")
  })

  const publishFake = (options: { notes?: unknown[]; refuse?: (body: any) => boolean; summary?: (body: any) => { code: number; out: string; err?: string } } = {}) => fakeGlab((endpoint, method, body) => {
    if (endpoint === `${PROJECT}/merge_requests/5` && method === "GET") return ok(single(5))
    if (endpoint.startsWith(`${PROJECT}/merge_requests/5/notes?`)) return ok(options.notes ?? [])
    if (endpoint === `${PROJECT}/merge_requests/5/discussions` && method === "POST") return options.refuse?.(body) ? { code: 1, out: "", err: "glab: 400 Bad Request: Note {:line_code=>[\"can't be blank\", \"must be a valid line code\"]}" } : ok({ id: "6a9c1750b37d513a43987b574953fceb50b03ce7", notes: [{ id: 1, body: body.body }] })
    if (endpoint === `${PROJECT}/merge_requests/5/notes` && method === "POST") return options.summary?.(body) ?? ok({ id: 301, body: body.body })
    return undefined
  })
  const input = (comments: Array<{ path: string; line: number; endLine?: number; body: string }>) => ({ repo: "group/sub/project", number: 5, head: HEAD, body: "Summary of the review.", comments, marker: MARKER })

  test("publish posts one diff discussion per comment with the MR's diff refs, then the summary note with the marker", async () => {
    const fake = publishFake()
    const done = await createGitlabProvider({ run: fake.run }).publish(input([{ path: "src/a.ts", line: 3, body: "Off by one." }, { path: "src/b.ts", line: 4, endLine: 6, body: "```suggestion\nreturn x\n```" }]))
    expect(done).toEqual({ ok: true, remote: "note:301", comments: 2, movedToBody: 0 })
    const posts = fake.calls.filter((call) => fake.method(call) === "POST")
    expect(posts.map((call) => call.argv[1])).toEqual([`${PROJECT}/merge_requests/5/discussions`, `${PROJECT}/merge_requests/5/discussions`, `${PROJECT}/merge_requests/5/notes`])
    expect(posts[0]!.body.position).toEqual({ position_type: "text", base_sha: BASE, start_sha: START, head_sha: HEAD, old_path: "src/a.ts", new_path: "src/a.ts", new_line: 3 })
    expect(posts[1]!.body.position.new_line).toBe(6)
    expect(posts[1]!.body.body).toContain("```suggestion:-2+0")
    expect(posts.every((call) => call.body.body.includes(MARKER))).toBe(true)
    expect(posts[2]!.body.body.startsWith("Summary of the review.")).toBe(true)
  })

  test("a comment GitLab refuses moves into the summary; the others stay inline", async () => {
    const fake = publishFake({ refuse: (body) => body.position.new_path === "src/gone.ts" })
    const done = await createGitlabProvider({ run: fake.run }).publish(input([{ path: "src/a.ts", line: 3, body: "Kept inline." }, { path: "src/gone.ts", line: 9, body: "Not in the diff." }]))
    expect(done).toEqual({ ok: true, remote: "note:301", comments: 1, movedToBody: 1 })
    const summary = fake.calls.find((call) => call.argv[1] === `${PROJECT}/merge_requests/5/notes`)!.body.body
    expect(summary).toContain("Comments GitLab could not place on the diff")
    expect(summary).toContain("`src/gone.ts` line 9")
    expect(summary).toContain("Not in the diff.")
    expect(summary.endsWith(MARKER)).toBe(true)
  })

  test("a server error on a discussion posts no summary and is retryable", async () => {
    const fake = fakeGlab((endpoint, method) => {
      if (endpoint === `${PROJECT}/merge_requests/5` && method === "GET") return ok(single(5))
      if (endpoint.includes("/notes?")) return ok([])
      if (endpoint.endsWith("/discussions")) return { code: 1, out: "", err: "glab: 502 Bad Gateway" }
      return undefined
    })
    const done = await createGitlabProvider({ run: fake.run }).publish(input([{ path: "src/a.ts", line: 3, body: "x" }]))
    expect(done).toMatchObject({ ok: false, retryable: true })
    expect(fake.calls.some((call) => call.argv[1] === `${PROJECT}/merge_requests/5/notes` && fake.method(call) === "POST")).toBe(false)
  })

  test("a retry after a crash posts only the missing discussions and the summary (marker reconciliation)", async () => {
    const already = { id: 77, type: "DiffNote", system: false, body: `Off by one.\n\n${MARKER}`, author: { username: "mendcode" } }
    const fake = publishFake({ notes: [{ id: 70, type: null, system: true, body: "added 1 commit" }, already] })
    const done = await createGitlabProvider({ run: fake.run }).publish(input([{ path: "src/a.ts", line: 3, body: "Off by one." }, { path: "src/b.ts", line: 8, body: "Second." }]))
    expect(done).toEqual({ ok: true, remote: "note:301", comments: 2, movedToBody: 0 })
    expect(fake.calls.filter((call) => call.argv[1]?.endsWith("/discussions")).map((call) => call.body.position.new_path)).toEqual(["src/b.ts"])
  })

  test("a summary already carrying the marker means the review is there: nothing is posted again", async () => {
    const fake = publishFake({ notes: [{ id: 300, type: null, body: `Earlier summary\n\n${MARKER}` }] })
    const done = await createGitlabProvider({ run: fake.run }).publish(input([{ path: "src/a.ts", line: 3, body: "x" }]))
    expect(done).toMatchObject({ ok: true, remote: "note:300" })
    expect(fake.calls.filter((call) => fake.method(call) === "POST")).toEqual([])
  })

  test("a head that moved since the review is refused before anything is posted", async () => {
    const fake = publishFake()
    const done = await createGitlabProvider({ run: fake.run }).publish({ ...input([]), head: "f".repeat(40) })
    expect(done).toMatchObject({ ok: false, retryable: false, reason: expect.stringContaining("moved") })
    expect(fake.calls.filter((call) => fake.method(call) === "POST")).toEqual([])
  })

  test("findMarker searches every page of notes and ignores diff notes", async () => {
    const page1 = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, type: index === 5 ? "DiffNote" : null, body: index === 5 ? `inline ${MARKER}` : "chatter" }))
    const fake = fakeGlab((endpoint) => endpoint.includes("/notes?") ? ok(endpoint.endsWith("page=1") ? page1 : [{ id: 900, type: "DiscussionNote", body: `summary ${MARKER}` }]) : undefined)
    const provider = createGitlabProvider({ run: fake.run })
    expect(await provider.findMarker({ repo: "group/sub/project", number: 5, marker: MARKER })).toEqual({ found: true, remote: "note:900" })
    expect(await provider.findMarker({ repo: "group/sub/project", number: 5, marker: "<!-- other -->" })).toEqual({ found: false })
  })

  test("permission reads the user id, then the member's access level; a non-member is none", async () => {
    const fake = fakeGlab((endpoint) => {
      if (endpoint === "users?username=dev") return ok([{ id: 12, username: "dev" }])
      if (endpoint === "users?username=ghost") return ok([])
      if (endpoint === "users?username=outsider") return ok([{ id: 13 }])
      if (endpoint === `${PROJECT}/members/all/12`) return ok({ id: 12, username: "dev", access_level: 30, state: "active" })
      return undefined
    })
    const provider = createGitlabProvider({ run: fake.run })
    expect(await provider.permission({ repo: "group/sub/project", login: "dev" })).toBe("write")
    expect(await provider.permission({ repo: "group/sub/project", login: "ghost" })).toBe("none")
    expect(await provider.permission({ repo: "group/sub/project", login: "outsider" })).toBe("none")
    expect(await createGitlabProvider({ run: async () => ({ code: 1, out: "", err: "glab: 500" }) }).permission({ repo: "g/p", login: "x" })).toBe("unknown")
  })

  test("resolve PUTs resolved=true on a discussion and refuses an id that is not one", async () => {
    const fake = fakeGlab((endpoint, method) => method === "PUT" ? ok({ id: "6a9c", notes: [] }) : undefined)
    const provider = createGitlabProvider({ run: fake.run })
    expect(await provider.resolve({ repo: "group/sub/project", number: 5, discussion: "6a9c1750b37d513a43987b574953fceb50b03ce7" })).toBe(true)
    expect(fake.calls[0]!.argv[1]).toBe(`${PROJECT}/merge_requests/5/discussions/6a9c1750b37d513a43987b574953fceb50b03ce7?resolved=true`)
    await expect(provider.resolve({ repo: "g/p", number: 5, discussion: "../../x" })).rejects.toThrow(TypeError)
  })

  test("repoOf reads the origin remote and keeps subgroups", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendcode-gitlab-")))
    temps.push(dir)
    const git = async (args: string[], cwd: string) => ({ code: args.join(" ") === "remote get-url origin" && cwd === dir ? 0 : 1, out: "git@gitlab.com:group/sub/project.git\n" })
    expect(await createGitlabProvider({ run: fakeGlab(() => undefined).run, git }).repoOf(dir)).toBe("group/sub/project")
    await expect(createGitlabProvider({ run: fakeGlab(() => undefined).run, git: async () => ({ code: 0, out: "https://gitlab.com/solo\n" }) }).repoOf(dir)).rejects.toThrow("[PR_REVIEW]")
  })
})
