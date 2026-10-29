import { describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { bench, paste } from "./inline-attachments-helpers"

/** Tokens survive what keeps a prompt: a draft, the stash, an undo that gives the message back, a fork. Old data without tokens still loads. */

const SHOT = "/shots/one.png"
const sha = (seed: string) => seed.repeat(64).slice(0, 64)
const chord = async (b: ReturnType<typeof bench>, key: string) => {
  await b.type("\x18")
  await b.type(key)
}

const rewound = () => ({ turnIds: [], files: { restored: [], removed: [], skipped: [] }, history: { messages: 2, tracked: true }, notes: [] as string[], shellUntracked: false, worktreeTracked: false, canRedo: true })

/** A daemon that keeps the one draft it is given and answers draft.get with it. */
function draftStore() {
  const saved: { text: string; attachments: Array<Record<string, unknown>> } = { text: "", attachments: [] }
  const reply = (command: CommandInput): CommandReply | undefined => {
    const c = command as CommandInput & { text?: string; attachments?: Array<Record<string, unknown>> }
    if (c.type === "draft.set") {
      saved.text = c.text ?? ""
      saved.attachments = c.attachments ?? []
      return { ok: true } as CommandReply
    }
    if (c.type === "draft.get") return { ok: true, result: saved.text ? { draft: { text: saved.text, attachments: saved.attachments, updatedAt: 1 } } : {} } as CommandReply
    return undefined
  }
  return { saved, reply }
}

describe("drafts", () => {
  test("the draft keeps the text with its token and the attachment's token and name", async () => {
    const store = draftStore()
    const b = bench({ reply: store.reply })
    await b.type("mira ")
    await b.type(paste(SHOT))
    await b.h.app.saveDrafts()
    expect(store.saved.text).toBe("mira [Image #1] ")
    expect(store.saved.attachments).toEqual([expect.objectContaining({ sha256: sha("1"), name: "one.png", label: "[Image #1]" })])
  })

  test("a token deleted from the prompt is gone from the draft", async () => {
    const store = draftStore()
    const b = bench({ reply: store.reply })
    await b.type("mira ")
    await b.type(paste(SHOT))
    await b.type("\x7f")
    await b.type("\x7f")
    await b.h.app.saveDrafts()
    expect(store.saved.attachments).toEqual([])
  })

  test("a new terminal gets the draft back with the token in place, and sends it where it stood", async () => {
    const store = draftStore()
    const first = bench({ reply: store.reply })
    await first.type("mira ")
    await first.type(paste(SHOT))
    await first.type("ya")
    await first.h.app.saveDrafts()

    const second = bench({ reply: store.reply })
    await second.start()
    expect(second.text).toBe("mira [Image #1] ya")
    await second.type("\r")
    expect(second.submitted()).toMatchObject({ text: "mira [Image #1] ya", attachments: [{ name: "one.png", label: "[Image #1]", at: "mira [Image #1]".length }] })
  })

  test("a draft from before tokens (an image with no label) comes back as a chip and is sent after the text", async () => {
    const store = draftStore()
    store.saved.text = "texto viejo"
    store.saved.attachments = [{ sha256: sha("7"), bytes: 30, mime: "image/png", name: "old.png" }]
    const b = bench({ reply: store.reply, profile: { attachmentChips: "inline" } })
    await b.start()
    expect(b.text).toBe("texto viejo")
    expect(b.h.text().some((row) => row.includes("[Image #1 · 30 B]"))).toBe(true)
    await b.type("\r")
    const sent = b.submitted()!
    expect(sent.text).toBe("texto viejo")
    expect(sent.attachments).toEqual([{ sha256: sha("7"), bytes: 30, mime: "image/png", name: "old.png" }])
  })

  test("a new token after a restored one does not reuse its number", async () => {
    const store = draftStore()
    store.saved.text = "uno [Image #1]"
    store.saved.attachments = [{ sha256: sha("7"), bytes: 30, mime: "image/png", name: "old.png", label: "[Image #1]", at: 14 }]
    const b = bench({ reply: store.reply })
    await b.start()
    await b.type(paste(SHOT))
    expect(b.text).toBe("uno [Image #1] [Image #2] ")
  })
})

describe("stash", () => {
  test("a stashed prompt comes back with its tokens and the attachments they stand for", async () => {
    const b = bench()
    await b.start()
    await b.type("mira ")
    await b.type(paste(SHOT))
    await chord(b, "p")
    expect(b.text).toBe("")
    expect(b.h.text().some((row) => row.includes("[Image #1"))).toBe(false)
    await chord(b, "o")
    expect(b.text).toBe("mira [Image #1] ")
    await b.type("\r")
    expect(b.submitted()).toMatchObject({ text: "mira [Image #1]", attachments: [{ label: "[Image #1]", at: "mira [Image #1]".length }] })
  })
})

describe("undo of a sent message", () => {
  test("the prompt the daemon gives back keeps its tokens, and the attachments are sent again in place", async () => {
    const report = rewound()
    const b = bench({
      reply: (command) => (command.type === "session.undo"
        ? ({ ok: true, result: { ...report, prompt: { text: "mira [Image #1] ya", attachments: [{ sha256: sha("5"), bytes: 77, mime: "image/png", name: "back.png", label: "[Image #1]", at: 15 }] } } } as CommandReply)
        : undefined),
    })
    await b.type("/undo\r")
    expect(b.text).toBe("mira [Image #1] ya")
    await b.type("\r")
    expect(b.submitted()).toMatchObject({ text: "mira [Image #1] ya", attachments: [{ sha256: sha("5"), label: "[Image #1]", at: 15 }] })
  })

  test("a prompt from a message sent before tokens existed (refs with no label) is sent after the text", async () => {
    const b = bench({
      reply: (command) => (command.type === "session.undo"
        ? ({ ok: true, result: { ...rewound(), prompt: { text: "viejo", attachments: [{ sha256: sha("5"), bytes: 77, mime: "image/png", name: "back.png" }] } } } as CommandReply)
        : undefined),
    })
    await b.type("/undo\r")
    await b.type("\r")
    expect(b.submitted()).toMatchObject({ text: "viejo", attachments: [{ sha256: sha("5"), name: "back.png" }] })
    expect(b.submitted()!.attachments[0]).not.toHaveProperty("label")
  })
})
