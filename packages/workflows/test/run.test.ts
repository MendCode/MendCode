import { describe, expect, test } from "bun:test"
import { createIdFactory, WorkflowPlan, type LoopGate, type WorkflowRun } from "@mendcode/protocol"
import { acceptRun, applyVerification, auditNeeded, controlRun, createRun, deriveWorkflowState, finishTask, judgeVerification, readyTasks, reconcileAfterRestart, retryTask, setWaiting, startTask, type AuditOutcome } from "../src"

const ids = createIdFactory()
type TaskInput = { id: string; needs?: string[]; mode?: "read" | "work"; check?: boolean }

function run(tasks: TaskInput[], extra: Record<string, unknown> = {}): WorkflowRun {
  const plan = WorkflowPlan.parse({
    name: "wf",
    objective: "Ship it.",
    tasks: tasks.map((t) => (t.check ? { kind: "check", id: t.id, title: t.id, command: "bun test", needs: t.needs ?? [] } : { kind: "agent", id: t.id, title: t.id, prompt: `do ${t.id}`, needs: t.needs ?? [], mode: t.mode ?? "read" })),
    ...extra,
  })
  return createRun({ workflowId: ids("workflow"), plan, planHash: "0".repeat(64), directory: "/repo", permission: "edits", rootSessionId: ids("session"), at: 0 })
}
const state = (r: WorkflowRun, id: string) => r.tasks.find((t) => t.id === id)!.state

test("B21 input-waiting retry preserves attempts and session, resets dependents and carries the reason", () => {
  const sessionId = ids("session")
  const waiting = setWaiting(startTask(run([{ id: "a" }, { id: "b", needs: ["a"] }]), "a", { at: 1, sessionId }), "a", true, 2)
  const next = retryTask(waiting, "a", 3, "Use the confirmed input")
  expect(next.tasks[0]).toMatchObject({ state: "pending", attempt: 1, sessionId, feedback: "Use the confirmed input" })
  expect(next.tasks[1]!.state).toBe("pending")
  expect(next.state).toBe("running")
  expect(retryTask({ ...waiting, tasks: [{ ...waiting.tasks[0]!, attempt: 6 }, waiting.tasks[1]!] }, "a", 3).tasks[0]).toMatchObject({ state: "pending", attempt: 6 })
})
const done = (r: WorkflowRun, id: string, at = 1) => finishTask(startTask(r, id, { at }), id, { outcome: "done", result: `${id} ok`, at: at + 1 })
const contract = { criteria: [{ id: "tests", text: "tests pass", owners: ["build"] }, { id: "docs", text: "docs updated" }], checks: [{ id: "unit", command: "bun test", covers: ["tests"] }] }
const gate = (status: "pass" | "fail"): LoopGate => ({ id: "bun test", status, ...(status === "fail" ? { detail: "2 failing" } : {}) })
const audit = (over: Partial<AuditOutcome> = {}): AuditOutcome => ({ verdict: "pass", sessionId: ids("session"), inspections: 2, findings: "read README", criteria: [{ id: "docs", status: "pass", evidence: "README.md:12" }], ...over })

describe("task transitions", () => {
  test("a task starts only when its needs are done, and the run follows its tasks", () => {
    let r = run([{ id: "a" }, { id: "b", needs: ["a"] }])
    expect(readyTasks(r)).toEqual(["a"])
    expect(() => startTask(r, "b", { at: 1 })).toThrow(RangeError)
    r = done(r, "a")
    expect(readyTasks(r)).toEqual(["b"])
    r = done(r, "b", 3)
    expect(r.state).toBe("completed")
    expect(r.endedAt).toBe(4)
  })

  test("waiting on a request is derived from the session and reported as needs_input", () => {
    let r = startTask(run([{ id: "a" }]), "a", { at: 1 })
    r = setWaiting(r, "a", true, 2)
    expect([state(r, "a"), r.state]).toEqual(["needs_input", "needs_input"])
    r = setWaiting(r, "a", false, 3)
    expect([state(r, "a"), r.state]).toEqual(["running", "running"])
  })

  test("a failed task skips what needs it, and the run fails", () => {
    let r = startTask(run([{ id: "a" }, { id: "b", needs: ["a"] }, { id: "c", needs: ["b"] }]), "a", { at: 1 })
    r = finishTask(r, "a", { outcome: "failed", reason: "boom", at: 2 })
    expect([state(r, "b"), state(r, "c"), r.state]).toEqual(["skipped", "skipped", "failed"])
  })

  test("interruptions retry up to three starts, then fail", () => {
    let r = run([{ id: "a" }])
    for (let i = 0; i < 2; i++) {
      r = finishTask(startTask(r, "a", { at: i }), "a", { outcome: "interrupted", reason: "reset", at: i })
      expect(state(r, "a")).toBe("pending")
    }
    r = finishTask(startTask(r, "a", { at: 5 }), "a", { outcome: "interrupted", reason: "reset", at: 6 })
    expect(state(r, "a")).toBe("failed")
    expect(r.tasks[0]!.attempt).toBe(3)
  })

  test("a user cancel stops the task and pauses the run; resume brings it back", () => {
    let r = finishTask(startTask(run([{ id: "a" }]), "a", { at: 1 }), "a", { outcome: "cancelled", at: 2 })
    expect([state(r, "a"), r.state]).toEqual(["stopped", "paused"])
    expect(readyTasks(r)).toEqual([])
    r = controlRun(r, "resume", 3)
    expect([state(r, "a"), r.state, readyTasks(r)]).toEqual(["pending", "running", ["a"]])
  })

  test("retry resets the task and its dependents but keeps the attempt count", () => {
    let r = startTask(run([{ id: "a" }, { id: "b", needs: ["a"] }]), "a", { at: 1 })
    r = finishTask(r, "a", { outcome: "failed", reason: "x", at: 2 })
    r = retryTask(r, "a", 3)
    expect([state(r, "a"), state(r, "b"), r.state, r.tasks[0]!.attempt]).toEqual(["pending", "pending", "running", 1])
    expect(() => retryTask(r, "a", 4)).toThrow(RangeError)
  })

  test("stop ends the run and every unfinished task; nothing starts after", () => {
    const r = controlRun(startTask(run([{ id: "a" }, { id: "b" }]), "a", { at: 1 }), "stop", 2)
    expect([r.state, state(r, "a"), state(r, "b"), readyTasks(r)]).toEqual(["stopped", "stopped", "stopped", []])
    expect(controlRun(r, "resume", 3)).toBe(r)
  })

  test("pause drains: running tasks finish, nothing new starts", () => {
    let r = controlRun(startTask(run([{ id: "a" }, { id: "b", needs: ["a"] }]), "a", { at: 1 }), "pause", 2)
    r = finishTask(r, "a", { outcome: "done", result: "ok", at: 3 })
    expect([r.state, readyTasks(r)]).toEqual(["paused", []])
  })

  test("after a restart running tasks go back to pending", () => {
    const r = reconcileAfterRestart(setWaiting(startTask(run([{ id: "a" }]), "a", { at: 1 }), "a", true, 2), 3)
    expect([state(r, "a"), r.state]).toEqual(["pending", "running"])
  })
})

describe("scheduling", () => {
  test("work-conserving: C starts when B ends, not when the long A ends (F8)", () => {
    let r = run([{ id: "a" }, { id: "b" }, { id: "c", needs: ["b"] }], { maxConcurrent: 2 })
    expect(readyTasks(r)).toEqual(["a", "b"])
    r = startTask(startTask(r, "a", { at: 1 }), "b", { at: 1 })
    r = finishTask(r, "b", { outcome: "done", result: "ok", at: 2 })
    expect(readyTasks(r)).toEqual(["c"])
  })

  test("one work task per directory at a time; read tasks run beside it (W-I2)", () => {
    const r = run([{ id: "w1", mode: "work" }, { id: "w2", mode: "work" }, { id: "r1" }], { maxConcurrent: 3 })
    expect(readyTasks(r)).toEqual(["w1", "r1"])
    expect(readyTasks(r, true)).toEqual(["r1"])
  })

  test("seeded random orderings keep the invariants", () => {
    for (let seed = 1; seed <= 300; seed++) {
      let random = seed
      const next = () => ((random = (random * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31)
      let r = run(
        [{ id: "a", mode: "work" }, { id: "b" }, { id: "c", needs: ["a"], mode: "work" }, { id: "d", needs: ["a", "b"] }, { id: "e", needs: ["c", "d"] }],
        { maxConcurrent: 2 },
      )
      for (let step = 0; step < 60 && !["completed", "failed", "stopped"].includes(r.state); step++) {
        const ready = readyTasks(r)
        const active = r.tasks.filter((t) => t.state === "running" || t.state === "needs_input")
        if (ready.length && (active.length === 0 || next() < 0.5)) r = startTask(r, ready[Math.floor(next() * ready.length)]!, { at: step })
        else if (active.length) {
          const task = active[Math.floor(next() * active.length)]!
          const roll = next()
          r = roll < 0.7 ? finishTask(r, task.id, { outcome: "done", result: "ok", at: step }) : roll < 0.8 ? finishTask(r, task.id, { outcome: "failed", reason: "x", at: step }) : roll < 0.9 ? finishTask(r, task.id, { outcome: "interrupted", reason: "x", at: step }) : setWaiting(r, task.id, task.state === "running", step)
        } else if (r.state === "paused") r = controlRun(r, "resume", step)
        const running = r.tasks.filter((t) => t.state === "running" || t.state === "needs_input")
        expect(running.length).toBeLessThanOrEqual(2)
        expect(running.filter((t) => t.mode === "work").length).toBeLessThanOrEqual(1)
        for (const t of running) expect(t.needs.every((n) => state(r, n) === "done")).toBe(true)
        for (const t of r.tasks.filter((t) => t.state === "skipped")) expect(t.needs.some((n) => ["failed", "skipped", "stopped"].includes(state(r, n)))).toBe(true)
        if (r.state === "completed") expect(r.tasks.every((t) => t.state === "done")).toBe(true)
        expect(deriveWorkflowState(r)).toBe(r.state)
      }
    }
  })
})

describe("verification", () => {
  const verifying = () => {
    let r = run([{ id: "build", mode: "work" }, { id: "doc" }], { contract })
    r = done(done(r, "build"), "doc", 3)
    expect(r.state).toBe("verifying")
    return r
  }

  test("auto asks the auditor only when a required criterion has no covering check", () => {
    const parsed = WorkflowPlan.parse({ name: "x", objective: "y", tasks: [{ kind: "agent", id: "a", title: "a", prompt: "p" }], contract }).contract as never
    expect(auditNeeded(parsed)).toBe(true)
    expect(auditNeeded({ ...(parsed as object), criteria: [{ id: "tests", text: "t", required: true }] } as never)).toBe(false)
  })

  test("checks decide what they cover, the audit decides the rest; all pass completes", () => {
    const r = verifying()
    const v = judgeVerification({ contract: r.plan.contract as never, round: 1, at: 5, gates: [gate("pass")], audit: audit() })
    expect(v.criteria).toEqual([{ id: "tests", status: "pass", by: "check" }, { id: "docs", status: "pass", by: "audit" }])
    expect(applyVerification(r, v, 5).state).toBe("completed")
  })

  test("an audit without inspections or with a changed workspace is void", () => {
    const r = verifying()
    for (const bad of [audit({ inspections: 0 }), audit({ workspaceChanged: true })]) {
      const v = judgeVerification({ contract: r.plan.contract as never, round: 1, at: 5, gates: [gate("pass")], audit: bad })
      expect(v.criteria[1]).toEqual({ id: "docs", status: "unsure", by: "audit" })
      expect(v.accepted).toBe(false)
    }
  })

  test("a rejection re-runs the owners with the failure as feedback", () => {
    const r = verifying()
    const v = judgeVerification({ contract: r.plan.contract as never, round: 1, at: 5, gates: [gate("fail")], audit: audit() })
    const next = applyVerification(r, v, 5)
    expect([next.state, state(next, "build"), state(next, "doc"), next.repairs]).toEqual(["running", "pending", "done", 1])
    expect(next.tasks[0]!.feedback).toContain("2 failing")
    // The note is consumed when the owner starts again.
    expect(startTask(next, "build", { at: 6 }).tasks[0]!.feedback).toBeUndefined()
  })

  test("repairs run out into blocked; resume verifies again; accept overrides with a reason", () => {
    let r = verifying()
    const fail = () => judgeVerification({ contract: r.plan.contract as never, round: r.verifications.length + 1, at: 9, gates: [gate("fail")], audit: audit() })
    for (let i = 0; i < 2; i++) r = done(applyVerification(r, fail(), 9), "build", 10)
    r = applyVerification(r, fail(), 12)
    expect([r.state, r.reason]).toEqual(["blocked", "contract still failing after 2 repairs"])
    expect(controlRun(r, "resume", 13).state).toBe("verifying")
    expect(acceptRun(r, "known flaky test", 14)).toMatchObject({ state: "completed", override: { reason: "known flaky test" } })
  })

  test("no declared owner with several workers blocks instead of guessing", () => {
    let r = run([{ id: "x", mode: "work" }, { id: "y", mode: "work" }], { contract: { criteria: [{ id: "c", text: "c" }], checks: [{ id: "k", command: "bun test", covers: ["c"] }] } })
    r = done(done(r, "x"), "y", 3)
    const v = judgeVerification({ contract: r.plan.contract as never, round: 1, at: 5, gates: [gate("fail")] })
    expect(applyVerification(r, v, 5)).toMatchObject({ state: "blocked", reason: "no repair owner declared for: c, k" })
  })
})
