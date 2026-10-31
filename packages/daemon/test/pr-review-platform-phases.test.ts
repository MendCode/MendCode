import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PrFinding } from "@mendcode/protocol"
import { parseReviewConfig } from "../src/pr-review/config"
import { findingId } from "../src/pr-review/findings"
import { createJobLedger } from "../src/pr-review/jobs"
import { phasesBefore, planPhases, progressStop, validationGate } from "../src/pr-review/phases"

/**
 * Platform scenarios for review stages (docs/pr-review.md, "Stages"): the repository's YAML parsed as the daemon parses it, the
 * plan for a concrete change, its decisions kept on the job across a restart, and the deterministic closing gate. No model call.
 */

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const config = (yaml: string) => { const parsed = parseReviewConfig(yaml); expect(parsed.problem).toBeUndefined(); return parsed.config }
const open = PrFinding.parse({ id: findingId({ path: "a.ts", line: 1, category: "correctness", summary: "x" }), path: "a.ts", line: 1, side: "RIGHT", severity: "major", category: "correctness", summary: "x", detail: "d", evidence: ["a.ts:1"], verdict: "confirmed" })

describe("platform phases: dynamic stages with a visible reason", () => {
  test("a stacked change to a migration and an auth module adds those stages with their evidence, and the decisions survive a restart on the job", () => {
    const repo = config("phases:\n  mode: dynamic\n")
    const plan = planPhases({ config: repo.phases, facts: { files: ["db/migrations/0042_users.sql", "src/auth/session.ts", "src/ui/button.tsx"], changedLines: 140, stacked: true, fixMode: repo.fix.mode } })
    expect(plan.phases.map((phase) => phase.id)).toEqual(["discovery", "analysis", "migrations", "security", "stack", "corroboration", "validation"])
    expect(plan.decisions).toEqual([
      { phase: "migrations", action: "added", reason: "`db/migrations/0042_users.sql` is a migration or schema path" },
      { phase: "security", action: "added", reason: "`src/auth/session.ts` touches authentication, permissions, secrets or crypto" },
      { phase: "stack", action: "added", reason: "the pull request is stacked on another open pull request" },
    ])
    // A plain small change gets no extra stage, and says why it skipped discovery.
    const small = planPhases({ config: repo.phases, facts: { files: ["README.md"], changedLines: 3, stacked: false, fixMode: "review" } })
    expect(small.phases.map((phase) => phase.id)).toEqual(["analysis", "corroboration", "validation"])
    expect(small.decisions[0]).toMatchObject({ phase: "discovery", action: "skipped" })

    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mc-platform-phases-")))
    temps.push(dir)
    const file = path.join(dir, "pr-review", "jobs.json")
    const jobs = createJobLedger({ file, now: () => 1_000 })
    const job = jobs.upsert({ provider: "github", repo: "acme/app", directory: "/tmp/acme", number: 12, sessionId: "s1", reviewer: "global", scope: "global", trigger: "opened", coverage: "full", base: "b".repeat(40), head: "a".repeat(40), configKey: "cfg1" })
    jobs.transition(job.id, "running")
    jobs.checkpoint(job.id, { phase: "corroboration", completedPhases: phasesBefore(plan, "corroboration"), decisions: plan.decisions })
    const restarted = createJobLedger({ file, now: () => 2_000 })
    expect(restarted.get(job.id)!.checkpoint.decisions).toEqual(plan.decisions)
    expect(restarted.get(job.id)!.checkpoint.completedPhases).toEqual(["discovery", "analysis", "migrations", "security", "stack"])
  })
  test("a list cannot remove the verify pass or the closing gate, and an invalid list falls back to the preset with the reason", () => {
    const trimmed = config("phases:\n  mode: fixed\n  list:\n    - id: analysis\n    - id: corroboration\n      enabled: false\n")
    const plan = planPhases({ config: trimmed.phases, facts: { files: ["a.ts"], changedLines: 10, stacked: false, fixMode: "review" } })
    expect(plan.phases.map((phase) => phase.id)).toEqual(["analysis", "corroboration", "validation"])
    expect(plan.decisions.map((decision) => [decision.phase, decision.action])).toEqual([["corroboration", "kept"], ["validation", "kept"]])
    const broken = config("phases:\n  mode: fixed\n  list:\n    - id: analysis\n    - id: analysis\n")
    const fallback = planPhases({ config: broken.phases, facts: { files: ["a.ts"], changedLines: 10, stacked: false, fixMode: "fix-once" } })
    expect(fallback.decisions[0]).toMatchObject({ phase: "plan", action: "skipped" })
    expect(fallback.phases.map((phase) => phase.id)).toEqual(["discovery", "analysis", "corroboration", "fix", "validation"])
  })
  test("phases: none hides the stages but keeps the operational states, including validation", () => {
    const quiet = config("preset: quiet\n")
    const plan = planPhases({ config: quiet.phases, facts: { files: ["a.ts"], changedLines: 10, stacked: false, fixMode: "review" } })
    expect(plan.mode).toBe("none")
    expect(plan.phases.map((phase) => phase.id)).toEqual(["analysis", "corroboration", "validation"])
  })
})

describe("platform phases: closing", () => {
  test("validation is a deterministic gate: unverified, incomplete, a failing check or an open finding is never done", () => {
    expect(validationGate({ complete: true, verified: false })).toEqual({ ok: false, reason: "verification failed: nothing is confirmed" })
    expect(validationGate({ complete: false, verified: true }).ok).toBe(false)
    expect(validationGate({ complete: true, verified: true, checks: [{ command: "bun test", code: 1 }] })).toEqual({ ok: false, reason: "1 check did not pass: `bun test` (exit 1)" })
    expect(validationGate({ complete: true, verified: true, open: [open] }).ok).toBe(false)
    expect(validationGate({ complete: true, verified: true, checks: [{ command: "bun test", code: 0 }] })).toEqual({ ok: true, reason: "complete and verified; 1 check passed" })
  })
  test("rounds that fix nothing stop after max_rounds_without_progress with the reason in rounds", () => {
    const rounds = [{ at: 1, open: ["a", "b"] }, { at: 2, open: ["a", "b"] }, { at: 3, open: ["b", "a"] }]
    expect(progressStop({ rounds, max: 2 })).toMatchObject({ kind: "no_progress", unit: "rounds", used: 2, limit: 2, resumable: false, remaining: "2 confirmed findings open" })
    expect(progressStop({ rounds: [...rounds.slice(0, 2), { at: 3, open: ["b"] }], max: 2 })).toBeUndefined()
  })
})
