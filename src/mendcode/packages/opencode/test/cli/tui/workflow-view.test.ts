import { describe, expect, test } from "bun:test"
import {
  workflowReceiptCounts,
  workflowReceiptElapsed,
  workflowReceiptFallbackPhases,
  workflowReceiptNextAction,
  workflowReceiptPhaseDiagram,
  workflowReceiptProgress,
  workflowReceiptStateIsAnimated,
  workflowReceiptStateIsTerminal,
  workflowReceiptStateMarker,
  workflowReceiptUsage,
  type WorkflowReceiptSnapshot,
} from "../../../src/cli/cmd/tui/util/workflow-receipt"
import {
  workflowCurrentActivity,
  workflowMonitorFooter,
  workflowMonitorLayout,
  workflowMonitorResumeTarget,
  workflowMonitorRows,
  workflowMonitorTaskRows,
  workflowMonitorSessionID,
  workflowRequestErrorText,
  workflowParentSessionID,
  workflowTaskSessionContext,
  workflowTaskSiblingSessionID,
} from "../../../src/cli/cmd/tui/util/workflow-view"

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
    expect(workflowMonitorLayout({ width: 140, height: 20 })).toMatchObject({ compact: true, stacked: true })
  })

  test("retries failed workflow work while normally resuming non-terminal runs", () => {
    expect(workflowMonitorResumeTarget(snapshot())).toEqual({ kind: "resume" })
    expect(
      workflowMonitorResumeTarget(
        snapshot({
          run: { ...snapshot().run, state: "failed" },
          phases: [
            {
              id: "phase_1",
              state: "failed",
              counts: { total: 1, queued: 0, working: 0, completed: 0, failed: 1, blocked: 0 },
            },
          ],
          tasks: [{ id: "task_1", name: "Implement", phaseID: "phase_1", state: "failed" }],
        }),
      ),
    ).toEqual({ kind: "retry-task", taskID: "task_1", name: "Implement" })
    expect(
      workflowMonitorResumeTarget(
        snapshot({
          run: { ...snapshot().run, state: "failed" },
          phases: [
            {
              id: "phase_1",
              name: "Implementation",
              state: "failed",
              counts: { total: 0, queued: 0, working: 0, completed: 0, failed: 1, blocked: 0 },
            },
          ],
          tasks: [],
        }),
      ),
    ).toEqual({ kind: "retry-phase", phaseID: "phase_1", name: "Implementation" })
  })

  test("surfaces structured workflow API errors", () => {
    expect(workflowRequestErrorText({ errors: [{ message: "Run is already terminal." }] })).toBe(
      "Run is already terminal.",
    )
    expect(workflowRequestErrorText({ data: { message: "Run not found." } })).toBe("Run not found.")
    expect(workflowRequestErrorText({ errors: [] })).toBe("Workflow request failed.")
  })

  test("advertises the controls implemented by the monitor", () => {
    expect(workflowMonitorFooter(false)).toContain("t retry task · f retry phase")
    expect(workflowMonitorFooter(true)).toContain("t/f retry")
    expect(workflowMonitorFooter(false)).toContain("d delete")
    expect(workflowMonitorFooter(false)).toContain("c creator")
    expect(workflowMonitorFooter(false)).toContain("m permission mode")
    expect(workflowMonitorFooter(false)).toContain("q/Esc back")
  })

  test("opens the active task transcript before the workflow root", () => {
    const value = snapshot({
      run: {
        id: "wf_run_1",
        state: "working",
        originSessionID: "ses_creator",
        rootSessionID: "ses_root",
        createdAt: 1_000,
        updatedAt: 2_000,
      },
      tasks: [
        { id: "task_1", state: "completed", sessionID: "ses_old", startedAt: 1_000 },
        { id: "task_2", state: "working", sessionID: "ses_active", startedAt: 2_000 },
      ],
    })
    expect(workflowMonitorSessionID(value)).toBe("ses_active")
    expect(workflowMonitorSessionID(snapshot({ tasks: [], run: { ...value.run, rootSessionID: "ses_root" } }))).toBe("ses_creator")
    expect(workflowMonitorSessionID(snapshot({ tasks: [], run: { ...value.run, originSessionID: undefined, rootSessionID: "ses_root" } }))).toBe("ses_root")
  })

  test("lists tasks in phase order instead of raw plan insertion order", () => {
    const value = snapshot({
      phases: [
        {
          id: "phase_1",
          ordinal: 1,
          state: "working",
          taskIDs: ["task_2", "task_1"],
          counts: { total: 2, queued: 0, working: 1, completed: 1, failed: 0, blocked: 0 },
        },
        {
          id: "phase_2",
          ordinal: 2,
          state: "pending",
          taskIDs: ["task_3"],
          counts: { total: 1, queued: 0, working: 0, completed: 0, failed: 0, blocked: 0 },
        },
      ],
      tasks: [
        { id: "task_3", name: "Later", phaseID: "phase_2", state: "pending" },
        { id: "task_1", name: "First phase second", phaseID: "phase_1", state: "completed" },
        { id: "task_2", name: "First phase first", phaseID: "phase_1", state: "working" },
      ],
    })

    expect(workflowMonitorTaskRows(value).map((task) => task.id)).toEqual(["task_2", "task_1", "task_3"])
  })

  test("keeps the creator chat as the non-task parent fallback", () => {
    const workflows = [{ run: { rootSessionID: "ses_root", originSessionID: "ses_creator" } }]
    expect(workflowParentSessionID({ sessionID: "ses_task", parentSessionID: "ses_root", workflows })).toBe("ses_creator")
    expect(workflowParentSessionID({ sessionID: "ses_child", parentSessionID: "ses_task", workflows })).toBe("ses_task")
    expect(workflowParentSessionID({ sessionID: "ses_root", workflows })).toBe("ses_creator")
  })

  test("locates the current workflow task and preserves plan order for sibling navigation", () => {
    const workflow = {
      definition: { name: "Release pipeline" },
      revision: { plan: { phases: [{ taskIDs: ["task_2", "task_1"] }] } },
      run: { id: "wf_run_1" },
      tasks: [
        { id: "task_1", name: "Verify", sessionID: "ses_verify" },
        { id: "task_2", name: "Build", sessionID: "ses_build" },
      ],
    }

    expect(workflowTaskSessionContext({ sessionID: "ses_verify", workflows: [workflow] })).toEqual({
      runID: "wf_run_1",
      workflowName: "Release pipeline",
      taskID: "task_1",
      taskName: "Verify",
      taskIndex: 1,
      taskCount: 2,
      sessionIDs: ["ses_build", "ses_verify"],
    })
    expect(workflowTaskSessionContext({ sessionID: "ses_other", workflows: [workflow] })).toBeUndefined()
    expect(
      workflowTaskSiblingSessionID({
        sessionID: "ses_build",
        sessionIDs: ["ses_build", "ses_verify", "ses_ship"],
        direction: 1,
      }),
    ).toBe("ses_verify")
    expect(
      workflowTaskSiblingSessionID({
        sessionID: "ses_build",
        sessionIDs: ["ses_build", "ses_verify", "ses_ship"],
        direction: -1,
      }),
    ).toBe("ses_ship")
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

  test("prioritizes human waits over generic session status", () => {
    expect(
      workflowCurrentActivity({
        runState: "working",
        statuses: [
          { type: "busy", message: "Waiting for input/tools" },
          { type: "busy", message: "Running a command" },
        ],
      }),
    ).toBe("Running a command")
    expect(
      workflowCurrentActivity({
        runState: "needs_input",
        statuses: [{ type: "busy", message: "Waiting for input/tools" }],
        activeTools: [{ tool: "bash", status: "running" }],
        pendingPermissions: 1,
        waitingTasks: 1,
      }),
    ).toBe("Running a command")
    expect(
      workflowCurrentActivity({
        runState: "working",
        statuses: [{ type: "busy", kind: "subagent-wait", message: "Waiting for an agent..." }],
      }),
    ).toBe("Working with a subagent")
    expect(
      workflowCurrentActivity({
        runState: "working",
        statuses: [{ type: "busy", message: "Waiting for input/tools" }],
      }),
    ).toBeUndefined()
    expect(
      workflowCurrentActivity({
        runState: "working",
        statuses: [{ type: "busy", message: "Running a command" }],
        pendingPermissions: 1,
      }),
    ).toBe("1 permission request waiting")
    expect(
      workflowCurrentActivity({
        runState: "awaiting_approval",
        statuses: [{ type: "busy", message: "Running a command" }],
      }),
    ).toBe("Workflow approval required")
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

  test("renders stable ASCII state markers with animated working frames", () => {
    expect([0, 1, 2, 3].map((frame) => workflowReceiptStateMarker("working", frame))).toEqual([
      "[|]",
      "[/]",
      "[-]",
      "[\\]",
    ])
    expect(workflowReceiptStateMarker("completed")).toBe("[x]")
    expect(workflowReceiptStateMarker("needs_input")).toBe("[?]")
    expect(workflowReceiptStateIsAnimated("working")).toBe(true)
    expect(workflowReceiptStateIsTerminal("failed")).toBe(true)
    expect(workflowReceiptStateIsTerminal("paused")).toBe(false)
  })

  test("renders a vertical ASCII phase flow for the session receipt", () => {
    const rows = workflowReceiptPhaseDiagram({
      phases: [
        { ordinal: 1, name: "Inspect", state: "working", counts: { total: 2, queued: 1, working: 1, completed: 0, failed: 0, blocked: 0 } },
        { ordinal: 2, name: "Implement", state: "queued", counts: { total: 1, queued: 1, working: 0, completed: 0, failed: 0, blocked: 0 } },
        { ordinal: 3, name: "Verify", state: "completed", counts: { total: 1, queued: 0, working: 0, completed: 1, failed: 0, blocked: 0 } },
      ],
    }, 1)
    expect(rows.map((row) => row.text)).toEqual([
      "[/] 01 Inspect  0/2",
      "     |",
      "[ ] 02 Implement  0/1",
      "     |",
      "[x] 03 Verify  1/1",
    ])
  })

  test("builds the ASCII flow from a historical tool input plan", () => {
    const phases = workflowReceiptFallbackPhases({
      plan: [
        { id: "audit", ordinal: 1, name: "Audit TabTab", taskIDs: ["audit"] },
        { id: "implement", ordinal: 2, name: "Implement gaps", taskIDs: ["implement", "verify"] },
      ],
    })
    expect(workflowReceiptPhaseDiagram({ phases }).map((row) => row.text)).toEqual([
      "[ ] 01 Audit TabTab  0/1",
      "     |",
      "[ ] 02 Implement gaps  0/2",
    ])
  })
})
