import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PrFinding } from "@mendcode/protocol"
import type { FixResult } from "../src/pr-review/commands"
import type { JobState } from "../src/pr-review/contracts"
import { roundsFor, runFixLoop, type FixLoopInput } from "../src/pr-review/fix-loop"
import { createJobLedger } from "../src/pr-review/jobs"
import { ReviewTurnError } from "../src/pr-review/sessions"

const cleanups: Array<() => unknown> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pr-fix-loop-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

const finding = (n: number): PrFinding => ({ id: n.toString(16).padStart(40, "0"), path: "a.ts", line: n, side: "RIGHT", severity: "major", category: "correctness", summary: `finding ${n}`, detail: "d", evidence: ["a.ts:1"] })
const NOW = 1_800_000_000_000

/** The real job ledger in a temp dir, with one pending job, and every state the job passes through. */
function setup(state: JobState = "pending") {
  const ledger = createJobLedger({ file: path.join(temp(), "jobs.json"), now: () => NOW })
  const job = ledger.upsert({ provider: "github", repo: "acme/app", directory: "/x", number: 12, sessionId: "ses_1", reviewer: "global", scope: "global", trigger: "manual", coverage: "full", base: "b".repeat(40), head: "c".repeat(40), configKey: "k", state })
  const states: JobState[] = []
  const transition = ledger.transition.bind(ledger)
  ledger.transition = (id, next, patch) => { states.push(next); return transition(id, next, patch) }
  return { ledger, jobId: job.id, states }
}

/** A scripted loop: each review answers the next open set; fixes push a fresh commit unless `fixes` says otherwise. */
function script(opens: number[][], extra: Partial<FixLoopInput> = {}) {
  const calls: string[] = []
  let review = 0, fixes = 0
  const input = {
    review: async () => { calls.push("review"); return { open: (opens[Math.min(review++, opens.length - 1)] ?? []).map(finding) } },
    fix: async (findings: PrFinding[]): Promise<FixResult> => { calls.push(`fix ${findings.length}`); return { ok: true, commit: (++fixes).toString(16).padStart(40, "f"), pushed: true, sessionId: "ses_fix" } },
    validate: async () => { calls.push("validate"); return { ok: true, detail: "checks passed" } },
    maxRounds: 5,
    maxNoProgress: 2,
    controlOf: () => "reviewer" as const,
    now: () => NOW,
    ...extra,
  }
  return { input, calls }
}

describe("runFixLoop", () => {
  test("two fix rounds that leave nothing open end done; each round is in the checkpoint with what stayed open and its commit", async () => {
    const { ledger, jobId, states } = setup()
    const { input, calls } = script([[1, 2, 3], [3], []])
    const done = await runFixLoop({ jobId, ledger, ...input })
    expect(done).toMatchObject({ state: "done", rounds: 2, open: [] })
    expect(calls).toEqual(["review", "fix 3", "validate", "review", "fix 1", "validate", "review"])
    expect(states).toEqual(["running", "fixing", "validating", "fixing", "validating", "done"])
    const job = ledger.get(jobId)!
    expect(job.state).toBe("done")
    expect(job.fixSessionId).toBe("ses_fix")
    expect(job.checkpoint.rounds.map((round) => round.open.length)).toEqual([1, 0])
    expect(job.checkpoint.rounds.map((round) => round.commit?.slice(-1))).toEqual(["1", "2"])
  })

  test("an open set that does not shrink for maxNoProgress rounds stops with no_progress, in rounds", async () => {
    const { ledger, jobId } = setup()
    const { input, calls } = script([[1, 2], [1, 3], [4, 5]])
    const done = await runFixLoop({ jobId, ledger, ...input })
    expect(done.state).toBe("failed")
    expect(done.rounds).toBe(2)
    expect(done.stop).toMatchObject({ kind: "no_progress", unit: "rounds", used: 2, limit: 2, resumable: false, remaining: "2 confirmed findings still open (a.ts:4, a.ts:5)" })
    expect(calls.filter((call) => call.startsWith("fix"))).toHaveLength(2)
    expect(ledger.get(jobId)!.stop?.kind).toBe("no_progress")
  })

  test("max rounds stops with max_rounds; fix-once is one round and review alone runs none", async () => {
    expect([roundsFor("review", 3), roundsFor("fix-once", 3), roundsFor("fix-loop", 3)]).toEqual([0, 1, 3])
    const { ledger, jobId } = setup()
    const { input, calls } = script([[1, 2], [1]], { maxRounds: roundsFor("fix-once", 3) })
    const done = await runFixLoop({ jobId, ledger, ...input })
    expect(done).toMatchObject({ state: "failed", rounds: 1, open: [finding(1).id] })
    expect(done.stop).toMatchObject({ kind: "max_rounds", used: 1, limit: 1, unit: "rounds" })
    expect(calls).toEqual(["review", "fix 2", "validate", "review"])
  })

  test("a failed validation never ends done: not when the review finds nothing, and not after the last round's fix", async () => {
    const empty = setup()
    const clean = script([[]], { validate: async () => ({ ok: false, detail: "bun test exited with 1" }) })
    const first = await runFixLoop({ jobId: empty.jobId, ledger: empty.ledger, ...clean.input })
    expect(first.state).toBe("failed")
    expect(first.stop?.detail).toContain("bun test exited with 1")
    expect(empty.ledger.get(empty.jobId)!.state).toBe("failed")

    const fixed = setup()
    let validations = 0
    const broken = script([[1], []], { validate: async () => { validations++; return { ok: false, detail: "typecheck failed" } } })
    const second = await runFixLoop({ jobId: fixed.jobId, ledger: fixed.ledger, ...broken.input })
    expect(second.state).toBe("failed")
    expect(second.stop?.detail).toContain("typecheck failed")
    // The validation of the round's fix is the one that counts: it is not run a second time to get a different answer.
    expect(broken.calls).toEqual(["review", "fix 1", "review"])
    expect(validations).toBe(1)
  })

  test("a fix kept locally (fix.push off) ends after its round with the ref, and says it was not pushed", async () => {
    const { ledger, jobId } = setup()
    const { input, calls } = script([[1]], { fix: async () => ({ ok: true, commit: "e".repeat(40), pushed: false, kept: "refs/mendcode/fix/12/1" }) })
    const done = await runFixLoop({ jobId, ledger, ...input })
    expect(done).toMatchObject({ state: "done", rounds: 1, kept: "refs/mendcode/fix/12/1" })
    expect(done.stop).toMatchObject({ kind: "permission", resumable: false })
    expect(done.stop?.detail).toContain("not pushed")
    expect(calls).toEqual(["review", "validate"])
    expect(ledger.get(jobId)!.checkpoint.rounds[0]!.commit).toBe("e".repeat(40))
  })

  test("a fix whose branch moved ends stale with its kept ref; a refused push fails with the reason", async () => {
    const moved = setup()
    const stale = await runFixLoop({ jobId: moved.jobId, ledger: moved.ledger, ...script([[1]], { fix: async () => ({ ok: false, reason: "the branch moved", stale: true, kept: "refs/mendcode/fix/12/2", commit: "d".repeat(40) }) }).input })
    expect(stale).toMatchObject({ state: "stale", kept: "refs/mendcode/fix/12/2" })
    expect(moved.ledger.get(moved.jobId)!.state).toBe("stale")
    const refused = setup()
    const failed = await runFixLoop({ jobId: refused.jobId, ledger: refused.ledger, ...script([[1]], { fix: async () => ({ ok: false, reason: "git push was refused", kept: "refs/mendcode/fix/12/3" }) }).input })
    expect(failed).toMatchObject({ state: "failed", kept: "refs/mendcode/fix/12/3" })
    expect(failed.stop?.detail).toContain("git push was refused")
  })

  test("while the user holds the job no fix runs: the loop stops with a user stop reason and leaves the job paused", async () => {
    const { ledger, jobId } = setup()
    const { input, calls } = script([[1, 2]], { controlOf: () => "user" })
    const done = await runFixLoop({ jobId, ledger, ...input })
    expect(done.state).toBe("paused")
    expect(done.stop).toMatchObject({ kind: "user", resumable: true })
    // Not even a review: the user's session is the only one working on the job.
    expect(calls).toEqual([])
    expect(ledger.get(jobId)!.state).toBe("paused")
  })

  test("a quota or rate limit in a turn checkpoints the job with its reset instead of failing it; the rounds done stay", async () => {
    const { ledger, jobId } = setup()
    let reviews = 0
    const { input } = script([[1, 2]], {
      review: async () => { if (reviews++ === 1) throw new ReviewTurnError("[PR_REVIEW]: the review turn failed: Claude AI usage limit reached|1800003600", "quota", NOW + 3_600_000); return { open: [finding(1), finding(2)] } },
    })
    const done = await runFixLoop({ jobId, ledger, ...input })
    expect(done.state).toBe("checkpointed")
    expect(done.stop).toMatchObject({ kind: "quota", resumable: true, resetsAt: NOW + 3_600_000 })
    const job = ledger.get(jobId)!
    expect(job).toMatchObject({ state: "checkpointed", notBefore: NOW + 3_600_000 })
    expect(job.checkpoint.rounds).toHaveLength(0)
    // Resumed: the checkpointed job runs again from pending and finishes; the earlier round is not lost.
    const resumed = await runFixLoop({ jobId, ledger, ...script([[1], []]).input })
    expect(resumed.state).toBe("done")
  })

  test("a resumed loop counts the rounds its checkpoint already holds against maxRounds", async () => {
    const { ledger, jobId } = setup()
    ledger.checkpoint(jobId, { rounds: [{ at: 1, open: [finding(1).id, finding(2).id] }, { at: 2, open: [finding(1).id] }] })
    const { input, calls } = script([[1]], { maxRounds: 2 })
    const done = await runFixLoop({ jobId, ledger, ...input })
    expect(done).toMatchObject({ state: "failed", rounds: 2 })
    expect(done.stop?.kind).toBe("max_rounds")
    expect(calls).toEqual(["review"])
  })
})
