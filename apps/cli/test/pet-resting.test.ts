import { expect, test } from "bun:test"
import { spriteCells } from "../src/pets/art"
import type { PetImage } from "../src/pets/decode"
import type { PetSprite } from "../src/pets/sprite"

/** A 100 x 100 frame with an opaque block `height` tall standing on its bottom edge. */
const standing = (height: number): PetImage => {
  const rgba = new Uint8Array(100 * 100 * 4)
  for (let y = 100 - height; y < 100; y++) for (let x = 20; x < 80; x++) rgba.set([255, 255, 255, 255], (y * 100 + x) * 4)
  return { width: 100, height: 100, rgba }
}
const pet = (rows: Record<string, PetImage[]>): PetSprite => ({ id: "test", rows: new Map(Object.entries(rows)) as PetSprite["rows"] })

test("a pet whose jump reaches a little past its resting figure is drawn smaller, so at rest it stands three quarters of the box", () => {
  // At rest 90 of the 100 pixels its frames reach: the box keeps a quarter for the jump, as a Codex atlas cell does.
  expect(spriteCells(pet({ idle: [standing(90)], jumping: [standing(100)] }), 16, 8)).toEqual({ cols: 8, rows: 7 })
})

test("a pet whose jump reaches further than a quarter keeps the whole box and stands lower; a still pet stands three quarters too", () => {
  expect(spriteCells(pet({ idle: [standing(70)], jumping: [standing(100)] }), 16, 8)).toEqual({ cols: 10, rows: 8 })
  expect(spriteCells(pet({ idle: [standing(100)] }), 16, 8)).toEqual({ cols: 7, rows: 6 })
})

test("a still pet and an animated one are the same height at rest, whatever their sheet's margins", () => {
  const still = pet({ idle: [standing(100)] })
  const jumper = pet({ idle: [standing(75)], jumping: [standing(100)] })
  // The jumper's box is a third taller than its 75-pixel resting figure: at rest both stand 12 half rows.
  expect(spriteCells(still, 16, 8).rows * 2).toBe(12)
  expect(spriteCells(jumper, 16, 8).rows * 2 * 0.75).toBe(12)
})
