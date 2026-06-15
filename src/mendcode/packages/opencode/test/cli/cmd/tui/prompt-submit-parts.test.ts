import { describe, expect, test } from "bun:test"
import {
  DEFAULT_PASTE_SUMMARY_MIN_CHARS,
  messagePartsToPortableClipboard,
  parsePortableImageClipboard,
  pastedContentLabel,
  promptSubmitParts,
  restorePromptFromSubmittedParts,
  shouldSummarizePastedContent,
  shouldSummarizePastedContentWithThreshold,
} from "../../../../src/cli/cmd/tui/component/prompt/submit-parts"

describe("prompt submit parts", () => {
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

  test("serializes submitted image attachments as portable clipboard data URLs", () => {
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
    expect(result.firstImage).toEqual({ mime: "image/png", data: "aGVsbG8=" })
    expect(result.text).toBe("inspect ![clip.png](data:image/png;base64,aGVsbG8=) please")
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
