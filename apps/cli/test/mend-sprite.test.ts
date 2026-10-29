import { describe, expect, test } from "bun:test"
import { BEATS, mendBeat, mendImage } from "../src/view/mend-sprite"

const CHEEK = [240, 168, 172]
const EYE = [11, 52, 47]

/** The columns of row `y` drawn in `rgb`. */
function columns(phase: string, beat: number, y: number, rgb: number[]): number[] {
  const { width, rgba } = mendImage(phase, beat)
  return Array.from({ length: width }, (_, x) => x).filter((x) => rgb.every((value, i) => rgba[(y * width + x) * 4 + i] === value))
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
