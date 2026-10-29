import { describe, expect, test } from "bun:test"
import { glyphs, type Line } from "../src/ui/theme"
import { placeholderFor, promptFrame, promptRow, renderStatusRow } from "../src/view/prompt-chrome"
import { PROMPT_CHROMES, type PromptChrome } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"

const g = glyphs({})
const plain = (line: Line) => line.map((span) => span.text).join("")
const status = (width: number) => renderStatusRow({ width, model: "gpt-6", effort: "high", loops: 1 })

function draw(preset: PromptChrome, width: number, text = "") {
  const frame = promptFrame({ preset, width, glyphs: g, rich: true })
  const row = frame.row(promptRow({ text, first: true, rich: true, glyphs: g, ...(text ? {} : { placeholder: placeholderFor(0) }) }))
  const inside = frame.inside?.(status)
  return { frame, rows: [...frame.top, row, ...(inside ? [inside] : []), ...frame.bottom] }
}

describe("prompt chrome presets", () => {
  for (const width of [60, 100, 140]) {
    test(`every preset draws rows of exactly ${width} cells`, () => {
      for (const preset of PROMPT_CHROMES) {
        for (const text of ["", "hello", "x".repeat(300)]) {
          const { rows } = draw(preset, width, text)
          for (const row of rows) expect([preset, textWidth(plain(row))]).toEqual([preset, width])
        }
      }
    })
  }

  test("top-bottom (v1's default) is two straight rules with a 2-cell margin around the row", () => {
    const { rows } = draw("top-bottom", 100)
    expect(plain(rows[0]!)).toBe(`  ${"─".repeat(96)}  `)
    expect(plain(rows[1]!).startsWith('  ❭ Ask anything... "Fix a TODO in the codebase"')).toBe(true)
    expect(plain(rows[2]!)).toBe(plain(rows[0]!))
    expect(rows).toHaveLength(3)
  })

  test("box is a rounded frame with the lead inside it", () => {
    const { rows, frame } = draw("box", 100, "hi")
    expect(plain(rows[0]!)).toBe(`  ╭${"─".repeat(94)}╮  `)
    expect(plain(rows[1]!).startsWith("  │ ❭ hi ")).toBe(true)
    expect(plain(rows[1]!).endsWith(" │  ")).toBe(true)
    expect(plain(rows[2]!)).toBe(`  ╰${"─".repeat(94)}╯  `)
    // The cursor column is the first typed cell: margin, bar, gap, lead, gap.
    expect(plain(rows[1]!).indexOf("hi")).toBe(frame.inset)
    expect(frame.inside).toBeUndefined()
  })

  test("ascii-box wraps input only with box-drawing glyphs; ASCII is explicit", () => {
    const { rows, frame } = draw("ascii-box", 100, "hi")
    expect(rows).toHaveLength(3)
    expect(plain(rows[0]!)).toBe(`  ┌${"─".repeat(94)}┐  `)
    expect(plain(rows[1]!).startsWith("  │ ❭ hi")).toBe(true)
    expect(plain(rows[2]!)).toBe(`  └${"─".repeat(94)}┘  `)
    expect(frame.inside).toBeUndefined()
    const ascii = promptFrame({ preset: "ascii-box", width: 100, glyphs: g, rich: true, border: "ascii" })
    expect(plain(ascii.top[0]!)).toBe(`  +${"=".repeat(94)}+  `)
  })

  test("minimal is a filled panel: subtle prompt background on every cell, no border glyphs", () => {
    const { rows } = draw("minimal", 100, "hi")
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(plain(row)).not.toMatch(/[─│╭╮╰╯+=|]/)
      expect(row.every((span) => span.bg === "promptBg")).toBe(true)
    }
    expect(plain(rows[1]!).startsWith("  ❭ hi")).toBe(true)
  })

  test("the bare minimal view keeps its full-width rules whatever the preset", () => {
    for (const preset of PROMPT_CHROMES) {
      const frame = promptFrame({ preset, width: 80, glyphs: g, rich: false })
      expect(plain(frame.top[0]!)).toBe("─".repeat(80))
      expect(frame.inset).toBe(2)
      expect(frame.inside).toBeUndefined()
    }
  })

  test("a row longer than the box is cut inside it, never over the border", () => {
    const { rows } = draw("box", 60, "y".repeat(200))
    expect(plain(rows[1]!).trimEnd().endsWith("│")).toBe(true)
    expect(textWidth(plain(rows[1]!))).toBe(60)
  })

  test("a terminal narrower than the frame does not throw", () => {
    for (const preset of PROMPT_CHROMES) for (const width of [0, 1, 5, 9]) expect(() => draw(preset, width, "x")).not.toThrow()
  })
})
