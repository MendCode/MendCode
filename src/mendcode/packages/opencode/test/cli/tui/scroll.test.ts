import { expect, test } from "bun:test"
import { isScrollboxAtBottom, isScrollboxAtTop } from "../../../src/cli/cmd/tui/util/scroll"

test("isScrollboxAtBottom treats only near-bottom scroll positions as following output", () => {
  expect(isScrollboxAtBottom({ scrollTop: 75, scrollHeight: 100, viewport: { height: 25 } })).toBe(true)
  expect(isScrollboxAtBottom({ scrollTop: 74, scrollHeight: 100, viewport: { height: 25 } })).toBe(true)
  expect(isScrollboxAtBottom({ scrollTop: 60, scrollHeight: 100, viewport: { height: 25 } })).toBe(false)
})

test("isScrollboxAtTop only treats the real top as the paging boundary by default", () => {
  expect(isScrollboxAtTop({ scrollTop: 0 })).toBe(true)
  expect(isScrollboxAtTop({ scrollTop: 1 })).toBe(false)
  expect(isScrollboxAtTop({ scrollTop: 80 })).toBe(false)
})

test("isScrollboxAtTop can opt into a caller supplied tolerance", () => {
  expect(isScrollboxAtTop({ scrollTop: 1 }, 1)).toBe(true)
  expect(isScrollboxAtTop({ scrollTop: 2 }, 1)).toBe(false)
})
