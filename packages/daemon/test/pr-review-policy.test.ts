import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { GhRun } from "../src/pr-watch"
import { gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import type { GhCall } from "../src/pr-review/publish"
import { createPrReviewService } from "../src/pr-review/service"

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

/**
 * A watched repository as it was: the PR's recorded base predates the commit on master that adds `.mendcode/review.yaml`, and the
 * user's checkout is on a branch without the file. The policy must come from master's tip.
 */
async function symbexLike(yaml: string) {
  const origin = temp("pr-policy-origin-"), dir = temp("pr-policy-clone-")
  const git = async (cwd: string, ...args: string[]) => { const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd); if (done.code) throw new Error(args.join(" ")); return done.out.trim() }
  await git(origin, "init", "-q", "--bare", "-b", "master")
  await git(dir, "init", "-q", "-b", "master")
  writeFileSync(path.join(dir, "a.ts"), "export const one = 1\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  const recorded = await git(dir, "rev-parse", "HEAD")
  await git(dir, "checkout", "-q", "-b", "feature")
  writeFileSync(path.join(dir, "a.ts"), "export const one = 2\n")
  await git(dir, "commit", "-q", "-am", "feature")
  const head = await git(dir, "rev-parse", "HEAD")
  await git(dir, "checkout", "-q", "master")
  mkdirSync(path.join(dir, ".mendcode"))
  writeFileSync(path.join(dir, ".mendcode", "review.yaml"), yaml)
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "MendCode reviewer: enable on PRs, requests limited to the team")
  await git(dir, "remote", "add", "origin", origin)
  await git(dir, "push", "-q", "origin", "master", "feature:refs/pull/12/head")
  // The user's own work branch, from before the config, and nothing fetched since.
  await git(dir, "checkout", "-q", "-b", "work", recorded)
  return { dir, recorded, head }
}

function service({ dir, recorded, head }: { dir: string; recorded: string; head: string }) {
  const data = temp("pr-policy-data-")
  const posts: Array<{ endpoint: string; body: string }> = []
  const notices: string[] = []
  const writers = new Set(["carol"])
  const run: GhRun = async ({ argv }) => {
    if (argv[0] === "repo") return { code: 0, out: "acme/app", err: "" }
    if (argv.join(" ") === "api user --jq .login") return { code: 0, out: "ana", err: "" }
    if (argv[0] === "pr" && argv[1] === "view") return { code: 0, out: JSON.stringify({ number: 12, headRefOid: head, baseRefOid: recorded, baseRefName: "master", url: "https://github.com/acme/app/pull/12", title: "t", body: "b" }), err: "" }
    return { code: 1, out: "", err: "unexpected" }
  }
  const call: GhCall = async ({ argv, stdin }) => {
    const endpoint = argv[1] ?? ""
    if (argv.includes("POST")) { posts.push({ endpoint, body: stdin ?? "" }); return { code: 0, out: JSON.stringify({ id: posts.length }) } }
    if (endpoint.endsWith("/permission")) return { code: 0, out: writers.has(endpoint.split("/")[4]!) ? "write" : "read" }
    // This reviewer's login has no write access: only the publishers list lets it post.
    if (endpoint === "repos/acme/app") return { code: 0, out: "false" }
    return { code: 0, out: "[]" }
  }
  let turns = 0
  const sessions = (): ReviewSessionFactory => async () => ({ async send() { turns++; return { text: JSON.stringify({ summary: "Changes one.", findings: [] }), tokens: { input: 10, output: 1 } } }, async close() {} })
  const reviewer = createPrReviewService({
    dir: data, run, call, intervalMs: 3_600_000, enabled: () => true, graphOn: () => false, sessionDirectory: () => dir, sessionExists: () => true,
    notify: (_session, text) => notices.push(text), sessions, editor: sessions, schedule: async (job) => { await job() },
  })
  cleanups.push(() => reviewer.stop())
  const command = (actor: string, kind: "pause" | "review" = "pause", id = 5) => ({ kind: "command" as const, directory: dir, sessionId: "ses_a", number: 12, head, trigger: "comment" as const, command: { kind }, comment: { id, surface: "issue" as const, actor, body: `@mendcode ${kind}` } })
  return { reviewer, posts, notices, command, turns: () => turns }
}

describe("the repository's policy", () => {
  const TEAM = "enabled: true\nreviewers: [carol, dave]\npublishers: [ana, carol]\n"

  test("reviewers as a list: a listed member's command is answered under the base branch's current publishers; anyone else's is not taken, and nobody is told", async () => {
    const repo = await symbexLike(TEAM)
    const s = service(repo)
    await s.reviewer.control({ sessionId: "ses_a", action: "publish-on" })
    // Not in the team, even with write access elsewhere: dropped without a reply, a notice or a retry.
    expect(await s.reviewer.command(s.command("mallory"))).toBeUndefined()
    expect(s.posts).toEqual([])
    expect(s.notices).toEqual([])
    // In the team, with write access: answered, as a publisher only master's tip lists (the checkout and the PR's base say nothing).
    expect(await s.reviewer.command(s.command("carol", "pause", 6))).toBeUndefined()
    expect(s.posts).toHaveLength(1)
    expect(s.notices.at(-1)).toBe("@mendcode pause from carol on acme/app#12: answered on GitHub.")
  })

  test("being in reviewers grants no execution: a listed member without write access is refused as before", async () => {
    const repo = await symbexLike(TEAM)
    const s = service(repo)
    await s.reviewer.control({ sessionId: "ses_a", action: "publish-on" })
    await s.reviewer.command(s.command("dave"))
    expect(s.notices.at(-1)).toBe("@mendcode pause from dave on acme/app#12: refused (no write access).")
    expect(s.posts).toHaveLength(1)
    expect(s.posts[0]!.body).toContain("Only maintainers")
  })

  test("all and requested keep their meaning: anyone's comment is taken and the write-access check decides", async () => {
    for (const role of ["all", "requested"]) {
      const repo = await symbexLike(`enabled: true\nreviewers: ${role}\npublishers: [ana]\n`)
      const s = service(repo)
      await s.reviewer.control({ sessionId: "ses_a", action: "publish-on" })
      await s.reviewer.command(s.command("mallory"))
      expect(s.notices.at(-1)).toBe("@mendcode pause from mallory on acme/app#12: refused (no write access).")
    }
  })

  test("a publisher only master's tip lists may post a review: enabled and publishers are read there, not at the PR's older base", async () => {
    const repo = await symbexLike(TEAM)
    const s = service(repo)
    await s.reviewer.control({ sessionId: "ses_a", action: "publish-on" })
    await s.reviewer.control({ sessionId: "ses_a", action: "review", pr: "12" })
    for (let i = 0; i < 150 && !s.notices.some((text) => text.startsWith("PR review of")); i++) await Bun.sleep(20)
    const notice = s.notices.find((text) => text.startsWith("PR review of"))!
    expect(notice).not.toContain("publishing needs enabled")
    expect(notice).not.toContain("no write access")
    expect(s.posts.some((post) => post.endpoint.endsWith("/reviews"))).toBe(true)
  })
})
