import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildReviewContext, gitRun } from "../src/pr-review/context"
import { DEFAULT_ENGINE_CONFIG, resumeReview, reviewPullRequest, type ReviewCheckpoint, type ReviewSessionFactory } from "../src/pr-review/engine"
import { findingId } from "../src/pr-review/findings"
import { createJobLedger, toSummary } from "../src/pr-review/jobs"

/**
 * Platform scenario for a budget stop and its resume through the real engine (docs/pr-review.md, "Budgets, quotas and
 * accounting"): a temp git repository, the real review context, scripted review and verify children, and the durable job ledger
 * across a daemon restart. The model is scripted; nothing is published here.
 */

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); temps.push(dir); return dir }
async function git(cwd: string, ...args: string[]) {
  const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd)
  if (done.code !== 0) throw new Error(`git ${args.join(" ")} failed`)
  return done.out.trim()
}
async function repository() {
  const dir = temp("mc-platform-resume-repo-")
  await git(dir, "init", "-q", "-b", "main")
  mkdirSync(path.join(dir, "src"))
  writeFileSync(path.join(dir, "src", "math.ts"), "export function total(values: number[]) {\n  let sum = 0\n  for (const value of values) sum += value\n  return sum\n}\nexport const half = (n: number) => n / 2\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  await git(dir, "checkout", "-q", "-b", "feature")
  writeFileSync(path.join(dir, "src", "math.ts"), "export function total(values: number[]) {\n  let sum = 0\n  for (let i = 1; i < values.length; i++) sum += values[i]!\n  return sum\n}\nexport const half = (n: number) => n >> 1\n")
  await git(dir, "commit", "-q", "-am", "feature")
  return dir
}

/** Children that answer from `answers` in order and record the purpose of every turn. */
function scripted(answers: string[]) {
  const asked: string[] = []
  const factory: ReviewSessionFactory = async ({ purpose }) => ({
    async send() { asked.push(purpose); return { text: answers.shift() ?? "", tokens: { input: 1000, output: 100 } } },
    async close() {},
  })
  return { factory, asked }
}
const candidate = (line: number, summary: string) => ({ path: "src/math.ts", line, severity: "major", category: "correctness", summary, detail: "d", evidence: [`src/math.ts:${line}`] })
const idOf = (line: number, summary: string) => findingId({ path: "src/math.ts", line, category: "correctness", summary })

describe("platform resume: a budget stop keeps the candidates and a resume finishes without a second review pass", () => {
  test("the review pass alone spends a small budget: both candidates are checkpointed, the job survives a restart, and the resume verifies only them", async () => {
    const dir = await repository()
    const context = await buildReviewContext({ directory: dir, base: "main", head: "feature", budgetTokens: 200_000 })
    const review = scripted([JSON.stringify({ summary: "Changes total and half.", findings: [candidate(3, "The loop skips the first value"), candidate(6, "half() truncates odd numbers")] })])
    const stopped = await reviewPullRequest({ sessionFactory: review.factory, context, config: { ...DEFAULT_ENGINE_CONFIG, budgetTokens: 500 }, cap: 8 })
    // The review pass, then the one short closing check (it gets no usable answer here, so both candidates stay unverified).
    expect(review.asked).toEqual(["review", "verify", "verify"])
    expect(stopped.stop).toMatchObject({ kind: "budget", unit: "tokens", used: 1100, limit: 500, resumable: true, remaining: "2 candidates not verified" })
    expect(stopped.result.findings).toEqual([])
    expect(stopped.result.summary).toContain("The review is incomplete")
    expect(stopped.result.summary).not.toContain("No findings")
    expect(stopped.validation).toEqual({ ok: false, reason: "the review is incomplete: candidates are still unverified" })
    expect(stopped.checkpoint!.candidates.map((finding) => finding.id).sort()).toEqual([idOf(3, "The loop skips the first value"), idOf(6, "half() truncates odd numbers")].sort())

    const file = path.join(temp("mc-platform-resume-data-"), "pr-review", "jobs.json")
    const jobs = createJobLedger({ file, now: () => 1_000 })
    const job = jobs.upsert({ provider: "github", repo: "acme/app", directory: dir, number: 12, sessionId: "s1", reviewer: "global", scope: "global", trigger: "opened", coverage: "full", base: "b".repeat(40), head: "a".repeat(40), configKey: "cfg1" })
    jobs.transition(job.id, "running")
    jobs.checkpoint(job.id, stopped.checkpoint!)
    jobs.transition(job.id, "checkpointed", { stop: stopped.stop })

    // Restart, then a retry with no internal cap (`tokens_per_pr: null` is `Infinity` for the engine).
    const restarted = createJobLedger({ file, now: () => 2_000 })
    const kept = restarted.get(job.id)!
    expect(toSummary(kept)).toMatchObject({ state: "checkpointed", phase: "corroboration", findings: { candidates: 2 } })
    const [loop, half] = kept.checkpoint.candidates.toSorted((a, b) => a.line - b.line)
    const verify = scripted([JSON.stringify({ verdicts: [{ id: loop!.id, verdict: "confirmed", evidence: ["src/math.ts:3 starts at 1"] }, { id: half!.id, verdict: "rejected", evidence: [] }] })])
    restarted.transition(job.id, "pending")
    restarted.transition(job.id, "running", { stop: undefined })
    const resumed = await resumeReview({ sessionFactory: verify.factory, context, config: { ...DEFAULT_ENGINE_CONFIG, budgetTokens: Number.POSITIVE_INFINITY }, checkpoint: kept.checkpoint as ReviewCheckpoint, cap: 8 })
    expect(verify.asked).toEqual(["verify"])
    expect(resumed.stop).toBeUndefined()
    expect(resumed.validation).toEqual({ ok: true, reason: "complete and verified" })
    expect(resumed.result.findings.map((finding) => [finding.line, finding.verdict])).toEqual([[3, "confirmed"]])
    // The continuation counts its own spending under a fresh allowance; the stopped run's stays in the job's ledger.
    expect(resumed.result.tokens).toMatchObject({ input: 1000, output: 100 })
    restarted.checkpoint(job.id, { candidates: [], verified: resumed.candidates, completedPhases: resumed.completedPhases ?? [] })
    restarted.transition(job.id, "validating")
    expect(toSummary(restarted.transition(job.id, "done")).findings).toMatchObject({ confirmed: 1, candidates: 0 })
  })
  test("the template's own sections written before a budget stop survive the job ledger, so a resume can publish them", () => {
    const file = path.join(temp("mc-platform-resume-data-"), "pr-review", "jobs.json")
    const jobs = createJobLedger({ file, now: () => 1_000 })
    const job = jobs.upsert({ provider: "github", repo: "acme/app", directory: "/tmp/acme", number: 12, sessionId: "s1", reviewer: "global", scope: "global", trigger: "opened", coverage: "full", base: "b".repeat(40), head: "a".repeat(40), configKey: "cfg1" })
    const checkpoint: ReviewCheckpoint = { completedPhases: ["analysis"], candidates: [], verified: [], rounds: [], decisions: [], sections: { "rollout-risks": "Feature flag is missing." } }
    jobs.checkpoint(job.id, checkpoint)
    expect((createJobLedger({ file }).get(job.id)!.checkpoint as ReviewCheckpoint).sections).toEqual({ "rollout-risks": "Feature flag is missing." })
  })
})
