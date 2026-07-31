import { describe, expect, test } from "bun:test"
import {
  BLANK_USER_MESSAGE_DISPLAY_TEXT,
  expandedUserMessageOffset,
  expandedUserMessagePageOffset,
  expandPastedContentPlaceholders,
  hiddenUserMessageAttachmentCount,
  isPastedContentPart,
  shouldCollapseUserMessageAttachments,
  USER_MESSAGE_ATTACHMENT_COLLAPSE_THRESHOLD,
  userMessageDisplayText,
  visibleUserMessageAttachments,
  visibleUserMessageText,
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

  test("shows whitespace-only user messages with a visible placeholder", () => {
    expect(visibleUserMessageText(" ")).toBe(BLANK_USER_MESSAGE_DISPLAY_TEXT)
    expect(visibleUserMessageText("\n\t")).toBe(BLANK_USER_MESSAGE_DISPLAY_TEXT)
    expect(userMessageDisplayText(" ")).toEqual({
      text: BLANK_USER_MESSAGE_DISPLAY_TEXT,
      compacted: false,
      hiddenLines: 0,
      hiddenChars: 0,
    })
  })

  test("keeps three attachment badges visible before the show-more row", () => {
    const files = Array.from({ length: 15 }, (_, index) => ({ id: index + 1 }))

    expect(USER_MESSAGE_ATTACHMENT_COLLAPSE_THRESHOLD).toBe(3)
    expect(shouldCollapseUserMessageAttachments(3)).toBe(false)
    expect(shouldCollapseUserMessageAttachments(4)).toBe(true)
    expect(hiddenUserMessageAttachmentCount(files.length)).toBe(12)
    expect(visibleUserMessageAttachments(files, false)).toEqual(files.slice(0, 3))
    expect(visibleUserMessageAttachments(files, true)).toBe(files)
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

  test("clamps expanded message offsets for header and scrollbar controls", () => {
    expect(expandedUserMessageOffset({ offset: -10, maxOffset: 100 })).toBe(0)
    expect(expandedUserMessageOffset({ offset: 10, maxOffset: -1 })).toBe(0)
    expect(expandedUserMessageOffset({ offset: 40, maxOffset: 100 })).toBe(40)
    expect(expandedUserMessageOffset({ offset: 120, maxOffset: 100 })).toBe(100)
    expect(expandedUserMessagePageOffset({ currentOffset: 0, viewportRows: 15, maxOffset: 505, direction: "down" })).toBe(15)
    expect(expandedUserMessagePageOffset({ currentOffset: 510, viewportRows: 15, maxOffset: 505, direction: "down" })).toBe(505)
    expect(expandedUserMessagePageOffset({ currentOffset: 5, viewportRows: 15, maxOffset: 505, direction: "up" })).toBe(0)
  })
})
