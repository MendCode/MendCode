import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { highlight } from "../src/view/syntax"
import { renderMarkdown } from "../src/view/markdown"
import { cleanTemps, type Harness } from "./session-ui-harness"
import { chat, click, frame, rowOf, slot, type Setup } from "./file-viewer-helpers"

afterEach(cleanTemps)

const spans = (text: string, lang: string) => highlight(text, lang, {})
const roleOf = (parts: ReturnType<typeof highlight>, needle: string) => parts.find((span) => span.text.includes(needle))

/** The spans of the last frame that hold `needle`, with the cells they cover: what the terminal was told to paint. */
function painted(h: Harness, needle: string) {
  const line = (h.frames.at(-1) ?? []).find((row) => row.map((span) => span.text).join("").includes(needle))
  if (!line) throw new Error(`[TEST]: "${needle}" is not painted`)
  return line.filter((span) => span.text.includes(needle) || needle.includes(span.text.trim()) && span.text.trim() !== "")
}

describe("the colors of a document", () => {
  test("prose is the normal text color, whole lines never green", () => {
    for (const line of ["Rules for this repository.", "A paragraph with some words in it, and more.", "plain text"]) {
      const parts = spans(line, "md")
      expect(parts.map((span) => span.text).join("")).toBe(line)
      expect(parts.every((span) => span.fg === "text")).toBe(true)
    }
  })

  test("a heading is bold, its marker alone is the accent", () => {
    const parts = spans("## Worktrees and sessions", "md")
    expect(parts[0]).toMatchObject({ text: "## ", fg: "heading", bold: true })
    expect(parts[1]).toMatchObject({ text: "Worktrees and sessions", fg: "text", bold: true })
  })

  test("a code span is the code role, a link's address is muted, a list marker is not an accent", () => {
    const parts = spans("- run `bun test` and read [the doc](docs/a.md)", "md")
    expect(roleOf(parts, "`bun test`")?.fg).toBe("code")
    expect(roleOf(parts, "[the doc]")?.fg).toBe("text")
    expect(roleOf(parts, "(docs/a.md)")?.fg).toBe("muted")
    expect(parts[0]).toMatchObject({ text: "- ", fg: "muted" })
  })

  test("code uses the roles the chat gives a fenced block of the same language", () => {
    const source = 'const answer = "forty-two" // the answer'
    const viewer = spans(source, "ts")
    expect(roleOf(viewer, "const")?.fg).toBe("synKeyword")
    expect(roleOf(viewer, '"forty-two"')?.fg).toBe("synString")
    expect(roleOf(viewer, "// the answer")?.fg).toBe("synComment")
    const chatRows = renderMarkdown("```ts\n" + source + "\n```", 80).flat()
    for (const needle of ["const", '"forty-two"', "// the answer"]) {
      expect(chatRows.find((span) => span.text.includes(needle))?.fg).toBe(roleOf(viewer, needle)?.fg)
    }
  })
})

describe("what the viewer paints", () => {
  const open = async (file: string, body: string, setup: Setup = {}) => {
    const ctx = await chat({ text: `see ${file} now`, ...setup })
    writeFileSync(path.join(ctx.dir, file), body)
    await click(ctx.h, file)
    return ctx
  }

  test("a Markdown file: plain prose, a bold heading, the header in the chrome roles and no link styling anywhere", async () => {
    const { h } = await open("notes.md", "# Worktrees\n\nSome plain prose that is a paragraph of the file.\n\nUse `bun test` here.\n")
    const header = h.frames.at(-1)!.find((row) => row.some((span) => span.text.includes("notes.md")))!
    const name = header.find((span) => span.text.includes("notes.md"))!
    expect(name).toMatchObject({ fg: "text", bold: true })
    expect(header.find((span) => span.text.includes("lines"))).toMatchObject({ fg: "muted" })
    for (const action of ["o open", "a ask", "y copy"]) {
      const span = header.find((part) => part.text === action)!
      expect(span).toMatchObject({ fg: "muted" })
      expect(span.underline).toBeFalsy()
    }
    expect(painted(h, "Some plain prose").every((span) => span.fg === "text" || span.fg === "muted" || span.bg !== undefined)).toBe(true)
    const prose = painted(h, "Some plain prose").find((span) => span.text.includes("Some plain prose"))!
    expect(prose.fg).toBe("text")
    const title = painted(h, "Worktrees").find((span) => span.text === "Worktrees")!
    expect(title).toMatchObject({ fg: "text", bold: true })
    expect(painted(h, "bun test").find((span) => span.text === "`bun test`")?.fg).toBe("code")
    const all = h.frames.at(-1)!.flat().slice(-400)
    expect(all.some((span) => span.fg === "link" || span.underline === true && span.text.trim() !== "" && span.fg === "link")).toBe(false)
  })

  test("a header is one row: the second row of the old design is gone, the footer takes the panel switch", async () => {
    const { h } = await open("notes.md", "# T\n\ntext\n", { profile: { rightSidebar: true, sidebarWidgets: [{ type: "context", options: {} }] } as never })
    const text = frame(h)
    expect(text).not.toContain("file · panel")
    expect(text).not.toContain("switch")
    expect(slot(h)[rowOf(h, "‹ notes.md") + 1]).not.toContain("notes.md")
    expect(text).toContain("ctrl+\\ focus · alt+{ panel")
  })
})

describe("wrap", () => {
  const long = "word ".repeat(40).trim()

  async function show(file: string, body: string, wrap?: "auto" | "on" | "off") {
    const ctx = await chat({ text: `see ${file} now`, profile: wrap ? { viewerWrap: wrap } : {}, width: 120 })
    writeFileSync(path.join(ctx.dir, file), body)
    await click(ctx.h, file)
    return ctx.h
  }

  test("auto wraps prose under the number gutter and cuts code", async () => {
    const prose = await show("notes.md", `${long}\n`)
    const rows = slot(prose).filter((row) => /word/.test(row))
    expect(rows.length).toBeGreaterThan(1)
    // The second piece has no number and starts under the first one's text.
    const indent = rows[0]!.indexOf("word")
    expect(rows[1]!.indexOf("word")).toBe(indent)
    expect(rows[1]!.slice(0, indent).trim()).toBe("")
    const code = await show("long.ts", `const text = "${long}"\n`)
    expect(slot(code).filter((row) => /word/.test(row)).length).toBe(1)
  })

  test("a word is never cut when it fits on a row", async () => {
    const h = await show("notes.md", `${"alpha beta gamma ".repeat(12)}\n`)
    const rows = slot(h).filter((row) => /alpha|beta|gamma/.test(row))
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) for (const piece of row.split(/\s+/)) if (/^[a-z]+$/.test(piece)) expect(["alpha", "beta", "gamma"]).toContain(piece)
  })

  test("off cuts prose, on wraps code", async () => {
    const off = await show("notes.md", `${long}\n`, "off")
    expect(slot(off).filter((row) => /word/.test(row)).length).toBe(1)
    const on = await show("long.ts", `const text = "${long}"\n`, "on")
    expect(slot(on).filter((row) => /word/.test(row)).length).toBeGreaterThan(1)
  })

  test("a saved boolean becomes auto or on", async () => {
    const { normalizeTuiProfile } = await import("../src/view/tui-profile")
    expect(normalizeTuiProfile({ viewerWrap: false }).viewerWrap).toBe("auto")
    expect(normalizeTuiProfile({ viewerWrap: true }).viewerWrap).toBe("on")
    expect(normalizeTuiProfile({ viewerWrap: "off" }).viewerWrap).toBe("off")
    expect(normalizeTuiProfile({}).viewerWrap).toBe("auto")
  })
})
