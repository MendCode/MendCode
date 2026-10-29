import { describe, expect, test } from "bun:test"
import { parseBool, parseQuery } from "../src/parse"

describe("parseBool", () => {
  test("truthy words", () => {
    for (const word of ["true", "YES", " on ", "1"]) expect(parseBool(word)).toBe(true)
  })
  test("falsy words, including empty", () => {
    for (const word of ["false", "No", "off", "0", ""]) expect(parseBool(word)).toBe(false)
  })
  test("anything else is a syntax error", () => {
    expect(() => parseBool("maybe")).toThrow(SyntaxError)
  })
})

describe("parseQuery", () => {
  test("simple pairs and a leading question mark", () => {
    expect(parseQuery("?a=1&b=2")).toEqual({ a: "1", b: "2" })
  })
  test("repeated keys become arrays in order", () => {
    expect(parseQuery("a=1&b=2&a=3&a=4")).toEqual({ a: ["1", "3", "4"], b: "2" })
  })
  test("values are decoded and missing values are empty", () => {
    expect(parseQuery("name=Ana%20Ruiz&flag")).toEqual({ name: "Ana Ruiz", flag: "" })
  })
  test("empty input", () => {
    expect(parseQuery("")).toEqual({})
  })
})
