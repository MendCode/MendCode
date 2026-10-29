import { describe, expect, test } from "bun:test"
import { createEditor, editorRows, graphemes, offsetAtColumn, rowLimit, stepRows } from "../src/view/editor"

const UP = "\x1b[A"
const DOWN = "\x1b[B"

function editorWith(text: string, width: number, at?: number) {
  const editor = createEditor()
  editor.setVisualWidth(width)
  editor.insert(text)
  if (at !== undefined) editor.moveTo(at)
  return editor
}

describe("↑/↓ move one visual row", () => {
  test("a wrapped line is several rows: ↓ and ↑ walk them and stop at the first and last", () => {
    const editor = editorWith("abcdefghijkl", 4, 1)
    expect(editor.key(DOWN)).toBe("changed")
    expect(editor.cursorOffset).toBe(5)
    expect(editor.key(DOWN)).toBe("changed")
    expect(editor.cursorOffset).toBe(9)
    expect(editor.key(DOWN)).toBe("none")
    expect(editor.cursorOffset).toBe(9)
    editor.key(UP)
    editor.key(UP)
    expect(editor.cursorOffset).toBe(1)
    expect(editor.key(UP)).toBe("none")
  })

  test("a hard line break and a wrap both count as one row", () => {
    const editor = editorWith("abcdefgh\nxy", 4, 2)
    expect(editor.visualLines().map((row) => row.text)).toEqual(["abcd", "efgh", "xy"])
    editor.key(DOWN)
    expect(editor.cursorOffset).toBe(6)
    editor.key(DOWN)
    expect(editor.cursorOffset).toBe(11)
    expect(editor.cursor).toEqual({ row: 1, col: 2 })
  })

  test("the goal column survives a shorter row in between", () => {
    const editor = editorWith("abcdefgh\nx\nabcdefgh", 20, 6)
    editor.key(DOWN)
    expect(editor.cursor).toEqual({ row: 1, col: 1 })
    editor.key(DOWN)
    expect(editor.cursor).toEqual({ row: 2, col: 6 })
    editor.key(UP)
    editor.key(UP)
    expect(editor.cursor).toEqual({ row: 0, col: 6 })
  })

  test("moving sideways or typing forgets the goal column", () => {
    const editor = editorWith("abcdefgh\nx\nabcdefgh", 20, 6)
    editor.key(DOWN)
    editor.key("\x1b[D")
    editor.key(DOWN)
    expect(editor.cursor).toEqual({ row: 2, col: 0 })
  })

  test("a wide character counts two cells: the column is cells, not graphemes, and a cell inside a wide character lands before it", () => {
    const editor = editorWith("abcd\n漢字漢字", 20, 3)
    editor.key(DOWN)
    // cell 3 is the right half of the second wide character: the cursor sits before it.
    expect(editor.cursor).toEqual({ row: 1, col: 1 })
    editor.key(UP)
    expect(editor.cursor).toEqual({ row: 0, col: 3 })
    const wide = editorWith("漢字漢字\nabcdefgh", 20, 2)
    wide.key(DOWN)
    // two wide characters are four cells.
    expect(wide.cursor).toEqual({ row: 1, col: 4 })
    wide.key(DOWN)
    expect(wide.key(DOWN)).toBe("none")
  })

  test("a combining sequence and an emoji move as one grapheme", () => {
    const editor = editorWith("ééé\n👍🏽a👍🏽b", 20, 3)
    expect(graphemes(editor.text).length).toBe(8)
    editor.key(DOWN)
    // three narrow graphemes in, past the emoji's two cells: after the emoji and the `a` is 2 + 1 cells.
    expect(editor.cursor).toEqual({ row: 1, col: 2 })
  })

  test("landing past the end of a wrapped row stops before the wrap, which belongs to the next row", () => {
    const editor = editorWith("a漢漢b", 4, 4)
    expect(editor.visualLines().map((row) => row.text)).toEqual(["a漢", "漢b"])
    editor.key(UP)
    // the goal is cell 3, the end of the first row: its end offset would be drawn on the second row.
    expect(editor.cursorOffset).toBe(1)
    expect(editor.visualLines().findLastIndex((row) => row.start <= editor.cursorOffset)).toBe(0)
  })

  test("shift+arrows select across rows", () => {
    const editor = editorWith("abcdefgh", 4, 1)
    editor.key("\x1b[1;2B")
    expect(editor.selection).toEqual({ start: 1, end: 5 })
  })

  test("canMoveRows says where history takes over", () => {
    const editor = editorWith("abcdefgh", 4, 6)
    expect(editor.canMoveRows(-1)).toBe(true)
    expect(editor.canMoveRows(1)).toBe(false)
    editor.moveTo(2)
    expect(editor.canMoveRows(-1)).toBe(false)
    expect(editor.canMoveRows(1)).toBe(true)
    expect(createEditor().canMoveRows(-1)).toBe(false)
    expect(createEditor().canMoveRows(1)).toBe(false)
  })
})

describe("row geometry", () => {
  const chars = graphemes("ab漢cd\nxy")
  const rows = editorRows("ab漢cd\nxy", 4)

  test("a wrapped row's limit is one before its end; a line's last row may end past its text", () => {
    expect(rows.map((row) => row.text)).toEqual(["ab漢", "cd", "xy"])
    expect(rowLimit({ rows, index: 0 })).toBe(2)
    expect(rowLimit({ rows, index: 1 })).toBe(5)
    expect(rowLimit({ rows, index: 2, normal: true })).toBe(7)
  })

  test("a column picks the grapheme under that cell", () => {
    expect(offsetAtColumn({ rows, chars, index: 0, column: 2 })).toBe(2)
    expect(offsetAtColumn({ rows, chars, index: 0, column: 99 })).toBe(2)
    expect(offsetAtColumn({ rows, chars, index: 1, column: 1 })).toBe(4)
  })

  test("a count past the last row stops there and no move is undefined", () => {
    expect(stepRows({ rows, chars, at: 0, direction: 1, count: 9 })?.target).toBe(6)
    expect(stepRows({ rows, chars, at: 0, direction: -1 })).toBeUndefined()
  })
})
