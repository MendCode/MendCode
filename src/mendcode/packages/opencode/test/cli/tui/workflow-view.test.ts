import { describe, expect, test } from "bun:test"
import {
  workflowReceiptCounts,
  workflowReceiptElapsed,
  workflowReceiptNextAction,
  workflowReceiptProgress,
  workflowReceiptUsage,
  type WorkflowReceiptSnapshot,
} from "../../../src/cli/cmd/tui/util/workflow-receipt"
import { workflowMonitorFooter, workflowMonitorLayout, workflowMonitorRows } from "../../../src/cli/cmd/tui/util/workflow-view"

const snapshot = (overrides: Partial<WorkflowReceiptSnapshot> = {}): WorkflowReceiptSnapshot => ({
  definition: { name: "Release pipeline", description: "Build and verify" },
  revision: { plan: { objective: "Produce a verified release" } },
  run: { id: "wf_run_1", state: "working", createdAt: 1_000, updatedAt: 2_000 },
  phases: [
    {
      id: "phase_1",
      state: "working",
      counts: { total: 2, queued: 1, working: 1, completed: 0, failed: 0, blocked: 0 },
    },
  ],
  tasks: [
    { id: "task_1", name: "Implement", phaseID: "phase_1", state: "working", attempt: 1 },
    { id: "task_2", name: "Verify", phaseID: "phase_1", state: "queued", attempt: 0 },
  ],
  ...overrides,
})

describe("workflow monitor helpers", () => {
  test("uses compact and stacked layouts at bounded terminal sizes", () => {
    expect(workflowMonitorLayout({ width: 80, height: 30 })).toMatchObject({ compact: true, stacked: true })
    expect(workflowMonitorLayout({ width: 140, height: 30 })).toMatchObject({ compact: false, stacked: false })
  })

  test("advertises the controls implemented by the monitor", () => {
    expect(workflowMonitorFooter(false)).toContain("t task · f phase")
    expect(workflowMonitorFooter(true)).toContain("t/f retry")
    expect(workflowMonitorFooter(false)).toContain("q/Esc back")
  })

  test("summarizes task progress and phase counts", () => {
    const value = snapshot({
      tasks: [
        { id: "task_1", name: "Implement", phaseID: "phase_1", state: "completed" },
        { id: "task_2", name: "Verify", phaseID: "phase_1", state: "failed" },
      ],
    })
    expect(workflowReceiptCounts(value)).toMatchObject({ total: 2, completed: 1, failed: 1, phases: 1 })
    expect(workflowReceiptProgress(value)).toBe("1/2 tasks")
    expect(workflowMonitorRows(value)).toContainEqual(["progress", "1/2 tasks"])
  })

  test("prioritizes blockers and operator input in the next action", () => {
    expect(workflowReceiptNextAction(snapshot({ tasks: [{ state: "blocked", blocker: "Approval required" }] }))).toBe("Approval required")
    expect(workflowReceiptNextAction(snapshot({ run: { id: "wf_run_1", state: "needs_input", createdAt: 1_000, updatedAt: 2_000 } }))).toContain("input")
  })

  test("computes terminal elapsed time and bounded usage labels", () => {
    const value = snapshot({
      run: { id: "wf_run_1", state: "completed", createdAt: 1_000, updatedAt: 4_500 },
      usage: { inputTokens: 120, outputTokens: 30, cost: 0.1234 },
    })
    expect(workflowReceiptElapsed(value, 9_000)).toBe(3_500)
    expect(workflowReceiptUsage(value)).toBe("150 tokens · $0.1234")
  })
})
