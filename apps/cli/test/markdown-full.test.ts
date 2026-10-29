import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { Line, Span } from "../src/ui/theme"
import { colorOverrides, setColorOverrides, setTheme, sgr } from "../src/ui/theme"
import { COLOR_NAMES, DEFAULT_THEME, THEMES } from "../src/themes"
import { inline, markdownStyleFor, renderMarkdown, type MarkdownStyle } from "../src/view/markdown"
import { CLASSIC_STYLE, ENHANCED_ROLES } from "../src/view/markdown-style"
import { alignRight, firstStrong, visualRow } from "../src/view/markdown-bidi"
import { copyOf, gutterOf } from "../src/view/line-meta"
import { HIGHLIGHT_LANGUAGES, highlight, isHighlighted } from "../src/view/syntax"
import { ensureMermaid, onMermaidLoaded } from "../src/view/mermaid-lazy"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"
import { MARKDOWN_COLOR_ROLES, parseMarkdownColors, tuiProblems, TUI_DEFAULTS } from "@mendcode/protocol/wire"

const plain = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join(""))
const spansOf = (lines: Line[]) => lines.flat() as Span[]
/** The copy buttons a reader can see and click: the zero-width regions only answer the key. */
const visible = (rows: Line[]) => rows.flatMap((row) => (copyOf(row) ?? []).filter((region) => region.to > region.from))

const FULL: MarkdownStyle = { enhanced: true, table: "box", heading: "underline", copy: "all", rtl: true }
const style = (patch: Partial<MarkdownStyle> = {}): MarkdownStyle => ({ ...FULL, ...patch })
const draw = (source: string, width = 60, patch: Partial<MarkdownStyle> = {}) => renderMarkdown(source, width, "body", { style: style(patch) })

const TORTURE = fs.readFileSync(path.join(import.meta.dir, "fixtures", "markdown-torture.md"), "utf8")

beforeAll(async () => {
  const loaded = new Promise<void>((resolve) => onMermaidLoaded(resolve))
  ensureMermaid()
  await loaded
})
afterEach(() => {
  setColorOverrides({})
  setTheme(DEFAULT_THEME)
})

describe("style resolution", () => {
  const profile = (patch: Partial<typeof DEFAULT_TUI_PROFILE> = {}) => ({ ...DEFAULT_TUI_PROFILE, ...patch })
  test("only the full renderer in the balanced and full views is enhanced; minimal and the markdown renderer stay classic", () => {
    expect(markdownStyleFor({ profile: profile(), mode: "minimal" })).toEqual(CLASSIC_STYLE)
    expect(markdownStyleFor({ profile: profile({ messageRenderer: "markdown" }), mode: "full" })).toEqual(CLASSIC_STYLE)
    expect(markdownStyleFor({ profile: profile({ messageRenderer: "plain" }), mode: "full" })).toEqual(CLASSIC_STYLE)
    expect(markdownStyleFor({ profile: profile(), mode: "full" }).enhanced).toBe(true)
  })
  test("auto settings are calmer in balanced: bold headings and copy buttons on code only", () => {
    expect(markdownStyleFor({ profile: profile(), mode: "balanced" })).toMatchObject({ table: "box", heading: "bold", copy: "code" })
    expect(markdownStyleFor({ profile: profile(), mode: "full" })).toMatchObject({ table: "box", heading: "underline", copy: "all" })
  })
  test("explicit settings win in both views", () => {
    const set = profile({ tableStyle: "rules", headingStyle: "banner", markdownCopyHints: "off", markdownRtl: false })
    for (const mode of ["balanced", "full"] as const) expect(markdownStyleFor({ profile: set, mode })).toEqual({ enhanced: true, table: "rules", heading: "banner", copy: "off", rtl: false })
  })
})

describe("code blocks", () => {
  test("a header names the language and ends in a copy button at the right edge", () => {
    const rows = draw("```ts\nconst a = 1\n```", 40)
    const header = plain(rows)[0]!
    expect(header.startsWith("╭─ ts ")).toBe(true)
    expect(header.endsWith(" copy")).toBe(true)
    expect(textWidth(header)).toBe(40)
    expect(plain(rows)[1]).toBe("│ const a = 1")
    expect(spansOf([rows[0]!]).find((span) => span.text === "copy")).toMatchObject({ fg: "mdCopy" })
    expect(spansOf([rows[0]!]).find((span) => span.text === "ts")).toMatchObject({ fg: "mdCodeLabel" })
  })

  test("the copy button is a hit region over exactly its cells and copies the source", () => {
    const code = "line one\n\tindented"
    const header = draw(`\`\`\`text\n${code}\n\`\`\``, 30)[0]!
    const [button] = copyOf(header)!
    expect(button).toMatchObject({ text: code, label: "text code" })
    expect(plain([header])[0]!.slice(button!.from, button!.to)).toBe("copy")
    expect(textWidth(plain([header])[0]!.slice(0, button!.to))).toBe(30)
    expect(gutterOf(header)).toBeGreaterThanOrEqual(30)
  })

  test("an unclosed fence copies what has streamed so far and a fence without a language says text", () => {
    const rows = draw("```\nfirst\nsecond", 30)
    expect(plain(rows)[0]!.startsWith("╭─ text ")).toBe(true)
    expect(copyOf(rows[0]!)![0]!.text).toBe("first\nsecond")
  })

  test("copy off keeps the label and drops the button; code scope keeps it on code", () => {
    const off = draw("```ts\nx\n```", 30, { copy: "off" })
    expect(visible(off)).toEqual([])
    expect(plain(off)[0]).not.toContain("copy")
    expect(plain(off)[0]!.startsWith("╭─ ts ")).toBe(true)
    expect(copyOf(draw("```ts\nx\n```", 30, { copy: "code" })[0]!)).toHaveLength(1)
  })

  test("the classic style has no header button and keeps its language label row", () => {
    const rows = renderMarkdown("```ts\nx\n```", 40)
    expect(plain(rows)).toEqual(["│ ts", "│ x"])
    expect(copyOf(rows[0]!)).toBeUndefined()
  })

  test("long lines wrap behind a continuation marker and never pass the width", () => {
    const rows = draw("```text\n" + "word ".repeat(30) + "\n```", 30)
    expect(plain(rows).slice(1).filter((row) => row.startsWith("│ ↪ ")).length).toBeGreaterThan(1)
    for (const row of plain(rows)) expect(textWidth(row)).toBeLessThanOrEqual(30)
  })

  test("diff bars follow the change: green plus, red minus, blue hunk", () => {
    const rows = draw("```diff\n+added\n-removed\n@@ -1 +1 @@\n context\n```", 40)
    const bars = rows.slice(1).map((row) => row[0]!.fg)
    expect(bars).toEqual(["success", "error", "info", "mdCodeBorder"])
  })

  test("tabs inside copied code are kept as typed", () => {
    expect(copyOf(draw("```go\n\tfmt.Println()\n```", 40)[0]!)![0]!.text).toBe("\tfmt.Println()")
  })
})

describe("syntax coverage", () => {
  const SAMPLES: Record<string, string> = {
    ts: 'const total = add(1, "two") // sum',
    json: '{"a": 1, "b": true}',
    bash: "git commit -m 'x' --no-verify # note",
    py: 'def f(x): return "a"  # c',
    go: "func main() { return nil }",
    rust: "fn main() { let x = 1; }",
    c: 'int main(void) { return 0; } // c',
    cpp: "template <typename T> class Box { public: T value; };",
    java: 'public class A { String s = "x"; }',
    csharp: 'public class A { string s = "x"; }',
    kotlin: 'fun main() { val x = "a" }',
    swift: 'func f() { let x = "a" }',
    ruby: 'def f; @x = "a"; end # c',
    php: '<?php echo $name; // c',
    sql: "SELECT id, name FROM users WHERE id = 1 -- c",
    yaml: "name: ci # c",
    toml: 'title = "x" # c',
    css: "a { color: #fff; margin: 10px; }",
    html: '<div class="a">x</div> <!-- c -->',
    lua: 'local x = "a" -- c',
    dockerfile: "FROM node:20 AS build",
    diff: "+added",
    md: "# Title",
  }
  test("every canonical language has a sample here and colours something", () => {
    expect([...HIGHLIGHT_LANGUAGES].sort()).toEqual(Object.keys(SAMPLES).sort())
    for (const [lang, line] of Object.entries(SAMPLES)) {
      const spans = highlight(line, lang)
      expect(spans.map((span) => span.text).join("")).toBe(line)
      expect(spans.some((span) => span.fg !== "code"), lang).toBe(true)
      expect(isHighlighted(lang)).toBe(true)
    }
  })

  test("there are twenty-three languages, plus the common aliases", () => {
    expect(HIGHLIGHT_LANGUAGES).toHaveLength(23)
    for (const alias of ["tsx", "js", "sh", "zsh", "yml", "kt", "rb", "cs", "c++", "hpp", "scss", "xml", "docker", "psql"]) expect(isHighlighted(alias), alias).toBe(true)
    expect(isHighlighted("brainfuck")).toBe(false)
  })

  test("yaml keys are keys, values with a colon are not", () => {
    const roles = (line: string, lang: string) => Object.fromEntries(highlight(line, lang).map((span) => [span.text, span.fg]))
    expect(roles("name: https://example.com", "yaml")).toMatchObject({ name: "synFunction" })
    expect(roles("name: https://example.com", "yaml").https).toBe("code")
    expect(roles('title = "x"', "toml")).toMatchObject({ title: "synFunction", '"x"': "synString" })
    expect(highlight("[server.http]", "toml")[0]).toMatchObject({ fg: "synType", bold: true })
    expect(roles("SELECT 1 from t", "sql")).toMatchObject({ SELECT: "synKeyword", from: "synKeyword" })
    expect(roles("a { color: #fff; }", "css")).toMatchObject({ color: "synFunction", "#fff": "synNumber" })
    expect(roles("<div class=\"a\">", "html")).toMatchObject({ "<div": "synKeyword", class: "synType", '"a"': "synString" })
  })

  test("shell lines colour prompt, command, flag, string, variable and comment", () => {
    const roles = (line: string) => highlight(line, "bash").map((span) => [span.text, span.fg])
    expect(roles("$ git commit -m 'fix' --no-verify $HOME # note")).toEqual(
      expect.arrayContaining([["$", "synPrompt"], ["git", "synFunction"], ["-m", "synFlag"], ["--no-verify", "synFlag"], ["'fix'", "synString"], ["$HOME", "synType"], ["# note", "synComment"]]),
    )
    expect(roles("ls | grep -i x")).toEqual(expect.arrayContaining([["ls", "synFunction"], ["grep", "synFunction"], ["-i", "synFlag"]]))
    expect(highlight("$HOME/bin", "bash")[0]!.fg).not.toBe("synPrompt")
    expect(highlight("foo-bar baz", "bash").some((span) => span.fg === "synFlag")).toBe(false)
  })
})

describe("tables", () => {
  const draw = (source: string, width: number, patch: Partial<MarkdownStyle> = {}) => renderMarkdown(source, width, "body", { style: style({ copy: "off", ...patch }) })
  const TABLE = "| Name | Qty | Note |\n|:-----|----:|:----:|\n| apple | 3 | fresh |\n| kiwi | 12 | ok |"
  test("box draws the full frame, grid adds a rule between rows", () => {
    expect(plain(draw(TABLE, 40, { table: "box", copy: "off" }))).toEqual([
      "┌───────┬─────┬───────┐",
      "│ Name  │ Qty │ Note  │",
      "├───────┼─────┼───────┤",
      "│ apple │   3 │ fresh │",
      "│ kiwi  │  12 │  ok   │",
      "└───────┴─────┴───────┘",
    ].map((row) => row))
    expect(plain(draw(TABLE, 40, { table: "grid" }))).toContain("├───────┼─────┼───────┤")
    expect(plain(draw(TABLE, 40, { table: "grid" })).filter((row) => row.startsWith("├"))).toHaveLength(2)
  })

  test("rules keep horizontal rules only and minimal underlines each header column", () => {
    const rules = plain(draw(TABLE, 40, { table: "rules" }))
    expect(rules[0]).toMatch(/^─+$/)
    expect(rules.at(-1)).toBe(rules[0]!)
    expect(rules.some((row) => row.includes("│"))).toBe(false)
    expect(rules[1]).toBe("Name   Qty  Note")
    const minimal = plain(draw(TABLE, 40, { table: "minimal" }))
    expect(minimal).toEqual(["Name   Qty  Note", "─────  ───  ─────", "apple    3  fresh", "kiwi    12   ok"])
  })

  test("alignment markers apply in every style: left, right and centre", () => {
    for (const table of ["box", "grid", "rules", "minimal"] as const) {
      const rows = plain(draw(TABLE, 40, { table }))
      const kiwi = rows.find((row) => row.includes("kiwi"))!
      expect(kiwi, table).toMatch(/kiwi[\s│]+12[\s│]+ok/)
      expect(kiwi.indexOf("12") + 2, table).toBe(rows.find((row) => row.includes("Qty"))!.indexOf("Qty") + 3)
    }
  })

  test("the header uses the table header slot, bold; borders use the border slot", () => {
    const spans = spansOf(draw(TABLE, 40))
    expect(spans.find((span) => span.text === "Name")).toMatchObject({ fg: "mdTableHeader", bold: true })
    expect(spans.find((span) => span.text.startsWith("┌"))?.fg).toBe("mdTableBorder")
  })

  test("a table that cannot share the width stacks into key and value pairs, in every style", () => {
    const wide = "| identifier | description | environment | owner | status |\n|---|---|---|---|---|\n| 1 | alpha | production | platform | healthy |"
    for (const table of ["box", "grid", "rules", "minimal"] as const) {
      const rows = plain(draw(wide, 40, { table }))
      expect(rows, table).toContain("identifier: 1")
      expect(rows.some((row) => /[│┌]/.test(row)), table).toBe(false)
    }
    expect(plain(draw(wide, 120, { table: "box" })).some((row) => row.startsWith("┌"))).toBe(true)
  })

  test("wide characters and emoji never break a border or pass the width, in every style and width", () => {
    const cjk = "| 名前 | 説明 | 🚀 |\n|---|---|---|\n| 猫 | とても長い説明文がここに入ります | ✅ done |\n| 🚀 launch | 発射 | 日本語のテキスト |"
    for (const table of ["box", "grid", "rules", "minimal"] as const) {
      for (const width of [24, 30, 40, 60, 80, 120, 200]) {
        const rows = plain(draw(cjk, width, { table }))
        for (const row of rows) expect(textWidth(row), `${table}@${width}: ${row}`).toBeLessThanOrEqual(width)
        if (table === "box" && rows[0]!.startsWith("┌")) for (const row of rows.filter((r) => r.startsWith("│"))) expect(textWidth(row), `${width}: ${row}`).toBe(textWidth(rows[0]!))
      }
    }
  })

  test("the classic style still draws the plain box and heading colour", () => {
    expect(plain(renderMarkdown(TABLE, 40))[0]).toBe("┌───────┬─────┬───────┐")
    expect(spansOf(renderMarkdown(TABLE, 40)).find((span) => span.text === "Name")).toMatchObject({ fg: "heading", bold: true })
  })
})

describe("headings", () => {
  const SOURCE = "# One\n\n## Two\n\n### Three\n\n#### Four"
  const heading = (kind: MarkdownStyle["heading"], width = 20) => draw(SOURCE, width, { heading: kind })

  test("bold keeps every level bold with a colour per level", () => {
    const spans = spansOf(heading("bold"))
    expect(spans.find((span) => span.text === "One")).toMatchObject({ fg: "mdHeading1", bold: true })
    expect(spans.find((span) => span.text === "Two")).toMatchObject({ fg: "mdHeading2", bold: true })
    expect(spans.find((span) => span.text === "Three")).toMatchObject({ fg: "mdHeading3", bold: true })
    expect(spans.find((span) => span.text === "Four")).toMatchObject({ fg: "mdHeading4", bold: true })
    expect(plain(heading("bold"))).toEqual(["One", "", "Two", "", "Three", "", "Four"])
  })

  test("underline rules h1 double and h2 single, as wide as the text", () => {
    expect(plain(heading("underline"))).toEqual(["One", "═══", "", "Two", "───", "", "Three", "", "Four"])
  })

  test("uppercase capitalises h1 and h2 only and leaves inline code alone", () => {
    expect(plain(draw("# one `Code` x\n\n### three", 30, { heading: "uppercase" }))).toEqual(["ONE Code X", "", "three"])
  })

  test("banner fills h1 and h2 across the width with a background and marks h3", () => {
    const rows = heading("banner", 20)
    expect(plain(rows)[0]).toBe(` One${" ".repeat(16)}`)
    expect(textWidth(plain(rows)[0]!)).toBe(20)
    expect(rows[0]!.every((span) => span.bg === "element")).toBe(true)
    expect(rows[2]!.every((span) => span.bg === "panel")).toBe(true)
    expect(plain(rows)[4]).toBe("▌ Three")
  })

  test("the classic heading is unchanged", () => {
    expect(renderMarkdown("## Título", 40)[0]).toEqual([{ text: "Título", fg: "heading", bold: true }])
  })
})

describe("blocks and inline", () => {
  test("callouts carry a label in their colour and a rail; plain quotes nest", () => {
    const rows = draw("> [!WARNING]\n> Careful now\n\n> plain\n> > deeper", 40)
    expect(plain(rows)).toEqual(["┃ WARNING", "┃ Careful now", "", "│ plain", "│ │ deeper"])
    expect(rows[0]![1]).toMatchObject({ text: "WARNING", fg: "mdWarning", bold: true })
    expect(rows[1]![0]).toMatchObject({ fg: "mdWarning" })
    for (const [kind, role] of [["NOTE", "mdNote"], ["TIP", "mdTip"], ["IMPORTANT", "mdImportant"], ["CAUTION", "mdCaution"]] as const) expect(draw(`> [!${kind}]\n> x`, 30)[0]![1]).toMatchObject({ fg: role })
  })

  test("task lists show indicators and nested lists keep their levels", () => {
    const rows = draw("- [x] done\n- [ ] open\n- plain\n  - nested", 30, { copy: "off" })
    expect(plain(rows)).toEqual(["✓ done", "○ open", "• plain", "  ◦ nested"])
    expect(rows[0]![1]).toMatchObject({ fg: "mdTaskDone" })
    expect(rows[1]![1]).toMatchObject({ fg: "mdTaskOpen" })
  })

  test("strikethrough is struck, links are underlined and linked, footnotes are numbered", () => {
    const spans = inline("~~gone~~ [site](https://example.com) x[^1]", "body", {}, style())
    expect(spans.find((span) => span.text === "gone")).toMatchObject({ strike: true, fg: "mdStrike" })
    expect(spans.find((span) => span.text === "site")).toMatchObject({ underline: true, fg: "mdLink", link: "https://example.com" })
    expect(spans.find((span) => span.text === "¹")).toMatchObject({ fg: "mdFootnote" })
    expect(plain(draw("text[^note]\n\n[^note]: the body", 30))).toEqual(["text[note]", "", "[note] the body"])
    expect(plain(draw("[^1]: the body", 30))).toEqual(["¹ the body"])
    expect(inline("x[^1]", "body").map((span) => span.text).join("")).toBe("x[^1]")
  })

  test("a horizontal rule spans the width in the rule slot", () => {
    const [rule] = draw("---", 33)
    expect(rule).toEqual([{ text: "─".repeat(33), fg: "mdRule" }])
  })

  test("inline code takes the inline code slot", () => {
    expect(inline("`x`", "body", {}, style())[0]).toMatchObject({ fg: "mdInlineCode" })
    expect(inline("`x`", "body")[0]).toMatchObject({ fg: "code" })
  })
})

describe("copy affordances", () => {
  const BLOCKS = "- a\n- b\n- c\n- d\n\n> q1\n> q2\n> q3\n> q4\n\n| a | b |\n|---|---|\n| 1 | 2 |"
  const labels = (rows: Line[]) => visible(rows).map((region) => region.label)

  test("lists and quotes draw no header, no rail and no button: they render as plain Markdown", () => {
    const long = "- a\n- b\n- c\n- d\n- e"
    expect(plain(draw(long, 40))).toEqual(["• a", "• b", "• c", "• d", "• e"])
    expect(plain(draw(long, 40))).toEqual(plain(renderMarkdown(long, 40)))
    expect(plain(draw("> q1\n> q2\n> q3\n> q4", 40))).toEqual(["│ q1", "│ q2", "│ q3", "│ q4"])
    expect(labels(draw(`${long}\n\n> q1\n> q2\n> q3\n> q4`, 40))).toEqual([])
  })

  test("every row of a list or quote answers the copy key with the block's source", () => {
    const rows = draw("- a\n- b\n  - c\n- d\n\n> q1\n> q2\n> q3\n> q4", 40)
    const listRows = rows.slice(0, 4)
    const quoteRows = rows.slice(5)
    for (const row of listRows) expect(copyOf(row)).toEqual([{ from: 0, to: 0, text: "- a\n- b\n  - c\n- d", label: "list" }])
    for (const row of quoteRows) expect(copyOf(row)).toEqual([{ from: 0, to: 0, text: "q1\nq2\nq3\nq4", label: "quote" }])
  })

  test("a table's copy hint sits on its own top border, right-aligned to the table", () => {
    const rows = draw("| Name | Qty | Note |\n|---|---|---|\n| apple | 3 | fresh fruit |", 60)
    expect(plain(rows)).toEqual([
      "┌───────┬─────┬─────── copy ┐",
      "│ Name  │ Qty │ Note        │",
      "├───────┼─────┼─────────────┤",
      "│ apple │ 3   │ fresh fruit │",
      "└───────┴─────┴─────────────┘",
    ])
    const [button] = copyOf(rows[0]!)!
    expect(button).toMatchObject({ text: "| Name | Qty | Note |\n|---|---|---|\n| apple | 3 | fresh fruit |", label: "table" })
    expect(plain([rows[0]!])[0]!.slice(button!.from, button!.to)).toBe("copy")
    expect(spansOf([rows[0]!]).find((span) => span.text === "copy")).toMatchObject({ fg: "mdCopy" })
    expect(textWidth(plain(rows)[0]!)).toBe(textWidth(plain(rows)[1]!))
    expect(gutterOf(rows[0]!)).toBeGreaterThanOrEqual(30)
    expect(rows.slice(1).every((row) => copyOf(row)?.[0]?.to === 0)).toBe(true)
  })

  test("a table with no top border, a narrow one or a stacked one shows no hint and keeps the key", () => {
    const table = "| a | b |\n|---|---|\n| 1 | 2 |"
    for (const kind of ["rules", "minimal"] as const) {
      const rows = draw(table, 40, { table: kind })
      expect(visible(rows)).toEqual([])
      expect(copyOf(rows[0]!)?.[0]).toMatchObject({ text: table, label: "table" })
    }
    const narrow = draw(table, 40)
    expect(plain(narrow)[0]).toBe("┌───┬───┐")
    expect(visible(narrow)).toEqual([])
    expect(copyOf(narrow[0]!)?.[0]).toMatchObject({ text: table, label: "table" })
    const stacked = draw("| id | service | region | owner |\n|---|---|---|---|\n| 1 | gateway | us-east-1 | platform |", 14)
    expect(visible(stacked)).toEqual([])
    expect(copyOf(stacked[0]!)?.[0]).toMatchObject({ label: "table" })
  })

  test("grid tables carry the hint too, and no table adds a separate header row", () => {
    const rows = draw("| Name | Qty | Note |\n|---|---|---|\n| apple | 3 | fresh fruit |", 60, { table: "grid" })
    expect(plain(rows)[0]).toBe("┌───────┬─────┬─────── copy ┐")
    expect(plain(rows).some((row) => row.startsWith("╭"))).toBe(false)
  })

  test("the code scope draws hints on code only; the key still reaches tables and diagrams", () => {
    const source = `${BLOCKS}\n\n\`\`\`ts\nx\n\`\`\``
    expect(labels(draw(source, 40, { copy: "code" }))).toEqual(["ts code"])
    expect(labels(draw(source, 40, { copy: "all" }))).toEqual(["ts code"])
    const wide = "| Name | Qty | Note |\n|---|---|---|\n| apple | 3 | fresh fruit |"
    expect(labels(draw(wide, 60, { copy: "all" }))).toEqual(["table"])
    expect(labels(draw(wide, 60, { copy: "code" }))).toEqual([])
    expect(copyOf(draw(wide, 60, { copy: "code" })[0]!)?.[0]).toMatchObject({ label: "table" })
    expect(labels(renderMarkdown(source, 40))).toEqual([])
    expect(labels(draw(wide, 60, { copy: "off" }))).toEqual([])
  })

  test("a narrow width drops hints that do not fit instead of overflowing", () => {
    for (const width of [4, 8, 12, 16, 20]) {
      for (const row of draw("```text\nx\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |", width)) {
        expect(textWidth(plain([row])[0]!)).toBeLessThanOrEqual(width)
        for (const region of copyOf(row) ?? []) expect(region.to).toBeLessThanOrEqual(width)
      }
    }
  })

  test("a fenced block's rows all carry its source for the key", () => {
    const rows = draw("```ts\nconst a = 1\nconst b = 2\n```", 40)
    for (const row of rows) expect(copyOf(row)!.at(-1)).toMatchObject({ text: "const a = 1\nconst b = 2", label: "ts code" })
  })

  test("buttons inside an open <details> block keep their hit regions two cells to the right", () => {
    const rows = draw("<details open>\n<summary>S</summary>\n\n```ts\nx\n```\n\n</details>", 40)
    const header = rows.find((row) => copyOf(row))!
    const [button] = copyOf(header)!
    expect(plain([header])[0]!.slice(button!.from, button!.to)).toBe("copy")
  })
})

describe("diagrams", () => {
  const FENCE = (body: string) => `\`\`\`mermaid\n${body}\n\`\`\``
  const KINDS: Record<string, string> = {
    flowchart: "flowchart LR\n  A[Start] --> B{Ok?}\n  B -- yes --> C[Done]\n  B -- no --> D[Retry]",
    sequence: "sequenceDiagram\n  participant A\n  participant B\n  A->>B: hello\n  B-->>A: ok",
    state: "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy: go\n  Busy --> [*]",
    chart: 'xychart-beta\n  title "Per day"\n  x-axis [mon, tue, wed]\n  y-axis "n" 0 --> 100\n  bar [20, 55, 80]\n  line [20, 55, 80]',
    pie: 'pie title Pets\n  "Dogs" : 386\n  "Cats" : 85',
  }
  test("flowchart, sequence, state, bar/line charts and pie render sized to the width, with art and source buttons", () => {
    for (const [kind, body] of Object.entries(KINDS)) {
      for (const width of [60, 80, 120, 200]) {
        const rows = draw(FENCE(body), width)
        const text = plain(rows)
        expect(text.some((row) => row.startsWith("╭─")), kind).toBe(false)
        expect(text.some((row) => row.includes("loading diagram")), kind).toBe(false)
        for (const row of text) expect(textWidth(row), `${kind}@${width}`).toBeLessThanOrEqual(width)
        for (const row of rows) expect(copyOf(row)!.at(-1), kind).toMatchObject({ text: body, label: "diagram" })
        const hint = visible(rows)
        if (hint.length) {
          const [art, source] = hint
          expect(art).toMatchObject({ label: "diagram as drawn" })
          expect(source).toMatchObject({ text: body, label: "diagram" })
          expect(art!.text.split("\n").length, kind).toBeGreaterThan(3)
          expect(art!.text.split("\n").length, kind).toBeLessThanOrEqual(rows.length)
        }
      }
    }
  })

  test("the art and copy hint sit on the first row beside the diagram, only where those cells are blank", () => {
    const rows = draw(FENCE(KINDS.flowchart!), 80)
    const [art, source] = copyOf(rows[0]!)!
    expect(plain([rows[0]!])[0]!.slice(art!.from, art!.to)).toBe("art")
    expect(plain([rows[0]!])[0]!.slice(source!.from, source!.to)).toBe("copy")
    expect(gutterOf(rows[0]!)).toBeGreaterThanOrEqual(30)
    expect(visible(draw(FENCE(KINDS.flowchart!), 80, { copy: "code" }))).toEqual([])
    const crowded = draw(FENCE(KINDS.flowchart!), 30)
    expect(visible(crowded).every((region) => region.to <= 30)).toBe(true)
  })

  test("the classic style draws the diagram without a header", () => {
    const rows = renderMarkdown(FENCE(KINDS.flowchart!), 80)
    expect(plain(rows)[0]).not.toContain("╭")
    expect(rows.some((row) => copyOf(row))).toBe(false)
  })

  test("diagram lines use the diagram slots", () => {
    const spans = spansOf(draw(FENCE(KINDS.flowchart!), 80))
    expect(spans.some((span) => span.fg === "mdDiagramLine")).toBe(true)
    expect(spans.some((span) => span.fg === "heading")).toBe(false)
  })

  test("a diagram that cannot be drawn falls back to its source behind a header", () => {
    const rows = draw(FENCE("notADiagram\n  x"), 60)
    expect(plain(rows)[0]!.startsWith("╭─ notADiagram")).toBe(true)
    expect(plain(rows).join("\n")).toContain("│   x")
  })
})

describe("right-to-left text", () => {
  const HEBREW = "שלום עולם"
  test("the first strong letter picks the paragraph direction; digits and punctuation do not", () => {
    expect(firstStrong("123 ... שלום")).toBe("rtl")
    expect(firstStrong("Hello שלום")).toBe("ltr")
    expect(firstStrong("مرحبا")).toBe("rtl")
    expect(firstStrong("123 !?")).toBeUndefined()
  })

  test("a Hebrew row is reversed into visual order and an embedded Latin run stays readable", () => {
    const row = visualRow([{ text: "שלום MendCode עולם" }], "rtl")
    expect(row.map((span) => span.text).join("")).toBe("םלוע MendCode םולש")
  })

  test("numbers keep their digit order inside right-to-left text", () => {
    expect(visualRow([{ text: "שלום 2024 עולם" }], "rtl").map((span) => span.text).join("")).toBe("םלוע 2024 םולש")
    expect(visualRow([{ text: "שלום 1,234.5 עולם" }], "rtl").map((span) => span.text).join("")).toBe("םלוע 1,234.5 םולש")
  })

  test("brackets mirror and a trailing full stop lands on the left", () => {
    expect(visualRow([{ text: "שלום (עולם)." }], "rtl").map((span) => span.text).join("")).toBe(".(םלוע) םולש")
  })

  test("a left-to-right paragraph with a Hebrew run reorders only the run and is not aligned", () => {
    const rows = draw("Say שלום עולם now", 40)
    expect(plain(rows)).toEqual(["Say םלוע םולש now"])
  })

  test("right-to-left paragraphs are right-aligned to the width, with the blanks as chrome", () => {
    const rows = draw(HEBREW, 20)
    expect(plain(rows)).toEqual([`${" ".repeat(11)}םלוע םולש`])
    expect(gutterOf(rows[0]!)).toBe(11)
    expect(textWidth(plain(rows)[0]!)).toBe(20)
  })

  test("wrapped right-to-left rows each align right and keep every character", () => {
    const rows = draw(`${HEBREW} `.repeat(6).trim(), 20)
    expect(rows.length).toBeGreaterThan(1)
    for (const row of plain(rows)) expect(textWidth(row)).toBe(20)
    expect(plain(rows).join("").replaceAll(" ", "").length).toBe(`${HEBREW}`.repeat(6).replaceAll(" ", "").length)
  })

  test("right-to-left list items and quotes hang from the right edge", () => {
    expect(plain(draw("- שלום\n  - עולם", 20))).toEqual([`${" ".repeat(14)}םולש •`, `${" ".repeat(12)}םלוע ◦`])
    expect(plain(draw("> שלום", 12))).toEqual([`${" ".repeat(6)}םולש │`])
  })

  test("arabic follows the same rule and pure Latin rows are returned untouched", () => {
    expect(visualRow([{ text: "مرحبا بالعالم" }], "rtl").map((span) => span.text).join("")).toBe([..."مرحبا بالعالم".split(" ")].reverse().map((word) => [...word].reverse().join("")).join(" "))
    const latin = [{ text: "plain text" }]
    expect(visualRow(latin, "ltr")).toBe(latin)
    expect(alignRight(latin, 4)).toBe(latin)
  })

  test("markdownRtl off leaves the logical order and the left edge", () => {
    expect(plain(draw(HEBREW, 20, { rtl: false }))).toEqual([HEBREW])
  })

  test("styles survive the reorder: a bold Latin run inside Hebrew stays bold", () => {
    const row = visualRow([{ text: "שלום " }, { text: "Mend", bold: true }, { text: " עולם" }], "rtl")
    expect(row.find((span) => span.text === "Mend")).toMatchObject({ bold: true })
  })
})

describe("theme slots", () => {
  test("every slot of the enhanced style is a colour role and every bundled theme defines it", () => {
    for (const role of Object.values(ENHANCED_ROLES)) expect(COLOR_NAMES, role).toContain(role)
    for (const theme of THEMES) for (const role of MARKDOWN_COLOR_ROLES) expect(theme.colors[role], `${theme.name}.${role}`).toMatch(/^#[0-9a-f]{6}$/i)
  })

  test("a theme that omits them derives the slots from its base roles, and may set any", () => {
    const dracula = THEMES.find((theme) => theme.name === "dracula")!
    expect(dracula.colors.mdHeading1).toBe(dracula.colors.heading)
    expect(dracula.colors.mdTableBorder).toBe(dracula.colors.border)
    expect(dracula.colors.synPrompt).toBe(dracula.colors.muted)
  })

  test("an override replaces one role in the SGR output and nothing else", () => {
    const before = sgr({ text: "x", fg: "mdHeading1" }, "truecolor")
    const other = sgr({ text: "x", fg: "mdHeading2" }, "truecolor")
    setColorOverrides({ mdHeading1: "#123456", mdBogus: "#ffffff", mdHeading2: "red" })
    expect(sgr({ text: "x", fg: "mdHeading1" }, "truecolor")).toBe("\x1b[38;2;18;52;86m")
    expect(sgr({ text: "x", fg: "mdHeading2" }, "truecolor")).toBe(other)
    expect(colorOverrides()).toEqual({ mdHeading1: "#123456" })
    setColorOverrides({})
    expect(sgr({ text: "x", fg: "mdHeading1" }, "truecolor")).toBe(before)
  })

  test("the terminal theme keeps its own palette: overrides do not reach it", () => {
    setTheme("terminal")
    const before = sgr({ text: "x", fg: "mdHeading1" }, "truecolor")
    setColorOverrides({ mdHeading1: "#123456" })
    expect(sgr({ text: "x", fg: "mdHeading1" }, "truecolor")).toBe(before)
  })
})

describe("profile settings", () => {
  test("defaults, normalisation and validation agree between the terminal profile and the wire contract", () => {
    for (const key of ["tableStyle", "headingStyle", "markdownCopyHints", "markdownRtl", "markdownColors"] as const) expect(TUI_DEFAULTS[key], key).toBe(DEFAULT_TUI_PROFILE[key])
    expect(normalizeTuiProfile({ tableStyle: "grid", headingStyle: "banner", markdownCopyHints: "code", markdownRtl: false })).toMatchObject({ tableStyle: "grid", headingStyle: "banner", markdownCopyHints: "code", markdownRtl: false })
    expect(normalizeTuiProfile({ tableStyle: "round", headingStyle: 3, markdownCopyHints: "x" })).toMatchObject({ tableStyle: "auto", headingStyle: "auto", markdownCopyHints: "auto" })
    expect(tuiProblems({ tableStyle: "round" })).toEqual(["tableStyle: expected auto|box|rules|grid|minimal"])
    expect(tuiProblems({ tableStyle: "rules", headingStyle: "uppercase", markdownCopyHints: "off", markdownRtl: false })).toEqual([])
  })

  test("markdownColors keeps valid roles only and the wire contract names the first bad one", () => {
    const text = JSON.stringify({ mdHeading1: "#ABCDEF", synKeyword: "#112233", nope: "#ffffff", mdRule: "blue" })
    expect(JSON.parse(normalizeTuiProfile({ markdownColors: text }).markdownColors)).toEqual({ mdHeading1: "#abcdef", synKeyword: "#112233" })
    expect(normalizeTuiProfile({ markdownColors: "not json" }).markdownColors).toBe("")
    expect(parseMarkdownColors(text).error).toBe("unknown role: nope")
    expect(tuiProblems({ markdownColors: text })).toEqual(["markdownColors: unknown role: nope"])
    expect(tuiProblems({ markdownColors: JSON.stringify({ mdRule: "blue" }) })).toEqual(["markdownColors: mdRule must be #rrggbb"])
    expect(tuiProblems({ markdownColors: JSON.stringify({ mdRule: "#abc123" }) })).toEqual([])
  })
})

describe("the torture document", () => {
  test("never passes the width in any style, at any width", () => {
    for (const width of [20, 40, 80, 120, 200]) {
      for (const table of ["box", "grid", "rules", "minimal"] as const) {
        for (const heading of ["banner", "bold", "underline", "uppercase"] as const) {
          for (const row of plain(draw(TORTURE, width, { table, heading }))) expect(textWidth(row), `${table}/${heading}@${width}: ${row}`).toBeLessThanOrEqual(width)
        }
      }
    }
  })
})
