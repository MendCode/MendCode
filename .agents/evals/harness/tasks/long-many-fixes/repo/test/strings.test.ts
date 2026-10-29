import { describe, expect, test } from "bun:test"
import { capitalizeWords, slugify } from "../src/strings"

describe("slugify", () => {
  test("collapses runs of separators", () => {
    expect(slugify("Hello,  World!")).toBe("hello-world")
  })
  test("trims leading and trailing separators", () => {
    expect(slugify("  --A  B--  ")).toBe("a-b")
  })
  test("keeps digits", () => {
    expect(slugify("Route 66")).toBe("route-66")
  })
  test("nothing alphanumeric gives an empty slug", () => {
    expect(slugify("!!!")).toBe("")
  })
})

describe("capitalizeWords", () => {
  test("upper-cases the first letter of each word", () => {
    expect(capitalizeWords("the quick  brown fox")).toBe("The Quick  Brown Fox")
  })
  test("lower-cases the rest", () => {
    expect(capitalizeWords("hELLO wORLD")).toBe("Hello World")
  })
  test("empty input", () => {
    expect(capitalizeWords("")).toBe("")
  })
})
