import { describe, expect, test } from "bun:test"
import { validateThemeDocument, THEME_COLOR_KEYS } from "../../../src/cli/cmd/tui/theme-format"

const valid = Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, key === "background" ? "#101010" : "#f0f0f0"]))

describe("MendCode theme format", () => {
  test("accepts a complete high-contrast theme", () => {
    expect(validateThemeDocument({ $schema: "https://mendcode.ai/theme.json", theme: valid })).toEqual([])
  })

  test("rejects incomplete themes and weak text contrast", () => {
    expect(validateThemeDocument({ theme: { background: "#ffffff", text: "#eeeeee" } })).toEqual(
      expect.arrayContaining(["theme.primary is required", expect.stringContaining("contrast")]),
    )
  })

  test("accepts ANSI colors, references, and dark/light variants", () => {
    const theme = Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, key === "text" ? { dark: "#ffffff", light: "#000000" } : "accent"]))
    expect(validateThemeDocument({ defs: { accent: 10 }, theme })).toEqual([])
  })

  test("rejects unknown and circular color references", () => {
    const unknown = { ...valid, accent: "missingColor" }
    expect(validateThemeDocument({ theme: unknown })).toEqual(expect.arrayContaining([expect.stringContaining("unknown color missingColor")]))

    const circular = { ...valid, accent: "first", primary: "second" }
    expect(validateThemeDocument({ defs: { first: "second", second: "first" }, theme: circular })).toEqual(
      expect.arrayContaining([expect.stringContaining("unknown color first"), expect.stringContaining("unknown color second")]),
    )
  })
})
