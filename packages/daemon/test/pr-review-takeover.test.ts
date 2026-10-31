import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PrFinding } from "@mendcode/protocol"
import type { JobState } from "../src/pr-review/contracts"
import { runFixLoop } from "../src/pr-review/fix-loop"
import { runFix } from "../src/pr-review/fix"
import { createJobLedger } from "../src/pr-review/jobs"
import { controlOf, holderOf, release, takeOver } from "../src/pr-review/takeover"

const cleanups: Array<() => unknown> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const NOW = 1_800_000_000_000
const finding: PrFinding = { id: "1".padStart(40, "0"), path: "a.ts", line: 1, side: "RIGHT", severity: "major", category: "correctness", summary: "s", detail: "d", evidence: [] }

function setup(state: JobState = "running") {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pr-takeover-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = createJobLedger({ file: path.join(dir, "jobs.json"), now: () => NOW })
  const job = ledger.upsert({ provider: "github", repo: "acme/app", directory: dir, number: 12, sessionId: "ses_1", reviewer: "global", scope: "global", trigger: "manual", coverage: "full", base: "b".repeat(40), head: "c".repeat(40), configKey: "k", state, fixSessionId: "ses_fix" })
  return { ledger, jobId: job.id, dir }
}

describe("take-over", () => {
  test("taking over pauses the job and gives the user control; no automatic fix or push runs until it is released", async () => {
    const { ledger, jobId, dir } = setup()
    const taken = takeOver({ ledger, jobId, now: () => NOW, by: "nora" })
    expect(taken.ok && taken.job).toMatchObject({ state: "paused", control: "user", stop: { kind: "user", resumable: true } })
    expect(controlOf(ledger, jobId)).toBe("user")
    // The fix loop yields at once: no review, no fix.
    const calls: string[] = []
    const loop = await runFixLoop({ jobId, ledger, review: async () => { calls.push("review"); return { open: [finding] } }, fix: async () => { calls.push("fix"); return { ok: true, commit: "e".repeat(40), pushed: true } }, validate: async () => ({ ok: true, detail: "" }), maxRounds: 3, maxNoProgress: 2, controlOf: () => controlOf(ledger, jobId) })
    expect(loop).toMatchObject({ state: "paused", stop: { kind: "user" } })
    expect(loop.stop?.detail).toContain("taken over by nora")
    expect(calls).toEqual([])
    // `runFix` backed by the ledger neither opens a fix session nor touches git.
    const git: string[][] = []
    const fixed = await runFix({ directory: dir, root: dir, number: 12, head: "c".repeat(40), branch: "feature", pushUrl: "origin", instructions: "x", checks: [], runChecks: async () => [], sessions: () => { throw new Error("a fix session started") }, controlOf: () => controlOf(ledger, jobId), git: async (args) => { git.push(args); return { code: 0, out: "", err: "" } } })
    expect(fixed).toMatchObject({ ok: false })
    expect(git).toEqual([])

    expect(release({ ledger, jobId, by: "nora" }).ok).toBe(true)
    expect(ledger.get(jobId)).toMatchObject({ state: "pending", control: "reviewer" })
    expect(ledger.get(jobId)!.stop).toBeUndefined()
    // Released, the loop runs again from its checkpoint.
    const resumed = await runFixLoop({ jobId, ledger, review: async () => ({ open: [] }), fix: async () => ({ ok: false, reason: "unused" }), validate: async () => ({ ok: true, detail: "" }), maxRounds: 3, maxNoProgress: 2, controlOf: () => controlOf(ledger, jobId) })
    expect(resumed.state).toBe("done")
  })

  test("a second take-over of a held job is refused with who holds it; only the holder releases it", () => {
    const { ledger, jobId } = setup("pending")
    expect(takeOver({ ledger, jobId, now: () => NOW, by: "nora" }).ok).toBe(true)
    const second = takeOver({ ledger, jobId, now: () => NOW + 1, by: "omar" })
    expect(second).toEqual({ ok: false, reason: "[PR_REVIEW]: the job is already taken over by nora", holder: "nora" })
    expect(holderOf(ledger.get(jobId)!)).toBe("nora")
    expect(release({ ledger, jobId, by: "omar" })).toMatchObject({ ok: false, holder: "nora" })
    expect(ledger.get(jobId)!.control).toBe("user")
    expect(release({ ledger, jobId, by: "omar", force: true }).ok).toBe(true)
    expect(release({ ledger, jobId, by: "nora" })).toMatchObject({ ok: false, reason: "[PR_REVIEW]: the job is not taken over" })
  })

  test("a job paused for another reason can be taken over; a finished job has no writer to stop", () => {
    const paused = setup("paused")
    expect(takeOver({ ledger: paused.ledger, jobId: paused.jobId, now: () => NOW }).ok).toBe(true)
    expect(paused.ledger.get(paused.jobId)).toMatchObject({ state: "paused", control: "user" })
    const finished = setup("pending")
    finished.ledger.transition(finished.jobId, "cancelled")
    expect(takeOver({ ledger: finished.ledger, jobId: finished.jobId, now: () => NOW })).toMatchObject({ ok: false })
    expect(takeOver({ ledger: finished.ledger, jobId: "prj_missing", now: () => NOW })).toMatchObject({ ok: false, reason: "[PR_REVIEW]: no job prj_missing" })
  })

  test("a take-over during a fix round stops the loop before it writes again, leaving the job paused", async () => {
    const { ledger, jobId } = setup()
    const calls: string[] = []
    let reviews = 0
    const loop = await runFixLoop({
      jobId, ledger, maxRounds: 5, maxNoProgress: 3, controlOf: () => controlOf(ledger, jobId),
      review: async () => { calls.push("review"); return { open: reviews++ === 0 ? [finding, { ...finding, id: "2".padStart(40, "0") }] : [finding] } },
      // The user takes over while the first fix runs: that round's result is recorded, then nothing more is fixed.
      fix: async () => { calls.push("fix"); takeOver({ ledger, jobId, now: () => NOW, by: "nora" }); return { ok: true, commit: "e".repeat(40), pushed: true } },
      validate: async () => { calls.push("validate"); return { ok: true, detail: "" } },
    })
    expect(loop.state).toBe("paused")
    expect(calls).toEqual(["review", "fix"])
    expect(ledger.get(jobId)).toMatchObject({ state: "paused", control: "user" })
    expect(ledger.get(jobId)!.checkpoint.rounds.map((round) => round.commit)).toEqual(["e".repeat(40)])
  })

  test("a take-over during the validation, the review after a fix, or a failing turn never throws and never moves the job again", async () => {
    const two = [finding, { ...finding, id: "2".padStart(40, "0") }]
    for (const at of ["validate", "review", "turn", "empty-validate"] as const) {
      const { ledger, jobId } = setup()
      const calls: string[] = []
      let reviews = 0
      const grab = (step: string) => { if (step === at) takeOver({ ledger, jobId, now: () => NOW, by: "nora" }) }
      const loop = await runFixLoop({
        jobId, ledger, maxRounds: 5, maxNoProgress: 3, controlOf: () => controlOf(ledger, jobId),
        review: async () => { calls.push("review"); if (reviews++ === 1) grab("review"); return { open: at === "empty-validate" ? [] : reviews === 1 ? two : [finding] } },
        fix: async () => { calls.push("fix"); if (at === "turn") { grab("turn"); throw new Error("[PR_REVIEW]: the review turn stopped") } return { ok: true, commit: "e".repeat(40), pushed: true } },
        validate: async () => { calls.push("validate"); grab("validate"); grab("empty-validate"); return { ok: true, detail: "" } },
      })
      expect({ at, state: loop.state, stop: loop.stop?.kind }).toEqual({ at, state: "paused", stop: "user" })
      expect(ledger.get(jobId)).toMatchObject({ state: "paused", control: "user" })
      expect(calls.filter((call) => call === "fix").length).toBeLessThanOrEqual(1)
    }
  })

  test("a controlOf that reports the user (without the ledger knowing) pauses the job itself before the next write", async () => {
    const { ledger, jobId } = setup()
    let user = false
    const loop = await runFixLoop({
      jobId, ledger, maxRounds: 5, maxNoProgress: 3, controlOf: () => user ? "user" : "reviewer",
      review: async () => ({ open: [finding] }),
      fix: async () => { user = true; return { ok: true, commit: "e".repeat(40), pushed: true } },
      validate: async () => { throw new Error("validated after the user took over") },
    })
    expect(loop).toMatchObject({ state: "paused", stop: { kind: "user" } })
    expect(ledger.get(jobId)!.state).toBe("paused")
  })
})
