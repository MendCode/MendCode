import { describe, expect, test } from "bun:test"
import { tuiText } from "@tui/util/text"

describe("TUI text payload boundary", () => {
  test("keeps valid text and drops malformed partial payloads", () => {
    expect(tuiText("hello")).toBe("hello")
    expect(tuiText(undefined)).toBe("")
    expect(tuiText(null)).toBe("")
    expect(tuiText({ text: "not a string" })).toBe("")
  })
})
