import { afterEach, describe, expect, test } from "bun:test"
import { appHarness, cleanTemps, conversation, ids, tempDir, type Harness } from "./session-ui-harness"

afterEach(cleanTemps)

const press = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`
const release = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}m`
const drag = (col: number, row: number) => `\x1b[<32;${col + 1};${row + 1}M`
const rowOf = (h: Harness, needle: string) => h.text().findIndex((row) => row.includes(needle))
const output = (count: number) => Array.from({ length: count }, (_, i) => `out line ${i + 1}`).join("\n")
const shows = (h: Harness, needle: string) => h.text().some((row) => row.includes(needle))

/** A full-view chat with a short exchange and one finished shell card of `lines` rows of output (more turns can follow). */
async function chat({ lines = 60, height = 30, width = 100 }: { lines?: number; height?: number; width?: number } = {}) {
  const h = appHarness({ dataDir: tempDir(), width, height, mode: "full", directory: tempDir() })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  const talk = conversation(h.sessionId, h.app.onEvent)
  talk.exchange("Run it", "Running.")
  const shell = (command: string, text: string, status: "ok" | "running" = "ok") => {
    const turnId = ids("turn")
    const itemId = ids("item")
    talk.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    talk.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: `shell: ${command}` } })
    if (status === "ok") {
      talk.emit({ type: "item.completed", itemId, status: "ok", text, meta: { tool: `shell: ${command}` } })
      talk.emit({ type: "turn.completed", turnId })
    }
    h.app.render()
    return itemId
  }
  shell("make all", output(lines))
  return { h, talk, shell }
}

async function click(h: Harness, col: number, row: number) {
  await h.app.onKey(press(col, row))
  await h.app.onKey(release(col, row))
  h.app.render()
}

describe("clicking a tool card", () => {
  test("a click on the header opens the card and a click on any body row closes it again", async () => {
    const { h } = await chat()
    expect(shows(h, "out line 20")).toBe(false)
    await click(h, 12, rowOf(h, "make all"))
    expect(shows(h, "out line 20")).toBe(true)
    await click(h, 14, rowOf(h, "out line 20"))
    expect(shows(h, "out line 20")).toBe(false)
    expect(shows(h, "make all")).toBe(true)
  })

  test("a click on the body of a collapsed card opens it", async () => {
    const { h } = await chat({ lines: 12 })
    await click(h, 14, rowOf(h, "out line 12"))
    expect(shows(h, "out line 1")).toBe(true)
    expect(shows(h, "out line 8")).toBe(true)
  })

  test("closing from a row far below a header that scrolled off keeps the card's header in view", async () => {
    const { h } = await chat({ lines: 39, height: 20 })
    await click(h, 12, rowOf(h, "make all"))
    await h.app.onKey("\x1b[6~")
    h.app.render()
    expect(shows(h, "make all")).toBe(false)
    await click(h, 14, rowOf(h, "out line"))
    expect(shows(h, "make all")).toBe(true)
    expect(shows(h, "out line 20")).toBe(false)
    expect(shows(h, "out line 39")).toBe(true)
  })

  test("closing a card keeps its header on the screen row it was on", async () => {
    const { h, talk } = await chat({ lines: 20, height: 40 })
    for (let n = 0; n < 8; n++) talk.exchange(`Later ${n}`, `Answer ${n}`)
    h.app.render()
    await h.app.onKey("\x1b[5~")
    h.app.render()
    const header = rowOf(h, "make all")
    expect(header).toBeGreaterThanOrEqual(0)
    await click(h, 12, header)
    expect(rowOf(h, "make all")).toBe(header)
    expect(shows(h, "out line 5")).toBe(true)
    await click(h, 14, rowOf(h, "out line 5"))
    expect(rowOf(h, "make all")).toBe(header)
    expect(shows(h, "out line 5")).toBe(false)
  })

  test("closing a card while a turn streams keeps the header where it was and the stream growing", async () => {
    const { h, talk } = await chat({ lines: 20, height: 40 })
    // Enough turns below that one page up never lands on the top of the transcript, whatever the tool density (a view clamped to the top moves a card's head by a row when it opens, in every density).
    for (let n = 0; n < 14; n++) talk.exchange(`Later ${n}`, `Answer ${n}`)
    h.app.render()
    await h.app.onKey("\x1b[5~")
    h.app.render()
    const header = rowOf(h, "make all")
    await click(h, 12, header)
    const turnId = ids("turn")
    const itemId = ids("item")
    talk.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    talk.emit({ type: "item.started", turnId, itemId, kind: "agent_message" })
    talk.emit({ type: "item.delta", itemId, text: "streaming answer one" })
    h.app.render()
    expect(rowOf(h, "make all")).toBe(header)
    await click(h, 14, rowOf(h, "out line 5"))
    expect(rowOf(h, "make all")).toBe(header)
    talk.emit({ type: "item.delta", itemId, text: "\n\nstreaming answer two\n\nthree\n\nfour" })
    h.app.render()
    expect(rowOf(h, "make all")).toBe(header)
  })

  test("a drag over the output selects it and does not toggle the card", async () => {
    const { h } = await chat()
    await click(h, 12, rowOf(h, "make all"))
    const first = rowOf(h, "out line 3")
    await h.app.onKey(press(10, first))
    await h.app.onKey(drag(20, first + 2))
    await h.app.onKey(release(20, first + 2))
    h.app.render()
    expect(shows(h, "out line 3")).toBe(true)
    expect(shows(h, "out line 20")).toBe(true)
  })

  test("the second press of a double click selects a word and does not toggle another card", async () => {
    const { h } = await chat({ lines: 20 })
    await click(h, 12, rowOf(h, "make all"))
    const row = rowOf(h, "out line 5")
    await click(h, 14, row)
    expect(shows(h, "out line 5")).toBe(false)
    await click(h, 14, row)
    expect(shows(h, "out line 5")).toBe(false)
  })
})
