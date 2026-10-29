import { describe, expect, test } from "bun:test"
import { glyphs, type Line } from "../src/ui/theme"
import { replyUnits, type ReplyComment } from "../src/view/reply-comments"
import { chipRow, commentHint, commentList, composeHeader, decideHeader, hintByPassage, markRows, parseDecisions, replyBar } from "../src/view/reply-comments-view"
import { fit } from "../src/view/deck"
import { lineWidth } from "../src/view/wrap"

const g = glyphs({})
const text = (line: Line) => line.map((span) => span.text).join("")
const QUOTES = ["Use Opus 5 for the planner and keep the executor on codex.", "Before either, tell the user the schema change cannot be undone.", "await migrate({ dryRun: true })", "Pick one and I will start.", "Use codex for both."]
const chips = (count: number) => QUOTES.slice(0, count).map((quote, index) => ({ n: index + 1, quote }))
const comments = (count: number): ReplyComment[] => QUOTES.slice(0, count).map((quote, index) => ({ id: index, quote, text: `words ${index + 1}`, itemId: "a" }))

describe("chip row", () => {
  test("fits every width from 40 to 160 and keeps a count when the chips do not fit", () => {
    for (const width of [40, 60, 80, 120, 160]) {
      for (const count of [1, 2, 3, 5, 9]) {
        const row = chipRow({ chips: Array.from({ length: count }, (_, i) => chips(5)[i % 5]!).map((chip, i) => ({ ...chip, n: i + 1 })), width, listing: false }, g)
        expect(lineWidth(row)).toBeLessThanOrEqual(width)
        const drawn = text(row)
        // Either every chip is there with its number or the row says how many there are.
        expect(drawn.includes(`[${count}`) || drawn.includes(`${count} comment`)).toBe(true)
      }
    }
  })

  test("three chips collapse to a count at 60 columns and show their quotes at 80", () => {
    expect(text(chipRow({ chips: chips(3), width: 60, listing: false }, g))).toContain("3 comments")
    expect(text(chipRow({ chips: chips(3), width: 80, listing: false }, g))).toContain("[3 ")
  })

  test("a comment on an earlier answer carries an arrow after its number", () => {
    expect(text(chipRow({ chips: [{ n: 1, quote: QUOTES[0]!, earlier: true }], width: 80, listing: false }, g))).toContain("1↑")
  })
})

describe("compose and decide headers", () => {
  test("stay inside the width, keep the quote readable and say the draft is kept while there is room", () => {
    for (const width of [30, 40, 60, 80, 120]) {
      const row = composeHeader({ quote: QUOTES[0]!, width, draftKept: true }, g)
      expect(lineWidth(row)).toBe(width)
      expect(text(row)).toContain("comment on")
    }
    expect(text(composeHeader({ quote: QUOTES[0]!, width: 100, draftKept: true }, g))).toContain("draft kept")
    for (const width of [30, 60, 120]) expect(lineWidth(decideHeader({ options: [1, 2], pairs: [{ number: 1, text: "yes" }], width }, g))).toBe(width)
  })
})

describe("numbered decisions", () => {
  const options = [{ number: 1 }, { number: 2 }]
  test("`1: yes, 2: no` answers both options", () => {
    expect(parseDecisions("1: yes, 2: no", options)).toEqual({ pairs: [{ number: 1, text: "yes" }, { number: 2, text: "no" }], unknown: [] })
  })
  test("a comma inside the words stays in them, and a number with no option is reported", () => {
    expect(parseDecisions("1: yes, but later, 3: no", options)).toEqual({ pairs: [{ number: 1, text: "yes, but later" }], unknown: [3] })
  })
  test("nothing typed yet parses to nothing", () => {
    expect(parseDecisions("", options)).toEqual({ pairs: [], unknown: [] })
    expect(parseDecisions("1:", options).pairs).toEqual([])
  })
})

describe("list, bar and marks", () => {
  test("the list keeps the selected comment on screen and every row inside the width", () => {
    for (const width of [40, 60, 80]) {
      const rows = commentList({ comments: comments(5), selected: 4, width, maxRows: 5, lastItemId: "a" }, g)
      expect(rows.length).toBeLessThanOrEqual(5)
      expect(rows.some((row) => text(row).includes("5 "))).toBe(true)
      for (const row of rows) expect(lineWidth(row)).toBeLessThanOrEqual(width)
    }
  })
  test("a comment whose answer is gone says only its quote is sent", () => {
    const [orphan] = comments(1)
    const { itemId: _gone, ...rest } = orphan!
    expect(commentList({ comments: [rest as ReplyComment], selected: 0, width: 80, maxRows: 4 }, g).map(text).join("\n")).toContain("quote only")
  })
  test("the reply bar always leaves a way out", () => {
    const units = replyUnits("1. a\n2. b")
    for (const width of [20, 40, 60, 100]) {
      const row = replyBar({ index: 0, total: 2, unit: units[0]!, width, options: true }, g)
      expect(lineWidth(row)).toBe(width)
      expect(text(row)).toContain("esc")
    }
  })
  test("a gutter mark puts the number on the first row and the rail beside the rest, and moves no text", () => {
    const rows: Line[] = ["  alpha", "  beta", "  gamma"].map((row) => fit([{ text: row }], 20))
    const marked = markRows({ rows, from: 0, to: 1, n: 2, width: 20 }, g).map(text)
    expect(marked[0]!.startsWith(`2${g.rail}`)).toBe(true)
    expect(marked[1]!.startsWith(` ${g.rail}`)).toBe(true)
    expect(marked[2]).toBe(text(rows[2]!))
    expect(marked.map((row) => row.slice(2).trimEnd())).toEqual(["alpha", "beta", "gamma"])
  })
})

describe("hint", () => {
  const rows = ["  a short row", "", "  a row that fills the whole width of the screen right up to its end ok"].map((row) => fit([{ text: row }], 72))
  const plain = rows.map(text)
  const hint = commentHint({ copied: false, width: 60 }, g)
  test("goes on the passage's last row when its text leaves room", () => {
    expect(hintByPassage({ rows, plain, from: 0, to: 0, width: 72, hint })).toMatchObject({ row: 0, covers: false })
  })
  test("goes on the blank row under a full row, else nowhere unless allowed to cover words", () => {
    expect(hintByPassage({ rows, plain: [plain[2]!, "", "y"], from: 0, to: 0, width: 72, hint: commentHint({ copied: false, width: 60 }, g) })?.row).toBe(1)
    expect(hintByPassage({ rows, plain, from: 2, to: 2, width: 72, hint })).toBeUndefined()
    expect(hintByPassage({ rows, plain, from: 2, to: 2, width: 72, hint, cover: true })).toMatchObject({ row: 2, covers: true })
  })
  test("shrinks to fit a narrow screen", () => {
    expect(lineWidth(commentHint({ copied: true, width: 12 }, g))).toBeLessThanOrEqual(12)
  })
})
