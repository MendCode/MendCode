import { describe, expect, test } from "bun:test"
import { BOT_COLORS, BOT_SHAPES } from "@mendcode/protocol/wire"
import { botIcon } from "../src/view/bot-icon"
import { textWidth } from "../src/view/wrap"

describe("botIcon: the one place a bot's icon is drawn", () => {
  test("each shape is a glyph in the bot's theme color role, two cells wide", () => {
    const glyphs = { circle: "●", square: "■", diamond: "◆", triangle: "▲", hexagon: "⬢" } as const
    for (const shape of BOT_SHAPES) {
      const icon = botIcon({ name: "calm", shape, color: "success" })
      expect(icon).toMatchObject({ text: `${glyphs[shape]} `, fg: "success", shape, color: "success" })
      expect(textWidth(icon.text)).toBe(2)
    }
    for (const color of BOT_COLORS) expect(botIcon({ name: "calm", shape: "circle", color }).fg).toBe(color)
  })

  test("without unicode every shape falls back to two ASCII cells", () => {
    const ascii = { circle: "()", square: "[]", diamond: "<>", triangle: "/\\", hexagon: "{}" } as const
    for (const shape of BOT_SHAPES) {
      const icon = botIcon({ name: "calm", shape, color: "info", ascii: true })
      expect(icon.text).toBe(ascii[shape])
      expect(/^[\x20-\x7e]{2}$/.test(icon.text)).toBe(true)
    }
  })

  test("a missing shape or color comes from the name, the same every time and only from valid values", () => {
    const first = botIcon({ name: "reviewer" })
    expect(botIcon({ name: "reviewer" })).toEqual(first)
    expect(BOT_SHAPES).toContain(first.shape)
    expect(BOT_COLORS).toContain(first.color)
    const kinds = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map((name) => botIcon({ name }).shape))
    expect(kinds.size).toBeGreaterThan(2)
    // The look the file names wins; only the missing half is made up.
    expect(botIcon({ name: "reviewer", shape: "square" })).toMatchObject({ shape: "square", color: first.color })
    expect(botIcon({ name: "reviewer", color: "error" })).toMatchObject({ shape: first.shape, color: "error" })
  })
})
