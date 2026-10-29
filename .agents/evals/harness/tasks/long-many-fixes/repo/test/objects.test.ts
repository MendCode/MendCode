import { describe, expect, test } from "bun:test"
import { groupBy, pick } from "../src/objects"

describe("groupBy", () => {
  test("collects items per key in input order", () => {
    expect(groupBy(["a", "bb", "cc", "d"], (word) => word.length)).toEqual({ 1: ["a", "d"], 2: ["bb", "cc"] })
  })
  test("string keys", () => {
    expect(groupBy([1, 2, 3, 4, 5], (n) => (n % 2 === 0 ? "even" : "odd"))).toEqual({ odd: [1, 3, 5], even: [2, 4] })
  })
  test("empty input", () => {
    expect(groupBy([], () => "x")).toEqual({})
  })
})

describe("pick", () => {
  test("copies the requested keys", () => {
    expect(pick({ a: 1, b: 2, c: 3 }, ["a", "c"])).toStrictEqual({ a: 1, c: 3 })
  })
  test("leaves out keys the object does not have", () => {
    const result = pick({ a: 1 } as { a: number; z?: number }, ["a", "z"])
    expect(Object.keys(result)).toEqual(["a"])
  })
  test("keeps keys whose value is undefined", () => {
    const result = pick({ a: undefined, b: 2 } as { a: undefined; b: number }, ["a"])
    expect(Object.keys(result)).toEqual(["a"])
  })
})
