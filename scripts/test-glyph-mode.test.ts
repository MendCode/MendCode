import { describe, expect, test } from "bun:test"
import { glyphMode, setGlyphMode } from "../apps/cli/src/ui/theme"

describe("the preloaded glyph reset (scripts/test-glyph-mode.ts)", () => {
  test("a test that switches the process to ASCII glyphs", () => {
    setGlyphMode("ascii")
    expect(glyphMode({})).toBe("ascii")
  })

  test("is not seen by the next test, as logo-mark.test.ts was not by loops-page.test.ts", () => {
    expect(glyphMode({})).toBe("unicode")
  })
})
