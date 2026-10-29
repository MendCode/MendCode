import { describe, expect, test } from "bun:test"
import { attachmentLabel, attachmentToken, composeSubmission, sentImageNumber, formatAttachmentBytes, pastedPaths, type PendingAttachment } from "../src/view/attachments"

const image = (bytes: number, name = "shot.png"): PendingAttachment => ({ kind: "image", ref: { sha256: "a".repeat(64), bytes, mime: "image/png" }, name })
const textFile = (name: string, content: string): PendingAttachment => ({ kind: "text", name, content })

describe("formatAttachmentBytes", () => {
  test("bytes, KB and MB with base 1024 and one decimal", () => {
    expect(formatAttachmentBytes(512)).toBe("512 B")
    expect(formatAttachmentBytes(1536)).toBe("1.5 KB")
    expect(formatAttachmentBytes(12 * 1024 * 1024 + 400 * 1024)).toBe("12.4 MB")
  })
})

describe("attachmentLabel", () => {
  test("an image shows its index among images and its size, never its name", () => {
    const pending = [image(245_760, "clipboard.png")]
    expect(attachmentLabel(pending, 0)).toBe("[Image #1 · 240 KB]")
  })

  test("an image with known pixel size shows it between index and bytes", () => {
    const pending: PendingAttachment[] = [{ ...image(319_488), kind: "image", width: 1440, height: 900 }]
    expect(attachmentLabel(pending, 0)).toBe("[Image #1 · 1440×900 · 312 KB]")
  })

  test("indices count only images, skipping text attachments in between", () => {
    const pending = [image(1024), textFile("notes.md", "hi"), image(2048)]
    expect(attachmentLabel(pending, 0)).toBe("[Image #1 · 1 KB]")
    expect(attachmentLabel(pending, 1)).toBe("notes.md")
    expect(attachmentLabel(pending, 2)).toBe("[Image #2 · 2 KB]")
  })
})

describe("composeSubmission", () => {
  test("PDF chips show name/size and submit as a blob ref, never as fenced text or an image index", () => {
    const doc: PendingAttachment = { kind: "document", ref: { sha256: "b".repeat(64), bytes: 2048, mime: "application/pdf" }, name: "design.pdf" }
    const pending = [image(1024), doc, image(512)]
    expect(attachmentLabel(pending, 1)).toBe("design.pdf · 2 KB")
    expect(attachmentLabel(pending, 2)).toBe("[Image #2 · 512 B]")
    expect(composeSubmission("review", [doc])).toEqual({ text: "review", attachments: [{ ...doc.ref, name: "design.pdf" }] })
  })
  test("image refs go to attachments with their file name; the typed text is unchanged when there is no text attachment", () => {
    const pending = [image(1024)]
    expect(composeSubmission("hola", pending)).toEqual({ text: "hola", attachments: [{ sha256: "a".repeat(64), bytes: 1024, mime: "image/png", name: "shot.png" }] })
  })

  test("a text attachment is fenced with its name and appended, never sent as an image ref", () => {
    const pending: PendingAttachment[] = [textFile("notes.txt", "line one\nline two")]
    const result = composeSubmission("revisa esto", pending)
    expect(result.attachments).toEqual([])
    expect(result.text).toBe("revisa esto\n\n[attached file: notes.txt]\n```\nline one\nline two\n```")
  })

  test("attachments only (no typed text) still submits the fenced content", () => {
    const result = composeSubmission("", [textFile("a.txt", "x")])
    expect(result.text).toBe("[attached file: a.txt]\n```\nx\n```")
  })

  test("only images and empty text composes to empty text (unchanged prior behavior)", () => {
    expect(composeSubmission("", [image(10)]).text).toBe("")
  })
})

describe("pastedPaths", () => {
  test("a single quoted path is one path", () => {
    expect(pastedPaths("'/tmp/My Shot.png'")).toEqual(["'/tmp/My Shot.png'"])
  })

  test("several path lines are all returned in order", () => {
    expect(pastedPaths("/tmp/a.png\n~/b.txt\nfile:///tmp/c.pdf")).toEqual(["/tmp/a.png", "~/b.txt", "file:///tmp/c.pdf"])
  })

  test("blank lines between paths are ignored", () => {
    expect(pastedPaths("/tmp/a.png\n\n\n/tmp/b.png")).toEqual(["/tmp/a.png", "/tmp/b.png"])
  })

  test("plain prose is not a path paste, even if one line starts with a slash", () => {
    expect(pastedPaths("check /etc/passwd for the format")).toBeUndefined()
  })

  test("a mix of a path and prose is not a paths-only paste", () => {
    expect(pastedPaths("/tmp/a.png\nplease look at this")).toBeUndefined()
  })

  test("an empty paste is not a paths paste", () => {
    expect(pastedPaths("   \n  ")).toBeUndefined()
  })
})

describe("image numbers across a session", () => {
  test("a new image goes on from the images the session already sent, not from #1", () => {
    const sent = [{ attachments: [{ mime: "image/png", label: "[Image #1]" }, { mime: "image/png", label: "[Image #2]" }] }, { attachments: [{ mime: "image/jpeg", label: "[Image #3]" }] }, {}]
    expect(sentImageNumber(sent)).toBe(3)
    expect(attachmentToken([], { ...image(10), label: undefined } as PendingAttachment, sentImageNumber(sent))).toBe("[Image #4]")
  })

  test("unlabelled sent images still count, PDFs do not, and a pending image numbers past both", () => {
    expect(sentImageNumber([{ attachments: [{ mime: "image/png" }, { mime: "application/pdf", label: "[PDF a.pdf]" }, { mime: "image/png" }] }])).toBe(2)
    const pending = [{ ...image(10), label: "[Image #5]" }] as PendingAttachment[]
    expect(attachmentToken(pending, image(20), 2)).toBe("[Image #6]")
    expect(attachmentToken([], image(20))).toBe("[Image #1]")
  })
})
