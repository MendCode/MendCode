import { describe, expect, test } from "bun:test"
import { LOGO_FONTS, LOGO_GLYPHS, LOGO_FONT_CHARACTERS, logoHeight, logoRowsFor } from "../src/view/logo-fonts"
import { normalizeTuiProfile } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" + Array.from({ length: 33 }, (_, i) => String.fromCharCode(32 + i)).join("").replace(/[0-9]/g, "") + "[\\]^_`{|}~"

describe("terminal logo fonts", () => {
  for (const font of LOGO_FONTS) {
    test(`${font}: every glyph is rectangular and has the exact font height`, () => {
      const glyphs = LOGO_GLYPHS[font]
      for (const char of alphabet) expect(glyphs[char]).toBeDefined()
      for (const [char, rows] of Object.entries(glyphs)) {
        expect(rows.length, `${font}/${char}`).toBe(logoHeight(font))
        const width = textWidth(rows[0]!)
        expect(width).toBeGreaterThan(0)
        for (const row of rows) {
          expect(textWidth(row), `${font}/${char}`).toBe(width)
          expect(row).not.toMatch(/[\x00-\x1f\x7f]/)
          for (const cell of row) expect(LOGO_FONT_CHARACTERS[font], `${font}/${char}: ${cell}`).toContain(cell)
        }
      }
      expect(logoRowsFor("MENDCODE", font).length).toBe(logoHeight(font))
    })
  }

  test("retired fonts migrate without losing the rest of the profile", () => {
    for (const logoFont of ["small", "standard", "shadow", "classic", "opencode", "slant"]) {
      expect(normalizeTuiProfile({ logoFont, logoText: "ACME", logoKind: "both", homeLayout: "split" })).toMatchObject({ logoFont: "mendcode", logoText: "ACME", logoKind: "both", homeLayout: "split" })
    }
  })
})
