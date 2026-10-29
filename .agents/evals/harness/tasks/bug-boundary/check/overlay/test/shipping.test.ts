import { describe, expect, test } from "bun:test"
import { orderTotalCents, shippingCents } from "../src/shipping"

describe("shippingCents", () => {
  test("light parcels", () => {
    expect(shippingCents(120)).toBe(499)
    expect(shippingCents(0.5)).toBe(499)
  })

  test("500 g is the top of the first tier", () => {
    expect(shippingCents(499)).toBe(499)
    expect(shippingCents(500)).toBe(499)
    expect(shippingCents(501)).toBe(899)
  })

  test("2 kg is the top of the second tier", () => {
    expect(shippingCents(1999)).toBe(899)
    expect(shippingCents(2000)).toBe(899)
    expect(shippingCents(2001)).toBe(1499)
  })

  test("5 kg is the top of the third tier", () => {
    expect(shippingCents(4999)).toBe(1499)
    expect(shippingCents(5000)).toBe(1499)
    expect(shippingCents(5001)).toBe(2999)
  })

  test("heavy parcels", () => {
    expect(shippingCents(9000)).toBe(2999)
  })

  test("rejects non-positive and non-finite weights", () => {
    expect(() => shippingCents(0)).toThrow(RangeError)
    expect(() => shippingCents(-3)).toThrow(RangeError)
    expect(() => shippingCents(Number.NaN)).toThrow(RangeError)
    expect(() => shippingCents(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})

describe("orderTotalCents", () => {
  test("adds shipping to the items", () => {
    expect(orderTotalCents([1000, 250], 800)).toBe(1250 + 899)
    expect(orderTotalCents([], 2000)).toBe(899)
  })
})
