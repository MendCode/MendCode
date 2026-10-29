import { afterEach, expect, test } from "bun:test"
import type { Settings } from "@mendcode/protocol"
import { appHarness, cleanTemps, conversation, ids } from "./session-ui-harness"

afterEach(cleanTemps)

type Entry = { queueId: string; kind: string; text: string; attachments: number; editable: boolean; delivery?: string }

function queueHarness(mode: NonNullable<Settings["queue"]>["mode"] = "after-response") {
  const settings: Settings = { onboarded: true, reducedMotion: true, queue: { mode } }
  const first = ids("queue"), second = ids("queue"), expanded = ids("queue")
  let entries: Entry[] = [
    { queueId: first, kind: "message", text: "Check the cancellation path", attachments: 0, editable: true },
    { queueId: second, kind: "message", text: "Run the focused tests", attachments: 0, editable: true },
    { queueId: expanded, kind: "message", text: "expanded file contents", attachments: 0, editable: false },
  ]
  const lists: number[] = []
  const h = appHarness({ width: 110, height: 30, directory: "/work/queue", reply: (command) => {
    if (command.type === "settings.get") return { ok: true, result: { settings } }
    if (command.type === "queue.list") { lists.push(1); return { ok: true, result: { held: false, paused: false, entries } } }
    if (command.type === "queue.reorder") {
      const from = entries.findIndex((entry) => entry.queueId === command.queueId)
      const [moved] = entries.splice(from, 1)
      entries.splice(command.to === "up" ? from - 1 : from + 1, 0, moved!)
      return { ok: true, result: { position: 0 } }
    }
    if (command.type === "queue.edit") {
      entries = entries.map((entry) => entry.queueId === command.queueId ? { ...entry, text: command.text } : entry)
      return { ok: true }
    }
    if (command.type === "queue.steer") {
      entries = entries.map((entry) => entry.queueId === command.queueId ? { ...entry, delivery: "steer" } : entry)
      return { ok: true, result: { steered: true } }
    }
    if (command.type === "queue.remove") {
      entries = entries.filter((entry) => entry.queueId !== command.queueId)
      return { ok: true }
    }
    if (command.type === "user.submit") return { ok: true, result: { queueId: ids("queue"), steered: command.delivery === "steer" } }
  } })
  h.app.applySettings(settings)
  const chat = conversation(h.sessionId, h.app.onEvent)
  chat.exchange("Review the queue", "Looking")
  return { ...h, chat, first, second, expanded, lists: () => lists.length }
}

const running = (h: ReturnType<typeof queueHarness>) => {
  const turnId = ids("turn")
  h.chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  h.chat.emit({ type: "foreground.state", state: "tool", turnId })
}

test("/queue opens the manager with every queued message and the policy", async () => {
  const h = queueHarness("after-tools")
  await h.type("/queue\r")
  await Bun.sleep(5)
  const text = h.text().join("\n")
  expect(text).toContain("Queue")
  expect(text).toContain("queue: after-tools")
  expect(text).toContain("Check the cancellation path")
  expect(text).toContain("Run the focused tests")
  expect(h.sentOf("queue.list")).toHaveLength(1)
})

test("K moves the selected message up, e edits it in place, s steers it and x twice drops it", async () => {
  const h = queueHarness()
  await h.type("/queue\r")
  await Bun.sleep(5)
  await h.app.onKey("\x1b[B")
  await h.app.onKey("K")
  expect(h.sentOf("queue.reorder").at(-1)).toMatchObject({ queueId: h.second, to: "up" })
  await Bun.sleep(5)
  // The second message is now first and selected.
  await h.app.onKey("e")
  for (const char of " now") await h.app.onKey(char)
  await h.app.onKey("\r")
  expect(h.sentOf("queue.edit").at(-1)).toMatchObject({ queueId: h.second, text: "Run the focused tests now" })
  await Bun.sleep(5)
  expect(h.text().join("\n")).toContain("Run the focused tests now")
  await h.app.onKey("s")
  expect(h.sentOf("queue.steer").at(-1)).toMatchObject({ queueId: h.second })
  await Bun.sleep(5)
  expect(h.text().join("\n")).toContain("STEER")
  await h.app.onKey("x")
  expect(h.sentOf("queue.remove")).toHaveLength(0)
  await h.app.onKey("x")
  expect(h.sentOf("queue.remove").at(-1)).toMatchObject({ queueId: h.second })
})

test("an expanded message is not editable and says why; esc leaves an edit without sending", async () => {
  const h = queueHarness()
  await h.type("/queue\r")
  await Bun.sleep(5)
  await h.app.onKey("\x1b[B")
  await h.app.onKey("\x1b[B")
  await h.app.onKey("e")
  await Bun.sleep(5)
  expect(h.text().join("\n")).toContain("cannot be edited")
  await h.app.onKey("\x1b[A")
  await h.app.onKey("e")
  await h.app.onKey("!")
  await h.app.onKey("\x1b")
  expect(h.sentOf("queue.edit")).toHaveLength(0)
  expect(h.text().join("\n")).toContain("Queue")
})

test("a queue change from another terminal refreshes the open page", async () => {
  const h = queueHarness()
  await h.type("/queue\r")
  await Bun.sleep(5)
  const before = h.lists()
  h.chat.emit({ type: "queue.changed", queue: [{ queueId: h.first, preview: "Check the cancellation path", attachments: 0 }] })
  await Bun.sleep(5)
  expect(h.lists()).toBeGreaterThan(before)
})

test("ctrl+shift+enter sends once the other way: steer by default, queue under after-tools, plain when idle", async () => {
  const flip = "\x1b[13;6u"
  const idle = queueHarness()
  await idle.type("hello")
  await idle.app.onKey(flip)
  expect(idle.sentOf("user.submit").at(-1)).not.toHaveProperty("delivery")

  const steer = queueHarness()
  running(steer)
  await steer.type("use the other file")
  await steer.app.onKey(flip)
  expect(steer.sentOf("user.submit").at(-1)).toMatchObject({ text: "use the other file", delivery: "steer" })
  await steer.type("plain")
  await steer.app.onKey("\r")
  expect(steer.sentOf("user.submit").at(-1)).not.toHaveProperty("delivery")

  const tools = queueHarness("after-tools")
  running(tools)
  await tools.type("wait for me")
  await tools.app.onKey(flip)
  expect(tools.sentOf("user.submit").at(-1)).toMatchObject({ delivery: "queue" })
})
