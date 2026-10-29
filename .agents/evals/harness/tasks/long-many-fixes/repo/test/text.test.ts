import { describe, expect, test } from "bun:test"
import { isPalindrome, wordCount } from "../src/text"

describe("isPalindrome", () => {
  test("plain palindromes", () => {
    expect(isPalindrome("level")).toBe(true)
    expect(isPalindrome("level up")).toBe(false)
  })
  test("ignores case, spaces and punctuation", () => {
    expect(isPalindrome("A man, a plan, a canal: Panama")).toBe(true)
  })
  test("digits count", () => {
    expect(isPalindrome("12 3 21")).toBe(true)
    expect(isPalindrome("12 3 4")).toBe(false)
  })
  test("empty text is a palindrome", () => {
    expect(isPalindrome("")).toBe(true)
  })
})

describe("wordCount", () => {
  test("counts runs of non-space characters", () => {
    expect(wordCount("  a  b ")).toBe(2)
  })
  test("tabs and newlines separate words too", () => {
    expect(wordCount("one\ttwo\nthree")).toBe(3)
  })
  test("empty and blank text have no words", () => {
    expect(wordCount("")).toBe(0)
    expect(wordCount("   ")).toBe(0)
  })
})
