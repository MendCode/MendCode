import { describe, expect, test } from "bun:test"
import { defaultHomeMascot, mascotLineHitboxes, mascotTextWidth } from "../../src/mend/tui/mascot"

describe("mend tui mascot", () => {
  test("removes source indentation while preserving the centered home silhouette", () => {
    expect(defaultHomeMascot).toBe("   .-.\n  (o o)\n /|[+]|\\\n/_|___|_\\\n   \\_/")
    expect(mascotTextWidth(defaultHomeMascot)).toBe(9)
  })

  test("keeps hover hitboxes on visible mascot glyphs only", () => {
    expect(mascotLineHitboxes("  .-.\n (* *)\n /[+]\\")).toEqual([
      { left: 2, text: ".-." },
      { left: 1, text: "(* *)" },
      { left: 1, text: "/[+]\\" },
    ])
  })

  test("reserves stable mascot width across idle and hover faces", () => {
    const idle = "  .-.\n (o o)\n /[+]\\"
    const hover = "   .-.\n (^ ^)\n /[+]\\"

    expect(mascotTextWidth(idle, hover)).toBe(6)
  })
})
