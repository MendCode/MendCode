import { describe, expect, test } from "bun:test"
import { describePage, paginate } from "../src/paginate"

const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

describe("paginate", () => {
  test("first page holds pageSize items", () => {
    const result = paginate(ten, 1, 4)
    expect(result.items).toEqual([1, 2, 3, 4])
    expect(result.hasNext).toBe(true)
    expect(result.hasPrevious).toBe(false)
  })

  test("middle page", () => {
    expect(paginate(ten, 2, 4).items).toEqual([5, 6, 7, 8])
  })

  test("last page holds the remainder", () => {
    const result = paginate(ten, 3, 4)
    expect(result.items).toEqual([9, 10])
    expect(result.hasNext).toBe(false)
    expect(result.pageCount).toBe(3)
  })

  test("exact multiple fills the last page", () => {
    const result = paginate([1, 2, 3, 4, 5, 6], 2, 3)
    expect(result.items).toEqual([4, 5, 6])
    expect(result.pageCount).toBe(2)
    expect(result.hasNext).toBe(false)
  })

  test("page size one returns single items", () => {
    expect(paginate(["a", "b", "c"], 3, 1).items).toEqual(["c"])
  })

  test("page size larger than the list returns everything", () => {
    expect(paginate([1, 2], 1, 50).items).toEqual([1, 2])
  })

  test("a page past the end is empty", () => {
    expect(paginate(ten, 4, 4).items).toEqual([])
  })

  test("empty input has one empty page", () => {
    const result = paginate([], 1, 5)
    expect(result.items).toEqual([])
    expect(result.pageCount).toBe(1)
    expect(result.hasNext).toBe(false)
  })

  test("invalid arguments throw", () => {
    expect(() => paginate(ten, 0, 4)).toThrow(RangeError)
    expect(() => paginate(ten, 1, 0)).toThrow(RangeError)
  })
})

describe("describePage", () => {
  test("labels a middle page", () => {
    expect(describePage(10, 2, 4)).toBe("Showing 5-8 of 10")
  })
  test("labels the last page", () => {
    expect(describePage(10, 3, 4)).toBe("Showing 9-10 of 10")
  })
})
