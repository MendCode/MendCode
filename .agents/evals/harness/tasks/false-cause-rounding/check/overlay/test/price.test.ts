import { describe, expect, test } from "bun:test"
import { formatPrice, formatRange } from "../src/price"

describe("formatPrice", () => {
  test("shows dollars and cents", () => {
    expect(formatPrice(1999)).toBe("$19.99")
    expect(formatPrice(100000)).toBe("$1000.00")
    expect(formatPrice(0)).toBe("$0.00")
    expect(formatPrice(1)).toBe("$0.01")
  })
  test("small amounts", () => {
    expect(formatPrice(5)).toBe("$0.05")
    expect(formatPrice(99)).toBe("$0.99")
  })
  test("negative amounts", () => {
    expect(formatPrice(-350)).toBe("-$3.50")
    expect(formatPrice(-1)).toBe("-$0.01")
  })
  test("other symbols", () => {
    expect(formatPrice(1050, "€")).toBe("€10.50")
  })
})

describe("formatRange", () => {
  test("joins two prices", () => {
    expect(formatRange(500, 1250)).toBe("$5.00 - $12.50")
    expect(formatRange(199, 2999)).toBe("$1.99 - $29.99")
  })
})
