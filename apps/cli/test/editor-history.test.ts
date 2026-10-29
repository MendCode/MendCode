import { describe, expect, test } from "bun:test"
import { createEditor, EDIT_HISTORY_LIMIT, type Editor } from "../src/view/editor"

function type(editor: Editor, text: string) {
  for (const char of text) editor.key(char)
}

describe("prompt undo and redo", () => {
  test("a word typed in one go is one undo step; the space starts the next step", () => {
    const editor = createEditor()
    type(editor, "hello world")
    expect(editor.undo()).toBe(true)
    expect(editor.text).toBe("hello")
    expect(editor.undo()).toBe(true)
    expect(editor.text).toBe("")
    expect(editor.undo()).toBe(false)
  })

  test("redo walks forward again and a new edit drops what was undone", () => {
    const editor = createEditor()
    type(editor, "one two")
    editor.undo()
    expect(editor.canRedo).toBe(true)
    expect(editor.redo()).toBe(true)
    expect(editor.text).toBe("one two")
    expect(editor.redo()).toBe(false)
    editor.undo()
    type(editor, "!")
    expect(editor.canRedo).toBe(false)
    expect(editor.text).toBe("one!")
  })

  test("a sequence of undo, redo, undo lands on the same states", () => {
    const editor = createEditor()
    type(editor, "a b c")
    const states = [editor.text]
    while (editor.undo()) states.push(editor.text)
    expect(states).toEqual(["a b c", "a b", "a", ""])
    while (editor.redo()) states.push(editor.text)
    expect(states.slice(4)).toEqual(["a", "a b", "a b c"])
  })

  test("the cursor comes back with the text", () => {
    const editor = createEditor()
    type(editor, "abc")
    editor.key("\x1b[D")
    editor.key("\x1b[D")
    editor.key("\x7f")
    expect(editor.text).toBe("bc")
    expect(editor.undo()).toBe(true)
    expect(editor.text).toBe("abc")
    expect(editor.cursor).toEqual({ row: 0, col: 1 })
  })

  test("moving the cursor ends a typing run, so the next characters are their own step", () => {
    const editor = createEditor()
    type(editor, "abc")
    editor.key("\x1b[D")
    type(editor, "X")
    expect(editor.text).toBe("abXc")
    editor.undo()
    expect(editor.text).toBe("abc")
  })

  test("consecutive backspaces are one step; typing after them is another", () => {
    const editor = createEditor()
    editor.insert("keep this")
    editor.key("\x7f")
    editor.key("\x7f")
    editor.key("\x7f")
    expect(editor.text).toBe("keep t")
    editor.undo()
    expect(editor.text).toBe("keep this")
  })

  test("a paste, a newline and a word delete are each their own step", () => {
    const editor = createEditor()
    type(editor, "start")
    editor.insert(" pasted block")
    editor.key("\n")
    type(editor, "second")
    editor.key("\x17")
    expect(editor.text).toBe("start pasted block\n")
    editor.undo()
    expect(editor.text).toBe("start pasted block\nsecond")
    editor.undo()
    expect(editor.text).toBe("start pasted block\n")
    editor.undo()
    expect(editor.text).toBe("start pasted block")
    editor.undo()
    expect(editor.text).toBe("start")
  })

  test("keys that change nothing leave no undo step", () => {
    const editor = createEditor()
    editor.key("\x7f")
    editor.key("\x1b[3~")
    expect(editor.canUndo).toBe(false)
    type(editor, "x")
    editor.key("\x1b[3~")
    editor.undo()
    expect(editor.text).toBe("")
    expect(editor.canUndo).toBe(false)
  })

  test("clear is undoable (ctrl+c by mistake), replaceAll is one step", () => {
    const editor = createEditor()
    editor.insert("a long prompt")
    editor.clear()
    expect(editor.isEmpty()).toBe(true)
    editor.undo()
    expect(editor.text).toBe("a long prompt")
    editor.replaceAll("from elsewhere\nsecond line")
    expect(editor.text).toBe("from elsewhere\nsecond line")
    expect(editor.cursor).toEqual({ row: 1, col: 11 })
    editor.undo()
    expect(editor.text).toBe("a long prompt")
  })

  test("graphemes survive a round trip", () => {
    const editor = createEditor()
    editor.insert("café 👩‍👩‍👧")
    type(editor, " ok")
    editor.undo()
    expect(editor.text).toBe("café 👩‍👩‍👧")
    editor.redo()
    expect(editor.text).toBe("café 👩‍👩‍👧 ok")
    editor.key("\x7f")
    editor.key("\x7f")
    editor.key("\x7f")
    editor.key("\x7f")
    expect(editor.text).toBe("café 👩‍👩‍👧".slice(0, -"👩‍👩‍👧".length))
    editor.undo()
    expect(editor.text).toBe("café 👩‍👩‍👧 ok")
  })

  test("resetHistory keeps the text but forgets every step", () => {
    const editor = createEditor()
    type(editor, "sent prompt")
    editor.resetHistory()
    expect(editor.text).toBe("sent prompt")
    expect(editor.canUndo).toBe(false)
    expect(editor.canRedo).toBe(false)
  })

  test("the history is bounded", () => {
    const editor = createEditor()
    for (let i = 0; i < EDIT_HISTORY_LIMIT + 50; i++) editor.insert("x")
    let steps = 0
    while (editor.undo()) steps++
    expect(steps).toBe(EDIT_HISTORY_LIMIT)
  })
})
