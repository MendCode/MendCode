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

  test("last page holds the remainder", () => {
    const result = paginate(ten, 3, 4)
    expect(result.items).toEqual([9, 10])
    expect(result.hasNext).toBe(false)
    expect(result.pageCount).toBe(3)
  })

  test("a page past the end is empty", () => {
    expect(paginate(ten, 4, 4).items).toEqual([])
  })
})

describe("describePage", () => {
  test("labels a middle page", () => {
    expect(describePage(10, 2, 4)).toBe("Showing 5-8 of 10")
  })
})
