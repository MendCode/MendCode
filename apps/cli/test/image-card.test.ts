import { describe, expect, test } from "bun:test"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { createTranscript, type PresentationMode } from "../src/view/transcript"
import { glyphs } from "../src/ui/theme"

const ids = createIdFactory()
const sessionId = ids("session")
const turnId = ids("turn")
const sha = "c".repeat(64)

function generatedImage(mode: PresentationMode, text: string) {
  let seq = 0
  const ev = (e: Record<string, unknown>) => ({ sessionId, seq: ++seq, at: 0, ...e }) as SessionEvent
  const t = createTranscript({ glyphs: glyphs({}), mode })
  const itemId = ids("item")
  t.apply(ev({ type: "turn.started", turnId, queueId: ids("queue") }))
  t.apply(ev({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "image_generation" } }))
  t.apply(ev({ type: "item.completed", itemId, status: "ok", text, attachments: [{ sha256: sha, bytes: 10, mime: "image/png" }] }))
  return t.viewport(80, 20).map((l) => l.text).filter(Boolean)
}

describe("image_generation card", () => {
  const path = `/data/blobs/cc/${sha}`
  for (const mode of ["minimal", "balanced", "full"] as const) {
    test(`${mode}: an image line with the blob path follows the card`, () => {
      const lines = generatedImage(mode, `A small green square icon\n${path}`)
      expect(lines.some((l) => l.includes(mode === "minimal" ? "image_generation" : "◧ Image"))).toBe(true)
      expect(lines.join("")).toContain("■ 1 image · ")
      expect(lines.join("").replace(/\s/g, "")).toContain(path)
    })
  }
  test("without a path in the text only the image count shows", () => {
    const lines = generatedImage("balanced", "A small green square icon")
    expect(lines.find((l) => l.includes("■"))).toBe("    ■ 1 image")
  })
})
