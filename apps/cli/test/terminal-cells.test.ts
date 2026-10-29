import { describe, expect, test } from "bun:test"
import { createScreen } from "../src/ui/screen"
import { cells, terminalText, textWidth, wrap } from "../src/view/wrap"
import { truncateEnd } from "../src/view/session-list"

describe("cells: what the terminal draws", () => {
  test("widths follow the terminal for emoji presentation, skin tones, ZWJ sequences, flags and CJK", () => {
    expect(textWidth("✅")).toBe(2)
    expect(textWidth("⚠️")).toBe(2)
    expect(textWidth("👍🏽")).toBe(2)
    expect(textWidth("👨‍👩‍👧")).toBe(2)
    expect(textWidth("🇵🇦")).toBe(2)
    expect(textWidth("中文")).toBe(4)
    expect(textWidth("é")).toBe(1)
    expect([...cells("👨‍👩‍👧x")].map((c) => c.text)).toEqual(["👨‍👩‍👧", "x"])
  })

  test("escape sequences and control characters never reach the screen; tabs become four spaces", () => {
    expect(terminalText("\x1b[31mred\x1b[0m done")).toBe("red done")
    expect(terminalText("\x1b]8;;https://x.y\x07link\x1b]8;;\x07")).toBe("link")
    expect(terminalText("a\tb")).toBe("a    b")
    expect(terminalText("progress\r50%\x08\x07")).toBe("progress50%")
    expect(textWidth("\x1b[1mbold\x1b[0m")).toBe(4)
    expect(textWidth("a\tb")).toBe(6)
  })

  test("wrapping and truncation never split a grapheme and never exceed the width", () => {
    for (const line of wrap("✅✅✅✅✅ 👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧", 5)) expect(textWidth(line)).toBeLessThanOrEqual(5)
    expect(truncateEnd("status ✅ ok ⚠️ warn", 10)).toBe("status ✅…")
    expect(textWidth(truncateEnd("👍🏽👍🏽👍🏽👍🏽", 5))).toBeLessThanOrEqual(5)
  })
})

describe("screen output", () => {
  function screen(width: number, height: number) {
    const writes: string[] = []
    const s = createScreen({ write: (d: string) => void writes.push(d), columns: width, rows: height }, { COLORTERM: "truecolor", MENDCODE_MOUSE: "0" })
    return { s, writes }
  }

  test("each frame is wrapped in synchronized output so the terminal shows it at once", () => {
    const { s, writes } = screen(10, 2)
    s.draw([[{ text: "hi" }]])
    expect(writes.at(-1)!.startsWith("\x1b[?2026h")).toBe(true)
    expect(writes.at(-1)!.endsWith("\x1b[?2026l")).toBe(true)
  })

  test("a full-width row is not followed by erase-line (it would delete the last character in pending wrap)", () => {
    const { s, writes } = screen(5, 3)
    s.draw([[{ text: "abcde" }], [{ text: "ab" }]])
    const frame = writes.at(-1)!
    expect(frame).toContain("\x1b[1;1Habcde\x1b[2;1H")
    expect(frame).toContain("\x1b[2;1Hab\x1b[K")
  })

  test("the bottom-right cell is never written", () => {
    const { s, writes } = screen(5, 2)
    s.draw([[], [{ text: "abcdefgh" }]])
    // Four cells written, none past them: the corner is never touched, so nothing there needs erasing.
    expect(writes.at(-1)!).toContain("\x1b[2;1Habcd\x1b[?25l")
  })

  test("colored tool output is drawn as plain text inside our own styles", () => {
    const { s, writes } = screen(20, 1)
    s.draw([[{ text: "\x1b[31mFAIL\x1b[0m\tx" }]])
    expect(writes.at(-1)!).toContain("FAIL    x")
    expect(writes.at(-1)!).not.toContain("\x1b[31m")
  })
})
