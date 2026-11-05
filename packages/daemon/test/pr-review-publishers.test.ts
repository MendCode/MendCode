import { describe, expect, test } from "bun:test"
import { parsePrCommand, replyTo } from "../src/pr-review/commands"
import type { GhCall } from "../src/pr-review/publish"
import { answeredBy, answersMarker, answersRequest, headReviewedBy, mayPublish, reviewedBy } from "../src/pr-review/publishers"
import { reviewMarker } from "../src/pr-review/state"

const HEAD = "c".repeat(40)
/** GitHub answering one endpoint with `out`, and every other call with an error. */
const answering = (routes: Record<string, string>): GhCall => async ({ argv }) => argv[1]! in routes ? { code: 0, out: routes[argv[1]!]! } : { code: 1, out: "", err: "HTTP 403" }

describe("who may post", () => {
  test("maintainers (the default) needs this login's write access; a list names logins, contributors included; anyone lets everyone", async () => {
    const write = answering({ "repos/acme/app": "true" }), read = answering({ "repos/acme/app": "false" }), broken = answering({})
    expect(await mayPublish({ gh: write, repo: "acme/app", login: "ana", rule: "maintainers" })).toEqual({ ok: true })
    expect(await mayPublish({ gh: read, repo: "acme/app", login: "obed", rule: "maintainers" })).toEqual({ ok: false, reason: "@obed has no write access to acme/app, and its .mendcode/review.yaml does not list it in publishers" })
    expect(await mayPublish({ gh: broken, repo: "acme/app", login: "obed", rule: "maintainers" })).toMatchObject({ ok: false })
    expect(await mayPublish({ gh: broken, repo: "acme/app", login: "Obed", rule: ["obed", "ana"] })).toEqual({ ok: true })
    expect(await mayPublish({ gh: broken, repo: "acme/app", login: "mallory", rule: ["obed"] })).toEqual({ ok: false, reason: "@mallory is not in publishers of acme/app's .mendcode/review.yaml" })
    expect(await mayPublish({ gh: broken, repo: "acme/app", login: undefined, rule: "maintainers" })).toMatchObject({ ok: false })
    expect(await mayPublish({ gh: broken, repo: "acme/app", login: "anyone-at-all", rule: "anyone" })).toEqual({ ok: true })
  })

  test("a review of the same head by another publisher stands this one down; its own, an outsider's and another head's do not", async () => {
    const review = (login: string, association: string, head = HEAD, type = "User") => ({ body: `## MendCode review\n${reviewMarker(head)}`, user: { login, type }, author_association: association })
    const gh = (reviews: unknown[]) => answering({ "repos/acme/app/pulls/12/reviews?per_page=100": JSON.stringify(reviews) })
    const at = (reviews: unknown[], rule: Parameters<typeof reviewedBy>[0]["rule"] = "maintainers") => reviewedBy({ gh: gh(reviews), repo: "acme/app", number: 12, head: HEAD, rule, self: "ana" })
    expect(await at([review("bob", "MEMBER")])).toBe("bob")
    expect(await at([review("ana", "MEMBER")])).toBeUndefined()
    expect(await at([review("mallory", "NONE")])).toBeUndefined()
    expect(await at([review("mallory", "NONE")], ["mallory"])).toBe("mallory")
    expect(await at([review("bob", "MEMBER", "d".repeat(40))])).toBeUndefined()
    expect(await at([review("github-actions[bot]", "NONE", HEAD, "Bot")])).toBe("github-actions[bot]")
  })

  test("a submitted review of the head, MendCode's by this login or any by a publisher, answers @mendcode review; a hand-written note of this login, another head, a pending or dismissed review or an outsider's does not", async () => {
    // Seen live, #12: the user's own session posted review 9001 on head 6d33aa87 without MendCode's marker, with a MendCode summary.
    const review = (login: string, association: string, extra: Record<string, unknown> = {}) => ({ id: 9001, commit_id: HEAD, state: "COMMENTED", body: "## MendCode review\n\nReviewed in the user's own session.", user: { login, type: "User" }, author_association: association, ...extra })
    const at = (reviews: unknown[]) => headReviewedBy({ gh: answering({ "repos/acme/app/pulls/12/reviews?per_page=100": JSON.stringify(reviews) }), repo: "acme/app", number: 12, head: HEAD, rule: "maintainers", self: "Alice-Dev" })
    expect(await at([review("alice-dev", "NONE")])).toMatchObject({ login: "alice-dev", id: 9001, mine: true })
    expect(await at([review("bob", "MEMBER")])).toMatchObject({ login: "bob", id: 9001, mine: false })
    expect(await at([review("mallory", "NONE")])).toBeUndefined()
    // This login's own post counts only when it is a MendCode review: a note by hand or a thread reply under the login does not.
    expect(await at([review("alice-dev", "NONE", { body: "## Summary\nReviewed by hand." })])).toBeUndefined()
    expect(await at([review("alice-dev", "NONE", { body: "Fixed in 0384447e: the file is gone." })])).toBeUndefined()
    expect(await at([review("Alice-Dev", "NONE", { commit_id: "d".repeat(40) })])).toBeUndefined()
    expect(await at([review("Alice-Dev", "NONE", { state: "PENDING" })])).toBeUndefined()
    expect(await at([review("Alice-Dev", "NONE", { state: "DISMISSED" })])).toBeUndefined()
    // Unreadable reviews answer nothing: the command runs as before.
    expect(await headReviewedBy({ gh: answering({}), repo: "acme/app", number: 12, head: HEAD, rule: "maintainers", self: "Alice-Dev" })).toBeUndefined()
  })

  test("a review by this same login submitted at or after the comment answers it; one before it, or by someone else, does not", async () => {
    const review = (login: string, submitted_at: string) => ({ id: 9001, commit_id: HEAD, state: "COMMENTED", body: "## MendCode review", user: { login, type: "User" }, author_association: "MEMBER", submitted_at })
    const done = (reviews: unknown[]) => headReviewedBy({ gh: answering({ "repos/acme/app/pulls/12/reviews?per_page=100": JSON.stringify(reviews) }), repo: "acme/app", number: 12, head: HEAD, rule: "maintainers", self: "obed0101" })
    const asked = "2026-11-02T15:00:30Z"
    expect(answersRequest({ done: await done([review("Obed0101", "2026-11-02T15:00:50Z")]), asked })).toBe(true)
    expect(answersRequest({ done: await done([review("Obed0101", asked)]), asked })).toBe(true)
    expect(answersRequest({ done: await done([review("Obed0101", "2026-11-02T14:00:00Z")]), asked })).toBe(false)
    expect(answersRequest({ done: await done([review("bob", "2026-11-02T15:00:50Z")]), asked })).toBe(false)
    expect(answersRequest({ done: await done([review("Obed0101", "2026-11-02T15:00:50Z")]), asked: undefined })).toBe(false)
    expect(answersRequest({ done: undefined, asked })).toBe(false)
  })

  test("the empty COMMENTED reviews GitHub makes of thread replies are not a review of the head; an approval, a change request or a comment with a body is", async () => {
    // Seen live, NotchNull#23: a collaborator answered three threads with "Fixed in 3806381"; GitHub recorded three COMMENTED
    // reviews with no body on that head, and "@mendcode review" was told they had already reviewed it.
    const reply = { id: 7, commit_id: HEAD, state: "COMMENTED", body: "", user: { login: "alpha", type: "User" }, author_association: "COLLABORATOR" }
    const reviews = (extra: Array<Record<string, unknown>> = []) => JSON.stringify([reply, { ...reply, id: 8 }, ...extra.map((item) => ({ ...reply, ...item }))])
    const at = (body: string, self = "ana") => headReviewedBy({ gh: answering({ "repos/acme/app/pulls/23/reviews?per_page=100": body }), repo: "acme/app", number: 23, head: HEAD, rule: "maintainers", self })
    expect(await at(reviews())).toBeUndefined()
    expect(await at(reviews(), "alpha")).toBeUndefined()
    expect(await at(reviews([{ id: 9, state: "APPROVED" }]))).toMatchObject({ login: "alpha", id: 9 })
    expect(await at(reviews([{ id: 10, state: "CHANGES_REQUESTED" }]))).toMatchObject({ login: "alpha", id: 10 })
    expect(await at(reviews([{ id: 11, body: "Looks good to me." }]))).toMatchObject({ login: "alpha", id: 11 })
    // The owner's MendCode review of the head is named by its own login, not by the collaborator whose replies came first.
    expect(await at(reviews([{ id: 12, body: `## MendCode review\n${reviewMarker(HEAD)}`, user: { login: "obed", type: "User" }, author_association: "OWNER" }]))).toMatchObject({ login: "obed", id: 12 })
    // The same head decides the later publish: with only replies on it, nothing says it was reviewed, so the review runs.
    expect(await reviewedBy({ gh: answering({ "repos/acme/app/pulls/23/reviews?per_page=100": reviews() }), repo: "acme/app", number: 23, head: HEAD, rule: "maintainers", self: "ana" })).toBeUndefined()
  })

  test("a comment another publisher answered is not answered again; every reply carries the comment it answers", async () => {
    const replies = [{ body: `Paused.\n\n<!-- mendcode:reply -->${answersMarker(5)}`, user: { login: "bob" }, author_association: "COLLABORATOR" }]
    const gh = answering({ "repos/acme/app/issues/12/comments?per_page=100": JSON.stringify(replies), "repos/acme/app/pulls/12/comments?per_page=100": "[]" })
    expect(await answeredBy({ gh, repo: "acme/app", number: 12, commentId: 5, rule: "maintainers", self: "ana" })).toBe("bob")
    expect(await answeredBy({ gh, repo: "acme/app", number: 12, commentId: 6, rule: "maintainers", self: "ana" })).toBeUndefined()
    // Its own earlier reply (before a restart) counts too, so a command is never answered twice.
    expect(await answeredBy({ gh, repo: "acme/app", number: 12, commentId: 5, rule: "maintainers", self: "bob" })).toBe("bob")
    const posted: string[] = []
    await replyTo({ gh: async ({ stdin }) => { posted.push(JSON.parse(stdin!).body); return { code: 0, out: "{}" } }, repo: "acme/app", number: 12, comment: { id: 9, surface: "issue", actor: "ana", body: "@mendcode pause" }, text: "Paused." })
    expect(posted[0]).toContain(answersMarker(9))
  })
})

test("a comment can address one developer's reviewer: @mendcode review @alice", () => {
  expect(parsePrCommand("@mendcode review @alice")).toEqual({ kind: "review", target: "alice" })
  expect(parsePrCommand("@mendcode explain @alice why is this wrong?")).toEqual({ kind: "explain", target: "alice", arg: "why is this wrong?" })
  expect(parsePrCommand("@mendcode learn @Decorators are fine here")).toEqual({ kind: "learn", target: "Decorators", arg: "are fine here" })
  // GitLab and Gitea usernames may hold `_` and `.`.
  expect(parsePrCommand("@mendcode review @ana.lopez_2")).toEqual({ kind: "review", target: "ana.lopez_2" })
  expect(parsePrCommand("@mendcode review @ana.")).toEqual({ kind: "review", arg: "@ana." })
  expect(parsePrCommand("@mendcode learn decorators are fine")).toEqual({ kind: "learn", arg: "decorators are fine" })
})
