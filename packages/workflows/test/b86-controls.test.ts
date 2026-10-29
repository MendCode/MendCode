import { expect, test } from "bun:test"
import { WorkflowPlan, createIdFactory, type WorkflowId, type WorkflowRun } from "@mendcode/protocol"
import { createRun, createWorkflowService, retryPhase } from "../src"

const ids = createIdFactory(), at = 1_800_000_000_000
test("B86 runtime permission overrides update captured live policies, preserve frozen settings and restore inheritance", async () => {
  const rows = new Map<WorkflowId, WorkflowRun>()
  const service = createWorkflowService({
    store: { all: () => [...rows.values()], save: (run) => { rows.set(run.workflowId, structuredClone(run)) }, remove: (id) => { rows.delete(id) } },
    clock: { now: () => at, setTimer: () => ({ cancel() {} }) }, ids,
    createSession: () => ids("session"), submit: async () => ({ queueId: ids("queue") }), cancelTurn() {},
  })
  try {
    const plan = WorkflowPlan.parse({ name: "Policy", objective: "Hold a local task", permission: "edits", tasks: [{ id: "task", title: "Task", kind: "agent", prompt: "Hold", needs: [], mode: "work", permissions: { mode: "normal", allowedTools: ["read"], allowExternalSend: false } }] })
    const run = service.create({ plan, planHash: "a".repeat(64), directory: "/local-fixture", permission: "edits" })
    const task = service.get(run.workflowId)!.tasks[0]!, sessionId = task.sessionId!, captured = service.execution(sessionId)!.execution
    expect(captured.permission).toBe("edits")
    expect(captured.readOnly).toBe(false)
    expect(service.permissions(run.workflowId, { mode: "report-only", sessionPermission: "full" })).not.toHaveProperty("error")
    expect(captured).toMatchObject({ permission: "edits", readOnly: true, permissions: { allowedTools: ["read"], allowEdits: false, allowExternalSend: false } })
    expect(rows.get(run.workflowId)!.tasks[0]!.execution!.readOnly).toBe(false)
    expect(service.permissions(run.workflowId, { mode: "normal", sessionPermission: "ask" })).not.toHaveProperty("error")
    expect(captured).toMatchObject({ permission: "ask", readOnly: false, permissions: { allowedTools: ["read"], allowExternalSend: false } })
    service.permissions(run.workflowId, { sessionPermission: null })
    expect(captured.permission).toBe("edits")
    expect(service.get(run.workflowId)!.plan).toEqual(plan)
    const snapshot = structuredClone(rows.get(run.workflowId)!)
    service.dispose()
    const restored = createWorkflowService({ store: { all: () => [snapshot], save() {}, remove() {} }, clock: { now: () => at, setTimer: () => ({ cancel() {} }) }, ids, createSession: () => ids("session"), submit: async () => ({ queueId: ids("queue") }), cancelTurn() {} })
    expect(restored.execution(sessionId)!.execution).toMatchObject({ readOnly: false, permission: "edits" })
    restored.dispose()
  } finally { service.dispose() }
})

test("B86 phase retry reopens completed siblings, dependents and later phases atomically, retaining attempts", () => {
  const plan = WorkflowPlan.parse({ name: "Phases", objective: "Review then finalize", tasks: [
    { kind: "agent", id: "a", title: "A", prompt: "A" }, { kind: "agent", id: "b", title: "B", prompt: "B" }, { kind: "agent", id: "c", title: "C", prompt: "C", needs: ["a", "b"] },
  ], phases: [{ id: "review", title: "Review", tasks: ["a", "b"] }, { id: "final", title: "Final", tasks: ["c"] }] })
  const run = createRun({ workflowId: ids("workflow"), rootSessionId: ids("session"), plan, planHash: "b".repeat(64), directory: "/local", permission: "ask", at })
  run.state = "failed"
  run.tasks = run.tasks.map((task) => ({ ...task, state: task.id === "b" ? "failed" : "done", attempt: 2, output: { kind: "text", value: "stale" }, result: "stale", endedAt: at }))
  const next = retryPhase(run, "review", at + 1, "Fix the review")
  expect(next.state).toBe("running")
  expect(next.tasks.map((task) => task.state)).toEqual(["pending", "pending", "pending"])
  expect(next.tasks.every((task) => task.attempt === 2 && task.output === undefined && task.result === undefined)).toBe(true)
  expect(next.tasks[0]!.feedback).toBe("Fix the review")
  expect(run.tasks[0]!.output).toBeDefined()
  expect(() => retryPhase(run, "missing", at)).toThrow("unknown phase")
  expect(() => retryPhase({ ...run, state: "completed" }, "review", at)).toThrow("cannot retry")
  expect(() => retryPhase({ ...run, tasks: run.tasks.map((task) => ({ ...task, state: "done" })) }, "review", at)).toThrow("not retryable")
})

test("B86 runtime report-only rejects host checks and inherited report-only is never widened", () => {
  const service = createWorkflowService({ store: { all: () => [], save() {}, remove() {} }, clock: { now: () => at, setTimer: () => ({ cancel() {} }) }, ids, createSession: () => ids("session"), submit: async () => ({ queueId: ids("queue") }), cancelTurn() {}, runCheck: async () => ({ exitCode: 0, output: "" }) })
  try {
    const run = service.create({ plan: WorkflowPlan.parse({ name: "Checks", objective: "Check", tasks: [{ kind: "check", id: "check", title: "Check", command: "true" }] }), planHash: "c".repeat(64), directory: "/local", permission: "full" })
    expect(service.permissions(run.workflowId, { mode: "report-only" })).toMatchObject({ error: expect.stringContaining("host checks") })
    const read = service.create({ plan: WorkflowPlan.parse({ name: "Read", objective: "Read", permissions: { mode: "report-only" }, tasks: [{ kind: "agent", id: "read", title: "Read", prompt: "Read" }] }), planHash: "d".repeat(64), directory: "/other", permission: "full" })
    service.permissions(read.workflowId, { mode: "normal" })
    expect(service.execution(service.get(read.workflowId)!.tasks[0]!.sessionId!)!.execution.readOnly).toBe(true)
  } finally { service.dispose() }
})
