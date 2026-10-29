import { describe, expect, test } from "bun:test"
import { createEditor, editorRows, tokenSpans } from "../src/view/editor"
import { createVim } from "../src/view/vim"
import { textWidth } from "../src/view/wrap"

/** An editor whose text may hold the tokens in `labels`, with `text` typed in and the cursor at its end. */
function tokened(text: string, labels: string[] = ["[Image #1]", "[Image #2]", "[PDF spec.pdf]", "[codeconfig/]"], options: { wordWrap?: boolean } = {}) {
  const editor = createEditor({ ...options, tokens: () => labels })
  editor.insert(text)
  editor.resetHistory()
  return editor
}

const LEFT = "\x1b[D"
const RIGHT = "\x1b[C"
const BACKSPACE = "\x7f"
const DELETE = "\x1b[3~"
const SHIFT_LEFT = "\x1b[1;2D"
const SHIFT_RIGHT = "\x1b[1;2C"
const WORD_BACK = "\x1bb"
const WORD_FORWARD = "\x1bf"
const KILL_WORD_BACK = "\x17"

describe("tokenSpans", () => {
  test("every place a label stands, as grapheme ranges, in order", () => {
    expect(tokenSpans("a [Image #1] b [Image #2]", ["[Image #2]", "[Image #1]"])).toEqual([{ start: 2, end: 12 }, { start: 15, end: 25 }])
  })

  test("graphemes, not UTF-16 units: an emoji before the token counts as one", () => {
    expect(tokenSpans("👍🏽 [Image #1]", ["[Image #1]"])).toEqual([{ start: 2, end: 12 }])
  })

  test("no labels, no text or a label that is not there are no tokens", () => {
    expect(tokenSpans("text", [])).toEqual([])
    expect(tokenSpans("", ["[Image #1]"])).toEqual([])
    expect(tokenSpans("[Image #3]", ["[Image #1]"])).toEqual([])
  })

  test("a label cut in half is no token", () => {
    expect(tokenSpans("[Image #", ["[Image #1]"])).toEqual([])
  })
})

describe("inserting a token", () => {
  test("a space goes before it after a word and after it at the end, for what comes next", () => {
    const editor = tokened("configura de")
    editor.insertToken("[Image #1]")
    expect(editor.text).toBe("configura de [Image #1] ")
    expect(editor.cursorOffset).toBe(editor.text.length)
  })

  test("in the middle of a word it adds the spaces it needs on both sides, and only those", () => {
    const editor = tokened("configura")
    editor.moveTo(3)
    editor.insertToken("[Image #1]")
    expect(editor.text).toBe("con [Image #1] figura")
  })

  test("after a space no second one, before a space no second one", () => {
    const editor = tokened("a  b")
    editor.moveTo(2)
    editor.insertToken("[Image #1]")
    expect(editor.text).toBe("a [Image #1] b")
  })

  test("at the start of a line and before a line break no space is added", () => {
    const editor = tokened("uno\ndos")
    editor.moveTo(4)
    editor.insertToken("[Image #1]")
    expect(editor.text).toBe("uno\n[Image #1] dos")
    const end = tokened("uno\ndos")
    end.moveTo(3)
    end.insertToken("[Image #2]")
    expect(end.text).toBe("uno [Image #2]\ndos")
  })

  test("several in a row are separated by one space each and are two tokens", () => {
    const editor = tokened("")
    editor.insertToken("[Image #1]")
    editor.insertToken("[Image #2]")
    editor.insertToken("[codeconfig/]")
    expect(editor.text).toBe("[Image #1] [Image #2] [codeconfig/] ")
    expect(editor.tokens).toHaveLength(3)
  })

  test("replaces a selection, and is one undo step", () => {
    const editor = tokened("hola mundo")
    editor.select(5, 10)
    editor.insertToken("[Image #1]")
    expect(editor.text).toBe("hola [Image #1] ")
    expect(editor.undo()).toBe(true)
    expect(editor.text).toBe("hola mundo")
  })
})

describe("one character", () => {
  test("left and right step over the whole token", () => {
    const editor = tokened("ab [Image #1] cd")
    editor.moveTo(13)
    editor.key(LEFT)
    expect(editor.cursorOffset).toBe(3)
    editor.key(LEFT)
    expect(editor.cursorOffset).toBe(2)
    editor.key(RIGHT)
    expect(editor.cursorOffset).toBe(3)
    editor.key(RIGHT)
    expect(editor.cursorOffset).toBe(13)
  })

  test("backspace after a token takes all of it; delete before it takes all of it", () => {
    const back = tokened("ab [Image #1]")
    back.key(BACKSPACE)
    expect(back.text).toBe("ab ")
    const forward = tokened("ab [Image #1] cd")
    forward.moveTo(3)
    forward.key(DELETE)
    expect(forward.text).toBe("ab  cd")
  })

  test("backspace on the space after a token takes only the space", () => {
    const editor = tokened("[Image #1] x")
    editor.moveTo(11)
    editor.key(BACKSPACE)
    expect(editor.text).toBe("[Image #1]x")
    expect(editor.tokens).toHaveLength(1)
  })

  test("the cursor never rests inside it, however it is put there", () => {
    const editor = tokened("ab [Image #1] cd")
    editor.moveTo(8)
    expect([3, 13]).toContain(editor.cursorOffset)
    editor.moveTo(0)
    editor.moveTo(5)
    expect(editor.cursorOffset).toBe(13)
    editor.moveTo(13)
    editor.moveTo(10)
    expect(editor.cursorOffset).toBe(3)
  })

  test("text typed with the cursor in a token lands after it, never inside", () => {
    const editor = tokened("[Image #1]")
    editor.moveTo(4)
    editor.insert("x")
    expect(editor.text.replace("x", "")).toBe("[Image #1]")
    expect(editor.tokens).toHaveLength(1)
  })

  test("a token cannot be half-edited: a range that touches it takes it whole", () => {
    const editor = tokened("ab [Image #1] cd")
    editor.replaceRange(5, 7, "")
    expect(editor.text).toBe("ab  cd")
    const insert = tokened("ab [Image #1] cd")
    insert.replaceRange(6, 6, "X")
    expect(insert.text).toBe("ab [Image #1]X cd")
  })

  test("a selection that ends inside it is made whole", () => {
    const editor = tokened("ab [Image #1] cd")
    editor.select(0, 7)
    expect(editor.selection).toEqual({ start: 0, end: 13 })
    editor.key(BACKSPACE)
    expect(editor.text).toBe(" cd")
  })

  test("shift+arrow selects the token in one step, and the selection deletes it", () => {
    const editor = tokened("ab [Image #1]")
    editor.key(SHIFT_LEFT)
    expect(editor.selectedText).toBe("[Image #1]")
    editor.key(BACKSPACE)
    expect(editor.text).toBe("ab ")
    const right = tokened("[Image #1] ab")
    right.moveTo(0)
    right.key(SHIFT_RIGHT)
    expect(right.selectedText).toBe("[Image #1]")
  })

  test("two tokens are two characters", () => {
    const editor = tokened("[Image #1] [Image #2]")
    editor.key(BACKSPACE)
    expect(editor.text).toBe("[Image #1] ")
    expect(editor.tokens).toHaveLength(1)
  })

  test("a deleted token goes with its attachment: its label is no token once the text lacks it", () => {
    const editor = tokened("a [Image #1] b")
    expect(editor.tokens).toHaveLength(1)
    editor.moveTo(12)
    editor.key(BACKSPACE)
    editor.key(BACKSPACE)
    expect(editor.text).toBe("a b")
    expect(editor.tokens).toHaveLength(0)
  })
})

describe("words", () => {
  test("a word motion steps over a token whole, spaces inside it included", () => {
    const editor = tokened("uno [Image #1] dos")
    editor.moveTo(4)
    editor.key(WORD_FORWARD)
    expect(editor.cursorOffset).toBe(15)
    editor.key(WORD_BACK)
    expect(editor.cursorOffset).toBe(4)
  })

  test("backward from after the token goes to its start", () => {
    const editor = tokened("uno [Image #1]")
    editor.key(WORD_BACK)
    expect(editor.cursorOffset).toBe(4)
  })

  test("delete word backward takes the token and not half of it", () => {
    const editor = tokened("uno [Image #1]")
    editor.key(KILL_WORD_BACK)
    expect(editor.text).toBe("uno ")
  })

  test("a kill of a token can be yanked back whole", () => {
    const editor = tokened("uno [Image #1]")
    editor.key(KILL_WORD_BACK)
    editor.key("\x1by")
    expect(editor.text).toBe("uno [Image #1]")
    expect(editor.tokens).toHaveLength(1)
  })
})

describe("undo and redo", () => {
  test("deleting a token and undoing brings it back with the cursor outside it", () => {
    const editor = tokened("a [Image #1] b")
    editor.moveTo(12)
    editor.key(BACKSPACE)
    expect(editor.text).toBe("a  b")
    expect(editor.undo()).toBe(true)
    expect(editor.text).toBe("a [Image #1] b")
    expect(editor.tokens).toEqual([{ start: 2, end: 12 }])
    expect([2, 12]).toContain(editor.cursorOffset)
    expect(editor.redo()).toBe(true)
    expect(editor.text).toBe("a  b")
  })

  test("inserting a token is one step to undo and redo", () => {
    const editor = tokened("hola")
    editor.insertToken("[Image #1]")
    expect(editor.undo()).toBe(true)
    expect(editor.text).toBe("hola")
    expect(editor.redo()).toBe(true)
    expect(editor.text).toBe("hola [Image #1] ")
  })
})

describe("multi-line prompts", () => {
  test("a token on the second line, ↑ and ↓ land beside it and never inside", () => {
    const editor = tokened("primera linea larga\nsegunda [Image #1] fin")
    editor.setVisualWidth(80)
    for (let column = 0; column < 30; column++) {
      editor.moveTo(column)
      editor.key("\x1b[B")
      const at = editor.cursorOffset
      expect(editor.tokens.some((span) => span.start < at && at < span.end)).toBe(false)
    }
  })

  test("a token that ends a line, then a new line: backspace at the line start joins the lines without touching it", () => {
    const editor = tokened("[Image #1]\nx")
    editor.moveTo(11)
    editor.key(BACKSPACE)
    expect(editor.text).toBe("[Image #1]x")
    expect(editor.tokens).toHaveLength(1)
  })
})

describe("wrapping", () => {
  const rows = (text: string, width: number, wordWrap = false) => editorRows(text, width, wordWrap, tokenSpans(text, ["[Image #1]", "[Image #2]", "[PDF spec.pdf]"])).map((row) => row.text)

  test("a token that does not fit on the row moves whole to the next one", () => {
    expect(rows("un texto largo [Image #1] fin", 20)).toEqual(["un texto largo ", "[Image #1] fin"])
    expect(rows("un texto largo [Image #1] fin", 20, true)).toEqual(["un texto largo ", "[Image #1] fin"])
  })

  test("at sixty columns a sentence with three tokens never breaks one", () => {
    const text = "configura mi mend de mi pc que tenga un package de seda 9.7 de [Image #1] [Image #2] y luego [PDF spec.pdf] fin"
    for (const wordWrap of [false, true]) {
      const lines = rows(text, 60, wordWrap)
      for (const label of ["[Image #1]", "[Image #2]", "[PDF spec.pdf]"]) expect(lines.some((line) => line.includes(label))).toBe(true)
      for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(60)
      expect(lines.join("")).toBe(text)
    }
  })

  test("a token wider than the row has to break, and no text is lost", () => {
    const lines = rows("[PDF spec.pdf]", 8)
    expect(lines.join("")).toBe("[PDF spec.pdf]")
    expect(lines.every((line) => textWidth(line) <= 8)).toBe(true)
  })

  test("wide characters before and after a token keep their cells", () => {
    const text = "漢字漢字 [Image #1] 漢字"
    const lines = rows(text, 14)
    expect(lines.join("")).toBe(text)
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(14)
    expect(lines.some((line) => line.includes("[Image #1]"))).toBe(true)
  })

  test("the editor's own rows use its tokens", () => {
    const editor = tokened("un texto largo [Image #1] fin")
    editor.setVisualWidth(20)
    expect(editor.visualLines().map((row) => row.text)).toEqual(["un texto largo ", "[Image #1] fin"])
  })
})

describe("vim", () => {
  function composer(text: string, at: number) {
    const editor = tokened(text)
    const vim = createVim(editor)
    editor.moveTo(at)
    vim.key("\x1b")
    editor.moveTo(at)
    const press = (keys: string) => {
      for (const key of keys) if (vim.key(key) === "pass") editor.key(key)
    }
    return { editor, press }
  }

  test("x on a token deletes the whole token", () => {
    const { editor, press } = composer("ab [Image #1] cd", 3)
    press("x")
    expect(editor.text).toBe("ab  cd")
  })

  test("l and h step over it", () => {
    const { editor, press } = composer("ab [Image #1] cd", 2)
    press("l")
    expect(editor.cursorOffset).toBe(3)
    press("l")
    expect(editor.cursorOffset).toBe(13)
    press("h")
    expect(editor.cursorOffset).toBe(3)
  })

  test("dw takes the token as one word, with the space after it", () => {
    const line = composer("uno [Image #1] dos", 4)
    line.press("dw")
    expect(line.editor.text).toBe("uno dos")
  })
})

describe("speed", () => {
  test("typing in a prompt holding twenty tokens stays far inside a frame", () => {
    const labels = Array.from({ length: 20 }, (_, index) => `[Image #${index + 1}]`)
    const editor = tokened(labels.map((label) => `word ${label}`).join(" "), labels)
    editor.setVisualWidth(80)
    const started = performance.now()
    for (let count = 0; count < 200; count++) {
      editor.key("x")
      editor.visualLines()
      editor.key(LEFT)
      editor.key(RIGHT)
    }
    expect((performance.now() - started) / 200).toBeLessThan(2)
  })
})
