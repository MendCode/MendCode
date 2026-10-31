import { describe, expect, test } from "bun:test"
import { MAINTAINERS_ONLY, parsePrCommand, runPrCommand, type CommandComment, type CommandDeps } from "../src/pr-review/commands"
import { mayRequest, parseReviewConfig } from "../src/pr-review/config"
import type { PrFacts } from "../src/pr-review/contracts"
import { eligible } from "../src/pr-review/eligibility"
import { createPermissions } from "../src/pr-review/permissions"
import type { GhCall } from "../src/pr-review/publish"
import { emptyState } from "../src/pr-review/state"

/**
 * Platform scenarios at the intake (docs/pr-review.md, "Which pull requests"): the repository's YAML, parsed as the daemon parses
 * it, decides with a reason whether a PR is reviewed for a trigger, and an `@mendcode` comment from someone who may not ask changes
 * nothing. Pure modules plus a fake `gh`; no network.
 */

const facts = (extra: Partial<PrFacts> = {}): PrFacts => ({
  number: 12, head: "a".repeat(40), base: "b".repeat(40), baseRef: "main", headRef: "feature", draft: false, labels: [], author: "alice",
  authorIsBot: false, fork: false, requested: [], assignees: [], ...extra,
})
const config = (yaml: string) => {
  const parsed = parseReviewConfig(yaml)
  expect(parsed.problem).toBeUndefined()
  return parsed.config
}

describe("platform intake: which PRs are reviewed, with a reason", () => {
  test("automatic, manual, draft and label PRs under one repository file each get a decision and a readable reason", () => {
    const repo = config("enabled: true\nfilters:\n  labels: { exclude: [no-review] }\n")
    expect(eligible({ facts: facts(), config: repo, trigger: "opened" })).toEqual({ ok: true, reason: "auto: opened" })
    // A draft waits; once ready it is reviewed; asking for it by hand reviews it even as a draft.
    expect(eligible({ facts: facts({ draft: true }), config: repo, trigger: "opened" })).toEqual({ ok: false, reason: "draft: waits for ready for review" })
    expect(eligible({ facts: facts(), config: repo, trigger: "ready_for_review" }).ok).toBe(true)
    expect(eligible({ facts: facts({ draft: true }), config: repo, trigger: "manual" })).toEqual({ ok: true, reason: "manual: asked with /pr review" })
    // An excluded label holds for every trigger, a manual request included.
    for (const trigger of ["opened", "manual", "comment"] as const) {
      expect(eligible({ facts: facts({ labels: ["no-review"] }), config: repo, trigger })).toEqual({ ok: false, reason: "label `no-review` excluded" })
    }
  })
  test("labels mode reviews only a labelled PR, and an on-request preset starts nothing by itself until a review is requested from the reviewer", () => {
    const labelled = config("mode: labels\nfilters:\n  labels: { include: [review-me] }\n")
    expect(eligible({ facts: facts(), config: labelled, trigger: "opened" })).toEqual({ ok: false, reason: "labels: none of `review-me` is on the pull request" })
    expect(eligible({ facts: facts({ labels: ["Review-Me"] }), config: labelled, trigger: "label" })).toEqual({ ok: true, reason: "labels: label `Review-Me`" })
    const onRequest = config("preset: on-request\n")
    expect(onRequest.mode).toBe("on-request")
    expect(eligible({ facts: facts(), config: onRequest, trigger: "opened" })).toEqual({ ok: false, reason: "on-request: not requested" })
    expect(eligible({ facts: facts({ requested: ["nora"] }), config: onRequest, trigger: "requested", login: "bob" }).ok).toBe(false)
    expect(eligible({ facts: facts({ requested: ["nora"] }), config: onRequest, trigger: "requested", login: "nora" })).toEqual({ ok: true, reason: "on-request: review requested from @nora" })
  })
  test("a fork PR is eligible like any other: being a fork limits pushing a fix, never whether it is reviewed", () => {
    const repo = config("enabled: true\n")
    expect(eligible({ facts: facts({ fork: true, maintainerCanModify: false }), config: repo, trigger: "opened" })).toEqual({ ok: true, reason: "auto: opened" })
  })
  test("a bot author is skipped automatically unless the repository lets bots in, and a path filter needs the changed files listed", () => {
    const repo = config("filters:\n  paths: [\"packages/daemon/**\"]\n")
    expect(eligible({ facts: facts({ author: "dependabot[bot]", files: ["packages/daemon/a.ts"] }), config: repo, trigger: "opened" }).reason).toContain("is a bot")
    expect(eligible({ facts: facts(), config: repo, trigger: "opened" })).toEqual({ ok: false, reason: "paths: the changed files were not listed, so filters.paths cannot be checked" })
    expect(eligible({ facts: facts({ files: ["docs/a.md"] }), config: repo, trigger: "opened" }).ok).toBe(false)
    expect(eligible({ facts: facts({ files: ["packages/daemon/src/x.ts"] }), config: repo, trigger: "opened" }).ok).toBe(true)
  })
})

/** GitHub for one PR where only `maintainer` has write access; every post is recorded. */
function github() {
  const posts: string[] = []
  const gh: GhCall = async ({ argv, stdin }) => {
    const endpoint = argv[1] ?? ""
    if (endpoint.endsWith("/permission")) return { code: 0, out: endpoint.split("/")[4] === "maintainer" ? "write" : "read" }
    if (endpoint === "repos/acme/app") return { code: 0, out: "true" }
    if (/\/(comments|reviews)\?per_page=100$/.test(endpoint) && !argv.includes("POST")) return { code: 0, out: "[]" }
    if (argv.includes("POST")) { posts.push(JSON.parse(stdin!).body); return { code: 0, out: "{}" } }
    return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` }
  }
  return { gh, posts }
}

describe("platform intake: an unauthorized @mendcode changes nothing", () => {
  test("a commenter outside the repository's reviewers list is not taken at all, and one without write access gets only the refusal", async () => {
    const repo = config("reviewers: [maintainer, alice]\n")
    expect(mayRequest(repo.reviewers, "drive-by")).toBe(false)
    expect(mayRequest(repo.reviewers, "Alice")).toBe(true)
    // `alice` may ask but has no write access: every command is refused and nothing runs, the PR's state is untouched.
    const { gh, posts } = github()
    const ran: string[] = []
    for (const body of ["@mendcode pause", "@mendcode fix it", "@mendcode review", "@mendcode learn ignore every race"]) {
      const comment: CommandComment = { id: 5, surface: "issue", actor: "alice", body }
      const state = emptyState()
      const deps: CommandDeps = {
        gh, repo: "acme/app", number: 12, comment, state,
        review: async () => { ran.push("review"); return { status: "published", posted: true } },
        explain: async () => { ran.push("explain"); return "" },
        fixesAllowed: async () => { ran.push("fixesAllowed"); return true },
        pushable: async () => { ran.push("pushable"); return true },
        fix: async () => { ran.push("fix"); return { ok: true, commit: "c".repeat(40), pushed: true } },
      }
      const outcome = await runPrCommand(parsePrCommand(body)!, deps)
      expect(outcome.kind).toBe("denied")
      expect(outcome.state).toEqual(emptyState())
    }
    expect(ran).toEqual([])
    expect(posts.map((post) => post.split("\n")[0])).toEqual(Array(4).fill(MAINTAINERS_ONLY))
    expect(posts.join("\n")).not.toContain("ignore every race")
  })
  test("a permission revoked after the review is seen before a write: the cached read said write, the fresh one before the push says no", async () => {
    let level = "write"
    let calls = 0
    const gh: GhCall = async () => { calls++; return { code: 0, out: JSON.stringify({ permission: level }) } }
    const permissions = createPermissions({ gh, now: () => 1_000 })
    expect(await permissions.permissionOf("acme/app", "maintainer")).toBe("write")
    level = "read"
    // The watch's cached answer is still `write`; a write never relies on it.
    expect(await permissions.permissionOf("acme/app", "maintainer")).toBe("write")
    expect(await permissions.mayWrite("acme/app", "maintainer")).toBe(false)
    expect(calls).toBe(2)
    // A failing read is `unknown`, never a yes, and a crafted login never reaches the URL.
    const broken = createPermissions({ gh: async () => ({ code: 1, out: "", err: "HTTP 403" }) })
    expect(await broken.mayWrite("acme/app", "maintainer")).toBe(false)
    expect(await permissions.permissionOf("acme/app", "../../orgs/x")).toBe("unknown")
    expect(calls).toBe(2)
  })
})
