import { describe, expect, test } from "bun:test"
import { parsePrCommand, replyTo } from "../src/pr-review/commands"
import type { GhCall } from "../src/pr-review/publish"
import { answeredBy, answersMarker, headReviewedBy, mayPublish, reviewedBy } from "../src/pr-review/publishers"
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

  test("a submitted review of the head, hand-written or MendCode's, by this login or a publisher answers @mendcode review; another head, a pending or dismissed review or an outsider's does not", async () => {
    // Seen live, #12: the user's own session posted review 9001 on head 6d33aa87 by hand, without MendCode's marker.
    const review = (login: string, association: string, extra: Record<string, unknown> = {}) => ({ id: 9001, commit_id: HEAD, state: "COMMENTED", body: "## Summary\nReviewed by hand.", user: { login, type: "User" }, author_association: association, ...extra })
    const at = (reviews: unknown[]) => headReviewedBy({ gh: answering({ "repos/acme/app/pulls/12/reviews?per_page=100": JSON.stringify(reviews) }), repo: "acme/app", number: 12, head: HEAD, rule: "maintainers", self: "Alice-Dev" })
    expect(await at([review("alice-dev", "NONE")])).toEqual({ login: "alice-dev", id: 9001 })
    expect(await at([review("bob", "MEMBER")])).toEqual({ login: "bob", id: 9001 })
    expect(await at([review("mallory", "NONE")])).toBeUndefined()
    expect(await at([review("Alice-Dev", "NONE", { commit_id: "d".repeat(40) })])).toBeUndefined()
    expect(await at([review("Alice-Dev", "NONE", { state: "PENDING" })])).toBeUndefined()
    expect(await at([review("Alice-Dev", "NONE", { state: "DISMISSED" })])).toBeUndefined()
    // Unreadable reviews answer nothing: the command runs as before.
    expect(await headReviewedBy({ gh: answering({}), repo: "acme/app", number: 12, head: HEAD, rule: "maintainers", self: "Alice-Dev" })).toBeUndefined()
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
  expect(parsePrCommand("@mendcode learn decorators are fine")).toEqual({ kind: "learn", arg: "decorators are fine" })
})
