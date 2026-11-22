import { afterEach, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { appHarness, cleanTemps, conversation, ids, tempDir } from "./session-ui-harness"
import { FILES, paste } from "./inline-attachments-helpers"
import { createCompositionMemory } from "../src/view/composition-memory"

afterEach(cleanTemps)

const ALT_UP = "\x1b[1;3A"
const UP = "\x1b[A"
const ESC = "\x1b"
const PASTED = "pasted log line with some detail\n".repeat(150)
const SHOT = "/shots/one.png"

/** The app on a fake daemon that keeps what was sent as the project's prompt history and answers the image path. */
function app() {
  const history: Array<{ text: string; kind: "sent" }> = []
  const control = { refuse: false }
  const h = appHarness({ dataDir: tempDir(), directory: "/repo", reply: (command: CommandInput): CommandReply | undefined => {
    if (command.type === "attachment.paste") {
      const found = FILES[String(command.path)]
      return found ? { ok: true, result: found } as CommandReply : undefined
    }
    if (command.type === "user.submit") {
      if (control.refuse) return { ok: false, error: { code: "unavailable", message: "daemon busy" } } as CommandReply
      history.unshift({ text: command.text, kind: "sent" })
      return { ok: true, result: {} } as CommandReply
    }
    if (command.type === "prompt.history") return { ok: true, result: { entries: history.map((entry) => ({ ...entry })) } } as CommandReply
    if (command.type === "queue.remove" || command.type === "prompt.record") return { ok: true, result: {} } as CommandReply
    if (command.type === "session.undo") return { ok: true, result: { turnIds: [], files: { restored: [], removed: [], skipped: [] }, history: { messages: 1, tracked: true }, shellUntracked: false, notes: [] } } as CommandReply
    return undefined
  } })
  h.app.applySettings({ onboarded: true })
  return Object.assign(h, { control })
}
type Bench = ReturnType<typeof app>

/** A message as the user composes it: words, a large paste, an image, more words. */
async function compose(h: Bench) {
  await h.type("look at ")
  await h.type(paste(PASTED))
  await h.type(" and ")
  await h.type(paste(SHOT))
  await h.type("please")
}
const submitted = (h: Bench) => h.sentOf("user.submit") as Array<{ text: string; attachments: unknown[] }>
const CHIPS = /^look at \[Pasted Content \d+ chars\] and \[Image #1\] please$/
const SENT = `look at ${PASTED} and [Image #1] please`

describe("a message brought back into the prompt shows as it was composed", () => {
  test("Up on the prompt history: the paste and the image are chips, and sending again sends the same content", async () => {
    const h = app()
    await compose(h)
    expect(h.app.editor.text).toMatch(CHIPS)
    await h.type("\r")
    const first = submitted(h)[0]!
    expect(first.text).toBe(SENT)
    expect(h.app.editor.text).toBe("")
    await h.type(UP)
    expect(h.app.editor.text).toMatch(CHIPS)
    expect(h.text().join("\n")).not.toContain("pasted log line")
    await h.type("\r")
    expect(submitted(h)[1]).toEqual(first)
  })

  test("Alt+Up on a queued message: the paste and the image are chips, and sending again sends the same content", async () => {
    const h = app()
    const chat = conversation(h.sessionId, h.app.onEvent)
    chat.exchange("hello", "hi")
    const turnId = ids("turn")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    chat.emit({ type: "foreground.state", state: "generating", turnId })
    await compose(h)
    await h.type("\r")
    const first = submitted(h)[0]!
    // The daemon queues it behind the running turn, with the text and refs it was sent with.
    const queueId = ids("queue")
    chat.emit({ type: "queue.added", queueId, text: first.text, attachments: first.attachments } as never)
    chat.emit({ type: "queue.changed", queue: [{ queueId, preview: first.text.slice(0, 200), attachments: 1 }] })
    await h.type(ALT_UP)
    expect(h.sentOf("queue.remove").at(-1)).toMatchObject({ queueId })
    chat.emit({ type: "queue.changed", queue: [] })
    expect(h.app.editor.text).toMatch(CHIPS)
    expect(h.text().join("\n")).not.toContain("pasted log line")
    await h.type("\r")
    expect(submitted(h)[1]).toEqual(first)
  })

  test("a message that could not be sent comes back with its chips, and goes out again identical", async () => {
    const h = app()
    await compose(h)
    const composed = h.app.editor.text
    h.control.refuse = true
    await h.type("\r")
    expect(h.app.editor.text).toBe(composed)
    expect(h.text().join("\n")).not.toContain("pasted log line")
    h.control.refuse = false
    await h.type("\r")
    const sent = submitted(h)
    expect(sent[1]).toEqual(sent[0]!)
    expect(sent[1]!.text).toBe(SENT)
  })

  test("Esc Esc on a message nothing has answered: the paste and the image are chips in the prompt, and sending again sends the same content", async () => {
    const h = app()
    const chat = conversation(h.sessionId, h.app.onEvent)
    await compose(h)
    await h.type("\r")
    const first = submitted(h)[0]!
    // The daemon starts the turn on that message: queued, then taken.
    const queueId = ids("queue")
    const turnId = ids("turn")
    chat.emit({ type: "queue.added", queueId, text: first.text, attachments: first.attachments } as never)
    chat.emit({ type: "queue.changed", queue: [{ queueId, preview: first.text.slice(0, 200), attachments: 1 }] })
    chat.emit({ type: "queue.changed", queue: [] })
    chat.emit({ type: "turn.started", turnId, queueId })
    const itemId = ids("item")
    chat.emit({ type: "item.started", turnId, itemId, kind: "user_message" })
    chat.emit({ type: "item.completed", itemId, status: "ok", text: first.text })
    chat.emit({ type: "foreground.state", state: "generating", turnId })
    h.app.render()
    await h.type(ESC)
    await h.type(ESC)
    await Bun.sleep(20)
    expect(h.sentOf("session.undo")).toHaveLength(1)
    expect(h.app.editor.text).toMatch(CHIPS)
    chat.emit({ type: "turn.reverted", turnId })
    chat.emit({ type: "foreground.state", state: "idle" })
    await h.type("\r")
    expect(submitted(h)[1]).toEqual(first)
  })
})

describe("the composition memory is bounded", () => {
  test("it keeps a handful of pastes and drops the oldest, and a text it did not compose stays plain", () => {
    const memory = createCompositionMemory()
    const texts = Array.from({ length: 10 }, (_, index) => `paste number ${index} `.repeat(40))
    for (const text of texts) memory.remember({ texts: [], pastes: [{ label: "[x]", text }], attachments: [] })
    expect(memory.rechip(`a ${texts[0]} b`, []).pastes).toHaveLength(0)
    const recent = memory.rechip(`a ${texts[9]} b ${texts[9]}`, [])
    expect(recent.pastes).toHaveLength(2)
    expect(new Set(recent.pastes.map((paste) => paste.label)).size).toBe(2)
    expect(memory.rechip("plain words", []).text).toBe("plain words")
  })
})
