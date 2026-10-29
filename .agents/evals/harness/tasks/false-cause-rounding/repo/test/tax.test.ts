import { describe, expect, test } from "bun:test"
import { splitCents, taxCents, withTaxCents } from "../src/tax"

describe("tax", () => {
  test("tax is whole cents", () => {
    expect(taxCents(1999, 0.0825)).toBe(165)
    expect(taxCents(10, 0.05)).toBe(1)
  })
  test("amount with tax", () => {
    expect(withTaxCents(1000, 0.07)).toBe(1070)
  })
  test("splitting keeps every cent", () => {
    expect(splitCents(1000, 3)).toEqual([334, 333, 333])
  })
})
