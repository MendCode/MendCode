import { expect, test } from "bun:test"
import { linkedIssueNumbers, readPullRequestInfo } from "../src/pr-review/pull-request"
import type { GhCall } from "../src/pr-review/publish"

test("linked issues are the ones the description closes with GitHub's keywords, in this repository, at most three", () => {
  expect(linkedIssueNumbers("Fixes #12. Also closes: #3, resolves acme/app#7 and see #99.", "acme/app")).toEqual([12, 3, 7])
  expect(linkedIssueNumbers("Fixed #1, fix #1, closed other/repo#2, resolved #4, close #5, fixes #6", "acme/app")).toEqual([1, 4, 5])
  expect(linkedIssueNumbers("Related to #8 and #9", "acme/app")).toEqual([])
})

test("each linked issue is read with gh api; one that fails or is a pull request is left out, and everything is bounded", async () => {
  const asked: string[] = []
  const gh: GhCall = async ({ argv }) => {
    asked.push(argv.join(" "))
    if (argv[1] === "repos/acme/app/issues/1") return { code: 0, out: JSON.stringify({ title: "total is wrong", body: "x".repeat(5000) }) }
    if (argv[1] === "repos/acme/app/issues/2") return { code: 0, out: JSON.stringify({ title: "a PR", pull_request: {} }) }
    return { code: 1, out: "", err: "HTTP 404" }
  }
  const info = await readPullRequestInfo({ gh, repo: "acme/app", title: "T".repeat(400), body: "Fixes #1, fixes #2 and fixes #3" })
  expect(asked).toEqual(["api repos/acme/app/issues/1", "api repos/acme/app/issues/2", "api repos/acme/app/issues/3"])
  expect(info.issues).toEqual([{ number: 1, title: "total is wrong", body: "x".repeat(1500) }])
  expect(info.title.length).toBe(300)
  // Without gh: the title and description alone.
  expect(await readPullRequestInfo({ repo: "acme/app", title: "T", body: "Fixes #1" })).toEqual({ title: "T", body: "Fixes #1", issues: [] })
})
