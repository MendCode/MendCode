import { describe, expect, test } from "bun:test"
import { formatDuration, toRoman } from "../src/format"

describe("formatDuration", () => {
  test("hours, minutes and seconds", () => {
    expect(formatDuration(3725)).toBe("1h 2m 5s")
  })
  test("zero units are left out", () => {
    expect(formatDuration(3600)).toBe("1h")
    expect(formatDuration(3605)).toBe("1h 5s")
    expect(formatDuration(120)).toBe("2m")
    expect(formatDuration(59)).toBe("59s")
  })
  test("zero is 0s", () => {
    expect(formatDuration(0)).toBe("0s")
  })
})

describe("toRoman", () => {
  test("subtractive forms", () => {
    expect(toRoman(4)).toBe("IV")
    expect(toRoman(9)).toBe("IX")
    expect(toRoman(40)).toBe("XL")
    expect(toRoman(90)).toBe("XC")
    expect(toRoman(400)).toBe("CD")
    expect(toRoman(900)).toBe("CM")
  })
  test("larger numbers", () => {
    expect(toRoman(1994)).toBe("MCMXCIV")
    expect(toRoman(3999)).toBe("MMMCMXCIX")
    expect(toRoman(58)).toBe("LVIII")
  })
  test("out of range throws", () => {
    expect(() => toRoman(0)).toThrow(RangeError)
    expect(() => toRoman(4000)).toThrow(RangeError)
  })
})
