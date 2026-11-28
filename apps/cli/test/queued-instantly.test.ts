import { afterEach, describe, expect, test } from "bun:test"
import { appHarness, cleanTemps, conversation, ids, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

/** A chat with a turn running, whose daemon answers a prompt only when the test lets it (a chat on a hub takes a few round trips). */
function running() {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const h = appHarness({ dataDir: tempDir(), width: 100, height: 30, reply: async (command) => { if (command.type === "user.submit") { await gate; return { ok: true, result: { queueId: ids("queue") } } } return { ok: true } } })
  h.app.applySettings({ onboarded: true })
  const chat = conversation(h.sessionId, h.app.onEvent)
  chat.exchange("hello", "hi")
  const turnId = ids("turn")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "foreground.state", state: "generating", turnId })
  h.app.render()
  return { ...h, chat, release }
}

describe("a message sent while a turn runs", () => {
  test("shows as queued from the keypress, before the daemon has answered", async () => {
    const h = running()
    expect(h.text().join("\n")).not.toContain("check the logs")
    await h.type("check the logs")
    void h.type("\r")
    await Bun.sleep(20)
    h.app.render()
    expect(h.sentOf("user.submit")).toHaveLength(1)
    expect(h.text().join("\n")).toContain("check the logs")
    h.release()
    await Bun.sleep(10)
  })

  test("is drawn once when the daemon's own queue arrives, and gone when the reply is", async () => {
    const h = running()
    await h.type("then the tests")
    void h.type("\r")
    await Bun.sleep(20)
    const queueId = ids("queue")
    h.chat.emit({ type: "queue.added", queueId, text: "then the tests", attachments: [] })
    h.chat.emit({ type: "queue.changed", queue: [{ queueId, preview: "then the tests", attachments: 0 }] })
    h.release()
    await Bun.sleep(20)
    h.app.render()
    const rows = h.text().filter((row) => row.includes("then the tests"))
    expect(rows).toHaveLength(1)
  })

  test("is not shown when no turn runs: the message starts one", async () => {
    const h = appHarness({ dataDir: tempDir(), width: 100, height: 30, reply: async (command) => (command.type === "user.submit" ? new Promise(() => {}) : { ok: true }) })
    h.app.applySettings({ onboarded: true })
    await h.type("hello there")
    void h.type("\r")
    await Bun.sleep(20)
    h.app.render()
    expect(h.sentOf("user.submit")).toHaveLength(1)
    expect(h.text().join("\n")).not.toContain("hello there")
  })
})
