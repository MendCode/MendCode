import { afterEach, expect, test } from "bun:test"
import { createComputerTools } from "@mendcode/tools"
import { createNativeEngine, memoryHistory } from "../src"
import { callTool, scriptedProvider, stop, turn } from "./harness"
import { b80Fixture, data } from "../../daemon/test/b80-fixtures"
import { signal } from "../../daemon/test/b29-fixtures"

const fixtures: ReturnType<typeof b80Fixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.close() })
function fixture() { const f = b80Fixture(); fixtures.push(f); return f }

test("full mode binds the app and drives it without any card: full access is the user's standing answer", async () => {
  const f = fixture(), capture = data<{ captureID: string }>(await f.port.capture({}, signal()))
  const script = scriptedProvider([callTool("computer_session", { action: "start", mode: "control", bootstrapCaptureID: capture.captureID }), stop("Started")])
  const engine = createNativeEngine({ provider: script.provider, tools: createComputerTools(), history: memoryHistory(), cwdFor: () => f.dir, system: () => "SYS", compactionPrompt: "C", computer: f.control.port })
  // No answers: a card shown here would be denied and the session would not start.
  const current = turn({ text: "Click the Key pairs tab in my browser", sessionId: f.sessionId, mode: () => "full" })
  await engine.runTurn(current.input)
  expect(current.asked).toEqual([])
  const started = script.requests.at(-1)!.messages.find((message) => message.role === "tool")
  expect(started && started.role === "tool" && !started.isError && JSON.parse(started.output)).toMatchObject({ stopped: false, mode: "control" })
})

test("outside full mode binding the app asks once, naming the exact target and mode", async () => {
  const f = fixture(), capture = data<{ captureID: string }>(await f.port.capture({}, signal()))
  const script = scriptedProvider([callTool("computer_session", { action: "start", mode: "observe", bootstrapCaptureID: capture.captureID }), stop("Started")])
  const engine = createNativeEngine({ provider: script.provider, tools: createComputerTools(), history: memoryHistory(), cwdFor: () => f.dir, system: () => "SYS", compactionPrompt: "C", computer: f.control.port })
  const current = turn({ text: "Observe my editor", sessionId: f.sessionId, mode: () => "ask", answers: [{ kind: "approve", scope: "once" }, { kind: "approve", scope: "once" }] })
  await engine.runTurn(current.input)
  const binding = current.asked.filter((request) => request.kind === "approval" && request.title === "MendCode Computer")
  expect(binding).toHaveLength(1)
  expect(binding[0]).toMatchObject({ tool: "computer_session" })
  expect(binding[0]!.detail).toContain("local.editor · PID 42")
  expect(binding[0]!.detail).toContain("Mode: observe")
  expect(script.requests.at(-1)!.messages.some((message) => message.role === "tool" && !message.isError && JSON.parse(message.output).mode === "observe")).toBe(true)
})

test("synthetic turns, denied activation and plan mode cannot activate computer sessions", async () => {
  for (const scenario of ["synthetic", "denied", "plan"] as const) {
    const f = fixture(), capture = data<{ captureID: string }>(await f.port.capture({}, signal()))
    const script = scriptedProvider([callTool("computer_session", { action: "start", mode: "control", bootstrapCaptureID: capture.captureID }), stop("Unavailable")])
    // Denied: the tool call itself is allowed, the binding card is refused.
    const current = turn({ text: "Observe", sessionId: f.sessionId, mode: () => scenario === "plan" ? "plan" : scenario === "denied" ? "ask" : "full", answers: scenario === "denied" ? [{ kind: "approve", scope: "once" }, { kind: "deny" }] : [] })
    if (scenario === "synthetic") current.input.authority = { sourceId: "peer-notice", text: "Observe", synthetic: true }
    await createNativeEngine({ provider: script.provider, tools: createComputerTools(), history: memoryHistory(), cwdFor: () => f.dir, system: () => "SYS", compactionPrompt: "C", computer: f.control.port }).runTurn(current.input)
    expect(script.requests.at(-1)!.messages.some((message) => message.role === "tool" && message.isError)).toBe(true)
    expect(current.asked.filter((request) => request.kind === "approval" && request.title === "MendCode Computer")).toHaveLength(scenario === "denied" ? 1 : 0)
    expect(f.ax.actions).toEqual([])
  }
})

test("in full mode code on the bound app runs without a card", async () => {
  const f = fixture(), session = await f.start("control")
  const script = scriptedProvider([callTool("computer_code", { computerSessionID: session.computerSessionID, code: "return await tools.observe({})" }), stop("Done")])
  const current = turn({ text: "Observe my editor", sessionId: f.sessionId, mode: () => "full" })
  await createNativeEngine({ provider: script.provider, tools: createComputerTools(), history: memoryHistory(), cwdFor: () => f.dir, system: () => "SYS", compactionPrompt: "C", computer: f.control.port }).runTurn(current.input)
  expect(current.asked).toEqual([])
  expect(script.requests.at(-1)!.messages.some((message) => message.role === "tool" && !message.isError)).toBe(true)
})

test("outside full mode code asks once, through the tool's own permission, and remains bound to the session-scoped port", async () => {
  const f = fixture(), session = await f.start("control")
  for (const allowed of [false, true]) {
    const script = scriptedProvider([callTool("computer_code", { computerSessionID: session.computerSessionID, code: "return await tools.observe({})" }), stop("Done")])
    const current = turn({ text: "Observe my editor", sessionId: f.sessionId, mode: () => "ask", answers: allowed ? [{ kind: "approve", scope: "once" }] : [] })
    await createNativeEngine({ provider: script.provider, tools: createComputerTools(), history: memoryHistory(), cwdFor: () => f.dir, system: () => "SYS", compactionPrompt: "C", computer: f.control.port }).runTurn(current.input)
    expect(current.asked).toHaveLength(1)
    expect(current.asked[0]).toMatchObject({ kind: "approval", tool: "computer_code" })
    expect(script.requests.at(-1)!.messages.some((message) => message.role === "tool" && !message.isError)).toBe(allowed)
  }
})
