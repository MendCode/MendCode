import { describe, expect, test } from "bun:test"
import { median, percent } from "../src/math"

describe("median", () => {
  test("odd count", () => {
    expect(median([5, 1, 3])).toBe(3)
  })
  test("even count averages the middle pair", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
  test("sorts numerically, not alphabetically", () => {
    expect(median([10, 9, 100])).toBe(10)
  })
  test("does not mutate the input", () => {
    const input = [3, 1, 2]
    median(input)
    expect(input).toEqual([3, 1, 2])
  })
  test("empty input throws", () => {
    expect(() => median([])).toThrow(RangeError)
  })
})

describe("percent", () => {
  test("rounds to one decimal, to nearest", () => {
    expect(percent(2, 3)).toBe(66.7)
    expect(percent(1, 3)).toBe(33.3)
  })
  test("whole results", () => {
    expect(percent(1, 4)).toBe(25)
  })
  test("a zero total gives 0", () => {
    expect(percent(5, 0)).toBe(0)
  })
})
