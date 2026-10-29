import { afterEach, describe, expect, test } from "bun:test"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { appHarness, cleanTemps, ids, tempDir, type Harness } from "./session-ui-harness"

afterEach(cleanTemps)

const UP = "\x1b[A"
const DOWN = "\x1b[B"
const NEWLINE = "\x1b\r"
const ESC = "\x1b"

/** A terminal whose project history holds `entries`, newest first. */
async function terminal(entries: string[], options: { vim?: boolean; width?: number; height?: number; preset?: "box" | "top-bottom" | "minimal" | "ascii-box"; mode?: "minimal" } = {}) {
  const dataDir = tempDir()
  if (options.vim || options.preset) writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...(options.vim ? { vimMode: true } : {}), ...(options.preset ? { promptChrome: options.preset } : {}) })
  const h = appHarness({
    dataDir,
    ...(options.mode ? { mode: options.mode } : {}),
    directory: "/repo",
    width: options.width ?? 60,
    height: options.height ?? 24,
    reply: (command) => command.type === "prompt.history" ? { ok: true, result: { prompts: entries, entries: entries.map((text) => ({ text, kind: "sent" })) } } : undefined,
  })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  return h
}

const editor = (h: Harness) => h.app.editor
const lastCursor = (h: Harness) => h.cursors.at(-1)!

describe("↑ and ↓ move inside the prompt before they touch the history", () => {
  test("a multi-line prompt: ↑ walks its rows, only the first row recalls, and ↓ brings the typed text back with its cursor", async () => {
    const h = await terminal(["old message"])
    await h.type(`one${NEWLINE}two${NEWLINE}three`)
    await h.type(UP)
    expect(editor(h).text).toBe("one\ntwo\nthree")
    expect(editor(h).cursor).toEqual({ row: 1, col: 3 })
    await h.type(UP)
    expect(editor(h).text).toBe("one\ntwo\nthree")
    expect(editor(h).cursor).toEqual({ row: 0, col: 3 })
    await h.type("\x1b[D")
    await h.type(UP)
    expect(editor(h).text).toBe("old message")
    await h.type(DOWN)
    expect(editor(h).text).toBe("one\ntwo\nthree")
    expect(editor(h).cursorOffset).toBe(2)
  })

  test("↓ moves down through the rows and does nothing at the last one while no history is being browsed", async () => {
    const h = await terminal(["old message"])
    await h.type(`one${NEWLINE}two${NEWLINE}three`)
    editor(h).moveTo(1)
    await h.type(DOWN)
    await h.type(DOWN)
    expect(editor(h).cursor).toEqual({ row: 2, col: 1 })
    await h.type(DOWN)
    expect(editor(h).text).toBe("one\ntwo\nthree")
    expect(editor(h).cursor).toEqual({ row: 2, col: 1 })
  })

  test("a long line that wraps counts as several rows: ↑ in the middle moves the cursor up one drawn row", async () => {
    const h = await terminal(["old message"])
    const text = Array.from({ length: 30 }, (_, i) => `w${String(i).padStart(2, "0")}`).join(" ")
    await h.type(text)
    const rows = editor(h).visualLines()
    expect(rows.length).toBeGreaterThan(2)
    const drawnRow = lastCursor(h).row
    const column = lastCursor(h).col
    await h.type(UP)
    expect(editor(h).text).toBe(text)
    expect(lastCursor(h).row).toBe(drawnRow - 1)
    // The goal column stays: the cursor is drawn one row up, as far right as before, unless that row is shorter.
    expect(lastCursor(h).col).toBeLessThanOrEqual(column)
    for (let i = 0; i < rows.length - 2; i++) await h.type(UP)
    expect(editor(h).text).toBe(text)
    expect(lastCursor(h).row).toBe(drawnRow - (rows.length - 1))
    await h.type(UP)
    expect(editor(h).text).toBe("old message")
    await h.type(DOWN)
    expect(editor(h).text).toBe(text)
  })

  test("an empty prompt recalls with ↑ and returns with ↓ as before", async () => {
    const h = await terminal(["newest", "older"])
    await h.type(UP)
    expect(editor(h).text).toBe("newest")
    await h.type(UP)
    expect(editor(h).text).toBe("older")
    await h.type(DOWN)
    expect(editor(h).text).toBe("newest")
    await h.type(DOWN)
    expect(editor(h).text).toBe("")
  })

  test("a recalled multi-line entry arrives with the cursor at its end: ↑ walks its rows, then goes to the older entry, and ↓ mirrors it", async () => {
    const h = await terminal(["l1\nl2\nl3", "older"])
    await h.type(UP)
    expect(editor(h).text).toBe("l1\nl2\nl3")
    expect(editor(h).cursor).toEqual({ row: 2, col: 2 })
    await h.type(UP)
    await h.type(UP)
    expect(editor(h).text).toBe("l1\nl2\nl3")
    expect(editor(h).cursor.row).toBe(0)
    await h.type(UP)
    expect(editor(h).text).toBe("older")
    expect(editor(h).cursorOffset).toBe(5)
    await h.type(DOWN)
    expect(editor(h).text).toBe("l1\nl2\nl3")
    expect(editor(h).cursorOffset).toBe(8)
    await h.type(UP)
    await h.type(DOWN)
    expect(editor(h).text).toBe("l1\nl2\nl3")
    await h.type(DOWN)
    expect(editor(h).text).toBe("")
  })

  test("the text being typed survives browsing untouched, cursor included", async () => {
    const h = await terminal(["alpha", "beta"])
    await h.type("draft in progress")
    editor(h).moveTo(5)
    await h.type(UP)
    expect(editor(h).text).toBe("alpha")
    await h.type(UP)
    expect(editor(h).text).toBe("beta")
    await h.type(DOWN)
    await h.type(DOWN)
    expect(editor(h).text).toBe("draft in progress")
    expect(editor(h).cursorOffset).toBe(5)
  })

  test("moving the cursor inside a recalled entry keeps browsing; editing it makes it the text being typed", async () => {
    const h = await terminal(["alpha\nbeta", "older"])
    await h.type(UP)
    await h.type("\x1b[D")
    await h.type("\x1b[D")
    await h.type(UP)
    await h.type(UP)
    expect(editor(h).text).toBe("older")
    await h.type(DOWN)
    expect(editor(h).text).toBe("alpha\nbeta")
    await h.type("!")
    expect(editor(h).text).toBe("alpha\nbeta!")
    // No more history from here: ↓ on the last row stays put and ↑ walks the rows of the edited text first.
    await h.type(DOWN)
    expect(editor(h).text).toBe("alpha\nbeta!")
    await h.type(UP)
    expect(editor(h).cursor.row).toBe(0)
    expect(editor(h).text).toBe("alpha\nbeta!")
  })

  test("a typed prefix stays: after an edit the first row's ↑ starts the history again and ↓ returns the edited text", async () => {
    const h = await terminal(["alpha", "beta"])
    await h.type(UP)
    await h.type("?")
    await h.type(UP)
    expect(editor(h).text).toBe("alpha")
    await h.type(DOWN)
    expect(editor(h).text).toBe("alpha?")
  })

  test("the slash menu keeps ↑/↓ while it is open", async () => {
    const h = await terminal(["old message"])
    await h.type("/")
    await h.type(DOWN)
    await h.type(DOWN)
    await h.type(UP)
    expect(editor(h).text).toBe("/")
    await h.type(UP)
    await h.type(UP)
    expect(editor(h).text).toBe("/")
    expect(h.sent.filter((command) => command.type === "prompt.history")).toEqual([])
  })

  test("a pending approval keeps ↑/↓ for its choices", async () => {
    const h = await terminal(["old message"])
    const sessionId = h.sessionId
    const turnId = ids("turn")
    const ev = (seq: number, patch: Record<string, unknown>) => h.app.onEvent({ sessionId, seq, at: 1, ...patch } as never)
    ev(1, { type: "turn.started", turnId, queueId: ids("queue") })
    ev(2, { type: "server.request", requestId: ids("request"), turnId, kind: "approval", title: "Run command", detail: "git status -s", tool: "shell", permission: "execute", permissionContext: { name: "bash", patterns: ["git status -s"], always: ["git status -s"] } })
    h.app.render()
    await h.type(DOWN)
    await h.type(UP)
    await h.type(UP)
    expect(editor(h).text).toBe("")
    expect(h.sent.filter((command) => command.type === "prompt.history")).toEqual([])
  })
})

describe("history from any row", () => {
  test("alt+p and alt+n walk the history whatever row the cursor is on, and the typed text comes back", async () => {
    const h = await terminal(["newest", "older"])
    await h.type(`one${NEWLINE}two${NEWLINE}three`)
    await h.type(UP)
    expect(editor(h).cursor.row).toBe(1)
    await h.type("\x1bp")
    expect(editor(h).text).toBe("newest")
    await h.type("\x1bp")
    expect(editor(h).text).toBe("older")
    await h.type("\x1bn")
    expect(editor(h).text).toBe("newest")
    await h.type("\x1bn")
    expect(editor(h).text).toBe("one\ntwo\nthree")
    expect(editor(h).cursor).toEqual({ row: 1, col: 3 })
    await h.type("\x1bn")
    expect(editor(h).text).toBe("one\ntwo\nthree")
  })

  test("the shortcut overlay names the new behaviour and the keys", async () => {
    const h = await terminal(["newest"])
    await h.type("?")
    const shown = h.text().join("\n")
    expect(shown).toContain("move; earlier prompts at the ends")
    expect(shown).toContain("alt+p")
  })
})

const press = (col: number, row: number, code = 0) => `\x1b[<${code};${col + 1};${row + 1}M`
const drag = (col: number, row: number) => `\x1b[<32;${col + 1};${row + 1}M`
const release = (col: number, row: number, code = 0) => `\x1b[<${code};${col + 1};${row + 1}m`
const SHIFT = 4
const osc52 = (h: Harness) => h.written.filter((data) => data.startsWith("\x1b]52;c;")).map((data) => Buffer.from(data.slice(7, -1), "base64").toString("utf8"))
const rowOf = (h: Harness, needle: string) => h.text().findIndex((row) => row.includes(needle))
/** A click: press and release on the same cell, then a frame. */
async function click(h: Harness, col: number, row: number, code = 0) {
  await h.app.onKey(press(col, row, code))
  await h.app.onKey(release(col, row, code))
  h.app.render()
}

describe("a click in the prompt places the text cursor", () => {
  test("it lands before the clicked character, is drawn there, and copies nothing", async () => {
    const h = await terminal([])
    await h.type("abcdef ghijkl")
    const row = rowOf(h, "abcdef")
    const start = h.text()[row]!.indexOf("abcdef")
    await click(h, start + 2, row)
    expect(editor(h).cursorOffset).toBe(2)
    expect(lastCursor(h)).toEqual({ row, col: start + 2 })
    expect(osc52(h)).toEqual([])
    expect(h.frames.at(-1)!.flat().some((span) => span.bg === "primary" && span.fg === "background")).toBe(false)
    await h.type("X")
    expect(editor(h).text).toBe("abXcdef ghijkl")
  })

  for (const [name, options] of [["rules", { preset: "top-bottom" }], ["box", { preset: "box" }], ["ascii box", { preset: "ascii-box" }], ["tinted", { preset: "minimal" }], ["minimal view", { mode: "minimal" }]] as const) {
    test(`the prompt's chrome does not shift the click (${name}), at 80x24 and 120x40`, async () => {
      for (const [width, height] of [[80, 24], [120, 40]] as const) {
        const h = await terminal([], { ...options, width, height })
        await h.type(`abcdef${NEWLINE}漢字ghi`)
        const first = rowOf(h, "abcdef")
        const start = h.text()[first]!.indexOf("abcdef")
        await click(h, start + 4, first)
        expect(editor(h).cursor).toEqual({ row: 0, col: 4 })
        expect(lastCursor(h)).toEqual({ row: first, col: start + 4 })
        await click(h, start + 4, first + 1)
        expect(editor(h).cursor).toEqual({ row: 1, col: 2 })
        expect(lastCursor(h)).toEqual({ row: first + 1, col: start + 4 })
      }
    })
  }

  test("a press alone already moves the cursor and nothing is selected until the mouse is dragged", async () => {
    const h = await terminal([])
    await h.type("abcdef")
    const row = rowOf(h, "abcdef")
    const start = h.text()[row]!.indexOf("abcdef")
    await h.app.onKey(press(start + 3, row))
    expect(editor(h).cursorOffset).toBe(3)
    h.app.render()
    expect(h.frames.at(-1)!.flat().some((span) => span.bg === "primary" && span.fg === "background")).toBe(false)
    await h.app.onKey(release(start + 3, row))
    expect(osc52(h)).toEqual([])
  })

  test("over the margin and the lead glyph it goes to the start of the row, past the text to the end of it", async () => {
    const h = await terminal([])
    await h.type(`first${NEWLINE}second line`)
    const first = rowOf(h, "first")
    const start = h.text()[first]!.indexOf("first")
    await click(h, 0, first + 1)
    expect(editor(h).cursor).toEqual({ row: 1, col: 0 })
    await click(h, start - 1, first)
    expect(editor(h).cursor).toEqual({ row: 0, col: 0 })
    await click(h, 55, first)
    expect(editor(h).cursor).toEqual({ row: 0, col: 5 })
    await click(h, 55, first + 1)
    expect(editor(h).cursor).toEqual({ row: 1, col: 11 })
  })

  test("a wrapped line's rows are separate click targets", async () => {
    const h = await terminal([])
    const text = Array.from({ length: 30 }, (_, i) => `w${String(i).padStart(2, "0")}`).join(" ")
    await h.type(text)
    const rows = editor(h).visualLines()
    expect(rows.length).toBeGreaterThan(2)
    const last = lastCursor(h).row
    const start = h.text()[last]!.indexOf(rows.at(-1)!.text.slice(0, 3))
    expect(start).toBeGreaterThan(-1)
    // Second row from the end, fourth character.
    await click(h, start + 3, last - 1)
    expect(editor(h).cursorOffset).toBe(rows.at(-2)!.start + 3)
    expect(lastCursor(h)).toEqual({ row: last - 1, col: start + 3 })
    // First row, clicking far to the right stops before the wrap (the wrapped character is drawn on the next row).
    await click(h, 55, last - (rows.length - 1))
    expect(editor(h).visualLines().findLastIndex((row) => row.start <= editor(h).cursorOffset)).toBe(0)
    expect(editor(h).cursorOffset).toBe(rows[0]!.end - 1)
  })

  test("wide characters take two cells: either half puts the cursor before it", async () => {
    const h = await terminal([])
    await h.type("ab漢字cd")
    const row = rowOf(h, "ab")
    const start = h.text()[row]!.indexOf("ab")
    // a b | 漢 (2-3) | 字 (4-5) | c d
    await click(h, start + 2, row)
    expect(editor(h).cursorOffset).toBe(2)
    await click(h, start + 3, row)
    expect(editor(h).cursorOffset).toBe(2)
    await click(h, start + 4, row)
    expect(editor(h).cursorOffset).toBe(3)
    expect(lastCursor(h).col).toBe(start + 4)
    await click(h, start + 5, row)
    expect(editor(h).cursorOffset).toBe(3)
    await click(h, start + 6, row)
    expect(editor(h).cursorOffset).toBe(4)
    expect(lastCursor(h).col).toBe(start + 6)
  })

  test("a press on the border under the text puts the cursor at the end of the text", async () => {
    const h = await terminal([])
    await h.type(`one${NEWLINE}two${NEWLINE}three`)
    await click(h, 0, rowOf(h, "one"))
    expect(editor(h).cursorOffset).toBe(0)
    const below = rowOf(h, "three") + 1
    await click(h, 10, below)
    expect(editor(h).cursorOffset).toBe(editor(h).text.length)
    expect(osc52(h)).toEqual([])
  })

  test("a scrolled prompt and an attachment chip above it do not shift the click", async () => {
    const dataDir = tempDir()
    const h = appHarness({
      dataDir, directory: "/repo", width: 60, height: 16,
      reply: (command) => command.type === "attachment.clipboard" ? { ok: true, result: { attachment: { sha256: "a".repeat(64), bytes: 2048, mime: "image/png" }, name: "clipboard.png" } } : undefined,
    })
    h.app.applySettings({ onboarded: true })
    await Bun.sleep(10)
    await h.type("\x16")
    expect(h.text().some((row) => row.includes("[Image #1"))).toBe(true)
    const lines = Array.from({ length: 12 }, (_, i) => `row${String(i).padStart(2, "0")}`)
    await h.type(lines.join(NEWLINE))
    // More rows than the prompt shows: the first ones are scrolled out.
    expect(rowOf(h, "row00")).toBe(-1)
    const shown = rowOf(h, "row11")
    const start = h.text()[shown]!.indexOf("row11")
    await click(h, start + 4, shown - 1)
    expect(editor(h).text.split("\n")[10]).toBe("row10")
    expect(editor(h).cursor).toEqual({ row: 10, col: 4 })
  })

  test("a click in the transcript keeps its meaning and leaves the prompt cursor alone", async () => {
    const h = await terminal([])
    await h.type("hello")
    const row = rowOf(h, "hello")
    expect(row).toBeGreaterThan(0)
    await click(h, 5, 0)
    expect(editor(h).cursorOffset).toBe(5)
    await click(h, 5, 2)
    expect(editor(h).cursorOffset).toBe(5)
    expect(osc52(h)).toEqual([])
  })

  test("dragging still selects and copies what was dragged over", async () => {
    const h = await terminal([])
    await h.type("alpha beta gamma")
    const row = rowOf(h, "alpha beta")
    const start = h.text()[row]!.indexOf("beta")
    await h.app.onKey(press(start, row))
    await h.app.onKey(drag(start + 2, row))
    await h.app.onKey(release(start + 3, row))
    expect(osc52(h)).toEqual(["beta"])
  })

  test("a double click selects the word and a triple click the line, as before", async () => {
    const h = await terminal([])
    await h.type("alpha beta gamma")
    const row = rowOf(h, "alpha beta")
    const start = h.text()[row]!.indexOf("beta")
    await click(h, start + 1, row)
    await click(h, start + 1, row)
    expect(osc52(h)).toEqual(["beta"])
    await click(h, start + 1, row)
    expect(osc52(h).at(-1)).toBe("alpha beta gamma")
  })

  test("shift+click extends the selection from the cursor and copies nothing", async () => {
    const h = await terminal([])
    await h.type("abcdef ghijkl")
    const row = rowOf(h, "abcdef")
    const start = h.text()[row]!.indexOf("abcdef")
    await click(h, start + 1, row)
    await click(h, start + 5, row, SHIFT)
    expect(editor(h).selection).toEqual({ start: 1, end: 5 })
    expect(editor(h).selectedText).toBe("bcde")
    expect(osc52(h)).toEqual([])
    h.app.render()
    expect(h.frames.at(-1)!.flat().some((span) => span.bg === "primary" && span.fg === "background" && span.text === "bcde")).toBe(true)
    await h.type("\x7f")
    expect(editor(h).text).toBe("af ghijkl")
  })

  test("a click in a recalled entry moves the cursor and keeps the browsing", async () => {
    const h = await terminal(["alpha\nbeta", "older"])
    await h.type(UP)
    const row = rowOf(h, "alpha")
    const start = h.text()[row]!.indexOf("alpha")
    await click(h, start + 2, row)
    expect(editor(h).cursor).toEqual({ row: 0, col: 2 })
    await h.type(UP)
    expect(editor(h).text).toBe("older")
  })

  test("in vim normal mode a click rests on a character", async () => {
    const h = await terminal([], { vim: true })
    await h.type("abc def")
    await h.type(ESC)
    const row = rowOf(h, "abc def")
    const start = h.text()[row]!.indexOf("abc")
    await click(h, 50, row)
    expect(editor(h).cursorOffset).toBe(6)
    await click(h, start + 1, row)
    expect(editor(h).cursorOffset).toBe(1)
  })
})

describe("vim mode", () => {
  test("j and k move by drawn rows, the arrows too, and ↑ on the first row still recalls", async () => {
    const h = await terminal(["old message"], { vim: true })
    const text = Array.from({ length: 30 }, (_, i) => `w${String(i).padStart(2, "0")}`).join(" ")
    await h.type(text)
    await h.type(ESC)
    const rows = editor(h).visualLines()
    expect(rows.length).toBeGreaterThan(2)
    const before = editor(h).cursorOffset
    await h.type("k")
    expect(editor(h).text).toBe(text)
    expect(editor(h).cursorOffset).toBeLessThan(before)
    expect(editor(h).visualLines().findLastIndex((row) => row.start <= editor(h).cursorOffset)).toBe(rows.length - 2)
    await h.type("j")
    expect(editor(h).visualLines().findLastIndex((row) => row.start <= editor(h).cursorOffset)).toBe(rows.length - 1)
    await h.type("2k")
    expect(editor(h).visualLines().findLastIndex((row) => row.start <= editor(h).cursorOffset)).toBe(Math.max(0, rows.length - 3))
    await h.type("gg")
    await h.type("0")
    await h.type(UP)
    expect(editor(h).text).toBe("old message")
  })
})
