import { afterEach, expect, test } from "bun:test"
import { appHarness, cleanTemps, conversation, ids } from "./session-ui-harness"

afterEach(cleanTemps)

const ESC = "\x1b"

/** A running turn; the daemon lists `children` as running child tasks and `engine` as Claude Code's own background agents. */
function running(options: { children?: string[]; engine?: string[]; oldDaemon?: boolean } = {}) {
  const h = appHarness({
    width: 110,
    height: 30,
    reply: (command) => {
      if (command.type === "turn.cancel") return options.oldDaemon && "spareAgents" in command ? { ok: false, error: { code: "invalid_command", message: "unrecognized key: spareAgents" } } : { ok: true }
      if (command.type === "task.list") return { ok: true, result: { tasks: (options.children ?? []).map((taskId) => ({ taskId, parentId: h.sessionId, rootId: h.sessionId, depth: 1, state: "running", description: "Check the build", agent: "general", generation: 1, background: false, createdAt: 1, updatedAt: 1 })) } }
      if (command.type === "background.list") return { ok: true, result: { tasks: (options.engine ?? []).map((id) => ({ id, kind: "local_agent", status: "running" })) } }
      if (command.type === "task.status" || command.type === "background.stop") return { ok: true, result: {} }
      if (command.type === "session.create") return { ok: true, result: { sessionId: ids("session") } }
      return undefined
    },
  })
  h.app.applySettings({ onboarded: true })
  const chat = conversation(h.sessionId, h.app.onEvent)
  chat.exchange("hello", "hi")
  const turnId = ids("turn")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "foreground.state", state: "generating", turnId })
  h.app.render()
  return { ...h, chat, turnId }
}

test("Esc Esc stops only the turn; its sub-agents keep running and the notice says a third Esc stops them", async () => {
  const h = running({ children: ["ses_child1"], engine: ["engine:a1"] })
  await h.type(ESC)
  await h.type(ESC)
  expect(h.sentOf("turn.cancel")).toMatchObject([{ turnId: h.turnId, spareAgents: true }])
  expect(h.sentOf("task.status")).toHaveLength(0)
  expect(h.text().join("\n")).toContain("sub-agents keep running · esc stops them")
})

test("a third Esc right after stops every running sub-agent: MendCode's children and Claude Code's background agents", async () => {
  const h = running({ children: ["ses_child1"], engine: ["engine:a1"] })
  await h.type(ESC)
  await h.type(ESC)
  h.chat.emit({ type: "turn.cancelled", turnId: h.turnId, by: "user" })
  await h.type(ESC)
  expect(h.sentOf("task.status")).toMatchObject([{ taskId: "ses_child1", action: "cancel" }])
  expect(h.sentOf("background.stop")).toMatchObject([{ taskId: "engine:a1" }])
  expect(h.text().join("\n")).toContain("stopped 2 sub-agents")
})

test("with no sub-agents running, Esc Esc is a plain interrupt and the next Esc goes back to its usual job", async () => {
  const h = running()
  await h.type(ESC)
  await h.type(ESC)
  h.chat.emit({ type: "turn.cancelled", turnId: h.turnId, by: "user" })
  await h.type(ESC)
  expect(h.sentOf("task.status")).toHaveLength(0)
  expect(h.text().join("\n")).not.toContain("esc stops them")
})

test("a daemon that does not know the field still gets the interrupt, the old way", async () => {
  const h = running({ children: ["ses_child1"], oldDaemon: true })
  await h.type(ESC)
  await h.type(ESC)
  const cancels = h.sentOf("turn.cancel")
  expect(cancels).toHaveLength(2)
  expect("spareAgents" in cancels[1]!).toBe(false)
  expect(h.text().join("\n")).not.toContain("esc stops them")
})

test("the third-Esc arm belongs to the session that was interrupted: switching away drops it", async () => {
  const h = running({ children: ["ses_child1"] })
  await h.type(ESC)
  await h.type(ESC)
  h.chat.emit({ type: "turn.cancelled", turnId: h.turnId, by: "user" })
  await h.type("/new\r")
  expect(h.sessionId).not.toBe(h.app.sessionId)
  await h.type(ESC)
  expect(h.sentOf("task.status")).toHaveLength(0)
  expect(h.text().join("\n")).not.toContain("stopped 1 sub-agent")
})

test("an engine agent the daemon could not stop is not counted as stopped, and the next Esc tries it again", async () => {
  let refuse = true
  const h = appHarness({
    width: 110,
    height: 30,
    reply: (command) => {
      if (command.type === "turn.cancel") return { ok: true }
      if (command.type === "task.list") return { ok: true, result: { tasks: [] } }
      if (command.type === "background.list") return { ok: true, result: { tasks: [{ id: "engine:a1", kind: "local_agent", status: "running" }] } }
      if (command.type === "background.stop") return refuse ? { ok: true, result: { stopped: 0, failed: ["Review the diff"] } } : { ok: true, result: { stopped: 1, failed: [] } }
      return undefined
    },
  })
  h.app.applySettings({ onboarded: true })
  const chat = conversation(h.sessionId, h.app.onEvent)
  chat.exchange("hello", "hi")
  const turnId = ids("turn")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "foreground.state", state: "generating", turnId })
  h.app.render()
  await h.type(ESC)
  await h.type(ESC)
  chat.emit({ type: "turn.cancelled", turnId, by: "user" })
  await h.type(ESC)
  expect(h.text().join("\n")).toContain("1 could not be stopped")
  expect(h.text().join("\n")).not.toContain("stopped 1 sub-agent")
  refuse = false
  await h.type(ESC)
  expect(h.text().join("\n")).toContain("stopped 1 sub-agent")
})

test("Esc Esc on a message the model has not answered keeps running sub-agents: the turn is interrupted, the message is not taken back", async () => {
  const h = running({ children: ["ses_child1"] })
  const message = ids("item")
  h.chat.emit({ type: "item.started", turnId: h.turnId, itemId: message, kind: "user_message" })
  h.chat.emit({ type: "item.completed", itemId: message, status: "ok", text: "check the build" })
  h.app.render()
  await h.type(ESC)
  await h.type(ESC)
  expect(h.sentOf("session.undo")).toHaveLength(0)
  expect(h.sentOf("turn.cancel")).toMatchObject([{ turnId: h.turnId, spareAgents: true }])
})

test("Esc Esc on a message nobody answered still takes it back when no sub-agent runs", async () => {
  const h = running()
  const message = ids("item")
  h.chat.emit({ type: "item.started", turnId: h.turnId, itemId: message, kind: "user_message" })
  h.chat.emit({ type: "item.completed", itemId: message, status: "ok", text: "check the build" })
  h.app.render()
  await h.type(ESC)
  await h.type(ESC)
  expect(h.sentOf("session.undo")).toMatchObject([{ atItemId: message, cancelRunning: true }])
  expect(h.sentOf("turn.cancel")).toHaveLength(0)
})
