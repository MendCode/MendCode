import { describe, expect, test } from "bun:test"
import {
  expandPastedContentPlaceholders,
  isPastedContentPart,
  userMessageDisplayText,
} from "../../../../src/cli/cmd/tui/routes/session/user-message-display"

describe("user message display text", () => {
  test("keeps short user messages unchanged", () => {
    expect(userMessageDisplayText("hello")).toEqual({
      text: "hello",
      compacted: false,
      hiddenLines: 0,
      hiddenChars: 0,
    })
  })

  test("compacts long historical messages without losing the full backing text", () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n")
    const display = userMessageDisplayText(text, { maxLines: 4, maxChars: 200 })

    expect(display.compacted).toBe(true)
    expect(display.text).toBe("line 1\nline 2\nline 3\nline 4")
    expect(display.hiddenLines).toBe(36)
    expect(display.hiddenChars).toBeGreaterThan(0)
  })

  test("compacts by char count for long single-line prompts", () => {
    const display = userMessageDisplayText("x".repeat(500), { maxLines: 10, maxChars: 80 })

    expect(display.compacted).toBe(true)
    expect(display.text.length).toBe(79)
    expect(display.hiddenChars).toBe(421)
  })

  test("expands pasted content placeholders from synthetic text parts", () => {
    const parts = [
      {
        type: "text",
        synthetic: true,
        text: "real pasted content",
        metadata: { kind: "pasted_content" },
      },
    ]

    expect(isPastedContentPart(parts[0])).toBe(true)
    expect(expandPastedContentPlaceholders("before [Pasted Content 19 chars] after", parts)).toBe(
      "before [Pasted Content 19 chars]\nreal pasted content after",
    )
  })

  test("appends pasted content when a legacy placeholder cannot be matched", () => {
    const expanded = expandPastedContentPlaceholders("visible text", [
      {
        text: "missing source paste",
        metadata: { kind: "pasted_content" },
      },
    ])

    expect(expanded).toBe("visible text\n\n[Pasted Content 20 chars]\nmissing source paste")
  })
})
