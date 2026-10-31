import { describe, expect, test } from "bun:test"
import { PrFinding } from "@mendcode/protocol"
import { ReviewConfig } from "../src/pr-review/config"
import type { PhaseFacts } from "../src/pr-review/contracts"
import { checkPhaseList, phaseFacts, planPhases, progressStop, reviewStages, validationGate } from "../src/pr-review/phases"

const phasesOf = (input: unknown) => ReviewConfig.parse({ phases: input }).phases
const facts = (extra: Partial<PhaseFacts> = {}): PhaseFacts => ({ files: ["src/a.ts", "src/b.ts", "src/c.ts"], changedLines: 120, stacked: false, fixMode: "review", ...extra })
const ids = (plan: ReturnType<typeof planPhases>) => plan.phases.map((phase) => phase.id)

describe("phase plans", () => {
  test("the default dynamic preset is discovery, analysis, corroboration and validation; fix only joins when fix.mode is not review", () => {
    const review = planPhases({ config: phasesOf({}), facts: facts() })
    expect(review.mode).toBe("dynamic")
    expect(ids(review)).toEqual(["discovery", "analysis", "corroboration", "validation"])
    expect(review.phases.find((phase) => phase.id === "discovery")?.prompt).toContain("map the change's scope")
    const fixing = planPhases({ config: phasesOf({}), facts: facts({ fixMode: "fix-once" }) })
    expect(ids(fixing)).toEqual(["discovery", "analysis", "corroboration", "fix", "validation"])
    expect(fixing.phases.find((phase) => phase.id === "fix")?.reason).toContain("fix.mode is fix-once")
  })

  test("dynamic stages join from evidence, each with a recorded reason: migrations, security, contracts and stack", () => {
    const plan = planPhases({ config: phasesOf({}), facts: facts({ files: ["db/migrations/001_users.sql", "src/auth/session.ts", "packages/protocol/src/user.ts", "src/ui.ts"], stacked: true }) })
    expect(ids(plan)).toEqual(["discovery", "analysis", "migrations", "security", "contracts", "stack", "corroboration", "validation"])
    const added = Object.fromEntries(plan.decisions.filter((decision) => decision.action === "added").map((decision) => [decision.phase, decision.reason]))
    expect(added.migrations).toContain("db/migrations/001_users.sql")
    expect(added.security).toContain("src/auth/session.ts")
    expect(added.contracts).toContain("packages/protocol/src/user.ts")
    expect(added.stack).toContain("stacked")
    for (const id of ["migrations", "security", "contracts", "stack"]) expect(plan.phases.find((phase) => phase.id === id)?.source).toBe("dynamic")
  })

  test("security also joins on high risk; a path that only contains the word (author.ts) adds nothing; a tiny change skips discovery and says why", () => {
    expect(ids(planPhases({ config: phasesOf({}), facts: facts({ risk: "high" }) }))).toContain("security")
    const quiet = planPhases({ config: phasesOf({}), facts: facts({ files: ["src/author.ts"], changedLines: 12 }) })
    expect(ids(quiet)).toEqual(["analysis", "corroboration", "validation"])
    expect(quiet.decisions).toContainEqual({ phase: "discovery", action: "skipped", reason: expect.stringContaining("a small change (1 file, 12 changed lines)") })
  })

  test("in dynamic mode the list disables, rewrites and adds stages, and its conditions decide with a reason", () => {
    const plan = planPhases({
      config: phasesOf({ list: [
        { id: "security", enabled: false },
        { id: "contracts", prompt: "Check the OpenAPI file against the handlers." },
        { id: "perf", prompt: "Look for N+1 queries.", when: { paths: ["src/db/**"] } },
        { id: "docs", prompt: "Check the docs mention it.", when: { min_lines: 500 } },
      ] }),
      facts: facts({ files: ["src/auth/login.ts", "api/openapi.yaml", "src/db/users.ts"] }),
    })
    expect(ids(plan)).toEqual(["discovery", "analysis", "contracts", "perf", "corroboration", "validation"])
    expect(plan.phases.find((phase) => phase.id === "contracts")?.prompt).toBe("Check the OpenAPI file against the handlers.")
    expect(plan.decisions).toContainEqual({ phase: "security", action: "skipped", reason: "disabled in phases.list" })
    expect(plan.decisions).toContainEqual({ phase: "perf", action: "added", reason: expect.stringContaining("`src/db/users.ts` match src/db/**") })
    expect(plan.decisions).toContainEqual({ phase: "docs", action: "skipped", reason: expect.stringContaining("120 changed lines (at least 500 asked)") })
    expect(reviewStages(plan)).toEqual([
      { id: "discovery", prompt: expect.stringContaining("scope") },
      { id: "contracts", prompt: "Check the OpenAPI file against the handlers." },
      { id: "perf", prompt: "Look for N+1 queries." },
    ])
  })

  test("fixed mode uses the list in its order and adds back the controls a list cannot remove, saying so", () => {
    const plan = planPhases({
      config: phasesOf({ mode: "fixed", list: [{ id: "analysis", prompt: "Focus on the parser." }, { id: "i18n", prompt: "Every new string is translated." }, { id: "corroboration", enabled: false }] }),
      facts: facts({ fixMode: "fix-loop", files: ["src/auth/x.ts"] }),
    })
    expect(plan.mode).toBe("fixed")
    // No dynamic additions in fixed mode, even with an auth path.
    expect(ids(plan)).toEqual(["analysis", "i18n", "corroboration", "fix", "validation"])
    expect(plan.decisions).toContainEqual({ phase: "corroboration", action: "kept", reason: expect.stringContaining("a control a list cannot remove") })
    expect(plan.decisions).toContainEqual({ phase: "validation", action: "kept", reason: expect.stringContaining("not in phases.list") })
    expect(plan.decisions).toContainEqual({ phase: "fix", action: "kept", reason: expect.stringContaining("fix.mode is fix-loop") })
    expect(reviewStages(plan).map((stage) => stage.id)).toEqual(["analysis", "i18n"])
  })

  test("none shows no stages but keeps the operational states, and ignores the list's prompts", () => {
    const plan = planPhases({ config: phasesOf({ mode: "none", list: [{ id: "perf", prompt: "x" }] }), facts: facts({ fixMode: "fix-once" }) })
    expect(plan.mode).toBe("none")
    expect(ids(plan)).toEqual(["analysis", "corroboration", "fix", "validation"])
    expect(plan.phases.every((phase) => phase.reason.includes("phases: none shows no stages"))).toBe(true)
    expect(reviewStages(plan)).toEqual([])
    expect(plan.decisions).toEqual([])
  })

  test("an invalid list is reported (duplicates, missing or disabled analysis, order) and the plan falls back to the preset with the reason", () => {
    expect(checkPhaseList(phasesOf({ mode: "fixed", list: [{ id: "analysis" }, { id: "analysis" }] }).list, "fixed")).toEqual([expect.stringContaining("listed twice")])
    expect(checkPhaseList(phasesOf({ mode: "fixed", list: [{ id: "discovery" }] }).list, "fixed")).toEqual(["a fixed list needs `analysis`, the review pass"])
    expect(checkPhaseList(phasesOf({ list: [{ id: "analysis", enabled: false }] }).list, "dynamic")).toEqual(["`analysis` cannot be disabled: it is the review pass"])
    expect(checkPhaseList(phasesOf({ mode: "fixed", list: [{ id: "analysis" }, { id: "validation" }, { id: "corroboration" }] }).list, "fixed")).toEqual([expect.stringContaining("the order is discovery → analysis → corroboration → fix → validation")])
    expect(checkPhaseList(phasesOf({ mode: "fixed", list: [{ id: "analysis" }, { id: "corroboration" }, { id: "late" }] }).list, "fixed")).toEqual([expect.stringContaining("a stage of your own runs in the review pass, before corroboration")])
    const fallback = planPhases({ config: phasesOf({ mode: "fixed", list: [{ id: "i18n", prompt: "x" }, { id: "i18n" }] }), facts: facts() })
    expect(ids(fallback)).toEqual(["discovery", "analysis", "corroboration", "validation"])
    expect(fallback.decisions[0]).toEqual({ phase: "plan", action: "skipped", reason: expect.stringContaining("phases.list was not used") })
  })

  test("a phase cannot carry tools or permissions: the config refuses any key beyond id, enabled, prompt and when", () => {
    expect(ReviewConfig.safeParse({ phases: { list: [{ id: "deploy", tools: ["bash"] }] } }).success).toBe(false)
    expect(ReviewConfig.safeParse({ phases: { list: [{ id: "deploy", permissions: "write" }] } }).success).toBe(false)
  })

  test("phase facts come from the review context's changed files and touched lines", () => {
    const made = phaseFacts({ context: { files: [{ path: "a.ts", text: "", right: new Set(), touched: [1, 2, 3], deleted: false }, { path: "b.ts", text: "", right: new Set(), touched: [9], deleted: false }] }, fixMode: "review", stacked: true, risk: "medium" })
    expect(made).toEqual({ files: ["a.ts", "b.ts"], changedLines: 4, stacked: true, fixMode: "review", risk: "medium" })
  })
})

describe("deterministic gates", () => {
  const confirmed = PrFinding.parse({ id: "a".repeat(40), path: "a.ts", line: 1, side: "RIGHT", severity: "major", category: "correctness", summary: "s", detail: "d", evidence: [], verdict: "confirmed" })
  test("validation passes only complete, verified work with passing checks and no open confirmed finding", () => {
    expect(validationGate({ complete: true, verified: true })).toEqual({ ok: true, reason: "complete and verified" })
    expect(validationGate({ complete: false, verified: true }).ok).toBe(false)
    expect(validationGate({ complete: true, verified: false }).ok).toBe(false)
    expect(validationGate({ complete: true, verified: true, checks: [{ command: "bun test", code: 1 }] })).toEqual({ ok: false, reason: "1 check did not pass: `bun test` (exit 1)" })
    expect(validationGate({ complete: true, verified: true, checks: [{ command: "bun test", code: 0 }], open: [confirmed] })).toEqual({ ok: false, reason: "1 confirmed finding still open" })
    expect(validationGate({ complete: true, verified: true, checks: [{ command: "bun test", code: 0 }] })).toEqual({ ok: true, reason: "complete and verified; 1 check passed" })
  })
  test("the no-progress guard stops after max rounds in a row that fixed nothing, and not while findings get fixed", () => {
    const round = (open: string[]) => ({ at: 0, open })
    expect(progressStop({ rounds: [round(["a", "b"]), round(["b"]), round(["c"])], max: 2 })).toBeUndefined()
    expect(progressStop({ rounds: [round(["a", "b"]), round(["a", "b"]), round(["a", "b", "c"])], max: 2 })).toMatchObject({ kind: "no_progress", unit: "rounds", used: 2, limit: 2, resumable: false, remaining: "3 confirmed findings open" })
    expect(progressStop({ rounds: [round(["a"]), round(["a"])], max: 2 })).toBeUndefined()
  })
})
