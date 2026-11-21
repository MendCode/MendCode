import { describe, expect, test } from "bun:test"
import { createIdFactory, type WorkflowSummary, type WorkflowTaskSummary } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { renderWorkflowsPage, type WorkflowsPageState } from "../src/view/workflows-page"
import { textWidth } from "../src/view/wrap"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const MIN = 60_000

const task = (id: string, over: Partial<WorkflowTaskSummary> = {}): WorkflowTaskSummary => ({ id, title: id, kind: "agent", mode: "read", needs: [], state: "pending", attempt: 0, ...over })
const text = (line: Line) => line.map((span) => span.text).join("")
const opened = (one: WorkflowSummary, extra: Partial<WorkflowsPageState> = {}): WorkflowsPageState => ({ scope: "project", focus: "run", row: `r:${one.workflowId}`, ...extra })
const render = (one: WorkflowSummary, state: WorkflowsPageState = opened(one), width = 120, height = 40) => renderWorkflowsPage({ runs: [one], state, width, height, now: NOW })
const screen = (one: WorkflowSummary, state?: WorkflowsPageState, width = 120, height = 40) => render(one, state, width, height).map(text).join("\n")

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
  tasks: [
    task("c01", { label: "Review: security", phase: "Find", state: "done", sessionId: ids("session"), startedAt: NOW - 3 * MIN, endedAt: NOW - 2 * MIN, modelId: "claude-opus", engine: "claude", usage: { input: 9_000, output: 3_400 } }),
    task("c02", { label: "Verify: token logged", phase: "Verify", state: "running", sessionId: ids("session"), startedAt: NOW - MIN, modelId: "gpt-6-luna", engine: "codex", latest: "reading src/auth.ts" }),
  ],
  rounds: 0,
  repairs: 0,
  startedAt: NOW - 12 * MIN,
  updatedAt: NOW - 1000,
  script: script(),
  ...over,
})

describe("script workflows on the page", () => {
  test("the list row says which phase the run is in, the run its progress against the agent cap", () => {
    const one = run()
    expect(screen(one, { scope: "project", focus: "list" })).toMatch(/review-and-verify +Verify 2\/2/)
    const out = screen(one)
    expect(out).toContain("✓ Find ── ● Verify")
    expect(out).toContain("phase 2 of 2 · 12 of 40 agents")
  })

  test("each call is a step under its phase, with the model and engine it runs on, its tokens and what it does now", () => {
    const out = screen(one())
    expect(out).toMatch(/│ ✓ Review: security +claude-opus · claude +1m 0s/)
    // Tokens once the run pane has room for them.
    expect(screen(run(), undefined, 200)).toMatch(/│ ✓ Review: security +claude-opus · claude +12.4k tok +1m 0s/)
    expect(out).toMatch(/│ ● Verify: token logged +gpt-6-luna · codex/)
    expect(out).toContain("▸ reading src/auth.ts")
    expect(out).not.toMatch(/\bL1\b/)
  })

  test("i shows the script's origin and hash, the caps used and the log tail", () => {
    const one = run()
    const out = screen(one, opened(one, { info: true }), 120, 60)
    expect(out).toContain("file · sha ab12cd34ef56")
    expect(out).toContain("agents 12/40 · tokens 150k/2M · $1.20/$5 · 12/60 min")
    expect(out).toContain("confirmed 3")
  })

  test("from 170 columns the facts column shows the limits and the models", () => {
    const out = screen(run(), undefined, 200)
    expect(out).toMatch(/agents +12 \/ 40/)
    expect(out).toMatch(/claude-opus +claude · 1 agent · 12.4k/)
  })

  test("a run paused at a cap shows the reason", () => {
    expect(screen(run({ state: "paused", reason: "agent cap reached (40/40); raise it with /workflows budget then resume", script: script({ usage: { agents: 40, tokens: 1_000, costMicros: 0 } }) }))).toContain("agent cap reached (40/40)")
  })

  test("a failed script shows its error; an outcome reads as the run's state; older calls are counted", () => {
    const failed = run({ state: "failed", tasks: [], script: script({ host: "failed", error: "ReferenceError: x is not defined" }) })
    expect(screen(failed)).toContain("ReferenceError: x is not defined")
    const done = run({ state: "completed", script: script({ host: "done", result: '{"state":"draft","reason":"audit unsure"}', outcome: { state: "draft", reason: "audit unsure" }, omitted: 14 }) })
    const out = screen(done)
    expect(out).toContain("draft: audit unsure")
    expect(out).toMatch(/review-and-verify +draft · 11m/)
    expect(out).toContain("14 earlier calls not listed")
    const plain = run({ state: "completed", script: script({ host: "done", result: '{"confirmed":3}' }) })
    expect(screen(plain, opened(plain, { info: true }), 120, 60)).toContain('{"confirmed":3}')
  })

  test("it fits a narrow terminal and keeps every line inside the width", () => {
    for (const width of [60, 90]) for (const line of render(run(), undefined, width, 20)) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
    expect(screen(run(), undefined, 60, 24)).toContain("12 of 40 agents")
  })
})

function one() {
  return run()
}
