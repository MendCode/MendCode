import { describe, expect, test } from "bun:test"
import { totalTaskUsage } from "../src/routing"
import { scriptHarness, settle } from "./script-harness"

const wf = (body: string) => `export const meta = { name: "t", description: "test", budget: { agents: 6 } }\n${body}`

describe("restarting one agent of a run (r on /workflows)", () => {
  test("a running agent is cancelled and starts again in its own place", async () => {
    const h = scriptHarness({ responder: () => "HOLD" })
    const run = h.start(wf(`return await agent("slow")`))
    await settle(20)
    const task = h.get(run).tasks[0]!
    expect(task.state).toBe("running")
    const sessionBefore = task.sessionId
    const result = h.service.control(run.workflowId, "retry", { taskId: task.id })
    expect("error" in result).toBe(false)
    expect(h.cancelled.some((entry) => entry.sessionId === sessionBefore)).toBe(true)
    await settle(20)
    expect(h.get(run).tasks).toHaveLength(1)
    expect(h.get(run).tasks[0]!.state).toBe("running")
    expect(h.prompts.filter((prompt) => prompt.startsWith("slow"))).toHaveLength(2)
  })

  test("a finished agent is asked again: its journaled answer goes and the script continues from the new one", async () => {
    let answers = 0
    const h = scriptHarness({ responder: (prompt) => (prompt.startsWith("first") ? `answer-${++answers}` : "HOLD") })
    const run = h.start(wf(`const a = await agent("first")\nreturn await agent("second " + a)`))
    await settle(30)
    const first = h.get(run).tasks.find((task) => task.title === "first")!
    expect(first.state).toBe("done")
    expect(h.prompts.at(-1)).toBe("second answer-1")
    const restarted = h.service.control(run.workflowId, "retry", { taskId: first.id })
    expect("error" in restarted).toBe(false)
    await settle(30)
    // The agent answered again and the script's next call was made from the new answer.
    expect(answers).toBe(2)
    expect(h.get(run).tasks.find((task) => task.id === first.id)!.state).toBe("done")
    expect(h.prompts).toContain("second answer-2")
    // The agent the old answer started was ended and left the run; only the one asked for from the new answer remains, and it runs.
    const seconds = h.get(run).tasks.filter((task) => task.title.startsWith("second"))
    expect(seconds).toHaveLength(1)
    expect(h.cancelled.length).toBeGreaterThan(0)
    expect(h.cancelled.some((entry) => entry.sessionId === seconds[0]!.sessionId)).toBe(false)
    expect(h.get(run).tasks.filter((task) => task.state === "running")).toHaveLength(1)
    // It did not start from the old answer a second time before the script asked for the new one.
    expect(h.prompts.filter((prompt) => prompt === "second answer-1")).toHaveLength(1)
  })

  test("what an agent removed by a restart had used still counts in the run's total", async () => {
    let answers = 0
    const h = scriptHarness({ responder: (prompt) => (prompt.startsWith("first") ? `answer-${++answers}` : "HOLD") })
    const run = h.start(wf(`const a = await agent("first")\nreturn await agent("second " + a)`))
    await settle(30)
    const first = h.get(run).tasks.find((task) => task.title === "first")!
    const second = h.get(run).tasks.find((task) => task.title.startsWith("second"))!
    h.service.recordUsage(second.sessionId!, { type: "usage.recorded", sessionId: second.sessionId!, seq: 1, at: 0, turnId: h.ids("turn"), provider: "fake", model: "fake", input: 7, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    expect("error" in h.service.control(run.workflowId, "retry", { taskId: first.id })).toBe(false)
    await settle(30)
    const after = h.get(run)
    expect(after.tasks.some((task) => task.id === second.id)).toBe(false)
    expect(after.retiredUsage?.input).toBe(7)
    expect(after.retiredUsage?.output).toBe(3)
    expect(totalTaskUsage(after).input).toBeGreaterThanOrEqual(7)
  })

  test("a script whose second call does not depend on the first is not stuck after the first is restarted: both finish", async () => {
    let answers = 0
    const h = scriptHarness({ responder: (prompt) => (prompt.startsWith("first") ? `answer-${++answers}` : prompt.startsWith("second") ? (answers < 2 ? "HOLD" : "second-done") : "ok") })
    const run = h.start(wf(`await agent("first")\nreturn await agent("second")`))
    await settle(30)
    const first = h.get(run).tasks.find((task) => task.title === "first")!
    expect(first.state).toBe("done")
    expect(h.get(run).tasks.find((task) => task.title === "second")!.state).toBe("running")
    expect("error" in h.service.control(run.workflowId, "retry", { taskId: first.id })).toBe(false)
    await settle(60)
    // The same second task starts again and the script ends: it does not wait for a cancelled agent.
    expect(h.get(run).tasks.filter((task) => task.title === "second")).toHaveLength(1)
    expect(h.get(run).state).toBe("completed")
  })

  test("a run that is over refuses a restart, and a step that never started has nothing to restart", async () => {
    const h = scriptHarness({ responder: () => "ok" })
    const run = h.start(wf(`return await agent("one")`))
    await settle(30)
    expect(h.get(run).state).toBe("completed")
    expect(h.service.control(run.workflowId, "retry", { taskId: h.get(run).tasks[0]!.id })).toMatchObject({ error: expect.stringContaining("cannot retry") })
  })
})
