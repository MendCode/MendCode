import { afterEach, expect, test } from "bun:test"
import { ComputerSessionInput, type ComputerSessionReport, type ComputerCodeReport, type ComputerTarget } from "@mendcode/protocol"
import { b80Fixture, activation, data } from "./b80-fixtures"
import { signal } from "./b29-fixtures"

// Demo AX only: these tests never launch or modify any real application.
const fixtures: ReturnType<typeof b80Fixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.close() })
function fixture() { const f = b80Fixture(); fixtures.push(f); return f }

test("control programs retain their cursor scope through success and failure, not observe-only reads", async () => {
  const f = fixture(), lifecycle: string[] = []
  f.ax.os.program = async (_, abort, execute) => { abort.throwIfAborted(); lifecycle.push("begin"); try { return await execute() } finally { lifecycle.push("end") } }
  const observer = await f.start()
  await f.port.code!({ computerSessionID: observer.computerSessionID, code: "return await tools.status({})" }, signal())
  expect(lifecycle).toEqual([])
  const controller = await f.start("control")
  expect((await f.port.code!({ computerSessionID: controller.computerSessionID, code: "return await tools.status({})" }, signal())).isError).toBe(false)
  expect((await f.port.code!({ computerSessionID: controller.computerSessionID, code: "return unknownVariable" }, signal())).isError).toBe(true)
  expect(lifecycle).toEqual(["begin", "end", "begin", "end"])
})

test("stopping one session keeps the app's window handles while another live session uses the same app", async () => {
  const f = fixture(), released: number[] = []
  f.ax.os.release = (target) => { released.push(target.pid) }
  const first = await f.start("control"), second = await f.start("control")
  await f.port.session!({ action: "stop", computerSessionID: second.computerSessionID }, signal())
  expect(released).toEqual([])
  expect((await f.observe(first.computerSessionID)).nodes.length).toBeGreaterThan(0)
  await f.port.session!({ action: "stop", computerSessionID: first.computerSessionID }, signal())
  expect(released).toEqual([42])
})

test("a window capture that fails names the window ID before the permission", async () => {
  const f = fixture()
  f.os.mac.failure = "/usr/sbin/screencapture"
  expect((await f.port.capture({}, signal())).output).not.toContain("window ID")
  const failed = await f.port.capture({ windowID: 124 }, signal())
  expect(failed.isError).toBe(true)
  expect(failed.output).toContain("macOS window ID 124")
  expect(failed.output).toContain("Screen Recording")
})

test("navigation refreshes the selected window title without rebinding to another window", async () => {
  const f = fixture()
  let windowID = "own-window", windowName = "Start Page"
  f.ax.os.identify = async () => ({ ...f.ax.state.target, windowID, windowName })
  const session = await f.start("control")
  windowName = "Local demo loaded"
  expect((await f.observe(session.computerSessionID)).target).toMatchObject({ windowID: "own-window", windowName: "Local demo loaded" })
  windowID = "other-window"; windowName = "Different window"
  expect((await f.observe(session.computerSessionID)).target).toMatchObject({ windowID: "own-window", windowName: "Local demo loaded" })
})

test("explicit app targeting approves before activation and preserves the running identity", async () => {
  const f = fixture(), calls: string[] = []
  f.ax.os.apps = async () => [{ ...f.ax.state.target }]
  f.ax.os.resolve = async () => { calls.push("resolve"); return { ...f.ax.state.target } }
  f.ax.os.activate = async (target) => { calls.push("activate"); return target }
  expect(data<ComputerSessionReport>(await f.port.session!({ action: "apps" }, signal())).apps).toHaveLength(1)
  expect(calls).toEqual([])
  const input = { action: "start" as const, mode: "control" as const, bundleID: "local.editor" }
  expect((await f.port.session!(input, signal(), { ...activation, approve: async () => { calls.push("deny"); return false } })).isError).toBe(true)
  expect(calls).toEqual(["resolve", "deny"])
  calls.length = 0
  const started = data<ComputerSessionReport>(await f.port.session!(input, signal(), { ...activation, approve: async () => { calls.push("approve"); return true } }))
  expect(calls).toEqual(["resolve", "approve", "activate"])
  expect(started.target?.bundleID).toBe("local.editor")
  expect(ComputerSessionInput.safeParse({ ...input, bootstrapCaptureID: crypto.randomUUID() }).success).toBe(false)
  expect(ComputerSessionInput.safeParse({ action: "start", mode: "control" }).success).toBe(false)
})

test("native actions are advertised, revisioned, audited without values and not claimed verified", async () => {
  const f = fixture()
  f.ax.state.nodes[1]!.actions = ["press", "click", "key", "scroll", "drag"]
  f.ax.state.nodes[2]!.actions = ["setValue", "typeText", "drag"]
  const session = await f.start("control")
  const code = `
    let o = await tools.observe({}); await tools.click({revision:o.revision,nodeID:'0.1',count:2});
    o = await tools.observe({}); await tools.typeText({revision:o.revision,nodeID:'0.2',value:'PRIVATE_UNICODE_😀'});
    o = await tools.observe({}); await tools.key({revision:o.revision,nodeID:'0.1',key:'s',modifiers:['command']});
    o = await tools.observe({}); await tools.scroll({revision:o.revision,nodeID:'0.1',direction:'down',amount:200});
    o = await tools.observe({}); const effect = await tools.drag({revision:o.revision,nodeID:'0.1',toNodeID:'0.2'});
    const status = await tools.status({}); return {effect,status};`
  const report = data<ComputerCodeReport>(await f.port.code!({ computerSessionID: session.computerSessionID, code }, signal()))
  expect(report.ok).toBe(true)
  expect(f.ax.actions.map((a) => a.action)).toEqual(["click", "typeText", "key", "scroll", "drag"])
  expect(report.value).toMatchObject({ effect: { outcome: "dispatched", verified: false }, status: { audit: [{ result: "dispatched" }, { result: "dispatched" }, { result: "dispatched" }, { result: "dispatched" }, { result: "dispatched" }] } })
  expect(JSON.stringify(report.value)).not.toContain("PRIVATE_UNICODE")
})

test("window selection and exact postcondition waiting stay within the approved app", async () => {
  const f = fixture()
  f.ax.os.windows = async () => [{ id: "demo-window", name: "Demo" }]
  f.ax.os.selectWindow = async (target, windowID) => ({ ...target, windowID, windowName: "Demo" })
  const session = await f.start("control")
  const code = "const windows = await tools.windows({}); await tools.selectWindow({windowID:windows[0].id}); const o = await tools.observe({}); await tools.setValue({revision:o.revision,nodeID:'0.2',value:'verified'}); const check = await tools.waitFor({name:'Search',value:'verified',timeoutMs:0}); return {matched:check.matched,window:check.observation.target.windowID}"
  const report = data<ComputerCodeReport>(await f.port.code!({ computerSessionID: session.computerSessionID, code }, signal()))
  expect(report.value).toEqual({ matched: true, window: "demo-window" })
})

test("expired evidence and unknown action outcomes cannot be replayed or redirected to secure nodes", async () => {
  const f = fixture(), session = await f.start("control")
  f.ax.state.nodes[1]!.actions = ["click", "drag"]
  const observed = await f.observe(session.computerSessionID)
  f.advance(15001)
  expect((await f.port.code!({ computerSessionID: session.computerSessionID, code: `await tools.click({revision:${observed.revision},nodeID:'0.1'})` }, signal())).output).toContain("stale")
  expect(f.ax.actions).toHaveLength(0)
  f.ax.state.onAction = async () => { throw new Error("Demo lost its result") }
  const failed = await f.port.code!({ computerSessionID: session.computerSessionID, code: "const o = await tools.observe({}); await tools.click({revision:o.revision,nodeID:'0.1'})" }, signal())
  expect(failed.isError).toBe(true)
  const audit = data<ComputerCodeReport>(await f.port.code!({ computerSessionID: session.computerSessionID, code: "return await tools.status({})" }, signal()))
  expect(audit.value).toMatchObject({ audit: [{ result: "unknown" }] })
  const blocked = await f.port.code!({ computerSessionID: session.computerSessionID, code: "const o = await tools.observe({}); await tools.drag({revision:o.revision,nodeID:'0.1',toNodeID:'0.3'})" }, signal())
  expect(blocked.output).toContain("Drag destination")
  expect(f.ax.actions).toHaveLength(0)
})

const OTHER_APP = { pid: 99, bundleID: "local.user-app", appName: "User App" }

test("observe, waitFor, windows, press and setValue work while the user is in another app, without asking which app is in front", async () => {
  const f = fixture()
  f.ax.os.windows = async () => [{ id: "w1", name: "Project" }]
  const session = await f.start("control")
  f.ax.state.front = OTHER_APP
  f.ax.calls.length = 0
  const code = "const o = await tools.observe({}); await tools.press({revision:o.revision,nodeID:'0.1'}); const p = await tools.observe({}); await tools.setValue({revision:p.revision,nodeID:'0.2',value:'typed in background'}); const w = await tools.windows({}); const check = await tools.waitFor({name:'Search',value:'typed in background',timeoutMs:0}); return {matched:check.matched,windows:w.length}"
  const report = data<ComputerCodeReport>(await f.port.code!({ computerSessionID: session.computerSessionID, code }, signal()))
  expect(report).toMatchObject({ ok: true, value: { matched: true, windows: 1 } })
  expect(f.ax.actions.map((a) => a.action)).toEqual(["press", "setValue"])
  expect(f.ax.calls).not.toContain("foreground")
  expect(f.ax.calls).toContain("identify")
  expect((await f.observe(session.computerSessionID)).target).toMatchObject({ pid: 42, bundleID: "local.editor" })
})

test("key, text, pointer and drag actions reach the bound app while another app is in front; only raising a window waits for it", async () => {
  const f = fixture()
  f.ax.state.nodes[1]!.actions = ["press", "click", "key", "scroll", "drag"]
  f.ax.state.nodes[2]!.actions = ["setValue", "typeText", "drag"]
  f.ax.os.selectWindow = async (target, windowID) => ({ ...target, windowID })
  const session = await f.start("control")
  f.ax.state.front = OTHER_APP
  const attempts: Record<string, string> = {
    click: "tools.click({revision:o.revision,nodeID:'0.1'})",
    key: "tools.key({revision:o.revision,nodeID:'0.1',key:'tab'})",
    scroll: "tools.scroll({revision:o.revision,nodeID:'0.1',direction:'down'})",
    drag: "tools.drag({revision:o.revision,nodeID:'0.1',toNodeID:'0.2'})",
    typeText: "tools.typeText({revision:o.revision,nodeID:'0.2',value:'x'})",
  }
  for (const call of Object.values(attempts)) {
    const result = await f.port.code!({ computerSessionID: session.computerSessionID, code: `const o = await tools.observe({}); await ${call}` }, signal())
    expect(result.isError).toBe(false)
  }
  expect(f.ax.actions.map((a) => a.action)).toEqual(["click", "key", "scroll", "drag", "typeText"])
  const raise = await f.port.code!({ computerSessionID: session.computerSessionID, code: "await tools.selectWindow({windowID:'w2'})" }, signal())
  expect(raise.isError).toBe(true)
  expect(raise.output).toContain("selectWindow needs Local Editor in front")
  expect((await f.observe(session.computerSessionID)).nodes.length).toBeGreaterThan(0)
})

test("a background session ends when its own process exits or its bundle ID differs, whatever app is in front", async () => {
  for (const change of [(t: ComputerTarget) => { t.pid = 43 }, (t: ComputerTarget) => { t.bundleID = "local.imposter" }]) {
    const f = fixture(), session = await f.start("control")
    f.ax.state.front = OTHER_APP
    const observed = await f.observe(session.computerSessionID)
    change(f.ax.state.target)
    const result = await f.port.code!({ computerSessionID: session.computerSessionID, code: `return await tools.press({revision:${observed.revision},nodeID:'0.1'})` }, signal())
    expect(result.output).toContain("Computer target changed")
    expect(f.ax.actions).toEqual([])
    f.ax.state.target.pid = 42; f.ax.state.target.bundleID = "local.editor"
    expect((await f.port.observe!({ computerSessionID: session.computerSessionID }, signal())).output).toContain("stopped")
  }
})

test("starting from a capture does not need the app to still be in front, only the same process and bundle ID", async () => {
  const f = fixture()
  const capture = data<{ captureID: string }>(await f.port.capture({}, signal()))
  f.ax.state.front = OTHER_APP
  const started = data<ComputerSessionReport>(await f.port.session!({ action: "start", mode: "observe", bootstrapCaptureID: capture.captureID }, signal(), activation))
  expect(started.target).toMatchObject({ pid: 42, bundleID: "local.editor" })
  expect((await f.observe(started.computerSessionID)).nodes.length).toBeGreaterThan(0)
})
