import { rmSync } from "node:fs"
import { createComputerTools, runTool, type ToolResult } from "../../../packages/tools/src"
import { captureData, computerFixture, png, signal } from "../../../packages/daemon/test/b29-fixtures"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { appHarness, conversation, ids, NOW, tempDir, type HarnessOptions } from "./session-ui-harness"

export const B29_SCENES = ["capture-main", "capture-window", "capture-region", "capture-multiple-displays", "capture-unchanged", "capture-resized", "capture-expanded", "capture-disabled", "capture-permission-denied", "key-pressed", "key-stale", "key-focus-changed", "key-consumed", "capture-approval"] as const
export type B29Scene = typeof B29_SCENES[number]

export async function b29Harness(scene: B29Scene, options: HarnessOptions = {}) {
  const fixture = computerFixture({ enabled: scene !== "capture-disabled" })
  const dataDir = options.dataDir ?? tempDir("b29-ui-")
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, toolOutput: "auto", pet: "off" })
  const harness = appHarness({ ...options, sessionId: fixture.sessionId, dataDir, directory: fixture.dir, env: {}, reply: (command) => {
    const override = options.reply?.(command)
    if (override) return override
    return command.type === "session.list" ? { ok: true, result: { sessions: [{ sessionId: fixture.sessionId, directory: fixture.dir, title: "Computer", createdAt: NOW - 3600_000, updatedAt: NOW, state: "idle" }] } } : { ok: true }
  } })
  const tools = createComputerTools()
  const context = { cwd: fixture.dir, signal: signal(), computer: fixture.port }
  const name = scene.startsWith("key-") ? "computer_key" : "computer_capture"
  let input: Record<string, unknown> = {}
  let result: ToolResult | undefined
  if (scene !== "capture-approval") {
    if (name === "computer_key") {
      const observed = captureData(await fixture.port.capture({}, signal()))
      input = { captureID: observed.captureID, key: "tab" }
      if (scene === "key-stale") fixture.advance(30_001)
      if (scene === "key-focus-changed") fixture.os.mac.foreground = 43
      if (scene === "key-consumed") await fixture.port.key({ captureID: observed.captureID, key: "tab" }, signal())
    } else {
      if (scene === "capture-window") input = { windowID: 902, region: null }
      if (scene === "capture-region") input = { windowID: null, region: { x: 20, y: 30, width: 500, height: 300 } }
      if (scene === "capture-multiple-displays") fixture.os.mac.displays = 2
      if (scene === "capture-resized") fixture.os.mac.image = png(3200, 2000)
      if (scene === "capture-permission-denied") fixture.os.mac.failure = "/usr/sbin/screencapture"
      if (scene === "capture-unchanged") await fixture.port.capture({}, signal())
    }
    result = await runTool(tools.find((tool) => tool.name === name)!, input, context)
  }
  const chat = conversation(harness.sessionId, (event) => harness.app.onEvent(event))
  harness.app.applySettings({ onboarded: true })
  harness.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: fixture.sessionId, directory: fixture.dir, title: "Computer", state: "idle", updatedAt: NOW })
  const turnId = ids("turn"), itemId = ids("item"), userId = ids("item")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "item.started", turnId, itemId: userId, kind: "user_message" })
  chat.emit({ type: "item.completed", itemId: userId, status: "ok", text: name === "computer_key" ? "Press Tab in the app from this capture" : "Capture the current desktop" })
  chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: name } })
  if (result) {
    chat.emit({ type: "item.completed", itemId, status: result.isError ? "error" : "ok", text: result.output, toolInput: JSON.stringify(input), meta: result.meta })
    chat.emit({ type: "turn.completed", turnId })
  } else {
    chat.emit({ type: "server.request", requestId: ids("request"), kind: "approval", title: "computer_capture", detail: "Capture the main display · execute permission", itemId })
  }
  if (scene === "capture-expanded") await harness.type("\x0f")
  harness.app.render()
  return { ...harness, result, close: async () => { await harness.app.onKey("\x03"); fixture.control.stop(); fixture.store.close(); rmSync(fixture.dir, { recursive: true, force: true }) } }
}
