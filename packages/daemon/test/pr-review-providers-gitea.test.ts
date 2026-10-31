import { describe, expect, test } from "bun:test"
import { createGiteaProvider, GiteaPullRequest, giteaFacts, giteaIsBot, giteaPermission, tokenFromEnv } from "../src/pr-review/providers/gitea"
import { PROVIDER_CAPABILITIES } from "../src/pr-review/providers/index"

/**
 * The Gitea/Forgejo adapter over `/api/v1` (docs/pr-review.md, providers). Fixtures follow the swagger of Gitea 1.27
 * (https://github.com/go-gitea/gitea/blob/release/v1.27/templates/swagger/v1_json.tmpl: `PullRequest`, `PRBranchInfo`,
 * `CreatePullReviewOptions`, `RepoCollaboratorPermission`) and the pagination headers of https://docs.gitea.com/development/api-usage.
 * Contract evidence only: `fetch` is a local fake, nothing reaches a Gitea instance.
 */

const HEAD = "a".repeat(40), BASE = "b".repeat(40)
const MARKER = "<!-- mendcode:review head=aaaaaaa -->"
const ORIGIN = "https://gitea.example.com:3000"

const pull = (number: number, extra: Record<string, unknown> = {}) => ({
  id: 9000 + number, number, title: `PR ${number}`, state: "open", draft: false, user: { id: 1, login: "alice" },
  labels: [{ id: 1, name: "bug", color: "ee0701" }], head: { label: `feat-${number}`, ref: `feat-${number}`, sha: HEAD, repo_id: 10 },
  base: { label: "main", ref: "main", sha: BASE, repo_id: 10 }, allow_maintainer_edit: false, requested_reviewers: [{ id: 2, login: "bob" }],
  assignees: [{ id: 3, login: "carol" }], html_url: `${ORIGIN}/owner/repo/pulls/${number}`, updated_at: "2026-10-29T10:00:00Z", ...extra,
})

type Request = { url: string; method: string; body: any; headers: Record<string, string> }
/** A fake `fetch`: answers by method and path below `/api/v1/`, records every request with its parsed body. */
function fakeFetch(answer: (path: string, method: string, body: any) => { status?: number; body?: unknown; text?: string; headers?: Record<string, string> } | undefined) {
  const requests: Request[] = []
  const fetcher = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    requests.push({ url, method, body, headers: { ...(init?.headers as Record<string, string>) } })
    const given = answer(url.slice(`${ORIGIN}/api/v1/`.length), method, body) ?? { status: 404, body: { message: "not found" } }
    return new Response(given.text ?? JSON.stringify(given.body ?? null), { status: given.status ?? 200, headers: given.headers ?? {} })
  }) as unknown as typeof fetch
  return { fetcher, requests }
}
/** `token: null` is an instance without a token in the environment. */
const provider = (fake: ReturnType<typeof fakeFetch>, token: string | null = "t0ken") => createGiteaProvider({ baseUrl: `${ORIGIN}/`, fetch: fake.fetcher, token: () => token ?? undefined })

describe("Gitea pull request facts", () => {
  test("maps draft, labels, author, branches, shas, reviewers, assignees and maintainer edit", () => {
    expect(giteaFacts(GiteaPullRequest.parse(pull(4, { allow_maintainer_edit: true })))).toEqual({
      number: 4, title: "PR 4", head: HEAD, base: BASE, baseRef: "main", headRef: "feat-4", draft: false, labels: ["bug"], author: "alice",
      authorIsBot: false, fork: false, maintainerCanModify: true, requested: ["bob"], assignees: ["carol"], url: `${ORIGIN}/owner/repo/pulls/4`, updatedAt: "2026-10-29T10:00:00Z", open: true,
    })
  })

  test("a head in another repository is a fork; a WIP title is a draft where the flag is missing; null lists are empty", () => {
    const facts = giteaFacts(GiteaPullRequest.parse(pull(5, { draft: undefined, title: "WIP: try it", head: { ref: "x", sha: HEAD, repo_id: 99 }, labels: null, requested_reviewers: null, assignees: null })))
    expect(facts).toMatchObject({ fork: true, draft: true, labels: [], requested: [], assignees: [] })
  })

  test("bots are named by login (no bot flag in Gitea's user)", () => {
    expect(["renovate", "dependabot[bot]", "gitea-actions", "release-bot"].map(giteaIsBot)).toEqual([true, true, true, true])
    expect(giteaIsBot("robert")).toBe(false)
  })

  test("collaborator permission names map onto the platform's levels", () => {
    expect(["owner", "admin", "write", "read", "none", "weird"].map(giteaPermission)).toEqual(["admin", "admin", "write", "read", "none", "unknown"])
  })

  test("the token comes only from the named environment variable", () => {
    expect(tokenFromEnv("GITEA_TOKEN", { GITEA_TOKEN: " abc " })()).toBe("abc")
    expect(tokenFromEnv("GITEA_TOKEN", { OTHER: "x" })()).toBeUndefined()
  })
})

describe("Gitea adapter over /api/v1", () => {
  test("listOpen follows Link rel=next pages and sends the token header", async () => {
    const fake = fakeFetch((path) => {
      if (!path.startsWith("repos/owner/repo/pulls?")) return undefined
      if (path.endsWith("page=1")) return { body: [pull(1), pull(2)], headers: { link: `<https://other-root.example/api/v1/repos/owner/repo/pulls?state=open&limit=2&page=2>; rel="next", <https://other-root.example/api/v1/repos/owner/repo/pulls?page=2>; rel="last"`, "x-total-count": "3" } }
      return { body: [pull(3, { user: { login: "renovate" } })], headers: { link: `<https://other-root.example/api/v1/repos/owner/repo/pulls?page=1>; rel="first"`, "x-total-count": "3" } }
    })
    const found = await provider(fake).listOpen({ directory: "/c", repo: "owner/repo" })
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.prs.map((pr) => pr.number)).toEqual([1, 2, 3])
    expect(found.prs[2]!.authorIsBot).toBe(true)
    expect(fake.requests.map((request) => request.url)).toEqual([
      `${ORIGIN}/api/v1/repos/owner/repo/pulls?state=open&sort=recentupdate&limit=50&page=1`,
      `${ORIGIN}/api/v1/repos/owner/repo/pulls?state=open&sort=recentupdate&limit=50&page=2`,
    ])
    expect(fake.requests[0]!.headers.authorization).toBe("token t0ken")
  })

  test("without a Link header, X-Total-Count decides whether a short page is the last", async () => {
    const fake = fakeFetch((path) => path.endsWith("page=1") ? { body: [pull(1)], headers: { "x-total-count": "2" } } : path.endsWith("page=2") ? { body: [pull(2)], headers: { "x-total-count": "2" } } : undefined)
    const found = await provider(fake).listOpen({ directory: "/c", repo: "owner/repo" })
    expect(found.ok && found.prs.length).toBe(2)
  })

  test("a 401 is an auth failure; a 404 without a token says the token is missing; no token header is sent then", async () => {
    expect(await provider(fakeFetch(() => ({ status: 401, body: { message: "token is required" } }))).listOpen({ directory: "/c", repo: "owner/repo" })).toMatchObject({ ok: false, auth: true })
    const anonymous = fakeFetch(() => undefined)
    const found = await provider(anonymous, null).listOpen({ directory: "/c", repo: "owner/repo" })
    expect(found).toMatchObject({ ok: false, auth: true, reason: expect.stringContaining("no Gitea token") })
    expect(anonymous.requests[0]!.headers.authorization).toBeUndefined()
  })

  test("headRef is refs/pull/N/head and the capabilities are the matrix's (no resolve, no suggestions)", () => {
    const gitea = provider(fakeFetch(() => undefined))
    expect(gitea.headRef(8)).toBe("refs/pull/8/head")
    expect(gitea.capabilities).toBe(PROVIDER_CAPABILITIES.gitea)
    expect(gitea.capabilities.resolveThreads).toBe(false)
  })

  const publishFake = (options: { reviews?: unknown[]; refuse?: boolean; diff?: string } = {}) => {
    let posts = 0
    return fakeFetch((path, method, body) => {
      if (path === "repos/owner/repo/pulls/6" && method === "GET") return { body: pull(6) }
      if (path.startsWith("repos/owner/repo/pulls/6/reviews?")) return { body: options.reviews ?? [] }
      if (path === "repos/owner/repo/pulls/6.diff") return { text: options.diff ?? "" }
      if (path === "repos/owner/repo/pulls/6/reviews" && method === "POST") {
        posts++
        return options.refuse && posts === 1 ? { status: 422, body: { message: "validation failed" } } : { body: { id: 55, body: body.body, state: "COMMENT", commit_id: body.commit_id } }
      }
      return undefined
    })
  }
  const input = (comments: Array<{ path: string; line: number; endLine?: number; body: string }>) => ({ repo: "owner/repo", number: 6, head: HEAD, body: "Summary.", comments, marker: MARKER })

  const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,4 @@\n line1\n+line2\n+line3\n line4\n"
    + "diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -3,1 +3,4 @@\n keep\n+four\n+five\n+six\n"

  test("publish sends one COMMENT review on the reviewed head with one-line inline comments and the marker", async () => {
    const fake = publishFake({ diff: DIFF })
    const done = await provider(fake).publish(input([{ path: "src/a.ts", line: 3, body: "One." }, { path: "src/b.ts", line: 4, endLine: 6, body: "Range." }]))
    expect(done).toEqual({ ok: true, remote: "review:55", comments: 2, movedToBody: 0 })
    const post = fake.requests.find((request) => request.method === "POST")!
    expect(post.body).toEqual({ body: `Summary.\n\n${MARKER}`, commit_id: HEAD, event: "COMMENT", comments: [{ path: "src/a.ts", body: "One.", new_position: 3 }, { path: "src/b.ts", body: "Range.", new_position: 6 }] })
  })

  test("a comment outside the PR's own diff moves into the body before posting (Gitea 28 accepts it on no line)", async () => {
    const fake = publishFake({ diff: DIFF })
    const done = await provider(fake).publish(input([{ path: "src/a.ts", line: 3, body: "In the diff." }, { path: "src/z.ts", line: 40, body: "Not in it." }, { path: "src/a.ts", line: 9999, body: "Past the end." }]))
    expect(done).toEqual({ ok: true, remote: "review:55", comments: 1, movedToBody: 2 })
    const posts = fake.requests.filter((request) => request.method === "POST")
    expect(posts.length).toBe(1)
    expect(posts[0]!.body.comments).toEqual([{ path: "src/a.ts", body: "In the diff.", new_position: 3 }])
    expect(posts[0]!.body.body).toContain("Comments Gitea could not place on the diff")
    expect(posts[0]!.body.body).toContain("`src/z.ts` line 40")
    expect(posts[0]!.body.body).toContain("`src/a.ts` line 9999")
  })

  test("a 422 on comments the diff says fit moves them all into the body and sends once more", async () => {
    const fake = publishFake({ refuse: true, diff: DIFF })
    const done = await provider(fake).publish(input([{ path: "src/a.ts", line: 3, body: "In the diff." }]))
    expect(done).toEqual({ ok: true, remote: "review:55", comments: 0, movedToBody: 1 })
    const posts = fake.requests.filter((request) => request.method === "POST")
    expect(posts.length).toBe(2)
    expect(posts[1]!.body.comments).toEqual([])
    expect(posts[1]!.body.body).toContain("`src/a.ts` line 3")
  })

  test("an unreadable diff sends the comments as they are", async () => {
    const fake = fakeFetch((path, method, body) => path === "repos/owner/repo/pulls/6" ? { body: pull(6) } : path.startsWith("repos/owner/repo/pulls/6/reviews?") ? { body: [] } : path === "repos/owner/repo/pulls/6/reviews" && method === "POST" ? { body: { id: 56, body: body.body } } : undefined)
    expect(await provider(fake).publish(input([{ path: "src/q.ts", line: 7, body: "x" }]))).toEqual({ ok: true, remote: "review:56", comments: 1, movedToBody: 0 })
  })

  test("a review already carrying the marker is found and nothing is posted (reconciliation after a timeout)", async () => {
    const fake = publishFake({ reviews: [{ id: 40, body: "chatter" }, { id: 41, body: `Summary.\n\n${MARKER}` }] })
    expect(await provider(fake).publish(input([{ path: "src/a.ts", line: 3, body: "x" }]))).toMatchObject({ ok: true, remote: "review:41" })
    expect(fake.requests.some((request) => request.method === "POST")).toBe(false)
    expect(await provider(fake).findMarker({ repo: "owner/repo", number: 6, marker: MARKER })).toEqual({ found: true, remote: "review:41" })
    expect(await provider(fake).findMarker({ repo: "owner/repo", number: 6, marker: "<!-- none -->" })).toEqual({ found: false })
  })

  test("without a token, or with a moved head, nothing is posted", async () => {
    const none = publishFake()
    expect(await provider(none, null).publish(input([]))).toMatchObject({ ok: false, retryable: false, reason: expect.stringContaining("no Gitea token") })
    expect(none.requests.length).toBe(0)
    const moved = publishFake()
    expect(await provider(moved).publish({ ...input([]), head: "c".repeat(40) })).toMatchObject({ ok: false, retryable: false, reason: expect.stringContaining("moved") })
    expect(moved.requests.some((request) => request.method === "POST")).toBe(false)
  })

  test("a server error on the review is retryable and posts nothing else", async () => {
    const fake = fakeFetch((path, method) => path === "repos/owner/repo/pulls/6" ? { body: pull(6) } : path.startsWith("repos/owner/repo/pulls/6/reviews?") ? { body: [] } : method === "POST" ? { status: 503, body: { message: "busy" } } : undefined)
    expect(await provider(fake).publish(input([{ path: "src/a.ts", line: 3, body: "x" }]))).toMatchObject({ ok: false, retryable: true, reason: expect.stringContaining("HTTP 503") })
  })

  test("permission maps the collaborator answer; 404 is none, other failures unknown", async () => {
    const fake = fakeFetch((path) => path === "repos/owner/repo/collaborators/dev/permission" ? { body: { permission: "write", role_name: "write", user: { login: "dev" } } } : path === "repos/owner/repo/collaborators/boss/permission" ? { body: { permission: "owner" } } : path.includes("/flaky/") ? { status: 500 } : undefined)
    const gitea = provider(fake)
    expect(await gitea.permission({ repo: "owner/repo", login: "dev" })).toBe("write")
    expect(await gitea.permission({ repo: "owner/repo", login: "boss" })).toBe("admin")
    expect(await gitea.permission({ repo: "owner/repo", login: "nobody" })).toBe("none")
    expect(await gitea.permission({ repo: "owner/repo", login: "flaky" })).toBe("unknown")
  })

  test("a repository that is not owner/repo and a base URL that is not http(s) are refused", async () => {
    await expect(provider(fakeFetch(() => undefined)).view({ directory: "/c", repo: "a/b/c", number: 1 })).rejects.toThrow(TypeError)
    expect(() => createGiteaProvider({ baseUrl: "codeberg.org" })).toThrow(TypeError)
  })
})
