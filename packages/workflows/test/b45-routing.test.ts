import { describe, expect, test } from "bun:test"
import { createIdFactory, WorkflowPlan, WorkflowRun, summarizeWorkflow, type QueueId, type SessionEvent, type SessionId, type WorkflowId, type WorkflowRun as Run } from "@mendcode/protocol"
import { budgetReason, createWorkflowService, emptyTaskUsage, taskExecution, validatePlan } from "../src"

const agent = (id: string, extra = {}) => ({ kind: "agent", id, title: id, prompt: `Do ${id}`, ...extra })
const plan = (extra = {}) => WorkflowPlan.parse({ name: "routing", objective: "Verify routing", tasks: [agent("a")], ...extra })

function harness(extra: Partial<Parameters<typeof createWorkflowService>[0]> = {}) {
  const ids = createIdFactory()
  let now = 1_800_000_000_000
  let timer: { at: number; callback: () => void } | undefined
  const saved = new Map<WorkflowId, Run>()
  const sessions: Array<Parameters<Parameters<typeof createWorkflowService>[0]["createSession"]>[0] & { sessionId: SessionId }> = []
  const sent: Array<{ sessionId: SessionId; queueId: QueueId; text: string }> = []
  const cancelled: SessionId[] = []
  const service = createWorkflowService({
    ids,
    clock: { now: () => now, setTimer: (ms, callback) => { const entry = { at: now + ms, callback }; timer = entry; return { cancel: () => { if (timer === entry) timer = undefined } } } },
    store: { all: () => [...saved.values()], save: (run) => void saved.set(run.workflowId, run), remove: (id) => void saved.delete(id) },
    createSession: (input) => { const sessionId = ids("session"); sessions.push({ ...input, sessionId }); return sessionId },
    submit: async ({ sessionId, text }) => { const queueId = ids("queue"); sent.push({ sessionId, queueId, text }); return { queueId } },
    cancelTurn: ({ sessionId }) => void cancelled.push(sessionId),
    ...extra,
  })
  let seq = 0
  const flush = async () => { for (let n = 0; n < 4; n++) await new Promise((resolve) => setImmediate(resolve)) }
  const begin = async (sessionId = sent.at(-1)!.sessionId) => {
    await flush()
    const turnId = ids("turn")
    const queueId = sent.findLast((entry) => entry.sessionId === sessionId)!.queueId
    const emit = (event: Record<string, unknown>) => service.observe({ sessionId, seq: ++seq, at: now, ...event } as SessionEvent)
    emit({ type: "turn.started", turnId, queueId })
    return { sessionId, turnId, emit }
  }
  const create = (input = plan()) => service.create({ plan: input, directory: "/repo", permission: "edits", planHash: "0".repeat(64) })
  const advance = (ms: number) => { now += ms; const due = timer; if (due && due.at <= now) { timer = undefined; due.callback() } }
  return { service, saved, sessions, sent, cancelled, ids, create, begin, flush, advance }
}

describe("B45 workflow routing and budgets", () => {
  test("legacy plans and run rows remain readable; optional routing survives summaries", () => {
    const h = harness()
    const run = h.create(plan({ model: { model: "plan", variant: "fast" }, tasks: [agent("a", { model: { model: "task", variant: "deep" }, agent: "explore", permission: "full", budget: { maxTokens: 100 } })] }))
    expect(WorkflowRun.safeParse(run).success).toBe(true)
    expect(summarizeWorkflow(run).tasks[0]?.execution).toMatchObject({ model: { model: "task", variant: "deep" }, agent: "explore", permission: "edits", budget: { maxTokens: 100 } })
    const legacy = { ...run, plan: plan(), tasks: run.tasks.map(({ execution: _execution, usage: _usage, ...task }) => task) }
    expect(WorkflowRun.safeParse(legacy).success).toBe(true)
    h.service.dispose()
  })

  test("policy allowlists intersect; side effects, permission and budgets only tighten", () => {
    const h = harness()
    const run = h.create(plan({ permissions: { mode: "custom", allowedTools: ["read", "write"], allowExternalSend: false, approvalRequiredFor: ["write"] }, budget: { maxTokens: 50 }, tasks: [agent("a", { permission: "ask", allowedTools: ["read"], permissions: { mode: "custom", allowedTools: ["read", "shell"], approvalRequiredFor: ["shell"] }, budget: { maxTokens: 200 } })] }))
    expect(run.tasks[0]?.execution).toMatchObject({ permission: "ask", budget: { maxTokens: 50 }, permissions: { allowedTools: ["read"], allowExternalSend: false, approvalRequiredFor: ["write", "shell"] } })
    const readonly = taskExecution(run, WorkflowPlan.parse({ ...run.plan, tasks: [agent("a", { workspace: { mode: "read-only" } })] }).tasks[0]!)
    expect(readonly.readOnly).toBe(true)
    h.service.dispose()
  })

  test("preview rejects widening, side-effect contradictions and read-only host checks", () => {
    expect(validatePlan({ ...plan(), permissions: { mode: "report-only", allowEdits: true } }).ok).toBe(false)
    expect(validatePlan({ ...plan(), permissions: { mode: "normal", allowEdits: false }, tasks: [agent("a", { permissions: { mode: "normal", allowEdits: true } })] }).ok).toBe(false)
    expect(validatePlan({ ...plan(), workspace: { mode: "read-only" }, tasks: [{ kind: "check", id: "check", title: "check", command: "bun test" }] }).ok).toBe(false)
    expect(validatePlan({ ...plan(), budget: { maxCost: -1 } }).ok).toBe(false)
    expect(validatePlan({ ...plan(), tasks: [agent("a", { workspace: { mode: "escape" } })] }).ok).toBe(false)
  })

  test("token limit cancels the owned turn and skips dependents without double-counting cache/reasoning", async () => {
    const h = harness()
    const run = h.create(plan({ tasks: [agent("a", { budget: { maxTokens: 20 } }), agent("b", { needs: ["a"] })] }))
    const turn = await h.begin()
    turn.emit({ type: "usage.recorded", turnId: turn.turnId, provider: "fake", model: "fake", input: 14, output: 6, reasoning: 4, cacheRead: 10, cacheWrite: 0 })
    expect(h.service.get(run.workflowId)?.tasks[0]).toMatchObject({ state: "failed", usage: { input: 14, output: 6 }, reason: "token budget exhausted (20/20)" })
    expect(h.service.get(run.workflowId)?.tasks[1]?.state).toBe("skipped")
    expect(h.cancelled).toEqual([turn.sessionId])
    h.service.dispose()
  })

  test("model-call and child reservations persist across retries and restart", async () => {
    const h = harness()
    const run = h.create(plan({ tasks: [agent("a", { budget: { maxTurns: 1, maxChildren: 1, maxDepth: 2 } })] }))
    const turn = await h.begin()
    const runtime = h.service.execution(turn.sessionId)!
    expect(runtime.beforeCall()).toBeUndefined()
    expect(runtime.beforeCall()).toContain("model-call budget")
    expect(runtime.reserveChild()).toBe(true)
    expect(runtime.reserveChild()).toBe(false)
    turn.emit({ type: "turn.failed", turnId: turn.turnId, error: { code: "fake", message: "failed" } })
    h.service.control(run.workflowId, "retry", { taskId: "a" })
    expect(h.service.get(run.workflowId)?.tasks[0]).toMatchObject({ state: "failed", usage: { calls: 1, children: 1 } })
    const stored = h.service.get(run.workflowId)!
    h.service.dispose()
    const recovered = harness({ store: { all: () => [stored], save: () => {}, remove: () => {} } })
    expect(recovered.service.execution(turn.sessionId)?.execution).toEqual(runtime.execution)
    recovered.service.dispose()
  })

  test("runtime milliseconds arm a deadline even without timeoutMinutes", async () => {
    const h = harness()
    const run = h.create(plan({ tasks: [agent("a", { budget: { maxRuntimeMs: 20 } })] }))
    const turn = await h.begin()
    h.advance(20)
    expect(h.service.get(run.workflowId)?.tasks[0]).toMatchObject({ state: "failed", reason: "task runtime limit exceeded" })
    expect(h.cancelled).toEqual([turn.sessionId])
    h.service.dispose()
  })

  test("cost limits use USD, reject unknown prices, and preserve unknown cost", () => {
    expect(budgetReason({ maxCost: 0.01 }, { ...emptyTaskUsage(), costMicros: 10_000 })).toContain("cost budget exhausted")
    expect(budgetReason({ maxCost: 1 }, { ...emptyTaskUsage(), costUnknown: true })).toContain("price is unknown")
    expect(budgetReason({ maxTokens: 0 }, emptyTaskUsage())).toContain("token budget exhausted")
    expect(budgetReason({ maxRuntimeMs: 0 }, emptyTaskUsage())).toBe("task runtime limit exceeded")
  })

  test("async routing preserves the repair feedback on retry", async () => {
    const h = harness({ prepareTask: async (_run, _spec, execution) => execution })
    const run = h.create()
    await h.flush()
    const turn = await h.begin()
    turn.emit({ type: "turn.failed", turnId: turn.turnId, error: { code: "fake", message: "failed" } })
    h.service.control(run.workflowId, "retry", { taskId: "a", reason: "Repair caller contract" })
    await h.flush()
    expect(h.sent.at(-1)?.text).toContain("Repair caller contract")
    expect(h.service.get(run.workflowId)?.tasks[0]?.attempt).toBe(2)
    h.service.dispose()
  })

  test("plan runtime cap stops the whole run", async () => {
    const h = harness()
    const run = h.create(plan({ budget: { maxRuntimeMs: 20 } }))
    await h.begin()
    h.advance(20)
    expect(h.service.get(run.workflowId)).toMatchObject({ state: "stopped", reason: "workflow runtime limit exceeded" })
    expect(h.cancelled).toHaveLength(1)
    h.service.dispose()
  })

  test("late workspace preparation after stop never submits a turn", async () => {
    let ready!: (execution: ReturnType<typeof taskExecution>) => void
    const h = harness({ prepareTask: async (_run, _spec, execution) => new Promise((resolve) => { ready = () => resolve({ ...execution, directory: "/worktree" }) }) })
    const run = h.create()
    h.service.control(run.workflowId, "stop")
    ready(taskExecution(run, run.plan.tasks[0]!))
    await h.flush()
    expect(h.sent).toHaveLength(0)
    expect(h.sessions).toHaveLength(1)
    expect(h.service.get(run.workflowId)?.state).toBe("stopped")
    h.service.dispose()
  })

  test("plan token cap is aggregate across concurrent tasks and delegated usage", async () => {
    const h = harness()
    const run = h.create(plan({ budget: { maxTokens: 20 }, tasks: [agent("a", { mode: "read" }), agent("b", { mode: "read" })] }))
    const first = await h.begin(h.sent[0]!.sessionId)
    const second = await h.begin(h.sent[1]!.sessionId)
    first.emit({ type: "usage.recorded", turnId: first.turnId, provider: "fake", model: "fake", input: 5, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    h.service.recordUsage(second.sessionId, { type: "usage.recorded", sessionId: h.ids("session"), seq: 1, at: 0, turnId: h.ids("turn"), provider: "fake", model: "fake", input: 5, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    expect(h.service.get(run.workflowId)?.tasks.map((task) => task.state)).toEqual(["failed", "failed"])
    expect(h.cancelled).toHaveLength(2)
    h.service.dispose()
  })
})
