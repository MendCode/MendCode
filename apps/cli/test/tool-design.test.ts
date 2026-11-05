import { afterEach, expect, test } from "bun:test"
import { renderDiffRows, renderToolCard, type ToolCardInput } from "../src/view/tool-card"
import { DEFAULT_TOOL_DESIGN, parseToolDesign, registerToolDesignFiles, registerToolDesigns, toolDesignNames, toolDesignOf } from "../src/view/tool-design"
import type { Line } from "../src/ui/theme"

const DIFF = ["@@ -12,4 +12,4 @@", " export function total(items: Item[]) {", "-  let sum = 0", "+  let sum = 1", " }"].join("\n")
const text = (line: Line) => line.map((span) => span.text).join("")
/** The first column a row's background tint covers, or -1. */
const tintStart = (line: Line) => {
  let column = 0
  for (const span of line) {
    if (span.bg) return column
    column += [...span.text].length
  }
  return -1
}
const card = (extra: Partial<ToolCardInput> = {}) => renderToolCard({ title: "edit: src/cart.ts", text: DIFF, status: "ok", width: 60, expanded: true, level: "preview", frame: 0, tailLines: 4, ascii: false, ...extra })

afterEach(() => registerToolDesigns([]))

test("a changed diff row's tint starts right after the card's rule: no column of background between the rule and the number", () => {
  const rows = card()
  const removed = rows.find((row) => text(row).includes("let sum = 0"))!
  // `   │` is the indent and the rule (columns 0-3); the tint starts at column 4, the cell before the line number.
  expect(text(removed).slice(0, 4)).toBe("   │")
  expect(tintStart(removed)).toBe(4)
  expect(text(removed)).toStartWith("   │ 13 -   let sum = 0")
  // The tint runs to the card's last column but one, as before.
  expect(text(removed).length).toBe(59)
})

test("a card drawn without its rule starts the tint under the header's glyph", () => {
  const rows = card({ rail: false })
  const added = rows.find((row) => text(row).includes("let sum = 1"))!
  expect(tintStart(added)).toBe(3)
  expect(text(rows[0]!).indexOf("✎")).toBe(3)
})

test("the split diff's old half starts its tint at the rule too", () => {
  const rows = card({ splitDiff: true, width: 120 })
  const pair = rows.find((row) => text(row).includes("let sum = 0"))!
  expect(tintStart(pair)).toBe(4)
})

test("render specs keep their own diff rows: a prefix of one indent is never tinted", () => {
  const rows = renderDiffRows([{ kind: "remove", text: "a", old: 1 }], 20)
  expect(tintStart(rows[0]!)).toBe(3)
})

test("the default design draws exactly what a card without a design draws", () => {
  for (const status of ["ok", "error", "running"] as const) {
    for (const title of ["edit: src/cart.ts", "shell: bun test", "read: README.md"]) {
      const input = { title, text: title.startsWith("edit") ? DIFF : "a\nb\nc", status, width: 70, expanded: true, level: "preview" as const, frame: 0, tailLines: 4, ascii: false }
      expect(renderToolCard({ ...input, design: DEFAULT_TOOL_DESIGN })).toEqual(renderToolCard(input))
    }
  }
})

test("branch: one bullet per call, the call in brackets, a branch on the first body row only, tints still from the rule's column", () => {
  const rows = card({ design: toolDesignOf("branch") })
  expect(text(rows[0]!)).toStartWith("   ● Edit(src/cart.ts)")
  const body = rows.slice(1).map(text)
  expect(body[0]).toStartWith("   ╰ 12")
  expect(body.slice(1).every((row) => row.startsWith("     "))).toBe(true)
  expect(tintStart(rows.find((row) => text(row).includes("let sum = 0"))!)).toBe(3)
})

test("branch: a wrapped command's continuation rows are blank under the bullet, the branch marks the output", () => {
  const rows = renderToolCard({ title: "shell: bun test apps/cli/test/some-long-file-name.test.ts --timeout 20000 && echo done", text: "1\n2\n3", status: "ok", width: 60, expanded: true, level: "preview", frame: 0, tailLines: 4, ascii: false, exitCode: 1, design: toolDesignOf("branch") })
  expect(text(rows[0]!)).toStartWith("   ● bun test")
  expect(text(rows[1]!)).toStartWith("     ")
  expect(text(rows[2]!)).toBe("   ╰ 1")
  expect(text(rows[3]!)).toBe("     2")
})

test("terse: no tool name, no rule, a diff of signs without numbers or tints", () => {
  const rows = card({ design: toolDesignOf("terse") })
  expect(text(rows[0]!)).toStartWith("   ✎ src/cart.ts  +1 −1")
  expect(rows.slice(1).map(text)).toEqual(["       export function total(items: Item[]) {", "     -   let sum = 0", "     +   let sum = 1", "       }"])
  expect(rows.every((row) => tintStart(row) < 0)).toBe(true)
})

test("glyphs follow the ASCII mode", () => {
  const rows = card({ design: toolDesignOf("branch"), ascii: true })
  expect(text(rows[0]!)).toStartWith("   * Edit(src/cart.ts)")
  expect(text(rows[1]!)).toStartWith("   ` 12")
})

test("a design file: every field optional, unknown fields and values refused with what is wrong", () => {
  const minimal = parseToolDesign("mine", {})
  expect("design" in minimal && minimal.design).toMatchObject({ name: "mine", header: DEFAULT_TOOL_DESIGN.header, diff: DEFAULT_TOOL_DESIGN.diff })
  expect(parseToolDesign("mine", { header: { mark: "star" } })).toEqual({ problem: "header.mark: expected kind|bullet" })
  expect(parseToolDesign("mine", { colours: {} })).toEqual({ problem: "unknown field colours" })
  expect(parseToolDesign("mine", { colors: { added: "lime" } })).toMatchObject({ problem: expect.stringContaining("colors.added: expected a theme role") })
  expect(parseToolDesign("mine", { rail: { glyph: "ab" } })).toMatchObject({ problem: expect.stringContaining("one cell each") })
  expect(parseToolDesign("mine", { diff: { tint: "none", signs: false } })).toMatchObject({ problem: expect.stringContaining("keep signs true") })
  expect(parseToolDesign("mine", { output: { rows: 99 } })).toMatchObject({ problem: expect.stringContaining("output.rows") })
  expect(parseToolDesign("Bad Name", {})).toMatchObject({ problem: expect.stringContaining("file names") })
})

test("a profile's design file is listed and used by name; a file cannot replace the default; an unknown name draws the default", () => {
  const problems = registerToolDesignFiles([
    { name: "ledger", file: "/p/tool-designs/ledger.json", json: { label: "Ledger", header: { label: false }, diff: { tint: "code" } } },
    { name: "rail", file: "/p/tool-designs/rail.json", json: { header: { mark: "bullet" } } },
    { name: "broken", file: "/p/tool-designs/broken.json", problem: "invalid JSON: x" },
  ])
  expect(problems).toEqual([{ name: "broken", file: "/p/tool-designs/broken.json", message: "invalid JSON: x" }])
  expect(toolDesignNames()).toEqual(["rail", "branch", "terse", "ledger"])
  expect(toolDesignOf("rail")).toBe(DEFAULT_TOOL_DESIGN)
  expect(toolDesignOf("ledger").label).toBe("Ledger")
  expect(toolDesignOf("gone")).toBe(DEFAULT_TOOL_DESIGN)
  // `code` tints the changed code only: the number and the sign stay on the terminal's background.
  const removed = card({ design: toolDesignOf("ledger") }).find((row) => text(row).includes("let sum = 0"))!
  expect(tintStart(removed)).toBe(text(removed).indexOf("let"))
  registerToolDesigns([])
  expect(toolDesignNames()).toEqual(["rail", "branch", "terse"])
})
