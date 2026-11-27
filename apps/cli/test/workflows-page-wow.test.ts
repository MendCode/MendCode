import { describe, expect, test } from "bun:test"
import { createIdFactory, type WorkflowSummary, type WorkflowTaskSummary } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { renderWorkflowsPage, workflowsPageKey, type SavedWorkflow, type WorkflowsPageState } from "../src/view/workflows-page"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const MIN = 60_000
const task = (id: string, over: Partial<WorkflowTaskSummary> = {}): WorkflowTaskSummary => ({ id, title: id, kind: "agent", mode: "read", needs: [], state: "pending", attempt: 0, ...over })
const text = (line: Line) => line.map((span) => span.text).join("")

function run(state: WorkflowSummary["state"], over: Partial<WorkflowSummary> = {}): WorkflowSummary {
  const live = state === "running"
  return {
    workflowId: ids("workflow"), name: "api-migration", directory: "/Users/dev/Code/app", objective: "Port the API", planHash: "a".repeat(64), permission: "edits", state,
    rootSessionId: ids("session"), rounds: 0, repairs: 0, startedAt: NOW - 10 * MIN, updatedAt: NOW - 500,
    tasks: [
      task("a1", { label: "Survey", phase: "Plan", state: "done", startedAt: NOW - 9 * MIN, endedAt: NOW - 8 * MIN, produced: "14 endpoints" }),
      task("a2", { label: "Callers", phase: "Plan", state: "done", startedAt: NOW - 9 * MIN, endedAt: NOW - 8 * MIN, produced: "4 modules" }),
      task("b1", { label: "Migrate one", phase: "Build", state: live ? "running" : "done", startedAt: NOW - 6 * MIN, latest: "editing users.ts", usage: { input: 20_000, output: 6_000, costMicros: 150_000, calls: 1, children: 0 } }),
      task("b2", { label: "Migrate two", phase: "Build", state: live ? "pending" : "done" }),
    ],
    script: {
      hash: "ab".repeat(32), origin: "model", host: live ? "running" : "done", calls: 4, phases: [
        { title: "Plan", state: "done", completed: 2, total: 2, agents: 2, checks: 0 },
        { title: "Build", state: live ? "running" : "done", completed: live ? 0 : 2, total: 2, agents: 2, checks: 0 },
      ],
      budget: { agents: 10 }, usage: { agents: 4, tokens: 380_000, costMicros: 1_400_000 }, counts: { pending: 1, running: 1, done: 2, failed: 0 }, omitted: 0, logs: [],
    },
    ...over,
  } as WorkflowSummary
}

const inRun = (one: WorkflowSummary, extra: Partial<WorkflowsPageState> = {}): WorkflowsPageState => ({ scope: "project", focus: "run", row: `r:${one.workflowId}`, ...extra })
const screen = (one: WorkflowSummary, state: WorkflowsPageState, width = 100, extra: { frame?: number; still?: boolean } = {}) =>
  renderWorkflowsPage({ runs: [one], state, width, height: 40, now: NOW, ...extra }).map(text).join("\n")

describe("r, s and f on /workflows", () => {
  test("r asks first, and a second r restarts the agent under the cursor", () => {
    const one = run("running")
    let state = inRun(one, { step: "t:b1" })
    const asked = workflowsPageKey(state, "r", [one])
    expect(asked.action.type).toBe("none")
    expect(asked.state.confirm).toEqual({ kind: "restart", workflowId: one.workflowId, taskId: "b1" })
    expect(screen(one, asked.state)).toContain('run "Migrate one" again? r/y confirm')
    state = asked.state
    expect(workflowsPageKey(state, "r", [one]).action).toEqual({ type: "retry", workflowId: one.workflowId, taskId: "b1" })
    expect(workflowsPageKey(state, "n", [one]).action.type).toBe("none")
  })

  test("r on a step that has not started, or on a finished run, does nothing", () => {
    const one = run("running")
    expect(workflowsPageKey(inRun(one, { step: "t:b2" }), "r", [one]).state.confirm).toBeUndefined()
    const done = run("completed")
    expect(workflowsPageKey(inRun(done, { step: "t:b1" }), "r", [done]).state.confirm).toBeUndefined()
  })

  test("s asks to save the run under a name", () => {
    const one = run("completed")
    expect(workflowsPageKey(inRun(one), "s", [one]).action).toEqual({ type: "save", workflowId: one.workflowId })
  })

  test("f steps through the filters and back to every run, and the list shows only what matches", () => {
    const live = run("running"), failed = run("failed", { name: "broken" })
    let state: WorkflowsPageState = { scope: "project", focus: "list" }
    const seen: Array<string | undefined> = []
    for (let i = 0; i < 5; i++) {
      state = workflowsPageKey(state, "f", [live, failed]).state
      seen.push(state.filter)
    }
    expect(seen).toEqual(["active", "needs", "failed", "done", undefined])
    const onlyFailed = renderWorkflowsPage({ runs: [live, failed], state: { scope: "project", focus: "list", filter: "failed" }, width: 100, height: 20, now: NOW }).map(text).join("\n")
    expect(onlyFailed).toContain("broken")
    expect(onlyFailed).not.toContain("api-migration")
  })

  test("the Saved tab lists them, enter types the command and r runs it now", () => {
    const saved: SavedWorkflow[] = [{ name: "audit", kind: "script", source: "user", description: "Audit every package" }, { name: "bad", kind: "script", source: "project", problem: "not readable" }]
    const state: WorkflowsPageState = { scope: "saved", focus: "list" }
    const out = renderWorkflowsPage({ runs: [], saved, state, width: 100, height: 20, now: NOW }).map(text).join("\n")
    expect(out).toContain("/audit")
    expect(out).toContain("Audit every package")
    expect(out).toContain("cannot run: not readable")
    expect(workflowsPageKey(state, "\r", [], saved).action).toEqual({ type: "runSaved", name: "audit", kind: "script", now: false })
    expect(workflowsPageKey(state, "r", [], saved).action).toEqual({ type: "runSaved", name: "audit", kind: "script", now: true })
    const second = workflowsPageKey(state, "j", [], saved).state
    expect(workflowsPageKey(second, "\r", [], saved).action.type).toBe("none")
  })
})

describe("the live run view", () => {
  test("a running agent turns a spinner, still motion keeps the dot", () => {
    const one = run("running")
    expect(screen(one, inRun(one), 100, { frame: 0 })).toContain("⠋ Migrate one")
    expect(screen(one, inRun(one), 100, { frame: 3 })).toContain("⠸ Migrate one")
    expect(screen(one, inRun(one), 100, { frame: 3, still: true })).toContain("● Migrate one")
  })

  test("tokens and cost tick on the progress row, a finished phase folds into its results, space opens it", () => {
    const one = run("running")
    const out = screen(one, inRun(one), 100)
    expect(out).toContain("380k tok · $1.40")
    expect(out).toContain("14 endpoints · 4 modules")
    expect(out).not.toContain("Survey")
    const opened = workflowsPageKey(inRun(one, { step: "p:Plan" }), " ", [one]).state
    expect(screen(one, opened, 100)).toContain("Survey")
  })

  test("a run that ended opens on a summary card with its totals and what each phase produced", () => {
    const one = run("completed")
    const out = screen(one, inRun(one), 100)
    expect(out).toContain("Summary")
    expect(out).toMatch(/Plan +14 endpoints/)
    expect(out).toContain("s keeps this as a /command")
  })

  test("it fits 100 and 180 columns", () => {
    for (const width of [100, 180]) {
      for (const one of [run("running"), run("completed")]) {
        for (const line of renderWorkflowsPage({ runs: [one], state: inRun(one), width, height: 40, now: NOW, frame: 2 })) expect(line.reduce((sum, span) => sum + [...span.text].length, 0)).toBeLessThanOrEqual(width)
      }
    }
  })
})
