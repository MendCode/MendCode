import { expect, test } from "bun:test"
import { isScrollboxAtBottom } from "../../../src/cli/cmd/tui/util/scroll"

test("isScrollboxAtBottom treats only near-bottom scroll positions as following output", () => {
  expect(isScrollboxAtBottom({ scrollTop: 75, scrollHeight: 100, viewport: { height: 25 } })).toBe(true)
  expect(isScrollboxAtBottom({ scrollTop: 74, scrollHeight: 100, viewport: { height: 25 } })).toBe(true)
  expect(isScrollboxAtBottom({ scrollTop: 60, scrollHeight: 100, viewport: { height: 25 } })).toBe(false)
})
