import { describe, expect, test } from "bun:test"
import { binarySearch, mergeSorted } from "../src/search"

describe("binarySearch", () => {
  const values = [1, 3, 5, 7, 9, 11]
  test("finds every element", () => {
    values.forEach((value, index) => expect(binarySearch(values, value)).toBe(index))
  })
  test("single element arrays", () => {
    expect(binarySearch([5], 5)).toBe(0)
    expect(binarySearch([5], 4)).toBe(-1)
  })
  test("absent values", () => {
    expect(binarySearch(values, 0)).toBe(-1)
    expect(binarySearch(values, 6)).toBe(-1)
    expect(binarySearch(values, 12)).toBe(-1)
    expect(binarySearch([], 1)).toBe(-1)
  })
})

describe("mergeSorted", () => {
  test("interleaves", () => {
    expect(mergeSorted([1, 4, 7], [2, 3, 9])).toEqual([1, 2, 3, 4, 7, 9])
  })
  test("keeps the tail of the longer list", () => {
    expect(mergeSorted([1, 2], [3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5, 6])
    expect(mergeSorted([8, 9, 10], [1])).toEqual([1, 8, 9, 10])
  })
  test("one side empty", () => {
    expect(mergeSorted([], [1, 2])).toEqual([1, 2])
    expect(mergeSorted([1, 2], [])).toEqual([1, 2])
  })
  test("keeps duplicates", () => {
    expect(mergeSorted([1, 2], [2, 3])).toEqual([1, 2, 2, 3])
  })
})
