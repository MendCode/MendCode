import { describe, expect, test } from "bun:test"
import { clampInt, fmtMoney, padRight } from "../src/util"

describe("fmtMoney", () => {
  test("formats cents with grouping", () => {
    expect(fmtMoney(1234567)).toBe("$12,345.67")
  })
  test("keeps the sign in front", () => {
    expect(fmtMoney(-250)).toBe("-$2.50")
  })
  test("other currencies", () => {
    expect(fmtMoney(5, "EUR")).toBe("€0.05")
    expect(fmtMoney(100, "CHF")).toBe("CHF 1.00")
  })
})

describe("helpers", () => {
  test("clampInt truncates and bounds", () => {
    expect(clampInt(7.9, 0, 5)).toBe(5)
    expect(clampInt(-3.2, 0, 5)).toBe(0)
  })
  test("padRight", () => {
    expect(padRight("ab", 4)).toBe("ab  ")
  })
})
