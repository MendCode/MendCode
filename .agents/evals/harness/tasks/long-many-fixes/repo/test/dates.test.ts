import { describe, expect, test } from "bun:test"
import { isLeapYear, weekdayName } from "../src/dates"

describe("isLeapYear", () => {
  test("ordinary leap years", () => {
    expect(isLeapYear(2024)).toBe(true)
    expect(isLeapYear(2023)).toBe(false)
  })
  test("century years are not leap unless divisible by 400", () => {
    expect(isLeapYear(1900)).toBe(false)
    expect(isLeapYear(2100)).toBe(false)
    expect(isLeapYear(2000)).toBe(true)
  })
})

describe("weekdayName", () => {
  test("uses Date#getDay numbering", () => {
    expect(weekdayName(0)).toBe("Sunday")
    expect(weekdayName(6)).toBe("Saturday")
    expect(weekdayName(new Date("2026-03-04T12:00:00Z").getUTCDay())).toBe("Wednesday")
  })
  test("out of range throws", () => {
    expect(() => weekdayName(7)).toThrow(RangeError)
    expect(() => weekdayName(-1)).toThrow(RangeError)
    expect(() => weekdayName(1.5)).toThrow(RangeError)
  })
})
