import { discoveryFixture } from "../../../packages/engine-native/test/discovery-fixture"
import { turn } from "../../../packages/engine-native/test/harness"
import { appHarness, conversation, ids, tempDir } from "./session-ui-harness"

/** Actual native tool events on the CLI app harness; schemas and results are local fakes. */
export async function b26Harness(width: number, height: number, state: "found" | "empty" | "invalid" = "found") {
  const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/project" })
  h.app.applySettings({ onboarded: true, reducedMotion: true })
  const { engine, requests, query } = discoveryFixture(state)
  const chat = conversation(h.sessionId, h.app.onEvent)
  const t = turn({ text: `Find ${query}`, sessionId: h.sessionId })
  chat.emit({ type: "turn.started", turnId: t.input.turnId, queueId: ids("queue") })
  const userItem = ids("item")
  chat.emit({ type: "item.started", turnId: t.input.turnId, itemId: userItem, kind: "user_message" })
  chat.emit({ type: "item.completed", itemId: userItem, status: "ok", text: t.input.text })
  const outcome = await engine.runTurn({ ...t.input, emit: (event) => chat.emit({ ...event, turnId: t.input.turnId }) })
  if (outcome.status !== "ok") throw new Error(JSON.stringify(outcome))
  chat.emit({ type: "turn.completed", turnId: t.input.turnId })
  chat.emit({ type: "foreground.state", state: "idle" })
  h.app.render()
  return { ...h, requests }
}
