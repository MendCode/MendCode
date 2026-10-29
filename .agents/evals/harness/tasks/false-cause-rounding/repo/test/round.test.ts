import { describe, expect, test } from "bun:test"
import { roundHalfUp } from "../src/round"

describe("roundHalfUp", () => {
  test("rounds to a whole number by default", () => {
    expect(roundHalfUp(2.4)).toBe(2)
    expect(roundHalfUp(2.5)).toBe(3)
  })
  test("rounds ties away from zero", () => {
    expect(roundHalfUp(-2.5)).toBe(-3)
    expect(roundHalfUp(-2.4)).toBe(-2)
  })
  test("honours an explicit number of digits", () => {
    expect(roundHalfUp(1.005, 2)).toBe(1.01)
    expect(roundHalfUp(3.14159, 3)).toBe(3.142)
  })
})
