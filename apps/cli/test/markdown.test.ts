import { describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { renderMarkdown } from "../src/view/markdown"
import { textWidth } from "../src/view/wrap"
import { budgetMs } from "../../../scripts/test-budget"

const plain = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join(""))
const spansOf = (lines: Line[]) => lines.flat() as (Line[number] & { fgHex?: string; italic?: boolean })[]

function expectFits(lines: Line[], width: number) {
  for (const line of plain(lines)) expect(textWidth(line)).toBeLessThanOrEqual(width)
}

const TABLE = ["| Name | Qty | Note |", "|:-----|----:|:----:|", "| apple | 3 | fresh **fruit** |", "| kiwi | 12 | `green` |"].join("\n")

const DOCUMENT = [
  "# Título con #ff8800",
  "",
  "Texto con `code`, **negrita**, *cursiva*, _otra_, ~~viejo~~ y [enlace](https://example.com/a) más https://example.com/b.",
  "Color #0f0 y `#123456` pero no https://x.dev/#fff.",
  "",
  "1. primero",
  "2. segundo",
  "   - anidado uno",
  "     - más hondo",
  "- [ ] pendiente",
  "- [x] hecho",
  "",
  TABLE,
  "",
  "| 名前 | 説明 |",
  "|---|---|",
  "| 猫 | とても長い説明文がここに入ります |",
  "",
  "```ts",
  "\tconst value = 'x'.repeat(120)",
  "const b = 2",
  "```",
  "",
  "> cita",
  "---",
  "fin",
].join("\n")

describe("markdown tables", () => {
  test("renders header, separator and body with box borders and per-column alignment", () => {
    const lines = plain(renderMarkdown(TABLE, 60))
    expect(lines[0]).toBe("┌───────┬─────┬─────────────┐")
    expect(lines[1]).toBe("│ Name  │ Qty │    Note     │")
    expect(lines[2]).toBe("├───────┼─────┼─────────────┤")
    expect(lines[3]).toBe("│ apple │   3 │ fresh fruit │")
    expect(lines[4]).toBe("│ kiwi  │  12 │    green    │")
    expect(lines[5]).toBe("└───────┴─────┴─────────────┘")
  })

  test("colors borders with border, header with bold heading and applies inline markdown in cells", () => {
    const spans = renderMarkdown(TABLE, 60).flat()
    expect(spans.find((s) => s.text.startsWith("┌"))?.fg).toBe("border")
    expect(spans.find((s) => s.text === "Name")).toMatchObject({ fg: "heading", bold: true })
    expect(spans.find((s) => s.text === "fruit")?.bold).toBe(true)
    expect(spans.find((s) => s.text === "green")?.fg).toBe("code")
  })

  test("wraps cell text into multi-line rows when the table is too wide", () => {
    const source = "| a | description |\n|---|---|\n| 1 | one two three four five six seven eight nine ten eleven twelve |"
    const lines = renderMarkdown(source, 30)
    expectFits(lines, 30)
    const text = plain(lines)
    expect(text.length).toBeGreaterThan(6)
    expect(text.join(" ")).toContain("twelve")
    expect(text.some((line) => /^│ 1 +│ one/.test(line))).toBe(true)
  })

  test("falls back to stacked key value lists when columns cannot fit", () => {
    const source = "| alpha | beta | gamma | delta | epsilon |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |\n| 6 | 7 | 8 | 9 | 10 |"
    const text = plain(renderMarkdown(source, 20))
    expect(text).toContain("alpha: 1")
    expect(text).toContain("epsilon: 5")
    expect(text).toContain("delta: 9")
    expect(text.some((line) => line.includes("│"))).toBe(false)
    expectFits(renderMarkdown(source, 20), 20)
  })

  test("renders a header-only partial table as a table while streaming", () => {
    const text = plain(renderMarkdown("| a | b |", 40))
    expect(text[0]).toStartWith("┌")
    expect(text.join("\n")).toContain("│ a │ b │")
  })

  test("renders header plus separator as a table and a half-typed separator without losing the header", () => {
    expect(plain(renderMarkdown("| a | b |\n|---|---|", 40)).join("\n")).toContain("│ a │ b │")
    expect(plain(renderMarkdown("| a | b |\n|--", 40)).join("\n")).toContain("│ a │ b │")
  })

  test("keeps wide characters aligned inside table cells", () => {
    const lines = plain(renderMarkdown("| 名前 | x |\n|---|---|\n| 猫猫猫 | y |", 40))
    const widths = new Set(lines.map(textWidth))
    expect(widths.size).toBe(1)
    expectFits(renderMarkdown("| 名前 | 説明 |\n|---|---|\n| 猫 | とても長い説明文がここに入ります |", 20), 20)
  })

  test("escaped pipes stay inside the cell", () => {
    expect(plain(renderMarkdown("| a |\n|---|\n| x \\| y |", 40)).join("\n")).toContain("x | y")
  })

  test("short rows are padded and long rows truncated to the header columns", () => {
    const lines = plain(renderMarkdown("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |", 40))
    expect(new Set(lines.map(textWidth)).size).toBe(1)
  })
})

describe("markdown fenced code", () => {
  test("shows the language label in muted and a border gutter with the code in syntax colors", () => {
    const lines = renderMarkdown("```ts\nconst a = 1\n```", 40)
    expect(plain(lines)).toEqual(["│ ts", "│ const a = 1"])
    expect(lines[0]![1]).toMatchObject({ text: "ts", fg: "muted" })
    expect(lines[1]![0]).toMatchObject({ fg: "border" })
    const code = lines[1]!.slice(1)
    expect(code.find((span) => span.text === "const")).toMatchObject({ fg: "synKeyword" })
    expect(code.find((span) => span.text === "1")).toMatchObject({ fg: "synNumber" })
    expect(code.find((span) => span.text === "a")).toMatchObject({ fg: "code" })
  })

  test("a fence in an unknown language keeps the single code color", () => {
    const lines = renderMarkdown("```brainfuck\n+++[>+<-]\n```", 40)
    expect(lines[1]![1]).toMatchObject({ text: "+++[>+<-]", fg: "code" })
  })

  test("omits the label line when the fence has no language", () => {
    expect(plain(renderMarkdown("```\nx\n```", 40))).toEqual(["│ x"])
  })

  test("wraps long code lines with a continuation marker instead of clipping", () => {
    const lines = plain(renderMarkdown("```\n" + "x".repeat(50) + "\n```", 20))
    expect(lines.length).toBeGreaterThan(2)
    expect(lines[1]).toStartWith("│ ↪ ")
    expect(lines.join("").replaceAll("│ ", "").replaceAll("↪ ", "")).toBe("x".repeat(50))
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(20)
  })

  test("converts tabs to two spaces", () => {
    expect(plain(renderMarkdown("```\n\tx\n```", 40))).toEqual(["│   x"])
  })

  test("an unclosed fence streams as code and keeps every line", () => {
    const text = plain(renderMarkdown("Mira:\n```ts\nconst a = 1\nconst b", 40))
    expect(text).toContain("│ const b")
    expect(text).toContain("│ const a = 1")
  })

  test("a longer closing fence ends the block and text after it is a paragraph", () => {
    const text = plain(renderMarkdown("```\ncode\n````\nafter", 40))
    expect(text.at(-1)).toBe("after")
  })

  test("wide characters in code wrap by cell width", () => {
    const lines = plain(renderMarkdown("```\n" + "猫".repeat(30) + "\n```", 20))
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(20)
  })
})

describe("markdown hex swatches", () => {
  test("inserts a colored square before hex colors in text", () => {
    const spans = spansOf(renderMarkdown("mira #ff8800 y #0f0 ok", 40))
    const swatches = spans.filter((s) => s.text === "■")
    expect(swatches.map((s) => s.fgHex)).toEqual(["#ff8800", "#00ff00"])
    expect(plain(renderMarkdown("mira #ff8800 ok", 40))[0]).toBe("mira ■#ff8800 ok")
  })

  test("inserts a swatch inside inline code too", () => {
    const spans = spansOf(renderMarkdown("usa `#123456` aquí", 40))
    expect(spans.find((s) => s.text === "■")?.fgHex).toBe("#123456")
    expect(spans.find((s) => s.text === "#123456")?.fg).toBe("code")
  })

  test("ignores hex-like fragments in URLs, longer words and other lengths", () => {
    const line = plain(renderMarkdown("https://x.dev/#fff #ffff #12345 a#fff #ggg", 60))[0]!
    expect(line).not.toContain("■")
  })

  test("keeps the swatch and its color together when wrapping", () => {
    const text = plain(renderMarkdown("aaaa bbbb #ff8800", 12))
    expect(text).toEqual(["aaaa bbbb", "■#ff8800"])
  })
})

describe("markdown lists and inline styles", () => {
  test("keeps ordered numbers and nests by indentation of 2 or 4 spaces", () => {
    const two = plain(renderMarkdown("1. a\n2. b\n  - c\n    - d", 40))
    expect(two).toEqual(["1. a", "2. b", "  ◦ c", "    ▪ d"])
    const four = plain(renderMarkdown("- a\n    - b\n        - c", 40))
    expect(four).toEqual(["• a", "  ◦ b", "    ▪ c"])
  })

  test("returns to the outer level after a nested list", () => {
    expect(plain(renderMarkdown("- a\n  - b\n- c", 40))).toEqual(["• a", "  ◦ b", "• c"])
  })

  test("renders task list boxes with success color for done items", () => {
    const lines = renderMarkdown("- [ ] todo\n- [x] done", 40)
    expect(plain(lines)).toEqual(["[ ] todo", "[x] done"])
    expect(lines[1]!.find((s) => s.text === "[x] ")?.fg).toBe("success")
    expect(lines[0]!.find((s) => s.text === "[ ] ")?.fg).toBe("muted")
  })

  test("wrapped list items keep a hanging indent", () => {
    const text = plain(renderMarkdown("- uno dos tres cuatro cinco seis", 14))
    expect(text[0]).toStartWith("• ")
    for (const line of text.slice(1)) expect(line).toStartWith("  ")
  })

  test("renders strikethrough in muted, and italic with either marker", () => {
    const spans = spansOf(renderMarkdown("~~viejo~~ *a* _b_ snake_case_name 2 * 3 * 4", 60))
    expect(spans.find((s) => s.text === "viejo")?.fg).toBe("muted")
    expect(spans.find((s) => s.text === "a")?.italic).toBe(true)
    expect(spans.find((s) => s.text === "b")?.italic).toBe(true)
    expect(plain(renderMarkdown("snake_case_name 2 * 3 * 4", 60))[0]).toBe("snake_case_name 2 * 3 * 4")
  })

  test("nests bold around code", () => {
    const spans = renderMarkdown("**mira `x`**", 40).flat()
    expect(spans.find((s) => s.text === "x")).toMatchObject({ fg: "code", bold: true })
  })

  test("unclosed emphasis stays literal", () => {
    expect(plain(renderMarkdown("**abierto y *otro", 40))[0]).toBe("**abierto y *otro")
  })
})

describe("markdown links", () => {
  test("shows the url in muted after the text when they differ", () => {
    const lines = renderMarkdown("ver [docs](https://a.dev/x) ya", 60)
    expect(plain(lines)[0]).toBe("ver docs (https://a.dev/x) ya")
    const spans = lines.flat()
    expect(spans.find((s) => s.text === "docs")?.fg).toBe("link")
    expect(spans.find((s) => s.text === "(https://a.dev/x)")?.fg).toBe("muted")
  })

  test("colors autolinks in link color without repeating the url and drops trailing punctuation", () => {
    const lines = renderMarkdown("mira https://a.dev/x, y <https://b.dev>.", 60)
    expect(plain(lines)[0]).toBe("mira https://a.dev/x, y https://b.dev.")
    const links = lines.flat().filter((s) => s.fg === "link").map((s) => s.text)
    expect(links).toEqual(["https://a.dev/x", "https://b.dev"])
  })

  test("does not repeat the url when the link text equals the url", () => {
    expect(plain(renderMarkdown("[https://a.dev](https://a.dev)", 60))[0]).toBe("https://a.dev")
  })
})

describe("markdown streaming and width safety", () => {
  test("every prefix of a full document renders within widths 20, 40 and 100", () => {
    for (const width of [20, 40, 100]) {
      for (let end = 0; end <= DOCUMENT.length; end++) {
        const lines = renderMarkdown(DOCUMENT.slice(0, end), width)
        for (const line of plain(lines)) expect(textWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })

  test("every prefix keeps the text typed so far visible", () => {
    const words = ["Título", "negrita", "primero", "apple", "value", "cita"]
    for (const word of words) {
      const at = DOCUMENT.indexOf(word) + word.length
      const rendered = plain(renderMarkdown(DOCUMENT.slice(0, at), 100)).join("\n").replaceAll(/[│┌┐└┘├┤┬┴┼─↪]/g, "")
      expect(rendered.replaceAll(/\s+/g, "")).toContain(word)
    }
  })

  test("full document keeps headings unchanged", () => {
    expect(renderMarkdown("## Título", 40)[0]).toEqual([{ text: "Título", fg: "heading", bold: true }])
  })

  test("renders a 2000 line document at width 100 in under 50 ms", () => {
    const source = Array.from({ length: 10 }, () => DOCUMENT).join("\n\n").split("\n").slice(0, 2000).join("\n")
    const padded = source.split("\n").length < 2000 ? source + "\n" + Array.from({ length: 2000 - source.split("\n").length }, (_, i) => `- item ${i} con \`code\` y **negrita** #ff0000`).join("\n") : source
    renderMarkdown(padded, 100)
    const started = performance.now()
    const lines = renderMarkdown(padded, 100)
    expect(performance.now() - started).toBeLessThan(budgetMs(50))
    expect(lines.length).toBeGreaterThan(1000)
  })
})
