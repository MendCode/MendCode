import { afterEach, expect, test } from "bun:test"
import { appHarness, cleanTemps, conversation, ids, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

/** One agent turn whose tool call finished with `meta`, as the engine emits `session_open`'s result. */
function turnWithTool(talk: ReturnType<typeof conversation>, meta: Record<string, string>, status: "ok" | "error" = "ok") {
  const turnId = ids("turn")
  const itemId = ids("item")
  talk.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  talk.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "session_open" } })
  talk.emit({ type: "item.completed", itemId, status, text: "Opening", meta })
  return () => talk.emit({ type: "turn.completed", turnId })
}

test("the agent's session_open switches the attached terminal to that session when its turn ends, as /sessions does", async () => {
  const h = appHarness({ dataDir: tempDir(), width: 100, height: 30 })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  const talk = conversation(h.sessionId, h.app.onEvent)
  const target = ids("session")
  const end = turnWithTool(talk, { openSession: target })
  await Bun.sleep(5)
  // The turn is still running where it started.
  expect(h.app.sessionId).toBe(h.sessionId)
  end()
  await Bun.sleep(20)
  expect(h.app.sessionId).toBe(target)
  expect(h.sentOf("client.unsubscribe")).toContainEqual(expect.objectContaining({ sessionId: h.sessionId }))
})

test("a refused session_open, or a turn without one, leaves the terminal where it is", async () => {
  const h = appHarness({ dataDir: tempDir(), width: 100, height: 30 })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  const talk = conversation(h.sessionId, h.app.onEvent)
  turnWithTool(talk, { openSession: ids("session") }, "error")()
  talk.exchange("hello", "hi")
  turnWithTool(talk, { openSession: "not-a-session" })()
  await Bun.sleep(20)
  expect(h.app.sessionId).toBe(h.sessionId)
})
