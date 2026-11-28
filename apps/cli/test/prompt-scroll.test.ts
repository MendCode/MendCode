import { afterEach, describe, expect, test } from "bun:test"
import { appHarness, cleanTemps, tempDir, type Harness } from "./session-ui-harness"

afterEach(cleanTemps)

const NEWLINE = "\x1b\r"
const press = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`
const drag = (col: number, row: number) => `\x1b[<32;${col + 1};${row + 1}M`
const release = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}m`
const wheel = (up: boolean, col: number, row: number) => `\x1b[<${up ? 64 : 65};${col + 1};${row + 1}M`
const osc52 = (h: Harness) => h.written.filter((data) => data.startsWith("\x1b]52;c;")).map((data) => Buffer.from(data.slice(7, -1), "base64").toString("utf8"))
const rowOf = (h: Harness, needle: string) => h.text().findIndex((row) => row.includes(needle))
const names = (count: number) => Array.from({ length: count }, (_, i) => `row${String(i).padStart(3, "0")}`)

/** A terminal whose prompt holds `count` short lines: far taller than its box, so it scrolls inside. */
async function longPrompt(count = 60) {
  const h = appHarness({ dataDir: tempDir(), directory: "/repo", width: 60, height: 24, reply: () => undefined })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  await h.type(names(count).join(NEWLINE))
  return h
}

describe("a prompt taller than its box scrolls inside", () => {
  test("the wheel over the prompt scrolls the prompt, in both directions, and leaves the cursor and the text alone", async () => {
    const h = await longPrompt()
    const text = h.app.editor.text
    const cursor = h.app.editor.cursorOffset
    expect(rowOf(h, "row059")).toBeGreaterThan(0)
    expect(rowOf(h, "row000")).toBe(-1)
    const at = rowOf(h, "row059")
    for (let i = 0; i < 5; i++) await h.app.onKey(wheel(true, 8, at))
    h.app.render()
    expect(rowOf(h, "row059")).toBe(-1)
    expect(rowOf(h, "row0" + String(59 - 15))).toBeGreaterThan(0)
    expect(h.app.editor.text).toBe(text)
    expect(h.app.editor.cursorOffset).toBe(cursor)
    for (let i = 0; i < 50; i++) await h.app.onKey(wheel(true, 8, at))
    h.app.render()
    expect(rowOf(h, "row000")).toBeGreaterThan(0)
    for (let i = 0; i < 80; i++) await h.app.onKey(wheel(false, 8, at))
    h.app.render()
    expect(rowOf(h, "row059")).toBeGreaterThan(0)
  })

  test("a wheel over the transcript does not move the prompt", async () => {
    const h = await longPrompt()
    await h.app.onKey(wheel(true, 8, 2))
    h.app.render()
    expect(rowOf(h, "row059")).toBeGreaterThan(0)
  })

  test("the cursor pulls the window to itself only when it leaves it", async () => {
    const h = await longPrompt()
    const at = rowOf(h, "row059")
    for (let i = 0; i < 4; i++) await h.app.onKey(wheel(true, 8, at))
    await h.type("\x1b[A")
    h.app.render()
    expect(rowOf(h, "row058")).toBeGreaterThan(0)
    expect(h.app.editor.cursor.row).toBe(58)
    await h.type("\x1b[H")
    h.app.render()
    expect(rowOf(h, "row000")).toBeGreaterThan(0)
    await h.type("\x1b[F")
    h.app.render()
    expect(rowOf(h, "row059")).toBeGreaterThan(0)
    await h.type("\x1b[A".repeat(10))
    h.app.render()
    expect(rowOf(h, "row049")).toBeGreaterThan(0)
    expect(rowOf(h, "row059")).toBe(-1)
  })

  test("dragging past the top edge scrolls the prompt and the copy holds every row dragged over", async () => {
    const h = await longPrompt(40)
    const last = rowOf(h, "row039")
    const start = h.text()[last]!.indexOf("row039")
    await h.app.onKey(press(start + 6, last))
    await h.app.onKey(drag(start + 6, last - 1))
    await h.app.onKey(drag(start + 6, 0))
    await Bun.sleep(900)
    h.app.render()
    expect(rowOf(h, "row000")).toBeGreaterThan(0)
    await h.app.onKey(release(start + 6, 0))
    const copied = osc52(h).at(-1)!
    expect(copied).toBe(names(40).join("\n"))
  })

  test("a drag held while the wheel turns keeps extending to the pointer", async () => {
    const h = await longPrompt(40)
    const last = rowOf(h, "row039")
    const start = h.text()[last]!.indexOf("row039")
    await h.app.onKey(press(start + 6, last))
    await h.app.onKey(drag(start + 6, last - 2))
    for (let i = 0; i < 30; i++) await h.app.onKey(wheel(true, start + 6, last - 2))
    h.app.render()
    await h.app.onKey(release(start + 6, last - 2))
    const copied = osc52(h).at(-1)!
    // The pointer rests on the window's fourth row, which the wheel took to the top: the copy runs from the end of row003 to the press.
    expect(copied.startsWith("\nrow004")).toBe(true)
    expect(copied.split("\n").length).toBe(37)
    expect(copied.endsWith("row039")).toBe(true)
  })

  test("select-all then ctrl+c copies the whole prompt, rows out of sight included, and keeps the draft", async () => {
    const h = await longPrompt()
    await h.type("\x1b[97;9u")
    h.app.render()
    await h.type("\x03")
    expect(osc52(h).at(-1)).toBe(names(60).join("\n"))
    expect(h.app.editor.text).toBe(names(60).join("\n"))
    expect(h.app.editor.selection).toBeUndefined()
  })

  test("shift+ctrl-free selection with shift+↑ across the window copies the rows it covers", async () => {
    const h = await longPrompt()
    for (let i = 0; i < 20; i++) await h.type("\x1b[1;2A")
    h.app.render()
    expect(rowOf(h, "row039")).toBeGreaterThan(0)
    await h.type("\x03")
    const copied = osc52(h).at(-1)!
    // From the end of row039 (the cursor's column) to the end of the text.
    expect(copied.split("\n")).toHaveLength(21)
    expect(copied.startsWith("\nrow040")).toBe(true)
    expect(copied.endsWith("row059")).toBe(true)
  })
})
