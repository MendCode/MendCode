import { describe, expect, test } from "bun:test"
import {
  DEFAULT_PASTE_SUMMARY_MIN_CHARS,
  appendPromptInfo,
  expandEditedPastedContentInPrompt,
  expandPastedContentAtOffset,
  expandPastedContentInPrompt,
  messagePartsToPortableClipboard,
  parsePortableImageClipboard,
  pastedContentLabel,
  promptSubmitParts,
  restorePromptFromSubmittedParts,
  shouldSummarizePastedContent,
  shouldSummarizePastedContentWithThreshold,
} from "../../../../src/cli/cmd/tui/component/prompt/submit-parts"

describe("prompt submit parts", () => {
  test("appends an edited message without replacing the current draft", () => {
    const result = appendPromptInfo(
      { input: "keep this draft", parts: [] },
      {
        input: "edit this queued message",
        parts: [
          {
            type: "agent",
            name: "explore",
            source: { start: 0, end: 7, value: "explore" },
          },
        ],
      },
    )

    expect(result.input).toBe("keep this draft\n\nedit this queued message")
    expect(result.parts).toEqual([
      {
        type: "agent",
        name: "explore",
        source: { start: 17, end: 24, value: "explore" },
      },
    ])
  })

  test("keeps an empty draft from adding a separator when editing a message", () => {
    expect(appendPromptInfo({ input: "", parts: [] }, { input: "queued", parts: [] })).toEqual({
      input: "queued",
      parts: [],
    })
  })

  test("summarizes large pasted content in the visible prompt", () => {
    expect(shouldSummarizePastedContent("one\ntwo\nthree")).toBe(false)
    expect(shouldSummarizePastedContent("short")).toBe(false)
    expect(shouldSummarizePastedContent("a".repeat(DEFAULT_PASTE_SUMMARY_MIN_CHARS))).toBe(false)
    expect(shouldSummarizePastedContent("a".repeat(DEFAULT_PASTE_SUMMARY_MIN_CHARS + 1))).toBe(true)
    expect(shouldSummarizePastedContentWithThreshold("a".repeat(501), 500)).toBe(true)
    expect(pastedContentLabel("abc")).toBe("[Pasted Content 3 chars]")
  })

  test("keeps pasted content out of the visible user message while sending it to the model", () => {
    const pasted = "large pasted context\n".repeat(20)
    const result = promptSubmitParts({
      input: `review this ${pastedContentLabel(pasted)}`,
      parts: [
        {
          type: "text",
          text: pasted,
          source: {
            text: {
              start: 12,
              end: 41,
              value: pastedContentLabel(pasted),
            },
          },
        },
      ],
    })

    expect(result.parts).toHaveLength(2)
    expect(result.parts[0]).toMatchObject({
      type: "text",
      text: `review this ${pastedContentLabel(pasted)}`,
    })
    expect(result.parts[1]).toMatchObject({
      type: "text",
      text: pasted,
      synthetic: true,
      source: {
        text: {
          value: pastedContentLabel(pasted),
        },
      },
      metadata: {
        kind: "pasted_content",
        chars: pasted.length,
      },
    })
  })

  test("preserves whitespace-only prompt input as an intentional user message", () => {
    const result = promptSubmitParts({
      input: " ",
      parts: [],
    })

    expect(result.parts).toEqual([
      {
        type: "text",
        text: " ",
      },
    ])
  })

  test("restores reverted pasted content placeholders with the real text part intact", () => {
    const pasted = "large pasted context\n".repeat(20)
    const label = pastedContentLabel(pasted)

    const restored = restorePromptFromSubmittedParts([
      {
        id: "prt_visible",
        sessionID: "ses",
        messageID: "msg",
        type: "text",
        text: `review this ${label}`,
      },
      {
        id: "prt_pasted",
        sessionID: "ses",
        messageID: "msg",
        type: "text",
        text: pasted,
        synthetic: true,
        metadata: {
          kind: "pasted_content",
          chars: pasted.length,
        },
      },
    ])

    expect(restored.input).toBe(`review this ${label}`)
    expect(restored.parts).toHaveLength(1)
    expect(restored.parts[0]).toMatchObject({
      type: "text",
      text: pasted,
      source: {
        text: {
          start: 12,
          end: 12 + label.length,
          value: label,
        },
      },
    })
  })

  test("expands an existing pasted content placeholder when the same text is pasted again", () => {
    const pasted = "large pasted context\n".repeat(20)
    const label = pastedContentLabel(pasted)
    const otherPasted = "other pasted context\n".repeat(20)
    const otherLabel = pastedContentLabel(otherPasted)
    const result = expandPastedContentInPrompt(
      {
        input: `review ${label} ${otherLabel}`,
        parts: [
          {
            type: "text",
            text: pasted,
            source: {
              text: {
                start: 7,
                end: 7 + label.length,
                value: label,
              },
            },
          },
          {
            type: "text",
            text: otherPasted,
            source: {
              text: {
                start: 8 + label.length,
                end: 8 + label.length + otherLabel.length,
                value: otherLabel,
              },
            },
          },
        ],
      },
      pasted,
    )

    expect(result?.input).toBe(`review ${pasted} ${otherLabel}`)
    expect(result?.cursorOffset).toBe(7 + pasted.length)
    expect(result?.parts).toHaveLength(1)
    expect(result?.parts[0]).toMatchObject({
      type: "text",
      text: otherPasted,
      source: {
        text: {
          start: 8 + pasted.length,
          end: 8 + pasted.length + otherLabel.length,
          value: otherLabel,
        },
      },
    })
  })

  test("expands pasted content at a cursor offset inside the placeholder", () => {
    const pasted = "large pasted context\n".repeat(20)
    const label = pastedContentLabel(pasted)
    const result = expandPastedContentAtOffset(
      {
        input: `review ${label}`,
        parts: [
          {
            type: "text",
            text: pasted,
            source: {
              text: {
                start: 7,
                end: 7 + label.length,
                value: label,
              },
            },
          },
        ],
      },
      10,
    )

    expect(result?.input).toBe(`review ${pasted}`)
    expect(result?.cursorOffset).toBe(7 + pasted.length)
    expect(result?.parts).toEqual([])
  })

  test("expands pasted content when the visible placeholder is edited", () => {
    const pasted = "large pasted context\n".repeat(20)
    const label = pastedContentLabel(pasted)
    const editedLabel = label.replace("Content", "XDD")
    const result = expandEditedPastedContentInPrompt({
      input: `review ${editedLabel}`,
      parts: [
        {
          type: "text",
          text: pasted,
          source: {
            text: {
              start: 7,
              end: 7 + editedLabel.length,
              value: label,
            },
          },
        },
      ],
    })

    expect(result?.input).toBe(`review ${pasted}`)
    expect(result?.cursorOffset).toBe(7 + pasted.length)
    expect(result?.parts).toEqual([])
  })

  test("serializes submitted image attachments as text placeholders", () => {
    const result = messagePartsToPortableClipboard([
      {
        id: "prt_text",
        sessionID: "ses",
        messageID: "msg",
        type: "text",
        text: "inspect [Image 1] please",
      },
      {
        id: "prt_image",
        sessionID: "ses",
        messageID: "msg",
        type: "file",
        mime: "image/png",
        filename: "clip.png",
        url: "data:image/png;base64,aGVsbG8=",
        source: {
          text: {
            start: 8,
            end: 17,
            value: "[Image 1]",
          },
        },
      },
    ])

    expect(result.imageCount).toBe(1)
    expect(result.text).toBe("inspect [Image 1: clip.png] please")
    expect(result.text).not.toContain("base64")
  })

  test("serializes image-only submitted messages as copyable text", () => {
    const result = messagePartsToPortableClipboard([
      {
        id: "prt_image",
        sessionID: "ses",
        messageID: "msg",
        type: "file",
        mime: "image/png",
        filename: "screen.png",
        url: "data:image/png;base64,aGVsbG8=",
      },
    ])

    expect(result.imageCount).toBe(1)
    expect(result.text).toBe("[Image 1: screen.png]")
    expect(result.text).not.toContain("base64")
  })

  test("parses portable clipboard image data URLs back into paste tokens", () => {
    const tokens = parsePortableImageClipboard("before ![clip.png](data:image/png;base64,aGVsbG8=) after")

    expect(tokens).toEqual([
      { type: "text", text: "before " },
      { type: "image", filename: "clip.png", mime: "image/png", content: "aGVsbG8=" },
      { type: "text", text: " after" },
    ])
  })
})
