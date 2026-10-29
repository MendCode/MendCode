import { describe, expect, test } from "bun:test"
import { orderTotalCents, shippingCents } from "../src/shipping"

describe("shippingCents", () => {
  test("light parcels", () => {
    expect(shippingCents(120)).toBe(499)
  })

  test("a parcel of exactly 500 g is still in the first tier", () => {
    expect(shippingCents(500)).toBe(499)
  })

  test("heavy parcels", () => {
    expect(shippingCents(9000)).toBe(2999)
  })

  test("rejects non-positive weights", () => {
    expect(() => shippingCents(0)).toThrow(RangeError)
  })
})

describe("orderTotalCents", () => {
  test("adds shipping to the items", () => {
    expect(orderTotalCents([1000, 250], 800)).toBe(1250 + 899)
  })
})
