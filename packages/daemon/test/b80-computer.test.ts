import { afterEach, expect, test } from "bun:test"
import { Command, createIdFactory, type ComputerCaptureMetadata, type ComputerCodeReport } from "@mendcode/protocol"
import { isReadOnlyCommand } from "@mendcode/protocol/wire"
import { createComputerTools, BUILTIN_TOOLS, runTool } from "@mendcode/tools"
import { createMacAccessibility } from "../src/computer-accessibility"
import { b80Fixture, activation, data } from "./b80-fixtures"
import { signal } from "./b29-fixtures"

const fixtures: ReturnType<typeof b80Fixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.close() })
function fixture(options: Parameters<typeof b80Fixture>[0] = {}) { const f = b80Fixture(options); fixtures.push(f); return f }

test("B80 additive commands validate bounded inputs and expose no computer content to read-only peers", () => {
  const ids = createIdFactory(), base = { id: ids("command"), clientId: ids("client"), sessionId: ids("session") }
  for (const [type, input] of [["computer.session", { action: "start", mode: "observe", bootstrapCaptureID: crypto.randomUUID() }], ["computer.observe", { computerSessionID: crypto.randomUUID() }], ["computer.code", { computerSessionID: crypto.randomUUID(), code: "return null" }]]) {
    expect(Command.safeParse({ ...base, type, input }).success).toBe(true)
    expect(isReadOnlyCommand(type as "computer.session")).toBe(false)
  }
  for (const input of [{ action: "start", mode: "full", bootstrapCaptureID: crypto.randomUUID() }, { action: "start", mode: "observe", bootstrapCaptureID: crypto.randomUUID(), approved: true }]) expect(Command.safeParse({ ...base, type: "computer.session", input }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "computer.code", input: { computerSessionID: crypto.randomUUID(), code: "é".repeat(17000) } }).success).toBe(false)
  expect(createComputerTools().map((tool) => tool.name)).toEqual(["computer_capture", "computer_key", "computer_session", "computer_observe", "computer_code"])
  expect(BUILTIN_TOOLS.some((tool) => tool.name.startsWith("computer_"))).toBe(false)
})

test("session activation is fresh, exact-target, real-user and single-use even across concurrent approvals", async () => {
  const f = fixture()
  const capture = data<ComputerCaptureMetadata>(await f.port.capture({}, signal()))
  expect(capture.computerSessionBootstrapAvailable).toBe(true)
  const input = { action: "start" as const, mode: "observe" as const, bootstrapCaptureID: capture.captureID }
  for (const authority of [undefined, { ...activation, synthetic: true }, { ...activation, text: "" }, { ...activation, approve: async () => false }]) expect((await f.port.session!(input, signal(), authority)).isError).toBe(true)
  expect((await f.control.port(f.otherId).session!(input, signal(), activation)).isError).toBe(true)
  const results = await Promise.all([f.port.session!(input, signal(), activation), f.port.session!(input, signal(), activation)])
  expect(results.filter((result) => !result.isError)).toHaveLength(1)
  expect((await f.port.key({ captureID: capture.captureID, key: "tab" }, signal())).isError).toBe(true)
  const next = data<ComputerCaptureMetadata>(await f.port.capture({}, signal()))
  await f.port.key({ captureID: next.captureID, key: "tab" }, signal())
  expect((await f.port.session!({ ...input, bootstrapCaptureID: next.captureID }, signal(), activation)).isError).toBe(true)
})

test("bootstrap expires during approval and focus changes cannot redirect a session", async () => {
  const f = fixture()
  let capture = data<ComputerCaptureMetadata>(await f.port.capture({}, signal()))
  const input = () => ({ action: "start" as const, mode: "control" as const, bootstrapCaptureID: capture.captureID })
  expect((await f.port.session!(input(), signal(), { ...activation, approve: async () => { f.advance(30001); return true } })).output).toContain("stale")
  capture = data<ComputerCaptureMetadata>(await f.port.capture({}, signal()))
  expect((await f.port.session!(input(), signal(), { ...activation, approve: async () => { f.ax.state.target.bundleID = "local.other"; return true } })).output).toContain("changed")
  const window = data<ComputerCaptureMetadata>(await f.port.capture({ windowID: 42 }, signal()))
  expect(window.computerSessionBootstrapAvailable).toBe(false)
})

test("observe returns bounded revisions, redacts secure fields and binds the owner and foreground app", async () => {
  const f = fixture(), session = await f.start()
  const first = await f.observe(session.computerSessionID)
  expect(first.revision).toBe(1)
  expect(first.nodes[3]).toMatchObject({ secure: true, name: "", actions: [] })
  expect(JSON.stringify(first)).not.toContain("SECRET")
  const second = await f.port.observe!({ computerSessionID: session.computerSessionID, screenshot: true }, signal())
  expect(second.output).toContain("screenshotFallback")
  expect(JSON.parse(second.output).revision).toBe(2)
  expect((await f.control.port(f.otherId).observe!({ computerSessionID: session.computerSessionID }, signal())).isError).toBe(true)
  f.ax.state.target.pid = 43
  expect((await f.port.observe!({ computerSessionID: session.computerSessionID }, signal())).output).toContain("changed")
  f.ax.state.target.pid = 42
  expect((await f.port.observe!({ computerSessionID: session.computerSessionID }, signal())).output).toContain("stopped")
})

test("successful observation refreshes idle time but cannot extend the absolute ten-minute TTL", async () => {
  const f = fixture(), session = await f.start()
  for (let i = 0; i < 11; i++) { f.advance(50000); await f.observe(session.computerSessionID) }
  f.advance(50000)
  expect((await f.port.observe!({ computerSessionID: session.computerSessionID }, signal())).output).toContain("expired")
  const idle = await f.start()
  f.advance(60000)
  expect((await f.port.observe!({ computerSessionID: idle.computerSessionID }, signal())).output).toContain("expired")
})

test("semantic code uses data selection, host revisions and a visible indicator; stale or secure actions fail", async () => {
  const f = fixture(), session = await f.start("control")
  const code = "const o = await tools.observe({}); const save = o.nodes.find(n => n.name === 'Save'); await tools.press({revision:o.revision,nodeID:save.id}); const next = await tools.observe({}); return next.revision"
  const report = data<ComputerCodeReport>(await f.port.code!({ computerSessionID: session.computerSessionID, code }, signal()))
  expect(report).toMatchObject({ ok: true, value: 3, toolCalls: [{ name: "observe" }, { name: "press" }, { name: "observe" }] })
  expect(f.ax.calls).toContain("indicator")
  const old = await f.observe(session.computerSessionID)
  const action = (nodeID: string, revision = old.revision) => f.port.code!({ computerSessionID: session.computerSessionID, code: `return await tools.setValue({revision:${revision},nodeID:'${nodeID}',value:'query'})` }, signal())
  expect((await action("0.3")).output).toContain("Secure fields")
  expect((await action("0.2")).isError).toBe(false)
  expect((await action("0.2")).output).toContain("stale")
  expect(f.ax.actions).toHaveLength(2)
})

test("observe-only sessions, missing indicators and overlapping actions never mutate a node", async () => {
  const f = fixture(), observer = await f.start()
  const first = await f.observe(observer.computerSessionID)
  const run = (id: string, revision: number) => f.port.code!({ computerSessionID: id, code: `await tools.press({revision:${revision},nodeID:'0.1'})` }, signal())
  expect((await run(observer.computerSessionID, first.revision)).output).toContain("observe-only")
  const controller = await f.start("control"), observed = await f.observe(controller.computerSessionID)
  f.ax.state.indicator = false
  expect((await run(controller.computerSessionID, observed.revision)).output).toContain("indicator")
  expect(f.ax.actions).toEqual([])
  f.ax.state.indicator = true
  const fresh = await f.observe(controller.computerSessionID)
  const results = await Promise.all([run(controller.computerSessionID, fresh.revision), run(controller.computerSessionID, fresh.revision)])
  expect(results.filter((result) => !result.isError)).toHaveLength(1)
  expect(f.ax.actions).toHaveLength(1)
})

test("stopping cancels native work and a stopped or restarted host cannot resume session authority", async () => {
  const f = fixture(), session = await f.start()
  let release!: () => void
  f.ax.state.onObserve = () => new Promise<void>((resolve) => { release = resolve })
  const observing = f.port.observe!({ computerSessionID: session.computerSessionID }, signal())
  while (!release) await Bun.sleep(1)
  await f.port.session!({ action: "stop", computerSessionID: session.computerSessionID }, signal())
  release()
  expect((await observing).isError).toBe(true)
  expect((await f.port.observe!({ computerSessionID: session.computerSessionID }, signal())).isError).toBe(true)
  f.control.stop()
  expect((await f.port.code!({ computerSessionID: session.computerSessionID, code: "return 1" }, signal())).isError).toBe(true)
})

test("AX snapshots cap nodes and bytes and reject duplicate locators", async () => {
  const f = fixture(), session = await f.start()
  f.ax.state.nodes = Array.from({ length: 600 }, (_, index) => ({ id: `0.${index + 1}`, role: "AXTextField", name: "x".repeat(256), states: [], actions: [] }))
  const bounded = await f.observe(session.computerSessionID)
  expect(bounded.truncated).toBe(true)
  expect(bounded.nodes.length).toBeLessThanOrEqual(500)
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(65536)
  f.ax.state.nodes = [{ id: "0", role: "AXWindow", name: "", states: [], actions: [] }, { id: "0", role: "AXWindow", name: "", states: [], actions: [] }]
  expect((await f.port.observe!({ computerSessionID: session.computerSessionID }, signal())).isError).toBe(true)
})

test("a live indicator excludes capture, and stop aborts the pending semantic action", async () => {
  const f = fixture(), session = await f.start("control"), observed = await f.observe(session.computerSessionID)
  let release!: () => void
  f.ax.state.onAction = () => new Promise<void>((resolve) => { release = resolve })
  const action = f.port.code!({ computerSessionID: session.computerSessionID, code: `await tools.press({revision:${observed.revision},nodeID:'0.1'})` }, signal())
  while (!release) await Bun.sleep(1)
  expect((await f.port.capture({}, signal())).output).toContain("indicator")
  await f.port.session!({ action: "stop", computerSessionID: session.computerSessionID }, signal())
  release()
  expect((await action).isError).toBe(true)
  expect(f.ax.actions).toEqual([])
})

test("B29 focus-change capture still withholds both keyboard and session bootstrap", async () => {
  const f = fixture()
  f.os.mac.processes = [42, 43]
  expect(data<ComputerCaptureMetadata>(await f.port.capture({}, signal()))).toMatchObject({ keyboardControlAvailable: false, computerSessionBootstrapAvailable: false })
})

test("off-by-default tools and unsupported platforms fail without invoking Accessibility", async () => {
  for (const options of [{ enabled: false }, { platform: "linux" }]) {
    const f = fixture(options)
    const result = await runTool(createComputerTools().find((tool) => tool.name === "computer_session")!, { action: "start", mode: "observe", bootstrapCaptureID: crypto.randomUUID() }, { cwd: f.dir, signal: signal(), computer: f.port })
    expect(result.isError).toBe(true)
    expect(f.ax.calls).toEqual([])
  }
})

test("native Accessibility adapter transports arguments as data and checks identity/secure policy inside the OS script", async () => {
  const calls: string[][] = []
  const os = createMacAccessibility(async (args) => { calls.push(args); return { code: 0, stdout: calls.length === 1 ? JSON.stringify({ pid: 42, bundleID: "local.editor", appName: "Editor" }) : "ok", stderr: "" } })
  const target = await os.foreground(signal())
  await os.action(target, { revision: 1, nodeID: "0.2", action: "setValue", role: "AXTextField", value: "'); do shell script 'bad" }, signal())
  expect(calls[1]![4]).toContain("AXSecureTextField")
  expect(calls[1]![4]).toContain("target.bundleID")
  expect(calls[1]![4]).not.toContain("do shell script")
  expect(JSON.parse(calls[1]![6]!)).toMatchObject({ value: "'); do shell script 'bad" })
})

test("native Accessibility adapter addresses the approved process by pid and never asks which app is in front", async () => {
  const calls: string[][] = []
  const target = { pid: 42, bundleID: "local.editor", appName: "Editor" }
  let identity: unknown = target
  const os = createMacAccessibility(async (args) => { calls.push(args); return { code: 0, stdout: args[4]!.includes("return 'null'") ? JSON.stringify(identity) : args[4]!.includes("JSON.stringify({nodes") ? JSON.stringify({ nodes: [], truncated: false }) : "ok", stderr: "" } })
  expect(await os.identify(target, signal())).toEqual(target)
  await os.observe(target, signal())
  await os.action(target, { revision: 1, nodeID: "0.1", action: "press", role: "AXButton" }, signal())
  expect(calls).toHaveLength(3)
  for (const call of calls) {
    expect(call[4]).toContain("whose({unixId:target.pid})")
    expect(call[4]).not.toContain("frontmost")
    expect(call[4]).toContain("target.bundleID")
    expect(call.join("\n")).not.toContain("activate")
  }
  // A backend that answers with another process or bundle ID is not the approved target.
  identity = { ...target, pid: 43 }
  expect(await os.identify(target, signal())).toBeUndefined()
  identity = { ...target, bundleID: "local.imposter" }
  expect(await os.identify(target, signal())).toBeUndefined()
  identity = null
  expect(await os.identify(target, signal())).toBeUndefined()
})
