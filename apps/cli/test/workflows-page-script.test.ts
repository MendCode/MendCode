import { describe, expect, test } from "bun:test"
import { createIdFactory, type WorkflowSummary, type WorkflowTaskSummary } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { createWorkflowsPageState, renderWorkflowsPage } from "../src/view/workflows-page"
import { textWidth } from "../src/view/wrap"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const MIN = 60_000

const task = (id: string, over: Partial<WorkflowTaskSummary> = {}): WorkflowTaskSummary => ({ id, title: id, kind: "agent", mode: "read", needs: [], state: "pending", attempt: 0, ...over })
const text = (line: Line) => line.map((span) => span.text).join("")
const render = (runs: WorkflowSummary[], width = 120, height = 40) => renderWorkflowsPage({ runs, state: createWorkflowsPageState(), width, height, now: NOW })
const screen = (runs: WorkflowSummary[], width = 120, height = 40) => render(runs, width, height).map(text).join("\n")

const script = (over: Partial<NonNullable<WorkflowSummary["script"]>> = {}): NonNullable<WorkflowSummary["script"]> => ({
  hash: "ab12cd34ef56".padEnd(64, "0"),
  origin: "file",
  host: "running",
  calls: 12,
  phase: "Verify",
  phases: [{ title: "Find", state: "done", completed: 4, total: 4 }, { title: "Verify", state: "running", completed: 2, total: 8 }],
  budget: { agents: 40, tokens: 2_000_000, usd: 5, minutes: 60 },
  usage: { agents: 12, tokens: 150_000, costMicros: 1_200_000 },
  counts: { pending: 2, running: 3, done: 7, failed: 0 },
  omitted: 0,
  logs: ["confirmed 3"],
  ...over,
})

const run = (over: Partial<WorkflowSummary> = {}): WorkflowSummary => ({
  workflowId: ids("workflow"),
  name: "review-and-verify",
  directory: "/Users/dev/Code/app",
  objective: "Review a change from several angles",
  planHash: "a".repeat(64),
  permission: "edits",
  state: "running",
  rootSessionId: ids("session"),
  tasks: [task("c01", { label: "Review: security", phase: "Find", state: "running", sessionId: ids("session"), startedAt: NOW - MIN }), task("c02", { label: "Verify: token logged", phase: "Verify", state: "pending" })],
  rounds: 0,
  repairs: 0,
  startedAt: NOW - 12 * MIN,
  updatedAt: NOW - 1000,
  script: script(),
  ...over,
})

describe("script workflows on the page", () => {
  test("the list shows finished calls out of calls so far, and the detail shows origin, hash, phases, live caps and the log tail", () => {
    const text = screen([run()])
    expect(text).toContain("7/12")
    expect(text).toContain("file · sha ab12cd34ef56")
    expect(text).toContain("Find 4/4 · Verify 2/8…")
    expect(text).toContain("agents 12/40 · tokens 150k/2M · $1.20/$5 · 12/60 min")
    expect(text).toContain("confirmed 3")
  })

  test("calls are listed under the label the script gave them, without static levels", () => {
    const text = screen([run()])
    expect(text).toContain("Review: security")
    expect(text).toContain("Verify: token logged")
    expect(text).not.toMatch(/\bL1\b/)
  })

  test("a run paused at a cap shows the reason and the caps that were reached", () => {
    const text = screen([run({ state: "paused", reason: "agent cap reached (40/40); raise it with /workflows budget then resume", script: script({ usage: { agents: 40, tokens: 1_000, costMicros: 0 } }) })])
    expect(text).toContain("agent cap reached (40/40)")
    expect(text).toContain("agents 40/40")
  })

  test("a failed script shows its error, a finished one its result, and old calls are counted", () => {
    expect(screen([run({ state: "failed", script: script({ host: "failed", error: "ReferenceError: x is not defined" }) })])).toContain("ReferenceError: x is not defined")
    const done = screen([run({ state: "completed", script: script({ host: "done", result: '{"confirmed":3}', omitted: 14 }) })])
    expect(done).toContain('{"confirmed":3}')
    expect(done).toContain("14 finished calls not listed")
  })

  test("it fits a narrow terminal and keeps every line inside the width", () => {
    for (const width of [60, 90]) for (const line of render([run()], width, 20)) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
    expect(screen([run()], 60, 24)).toContain("agents 12/40")
  })

  test("with no workflows the page names the script commands", () => {
    expect(screen([])).toContain("/workflows run <file.js>")
  })
})
