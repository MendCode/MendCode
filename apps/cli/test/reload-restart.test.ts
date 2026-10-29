import { afterAll, describe, expect, test } from "bun:test"
import { waitingNotice } from "../src/ui/app/daemon"
import { appHarness, cleanTemps, conversation } from "./session-ui-harness"

afterAll(cleanTemps)

const flush = () => Bun.sleep(5)

function harness() {
  let restarts = 0
  const h = appHarness({
    directory: "/work/app",
    daemon: { check: async () => "fresh", restart: async () => ({ ok: true }), restartTerminal: async () => { restarts++; return { ok: false, message: "could not restart" } } },
  })
  const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
  return { h, chat, restarts: () => restarts }
}

const screen = (h: ReturnType<typeof appHarness>) => h.text().join("\n")

describe("/reload and /restart act on this session only", () => {
  test("idle: /reload asks the daemon to reload this project's resources and says what was read again", async () => {
    const { h } = harness()
    await h.type("/reload\r")
    await flush()
    h.app.render()
    expect(h.sentOf("extensions.reload")).toEqual([expect.objectContaining({ type: "extensions.reload", directory: "/work/app" })])
    expect(h.sentOf("daemon.shutdown")).toHaveLength(0)
    expect(screen(h)).toContain("Reloaded")
  })

  test("idle: /restart restarts this terminal and never asks the daemon to stop", async () => {
    const { h, restarts } = harness()
    await h.type("/restart\r")
    await flush()
    expect(restarts()).toBe(1)
    expect(h.sentOf("daemon.shutdown")).toHaveLength(0)
  })

  test("while the response runs, both wait with a standing line and run once the turn ends", async () => {
    for (const action of ["reload", "restart"] as const) {
      const { h, chat, restarts } = harness()
      chat.emit({ type: "turn.started", turnId: "turn_1", queueId: "queue_1" })
      await h.type(`/${action}\r`)
      expect(screen(h)).toContain(waitingNotice(action))
      expect(h.sentOf("extensions.reload")).toHaveLength(0)
      expect(restarts()).toBe(0)
      chat.emit({ type: "turn.completed", turnId: "turn_1" })
      await flush()
      h.app.render()
      expect(screen(h)).not.toContain(waitingNotice(action))
      if (action === "reload") expect(h.sentOf("extensions.reload")).toHaveLength(1)
      else expect(restarts()).toBe(1)
    }
  })

  test("esc while waiting drops the wait and leaves the response running", async () => {
    const { h, chat } = harness()
    chat.emit({ type: "turn.started", turnId: "turn_1", queueId: "queue_1" })
    await h.type("/reload\r")
    await h.type("\x1b")
    await flush()
    h.app.render()
    expect(screen(h)).not.toContain(waitingNotice("reload"))
    expect(screen(h)).toContain("/reload cancelled")
    expect(h.sentOf("turn.cancel")).toHaveLength(0)
    chat.emit({ type: "turn.completed", turnId: "turn_1" })
    await flush()
    expect(h.sentOf("extensions.reload")).toHaveLength(0)
  })
})
