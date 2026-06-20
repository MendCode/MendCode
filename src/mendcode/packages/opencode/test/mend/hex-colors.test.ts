import { describe, expect, test } from "bun:test"
import { extractHexColors, normalizeHexColor } from "../../src/cli/cmd/tui/util/hex-colors"

describe("hex color extraction", () => {
  test("normalizes short and long hex colors", () => {
    expect(normalizeHexColor("#0fA")).toBe("#00ffaa")
    expect(normalizeHexColor("#FFAA00")).toBe("#ffaa00")
    expect(normalizeHexColor("not-a-color")).toBeUndefined()
  })

  test("extracts unique colors while preserving display text", () => {
    expect(extractHexColors("Palette: #FFAA00, #0fA, then #ffaa00 again")).toEqual([
      { hex: "#ffaa00", display: "#FFAA00" },
      { hex: "#00ffaa", display: "#0fA" },
    ])
  })

  test("does not treat markdown headings as colors", () => {
    expect(extractHexColors("# Heading\n## Another\nUse #123456")).toEqual([{ hex: "#123456", display: "#123456" }])
  })
})
