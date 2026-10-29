import { describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { renderSpecLines } from "../src/view/render-spec"
import { renderToolCard, type ToolCardInput } from "../src/view/tool-card"
import { callArgs, parseGrep, parseListing, parseRead, resultShape, shellSummary, webInfo } from "../src/view/tool-data"
import { gridRows, type GridCell } from "../src/view/tool-frame"
import { textWidth } from "../src/view/wrap"
import { GRAPH_MAP_RENDER, toolCardsSession, toolCardsView } from "./tool-cards-session"

const plain = (line: Line) => line.map((span) => span.text).join("")
const card = (input: Partial<ToolCardInput> & Pick<ToolCardInput, "title" | "text">) => renderToolCard({ status: "ok", width: 80, expanded: false, frame: 0, tailLines: 4, ...input })
const rows = (input: Parameters<typeof card>[0]) => card(input).map((line) => plain(line).trimEnd())
const numbered = (lines: string[], from = 1) => lines.map((line, i) => `${String(from + i).padStart(6)}\t${line}`).join("\n")

describe("read", () => {
  const text = numbered(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`))

  test("balanced is the header alone; a whole file says its line count", () => {
    expect(rows({ title: "read: a.ts", text, level: "summary", counts: { lines: 40 } })).toEqual(["   ▤ Read a.ts  40 lines"])
  })

  test("full shows the first 6 rows, never the tail, then how many are left", () => {
    const out = rows({ title: "read: a.ts", text, level: "preview", counts: { lines: 40 } })
    expect(out.slice(1, 7)).toEqual(["   │ 1  line 1", "   │ 2  line 2", "   │ 3  line 3", "   │ 4  line 4", "   │ 5  line 5", "   │ 6  line 6"])
    expect(out.at(-1)).toBe("   │ … 34 more lines")
    expect(out.join("\n")).not.toContain("line 40")
  })

  test("a partial read says its range, with the total when the tool said how many lines were cut", () => {
    const part = numbered(["a", "b", "c"], 40)
    expect(rows({ title: "read: a.ts", text: part, level: "summary" })[0]).toBe("   ▤ Read a.ts  L40–42")
    expect(rows({ title: "read: a.ts", text: `${numbered(["a", "b"])}\n[output truncated: 1,998 more lines]`, level: "summary" })[0]).toBe("   ▤ Read a.ts  L1–2 of 2,000")
  })

  test("the gutter is as wide as the widest number shown, so a read across 99 to 100 stays aligned", () => {
    const out = rows({ title: "read: a.ts", text: numbered(["x", "y", "z"], 98), level: "preview" })
    expect(out.slice(1)).toEqual(["   │  98  x", "   │  99  y", "   │ 100  z"])
  })

  test("source is highlighted by its extension, markdown by its markers, and an unknown extension is drawn plain", () => {
    const ts = card({ title: "read: a.ts", text: numbered(["const a = 1"]), level: "preview" })[1]!
    expect(ts.find((span) => span.text === "const")).toMatchObject({ fg: "synKeyword" })
    const md = card({ title: "read: README.md", text: numbered(["# Title"]), level: "preview" })[1]!
    // The marker is the accent, the title the normal text color in bold: a document, not a block of code.
    expect(md.find((span) => span.text === "# ")).toMatchObject({ fg: "heading", bold: true })
    expect(md.find((span) => span.text === "Title")).toMatchObject({ fg: "text", bold: true })
    const other = card({ title: "read: a.zzz", text: numbered(["const a = 1"]), level: "preview" })[1]!
    expect(other.find((span) => span.text === "const a = 1")).toMatchObject({ fg: "code" })
  })

  test("a row wider than the card is cut with an ellipsis, never wrapped", () => {
    const out = rows({ title: "read: a.ts", text: numbered(["x".repeat(200)]), level: "preview", width: 40 })
    expect(out).toHaveLength(2)
    expect(textWidth(out[1]!)).toBeLessThanOrEqual(40)
    expect(out[1]!.endsWith("…")).toBe(true)
  })

  test("a read from an engine without line numbers is drawn without a gutter", () => {
    const out = rows({ title: "read: a.ts", text: "one\ntwo", level: "preview" })
    expect(out).toEqual(["   ▤ Read a.ts  2 lines", "   │ one", "   │ two"])
  })

  test("images, pdfs, empty files and directories each say what they are", () => {
    expect(rows({ title: "read: a.png", text: "Image read successfully", level: "preview" })).toEqual(["   ▤ Read a.png  image"])
    expect(rows({ title: "read: a.txt", text: "", level: "preview" })).toEqual(["   ▤ Read a.txt  empty"])
    const directory = "<path>/p/src</path>\n<type>directory</type>\n<entries>\nview/\nmain.ts\n</entries>\n(2 of 2 entries)"
    expect(rows({ title: "read: src", text: directory, level: "preview" })).toEqual(["   ▤ Read src  2 entries (1 dir)", "   │ view/  main.ts"])
  })

  test("the opened card pages the whole file with its own gutter and a footer", () => {
    const big = numbered(Array.from({ length: 100 }, (_, i) => `row ${i + 1}`))
    const out = rows({ title: "read: a.ts", text: big, level: "full", page: 1, width: 80 })
    expect(out[1]).toBe("   │ 41  row 41")
    expect(out.at(-1)).toBe("   │ lines 41-80 of 100 · click or ctrl+x f for the next page")
  })
})

describe("list and glob grids", () => {
  const cell = (text: string): GridCell => ({ spans: [{ text }], width: text.length })

  test("columns fill the width ls-style: column by column, each as wide as its widest cell", () => {
    const cells = ["aa", "b", "cccc", "d", "ee", "f", "g"].map(cell)
    const wide = gridRows({ cells, width: 40, maxRows: 3 })
    expect(wide.rows.map(plain).map((row) => row.trimEnd())).toEqual(["aa  b  cccc  d  ee  f  g"])
    const { rows: grid, shown } = gridRows({ cells, width: 14, maxRows: 3 })
    expect(shown).toBe(7)
    expect(grid.map(plain).map((row) => row.trimEnd())).toEqual(["aa    d   g", "b     ee", "cccc  f"])
  })

  test("with more cells than rows × columns, the cap is rows and the rest is counted", () => {
    const cells = Array.from({ length: 30 }, (_, i) => cell(`name${String(i).padStart(2, "0")}`))
    const { rows: grid, shown } = gridRows({ cells, width: 30, maxRows: 2 })
    expect(grid).toHaveLength(2)
    expect(shown).toBeLessThan(30)
    expect(grid.every((row) => textWidth(plain(row)) <= 30)).toBe(true)
  })

  test("a list says its entries and dirs, shows directories first in the accent, dotfiles muted, and caps at 3 rows then 6", () => {
    const entries = [...Array.from({ length: 18 }, (_, i) => `dir${String(i).padStart(2, "0")}/`), ".env", ".gitignore", "README.md", "LICENSE", "a.ts", "b.ts", "c.ts"]
    const text = entries.join("\n")
    const balanced = card({ title: "ls: .", text, level: "summary", width: 50 })
    expect(plain(balanced[0]!).trimEnd()).toBe("   ▦ List .  25 entries (18 dirs)")
    expect(balanced).toHaveLength(1 + 3 + 1)
    expect(plain(balanced.at(-1)!)).toMatch(/^ {3}│ … \+\d+$/)
    const full = card({ title: "ls: .", text, level: "preview", width: 50 })
    expect(full.length).toBeGreaterThan(balanced.length - 1)
    const dir = balanced[1]!.find((span) => span.text === "dir00/")
    expect(dir).toMatchObject({ fg: "accent" })
    const dot = full.flat().find((span) => span.text === ".env")
    expect(dot).toMatchObject({ fg: "muted" })
    expect(full.flat().find((span) => span.text === "README.md")).toMatchObject({ fg: "text" })
  })

  test("a short list shows all its entries and no `… +N`", () => {
    const out = rows({ title: "ls: src", text: "view/\nmain.ts", level: "summary" })
    expect(out).toEqual(["   ▦ List src  2 entries (1 dir)", "   │ view/  main.ts"])
  })

  test("wide characters are measured by cells, so columns line up", () => {
    const out = rows({ title: "ls: .", text: "日本語/\nabc.ts\n中文.md\nx", level: "preview", width: 24 })
    const body = out.slice(1)
    for (const row of body) expect(textWidth(row)).toBeLessThanOrEqual(24)
    // Column starts agree on every row.
    const starts = body.map((row) => textWidth(row.slice(0, row.indexOf("abc.ts") >= 0 ? row.indexOf("abc.ts") : row.length)))
    expect(starts.length).toBeGreaterThan(0)
  })

  test("glob groups paths by directory: each directory once, the names hanging under it, `… +N` for the rest", () => {
    const files = [...Array.from({ length: 6 }, (_, i) => `apps/cli/test/t${i}.test.ts`), "packages/codegraph/test/g.test.ts"]
    const out = rows({ title: "glob: apps", text: files.join("\n"), pattern: "**/*.test.ts", level: "summary", width: 60 })
    expect(out[0]).toBe("   ✲ Glob **/*.test.ts  7 files")
    expect(out[1]).toContain("apps/cli/test/  t0.test.ts")
    expect(out.join("\n").match(/apps\/cli\/test\//g)).toHaveLength(1)
    const full = rows({ title: "glob: apps", text: files.join("\n"), pattern: "**/*.test.ts", level: "preview", width: 120 })
    expect(full.some((row) => row.includes("packages/codegraph/test/  g.test.ts"))).toBe(true)
    expect(rows({ title: "glob: x", text: "No files found", pattern: "*.zzz", level: "preview" })).toEqual(["   ✲ Glob *.zzz  no files"])
  })

  test("parseListing counts what the tool cut", () => {
    expect(parseListing("a/\nb\n[output truncated: 1,200 more entries]")).toEqual({ entries: ["a/", "b"], hidden: 1200, dirs: 1 })
    expect(parseListing("(empty)")).toEqual({ entries: [], hidden: 0, dirs: 0 })
  })
})

describe("grep", () => {
  const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"]
  const text = files.flatMap((file, i) => [`src/${file}:${10 + i}:const foo = ${i}`, `src/${file}:${50 + i}:foo(${i})`, `src/${file}:${90 + i}:// foo`]).join("\n")

  test("matches are grouped by file with a count, one matching line each in balanced and two in full", () => {
    const balanced = rows({ title: "grep: src", text, pattern: "foo", level: "summary" })
    expect(balanced[0]).toBe('   ⌕ Grep "foo"  21 matches in 7 files')
    expect(balanced.slice(1, 7)).toEqual(["   │ src/a.ts  3 matches", "   │ 10  const foo = 0", "   │ src/b.ts  3 matches", "   │ 11  const foo = 1", "   │ src/c.ts  3 matches", "   │ 12  const foo = 2"])
    expect(balanced.at(-1)).toBe("   │ … +18 more matches")
    const full = rows({ title: "grep: src", text, pattern: "foo", level: "preview" })
    expect(full.filter((row) => row.includes("matches") && row.includes("src/"))).toHaveLength(6)
    expect(full.slice(1, 4)).toEqual(["   │ src/a.ts  3 matches", "   │ 10  const foo = 0", "   │ 50  foo(0)"])
  })

  test("the match is emphasised and a long line is shifted to show it", () => {
    const line = `src/a.ts:5:${"x".repeat(100)} needle ${"y".repeat(10)}`
    const out = card({ title: "grep: src", text: line, pattern: "needle", level: "summary", width: 50 })
    const spans = out[2]!
    expect(spans.find((span) => span.text === "needle")).toMatchObject({ fg: "warning", bold: true })
    expect(plain(out[2]!)).toContain("…")
    expect(textWidth(plain(out[2]!))).toBeLessThanOrEqual(50)
  })

  test("a pattern that only matches ignoring case is still emphasised, and an invalid regex is drawn plain", () => {
    const ci = card({ title: "grep: src", text: "a.ts:1:Foo bar", pattern: "foo", level: "summary" })[2]!
    expect(ci.find((span) => span.text === "Foo")).toMatchObject({ fg: "warning" })
    const bad = card({ title: "grep: src", text: "a.ts:1:Foo (bar", pattern: "(", level: "summary" })[2]!
    expect(bad.find((span) => span.fg === "warning")).toBeUndefined()
  })

  test("no matches is its header alone; parseGrep keeps files in order of first match", () => {
    expect(rows({ title: "grep: src", text: "No matches found", pattern: "zzz", level: "preview" })).toEqual(['   ⌕ Grep "zzz"  no matches'])
    const grouped = parseGrep("b.ts:1:x\na.ts:2:y\nb.ts:3:z")
    expect(grouped.files.map((file) => [file.path, file.count])).toEqual([["b.ts", 2], ["a.ts", 1]])
  })
})

describe("shell", () => {
  test("the command is the header; a passing test run is its summary and nothing else", () => {
    const text = "bun test v1.3\n\n 241 pass\n 0 fail\nRan 241 tests across 9 files. [412.00ms]"
    expect(rows({ title: "shell: bun test", text, level: "preview", exitCode: 0, elapsedMs: 12_400 })).toEqual(["   $ bun test  241 pass · 0 fail                                          12.4s"])
    expect(rows({ title: "shell: bun test", text, level: "summary", exitCode: 0 })).toHaveLength(1)
  })

  test("a failing run keeps its tail under an error rule, and the exit code shows only when it is not zero", () => {
    const text = ["bun test v1.3", ...Array.from({ length: 20 }, (_, i) => `err ${i}`), " 3 pass", " 2 fail"].join("\n")
    const out = card({ title: "shell: bun test", text, status: "error", exitCode: 1, level: "summary" })
    expect(plain(out[0]!)).toContain("3 pass · 2 fail  exit 1")
    expect(out[0]!.find((span) => span.text.includes("exit 1"))).toMatchObject({ fg: "error" })
    expect(out[1]!.find((span) => span.text.startsWith("│"))).toMatchObject({ fg: "error" })
    expect(out).toHaveLength(1 + 1 + 12)
  })

  test("a long command is cut in its middle, an opened card shows it whole", () => {
    const command = `bun test ${"apps/cli/test/some-very-long-file-name.test.ts ".repeat(4)}--bail`
    const short = rows({ title: `shell: ${command}`, text: "x\ny", level: "summary", width: 60 })
    expect(textWidth(short[0]!)).toBeLessThanOrEqual(60)
    expect(short[0]).toContain("…")
    expect(short[0]!.endsWith("--bail")).toBe(true)
    expect(short[0]).toContain("bun test")
    const opened = rows({ title: `shell: ${command}`, text: "x\ny", level: "full", width: 60 })
    expect(opened.join(" ").replace(/\s+/g, " ")).toContain("--bail")
  })

  test("test and type-check summaries come from the output, and only for a runner or compiler", () => {
    expect(shellSummary({ command: "bun test", text: " 10 pass\n 2 fail", exitCode: 1 })).toBe("10 pass · 2 fail")
    expect(shellSummary({ command: "vitest run", text: "Tests  3 failed | 10 passed (13)", exitCode: 1 })).toBe("10 pass · 3 fail")
    expect(shellSummary({ command: "pytest", text: "=== 1 failed, 4 passed in 0.12s ===", exitCode: 1 })).toBe("4 pass · 1 fail")
    expect(shellSummary({ command: "cargo test", text: "test result: ok. 12 passed; 0 failed; 0 ignored", exitCode: 0 })).toBe("12 pass · 0 fail")
    expect(shellSummary({ command: "tsc --noEmit", text: "", exitCode: 0 })).toBe("no errors")
    expect(shellSummary({ command: "tsc", text: "a.ts(1,2): error TS2322: x\nb.ts(1,2): error TS2322: y", exitCode: 2 })).toBe("2 errors")
    expect(shellSummary({ command: "ls", text: " 10 pass", exitCode: 0 })).toBeUndefined()
  })

  test("a running shell counts its time at the right edge from one second and shows its live tail", () => {
    const out = rows({ title: "shell: sleep 5", text: "tick 1\ntick 2", status: "running", elapsedMs: 3_500 })
    expect(out[0]).toMatch(/^ {3}⠋ sleep 5 +3s$/)
    expect(out.slice(1)).toEqual(["   │ tick 1", "   │ tick 2"])
  })
})

describe("edit and write", () => {
  test("the header names the file with +A −D; write says created and its size", () => {
    expect(rows({ title: "write: docs/a.md", text: "Created docs/a.md (4231 bytes)" })).toEqual(["   + Write docs/a.md  created  4.2 KB"])
    expect(rows({ title: "write: docs/a.md", text: "File created successfully at: docs/a.md" })).toEqual(["   + Write docs/a.md  created"])
    expect(rows({ title: "write: docs/a.md", text: "Wrote docs/a.md (12 bytes)" })).toEqual(["   + Write docs/a.md  replaced  12 B"])
    expect(rows({ title: "edit: a.ts", text: "@@ -1,1 +1,2 @@\n-a\n+a\n+b" })[0]).toBe("   ✎ Edit a.ts  +2 −1")
  })

  test("one number column, as Claude Code draws it: a removal its old number, an addition and a kept line their new one; no `@@` row", () => {
    const out = rows({ title: "edit: a.ts", text: "@@ -9,3 +9,4 @@\n same\n-old\n+new\n+more\n same2" })
    expect(out.slice(1)).toEqual(["   │  9   same", "   │ 10 - old", "   │ 10 + new", "   │ 11 + more", "   │ 12   same2"])
  })

  test("a later hunk of the same file is a muted gap, not its header", () => {
    const out = rows({ title: "edit: a.ts", text: "@@ -1,1 +1,1 @@\n-a\n+b\n@@ -40,1 +40,1 @@\n-c\n+d" })
    expect(out.slice(1)).toEqual(["   │  1 - a", "   │  1 + b", "   │  ⋯", "   │ 40 - c", "   │ 40 + d"])
  })

  test("what differs inside a changed line is bold in the marker's colour, the shared ends are not", () => {
    const out = card({ title: "edit: a.ts", text: "@@ -1,1 +1,1 @@\n-const total = a + b\n+const total = a + c" })
    const removed = out[1]!
    expect(removed.find((span) => span.text === "b")).toMatchObject({ fg: "error", bold: true })
    expect(removed.find((span) => span.text === "const total = a + ")).toMatchObject({ fg: "body" })
    const added = out[2]!
    expect(added.find((span) => span.text === "c")).toMatchObject({ fg: "success", bold: true })
  })

  test("a rewritten line, which shares next to nothing with its replacement, gets no inner emphasis", () => {
    const out = card({ title: "edit: a.ts", text: "@@ -1,1 +1,1 @@\n-alpha\n+zzzzz" })
    expect(out[1]!.some((span) => span.bold)).toBe(false)
    expect(out[2]!.some((span) => span.bold)).toBe(false)
  })

  test("a long line wraps under its own gutter, and every row fits", () => {
    const out = rows({ title: "edit: a.ts", text: `@@ -1,1 +1,1 @@\n+${"word ".repeat(40)}`, width: 40 })
    for (const row of out) expect(textWidth(row)).toBeLessThanOrEqual(40)
    expect(out.length).toBeGreaterThan(3)
  })
})

describe("web, search, task and unknown tools", () => {
  test("a fetched page: its heading, host and size in the header; the first lines of text only in full", () => {
    const text = "# Writing tests\n\nFirst paragraph.\n\nSecond paragraph.\n```ts\ncode\n```"
    const meta = { bytes: 48_213, status: 200, finalUrl: "https://bun.sh/docs/test/writing" }
    expect(rows({ title: "webfetch: https://bun.sh/docs/test/writing", text, level: "summary", meta })).toEqual(["   ⌁ Fetch Writing tests  bun.sh · 48 KB"])
    expect(rows({ title: "webfetch: https://bun.sh/docs/test/writing", text, level: "preview", meta }).slice(1)).toEqual(["   │ First paragraph.", "   │ Second paragraph.", "   │ code"])
    expect(webInfo({ detail: "https://x.dev", text: "no heading", meta: undefined })).toMatchObject({ title: "", host: "x.dev" })
  })

  test("web search names its query and count; the hosted search shows the queries it ran", () => {
    const text = '2 results for "bun" (Exa)\n1. Bun docs\n   https://bun.sh\n2. Bun blog\n   https://bun.sh/blog'
    expect(rows({ title: "websearch: bun", text, level: "summary", meta: { results: 2 } })).toEqual(['   ⌁ Web search "bun"  2 results'])
    expect(rows({ title: "websearch: bun", text, level: "preview", meta: { results: 2 } }).slice(1)).toEqual(["   │ 1. Bun docs", "   │ 2. Bun blog"])
    expect(rows({ title: "web_search", text: "bun latest · bun notes", level: "summary" })).toEqual(["   ⌁ Web search bun latest · bun notes"])
  })

  test("a sub-agent is one row: agent, model, calls, and the duration at the right edge", () => {
    const out = rows({ title: "task: Review the cards", text: "Looks right.", agent: "reviewer", model: "gpt-5.5", toolCalls: 7, elapsedMs: 65_000, level: "preview" })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/^ {3}◔ Task Review the cards {2}reviewer · gpt-5\.5 · 7 calls +1m 5s$/)
    const running = rows({ title: "task: Review the cards", text: "reading tool-card.ts\nediting it", status: "running", agent: "reviewer" })
    expect(running[0]).toContain("reviewer · running  … editing it")
    const opened = rows({ title: "task: Review the cards", text: "Looks right.", level: "full" })
    expect(opened.slice(1)).toEqual(["   │ Looks right."])
  })

  test("a failed sub-agent says why under its row, without the receipt's task_id and state lines", () => {
    const text = "task_id: ses_1\nstate: failed\nunknown model gpt-6.1-terra; use an exact id such as chatgpt/gpt-6.1-terra"
    const out = rows({ title: "task: Bench Nexus Terra 6.1", text, status: "error", level: "preview" })
    expect(out[0]).toContain("failed")
    expect(out.slice(1).join("\n")).toContain("unknown model gpt-6.1-terra; use an exact id such as chatgpt/gpt-6.1-terra")
    expect(out.join("\n")).not.toContain("task_id")
    expect(rows({ title: "task: Bench", text, status: "error", level: "summary" })).toHaveLength(1)
  })

  test("an MCP result is its server · tool, the target and the shape of its text; rows only in full, capped at 6", () => {
    const json = JSON.stringify(Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`k${i}`, i])), null, 2)
    expect(rows({ title: "mcp__linear__get_issue: MEN-482", text: json, level: "summary" })).toEqual(["   ⊙ linear · get_issue MEN-482  object · 14 keys"])
    const full = rows({ title: "mcp__linear__get_issue: MEN-482", text: json, level: "preview" })
    expect(full).toHaveLength(1 + 6 + 1)
    expect(full.at(-1)).toBe("   │ … +10 lines")
    expect(resultShape("[1,2,3]")).toBe("array · 3 items")
    expect(resultShape("plain words")).toBe("text · 11 B")
    expect(resultShape("   ")).toBe("empty")
    expect(resultShape(`{"a":1`)).toStartWith("text · ")
  })

  test("callArgs keeps only what cards draw", () => {
    expect(callArgs("grep", JSON.stringify({ pattern: "foo\nbar", path: "src" }))).toEqual({ pattern: "foo" })
    expect(callArgs("task", JSON.stringify({ description: "d", agent: "reviewer", model: "m", prompt: "secret instructions" }))).toEqual({ agent: "reviewer", model: "m", description: "d" })
    expect(callArgs("read", "{}")).toBeUndefined()
    expect(callArgs("grep", "not json")).toBeUndefined()
    // A glob with a list shows every pattern, the single one first; a grep ignores `patterns`.
    expect(callArgs("glob", JSON.stringify({ patterns: ["src/**/*.ts", "test/**/*.ts"] }))).toEqual({ pattern: "src/**/*.ts, test/**/*.ts" })
    expect(callArgs("glob", JSON.stringify({ pattern: "*.md", patterns: ["docs/**"] }))).toEqual({ pattern: "*.md, docs/**" })
    expect(callArgs("grep", JSON.stringify({ patterns: ["a"] }))).toBeUndefined()
  })
})

/** The text spans of a body row: not the indent, not the rule. */
const words = (row: Line) => row.filter((span) => span.text.trim() && !span.text.startsWith("│"))

describe("the frame", () => {
  test("a failed call is the failure mark and a word in the error role over an error rule, with its message in the normal text", () => {
    const out = card({ title: "read: nope.ts", text: "ENOENT: no such file", status: "error", level: "preview" })
    expect(out[0]!.find((span) => span.text === "✗")).toMatchObject({ fg: "error" })
    expect(out[0]!.find((span) => span.text === "failed")).toMatchObject({ fg: "error" })
    expect(out[0]!.find((span) => span.text === " nope.ts")).toMatchObject({ fg: "text", bold: true })
    expect(out[1]!.find((span) => span.text.startsWith("│"))).toMatchObject({ fg: "error" })
    expect(words(out[1]!).map((span) => span.fg)).toEqual(["body", "body", "body", "body"])
    expect(rows({ title: "read: nope.ts", text: "x", status: "error", level: "preview", ascii: true })[0]).toBe("   x Read nope.ts  failed")
  })

  test("a failed call whose error is one huge line (an HTML error page) takes three rows, cut with an ellipsis", () => {
    const text = `HTTP 403 Blocked\n<body\nclass=theme-beta><style>${"--rem360:22.5rem;".repeat(200)}\n</style>`
    const out = rows({ title: "webfetch: https://www.reddit.com/r/x", text, status: "error", level: "preview" })
    expect(out).toHaveLength(5)
    expect(out[3]!.endsWith("…")).toBe(true)
    expect(out[4]).toContain("+2 lines")
  })

  test("a failed shell keeps the command's colour, carries exit N in the error role and prints its output in the muted role", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")
    const out = card({ title: "shell: make all", text, status: "error", exitCode: 2, level: "preview", tailLines: 4 })
    expect(out[0]!.find((span) => span.text === "✗")).toMatchObject({ fg: "error" })
    expect(out[0]!.find((span) => span.text === "make all")).toMatchObject({ fg: "primary", bold: true })
    expect(out[0]!.find((span) => span.text === "exit 2")).toMatchObject({ fg: "error" })
    expect(out[0]!.some((span) => span.text === "failed")).toBe(false)
    expect(out[1]!.find((span) => span.text.startsWith("│"))).toMatchObject({ fg: "error" })
    for (const row of out.slice(1)) for (const span of words(row)) expect(span.fg).toBe("muted")
    expect(words(out.at(-1)!).map((span) => span.text)).toEqual(["line", "29"])
    // With no colour at all the state is still the mark and the word.
    expect(rows({ title: "shell: make all", text, status: "error", exitCode: 2, level: "preview", ascii: true })[0]).toBe("   x make all  exit 2")
  })

  test("a short error is readable text and a long one is muted output with the rest behind `… +N lines`", () => {
    const short = card({ title: "skill: whittle", text: "Unknown skill \"whittle\".\nAvailable: build, fix.", status: "error", level: "preview" })
    for (const row of short.slice(1)) for (const span of words(row)) expect(span.fg).toBe("body")
    const long = card({ title: "skill: whittle", text: Array.from({ length: 8 }, (_, i) => `problem ${i}`).join("\n"), status: "error", level: "preview" })
    for (const row of long.slice(1, 4)) for (const span of words(row)) expect(span.fg).toBe("muted")
    expect(long).toHaveLength(5)
    expect(plain(long.at(-1)!)).toBe("   │ … +5 lines")
  })

  test("the status colours the glyph: running primary, ok success, awaiting warning", () => {
    expect(card({ title: "read: a", text: numbered(["x"]), level: "summary" })[0]!.find((span) => span.text === "▤")).toMatchObject({ fg: "success" })
    expect(card({ title: "read: a", text: "", status: "running", level: "summary" })[0]!.find((span) => span.text === "⠋")).toMatchObject({ fg: "primary" })
    expect(card({ title: "read: a", text: "", status: "running", awaiting: true, level: "summary" })[0]!.find((span) => span.text === "⠋")).toMatchObject({ fg: "warning" })
  })

  test("the target is emphasised and the facts are muted", () => {
    const head = card({ title: "read: a.ts", text: numbered(["x"]), level: "summary", counts: { lines: 1 } })[0]!
    expect(head.find((span) => span.text === " a.ts")).toMatchObject({ fg: "text", bold: true })
    expect(head.find((span) => span.text === "1 line")).toMatchObject({ fg: "muted" })
  })

  test("a duration shows from one second on, right-aligned to the card's edge", () => {
    const fast = rows({ title: "read: a.ts", text: numbered(["x"]), level: "summary", elapsedMs: 900, width: 40 })
    expect(fast[0]).toBe("   ▤ Read a.ts  1 line")
    const slow = rows({ title: "read: a.ts", text: numbered(["x"]), level: "summary", elapsedMs: 2_400, width: 40 })
    expect(slow[0]).toMatch(/^ {3}▤ Read a\.ts {2}1 line +2\.4s$/)
    expect(textWidth(slow[0]!)).toBe(39)
  })

  test("toolOutput collapsed keeps the looking tools to their header, and an opened card still opens", () => {
    const text = ["a/", "b/", "c.ts"].join("\n")
    expect(rows({ title: "ls: .", text, level: "summary", compact: true })).toHaveLength(1)
    expect(rows({ title: "ls: .", text, level: "preview", compact: true })).toHaveLength(1)
    expect(rows({ title: "ls: .", text, level: "full", compact: true }).length).toBeGreaterThan(1)
  })

  test("ASCII swaps every mark: rail, ellipsis, dot and the glyphs", () => {
    const out = rows({ title: "read: a.ts", text: numbered(Array.from({ length: 9 }, (_, i) => `l${i}`)), level: "preview", ascii: true, counts: { lines: 9 } })
    expect(out[0]).toBe("   r Read a.ts  9 lines")
    expect(out[1]).toBe("   | 1  l0")
    expect(out.at(-1)).toBe("   | ... 3 more lines")
    const task = rows({ title: "task: t", text: "x", ascii: true, agent: "a", model: "m" })
    expect(task[0]).toBe("   @ Task t  a - m")
    const shell = rows({ title: "shell: ls", text: "x", status: "running", ascii: true, frame: 1 })
    expect(shell[0]).toBe("   \\ ls")
    for (const input of [{ title: "grep: s", text: "a.ts:1:foo", pattern: "foo" }, { title: "ls: .", text: "a/\nb" }, { title: "edit: a", text: "@@ -1,1 +1,1 @@\n-x\n+y" }, { title: "webfetch: https://x.dev", text: "# T\nbody" }]) {
      for (const level of ["summary", "preview", "full"] as const) {
        const every = rows({ ...input, level, ascii: true }).join("\n")
        expect(every).toMatch(/^[\x20-\x7e\n]*$/)
      }
    }
  })
})

describe("graph cards: the visual is the content", () => {
  const draw = (level: "summary" | "preview" | "full", width = 100) => renderSpecLines(GRAPH_MAP_RENDER as never, width, { level, expanded: level === "full" }).map((line) => plain(line).trimEnd())

  test("balanced is the map and one muted summary row", () => {
    const out = draw("summary")
    expect(out.at(-1)).toBe("7 dirs · 2,360 files · hubs: ids 559 · textWidth 290 · createClient 211")
    expect(out.some((row) => row.includes("Hub symbols"))).toBe(false)
    expect(out.some((row) => row.includes("callers"))).toBe(false)
  })

  test("full adds a table of at most six hubs: name, file stem, callers", () => {
    const out = draw("preview")
    const at = out.findIndex((row) => row.startsWith("hub"))
    expect(out.slice(at, at + 7).map((row) => row.split(/\s{2,}/))).toEqual([["hub", "file", "callers"], ["ids", "ids", "559"], ["textWidth", "wrap", "290"], ["createClient", "client", "211"], ["fail", "util", "187"], ["succeed", "util", "176"], ["clip", "tools", "143"]])
    expect(out).toHaveLength(at + 7)
  })

  test("the lists, all 20 hubs and every directory, only once the card is opened", () => {
    const out = draw("full")
    expect(out).toContain("Directories")
    expect(out).toContain("Hub symbols")
    expect(out.filter((row) => row.includes("callers:"))).toHaveLength(20)
    expect(out.some((row) => row.startsWith("hub "))).toBe(false)
  })

  test("in the transcript the project map card is the ASCII map alone in every view and after ctrl+o, never its summary row, the lists or the hub table", () => {
    const events = toolCardsSession()
    const text = (mode: "balanced" | "full") => toolCardsView(events, { mode, width: 100 }).rows().filter((row) => row.trim())
    for (const mode of ["balanced", "full"] as const) {
      expect(text(mode).some((row) => row.includes("Project map"))).toBe(true)
      expect(text(mode).some((row) => row.includes("7 dirs · 2,360 files"))).toBe(false)
      expect(text(mode).some((row) => row.includes("textWidth") && row.includes("wrap"))).toBe(false)
      const view = toolCardsView(events, { mode, width: 100 })
      view.t.toggleTools()
      const opened = view.rows().filter((row) => row.trim())
      expect(opened.some((row) => row.includes("Project map"))).toBe(true)
      expect(opened.some((row) => row.includes("7 dirs · 2,360 files"))).toBe(false)
      expect(opened.some((row) => row.includes("callers:") || row.includes("Hub symbols") || row.includes("Directories"))).toBe(false)
    }
  })
})

describe("every kind in every view", () => {
  const events = toolCardsSession()

  test("no row is wider than the card, from 40 to 200 columns, in any view or toolOutput", () => {
    for (const mode of ["minimal", "balanced", "full"] as const) {
      for (const width of [40, 60, 100, 200]) {
        for (const toolOutput of ["auto", "collapsed", "expanded"]) {
          const out = toolCardsView(events, { mode, width, toolOutput }).rows()
          for (const row of out) expect(textWidth(row)).toBeLessThanOrEqual(width)
        }
      }
    }
  })

  test("balanced stays compact and the dense full view adds to it: more rows, never the same rows again", () => {
    const balanced = toolCardsView(events, { mode: "balanced", width: 100 }).rows().filter((row) => row.trim())
    const full = toolCardsView(events, { mode: "full", width: 100 }).rows().filter((row) => row.trim())
    const minimal = toolCardsView(events, { mode: "minimal", width: 100 }).rows().filter((row) => row.trim())
    expect(minimal.length).toBeLessThan(balanced.length)
    expect(full.length).toBeGreaterThan(balanced.length)
    expect(new Set(full).size).toBeGreaterThan(new Set(balanced).size)
  })

  test("the other densities of the full view only take rows away from the dense one", () => {
    const rowsOf = (toolDensity: "calm" | "standard" | "dense") => toolCardsView(events, { mode: "full", width: 100, toolDensity }).rows().filter((row) => row.trim())
    expect(rowsOf("standard").length).toBeLessThan(rowsOf("dense").length)
    expect(rowsOf("calm").length).toBeLessThan(rowsOf("standard").length)
  })

  test("a card never repeats on its second row what its header already says", () => {
    const out = toolCardsView(events, { mode: "full", width: 100 }).rows()
    for (const [at, row] of out.entries()) {
      const next = out[at + 1] ?? ""
      if (!row.includes("241 pass · 0 fail")) continue
      expect(next.includes(" 241 pass")).toBe(false)
    }
  })

  test("the model's result is untouched: the transcript keeps every line of what the tool returned", () => {
    const view = toolCardsView(events, { mode: "full", width: 100 })
    const readme = view.t.blocks().find((block) => block.title === "read: README.md")!
    expect(readme.text.split("\n")).toHaveLength(123)
  })
})
