import { describe, expect, test } from "bun:test"
import { WorkflowPlan, createIdFactory, type QueueId, type SessionEvent, type SessionId, type TurnId, type WorkflowId, type WorkflowRun } from "@mendcode/protocol"
import { answerHuman, createRun, createWorkflowService, finishTask, nextRetryAt, readyTasks, reconcileAfterRestart, startTask, validatePlan } from "../src"

const START = 1_800_000_000_000
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

function virtualClock() {
  let now = START
  let nextId = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    now: () => now,
    setTimer(ms: number, run: () => void) {
      const id = nextId++
      timers.set(id, { at: now + Math.max(0, ms), run })
      return { cancel: () => void timers.delete(id) }
    },
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].run()
      }
      now = target
    },
    pending: () => timers.size,
  }
}

function harness(checkExit: (argv: string[]) => number = () => 0) {
  const clock = virtualClock()
  const ids = createIdFactory({ now: () => clock.now() })
  const saved = new Map<WorkflowId, WorkflowRun>()
  const submitted: Array<{ sessionId: SessionId; text: string; queueId: QueueId }> = []
  const ran: string[][] = []
  const service = createWorkflowService({
    store: { all: () => [...saved.values()], save: (run) => void saved.set(run.workflowId, run), remove: (id) => void saved.delete(id) },
    clock,
    ids,
    createSession: () => ids("session"),
    submit: async ({ sessionId, text }) => {
      const queueId = ids("queue")
      submitted.push({ sessionId, text, queueId })
      return { queueId }
    },
    cancelTurn: () => undefined,
    runCheck: async ({ argv }) => {
      ran.push(argv)
      const exitCode = checkExit(argv)
      return { exitCode, output: exitCode ? "failing" : "ok" }
    },
    fingerprint: async () => "a",
  })
  let seq = 0
  const ev = (sessionId: SessionId, patch: Record<string, unknown>) => service.observe({ sessionId, seq: ++seq, at: clock.now(), ...patch } as SessionEvent)
  /** Plays one turn of the last message sent: it ends with `type` (a failed turn has no answer). */
  const turn = async (type: "turn.completed" | "turn.failed" = "turn.completed", text = "done") => {
    const sent = submitted.at(-1)!
    const turnId = ids("turn") as TurnId
    ev(sent.sessionId, { type: "turn.started", turnId, queueId: sent.queueId })
    if (type === "turn.completed") {
      const itemId = ids("item")
      ev(sent.sessionId, { type: "item.started", turnId, itemId, kind: "agent_message" })
      ev(sent.sessionId, { type: "item.completed", itemId, status: "ok", text })
      ev(sent.sessionId, { type, turnId })
    } else ev(sent.sessionId, { type, turnId, error: { code: "x", message: "boom" } })
    await flush()
  }
  const create = (tasks: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => service.create({ plan: WorkflowPlan.parse({ name: "wf", objective: "Ship it.", tasks, ...extra }), planHash: "0".repeat(64), directory: "/repo", permission: "edits" })
  const state = (run: WorkflowRun) => service.get(run.workflowId)!
  return { clock, service, saved, submitted, ran, turn, create, state }
}

const agent = (id: string, extra: Record<string, unknown> = {}) => ({ kind: "agent", id, title: id, prompt: `do ${id}`, ...extra })
const human = (id: string, extra: Record<string, unknown> = {}) => ({ kind: "human", id, title: `Approve ${id}`, prompt: `Please approve ${id}`, ...extra })

describe("human tasks", () => {
  test("a human task waits for the user, holds no slot, and approving it releases what needs it", async () => {
    const h = harness()
    const run = h.create([human("gate"), agent("build", { needs: ["gate"] }), agent("free")], { maxConcurrent: 1 })
    await flush()
    expect(h.state(run)).toMatchObject({ state: "needs_input", tasks: [{ id: "gate", state: "needs_input", kind: "human", latest: "Please approve gate" }, { id: "build", state: "pending" }, { id: "free", state: "running" }] })
    expect(h.submitted).toHaveLength(1)
    await h.turn()
    expect(h.state(run)).toMatchObject({ state: "needs_input", tasks: [{ state: "needs_input" }, { state: "pending" }, { state: "done" }] })
    const approved = h.service.control(run.workflowId, "approve", { taskId: "gate", reason: "ship it" })
    expect("run" in approved).toBe(true)
    expect(h.state(run).tasks[0]).toMatchObject({ state: "done", result: "ship it", output: { kind: "text", value: "ship it" } })
    expect(h.state(run).tasks[0]!.latest).toBeUndefined()
    await flush()
    expect(h.state(run).tasks[1]).toMatchObject({ id: "build", state: "running" })
    expect(h.submitted.at(-1)!.text).toContain("do build")
  })

  test("rejecting fails the task and skips its dependents; retry asks again", async () => {
    const h = harness()
    const run = h.create([human("gate"), agent("build", { needs: ["gate"] })])
    await flush()
    h.service.control(run.workflowId, "reject", { taskId: "gate", reason: "not yet" })
    expect(h.state(run)).toMatchObject({ state: "failed", tasks: [{ state: "failed", reason: "rejected: not yet" }, { state: "skipped" }] })
    expect(h.submitted).toHaveLength(0)
    h.service.control(run.workflowId, "retry", { taskId: "gate" })
    await flush()
    expect(h.state(run)).toMatchObject({ state: "needs_input", tasks: [{ state: "needs_input", attempt: 2 }, { state: "pending" }] })
  })

  test("only a waiting human task can be answered, and the answer needs a task", async () => {
    const h = harness()
    const run = h.create([human("gate"), agent("a", { needs: ["gate"] })])
    await flush()
    expect(h.service.control(run.workflowId, "approve")).toEqual({ error: "approve needs a task" })
    expect(h.service.control(run.workflowId, "approve", { taskId: "a" })).toEqual({ error: "task a is not a human task" })
    expect(h.service.control(run.workflowId, "approve", { taskId: "nope" })).toEqual({ error: "unknown task nope" })
    h.service.control(run.workflowId, "approve", { taskId: "gate" })
    expect(h.service.control(run.workflowId, "reject", { taskId: "gate" })).toEqual({ error: "task gate is done, not waiting for you" })
  })

  test("a human task survives a restart still waiting and nothing is submitted for it", async () => {
    const plan = WorkflowPlan.parse({ name: "wf", objective: "x", tasks: [human("gate")] })
    const run = createRun({ workflowId: createIdFactory()("workflow"), plan, planHash: "0".repeat(64), directory: "/repo", permission: "ask", rootSessionId: createIdFactory()("session"), at: START })
    const waiting = { ...run, tasks: [{ ...run.tasks[0]!, state: "needs_input" as const, attempt: 1, startedAt: START }], state: "needs_input" as const }
    expect(reconcileAfterRestart(waiting, START + 1).tasks[0]).toMatchObject({ state: "needs_input", attempt: 1 })
    expect(answerHuman(waiting, "gate", "approve", undefined, START + 2)).toMatchObject({ state: "completed", tasks: [{ state: "done", result: "approved" }] })
  })

  test("a gate in an earlier phase keeps every later task from starting until it is approved", async () => {
    const h = harness()
    const run = h.create([human("gate"), agent("work")], { phases: [{ id: "gates", title: "Gates", tasks: ["gate"] }, { id: "main", title: "Main", tasks: ["work"] }] })
    await flush()
    expect(h.submitted).toHaveLength(0)
    expect(h.state(run).state).toBe("needs_input")
    h.service.control(run.workflowId, "approve", { taskId: "gate" })
    await flush()
    expect(h.submitted).toHaveLength(1)
  })
})

describe("per-task retry", () => {
  test("a transient failure starts the task again in the same session until attempts run out", async () => {
    const h = harness()
    const run = h.create([agent("flaky", { retry: { maxAttempts: 3 } })])
    await flush()
    const sessionId = h.submitted[0]!.sessionId
    await h.turn("turn.failed")
    expect(h.state(run)).toMatchObject({ state: "running", tasks: [{ state: "running", attempt: 2 }] })
    expect(h.submitted.at(-1)!.sessionId).toBe(sessionId)
    expect(h.submitted.at(-1)!.text).toContain("attempt 2")
    await h.turn("turn.failed")
    await h.turn("turn.failed")
    expect(h.state(run)).toMatchObject({ state: "failed", tasks: [{ state: "failed", attempt: 3, reason: "the turn failed" }] })
    expect(h.submitted).toHaveLength(3)
  })

  test("a retry waits out its backoff on one timer and a success ends it", async () => {
    const h = harness()
    const run = h.create([agent("flaky", { retry: { maxAttempts: 2, backoffMs: 5_000 } })])
    await flush()
    await h.turn("turn.failed")
    expect(h.state(run).tasks[0]).toMatchObject({ state: "pending", attempt: 1, retryAt: START + 5_000, reason: "retrying after transient failure: the turn failed" })
    expect(h.submitted).toHaveLength(1)
    expect(h.clock.pending()).toBe(1)
    h.clock.advance(4_999)
    await flush()
    expect(h.submitted).toHaveLength(1)
    h.clock.advance(1)
    await flush()
    expect(h.state(run).tasks[0]).toMatchObject({ state: "running", attempt: 2 })
    expect(h.state(run).tasks[0]!.retryAt).toBeUndefined()
    await h.turn()
    expect(h.state(run)).toMatchObject({ state: "completed", tasks: [{ state: "done", attempt: 2 }] })
    expect(h.clock.pending()).toBe(0)
  })

  test("only the listed failure classes retry; a blocked answer is quality, so the default policy fails it", async () => {
    const h = harness()
    const run = h.create([agent("blocked", { retry: { maxAttempts: 3 } })])
    await flush()
    await h.turn("turn.completed", "```TASK_RESULT\nstatus: blocked\nsummary: no key\n```")
    expect(h.state(run)).toMatchObject({ state: "failed", tasks: [{ state: "failed", attempt: 1, reason: "blocked: no key" }] })
    const again = h.create([agent("blocked", { retry: { maxAttempts: 2, retryOn: ["quality"] } })])
    await flush()
    await h.turn("turn.completed", "```TASK_RESULT\nstatus: blocked\nsummary: no key\n```")
    expect(h.state(again).tasks[0]).toMatchObject({ state: "running", attempt: 2 })
  })

  test("a failing check task retries on quality and the budget class never retries", async () => {
    let calls = 0
    const h = harness(() => (++calls < 2 ? 1 : 0))
    const run = h.create([{ kind: "check", id: "unit", title: "unit", command: "bun test", retry: { maxAttempts: 2, retryOn: ["quality"] } }])
    await flush()
    await flush()
    expect(h.ran).toHaveLength(2)
    expect(h.state(run)).toMatchObject({ state: "completed", tasks: [{ state: "done", attempt: 2 }] })
    const plan = WorkflowPlan.parse({ name: "wf", objective: "x", tasks: [agent("a", { retry: { maxAttempts: 5, retryOn: ["budget", "transient"] } })] })
    const base = createRun({ workflowId: createIdFactory()("workflow"), plan, planHash: "0".repeat(64), directory: "/repo", permission: "ask", rootSessionId: createIdFactory()("session"), at: START })
    const started = startTask(base, "a", { at: START })
    expect(finishTask(started, "a", { outcome: "failed", reason: "token budget exhausted", failure: "budget", at: START }).tasks[0]!.state).toBe("failed")
    expect(finishTask(started, "a", { outcome: "failed", reason: "boom", failure: "transient", at: START }).tasks[0]!.state).toBe("pending")
    expect(finishTask(started, "a", { outcome: "failed", reason: "no class", at: START }).tasks[0]!.state).toBe("failed")
  })

  test("the scheduler skips a pending task until its retryAt", () => {
    const plan = WorkflowPlan.parse({ name: "wf", objective: "x", tasks: [agent("a", { retry: { maxAttempts: 2, backoffMs: 1_000 } })] })
    const base = createRun({ workflowId: createIdFactory()("workflow"), plan, planHash: "0".repeat(64), directory: "/repo", permission: "ask", rootSessionId: createIdFactory()("session"), at: START })
    const waiting = finishTask(startTask(base, "a", { at: START }), "a", { outcome: "failed", reason: "x", failure: "transient", at: START })
    expect(nextRetryAt(waiting)).toBe(START + 1_000)
    expect(readyTasks(waiting, false, START + 999)).toEqual([])
    expect(readyTasks(waiting, false, START + 1_000)).toEqual(["a"])
  })

  test("the policy shape is checked", () => {
    expect(validatePlan({ name: "wf", objective: "x", tasks: [agent("a", { retry: { maxAttempts: 7 } })] }).ok).toBe(false)
    expect(validatePlan({ name: "wf", objective: "x", tasks: [agent("a", { retry: { maxAttempts: 2, retryOn: [] } })] }).ok).toBe(false)
    expect(validatePlan({ name: "wf", objective: "x", tasks: [agent("a", { retry: { maxAttempts: 2, retryOn: ["nope"] } })] }).ok).toBe(false)
    const ok = validatePlan({ name: "wf", objective: "x", tasks: [agent("a", { retry: { maxAttempts: 2 } })], retention: { maxArtifacts: 5 } })
    expect(ok).toMatchObject({ ok: true, plan: { tasks: [{ retry: { maxAttempts: 2, backoffMs: 0, retryOn: ["transient", "environment"] } }], retention: { maxArtifacts: 5 } } })
  })
})
