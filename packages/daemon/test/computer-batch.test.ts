import { afterEach, expect, test } from "bun:test"
import type { ComputerCodeReport } from "@mendcode/protocol"
import { NotDelivered, type SemanticAction } from "../src/computer-accessibility"
import { b80Fixture, data } from "./b80-fixtures"
import { signal } from "./b29-fixtures"

// Demo AX only: these tests never launch or modify any real application.
const fixtures: ReturnType<typeof b80Fixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.close() })
async function controlled() {
  const f = b80Fixture(); fixtures.push(f)
  f.ax.state.nodes[1]!.actions = ["press", "click", "key"]
  f.ax.state.nodes[2]!.actions = ["setValue", "typeText", "key"]
  return { f, session: await f.start("control") }
}
async function run(f: ReturnType<typeof b80Fixture>, computerSessionID: string, code: string) {
  return data<ComputerCodeReport>(await f.port.code!({ computerSessionID, code }, signal()))
}
const status = "return await tools.status({})"

test("a batch runs several actions on one observation in one call, with one indicator, and reports each step", async () => {
  const { f, session } = await controlled()
  f.ax.calls.length = 0
  const report = await run(f, session.computerSessionID, `
    const o = await tools.observe({})
    return await tools.batch({ revision: o.revision, steps: [
      { action: "setValue", nodeID: "0.2", value: "draft two" },
      { action: "key", nodeID: "0.2", key: "enter" },
      { action: "press", nodeID: "0.1" },
    ] })`)
  expect(report.toolCalls.map((call) => call.name)).toEqual(["observe", "batch"])
  expect(f.ax.actions.map((step) => [step.action, step.nodeID])).toEqual([["setValue", "0.2"], ["key", "0.2"], ["press", "0.1"]])
  expect(f.ax.calls.filter((call) => call === "indicator")).toHaveLength(1)
  expect(report.value).toMatchObject({ ok: true, verified: false, steps: [
    { index: 0, action: "setValue", outcome: "dispatched", delivery: "delivered_unverified", retry: "unsafe" },
    { index: 1, action: "key", outcome: "dispatched" },
    { index: 2, action: "press", outcome: "dispatched" },
  ] })
  const audit = await run(f, session.computerSessionID, status)
  expect(audit.value).toMatchObject({ audit: [{ action: "setValue", result: "dispatched" }, { action: "key", result: "dispatched" }, { action: "press", result: "dispatched" }] })
  // The observation is consumed once, as by one action.
  const stale = await f.port.code!({ computerSessionID: session.computerSessionID, code: `await tools.press({ revision: ${(report.value as { revision: number }).revision - 1}, nodeID: "0.1" })` }, signal())
  expect(stale.output).toContain("stale")
})

test("a backend with native batches gets every step in one request", async () => {
  const { f, session } = await controlled()
  const requests: SemanticAction[][] = []
  f.ax.os.batch = async (_, steps) => { requests.push(steps); return steps.map((_, index) => ({ index, outcome: "dispatched" as const })) }
  const report = await run(f, session.computerSessionID, `const o = await tools.observe({}); return await tools.batch({ revision: o.revision, steps: [{ action: "press", nodeID: "0.1" }, { action: "typeText", nodeID: "0.2", value: "x" }] })`)
  expect(requests).toHaveLength(1)
  expect(requests[0]!.map((step) => [step.action, step.nodeID, step.role])).toEqual([["press", "0.1", "AXButton"], ["typeText", "0.2", "AXTextField"]])
  expect(f.ax.actions).toEqual([])
  expect(report.value).toMatchObject({ ok: true, steps: [{ outcome: "dispatched" }, { outcome: "dispatched" }] })
})

test("every step is checked before the first is sent: one bad step refuses the whole batch, nothing is delivered", async () => {
  const { f, session } = await controlled()
  for (const steps of [
    `[{ action: "press", nodeID: "0.1" }, { action: "press", nodeID: "0.9" }]`,
    `[{ action: "press", nodeID: "0.1" }, { action: "setValue", nodeID: "0.3", value: "x" }]`,
    `[{ action: "press", nodeID: "0.1" }, { action: "typeText", nodeID: "0.1", value: "x" }]`,
    `[{ action: "press", nodeID: "0.1", value: "x" }]`,
    `[{ action: "key", nodeID: "0.2" }]`,
  ]) {
    const result = await f.port.code!({ computerSessionID: session.computerSessionID, code: `const o = await tools.observe({}); return await tools.batch({ revision: o.revision, steps: ${steps} })` }, signal())
    expect(result.isError).toBe(true)
    expect(result.output).toContain("not delivered")
  }
  expect(f.ax.actions).toEqual([])
  expect((await run(f, session.computerSessionID, status)).value).toMatchObject({ audit: [] })
  const tooLarge = await f.port.code!({ computerSessionID: session.computerSessionID, code: `const o = await tools.observe({}); const text = "x".repeat(32000); return await tools.batch({ revision: o.revision, steps: [1, 2, 3, 4].map(() => ({ action: "setValue", nodeID: "0.2", value: text })) })` }, signal())
  expect(tooLarge.output).toContain("120 KB")
  expect(f.ax.actions).toEqual([])
})

test("the first failing step stops the batch: a refusal is safe to retry, an unknown outcome is not, later steps never start", async () => {
  for (const [failure, outcome, delivery, retry] of [[new NotDelivered("Semantic node changed"), "failed", "not_delivered", "safe"], [new Error("AXPress failed"), "unknown", "unknown", "unsafe"]] as const) {
    const { f, session } = await controlled()
    let count = 0
    f.ax.state.onAction = async () => { if (++count === 2) throw failure }
    const report = await run(f, session.computerSessionID, `const o = await tools.observe({}); return await tools.batch({ revision: o.revision, steps: [{ action: "press", nodeID: "0.1" }, { action: "press", nodeID: "0.1" }, { action: "setValue", nodeID: "0.2", value: "never" }] })`)
    expect(report.value).toMatchObject({ ok: false, stopped: { index: 1, reason: "step_failed" }, steps: [
      { outcome: "dispatched" },
      { outcome, delivery, retry, error: failure.message },
      { outcome: "not_started", delivery: "not_delivered", retry: "safe" },
    ] })
    expect(f.ax.actions.map((step) => step.action)).toEqual(["press"])
    expect((await run(f, session.computerSessionID, status)).value).toMatchObject({ audit: [{ result: "dispatched" }, { result: outcome }] })
  }
})

test("a native report that does not match its steps cannot say what ran, so every step counts as unknown", async () => {
  const { f, session } = await controlled()
  f.ax.os.batch = async () => [{ index: 1, outcome: "dispatched" }]
  const result = await f.port.code!({ computerSessionID: session.computerSessionID, code: `const o = await tools.observe({}); return await tools.batch({ revision: o.revision, steps: [{ action: "press", nodeID: "0.1" }, { action: "press", nodeID: "0.1" }] })` }, signal())
  expect(result.output).toContain("delivery unknown")
  expect((await run(f, session.computerSessionID, status)).value).toMatchObject({ audit: [{ result: "unknown" }, { result: "unknown" }] })
})

test("a single action the helper refused before any effect is audited as failed and says it is safe to retry; other failures stay unknown", async () => {
  const { f, session } = await controlled()
  f.ax.state.onAction = async () => { throw new NotDelivered("The pointer would hit AXStaticText at the node's center, not the node; no input was sent") }
  const refused = await f.port.code!({ computerSessionID: session.computerSessionID, code: "const o = await tools.observe({}); await tools.click({revision:o.revision,nodeID:'0.1'})" }, signal())
  expect(refused.output).toContain("not delivered")
  f.ax.state.onAction = async () => { throw new Error("Native operation cancelled or timed out; effects may be partial") }
  const unknown = await f.port.code!({ computerSessionID: session.computerSessionID, code: "const o = await tools.observe({}); await tools.click({revision:o.revision,nodeID:'0.1'})" }, signal())
  expect(unknown.output).toContain("delivery unknown")
  expect((await run(f, session.computerSessionID, status)).value).toMatchObject({ audit: [{ result: "failed" }, { result: "unknown" }] })
  // A refusal in the daemon, before the helper is asked, sends nothing either.
  const stale = await f.port.code!({ computerSessionID: session.computerSessionID, code: "await tools.press({revision:1,nodeID:'0.1'})" }, signal())
  expect(stale.output).toContain("stale")
  expect(stale.output).toContain("not delivered")
})
