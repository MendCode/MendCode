import { codeModeFixture } from "../../../packages/engine-native/test/code-mode-fixture"
import { turn } from "../../../packages/engine-native/test/harness"
import { appHarness, conversation, ids, tempDir } from "./session-ui-harness"

export async function b71Harness(width: number, height: number, state: Parameters<typeof codeModeFixture>[0] = "selected") {
  const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/project" })
  h.app.applySettings({ onboarded: true, reducedMotion: true, experimental: { code_mode: true, tool_discovery: true } })
  const fixture = codeModeFixture(state)
  const chat = conversation(h.sessionId, h.app.onEvent)
  const t = turn({ text: "Find the entry points in src/main.ts", sessionId: h.sessionId })
  chat.emit({ type: "turn.started", turnId: t.input.turnId, queueId: ids("queue") })
  const userItem = ids("item")
  chat.emit({ type: "item.started", turnId: t.input.turnId, itemId: userItem, kind: "user_message" })
  chat.emit({ type: "item.completed", itemId: userItem, status: "ok", text: t.input.text })
  const outcome = await fixture.engine.runTurn({ ...t.input, emit: (event) => chat.emit({ ...event, turnId: t.input.turnId }) })
  if (outcome.status !== "ok") throw new Error(JSON.stringify(outcome))
  chat.emit({ type: "turn.completed", turnId: t.input.turnId })
  chat.emit({ type: "foreground.state", state: "idle" })
  h.app.render()
  return { ...h, requests: fixture.requests, calls: fixture.calls, answer: fixture.text }
}
