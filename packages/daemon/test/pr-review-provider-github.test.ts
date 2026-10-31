import { describe, expect, test } from "bun:test"
import type { CommandRun } from "../src/pr-review/contracts"
import type { GhCall } from "../src/pr-review/publish"
import { createGithubProvider, factsOf, GithubPull, providerPermission, splitInclude } from "../src/pr-review/providers/github"
import type { GhRun } from "../src/pr-watch"

/**
 * Fixtures shaped like GitHub's REST answers (`GET /repos/{owner}/{repo}/pulls`, `/pulls/{n}`, `/pulls/{n}/files`,
 * `/pulls/{n}/reviews`, `/collaborators/{login}/permission`), with extra fields the adapter must ignore. Contract evidence only:
 * nothing here talks to GitHub.
 */
const sha = (char: string) => char.repeat(40)
const repoJson = (full_name: string) => ({ id: 1, node_id: "R_1", name: full_name.split("/")[1], full_name, private: false, owner: { login: full_name.split("/")[0], type: "Organization" }, fork: full_name !== "acme/app" })
const user = (login: string, type = "User") => ({ login, id: 100, node_id: "U_1", avatar_url: "https://avatars.githubusercontent.com/u/100", type, site_admin: false })
function pull(number: number, extra: Record<string, unknown> = {}) {
  return {
    url: `https://api.github.com/repos/acme/app/pulls/${number}`, id: 9000 + number, node_id: `PR_${number}`, html_url: `https://github.com/acme/app/pull/${number}`,
    number, state: "open", locked: false, title: `Change ${number}`, user: user("ana"), body: "Fixes #3", created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-29T10:00:00Z",
    closed_at: null, merged_at: null, merge_commit_sha: null, assignee: null, assignees: [], requested_reviewers: [], requested_teams: [{ name: "Backend", slug: "backend" }],
    labels: [{ id: 1, node_id: "L_1", name: "bug", color: "d73a4a", default: true, description: "Something isn't working" }], milestone: null, draft: false,
    head: { label: "acme:feature", ref: "feature", sha: sha("a"), user: user("acme", "Organization"), repo: repoJson("acme/app") },
    base: { label: "acme:main", ref: "main", sha: sha("b"), user: user("acme", "Organization"), repo: repoJson("acme/app") },
    author_association: "MEMBER", auto_merge: null, active_lock_reason: null, maintainer_can_modify: false,
    ...extra,
  }
}

type Route = (argv: string[], stdin: unknown) => { code: number; out: string; err?: string } | undefined
function fakeGh(route: Route) {
  const calls: Array<{ argv: string[]; stdin: unknown }> = []
  const call: GhCall = async ({ argv, stdin }) => {
    const body = stdin ? JSON.parse(stdin) : undefined
    calls.push({ argv, stdin: body })
    return route(argv, body) ?? { code: 1, out: "", err: "gh: Not Found (HTTP 404)" }
  }
  const run: GhRun = async ({ argv }) => argv[0] === "repo" ? { code: 0, out: "acme/app\n", err: "" } : { code: 1, out: "", err: "unexpected" }
  return { call, run, calls }
}
const LIST = "repos/acme/app/pulls?state=open&sort=updated&direction=desc&per_page=100"
const withHeaders = (body: unknown, status = "200 OK", etag = 'W/"abc123"') => `HTTP/2.0 ${status}\nContent-Type: application/json; charset=utf-8\nEtag: ${etag}\nX-Ratelimit-Remaining: 4999\n\n${JSON.stringify(body)}`

describe("the GitHub provider: listing", () => {
  test("maps GitHub's pull objects to facts: labels, author type Bot, fork by head repository, maintainer edits, requested reviewers, assignees, draft, refs and shas", async () => {
    const own = pull(1, { requested_reviewers: [user("Obed")], assignees: [user("bob")], labels: [{ id: 2, name: "ai-review" }, { id: 3, name: "backend" }] })
    const fork = pull(2, { user: user("dependabot[bot]", "Bot"), draft: true, maintainer_can_modify: true, head: { label: "ext:fix", ref: "fix", sha: sha("c"), user: user("ext"), repo: repoJson("ext/app") } })
    const gone = pull(3, { user: null, head: { label: "unknown:x", ref: "x", sha: sha("d"), repo: null } })
    const fake = fakeGh((argv) => argv[1] === LIST ? { code: 0, out: withHeaders([own, fork, gone]) } : undefined)
    const provider = createGithubProvider({ run: fake.run, call: fake.call })
    const listed = await provider.listOpen({ directory: "/w", repo: "acme/app" })
    if (!listed.ok) throw new Error(listed.reason)
    expect(listed.etag).toBe('W/"abc123"')
    expect(listed.prs[0]).toEqual({
      number: 1, title: "Change 1", head: sha("a"), base: sha("b"), baseRef: "main", headRef: "feature", draft: false, labels: ["ai-review", "backend"],
      author: "ana", authorIsBot: false, fork: false, maintainerCanModify: false, requested: ["Obed"], assignees: ["bob"],
      url: "https://github.com/acme/app/pull/1", updatedAt: "2026-10-29T10:00:00Z",
    })
    expect(listed.prs[1]).toMatchObject({ number: 2, author: "dependabot[bot]", authorIsBot: true, fork: true, maintainerCanModify: true, draft: true, headRef: "fix", head: sha("c") })
    // A deleted fork and a deleted account: still a fork, author "ghost".
    expect(listed.prs[2]).toMatchObject({ number: 3, author: "ghost", authorIsBot: false, fork: true })
    expect(fake.calls[0]!.argv).toEqual(["api", LIST, "--include"])
  })

  test("reads every page while pages come back full, and a page that fails makes the whole list unreadable", async () => {
    const page = (from: number, count: number) => Array.from({ length: count }, (_, index) => pull(from + index))
    const pages: Record<string, string> = { [LIST]: withHeaders(page(1, 100)), [`${LIST}&page=2`]: JSON.stringify(page(101, 100)), [`${LIST}&page=3`]: JSON.stringify(page(201, 7)) }
    const fake = fakeGh((argv) => argv[1]! in pages ? { code: 0, out: pages[argv[1]!]! } : undefined)
    const provider = createGithubProvider({ run: fake.run, call: fake.call })
    const listed = await provider.listOpen({ directory: "/w", repo: "acme/app" })
    expect(listed.ok && listed.prs.length).toBe(207)
    expect(fake.calls.map((call) => call.argv[1])).toEqual([LIST, `${LIST}&page=2`, `${LIST}&page=3`])
    delete pages[`${LIST}&page=3`]
    const broken = await provider.listOpen({ directory: "/w", repo: "acme/app" })
    expect(broken).toEqual({ ok: false, auth: false, reason: "gh could not read page 3 of the open pull requests" })
  })

  test("an etag makes the first page conditional: 304 is notModified with no pull requests, 200 is a new list and etag", async () => {
    let changed = false
    const fake = fakeGh((argv) => {
      if (argv[1] !== LIST) return undefined
      const conditional = argv.includes("If-None-Match: W/\"abc123\"")
      // gh prints the headers of a 304 and exits 1 with "HTTP 304".
      if (conditional && !changed) return { code: 1, out: 'HTTP/2.0 304 Not Modified\nEtag: W/"abc123"\n', err: "gh: HTTP 304" }
      return { code: 0, out: withHeaders([pull(1)], "200 OK", 'W/"def456"') }
    })
    const provider = createGithubProvider({ run: fake.run, call: fake.call })
    expect(await provider.listOpen({ directory: "/w", repo: "acme/app", etag: 'W/"abc123"' })).toEqual({ ok: true, prs: [], etag: 'W/"abc123"', notModified: true })
    expect(fake.calls[0]!.argv).toEqual(["api", LIST, "--include", "-H", 'If-None-Match: W/"abc123"'])
    changed = true
    const fresh = await provider.listOpen({ directory: "/w", repo: "acme/app", etag: 'W/"abc123"' })
    expect(fresh).toMatchObject({ ok: true, etag: 'W/"def456"' })
    expect(fresh.ok && fresh.notModified).toBeFalsy()
    // An etag that is not one (a header injection attempt) is not sent.
    await provider.listOpen({ directory: "/w", repo: "acme/app", etag: 'W/"x"\nAuthorization: token' })
    expect(fake.calls.at(-1)!.argv).toEqual(["api", LIST, "--include"])
  })

  test("a logged-out or missing gh is an auth failure; another error is not; an invalid repository calls nothing", async () => {
    const answers = [
      { code: 1, out: "", err: "gh: Bad credentials (HTTP 401)" },
      { code: 4, out: "", err: "To get started with GitHub CLI, please run:  gh auth login" },
      { code: 127, out: "", err: "Executable not found in $PATH: \"gh\"" },
    ]
    for (const answer of answers) {
      const fake = fakeGh(() => answer)
      expect(await createGithubProvider({ run: fake.run, call: fake.call }).listOpen({ directory: "/w", repo: "acme/app" })).toMatchObject({ ok: false, auth: true })
    }
    const fake = fakeGh(() => ({ code: 1, out: "", err: "gh: Server Error (HTTP 500)" }))
    const provider = createGithubProvider({ run: fake.run, call: fake.call })
    expect(await provider.listOpen({ directory: "/w", repo: "acme/app" })).toEqual({ ok: false, auth: false, reason: "gh: Server Error (HTTP 500)" })
    expect(await provider.listOpen({ directory: "/w", repo: "../etc/passwd" })).toMatchObject({ ok: false, auth: false })
    expect(fake.calls).toHaveLength(1)
  })
})

describe("the GitHub provider: one pull request", () => {
  test("view reads the pull request and every page of its files; headRef is refs/pull/N/head; repoOf asks gh in the checkout", async () => {
    const files = Array.from({ length: 100 }, (_, index) => ({ sha: sha("e"), filename: `src/f${index}.ts`, status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@ -1 +1 @@" }))
    const fake = fakeGh((argv) => {
      if (argv[1] === "repos/acme/app/pulls/5") return { code: 0, out: JSON.stringify(pull(5, { draft: true })) }
      if (argv[1] === "repos/acme/app/pulls/5/files?per_page=100") return { code: 0, out: JSON.stringify(files) }
      if (argv[1] === "repos/acme/app/pulls/5/files?per_page=100&page=2") return { code: 0, out: JSON.stringify([{ filename: "docs/readme.md", status: "added" }]) }
      return undefined
    })
    const provider = createGithubProvider({ run: fake.run, call: fake.call })
    const facts = await provider.view({ directory: "/w", repo: "acme/app", number: 5 })
    expect(facts).toMatchObject({ number: 5, draft: true, baseRef: "main" })
    expect(facts.files).toHaveLength(101)
    expect(facts.files?.at(-1)).toBe("docs/readme.md")
    expect(provider.headRef(5)).toBe("refs/pull/5/head")
    expect(await provider.repoOf("/w")).toBe("acme/app")
    await expect(provider.view({ directory: "/w", repo: "acme/app", number: 6 })).rejects.toThrow("[PR_REVIEW]: gh could not read acme/app#6")
  })

  test("findMarker finds a review carrying the marker, says absent when none does, and throws when the reviews cannot be read", async () => {
    let readable = true
    const reviews = [{ id: 41, body: "hand-written", state: "COMMENTED", user: user("bob") }, { id: 42, body: "## MendCode review\n<!-- mendcode:reviewer=global config=x effect=0123456789abcdef -->", state: "COMMENTED", user: user("mendcode") }]
    const fake = fakeGh((argv) => argv[1] === "repos/acme/app/pulls/9/reviews?per_page=100" ? (readable ? { code: 0, out: JSON.stringify(reviews) } : { code: 1, out: "", err: "HTTP 502" }) : undefined)
    const provider = createGithubProvider({ run: fake.run, call: fake.call })
    expect(await provider.findMarker({ repo: "acme/app", number: 9, marker: "effect=0123456789abcdef" })).toEqual({ found: true, remote: "42" })
    expect(await provider.findMarker({ repo: "acme/app", number: 9, marker: "effect=ffffffffffffffff" })).toEqual({ found: false })
    readable = false
    await expect(provider.findMarker({ repo: "acme/app", number: 9, marker: "effect=0123456789abcdef" })).rejects.toThrow("[PR_REVIEW]: gh could not read the reviews")
  })
})

describe("the GitHub provider: publishing", () => {
  const MARKER = "<!-- mendcode:reviewer=global config=base@1 effect=00000000000000aa -->"
  function remote() {
    const posted: Array<{ id: number; body: string; state: string; user: unknown }> = []
    let mode: "ok" | "timeout-after" | "422-first" = "ok"
    let attempts = 0
    const fake = fakeGh((argv, stdin: any) => {
      if (argv[1] === "repos/acme/app/pulls/4/reviews" && argv.includes("POST")) {
        attempts++
        if (mode === "422-first" && attempts === 1) return { code: 1, out: "", err: "gh: Validation Failed (HTTP 422)" }
        posted.push({ id: 300 + posted.length, body: stdin.body, state: "COMMENTED", user: user("mendcode") })
        return mode === "timeout-after" ? { code: 143, out: "", err: "" } : { code: 0, out: JSON.stringify({ id: posted.at(-1)!.id, state: "COMMENTED" }) }
      }
      if (argv[1] === "repos/acme/app/pulls/4/reviews?per_page=100") return { code: 0, out: JSON.stringify(posted) }
      if (argv[1] === "repos/acme/app/pulls/4/files?per_page=100") return { code: 0, out: JSON.stringify([{ filename: "src/a.ts", patch: "@@ -1,2 +1,3 @@\n a\n+b\n c" }]) }
      return undefined
    })
    return { fake, posted, setMode: (next: typeof mode) => { mode = next } }
  }
  const input = (comments = [{ path: "src/a.ts", line: 2, body: "inline <!-- mendcode:f=1 -->" }]) => ({ repo: "acme/app", number: 4, head: sha("a"), body: `## MendCode review\n\nSummary.\n\n${MARKER}`, comments, marker: MARKER })

  test("posts one COMMENT review at the head, then a second publish of the same marker posts nothing", async () => {
    const { fake, posted } = remote()
    const provider = createGithubProvider({ run: fake.run, call: fake.call })
    expect(await provider.publish(input())).toEqual({ ok: true, remote: "300", comments: 1, movedToBody: 0 })
    const post = fake.calls.find((call) => call.argv.includes("POST"))!
    expect(post.argv).toEqual(["api", "repos/acme/app/pulls/4/reviews", "--method", "POST", "--input", "-"])
    expect(post.stdin).toMatchObject({ commit_id: sha("a"), event: "COMMENT", comments: [{ path: "src/a.ts", side: "RIGHT", line: 2 }] })
    expect(await provider.publish(input())).toEqual({ ok: true, remote: "300", comments: 0, movedToBody: 0 })
    expect(posted).toHaveLength(1)
  })

  test("a timeout after GitHub applied it is reconciled by the marker: ok, one review", async () => {
    const { fake, posted, setMode } = remote()
    setMode("timeout-after")
    const provider = createGithubProvider({ run: fake.run, call: fake.call })
    expect(await provider.publish(input())).toMatchObject({ ok: true, remote: "300" })
    expect(posted).toHaveLength(1)
  })

  test("a comment off GitHub's diff moves into the body after a 422 and the review is sent once more", async () => {
    const { fake, posted, setMode } = remote()
    setMode("422-first")
    const provider = createGithubProvider({ run: fake.run, call: fake.call })
    const done = await provider.publish(input([{ path: "src/a.ts", line: 2, body: "on the diff" }, { path: "src/a.ts", line: 40, body: "off the diff" }]))
    expect(done).toEqual({ ok: true, remote: "300", comments: 1, movedToBody: 1 })
    expect(posted[0]!.body).toContain("Not on a line GitHub shows in this diff (1)")
    expect(posted[0]!.body).toContain("off the diff")
    expect(posted[0]!.body).toContain(MARKER)
  })

  test("a refusal is not retryable, a rate limit is; a review without a marker is refused before any call", async () => {
    const fake = fakeGh((argv) => argv.includes("POST") ? { code: 1, out: "", err: "gh: Resource not accessible by integration (HTTP 403)" } : argv[1]!.includes("/reviews?") ? { code: 0, out: "[]" } : undefined)
    const provider = createGithubProvider({ run: fake.run, call: fake.call })
    expect(await provider.publish(input())).toMatchObject({ ok: false, retryable: false })
    const limited = fakeGh((argv) => argv.includes("POST") ? { code: 1, out: "", err: "gh: API rate limit exceeded for user (HTTP 403)" } : argv[1]!.includes("/reviews?") ? { code: 0, out: "[]" } : undefined)
    expect(await createGithubProvider({ run: limited.run, call: limited.call }).publish(input())).toMatchObject({ ok: false, retryable: true })
    const none = fakeGh(() => undefined)
    expect(await createGithubProvider({ run: none.run, call: none.call }).publish({ ...input(), marker: " " })).toMatchObject({ ok: false, retryable: false })
    expect(none.calls).toHaveLength(0)
  })
})

describe("the GitHub provider: identity and permission", () => {
  test("capabilities are GitHub's full set, verified by contract only; kind is github", () => {
    const fake = fakeGh(() => undefined)
    const provider = createGithubProvider({ run: fake.run, call: fake.call })
    expect(provider.kind).toBe("github")
    expect(provider.capabilities).toEqual({ inlineComments: true, suggestions: true, resolveThreads: true, reviewEvents: true, requestedReviewers: true, labels: true, draft: true, forkPush: true, conditionalRequests: true, verified: "contract" })
  })

  test("permission revalidates on every call and maps maintain to write, triage to read, an error to unknown", async () => {
    let role = "maintain"
    const fake = fakeGh((argv) => argv[1] === "repos/acme/app/collaborators/ana/permission" ? { code: 0, out: JSON.stringify({ permission: role === "maintain" ? "write" : "read", role_name: role, user: user("ana") }) } : undefined)
    const provider = createGithubProvider({ run: fake.run, call: fake.call })
    expect(await provider.permission({ repo: "acme/app", login: "ana" })).toBe("write")
    role = "triage"
    expect(await provider.permission({ repo: "acme/app", login: "ana" })).toBe("read")
    expect(await provider.permission({ repo: "acme/app", login: "bob" })).toBe("unknown")
    expect(providerPermission("admin")).toBe("admin")
    expect(providerPermission("none")).toBe("none")
  })

  test("a single CommandRun serves as both runner and api call (stdin carried), as the provider registry builds it", async () => {
    const seen: Array<{ argv: string[]; stdin?: string | undefined; cwd?: string | undefined }> = []
    const run: CommandRun = async (input) => { seen.push(input); return input.argv[0] === "repo" ? { code: 0, out: "acme/app", err: "" } : { code: 0, out: "[]", err: "" } }
    const provider = createGithubProvider({ run })
    expect(await provider.repoOf("/w")).toBe("acme/app")
    expect(seen[0]).toMatchObject({ cwd: "/w" })
    const marker = "<!-- mendcode:reviewer=global config=x effect=00000000000000bb -->"
    await provider.publish({ repo: "acme/app", number: 4, head: sha("a"), body: `Summary.\n\n${marker}`, comments: [], marker })
    expect(seen.find((call) => call.argv.includes("POST"))?.stdin).toContain("\"event\":\"COMMENT\"")
  })
})

describe("GitHub shapes", () => {
  test("splitInclude reads the status, the headers and the body of gh api --include; plain output is all body", () => {
    const split = splitInclude('HTTP/2.0 200 OK\r\nEtag: W/"1"\r\nLink: <https://api.github.com/x?page=2>; rel="next"\r\n\r\n[1]')
    expect(split.status).toBe(200)
    expect(split.headers.get("etag")).toBe('W/"1"')
    expect(split.body).toBe("[1]")
    expect(splitInclude("[2]")).toEqual({ headers: new Map(), body: "[2]" })
  })

  test("a pull with a missing sha or a non-numeric number is not a pull; factsOf keeps no fields GitHub did not send", () => {
    expect(GithubPull.safeParse({ ...pull(1), head: { ref: "x", sha: "not-a-sha" } }).success).toBe(false)
    expect(GithubPull.safeParse({ ...pull(1), number: "1" }).success).toBe(false)
    const minimal = GithubPull.parse({ number: 8, head: { ref: "h", sha: sha("1") }, base: { ref: "main", sha: sha("2") } })
    expect(factsOf(minimal)).toEqual({ number: 8, head: sha("1"), base: sha("2"), baseRef: "main", headRef: "h", draft: false, labels: [], author: "ghost", authorIsBot: false, fork: true, requested: [], assignees: [] })
  })
})
