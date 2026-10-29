import { createComputerTools, runTool, type ToolResult } from "../../../packages/tools/src"
import { b80Fixture, activation } from "../../../packages/daemon/test/b80-fixtures"
import { signal } from "../../../packages/daemon/test/b29-fixtures"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { appHarness, conversation, ids, NOW, tempDir, type HarnessOptions } from "./session-ui-harness"

export const B80_SCENES = ["session-started", "session-control", "session-stopped", "session-approval", "session-disabled", "observe-nodes", "observe-expanded", "observe-expired", "observe-focus-changed", "code-completed", "code-stale", "code-secure", "capture-bootstrap"] as const
export type B80Scene = typeof B80_SCENES[number]

export async function b80Harness(scene: B80Scene, options: HarnessOptions = {}) {
  const f = b80Fixture({ enabled: scene !== "session-disabled" })
  const dataDir = options.dataDir ?? tempDir("b80-ui-")
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, toolOutput: "auto", pet: "off" })
  const h = appHarness({ ...options, sessionId: f.sessionId, dataDir, directory: f.dir, env: {}, reply: (command) => options.reply?.(command) ?? (command.type === "session.list" ? { ok: true, result: { sessions: [{ sessionId: f.sessionId, directory: f.dir, title: "Computer", createdAt: NOW - 3600000, updatedAt: NOW, state: "idle" }] } } : { ok: true }) })
  const name = scene.startsWith("observe-") ? "computer_observe" : scene.startsWith("code-") ? "computer_code" : scene === "capture-bootstrap" ? "computer_capture" : "computer_session"
  let result: ToolResult | undefined
  let args: Record<string, unknown> = {}
  try {
    if (scene === "session-disabled") args = { action: "start", mode: "observe", bootstrapCaptureID: crypto.randomUUID() }
    else if (scene === "capture-bootstrap") args = {}
    else if (scene !== "session-approval") {
      const started = await f.start(scene === "session-control" || name === "computer_code" ? "control" : "observe")
      args = { computerSessionID: started.computerSessionID }
      if (scene === "session-started" || scene === "session-control") result = { output: JSON.stringify(started), title: "MendCode Computer", truncated: false, isError: false }
      if (scene === "session-stopped") args.action = "stop"
      if (scene === "observe-expired") f.advance(60000)
      if (scene === "observe-focus-changed") f.ax.state.target.pid = 43
      if (name === "computer_code") {
        const observed = await f.observe(started.computerSessionID)
        if (scene === "code-stale") await f.observe(started.computerSessionID)
        args.code = scene === "code-secure" ? `return await tools.setValue({revision:${observed.revision},nodeID:'0.3',value:'query'})` : `return await tools.press({revision:${observed.revision},nodeID:'0.1'})`
      }
    }
    if (!result && scene !== "session-approval") result = await runTool(createComputerTools().find((tool) => tool.name === name)!, args, { cwd: f.dir, signal: signal(), computer: { ...f.port, session: (input, abort) => f.port.session!(input, abort, activation) } })
    h.app.applySettings({ onboarded: true })
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: f.sessionId, directory: f.dir, title: "Computer", state: "idle", updatedAt: NOW })
    const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
    const turnId = ids("turn"), itemId = ids("item"), userId = ids("item")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    chat.emit({ type: "item.started", turnId, itemId: userId, kind: "user_message" })
    chat.emit({ type: "item.completed", itemId: userId, status: "ok", text: "Observe the editor and save the current file" })
    chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: name } })
    if (result) {
      chat.emit({ type: "item.completed", itemId, status: result.isError ? "error" : "ok", text: result.output, toolInput: JSON.stringify(args), meta: result.meta })
      chat.emit({ type: "turn.completed", turnId })
    } else chat.emit({ type: "server.request", requestId: ids("request"), kind: "approval", title: "MendCode Computer", detail: "Local Editor · local.editor · PID 42\nMode: observe · 10 minute limit · 60 second idle expiry", itemId })
    if (scene === "observe-expanded") await h.type("\x0f")
    h.app.render()
    return { ...h, result, close: async () => { await h.app.onKey("\x03"); f.close() } }
  } catch (error) { await h.app.onKey("\x03"); f.close(); throw error }
}
