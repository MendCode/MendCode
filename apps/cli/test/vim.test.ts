import { describe, expect, test } from "bun:test"
import { createEditor } from "../src/view/editor"
import { createVim } from "../src/view/vim"

const ESC = "\x1b"

/** A composer in normal mode holding `text` with the cursor at `at` (grapheme offset). Keys the vim layer passes go to the editor, as the app does. */
function composer(text: string, at = 0) {
  const editor = createEditor()
  editor.insert(text)
  const vim = createVim(editor)
  editor.moveTo(at)
  vim.key(ESC)
  editor.moveTo(at)
  const press = (keys: string) => {
    const list = keys.split(/(<Esc>|<C-r>|<CR>)/).flatMap((part) => (part === "<Esc>" ? [ESC] : part === "<C-r>" ? ["\x12"] : part === "<CR>" ? ["\r"] : [...part]))
    for (const key of list) if (vim.key(key) === "pass") editor.key(key)
  }
  return { editor, vim, press, get text() { return editor.text }, get at() { return editor.cursorOffset } }
}

describe("vim modes", () => {
  test("a new composer is in insert mode; Esc goes to normal and steps the cursor back, i returns", () => {
    const editor = createEditor()
    const vim = createVim(editor)
    expect(vim.mode).toBe("insert")
    expect(vim.label).toBe("-- INSERT --")
    for (const key of "hello") if (vim.key(key) === "pass") editor.key(key)
    expect(editor.text).toBe("hello")
    expect(vim.key(ESC)).toBe("handled")
    expect(vim.mode).toBe("normal")
    expect(editor.cursorOffset).toBe(4)
    expect(vim.key("i")).toBe("handled")
    expect(vim.mode).toBe("insert")
    expect(vim.cursorShape).toBe("bar")
  })

  test("normal mode swallows unbound letters and lets Enter, controls and Esc through", () => {
    const { vim, text } = composer("abc")
    expect(vim.key("z")).toBe("handled")
    expect(vim.key("Q")).toBe("handled")
    expect(text).toBe("abc")
    expect(vim.key("\r")).toBe("pass")
    expect(vim.key("\x0f")).toBe("pass")
    expect(vim.key(ESC)).toBe("pass")
    expect(vim.cursorShape).toBe("block")
  })

  test("reset returns to insert and clears a half-typed command", () => {
    const c = composer("abc")
    c.press("2d")
    expect(c.vim.label).toContain("2d")
    c.vim.reset()
    expect(c.vim.mode).toBe("insert")
    expect(c.vim.pending).toBe("")
  })
})

describe("vim motions", () => {
  test("h l move within the line and stop at its ends; counts repeat", () => {
    const c = composer("abcdef", 2)
    c.press("h")
    expect(c.at).toBe(1)
    c.press("hhh")
    expect(c.at).toBe(0)
    c.press("3l")
    expect(c.at).toBe(3)
    c.press("99l")
    expect(c.at).toBe(5)
  })

  test("0 and $ reach the line ends; $ rests on the last character", () => {
    const c = composer("one two\nthree", 4)
    c.press("$")
    expect(c.at).toBe(6)
    c.press("0")
    expect(c.at).toBe(0)
  })

  test("w b e jump by word and punctuation", () => {
    const c = composer("foo.bar baz", 0)
    c.press("w")
    expect(c.at).toBe(3)
    c.press("w")
    expect(c.at).toBe(4)
    c.press("w")
    expect(c.at).toBe(8)
    c.press("b")
    expect(c.at).toBe(4)
    c.press("0e")
    expect(c.at).toBe(2)
    c.press("e")
    expect(c.at).toBe(3)
    c.press("2e")
    expect(c.at).toBe(10)
  })

  test("j k keep the column and clamp to shorter lines; gg and G jump to the ends", () => {
    const c = composer("abcdef\nab\nabcdef", 4)
    c.press("j")
    expect(c.at).toBe(8)
    c.press("j")
    expect(c.at).toBe(14)
    c.press("gg")
    expect(c.at).toBe(0)
    c.press("G")
    expect(c.at).toBe(10)
    c.press("2G")
    expect(c.at).toBe(7)
  })

  test("f and t find a character on the line", () => {
    const c = composer("a=b+c", 0)
    c.press("f+")
    expect(c.at).toBe(3)
    c.press("0t+")
    expect(c.at).toBe(2)
    c.press("0fz")
    expect(c.at).toBe(0)
  })

  test("arrow keys move as h j k l in normal mode", () => {
    const c = composer("ab\ncd", 0)
    c.vim.key("\x1b[C")
    expect(c.at).toBe(1)
    c.vim.key("\x1b[B")
    expect(c.at).toBe(4)
    c.vim.key("\x1b[D")
    c.vim.key("\x1b[A")
    expect(c.at).toBe(0)
  })
})

describe("vim operators", () => {
  test("x deletes under the cursor, with a count, and fills the register for p", () => {
    const c = composer("abcdef", 1)
    c.press("x")
    expect(c.text).toBe("acdef")
    c.press("2x")
    expect(c.text).toBe("aef")
    c.press("p")
    expect(c.text).toBe("aecdf")
  })

  test("dw deletes to the next word, d$ to the line end, d0 to its start, D like d$", () => {
    const a = composer("one two three", 4)
    a.press("dw")
    expect(a.text).toBe("one three")
    const b = composer("one two three", 4)
    b.press("d$")
    expect(b.text).toBe("one ")
    const c = composer("one two three", 4)
    c.press("d0")
    expect(c.text).toBe("two three")
    const d = composer("one two", 2)
    d.press("D")
    expect(d.text).toBe("on")
  })

  test("dw on the last word of a line does not join the next line", () => {
    const c = composer("one two\nthree", 4)
    c.press("dw")
    expect(c.text).toBe("one \nthree")
  })

  test("d2w and 2dw delete two words", () => {
    const a = composer("a b c d", 0)
    a.press("d2w")
    expect(a.text).toBe("c d")
    const b = composer("a b c d", 0)
    b.press("2dw")
    expect(b.text).toBe("c d")
  })

  test("dd deletes the line (last line takes the newline before it); counts delete several; cursor lands on the first nonblank", () => {
    const a = composer("one\ntwo\nthree", 5)
    a.press("dd")
    expect(a.text).toBe("one\nthree")
    expect(a.at).toBe(4)
    const b = composer("one\ntwo\nthree", 9)
    b.press("dd")
    expect(b.text).toBe("one\ntwo")
    expect(b.at).toBe(4)
    const c = composer("one\n  two\nthree\nfour", 0)
    c.press("2dd")
    expect(c.text).toBe("three\nfour")
    const d = composer("only")
    d.press("dd")
    expect(d.text).toBe("")
  })

  test("dj and dk delete both lines; dG and dgg reach the buffer ends", () => {
    const a = composer("a\nb\nc\nd", 2)
    a.press("dj")
    expect(a.text).toBe("a\nd")
    const b = composer("a\nb\nc\nd", 2)
    b.press("dG")
    expect(b.text).toBe("a")
    const c = composer("a\nb\nc\nd", 4)
    c.press("dgg")
    expect(c.text).toBe("d")
  })

  test("cw changes the word without eating the space; cc clears the line; C changes to the end", () => {
    const a = composer("one two three", 4)
    a.press("cwTWO<Esc>")
    expect(a.text).toBe("one TWO three")
    expect(a.vim.mode).toBe("normal")
    const b = composer("one\ntwo\nthree", 5)
    b.press("ccX<Esc>")
    expect(b.text).toBe("one\nX\nthree")
    const c = composer("one two", 4)
    c.press("Cx<Esc>")
    expect(c.text).toBe("one x")
  })

  test("yy and p paste a line below, P above; yw and P paste text before the cursor", () => {
    const a = composer("one\ntwo", 0)
    a.press("yyp")
    expect(a.text).toBe("one\none\ntwo")
    expect(a.at).toBe(4)
    const b = composer("one\ntwo", 4)
    b.press("yyP")
    expect(b.text).toBe("one\ntwo\ntwo")
    const c = composer("foo bar", 0)
    c.press("ywP")
    expect(c.text).toBe("foo foo bar")
    const d = composer("ab", 0)
    d.press("yl$p")
    expect(d.text).toBe("aba")
    const e = composer("x", 0)
    e.press("3yyp")
    expect(e.text).toBe("x\nx")
  })

  test("diw, daw and ciw act on the word under the cursor", () => {
    const a = composer("one two three", 5)
    a.press("diw")
    expect(a.text).toBe("one  three")
    const b = composer("one two three", 5)
    b.press("daw")
    expect(b.text).toBe("one three")
    const c = composer("one two three", 5)
    c.press("ciwX<Esc>")
    expect(c.text).toBe("one X three")
  })

  test("r replaces characters and leaves the mode alone", () => {
    const c = composer("abcd", 1)
    c.press("rX")
    expect(c.text).toBe("aXcd")
    c.press("l2rZ")
    expect(c.text).toBe("aXZZ")
    expect(c.vim.mode).toBe("normal")
  })
})

describe("vim insert commands", () => {
  test("i a I A insert at the cursor, after it, at the first nonblank and at the end", () => {
    const i = composer("bc", 0)
    i.press("ia<Esc>")
    expect(i.text).toBe("abc")
    const a = composer("ac", 0)
    a.press("ab<Esc>")
    expect(a.text).toBe("abc")
    const big = composer("  bc", 3)
    big.press("Ia<Esc>")
    expect(big.text).toBe("  abc")
    const end = composer("ab", 0)
    end.press("Ac<Esc>")
    expect(end.text).toBe("abc")
  })

  test("o and O open a line below and above", () => {
    const a = composer("one\nthree", 0)
    a.press("otwo<Esc>")
    expect(a.text).toBe("one\ntwo\nthree")
    const b = composer("two\nthree", 0)
    b.press("Oone<Esc>")
    expect(b.text).toBe("one\ntwo\nthree")
  })

  test("a count repeats the inserted text", () => {
    const c = composer("", 0)
    c.press("3ihi <Esc>")
    expect(c.text).toBe("hi hi hi ")
  })
})

describe("vim undo, redo and dot", () => {
  test("u undoes a change and ctrl-r redoes it", () => {
    const c = composer("one two", 0)
    c.press("dw")
    expect(c.text).toBe("two")
    c.press("u")
    expect(c.text).toBe("one two")
    c.press("<C-r>")
    expect(c.text).toBe("two")
    c.press("u")
    expect(c.text).toBe("one two")
  })

  test(". repeats the last change: delete, change with its typed text, and an insert", () => {
    const a = composer("a b c d", 0)
    a.press("dw.")
    expect(a.text).toBe("c d")
    const b = composer("foo bar baz", 0)
    b.press("cwxy<Esc>w.")
    expect(b.text).toBe("xy xy baz")
    const c = composer("a\nb", 0)
    c.press("Ax<Esc>j.")
    expect(c.text).toBe("ax\nbx")
    const d = composer("aaaa", 0)
    d.press("x..")
    expect(d.text).toBe("a")
  })
})

describe("vim visual mode", () => {
  test("v selects characters as the cursor moves; the selection includes the character under it", () => {
    const c = composer("hello world", 0)
    c.press("vll")
    expect(c.vim.mode).toBe("visual")
    expect(c.editor.selectedText).toBe("hel")
    c.press("h")
    expect(c.editor.selectedText).toBe("he")
  })

  test("d deletes the selection, y yanks it and p pastes", () => {
    const a = composer("hello world", 0)
    a.press("vwd")
    expect(a.text).toBe("orld")
    expect(a.vim.mode).toBe("normal")
    const b = composer("hello world", 0)
    b.press("vey$p")
    expect(b.text).toBe("hello worldhello")
  })

  test("a selection made backwards covers both ends", () => {
    const c = composer("abcdef", 3)
    c.press("vhhd")
    expect(c.text).toBe("aef")
  })

  test("V selects whole lines for d and y; Esc leaves visual with the cursor in place", () => {
    const a = composer("one\ntwo\nthree", 1)
    a.press("Vjd")
    expect(a.text).toBe("three")
    const b = composer("one\ntwo", 1)
    b.press("Vy<Esc>")
    expect(b.vim.mode).toBe("normal")
    b.press("jp")
    expect(b.text).toBe("one\ntwo\none")
    const c = composer("abc", 0)
    c.press("vl<Esc>")
    expect(c.vim.mode).toBe("normal")
    expect(c.editor.selection).toBeUndefined()
  })

  test("c changes the selection and enters insert mode; o swaps the ends", () => {
    const a = composer("one two", 0)
    a.press("vecX<Esc>")
    expect(a.text).toBe("X two")
    const b = composer("abcdef", 1)
    b.press("vlo")
    expect(b.editor.selectedText).toBe("bc")
    b.press("d")
    expect(b.text).toBe("adef")
  })
})

describe("vim j and k follow the drawn rows", () => {
  test("a wrapped line is several rows, the goal column is kept in cells and a count stops at the edge", () => {
    const a = composer("abcdefghijkl\nxy", 1)
    a.editor.setVisualWidth(4)
    a.press("j")
    expect(a.at).toBe(5)
    a.press("j")
    expect(a.at).toBe(9)
    a.press("j")
    // The line "xy" is shorter: the cursor rests on its last character and the goal column is kept for the way back.
    expect(a.at).toBe(14)
    a.press("k")
    expect(a.at).toBe(9)
    a.press("5k")
    expect(a.at).toBe(1)
    a.press("k")
    expect(a.at).toBe(1)
  })

  test("visual mode extends by rows and dj still deletes whole lines", () => {
    const a = composer("abcdefgh\nxy", 1)
    a.editor.setVisualWidth(4)
    a.press("vj")
    expect(a.editor.selectedText).toBe("bcdef")
    const b = composer("abcdefgh\nxy\nlast", 1)
    b.editor.setVisualWidth(4)
    b.press("dj")
    expect(b.text).toBe("last")
  })
})
