import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ToolContext } from "@mendcode/tools"
import type { GhRun } from "../src/pr-watch"
import { gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import type { GhCall } from "../src/pr-review/publish"
import { createPrReviewService } from "../src/pr-review/service"
import { createPrReviewPort, createPrReviewTool, NO_SELF_MENTION, postingLine, type PrReviewPort } from "../src/pr-review-tool"
import { createReviewConfigTool } from "../src/review-config-tool"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

/** A clone of a local bare origin with `refs/pull/12/head` one commit past main, and a review.yaml that enables the reviewer. */
async function repository() {
  const origin = temp("pr-review-tool-origin-"), dir = temp("pr-review-tool-clone-")
  const git = async (cwd: string, ...args: string[]) => { const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd); if (done.code) throw new Error(args.join(" ")); return done.out.trim() }
  await git(origin, "init", "-q", "--bare", "-b", "main")
  await git(dir, "init", "-q", "-b", "main")
  mkdirSync(path.join(dir, ".mendcode"))
  writeFileSync(path.join(dir, ".mendcode", "review.yaml"), "enabled: true\n")
  writeFileSync(path.join(dir, "a.ts"), "export const one = 1\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  const base = await git(dir, "rev-parse", "HEAD")
  await git(dir, "checkout", "-q", "-b", "feature")
  writeFileSync(path.join(dir, "a.ts"), "export const one = 2\n")
  await git(dir, "commit", "-q", "-am", "feature")
  const head = await git(dir, "rev-parse", "HEAD")
  await git(dir, "remote", "add", "origin", origin)
  await git(dir, "push", "-q", "origin", "main", "feature:refs/pull/12/head")
  await git(dir, "checkout", "-q", "main")
  return { dir, base, head }
}

/** The real PR review service over a fake gh that records every call; review children answer from a script. */
async function reviewer() {
  const { dir, base, head } = await repository()
  const notices: string[] = []
  const calls: string[][] = []
  const run: GhRun = async ({ argv }) => {
    calls.push(argv)
    if (argv[0] === "repo") return { code: 0, out: "acme/app", err: "" }
    if (argv[0] === "pr" && argv[1] === "view") return { code: 0, out: JSON.stringify({ number: Number(argv[2]), headRefOid: head, baseRefOid: base, baseRefName: "main", url: "https://github.com/acme/app/pull/12" }), err: "" }
    if (argv[0] === "pr" && argv[1] === "list") return { code: 0, out: "[]", err: "" }
    if (argv.join(" ") === "api user --jq .login") return { code: 0, out: "nora", err: "" }
    return { code: 1, out: "", err: "unexpected" }
  }
  const call: GhCall = async ({ argv }) => {
    calls.push(argv)
    if (argv[1] === "repos/acme/app") return { code: 0, out: "true" }
    return { code: 0, out: "[]" }
  }
  const finding = { path: "a.ts", line: 1, severity: "major", category: "correctness", summary: "one is now 2", detail: "Callers expect 1.", evidence: ["a.ts:1"] }
  const sessions = (): ReviewSessionFactory => async ({ purpose }) => ({
    async send(prompt) {
      if (purpose === "review") return { text: JSON.stringify({ summary: "Changes one.", findings: [finding] }), tokens: { input: 100, output: 10 } }
      const id = /"id":"([0-9a-f]{40})"/.exec(prompt)?.[1] ?? ""
      return { text: JSON.stringify({ verdicts: [{ id, verdict: "confirmed" }] }), tokens: { input: 50, output: 5 } }
    },
    async close() {},
  })
  const service = createPrReviewService({
    dir: temp("pr-review-tool-data-"), run, call, intervalMs: 3_600_000, enabled: () => true, graphOn: () => false,
    sessionDirectory: () => dir, sessionExists: () => true, notify: (_session, text) => notices.push(text),
    sessions, editor: sessions, schedule: async (job) => { await job() },
  })
  cleanups.push(() => service.stop())
  const port = createPrReviewPort({ sessionId: "ses_a", directory: () => dir, control: (input) => service.control(input) })
  return { service, port, dir, notices, calls }
}

const contextWith = (cwd: string, prReview?: PrReviewPort): ToolContext => ({ cwd, signal: new AbortController().signal, ...(prReview ? { prReview } : {}) }) as ToolContext
/** A forge call that writes a comment or a review: a POST, PATCH or PUT to an issues/pulls endpoint, or `gh pr comment`/`gh pr review`. */
const writesToForge = (argv: string[]) => (argv[0] === "pr" && ["comment", "review"].includes(argv[1] ?? "")) || (argv[0] === "api" && argv.some((part) => ["POST", "PATCH", "PUT"].includes(part)))

describe("pr_review tool", () => {
  test("review starts a ledger job through the daemon's reviewer, with no comment or post on the forge; without consent it stays in the session", async () => {
    const { service, port, dir, calls, notices } = await reviewer()
    const tool = createPrReviewTool({ enabled: () => true })
    const preview = await tool.preview!({ action: "review", pr: "12" }, contextWith(dir, port))
    expect(preview).toContain("Nothing is commented on the pull request to start it.")
    expect(preview).toContain(postingLine(undefined))
    const result = await tool.execute({ action: "review", pr: "12" }, contextWith(dir, port))
    expect(result.isError).toBe(false)
    expect(result.output).toContain("Reviewing #12.")
    expect(result.output).toContain("Posting: not allowed for this repository yet, so the review stays in this session")
    const jobs = service.platform.jobs.list()
    expect(jobs.map((job) => ({ directory: job.directory, number: job.number, trigger: job.trigger, sessionId: job.sessionId }))).toEqual([{ directory: dir, number: 12, trigger: "manual", sessionId: "ses_a" }])
    for (let i = 0; i < 100 && service.platform.jobs.list().some((job) => ["pending", "running", "validating"].includes(job.state)); i++) await Bun.sleep(20)
    expect(service.platform.jobs.list().map((job) => job.state)).toEqual(["done"])
    for (let i = 0; i < 100 && notices.length < 2; i++) await Bun.sleep(20)
    expect(notices[0]).toContain("PR review of acme/app#12: reviewed")
    expect(notices[1]).toContain("MendCode has never posted a review to acme/app")
    expect(calls.filter(writesToForge)).toEqual([])
    expect(calls.some((argv) => argv.join(" ").includes("@mendcode"))).toBe(false)

    const status = await tool.execute({ action: "status" }, contextWith(dir, port))
    expect(status.isError).toBe(false)
    expect(status.output).toContain("#12 ")
    expect(status.output).toContain(`[job ${jobs[0]!.id}]`)
  })

  test("after /pr publish on the answer says the review is posted; after /pr publish off it says it stays in the session", async () => {
    const { service, port } = await reviewer()
    expect((await service.control({ sessionId: "ses_a", action: "publish-on" })).ok).toBe(true)
    expect(await port.preview({ pr: "12" })).toContain(postingLine("allowed"))
    expect((await service.control({ sessionId: "ses_a", action: "publish-off" })).ok).toBe(true)
    expect(await port.preview({ pr: "12" })).toContain(postingLine("denied"))
  })

  test("a refused review (not a PR number) is an error and starts no job", async () => {
    const { service, port, dir } = await reviewer()
    const result = await createPrReviewTool({ enabled: () => true }).execute({ action: "review", pr: "not a pr" }, contextWith(dir, port))
    expect(result.isError).toBe(true)
    expect(service.platform.jobs.list()).toEqual([])
  })

  test("review follows the permission mode like a command (full access runs it, no forced prompt) and status is a read; off or without a port it refuses and points to /pr review, never to a comment", async () => {
    const tool = createPrReviewTool({ enabled: () => true })
    // Seen live: a full-access session was still asked to approve "Edit files" for a review.
    expect(tool.approvalFor).toBeUndefined()
    expect(tool.approval).toBeUndefined()
    expect(tool.permissionFor!({ action: "status" })).toBe("read")
    expect(tool.permissionFor!({ action: "review", pr: "12" })).toBe("execute")
    const bare = await tool.execute({ action: "review", pr: "12" }, contextWith("/tmp"))
    expect(bare.isError).toBe(true)
    expect(bare.output).toContain("Ask the user to run /pr review <n>; do not comment on the PR to trigger it.")
    const off = await createPrReviewTool({ enabled: () => false }).execute({ action: "status" }, contextWith("/tmp"))
    expect(off.output).toContain("/pr on")
  })

  test("the rule names the tool and forbids @mendcode from the user's account, in both tools' descriptions", () => {
    expect(NO_SELF_MENTION).toContain("call pr_review with action review (or the user runs /pr review <n>)")
    expect(NO_SELF_MENTION).toContain("never post an @mendcode comment")
    expect(createPrReviewTool({ enabled: () => true }).description).toContain(NO_SELF_MENTION)
    const control = { run: async () => ({ ok: false as const, text: "", problems: [] }) }
    expect(createReviewConfigTool({ control, enabled: () => true }).description).toContain(NO_SELF_MENTION)
  })
})
