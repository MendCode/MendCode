import { describe, expect, test } from "bun:test"
import { createIdFactory, type BlobRef } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { createDraftSync } from "../src/ui/drafts"
import { glyphs, type Line } from "../src/ui/theme"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"
import { afterEach } from "bun:test"

afterEach(cleanTemps)

const ids = createIdFactory()
const image: BlobRef = { sha256: "a".repeat(64), bytes: 10, mime: "image/png" }

/** A draft sync whose timer only fires when the test says so. */
function sync(reply: Record<string, unknown> = {}) {
  const sent: Array<Record<string, unknown>> = []
  let pending: (() => void) | undefined
  const drafts = createDraftSync({
    send: async (command) => {
      sent.push(command as Record<string, unknown>)
      return { ok: true, result: reply }
    },
    setTimer: (run) => (pending = run),
    clearTimer: () => (pending = undefined),
  })
  const fire = () => {
    const run = pending
    pending = undefined
    run?.()
  }
  return { drafts, sent, fire, waiting: () => pending !== undefined }
}

describe("draft sync", () => {
  test("typing saves once after a pause, with the latest text", () => {
    const { drafts, sent, fire } = sync()
    const sessionId = ids("session")
    drafts.changed(sessionId, { text: "h", images: [] })
    drafts.changed(sessionId, { text: "hello", images: [] })
    expect(sent).toEqual([])
    fire()
    expect(sent).toEqual([{ type: "draft.set", sessionId, text: "hello" }])
  })

  test("an unchanged prompt sends nothing, and typing back to the saved text cancels the save", () => {
    const { drafts, sent, fire, waiting } = sync()
    const sessionId = ids("session")
    drafts.changed(sessionId, { text: "", images: [] })
    expect(waiting()).toBe(false)
    drafts.changed(sessionId, { text: "abc", images: [] })
    fire()
    drafts.changed(sessionId, { text: "abcd", images: [] })
    drafts.changed(sessionId, { text: "abc", images: [] })
    expect(waiting()).toBe(false)
    expect(sent).toHaveLength(1)
  })

  test("emptying the prompt (a submit) clears the draft at once", () => {
    const { drafts, sent, fire } = sync()
    const sessionId = ids("session")
    drafts.changed(sessionId, { text: "send me", images: [] })
    fire()
    drafts.changed(sessionId, { text: "", images: [] })
    expect(sent.at(-1)).toEqual({ type: "draft.set", sessionId, text: "" })
  })

  test("changing session saves the pending draft of the one left", () => {
    const { drafts, sent } = sync()
    const first = ids("session")
    const second = ids("session")
    drafts.changed(first, { text: "for the first", images: [] })
    drafts.changed(second, { text: "x", images: [] })
    expect(sent).toEqual([{ type: "draft.set", sessionId: first, text: "for the first" }])
  })

  test("attached images are part of the draft", () => {
    const { drafts, sent, fire } = sync()
    const sessionId = ids("session")
    drafts.changed(sessionId, { text: "", images: [image] })
    fire()
    expect(sent).toEqual([{ type: "draft.set", sessionId, text: "", attachments: [image] }])
  })

  test("text over the limit is saved truncated and reported", () => {
    const { drafts, sent, fire } = sync()
    const sessionId = ids("session")
    expect(drafts.changed(sessionId, { text: "x".repeat(70_000), images: [] })).toBe(true)
    fire()
    expect((sent[0]!.text as string).length).toBe(65_536)
  })

  test("a restored draft counts as saved, so opening it writes nothing back", async () => {
    const { drafts, sent, waiting } = sync({ draft: { text: "left over", attachments: [image], updatedAt: 1 } })
    const sessionId = ids("session")
    expect(await drafts.restore(sessionId)).toEqual({ text: "left over", images: [image] })
    drafts.changed(sessionId, { text: "left over", images: [image] })
    expect(waiting()).toBe(false)
    expect(sent).toEqual([{ type: "draft.get", sessionId }])
  })
})

describe("drafts in the app", () => {
  test("PDF draft restores a named document chip and submits its original MIME", async () => {
    const ref = { sha256: "b".repeat(64), bytes: 2048, mime: "application/pdf", name: "design.pdf" }
    const h = appHarness({ dataDir: tempDir(), reply: (c) => c.type === "draft.get" ? { ok: true, result: { draft: { text: "review", attachments: [ref] } } } : undefined })
    h.app.applySettings({ onboarded: true })
    await Bun.sleep(10)
    h.app.render()
    expect(h.text().some((row) => row.includes("■ design.pdf · 2 KB"))).toBe(true)
    await h.app.onKey("\r")
    expect(h.sentOf("user.submit")[0]).toMatchObject({ text: "review", attachments: [ref] })
  })
  test("an empty prompt comes back with the session's saved draft", async () => {
    const sessionId = ids("session")
    const frames: Line[][] = []
    const screen = { size: { width: 100, height: 30 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
    const app = createApp({
      sessionId,
      screen,
      send: async (command: Record<string, unknown>) => {
        if (command.type === "draft.get") return { ok: true, result: { draft: { text: "unsent idea", attachments: [], updatedAt: 1 } } }
        if (command.type === "settings.get") return { ok: true, result: { settings: {} } }
        return { ok: true }
      },
      exit() {},
      schedule: (fn: () => void) => fn(),
      glyphs: glyphs({}),
      now: () => 1_800_000_000_000,
    } as never)
    // Startup applies the saved settings (main.ts), which starts the first loads, the draft among them.
    app.applySettings({} as never)
    await Bun.sleep(10)
    app.render()
    const text = () => frames.at(-1)!.map((row) => row.map((s) => s.text).join(""))
    expect(text().some((row) => row.includes("unsent idea"))).toBe(true)
  })
})
