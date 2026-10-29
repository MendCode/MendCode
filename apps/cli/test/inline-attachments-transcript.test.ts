import { describe, expect, test } from "bun:test"
import { messageRows, outsideText } from "../src/view/chat-blocks"
import { textWidth } from "../src/view/wrap"
import { conversation } from "./session-ui-harness"
import { bench } from "./inline-attachments-helpers"

/** The sent message in the transcript shows its tokens as chips inside the sentence, the way the prompt does. */

const plain = (row: Array<{ text: string }>) => row.map((span) => span.text).join("")
const IMAGE = { mime: "image/png", label: "[Image #1]", name: "one.png" }
const PDF = { mime: "application/pdf", label: "[PDF spec.pdf]", name: "spec.pdf" }

describe("messageRows", () => {
  test("a token is a chip in its kind's colour inside the sentence; the rest is plain text", () => {
    const [row] = messageRows("mira [Image #1] ya", [IMAGE], 80, [{ text: "  " }])
    expect(plain(row!)).toBe("  mira [Image #1] ya")
    expect(row!.find((span) => span.text === "[Image #1]")).toMatchObject({ fg: "background", bg: "accent" })
    expect(row!.find((span) => span.text.includes("mira"))).toMatchObject({ fg: "text" })
  })

  test("a PDF is the primary colour, a token the text has twice is a chip only where its attachment is", () => {
    const [row] = messageRows("[PDF spec.pdf] y [Image #1] y [Image #1]", [PDF, IMAGE], 80, [])
    expect(row!.filter((span) => span.bg)).toEqual([expect.objectContaining({ text: "[PDF spec.pdf]", bg: "primary" }), expect.objectContaining({ text: "[Image #1]", bg: "accent" })])
  })

  test("a token with a space in it moves to the next row whole, and the space is a space again", () => {
    const rows = messageRows("un texto largo [PDF spec.pdf] fin", [PDF], 20, [], [])
    const text = rows.map(plain)
    expect(text.some((row) => row.includes("[PDF spec.pdf]"))).toBe(true)
    for (const row of rows) expect(textWidth(plain(row))).toBeLessThanOrEqual(20)
    expect(text.join("").replaceAll(" ", "")).toBe("untextolargo[PDFspec.pdf]fin")
  })

  test("a folder or text file token (no ref, its block follows it) is a secondary chip too", () => {
    const rows = messageRows("lee [notes.txt]\n\n[attached file: notes.txt]\n```\nx\n```\n\nya [a] b", [], 80, [])
    expect(rows.flatMap((row) => row.filter((span) => span.bg))).toEqual([expect.objectContaining({ text: "[notes.txt]", bg: "secondary" })])
  })

  test("no label anywhere: the plain wrap it always was", () => {
    const text = "esto no tiene ningun token pero es bastante largo para cortar"
    const withAttachment = messageRows(text, [{ mime: "image/png", name: "a.png" }], 24, [{ text: "  " }], [{ text: "  " }])
    expect(withAttachment.every((row) => row.every((span) => !span.bg))).toBe(true)
  })

  test("a label that is not in the text is ignored", () => {
    const [row] = messageRows("sin token", [IMAGE], 80, [])
    expect(plain(row!)).toBe("sin token")
    expect(row!.some((span) => span.bg)).toBe(false)
  })
})

describe("the sentence is the only place a token's attachment is listed", () => {
  test("outsideText keeps attachments with no token and those whose token is not on screen, counting repeats", () => {
    expect(outsideText([IMAGE, PDF, { mime: "image/png", name: "old.png" }], "a [Image #1] b")).toEqual([PDF, { mime: "image/png", name: "old.png" }])
    expect(outsideText([IMAGE, IMAGE], "a [Image #1]")).toEqual([IMAGE])
  })

  test("a multi-line message keeps its line breaks and puts the chip on the line that holds the token", () => {
    const rows = messageRows("uno\ndos [Image #1]\ntres", [IMAGE], 40, [{ text: "> " }])
    expect(rows.map(plain)).toEqual(["> uno", "  dos [Image #1]", "  tres"])
    expect(rows[1]!.find((span) => span.bg)).toMatchObject({ text: "[Image #1]", bg: "accent" })
  })
})

describe("in the app", () => {
  test("a message the daemon reports with attachments shows its token as a chip and the chip row only for unlabeled ones", async () => {
    const b = bench({ width: 80 })
    const chat = conversation(b.h.sessionId, (event) => b.h.app.onEvent(event))
    chat.emit({ type: "turn.started", turnId: "turn_1", queueId: "queue_1" })
    chat.emit({ type: "item.started", turnId: "turn_1", itemId: "item_u1", kind: "user_message" })
    chat.emit({ type: "item.completed", itemId: "item_u1", status: "ok", text: "mira [Image #1] ya", attachments: [{ sha256: "1".repeat(64), bytes: 9, mime: "image/png", name: "one.png", label: "[Image #1]", at: 15 }] })
    chat.emit({ type: "item.started", turnId: "turn_1", itemId: "item_u2", kind: "user_message" })
    chat.emit({ type: "item.completed", itemId: "item_u2", status: "ok", text: "viejo", attachments: [{ sha256: "2".repeat(64), bytes: 9, mime: "image/png", name: "old.png" }] })
    b.h.app.render()
    const rows = b.h.text()
    expect(rows.some((row) => row.includes("mira [Image #1] ya"))).toBe(true)
    expect(rows.some((row) => row.includes("one.png"))).toBe(false)
    expect(rows.some((row) => row.includes("old.png"))).toBe(true)
  })
})
