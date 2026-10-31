import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PrFinding } from "@mendcode/protocol"
import type { FixResult } from "../src/pr-review/commands"
import { buildReviewContext, gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { findingId } from "../src/pr-review/findings"
import { openAfterRound, runFixLoop } from "../src/pr-review/fix-loop"
import { createJobLedger } from "../src/pr-review/jobs"
import type { GhCall } from "../src/pr-review/publish"
import { runPrReview } from "../src/pr-review/run"
import { findingMarker } from "../src/pr-review/state"
import { languageInstruction } from "../src/pr-review/template"
import { fixedFindings } from "../src/pr-review/verify"

/**
 * D1b of the live re-verification of 8c21523f (PR #8 of the private test repository): the review flagged `cancel.ts:8` (the cancel
 * path never refunds); the automatic fix inserted `await refund(receipt)` above that line and left the line itself as it was. The
 * review of the pushed fix re-checked only findings whose lines the new commits rewrote, so it never asked about this one: its
 * thread stayed open, and the fix round counted it as resolved (the review's own findings were empty), so the job ended `done`.
 * Also: that re-check's verify prompt carried no language line. Real git in temp directories, scripted children, a fake gh.
 */

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pr-recheck-"))); temps.push(dir); return dir }
async function git(cwd: string, ...args: string[]) {
  const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd)
  if (done.code !== 0) throw new Error(`git ${args.join(" ")} failed`)
  return done.out.trim()
}

const CANCEL = [
  "import { refund, release } from \"./payments\"",
  "",
  "/** Cancels an order: frees the stock and gives the money back. */",
  "export async function cancelOrder(order: Order) {",
  "  const { reservation, receipt } = order",
  "  if (order.status === \"cancelled\") return",
  "  order.status = \"cancelled\"",
  "  await release(reservation)",
  "  return order",
  "}",
  "",
].join("\n")
/** The fix as it was pushed live: one line inserted above the flagged one, which stays the same. */
const FIXED = CANCEL.replace("  await release(reservation)", "  await refund(receipt)\n  await release(reservation)")

/** main with the config, the PR's reviewed head (the bug) and the fix pushed on top of it. */
async function pullRequest(config = "enabled: true\n") {
  const dir = temp()
  await git(dir, "init", "-q", "-b", "main")
  writeFileSync(path.join(dir, "README.md"), "shop\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  mkdirSync(path.join(dir, ".mendcode"))
  writeFileSync(path.join(dir, ".mendcode", "review.yaml"), config)
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "config")
  const base = await git(dir, "rev-parse", "HEAD")
  await git(dir, "checkout", "-q", "-b", "cancel-order")
  writeFileSync(path.join(dir, "cancel.ts"), CANCEL)
  writeFileSync(path.join(dir, "other.ts"), "export const other = 1\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "cancel orders")
  const reviewed = await git(dir, "rev-parse", "HEAD")
  writeFileSync(path.join(dir, "cancel.ts"), FIXED)
  await git(dir, "commit", "-q", "-am", "fix: cancelOrder never calls refund(receipt)")
  return { dir, base, reviewed, fix: await git(dir, "rev-parse", "HEAD") }
}

const NO_REFUND = PrFinding.parse({
  id: findingId({ path: "cancel.ts", line: 8, category: "correctness", summary: "cancelOrder never calls refund(receipt): the charge is kept while the order is cancelled" }),
  path: "cancel.ts", line: 8, side: "RIGHT", severity: "critical", category: "correctness",
  summary: "cancelOrder never calls refund(receipt): the charge is kept while the order is cancelled", detail: "d", evidence: ["cancel.ts:8"], verdict: "confirmed",
})
const ELSEWHERE = PrFinding.parse({ ...NO_REFUND, id: findingId({ path: "other.ts", line: 1, category: "correctness", summary: "other is wrong" }), path: "other.ts", line: 1, summary: "other is wrong", evidence: ["other.ts:1"] })

/** Verify children that judge every finding they are asked about with `verdict`; every prompt is kept. */
function verifier(verdict: "rejected" | "confirmed") {
  const prompts: string[] = []
  const factory: ReviewSessionFactory = async ({ purpose }) => ({
    async send(prompt) {
      prompts.push(prompt)
      if (purpose === "review") return { text: JSON.stringify({ summary: "Calls refund on cancel.", findings: [] }), tokens: { input: 10, output: 1 } }
      const ids = prompt.split("\n").flatMap((line) => { try { const value = JSON.parse(line) as { id?: string }; return value.id ? [value.id] : [] } catch { return [] } })
      return { text: JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict, evidence: ["cancel.ts:8 refund(receipt) is called first now"] })) }), tokens: { input: 10, output: 1 } }
    },
    async close() {},
  })
  return { factory, prompts }
}

describe("D1b: a fix that inserts a line next to the flagged one", () => {
  test("the re-check asks about the finding whose line only moved, and resolves it when the verifier no longer finds it", async () => {
    const repo = await pullRequest()
    const context = await buildReviewContext({ directory: repo.dir, base: repo.reviewed, head: repo.fix, budgetTokens: 50_000 })
    const kids = verifier("rejected")
    expect(await fixedFindings({ sessionFactory: kids.factory, previous: [NO_REFUND, ELSEWHERE], context })).toEqual([NO_REFUND.id])
    expect(kids.prompts).toHaveLength(1)
    expect(kids.prompts[0]).toContain(NO_REFUND.summary)
    // other.ts was not touched by the fix: not asked about.
    expect(kids.prompts[0]).not.toContain(ELSEWHERE.summary)
  })

  test("the review of the pushed fix re-checks the round's findings, resolves the thread on GitHub and reports which it closed", async () => {
    const repo = await pullRequest("enabled: true\ntemplate:\n  language: Español\n")
    const calls: Array<{ argv: string[]; body: { query?: string; variables?: { thread?: string } } }> = []
    const thread = { id: "PRRT_4429610571", resolved: false }
    const gh: GhCall = async ({ argv, stdin }) => {
      const body = stdin ? JSON.parse(stdin) as { query?: string; variables?: { thread?: string } } : {}
      calls.push({ argv, body })
      if (argv[1] === "graphql" && body.query?.includes("resolveReviewThread")) { thread.resolved = true; return { code: 0, out: JSON.stringify({ data: { resolveReviewThread: { thread: { id: thread.id, isResolved: true } } } }) } }
      if (argv[1] === "graphql") {
        const nodes = [{ id: thread.id, isResolved: thread.resolved, comments: { nodes: [{ body: `cancelOrder never refunds\n\n${findingMarker(NO_REFUND.id)}` }] } }]
        return { code: 0, out: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } }) }
      }
      return { code: 0, out: "[]" }
    }
    const kids = verifier("rejected")
    const run = await runPrReview({
      repo: "acme/app", number: 8, directory: repo.dir, base: repo.base, head: repo.fix, publish: true, gh, sessionFactory: kids.factory,
      state: { version: 1, lastHead: repo.reviewed, published: { [NO_REFUND.id]: { commentId: 4429610571, finding: NO_REFUND } } },
      recheck: [NO_REFUND],
    })
    expect(run.incremental).toBe(true)
    expect(run.fixed).toEqual([NO_REFUND.id])
    expect(thread.resolved).toBe(true)
    expect(run.state.published[NO_REFUND.id]).toMatchObject({ resolved: true, threadId: thread.id })
    // Item 2: the re-check's verify prompt pins the repository's language like every other verify prompt.
    const recheck = kids.prompts.find((prompt) => prompt.includes("These findings were reported on the previous head"))
    expect(recheck).toContain(languageInstruction("Español"))
  })

  test("a finding the round set out to fix but nobody published is re-checked too, and stays open when the verifier still finds it", async () => {
    const repo = await pullRequest()
    const kids = verifier("confirmed")
    const run = await runPrReview({
      repo: "acme/app", number: 8, directory: repo.dir, base: repo.base, head: repo.fix, publish: false, sessionFactory: kids.factory,
      state: { version: 1, lastHead: repo.reviewed, published: {} }, recheck: [NO_REFUND],
    })
    expect(run.fixed).toEqual([])
    expect(kids.prompts.some((prompt) => prompt.includes(NO_REFUND.summary))).toBe(true)
  })
})

describe("re-check language", () => {
  test("fixedFindings pins the language it is given in the verify prompt", async () => {
    const repo = await pullRequest()
    const context = await buildReviewContext({ directory: repo.dir, base: repo.reviewed, head: repo.fix, budgetTokens: 50_000 })
    const kids = verifier("confirmed")
    await fixedFindings({ sessionFactory: kids.factory, previous: [NO_REFUND], context, language: "Português" })
    expect(kids.prompts[0]).toContain(languageInstruction("Português"))
  })
})

describe("a fix round counts only what the re-check closed", () => {
  test("openAfterRound: the round's findings the re-check did not close stay open beside the new ones; one reported again is not doubled", () => {
    const fresh = PrFinding.parse({ ...ELSEWHERE, id: findingId({ path: "cancel.ts", line: 3, category: "correctness", summary: "new" }), path: "cancel.ts", line: 3, summary: "new" })
    expect(openAfterRound({ fixing: [NO_REFUND], found: [], fixed: [] }).map((finding) => finding.id)).toEqual([NO_REFUND.id])
    expect(openAfterRound({ fixing: [NO_REFUND], found: [], fixed: [NO_REFUND.id] })).toEqual([])
    expect(openAfterRound({ fixing: [NO_REFUND], found: [fresh], fixed: [] }).map((finding) => finding.id)).toEqual([fresh.id, NO_REFUND.id])
    // The same defect reported again on its moved line: kept once, as the review reported it.
    const moved = PrFinding.parse({ ...NO_REFUND, line: 9, id: findingId({ path: "cancel.ts", line: 9, category: "correctness", summary: NO_REFUND.summary }) })
    expect(openAfterRound({ fixing: [NO_REFUND], found: [moved], fixed: [] }).map((finding) => finding.id)).toEqual([moved.id])
    // A whole-PR review (no re-check): what it confirmed is what is open.
    expect(openAfterRound({ fixing: [NO_REFUND], found: [], fixed: undefined })).toEqual([])
  })

  const ledgerJob = () => {
    const ledger = createJobLedger({ file: path.join(temp(), "jobs.json"), now: () => 1_000 })
    const job = ledger.upsert({ provider: "github", repo: "acme/app", directory: "/x", number: 8, sessionId: "s", reviewer: "global", scope: "global", trigger: "opened", coverage: "full", base: "b".repeat(40), head: "c".repeat(40), configKey: "k" })
    return { ledger, jobId: job.id }
  }
  const pushed = async (): Promise<FixResult> => ({ ok: true, commit: "d".repeat(40), pushed: true })

  test("fix-once: a pushed fix whose re-check did not close the finding ends failed and names what is still open, never done", async () => {
    const { ledger, jobId } = ledgerJob()
    const asked: string[][] = []
    const outcome = await runFixLoop({
      jobId, ledger, maxRounds: 1, maxNoProgress: 2, controlOf: () => "reviewer", fix: pushed, validate: async () => ({ ok: true, detail: "" }),
      review: async (fixing) => { asked.push(fixing.map((finding) => finding.id)); return asked.length === 1 ? { open: [NO_REFUND] } : { open: openAfterRound({ fixing, found: [], fixed: [] }) } },
    })
    // The review after the push was given the round's finding to re-check.
    expect(asked).toEqual([[], [NO_REFUND.id]])
    expect(outcome).toMatchObject({ state: "failed", rounds: 1, open: [NO_REFUND.id], stop: { kind: "max_rounds", remaining: "1 confirmed finding still open (cancel.ts:8)" } })
    expect(ledger.get(jobId)!.checkpoint.rounds.map((round) => round.open)).toEqual([[NO_REFUND.id]])
  })

  test("fix-loop: what the re-check left open is the next round's work; once it closes, the loop ends done", async () => {
    const { ledger, jobId } = ledgerJob()
    const fixed: string[][] = []
    let reviews = 0
    const outcome = await runFixLoop({
      jobId, ledger, maxRounds: 3, maxNoProgress: 3, controlOf: () => "reviewer", validate: async () => ({ ok: true, detail: "" }),
      fix: async (findings) => { fixed.push(findings.map((finding) => finding.id)); return pushed() },
      review: async (fixing) => {
        reviews++
        if (reviews === 1) return { open: [NO_REFUND] }
        return { open: openAfterRound({ fixing, found: [], fixed: reviews === 2 ? [] : [NO_REFUND.id] }) }
      },
    })
    expect(fixed).toEqual([[NO_REFUND.id], [NO_REFUND.id]])
    expect(outcome).toMatchObject({ state: "done", rounds: 2, open: [] })
  })
})
