import { expect, test } from "bun:test"
import { lineWidth, shortenMiddle, takeCellSlice, truncateEnd } from "../src/view/wrap"
import { lineWidth as deckWidth } from "../src/view/deck"
import { lineWidth as panelWidth } from "../src/view/panel-box"
import { shortenMiddle as sessionMiddle, truncateEnd as sessionEnd } from "../src/view/session-list"

test("styled row widths preserve span boundaries, controls and wide graphemes", () => {
  const row = [{ text: "ab", fg: "text" as const }, { text: "猫👨‍👩‍👧" }, { text: "\t\x1b[31mx\x1b[0m\n" }] as const
  expect(lineWidth(row)).toBe(11)
  expect(deckWidth([...row])).toBe(11)
  expect(panelWidth([...row])).toBe(11)
  expect(lineWidth([{ text: "e" }, { text: "\u0301" }])).toBe(1)
  expect(lineWidth([])).toBe(0)
})

test("shared truncation preserves end and tail-biased path policies", () => {
  expect(sessionEnd).toBe(truncateEnd)
  expect(sessionMiddle).toBe(shortenMiddle)
  for (const width of [-1, 0]) {
    expect(truncateEnd("abc", width)).toBe("")
    expect(shortenMiddle("abc", width)).toBe("")
  }
  expect(truncateEnd("abc", 1)).toBe("…")
  expect(truncateEnd("ab猫cd", 4)).toBe("ab…")
  expect(truncateEnd("e\u0301👨‍👩‍👧x", 4)).toBe("e\u0301👨‍👩‍👧x")
  expect(shortenMiddle("/project/deep/file.ts", 10)).toBe("/pr…ile.ts")
  expect(shortenMiddle("猫猫猫猫", 4)).toBe("…猫")
  const measured = [{ text: "a", width: 1 }, { text: "猫", width: 2 }, { text: "b", width: 1 }]
  expect(takeCellSlice(measured, 2, true)).toBe("b")
  expect(measured.map((cell) => cell.text)).toEqual(["a", "猫", "b"])
})
