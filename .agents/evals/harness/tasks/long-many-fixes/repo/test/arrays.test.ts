import { describe, expect, test } from "bun:test"
import { chunk, unique } from "../src/arrays"

describe("chunk", () => {
  test("keeps the remainder as a short last chunk", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
  test("exact multiples", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
  })
  test("size larger than the list", () => {
    expect(chunk([1, 2], 5)).toEqual([[1, 2]])
  })
  test("empty list", () => {
    expect(chunk([], 3)).toEqual([])
  })
  test("rejects a bad size", () => {
    expect(() => chunk([1], 0)).toThrow(RangeError)
  })
})

describe("unique", () => {
  test("keeps first occurrences in order", () => {
    expect(unique([3, 1, 3, 2, 1])).toEqual([3, 1, 2])
  })
  test("distinguishes 1 from '1'", () => {
    expect(unique([1, "1", 1, "1"])).toEqual([1, "1"])
  })
  test("distinguishes 0 from false and null from undefined", () => {
    expect(unique([0, false, null, undefined, 0, false])).toEqual([0, false, null, undefined])
  })
})
