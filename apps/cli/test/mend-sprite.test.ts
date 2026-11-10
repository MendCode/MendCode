import { afterEach, describe, expect, test } from "bun:test"
import { mendPicture, mendSprite } from "../src/pets/mend-pet"
import { DEFAULT_THEME, THEMES } from "../src/themes"
import { setTheme } from "../src/ui/theme"
import { BEATS, mendBeat, mendImage, mendPalette, mendSpriteLines } from "../src/view/mend-sprite"

const CHEEK = [240, 168, 172]
const theme = (name: string) => THEMES.find((entry) => entry.name === name)!
const MEND = mendPalette(theme("amber"))
const EYE = [...MEND.colors.E]

afterEach(() => setTheme(DEFAULT_THEME))

/** The columns of row `y` drawn in `rgb`. */
function columns(phase: string, beat: number, y: number, rgb: number[]): number[] {
  const { width, rgba } = mendImage(phase, beat, MEND)
  return Array.from({ length: width }, (_, x) => x).filter((x) => rgb.every((value, i) => rgba[(y * width + x) * 4 + i] === value))
}

/** Every pixel of a frame as [r, g, b], the background left out. */
function drawnColors(phase: string, palette = mendPalette()): number[][] {
  const { rgba } = mendImage(phase, 0, palette)
  const out: number[][] = []
  for (let at = 0; at < rgba.length; at += 4) if (rgba[at + 3]) out.push([rgba[at]!, rgba[at + 1]!, rgba[at + 2]!])
  return out
}



describe("the built-in Mend", () => {
  test("its cheeks move with its eyes, so the face turns as one", () => {
    expect(columns("idle", 0, 7, CHEEK)).toEqual([3, 9])
    expect(columns("editing", 0, 5, EYE)).toEqual([5, 9])
    expect(columns("editing", 0, 7, CHEEK)).toEqual([4, 10])
    expect(columns("reading", 0, 5, EYE)).toEqual([3, 7])
    expect(columns("reading", 0, 7, CHEEK)).toEqual([2, 8])
  })

  test("at work it moves beat by beat and its antenna blinks; at rest it holds still", () => {
    const frames = (phase: string) => new Set(Array.from({ length: BEATS }, (_, beat) => Buffer.from(mendImage(phase, beat).rgba).toString("hex")))
    expect(frames("thinking").size).toBeGreaterThan(2)
    expect(frames("idle").size).toBe(1)
    expect(columns("running", 1, 0, CHEEK)).toEqual([9, 10])
    expect(columns("running", 0, 0, CHEEK)).toEqual([])
  })

  test("every frame keeps the same size", () => {
    for (const phase of ["idle", "thinking", "editing", "reading", "blocked", "error"])
      for (let beat = 0; beat < BEATS; beat++) expect([mendImage(phase, beat).width, mendImage(phase, beat).height]).toEqual([13, 14])
  })

  test("a beat every half second of the spinner, none with reduced motion", () => {
    expect([0, 3, 4, 31, 32].map((frame) => mendBeat(frame, true))).toEqual([0, 0, 1, 7, 0])
    expect(mendBeat(13, false)).toBe(0)
  })
})

describe("Mend's colors follow the theme", () => {
  test("every other theme draws it in its own primary color, never the mint robot", () => {
    const hue = ([r, g, b]: number[]) => (r! > g! && r! > b! ? "red" : g! > b! ? "green" : "blue")
    for (const [name, expected] of [["amber", "red"], ["fjord", "blue"], ["matrix", "green"]] as const) {
      setTheme(name)
      expect(mendPalette().key).toStartWith(name)
      const body = drawnColors("idle").filter((color) => !(color[0] === CHEEK[0] && color[1] === CHEEK[1]))
      expect(new Set(body.map(hue))).toEqual(new Set([expected]))
      expect(body).not.toContainEqual([56, 143, 114])
    }
    setTheme("mono")
    expect(drawnColors("idle").every(([r, g, b]) => (r === g && g === b) || r === CHEEK[0])).toBe(true)
  })

  test("a theme's frames stay the same size and shape as the original robot", () => {
    const mask = (palette: ReturnType<typeof mendPalette>) => Array.from(mendImage("thinking", 3, palette).rgba.filter((_, at) => at % 4 === 3))
    for (const entry of THEMES) expect(mask(mendPalette(entry))).toEqual(mask(MEND))
  })

  test("MendCode's theme draws it in black and white: grey everywhere but the pink cheeks", () => {
    setTheme("mendcode")
    const colors = drawnColors("idle")
    const grey = colors.filter(([r, g, b]) => r === g && g === b)
    expect(colors.filter((color) => !grey.includes(color))).toEqual([CHEEK, CHEEK])
    // A white head, a mid-grey outline and dark eyes, all readable on MendCode's #0a0a0a.
    expect(colors).toContainEqual([250, 250, 250])
    expect(colors).toContainEqual([115, 115, 115])
    expect(colors).toContainEqual([23, 23, 23])
    expect(Math.min(...grey.filter(([r]) => r !== 23).map(([r]) => r))).toBeGreaterThan(0x40 - 1)
  })

  test("an error turns the body the theme's red; the head stays", () => {
    setTheme("mendcode")
    const error = drawnColors("error")
    expect(error).toContainEqual([0xf0, 0x71, 0x78])
    expect(error).toContainEqual([250, 250, 250])
    expect(error).not.toContainEqual([64, 64, 64])
  })

  test("the frame caches key by palette, so a theme switch draws the new colors", () => {
    setTheme("amber")
    const mintLines = mendSpriteLines("idle", 1)
    const mintPicture = mendPicture("idle", 13, 7, { width: 8, height: 16 })
    setTheme("mendcode")
    const inkLines = mendSpriteLines("idle", 1)
    const inkPicture = mendPicture("idle", 13, 7, { width: 8, height: 16 })
    expect(inkLines).not.toEqual(mintLines)
    expect(inkPicture.key).not.toBe(mintPicture.key)
    expect(mendSprite("idle").id).toContain("mendcode")
    expect(Buffer.from(inkPicture.image.rgba).equals(Buffer.from(mintPicture.image.rgba))).toBe(false)
    setTheme("amber")
    expect(mendSpriteLines("idle", 1)).toBe(mintLines)
    expect(mendPicture("idle", 13, 7, { width: 8, height: 16 }).image).toBe(mintPicture.image)
  })
})
