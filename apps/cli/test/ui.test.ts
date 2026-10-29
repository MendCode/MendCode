import { describe, expect, test } from "bun:test"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { createEditor } from "../src/view/editor"
import { renderMarkdown } from "../src/view/markdown"
import { createTranscript } from "../src/view/transcript"
import { textWidth } from "../src/view/wrap"
import { colorDepth, glyphs, setTheme, sgr } from "../src/ui/theme"
import { DEFAULT_THEME } from "../src/themes"

const plain = (lines: { text: string }[][]) => lines.map((l) => l.map((s) => s.text).join(""))

describe("markdown", () => {
  test("renders headings, lists, inline code and links with roles, within width", () => {
    const lines = renderMarkdown("## Título\n\nTexto con `code` y **negrita** y [enlace](http://x).\n\n- uno\n- dos", 40)
    expect(lines[0]).toEqual([{ text: "Título", fg: "heading", bold: true }])
    const spans = lines.flat()
    expect(spans.find((s) => s.text === "code")?.fg).toBe("code")
    expect(spans.find((s) => s.text === "negrita")?.bold).toBe(true)
    expect(spans.find((s) => s.text === "enlace")?.fg).toBe("link")
    expect(plain(lines).filter((l) => l.startsWith("• "))).toEqual(["• uno", "• dos"])
    for (const line of plain(lines)) expect(textWidth(line)).toBeLessThanOrEqual(40)
  })

  test("an unclosed fence during streaming is shown as code, never dropped (S1)", () => {
    const streaming = renderMarkdown("Mira:\n```ts\nconst a = 1\nconst b", 40)
    expect(plain(streaming)).toContain("│ const b")
    expect(streaming.at(-1)?.some((span) => span.fg === "code" && span.text === "b")).toBe(true)
    expect(streaming.at(-1)?.some((span) => span.fg === "synKeyword" && span.text === "const")).toBe(true)
    const done = renderMarkdown("Mira:\n```ts\nconst a = 1\nconst b = 2\n```\nfin", 40)
    expect(plain(done).at(-1)).toBe("fin")
  })

  test("code lines longer than the width wrap with a continuation marker and lose no characters", () => {
    const lines = plain(renderMarkdown("```\n" + "x".repeat(80) + "\n```", 20))
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(20)
    expect(lines.slice(1).some((line) => line.includes("↪"))).toBe(true)
    expect(lines.join("").replace(/[^x]/g, "")).toHaveLength(80)
  })
})

describe("editor (S4)", () => {
  test("Alt+Enter inserts a newline, Enter submits, backspace joins lines", () => {
    const editor = createEditor()
    for (const k of ["h", "o", "l", "a"]) editor.key(k)
    expect(editor.key("\x1b\r")).toBe("changed")
    editor.key("x")
    expect(editor.text).toBe("hola\nx")
    editor.key("\x7f")
    editor.key("\x7f")
    expect(editor.text).toBe("hola")
    expect(editor.key("\r")).toBe("submit")
  })

  test("cursor moves by grapheme so accents and emoji are one unit", () => {
    const editor = createEditor()
    editor.insert("añ🚀b")
    editor.key("\x1b[D")
    editor.key("\x7f")
    expect(editor.text).toBe("añb")
  })

  test("Ctrl+W deletes a word, Ctrl+U the line start, and unknown escapes are ignored", () => {
    const editor = createEditor()
    editor.insert("uno dos tres")
    editor.key("\x17")
    expect(editor.text).toBe("uno dos ")
    expect(editor.key("\x1b[1;5P")).toBe("none")
    editor.key("\x15")
    expect(editor.isEmpty()).toBe(true)
  })

  test("pasted multi-line text is inserted, not submitted", () => {
    const editor = createEditor()
    expect(editor.key("línea 1\rlínea 2")).toBe("changed")
    expect(editor.text).toBe("línea 1\nlínea 2")
  })
})

describe("tool cards (S2, S3)", () => {
  const ids = createIdFactory()
  const sessionId = ids("session")
  const turnId = ids("turn")
  const itemId = ids("item")
  let seq = 0
  const ev = (e: Record<string, unknown>) => ({ sessionId, seq: ++seq, at: 0, ...e }) as SessionEvent

  test("a running tool shows its last lines; when done it collapses to one line; Ctrl+O expands", () => {
    const t = createTranscript({ glyphs: glyphs({}) })
    t.apply(ev({ type: "turn.started", turnId, queueId: ids("queue") }))
    t.apply(ev({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "bun test" } }))
    for (let i = 1; i <= 10; i++) t.apply(ev({ type: "item.delta", itemId, text: `line ${i}\n` }))
    const running = t.viewport(60, 20).map((l) => l.text)
    expect(running.some((l) => l.includes("line 10"))).toBe(true)
    expect(running.some((l) => l.includes("line 5"))).toBe(false)
    t.apply(ev({ type: "item.completed", itemId, status: "ok" }))
    const collapsed = t.viewport(60, 20).map((l) => l.text).filter(Boolean)
    expect(collapsed).toEqual(["     ◆ bun test  text · 70 B"])
    t.toggleTools()
    const expanded = t.viewport(60, 20).map((l) => l.text).filter(Boolean)
    expect(expanded.length).toBe(11)
  })
})

describe("theme", () => {
  test("uses truecolor only when the terminal declares it, otherwise 256 colors", () => {
    // The theme is process-wide: a file that ran an app before this one in the same process (tui-automation) may have changed it.
    setTheme(DEFAULT_THEME)
    expect(colorDepth({ COLORTERM: "truecolor" })).toBe("truecolor")
    expect(colorDepth({})).toBe("256")
    expect(sgr({ text: "x", fg: "primary" }, "truecolor")).toBe("\x1b[38;2;34;197;94m")
    expect(sgr({ text: "x", fg: "primary" }, "256")).toMatch(/^\x1b\[38;5;\d+m$/)
    expect(glyphs({ MENDCODE_GLYPHS: "nerd" }).tool).not.toBe(glyphs({}).tool)
  })
})
