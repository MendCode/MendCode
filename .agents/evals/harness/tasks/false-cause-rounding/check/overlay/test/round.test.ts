import { describe, expect, test } from "bun:test"
import { roundHalfUp } from "../src/round"

describe("roundHalfUp keeps its contract", () => {
  test("rounds to a whole number by default", () => {
    expect(roundHalfUp(2.4)).toBe(2)
    expect(roundHalfUp(2.5)).toBe(3)
    expect(roundHalfUp(19.99)).toBe(20)
    expect(roundHalfUp(0.49)).toBe(0)
  })
  test("rounds ties away from zero", () => {
    expect(roundHalfUp(-2.5)).toBe(-3)
    expect(roundHalfUp(-2.4)).toBe(-2)
  })
  test("honours an explicit number of digits", () => {
    expect(roundHalfUp(1.005, 2)).toBe(1.01)
    expect(roundHalfUp(3.14159, 3)).toBe(3.142)
    expect(roundHalfUp(19.99, 2)).toBe(19.99)
  })
  test("non-finite values pass through", () => {
    expect(roundHalfUp(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
    expect(Number.isNaN(roundHalfUp(Number.NaN))).toBe(true)
  })
})
