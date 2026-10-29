import { describe, expect, test } from "bun:test"
import { attachmentToken, chipRowAttachments, composeSubmission, draftRefs, liveAttachments, pendingFromRefs, type PendingAttachment } from "../src/view/attachments"
import { bench, paste } from "./inline-attachments-helpers"

/**
 * Inline attachment tokens in the wired app: what a paste, a drop, /attach and the clipboard key put in the prompt, what the daemon is
 * sent, and what a draft, a stash, the history and an edit-and-resend give back.
 */

const SHOT = "/shots/one.png"
const SHOT2 = "/shots/two.png"
const PDF = "/docs/design-spec.pdf"
const NOTES = "/docs/notes.txt"
const FOLDER = "/repos/codeconfig"

describe("what lands in the prompt", () => {
  test("an image and a folder pasted after a sentence become two tokens inside it", async () => {
    const b = bench()
    await b.type("configura mi mend de mi pc que tenga un package de seda 9.7 de ")
    await b.type(paste(SHOT))
    await b.type(paste(FOLDER))
    expect(b.prompt()).toContain("de [Image #1] [codeconfig/]")
  })

  test("the model is sent the sentence with its tokens, the folder listing after its token, and the image's position", async () => {
    const b = bench()
    await b.type("mira ")
    await b.type(paste(SHOT))
    await b.type(paste(FOLDER))
    await b.type("fin")
    await b.type("\r")
    const sent = b.submitted()!
    expect(sent.text.startsWith("mira [Image #1] [codeconfig/]\n\n[attached file: codeconfig]\n```\n")).toBe(true)
    expect(sent.text.endsWith("```\n\nfin")).toBe(true)
    expect(sent.attachments).toHaveLength(1)
    expect(sent.attachments[0]).toMatchObject({ label: "[Image #1]", name: "one.png", mime: "image/png", at: "mira [Image #1]".length })
  })

  test("a file with no attachments is sent exactly as before: text and an empty list", async () => {
    const b = bench()
    await b.type("solo texto")
    await b.type("\r")
    expect(b.submitted()).toMatchObject({ text: "solo texto", attachments: [] })
  })

  test("a drop of several paths lands the tokens in the order of the drop, one space apart", async () => {
    const b = bench()
    await b.type(paste(`${SHOT}\n${PDF}\n${SHOT2}`))
    expect(b.prompt()).toContain("[Image #1] [PDF design-spec.pdf] [Image #2]")
  })

  test("a path pasted in the middle of a word splits it with spaces; the word is not glued to the token", async () => {
    const b = bench()
    await b.type("configurar")
    for (let n = 0; n < 6; n++) await b.type("\x1b[D")
    await b.type(paste(SHOT))
    expect(b.prompt()).toContain("conf [Image #1] igurar")
  })

  test("a PDF and a text file get their name in the token", async () => {
    const b = bench()
    await b.type(paste(PDF))
    await b.type(paste(NOTES))
    expect(b.prompt()).toContain("[PDF design-spec.pdf] [notes.txt]")
  })

  test("a text file is sent inside the text, after its token", async () => {
    const b = bench()
    await b.type("lee ")
    await b.type(paste(NOTES))
    await b.type("ya")
    await b.type("\r")
    expect(b.submitted()!.text).toBe("lee [notes.txt]\n\n[attached file: notes.txt]\n```\nline one\nline two\n```\n\nya")
    expect(b.submitted()!.attachments).toEqual([])
  })

  test("the clipboard key adds a token at the cursor", async () => {
    const b = bench()
    await b.type("ver ")
    await b.type("\x16")
    expect(b.prompt()).toContain("ver [Image #1]")
    await b.type("\x16")
    expect(b.prompt()).toContain("ver [Image #1] [Image #2]")
  })

  test("/attach adds the token to the prompt the command leaves behind", async () => {
    const b = bench()
    await b.type(`/attach ${SHOT}\r`)
    expect(b.prompt()).toContain("[Image #1]")
    expect(b.prompt()).not.toContain("/attach")
  })

  test("a path pasted while the slash popup is open does not run the command: the text stays a command", async () => {
    const b = bench()
    await b.type("/")
    await b.type(paste(SHOT))
    expect(b.prompt()).toContain("[Image #1]")
  })

  test("a refusal is one line and inserts nothing: no token, no path", async () => {
    const b = bench()
    await b.type("antes ")
    await b.type(paste("/shots/missing.png"))
    expect(b.prompt()).not.toContain("[")
    expect(b.h.text().filter((row) => row.includes("not a file or directory")).length).toBeGreaterThan(0)
  })

  test("a limit refusal (too big) inserts nothing and keeps the text", async () => {
    const b = bench({ reply: (command) => (command.type === "attachment.paste" ? ({ ok: false, error: { code: "invalid_command", message: "[ATTACHMENT]: big.png is over the 20 MB limit" } } as never) : undefined) })
    await b.type("antes ")
    await b.type(paste("/shots/big.png"))
    expect(b.prompt()).toContain("antes")
    expect(b.prompt()).not.toContain("[Image")
    expect(b.prompt()).not.toContain("big.png")
    expect(b.h.text().some((row) => row.includes("20 MB limit"))).toBe(true)
  })
})

describe("editing a token", () => {
  test("backspace after a token takes it, and its attachment is not sent", async () => {
    const b = bench()
    await b.type(paste(SHOT))
    await b.type("\x7f")
    await b.type("\x7f")
    await b.type("hola\r")
    expect(b.submitted()).toMatchObject({ text: "hola", attachments: [] })
  })

  test("a token deleted and brought back with undo sends its attachment again", async () => {
    const b = bench()
    await b.type("ver ")
    await b.type(paste(SHOT))
    await b.type("\x7f")
    await b.type("\x1f")
    expect(b.prompt()).toContain("[Image #1]")
    await b.type("\r")
    expect(b.submitted()!.attachments).toHaveLength(1)
  })

  test("the token that is not a token any more (half of it was cut by hand) is plain text and sends no attachment", async () => {
    const b = bench()
    await b.type(paste(SHOT))
    await b.type("\x7f")
    await b.type("\x7f")
    await b.type("[Image #1")
    await b.type("\r")
    expect(b.submitted()).toMatchObject({ text: "[Image #1", attachments: [] })
  })

  test("an empty prompt holding only a token submits; one holding nothing does not", async () => {
    const b = bench()
    await b.type("\r")
    expect(b.submitted()).toBeUndefined()
    await b.type(paste(SHOT))
    await b.type("\r")
    expect(b.submitted()).toMatchObject({ attachments: [{ label: "[Image #1]" }] })
  })
})

describe("the setting", () => {
  test("above: no token in the text, the chip row over the prompt, the attachment goes after the text", async () => {
    const b = bench({ profile: { attachmentChips: "above" } })
    await b.type("ver ")
    await b.type(paste(SHOT))
    expect(b.prompt()).not.toContain("[Image #1]")
    expect(b.h.text().some((row) => row.includes("[Image #1 · 1262×540"))).toBe(true)
    await b.type("\r")
    expect(b.submitted()).toMatchObject({ text: "ver", attachments: [{ name: "one.png" }] })
    expect(b.submitted()!.attachments[0]).not.toHaveProperty("label")
    expect(b.submitted()!.attachments[0]).not.toHaveProperty("at")
  })

  test("both: the token in the text and the chip over the prompt", async () => {
    const b = bench({ profile: { attachmentChips: "both" } })
    await b.type("ver ")
    await b.type(paste(SHOT))
    expect(b.prompt()).toContain("ver [Image #1]")
    expect(b.h.text().some((row) => row.includes("[Image #1 · 1262×540"))).toBe(true)
    await b.type("\r")
    expect(b.submitted()!.attachments[0]).toMatchObject({ label: "[Image #1]" })
  })

  test("inline (the default): the token in the text and no chip row", async () => {
    const b = bench()
    await b.type(paste(SHOT))
    expect(b.prompt()).toContain("[Image #1]")
    expect(b.h.text().some((row) => row.includes("[Image #1 · 1262×540"))).toBe(false)
  })
})

describe("the pure parts", () => {
  const image = (label?: string): PendingAttachment => ({ kind: "image", ref: { sha256: "1".repeat(64), bytes: 9, mime: "image/png" }, name: "a.png", ...(label ? { label } : {}) })
  const folder: PendingAttachment = { kind: "text", name: "codeconfig", content: "AGENTS.md", directory: true, label: "[codeconfig/]" }

  test("tokens: images count up and do not reuse a number, others carry their name, a repeat gets #2", () => {
    expect(attachmentToken([], image())).toBe("[Image #1]")
    expect(attachmentToken([image("[Image #1]"), image("[Image #4]")], image())).toBe("[Image #5]")
    expect(attachmentToken([], { kind: "document", ref: image().kind === "image" ? (image() as never as { ref: never }).ref : (undefined as never), name: "spec.pdf" })).toBe("[PDF spec.pdf]")
    expect(attachmentToken([folder], { ...folder })).toBe("[codeconfig/ #2]")
  })

  test("a name made of brackets, line breaks or a very long run is made safe and short", () => {
    const token = attachmentToken([], { kind: "text", name: `a[b]\nc${"x".repeat(80)}.txt`, content: "" })
    expect(token.length).toBeLessThanOrEqual(80)
    expect(token).not.toMatch(/\n/)
    expect(token.slice(1, -1)).not.toMatch(/[\[\]]/)
    expect(token.endsWith(".txt]")).toBe(true)
  })

  test("live attachments: those without a token and those whose token is still there, counting repeated labels", () => {
    const pending = [image(), image("[Image #1]"), image("[Image #2]"), image("[Image #2]")]
    expect(liveAttachments(pending, "x [Image #2]")).toEqual([pending[0], pending[2]])
    expect(liveAttachments(pending, "x [Image #2] [Image #2]")).toEqual([pending[0], pending[2], pending[3]])
    expect(liveAttachments(pending, "")).toEqual([pending[0]])
  })

  test("chip row: inline shows only the ones with no token, above and both show every one", () => {
    const live = [image(), image("[Image #1]")]
    expect(chipRowAttachments(live, "inline")).toEqual([live[0]!])
    expect(chipRowAttachments(live, "above")).toEqual(live)
    expect(chipRowAttachments(live, "both")).toEqual(live)
  })

  test("composeSubmission places refs after their tokens and puts a prefix in the offset", () => {
    const out = composeSubmission("a [Image #1] b", [image("[Image #1]")], "IDE: x\n\n")
    expect(out.text).toBe("a [Image #1] b")
    expect(out.attachments[0]).toMatchObject({ label: "[Image #1]", at: "IDE: x\n\n".length + "a [Image #1]".length })
  })

  test("composeSubmission: a folder's block follows its token; spaces after it do not indent the sentence", () => {
    const out = composeSubmission("lee [codeconfig/]  y luego", [folder])
    expect(out.text).toBe("lee [codeconfig/]\n\n[attached file: codeconfig]\n```\nAGENTS.md\n```\n\ny luego")
  })

  test("composeSubmission: an attachment with no token or whose token is gone goes last, as before", () => {
    const out = composeSubmission("hola", [image(), image("[Image #9]"), { kind: "text", name: "n.txt", content: "c" }])
    expect(out.text).toBe("hola\n\n[attached file: n.txt]\n```\nc\n```")
    expect(out.attachments.map((ref) => ref.name)).toEqual(["a.png", "a.png"])
    expect(out.attachments.every((ref) => !("at" in ref))).toBe(true)
  })

  test("composeSubmission with nothing pending returns the text untouched", () => {
    expect(composeSubmission("hola", [])).toEqual({ text: "hola", attachments: [] })
  })

  test("refs round trip: a draft keeps the token, an old draft (no token) comes back as a chip", () => {
    const refs = draftRefs([image("[Image #1]"), image(), folder], "x [Image #1]")
    expect(refs).toEqual([expect.objectContaining({ label: "[Image #1]", name: "a.png" }), expect.objectContaining({ name: "a.png" })])
    expect(pendingFromRefs(refs).map((item) => item.label)).toEqual(["[Image #1]", undefined])
    expect(pendingFromRefs([{ sha256: "2".repeat(64), bytes: 3, mime: "application/pdf" }])).toEqual([{ kind: "document", ref: { sha256: "2".repeat(64), bytes: 3, mime: "application/pdf" }, name: "document.pdf" }])
  })
})
