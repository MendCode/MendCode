import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ComputerCaptureMetadata, Command, createIdFactory } from "@mendcode/protocol"
import { isReadOnlyCommand } from "@mendcode/protocol/wire"
import { createComputerTools, runTool, BUILTIN_TOOLS } from "@mendcode/tools"
import { captureData, computerFixture, png, signal } from "./b29-fixtures"

const fixtures: ReturnType<typeof computerFixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) { f.control.stop(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }) } })
function fixture(options: Parameters<typeof computerFixture>[0] = {}) { const f = computerFixture(options); fixtures.push(f); return f }

test("computer transports validate null selectors and bounded navigation; neither is read-only", () => {
  const ids = createIdFactory()
  const base = { id: ids("command"), clientId: ids("client"), sessionId: ids("session") }
  for (const input of [{}, { region: null, windowID: null }, { windowID: 123 }, { region: { x: -12, y: 10, width: 500, height: 200 }, windowID: null }, { region: { x: 20000, y: -20000, width: 1, height: 1 } }]) expect(Command.safeParse({ ...base, type: "computer.capture", input }).success).toBe(true)
  for (const input of [{ windowID: 0 }, { windowID: 1.5 }, { windowID: 12, region: { x: 0, y: 0, width: 1, height: 1 } }, { region: { x: 0, y: 0, width: 16385, height: 1 } }, { region: { x: 0.5, y: 0, width: 1, height: 1 } }]) expect(Command.safeParse({ ...base, type: "computer.capture", input }).success).toBe(false)
  for (const input of [{ captureID: "bad", key: "tab" }, { captureID: crypto.randomUUID(), key: "type" }, { captureID: crypto.randomUUID(), key: "tab", text: "no" }]) expect(Command.safeParse({ ...base, type: "computer.key", input }).success).toBe(false)
  expect(isReadOnlyCommand("computer.capture")).toBe(false)
  expect(isReadOnlyCommand("computer.key")).toBe(false)
  expect(BUILTIN_TOOLS.some((tool) => tool.name.startsWith("computer_"))).toBe(false)
})

test("capture returns an owned private PNG, a fresh ID, dimensions and same-session hash lineage", async () => {
  const f = fixture()
  const first = await f.port.capture({ region: null, windowID: null }, signal())
  expect(first.isError).toBe(false)
  const data = ComputerCaptureMetadata.parse(captureData(first))
  expect(data).toMatchObject({ width: 800, height: 500, keyboardControlAvailable: true, resized: false })
  expect(data.sha256).toHaveLength(64)
  expect(first.images?.[0]?.bytes).toEqual(readFileSync(data.filePath))
  expect(statSync(data.filePath).mode & 0o777).toBe(0o600)
  expect(statSync(path.dirname(data.filePath)).mode & 0o777).toBe(0o700)
  expect(f.os.calls.find((args) => args[0] === "/usr/sbin/screencapture")).toContain("-m")
  const second = captureData(await f.port.capture({}, signal()))
  expect(second.captureID).not.toBe(data.captureID)
  expect(second.unchangedFrom).toBe(data.captureID)
  expect(captureData(await f.control.port(f.otherId).capture({}, signal())).unchangedFrom).toBeUndefined()
})

test("known windows and crops never create keyboard authority, and invalid selectors never touch the OS", async () => {
  const f = fixture()
  const window = captureData(await f.port.capture({ windowID: 902, region: null }, signal()))
  expect(f.os.calls.find((args) => args[0] === "/usr/sbin/screencapture")?.slice(4, 6)).toEqual(["-l", "902"])
  expect(window.keyboardControlAvailable).toBe(false)
  const region = captureData(await f.port.capture({ windowID: null, region: { x: -100, y: 10, width: 300, height: 200 } }, signal()))
  expect(f.os.calls.at(-1)?.slice(4, 6)).toEqual(["-R", "-100,10,300,200"])
  expect(region.keyboardControlAvailable).toBe(false)
  const before = f.os.calls.length
  for (const captureID of [window.captureID, region.captureID]) expect((await f.port.key({ captureID, key: "tab" }, signal())).isError).toBe(true)
  expect((await f.port.capture({ windowID: 0 }, signal())).isError).toBe(true)
  expect(f.os.calls).toHaveLength(before)
})

test("multi-display, unknown topology and focus changes during capture all withhold keyboard authority", async () => {
  const f = fixture()
  f.os.mac.displays = 2
  expect(captureData(await f.port.capture({}, signal())).keyboardControlAvailable).toBe(false)
  f.os.mac.displays = 1
  f.os.mac.topology = "not JSON"
  expect(captureData(await f.port.capture({}, signal())).keyboardControlAvailable).toBe(false)
  f.os.mac.topology = undefined
  f.os.mac.processes = [42, 43]
  expect(captureData(await f.port.capture({}, signal())).keyboardControlAvailable).toBe(false)
})

test("navigation is session-bound, single-use under concurrency and mapped to the native key codes", async () => {
  const f = fixture()
  const first = captureData(await f.port.capture({}, signal()))
  expect((await f.control.port(f.otherId).key({ captureID: first.captureID, key: "tab" }, signal())).isError).toBe(true)
  const keys = await Promise.all([f.port.key({ captureID: first.captureID, key: "tab" }, signal()), f.port.key({ captureID: first.captureID, key: "enter" }, signal())])
  expect(keys.map((result) => result.isError)).toEqual([false, true])
  expect(f.os.keys).toEqual([48])
  for (const [key, code] of [["escape", 53], ["enter", 36], ["space", 49], ["left", 123], ["right", 124], ["down", 125], ["up", 126]] as const) {
    const next = captureData(await f.port.capture({}, signal()))
    expect((await f.port.key({ captureID: next.captureID, key }, signal())).isError).toBe(false)
    expect(f.os.keys.at(-1)).toBe(code)
  }
  const script = f.os.calls.find((args) => args[2]?.includes("on run argv"))![2]!
  expect(script).toContain("currentID is not targetID")
  expect(script).not.toContain("activate")
})

test("stale captures and foreground changes fail without a key; a failed key also consumes authority", async () => {
  const f = fixture()
  const old = captureData(await f.port.capture({}, signal()))
  f.advance(30_001)
  expect((await f.port.key({ captureID: old.captureID, key: "tab" }, signal())).output).toContain("stale")
  const fresh = captureData(await f.port.capture({}, signal()))
  f.os.mac.foreground = 43
  expect((await f.port.key({ captureID: fresh.captureID, key: "tab" }, signal())).output).toContain("Foreground application changed")
  f.os.mac.foreground = 42
  expect((await f.port.key({ captureID: fresh.captureID, key: "tab" }, signal())).output).toContain("missing")
  expect(f.os.keys).toEqual([])
})

test("previews are bounded and never register authority for unreadable, oversized or failed native captures", async () => {
  const f = fixture()
  f.os.mac.image = png(3200, 2000)
  expect(captureData(await f.port.capture({}, signal()))).toMatchObject({ width: 1600, height: 1000, resized: true })
  f.os.mac.image = png(100, 100, 5 * 1024 * 1024)
  expect((await f.port.capture({}, signal())).output).toContain("bounded PNG")
  f.os.mac.image = Buffer.from("not a PNG")
  expect((await f.port.capture({}, signal())).isError).toBe(true)
  f.os.mac.image = png(3200, 2000)
  f.os.mac.resized = png(3200, 2000)
  expect((await f.port.capture({}, signal())).isError).toBe(true)
  f.os.mac.failure = "/usr/sbin/screencapture"
  const denied = await f.port.capture({}, signal())
  expect(denied.output).toContain("Screen Recording or Accessibility")
  expect(denied.images).toBeUndefined()
})

test("opt-in, platform, cancellation, unknown sessions and shutdown are checked before native effects", async () => {
  for (const options of [{ enabled: false }, { platform: "linux" }]) {
    const f = fixture(options)
    expect((await f.port.capture({}, signal())).isError).toBe(true)
    expect(f.os.calls).toEqual([])
  }
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  expect((await f.port.capture({}, controller.signal)).output).toBe("cancelled")
  expect((await f.control.port(createIdFactory()("session")).capture({}, signal())).output).toBe("Unknown session")
  f.control.stop()
  expect((await f.port.capture({}, signal())).output).toBe("cancelled")
  expect(f.os.calls).toEqual([])
})

test("the artifact cap persists across service instances and refuses a 65th native capture", async () => {
  const f = fixture()
  const directory = path.join(f.dir, "computer", f.sessionId)
  mkdirSync(directory, { recursive: true })
  for (let index = 0; index < 64; index++) writeFileSync(path.join(directory, `${index}.png`), "fixture")
  expect((await f.port.capture({}, signal())).output).toContain("64 screenshot artifact limit")
  expect(f.os.calls).toEqual([])
  expect(existsSync(directory)).toBe(true)
})

test("tool factories use the supplied session port, remain execute-gated and validate before dispatch", async () => {
  const f = fixture()
  const [capture, key] = createComputerTools()
  expect(capture!.permission).toBe("execute")
  expect(key!.permission).toBe("execute")
  const context = { cwd: f.dir, signal: signal(), computer: f.port }
  const result = await runTool(capture!, { windowID: null, region: null }, context)
  expect(result.isError).toBe(false)
  expect((await runTool(key!, { captureID: captureData(result).captureID, key: "tab" }, context)).isError).toBe(false)
  const before = f.os.calls.length
  expect((await runTool(key!, { captureID: captureData(result).captureID, key: "text" }, context)).isError).toBe(true)
  expect(f.os.calls).toHaveLength(before)
  expect((await runTool(capture!, {}, { cwd: f.dir, signal: signal() })).output).toContain("disabled")
})
