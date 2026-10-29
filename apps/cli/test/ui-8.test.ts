import { afterEach, expect, test } from "bun:test"
import { createEditor, editorRows, graphemes } from "../src/view/editor"
import { textWidth } from "../src/view/wrap"
import { createScreen } from "../src/ui/screen"
import { setTheme } from "../src/ui/theme"
import { cleanTemps } from "./session-ui-harness"
import { SCRATCH_TEXT, UI8_SIZES, ui8Harness } from "./ui-8-harness"

afterEach(() => { cleanTemps(); setTheme("mend") })

test("scratchpad wraps at word boundaries and only hard-breaks oversized words; offsets are lossless", () => {
  const rows = editorRows("A scratchpad keeps notes", 10, true)
  expect(rows.map((row) => row.text)).toEqual(["A ", "scratchpad", " keeps ", "notes"])
  expect(editorRows("abcdefghijklmnop", 5, true).map((row) => row.text)).toEqual(["abcde", "fghij", "klmno", "p"])
  const text = "A scratchpad with 👩🏽‍💻 and é notes\n猫猫猫猫猫猫 longword"
  const chars = graphemes(text)
  for (const row of editorRows(text, 10, true)) {
    expect(graphemes(row.text)).toEqual(chars.slice(row.start, row.end))
    expect(textWidth(row.text)).toBeLessThanOrEqual(10)
  }
})

test("word wrap preserves editing, selection, visual home/end and resizing offsets", () => {
  const editor = createEditor({ wordWrap: true })
  editor.insert("Keep scratchpad notes")
  editor.setVisualWidth(12)
  expect(editor.visualLines().map((row) => row.text)).toEqual(["Keep ", "scratchpad ", "notes"])
  editor.action("visual-line-home")
  expect(editor.cursorOffset).toBe(16)
  editor.action("select-left")
  expect(editor.selectedText).toBe(" ")
  editor.setVisualWidth(20)
  expect(editor.cursorOffset).toBe(15)
  expect(editor.text).toBe("Keep scratchpad notes")
  editor.action("visual-line-end")
  expect(editor.cursorOffset).toBe(16)
})

for (const [width, height] of UI8_SIZES) test(`app usage/context/scratchpad fit ${width}x${height}, keys and persistence stay live`, async () => {
  const h = ui8Harness(width, height, true)
  await h.type("/usage\r")
  expect(h.app.page).toBe("usage")
  expect(h.sentOf("usage.query")).toHaveLength(1)
  if (width >= 180) expect(h.text().at(-2)?.trimEnd()).toEndWith("┘")
  await h.app.onKey("\x1b")
  await h.type("/context\r")
  expect(h.app.page).toBe("context")
  expect(h.text().join("\n")).toContain("Autocompact buffer")
  await h.app.onKey("2")
  expect(h.text().join("\n")).toContain("Largest messages")
  await h.app.onKey("r")
  expect(h.sentOf("context.query")).toHaveLength(2)
  await h.app.onKey("\x1b")
  await h.type("/scratch\r")
  await h.app.onKey("\x1b[H")
  expect(h.text().join("\n")).toContain("Scratchpad")
  const cursor = h.cursors.at(-1)
  expect(cursor).toBeDefined()
  expect(cursor!.col).toBeLessThan(width)
  expect(cursor!.row).toBeLessThan(height)
  await h.type("Draft ")
  await h.app.onKey("\x1b")
  await Bun.sleep(5)
  expect(h.sentOf("scratchpad.set").at(-1)).toMatchObject({ text: `Draft ${SCRATCH_TEXT}` })
  for (const frame of h.frames) {
    expect(frame).toHaveLength(height)
    for (const line of frame) expect(textWidth(line.map((span) => span.text).join(""))).toBeLessThanOrEqual(width)
  }
  await h.app.onKey("\x03")
})

test("terminal home and arbitrary content emit no truecolor or extended palette through the real screen", async () => {
  const writes: string[] = []
  const screen = createScreen({ columns: 180, rows: 50, write: (data) => writes.push(data) }, { COLORTERM: "truecolor", MENDCODE_MOUSE: "0" })
  const h = ui8Harness(180, 50, false, true, screen)
  await Bun.sleep(5)
  h.app.render()
  screen.draw([[{ text: "swatch", fgHex: "#12ab34", bgHex: "#fedcba" }]])
  const output = writes.join("")
  expect(output).toContain("\x1b[32m")
  expect(output).not.toMatch(/(?:38|48);(?:2|5);/)
  await h.app.onKey("\x03")
})
