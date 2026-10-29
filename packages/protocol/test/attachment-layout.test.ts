import { describe, expect, test } from "bun:test"
import { BlobRef, Command, QueueAdded, createIdFactory } from "../src"
import { attachmentOrder, attachmentPlacementProblem, layoutAttachments } from "../src/wire"

const ids = createIdFactory()
const sha = (seed: string) => seed.repeat(64).slice(0, 64)
const ref = (seed: string, extra: Record<string, unknown> = {}) => ({ sha256: sha(seed), bytes: 10, mime: "image/png", ...extra })
const submit = (text: string, attachments: unknown[]) => ({ id: ids("command"), clientId: ids("client"), type: "user.submit", sessionId: ids("session"), text, attachments })

describe("layoutAttachments", () => {
  test("text up to and including each token, then its attachment, then the rest", () => {
    expect(layoutAttachments("a [Image #1] b [Image #2] c", [{ label: "[Image #1]", at: 12 }, { label: "[Image #2]", at: 24 }])).toEqual([{ text: "a [Image #1]" }, { ref: 0 }, { text: " b [Image #2]" }, { ref: 1 }, { text: " c" }])
  })

  test("no placed ref: undefined, so the plain text-then-media shape stays", () => {
    expect(layoutAttachments("sin tokens", [{}, {}])).toBeUndefined()
    expect(layoutAttachments("sin tokens", [])).toBeUndefined()
  })

  test("the label is the anchor: a stale offset is ignored and the label is found again", () => {
    expect(layoutAttachments("PRE a [Image #1] b", [{ label: "[Image #1]", at: 12 }])).toEqual([{ text: "PRE a [Image #1]" }, { ref: 0 }, { text: " b" }])
  })

  test("an offset that points at the right label wins over an earlier copy of the same label", () => {
    const text = "[Image #1] and again [Image #1]"
    expect(layoutAttachments(text, [{ label: "[Image #1]", at: text.length }])).toEqual([{ text }, { ref: 0 }])
  })

  test("two refs with one label take its two places in order", () => {
    expect(layoutAttachments("[Image #1] x [Image #1]", [{ label: "[Image #1]" }, { label: "[Image #1]" }])).toEqual([{ text: "[Image #1]" }, { ref: 0 }, { text: " x [Image #1]" }, { ref: 1 }])
  })

  test("a ref without a label, or whose label is gone, goes last in its own order", () => {
    expect(layoutAttachments("a [Image #1] b", [{}, { label: "[Image #1]" }, { label: "[Gone]" }])).toEqual([{ text: "a [Image #1]" }, { ref: 1 }, { text: " b" }, { ref: 0 }, { ref: 2 }])
  })

  test("a token at the very end leaves no empty text part", () => {
    expect(layoutAttachments("a [Image #1]", [{ label: "[Image #1]" }])).toEqual([{ text: "a [Image #1]" }, { ref: 0 }])
  })

  test("attachmentOrder follows the tokens; without tokens it is the order given", () => {
    expect(attachmentOrder("[B] then [A]", [{ label: "[A]" }, { label: "[B]" }, {}])).toEqual([1, 0, 2])
    expect(attachmentOrder("plain", [{}, {}])).toEqual([0, 1])
  })
})

describe("attachmentPlacementProblem", () => {
  test("accepts positions in range on distinct tokens and refs without positions", () => {
    expect(attachmentPlacementProblem("a [Image #1] [Image #2]", [{ label: "[Image #1]", at: 12 }, { label: "[Image #2]", at: 23 }, {}])).toBeUndefined()
  })

  test("refuses a position without its label, past the end, before its label, and two tokens on the same place", () => {
    expect(attachmentPlacementProblem("abc", [{ at: 2 }])).toMatch(/label/)
    expect(attachmentPlacementProblem("abc", [{ label: "[x]", at: 9 }])).toMatch(/past the end/)
    expect(attachmentPlacementProblem("abc [x]", [{ label: "[x]", at: 2 }])).toMatch(/before its label/)
    expect(attachmentPlacementProblem("[x] [y]", [{ label: "[x]", at: 3 }, { label: "[y]", at: 5 }])).toMatch(/same token/)
  })
})

describe("the wire", () => {
  test("user.submit takes positions in range and refuses the rest", () => {
    expect(Command.safeParse(submit("a [Image #1] b", [ref("1", { label: "[Image #1]", at: 12 })])).success).toBe(true)
    expect(Command.safeParse(submit("a [Image #1] b", [ref("1", { label: "[Image #1]", at: 99 })])).success).toBe(false)
    expect(Command.safeParse(submit("a [Image #1] b", [ref("1", { at: 12 })])).success).toBe(false)
    expect(Command.safeParse(submit("a [Image #1] b", [ref("1", { label: "[Image #1]", at: 12 }), ref("2", { label: "[Image #1]", at: 12 })])).success).toBe(false)
    expect(Command.safeParse(submit("a [Image #1] b", [ref("1", { label: "[Image #1]", at: -1 })])).success).toBe(false)
  })

  test("a submit from before tokens (refs with no label and no position) is unchanged", () => {
    const old = submit("hola", [ref("1", { name: "shot.png" })])
    expect(Command.parse(old)).toMatchObject({ text: "hola", attachments: [{ sha256: sha("1"), name: "shot.png" }] })
    expect(Command.safeParse(submit("hola", [])).success).toBe(true)
  })

  test("the new fields are optional and only these two: a ref still refuses unknown keys", () => {
    expect(BlobRef.safeParse(ref("1")).success).toBe(true)
    expect(BlobRef.safeParse(ref("1", { label: "[Image #1]", at: 4 })).success).toBe(true)
    expect(BlobRef.safeParse(ref("1", { label: "x".repeat(81) })).success).toBe(false)
    expect(BlobRef.safeParse(ref("1", { place: 3 })).success).toBe(false)
  })

  test("a queued message keeps the refs with their tokens", () => {
    const event = { type: "queue.added", sessionId: ids("session"), seq: 1, at: 1, queueId: ids("queue"), text: "a [Image #1]", attachments: [ref("1", { label: "[Image #1]", at: 12 })] }
    expect(QueueAdded.safeParse(event).success).toBe(true)
    expect(QueueAdded.parse(event).attachments[0]).toMatchObject({ label: "[Image #1]", at: 12 })
  })
})
