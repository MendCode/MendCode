import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PrFinding } from "@mendcode/protocol"
import { gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { findingId } from "../src/pr-review/findings"
import { runFix } from "../src/pr-review/fix"
import { runFixLoop } from "../src/pr-review/fix-loop"
import { createJobLedger } from "../src/pr-review/jobs"
import { createPermissions } from "../src/pr-review/permissions"
import type { GhCall } from "../src/pr-review/publish"
import { controlOf, release, takeOver } from "../src/pr-review/takeover"

/**
 * Platform scenarios for fixes (docs/pr-review.md, "Fix modes and taking over"): a real bare "origin" and a clone in temp
 * directories, the real `runFix` (worktree, commit, kept ref, plain push), the fix loop on the real job ledger, the take-over and
 * a fresh permission read through a fake `gh`. The fix session is scripted; no model, no network.
 */

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); temps.push(dir); return dir }
async function git(cwd: string, ...args: string[]) {
  const done = await gitRun(args, cwd)
  if (done.code !== 0) throw new Error(`git ${args.join(" ")}: exit ${done.code}`)
  return done.out.trim()
}

async function repository() {
  const origin = temp("mc-platform-fix-origin-"), dir = temp("mc-platform-fix-clone-"), root = temp("mc-platform-fix-root-")
  await git(origin, "init", "-q", "--bare", "-b", "main")
  await git(dir, "init", "-q", "-b", "main")
  await git(dir, "config", "user.name", "t")
  await git(dir, "config", "user.email", "t@example.invalid")
  await git(dir, "config", "commit.gpgsign", "false")
  writeFileSync(path.join(dir, "a.ts"), "export const one = 2\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "feature")
  await git(dir, "remote", "add", "origin", origin)
  await git(dir, "push", "-q", "origin", "main:feature")
  return { origin, dir, root, head: await git(dir, "rev-parse", "HEAD") }
}

/** A fix session that rewrites a.ts in the worktree it was given; `during` runs while it works (a concurrent push, a take-over). */
const editor = (during: () => Promise<void> = async () => {}) => (worktree: string): ReviewSessionFactory => async () => ({
  async send() { writeFileSync(path.join(worktree, "a.ts"), "export const one = 1\n"); await during(); return { text: "Restored one.", tokens: { input: 0, output: 0 } } },
  async close() {},
})
const passing = async (_directory: string, commands: readonly string[]) => commands.map((command) => ({ command, code: 0, output: "ok" }))
const fixInput = (repo: Awaited<ReturnType<typeof repository>>) => ({ directory: repo.dir, root: repo.root, number: 12, head: repo.head, branch: "feature", pushUrl: "origin", instructions: "restore one", checks: ["bun test"], runChecks: passing, now: () => 1_700_000_000_000 })
const keptRefs = async (dir: string) => (await git(dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/mendcode/fix/")).split("\n").filter(Boolean)

describe("platform fix: work survives every refused push", () => {
  test("a fork PR without edits from maintainers: the fix is committed and kept on a local ref, nothing is pushed", async () => {
    const repo = await repository()
    const result = await runFix({ ...fixInput(repo), sessions: editor(), mayPush: async () => "the head branch is in a fork that does not allow edits from maintainers" })
    expect(result).toMatchObject({ ok: false, reason: "the head branch is in a fork that does not allow edits from maintainers" })
    if (result.ok || !result.commit || !result.kept) throw new Error("the fix must be kept")
    expect(await keptRefs(repo.dir)).toEqual([`${result.kept} ${result.commit}`])
    expect(await git(repo.dir, "show", `${result.commit}:a.ts`)).toBe("export const one = 1")
    expect(await git(repo.origin, "rev-parse", "feature")).toBe(repo.head)
    // The user's own checkout is untouched.
    expect(readFileSync(path.join(repo.dir, "a.ts"), "utf8")).toBe("export const one = 2\n")
  })
  test("a write permission revoked while the fix ran is read fresh before the push: nothing pushed, the fix kept", async () => {
    const repo = await repository()
    let level = "write"
    const gh: GhCall = async () => ({ code: 0, out: JSON.stringify({ permission: level }) })
    const permissions = createPermissions({ gh })
    expect(await permissions.mayWrite("acme/app", "nora", { fresh: false })).toBe(true)
    const result = await runFix({
      ...fixInput(repo),
      sessions: editor(async () => { level = "read" }),
      mayPush: async () => await permissions.mayWrite("acme/app", "nora") ? true : "@nora no longer has write access to acme/app",
    })
    expect(result).toMatchObject({ ok: false, reason: "@nora no longer has write access to acme/app" })
    expect(result.ok === false && result.kept).toBeTruthy()
    expect(await git(repo.origin, "rev-parse", "feature")).toBe(repo.head)
  })
  test("the head moves while the fix runs: the result is stale, the newer code is not overwritten and no force push happens", async () => {
    const repo = await repository()
    const other = temp("mc-platform-fix-other-")
    await git(other, "clone", "-q", "--branch", "feature", repo.origin, ".")
    await git(other, "config", "user.name", "o")
    await git(other, "config", "user.email", "o@example.invalid")
    const push = async () => {
      writeFileSync(path.join(other, "b.ts"), "export const two = 2\n")
      await git(other, "add", "-A")
      await git(other, "commit", "-q", "-m", "author pushed meanwhile")
      await git(other, "push", "-q", "origin", "HEAD:feature")
    }
    const result = await runFix({ ...fixInput(repo), sessions: editor(push) })
    expect(result).toMatchObject({ ok: false, stale: true })
    expect(result.ok === false && result.reason).toContain("while the fix ran")
    const tip = await git(repo.origin, "rev-parse", "feature")
    expect(tip).toBe(await git(other, "rev-parse", "HEAD"))
    expect(await git(repo.origin, "show", "feature:b.ts")).toBe("export const two = 2")
    expect(result.ok === false && result.kept).toBeTruthy()
  })
})

const finding = (line: number) => PrFinding.parse({ id: findingId({ path: "a.ts", line, category: "correctness", summary: `bug ${line}` }), path: "a.ts", line, side: "RIGHT", severity: "major", category: "correctness", summary: `bug ${line}`, detail: "d", evidence: [`a.ts:${line}`], verdict: "confirmed" })
function ledgerWithJob() {
  const dir = temp("mc-platform-fix-ledger-")
  const ledger = createJobLedger({ file: path.join(dir, "pr-review", "jobs.json"), now: () => 1_000 })
  const job = ledger.upsert({ provider: "github", repo: "acme/app", directory: "/tmp/acme", number: 12, sessionId: "s1", reviewer: "global", scope: "global", trigger: "opened", coverage: "full", base: "b".repeat(40), head: "a".repeat(40), configKey: "cfg1" })
  ledger.transition(job.id, "running")
  return { ledger, jobId: job.id }
}
const pushedFix = async () => ({ ok: true as const, commit: "c".repeat(40), pushed: true })

describe("platform fix: loop endings", () => {
  test("a failed validation never closes the job as done, even when the review finds nothing open", async () => {
    const { ledger, jobId } = ledgerWithJob()
    const reviews = [[finding(1)], []]
    const outcome = await runFixLoop({ jobId, ledger, review: async () => ({ open: reviews.shift() ?? [] }), fix: pushedFix, validate: async () => ({ ok: false, detail: "`bun test` exited with 1" }), maxRounds: 3, maxNoProgress: 2, controlOf: () => controlOf(ledger, jobId) })
    expect(outcome.state).toBe("failed")
    expect(outcome.stop?.detail).toContain("no confirmed finding is open, but the validation failed: `bun test` exited with 1")
    expect(ledger.get(jobId)!.state).toBe("failed")
  })
  test("rounds that do not shrink the open findings stop with a no-progress reason in rounds, each round recorded", async () => {
    const { ledger, jobId } = ledgerWithJob()
    const outcome = await runFixLoop({ jobId, ledger, review: async () => ({ open: [finding(1), finding(2)] }), fix: pushedFix, validate: async () => ({ ok: true, detail: "" }), maxRounds: 10, maxNoProgress: 2, controlOf: () => controlOf(ledger, jobId) })
    expect(outcome).toMatchObject({ state: "failed", rounds: 2, stop: { kind: "no_progress", unit: "rounds", used: 2, limit: 2, resumable: false, remaining: "2 confirmed findings still open (a.ts:1, a.ts:2)" } })
    expect(ledger.get(jobId)!.checkpoint.rounds.map((round) => round.open.length)).toEqual([2, 2])
  })
  test("fix.push off: a passing fix is kept locally and the job says why it was not pushed", async () => {
    const { ledger, jobId } = ledgerWithJob()
    const outcome = await runFixLoop({ jobId, ledger, review: async () => ({ open: [finding(1)] }), fix: async () => ({ ok: true, commit: "d".repeat(40), pushed: false, kept: "refs/mendcode/fix/12/1" }), validate: async () => ({ ok: true, detail: "" }), maxRounds: 3, maxNoProgress: 2, controlOf: () => "reviewer" })
    expect(outcome).toMatchObject({ state: "done", kept: "refs/mendcode/fix/12/1", stop: { kind: "permission" } })
    expect(outcome.stop?.detail).toContain("`fix.push` is off")
  })
})

describe("platform fix: taking over prevents two writers", () => {
  test("the user takes the job over during a fix round: the loop yields before writing again, a second take-over is refused, and release queues the job back", async () => {
    const { ledger, jobId } = ledgerWithJob()
    let fixes = 0
    const outcome = await runFixLoop({
      jobId, ledger, review: async () => ({ open: [finding(1)] }), validate: async () => ({ ok: true, detail: "" }), maxRounds: 5, maxNoProgress: 3, controlOf: () => controlOf(ledger, jobId),
      // `fix.push` off: runFix commits and keeps the fix without a push, which it may do while the user holds the job.
      fix: async () => { fixes++; expect(takeOver({ ledger, jobId, now: () => Date.UTC(2026, 9, 30), by: "alice" }).ok).toBe(true); return { ok: true, commit: "e".repeat(40), pushed: false, kept: "refs/mendcode/fix/12/1" } },
    })
    expect(fixes).toBe(1)
    expect(outcome.state).toBe("paused")
    expect(ledger.get(jobId)).toMatchObject({ state: "paused", control: "user" })
    expect(takeOver({ ledger, jobId, now: () => 0, by: "bob" })).toEqual({ ok: false, reason: "[PR_REVIEW]: the job is already taken over by alice", holder: "alice" })
    expect(release({ ledger, jobId, by: "bob" }).ok).toBe(false)
    // While the user holds it, an automatic fix does not even start.
    expect(await runFix({ directory: "/nonexistent", root: "/nonexistent", number: 12, head: "a".repeat(40), branch: "f", pushUrl: "origin", instructions: "x", checks: [], runChecks: passing, sessions: editor(), controlOf: () => controlOf(ledger, jobId) })).toEqual({ ok: false, reason: "the job was taken over by the user, so no automatic fix runs" })
    const back = release({ ledger, jobId, by: "alice" })
    expect(back.ok && back.job).toMatchObject({ state: "pending", control: "reviewer" })
  })
})
