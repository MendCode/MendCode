import { describe, expect, test } from "bun:test"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { textWidth } from "../src/view/wrap"

const ids = createIdFactory()
const sessionId = ids("session")
const otherId = ids("session")

/** The palette card is on screen: its key hint row is only drawn by the palette. */
const isOpen = (rows: string[]) => rows.some((line) => line.includes("Run enter") && line.includes("Close esc"))

function harness(height = 30) {
  const frames: Line[][] = []
  const cursors: Array<{ row: number; col: number } | undefined> = []
  const sent: Array<Record<string, unknown>> = []
  const screen = {
    size: { width: 100, height },
    draw: (rows: Line[], cursor?: { row: number; col: number }) => (frames.push(rows), cursors.push(cursor)),
  } as unknown as Parameters<typeof createApp>[0]["screen"]
  const send = async (command: unknown) => {
    const c = command as Record<string, unknown>
    sent.push(c)
    if (c.type === "session.list")
      return { ok: true, result: { sessions: [{ sessionId: otherId, title: "fix flaky reconnect", directory: "/x", createdAt: 1, updatedAt: 2, lastSeq: 0, state: "idle", queued: 0 }] } }
    return { ok: true }
  }
  const app = createApp({ sessionId, screen, send: send as never, exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}) })
  const text = () => frames.at(-1)!.map((row) => row.map((s) => s.text).join(""))
  return { app, text, sent, frames, cursors }
}

describe("command palette in the app", () => {
  test("a command run from the palette leaves what was typed in the prompt", async () => {
    const { app } = harness()
    await app.onInput("half a thought about the parser")
    await app.onInput("\x10")
    await app.onInput("usage")
    await app.onInput("\r")
    expect(app.page).toBe("usage")
    expect(app.editor.text).toBe("half a thought about the parser")
  })

  test("ctrl+p opens the palette over the chat page, typing filters, enter opens the usage page", async () => {
    const { app, text, sent } = harness()
    await app.onInput("\x10")
    expect(isOpen(text())).toBe(true)
    expect(text().some((line) => line.includes("new") && line.includes("Start a session"))).toBe(true)
    expect(sent.some((c) => c.type === "session.list" && c.limit === 30)).toBe(true)
    await app.onInput("usage")
    const rows = text()
    expect(rows.some((line) => line.trim().startsWith("usage") && /\d+\/\d+/.test(line))).toBe(true)
    expect(rows.some((line) => line.includes("usage") && line.includes("Show usage and quota") && line.includes("command"))).toBe(true)
    await app.onInput("\r")
    expect(app.page).toBe("usage")
    expect(isOpen(text())).toBe(false)
    expect(sent.some((c) => c.type === "usage.query")).toBe(true)
  })
  test("the palette draws over the page rows and keeps every row inside the screen", async () => {
    const { app, text, cursors } = harness()
    await app.onInput("\x10")
    for (const line of text()) expect(textWidth(line)).toBeLessThanOrEqual(100)
    expect(text()).toHaveLength(30)
    expect(cursors.at(-1)).toBeDefined()
    expect(text()[cursors.at(-1)!.row]).toContain("search commands")
  })
  test("esc closes the palette without side effects", async () => {
    const { app, text, sent } = harness()
    await app.onInput("\x10")
    await app.onInput("\x1b")
    expect(isOpen(text())).toBe(false)
    expect(app.page).toBe("chat")
    expect(sent.filter((c) => c.type !== "session.list")).toEqual([])
  })
  test("typed text goes to the palette, not the editor", async () => {
    const { app } = harness()
    await app.onInput("\x10")
    await app.onInput("abc")
    expect(app.editor.text).toBe("")
    await app.onInput("\x1b")
    await app.onInput("hi")
    expect(app.editor.text).toBe("hi")
  })
  test("sessions load asynchronously and can be opened", async () => {
    const { app, text, sent } = harness()
    await app.onInput("\x10")
    await app.onInput("flaky")
    expect(text().some((line) => line.includes("session") && line.includes("fix flaky reconnect"))).toBe(true)
    await app.onInput("\r")
    expect(sent.some((c) => c.type === "client.unsubscribe" || c.type === "session.list")).toBe(true)
    expect(app.sessionId as SessionId).toBe(otherId)
  })
  test("theme, view and permission items run their commands", async () => {
    const { app, sent } = harness()
    await app.onInput("\x10")
    await app.onInput("mono")
    await app.onInput("\r")
    expect(sent.some((c) => c.type === "settings.set" && JSON.stringify(c.patch).includes("mono"))).toBe(true)
    await app.onInput("\x10")
    await app.onInput("minimal")
    await app.onInput("\r")
    expect(sent.some((c) => c.type === "settings.set" && JSON.stringify(c.patch).includes("minimal"))).toBe(true)
    await app.onInput("\x10")
    await app.onInput("full access")
    await app.onInput("\r")
    expect(sent.some((c) => c.type === "settings.set" || c.type === "session.permission" || String(c.type).includes("permission"))).toBe(true)
  })
  test("ctrl+p still moves the selection inside the sessions page", async () => {
    const { app, text } = harness()
    await app.onInput("\x10")
    await app.onInput("sessions")
    await app.onInput("\r")
    expect(app.page).toBe("sessions")
    await app.onInput("\x10")
    expect(isOpen(text())).toBe(false)
  })
  test("no palette while an approval is pending", async () => {
    const { app, text } = harness()
    app.onEvent({ sessionId, seq: 1, at: 0, type: "turn.started", turnId: ids("turn"), queueId: ids("queue") } as never)
    app.onEvent({ sessionId, seq: 2, at: 0, type: "server.request", requestId: ids("request"), turnId: ids("turn"), kind: "approval", title: "Run command", detail: "ls" } as never)
    await app.onInput("\x10")
    expect(isOpen(text())).toBe(false)
  })
})
