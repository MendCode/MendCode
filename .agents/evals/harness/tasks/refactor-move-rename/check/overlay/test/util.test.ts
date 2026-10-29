import { describe, expect, test } from "bun:test"
import { clampInt, padRight } from "../src/util"

describe("helpers", () => {
  test("clampInt truncates and bounds", () => {
    expect(clampInt(7.9, 0, 5)).toBe(5)
    expect(clampInt(-3.2, 0, 5)).toBe(0)
    expect(clampInt(2.9, 0, 5)).toBe(2)
  })
  test("padRight", () => {
    expect(padRight("ab", 4)).toBe("ab  ")
    expect(padRight("abcdef", 4)).toBe("abcdef")
  })
})
