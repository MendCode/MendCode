import { afterEach, describe, expect, test } from "bun:test"
import type { QuestionInfo } from "@mendcode/protocol"
import { appHarness, cleanTemps, conversation, ids, tempDir } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)

const LONG = "Codex makes the 14 slides with image_gen from prompts/slides.md and saves them in images/, then the deck is built here with those pictures."
const OPTIONS = [
  { label: "Generate in Codex (Recommended)", description: LONG },
  { label: "Run image_gen.py here", description: "Needs OPENAI_API_KEY in the environment." },
  { label: "Native shapes" },
]

/** A Claude-style pending question: the running AskUserQuestion call, then the request (a single question, or a batch). */
function asking(options: { width?: number; height?: number; questions?: QuestionInfo[]; draft?: string } = {}) {
  const h = appHarness({ width: options.width ?? 80, height: options.height ?? 40, dataDir: tempDir(), directory: "/work/project", mode: "balanced" })
  h.app.applySettings({ onboarded: true })
  const chat = conversation(h.sessionId, h.app.onEvent)
  chat.exchange("Build the deck", "Making the slides first.")
  if (options.draft) h.app.editor.insert(options.draft)
  const turnId = ids("turn"), itemId = ids("item"), requestId = ids("request")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "AskUserQuestion" } })
  if (options.questions) chat.emit({ type: "server.request", requestId, turnId, kind: "question", title: `Asked ${options.questions.length} questions`, detail: "", questions: options.questions })
  else chat.emit({ type: "server.request", requestId, turnId, kind: "question", title: "Images", detail: "Claude Code has no image_gen tool. How do we make the slides?", options: OPTIONS })
  chat.emit({ type: "foreground.state", state: "waiting_approval", turnId })
  h.app.render()
  const resolved = () => h.sentOf("request.resolve").map((command) => (command as { decision: unknown }).decision)
  return { ...h, chat, turnId, itemId, requestId, resolved }
}

const rowOf = (rows: string[], needle: string) => rows.findIndex((row) => row.includes(needle))

describe("question card", () => {
  test("long option descriptions wrap in full under their option at every width, never cut with an ellipsis", async () => {
    for (const width of [60, 80, 120, 200]) {
      const h = asking({ width })
      const rows = h.text()
      const words = rows.join(" ").replace(/[│┃]/g, " ").replace(/\s+/g, " ")
      expect(words).toContain("then the deck is built here with those pictures.")
      expect(rows.some((row) => row.includes("…"))).toBe(false)
      expect(rows.every((row) => textWidth(row) <= width)).toBe(true)
      // Continuation rows hang under the label, past the number.
      const label = rowOf(rows, "1. Generate in Codex")
      expect(rows[label + 1]!.indexOf("Codex makes")).toBe(rows[label]!.indexOf("Generate"))
      await h.app.onKey("\x1b")
    }
  })

  test("one waiting line at most: no waiting header, no working row, and the asking tool row hides until the answer", async () => {
    const h = asking()
    const shown = h.text().join("\n")
    expect(shown).not.toMatch(/waiting for answer/i)
    expect(shown).not.toContain("AskUserQuestion")
    expect(shown).toContain("Images")
    await h.app.onKey("2")
    expect(h.resolved()).toEqual([{ kind: "answer", text: "Run image_gen.py here" }])
    h.chat.emit({ type: "server.request.resolved", requestId: h.requestId, resolution: "answered" })
    h.chat.emit({ type: "item.completed", itemId: h.itemId, status: "ok", text: "Run image_gen.py here" })
    h.app.render()
    expect(h.text().join("\n")).toContain("AskUserQuestion")
    // The prompt is back once the card is gone.
    expect(h.text().some((row) => row.includes("❭"))).toBe(true)
  })

  test("choosing Type your own answer turns the row into a field: the caret is there, typing goes there, Enter sends it", async () => {
    const h = asking({ width: 80 })
    await h.app.onKey("4")
    let rows = h.text()
    const field = rowOf(rows, "4. Type your own answer")
    expect(rows[field]).toContain("› 4. ")
    expect(h.cursors.at(-1)).toEqual({ row: field, col: rows[field]!.indexOf("Type your own answer") })
    expect(rows.join("\n")).toContain("enter send · esc back")
    await h.type("Use Gemini 4 instead")
    rows = h.text()
    const typed = rowOf(rows, "› 4. Use Gemini 4 instead")
    expect(typed).toBeGreaterThan(0)
    expect(h.cursors.at(-1)).toEqual({ row: typed, col: rows[typed]!.indexOf("Use Gemini") + "Use Gemini 4 instead".length })
    // Nothing went into a prompt: there is none on screen while the card waits.
    expect(rows.some((row) => row.includes("❭"))).toBe(false)
    await h.app.onKey("\r")
    expect(h.resolved()).toEqual([{ kind: "answer", text: "Use Gemini 4 instead" }])
  })

  test("a long answer of one's own wraps inside the field and the caret follows it", async () => {
    const h = asking({ width: 60 })
    await h.app.onKey("4")
    await h.type("Generate them with the Gemini image model and keep the existing prompts file as it is")
    const rows = h.text()
    const first = rowOf(rows, "› 4. Generate them")
    expect(rows[first + 1]!.trim().length).toBeGreaterThan(0)
    expect(h.cursors.at(-1)!.row).toBeGreaterThan(first)
    expect(rows.every((row) => textWidth(row) <= 60)).toBe(true)
  })

  test("Esc in the field goes back to the list without answering; the next Esc dismisses the question", async () => {
    const h = asking()
    await h.app.onKey("\x1b[A")
    await h.app.onKey("\r")
    await h.type("draft")
    await h.app.onKey("\x1b")
    expect(h.resolved()).toEqual([])
    const rows = h.text()
    expect(rows.join("\n")).toContain("4. Type your own answer")
    expect(rows.join("\n")).not.toContain("draft")
    expect(rows.join("\n")).toContain("↑↓ select · enter confirm · esc dismiss")
    await h.app.onKey("\x1b")
    expect(h.resolved()).toEqual([{ kind: "deny" }])
  })

  test("text typed in the list starts the answer of one's own; ↑ from an empty field steps back into the list", async () => {
    const h = asking()
    await h.type("x")
    expect(h.text().join("\n")).toContain("› 4. x")
    await h.app.onKey("\x7f")
    await h.app.onKey("\x1b[A")
    expect(h.text().join("\n")).toContain("› 3. Native shapes")
    expect(h.resolved()).toEqual([])
  })

  test("a multiple choice ticks with space and sends the ticked labels in option order with Enter", async () => {
    const h = asking({ questions: [{ header: "Formats", question: "Which formats besides PPTX?", options: [{ label: "PDF" }, { label: "PNG" }, { label: "SVG" }], multiple: true }] })
    expect(h.text().join("\n")).toContain("space toggle · enter send")
    await h.app.onKey("3")
    await h.app.onKey("1")
    await h.app.onKey("\r")
    expect(h.resolved()).toEqual([{ kind: "answer", text: "PDF, SVG", answers: [["PDF", "SVG"]] }])
  })

  test("a batch shows tabs; a free-text question opens with its field ready and Tab keeps the text", async () => {
    const h = asking({ questions: [
      { header: "Images", question: "How do we make the slides?", options: OPTIONS },
      { header: "Notes", question: "Anything to keep?", options: [] },
    ] })
    expect(h.text().join("\n")).toContain("Images")
    expect(h.text().join("\n")).toContain("Confirm")
    await h.app.onKey("1")
    // The second question has no options: the field is open, and the caret is in it.
    expect(h.text().join("\n")).toContain("enter save · tab next · esc back")
    await h.type("keep the fonts")
    await h.app.onKey("\t")
    expect(h.text().join("\n")).toContain("Notes: keep the fonts")
    await h.app.onKey("\r")
    expect(h.resolved()).toEqual([{ kind: "answer", text: "Generate in Codex (Recommended)\nkeep the fonts", answers: [["Generate in Codex (Recommended)"], ["keep the fonts"]] }])
  })

  test("a prompt draft typed before the question waits while the card holds the editor, then comes back", async () => {
    const h = asking({ draft: "half a thought" })
    expect(h.text().join("\n")).not.toContain("half a thought")
    await h.app.onKey("1")
    h.chat.emit({ type: "server.request.resolved", requestId: h.requestId, resolution: "answered" })
    h.app.render()
    expect(h.app.editor.text).toBe("half a thought")
  })
})
