import { describe, expect, test } from "bun:test"
import { formatPrice, formatRange } from "../src/price"

describe("formatPrice", () => {
  test("shows dollars and cents", () => {
    expect(formatPrice(1999)).toBe("$19.99")
  })
  test("small amounts", () => {
    expect(formatPrice(5)).toBe("$0.05")
  })
  test("negative amounts", () => {
    expect(formatPrice(-350)).toBe("-$3.50")
  })
})

describe("formatRange", () => {
  test("joins two prices", () => {
    expect(formatRange(500, 1250)).toBe("$5.00 - $12.50")
  })
})
