import { afterAll, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { buildCommentMessage } from "../src/view/reply-comments"
import { cleanTemps, ids, NOW } from "./session-ui-harness"
import { chipsShown, comment, daemon, ENTER, key, OPUS, prompt, scene, screen, submitted, typeText } from "./reply-comments-helpers"

afterAll(cleanTemps)

/** A sent comment is spent: it must not come back as a chip, in the prompt or in the saved draft, whatever happened around the send. */

const SIZE = { width: 120, height: 40 }
const UP = "\x1b[A"
const ALT_UP = "\x1b[1;3A"
const NO_WINDOW = { ok: true, window: { events: [], firstSeq: 0, lastSeq: 0, sessionLastSeq: 0, more: false } } as never

/** The daemon of the drafts, with a draft.get the test can hold back (a long chat that is slow to open). */
function holdable() {
  const shared = daemon()
  const held: Array<() => void> = []
  let hold = false
  const reply = (command: CommandInput): CommandReply | undefined | Promise<CommandReply> => {
    if (command.type === "draft.get" && hold) {
      const answer = shared.reply(command)!
      return new Promise<CommandReply>((resolve) => held.push(() => resolve(answer)))
    }
    return shared.reply(command)
  }
  return { shared, reply, hold: (on: boolean) => void (hold = on), release: () => held.splice(0).forEach((run) => run()), pending: () => held.length }
}

async function twoChats(extra: { reply?: (command: CommandInput) => CommandReply | undefined | Promise<CommandReply> } = {}) {
  const origin = ids("session")
  const other = ids("session")
  const sessions = [origin, other].map((sessionId, index) => ({ sessionId, title: index ? "Other" : "Origin", directory: "/work/app", createdAt: NOW, updatedAt: NOW - index * 60_000, lastSeq: 0, state: "idle", queued: 0 }))
  const base = holdable()
  const answers = (command: CommandInput) => (command.type === "session.list" ? ({ ok: true, result: { sessions } } as CommandReply) : undefined)
  const s = await scene(SIZE, {
    sessionId: origin,
    reply: (command) => extra.reply?.(command) ?? base.reply(command) ?? answers(command),
    harness: { directory: "/work/app", events: { loadWindow: async () => NO_WINDOW, loadBefore: async () => NO_WINDOW } },
  })
  const go = async (target: typeof origin) => {
    // The session list opens on the current chat: the other one is a row away, down from the first and up from the second.
    await typeText(s, "/sessions\r")
    await Bun.sleep(5)
    await key(s, target === origin ? "\x1b[A" : "\x1b[B")
    await key(s, ENTER)
    await Bun.sleep(15)
    s.h.app.render()
    expect(s.h.app.sessionId).toBe(target)
  }
  return { s, origin, other, go, ...base }
}

/** The state the comment must have left: no chips, an empty prompt, no draft on the daemon. */
function expectSpent(s: Awaited<ReturnType<typeof scene>>, drafts: Map<string, string>) {
  expect(chipsShown(screen(s.h))).toBe(false)
  expect(s.h.app.editor.text).not.toContain("<mendcode_comments")
  expect(s.h.app.editor.text).toBe("")
  for (const text of drafts.values()) expect(text).not.toContain("<mendcode_comments")
}

describe("a sent comment does not come back", () => {
  test("a debounced save that is still waiting when the message goes does not outlive the send", async () => {
    const { shared, reply } = holdable()
    const s = await scene(SIZE, { reply })
    await comment(s, OPUS, "slow")
    await typeText(s, "go on")
    // The 400 ms timer holds a save of the chips and the words: the message goes before it fires.
    await key(s, ENTER)
    expect(submitted(s)).toHaveLength(1)
    await Bun.sleep(600)
    await s.h.app.saveDrafts()
    expect(shared.drafts.has(s.h.sessionId)).toBe(false)
    expectSpent(s, shared.drafts)
  })

  test("a save that already went out with the comment is replaced by the empty one when the message goes", async () => {
    const { shared, reply } = holdable()
    const s = await scene(SIZE, { reply })
    await comment(s, OPUS, "slow")
    await typeText(s, "go on")
    await s.h.app.saveDrafts()
    expect(shared.drafts.get(s.h.sessionId)).toContain("<mendcode_comments")
    await key(s, ENTER)
    await s.h.app.saveDrafts()
    expect(shared.drafts.has(s.h.sessionId)).toBe(false)
    expectSpent(s, shared.drafts)
  })

  test("a comment with no typed words is sent and leaves no draft", async () => {
    const { shared, reply } = holdable()
    const s = await scene(SIZE, { reply })
    await comment(s, OPUS, "slow")
    await s.h.app.saveDrafts()
    await key(s, ENTER)
    await s.h.app.saveDrafts()
    expect(submitted(s)).toHaveLength(1)
    expect(shared.drafts.has(s.h.sessionId)).toBe(false)
    expectSpent(s, shared.drafts)
  })

  test("another chat and back: the chat has no chip, no text and no draft of the sent comment", async () => {
    const { s, origin, other, go, shared } = await twoChats()
    await comment(s, OPUS, "slow")
    await typeText(s, "go on")
    await s.h.app.saveDrafts()
    await key(s, ENTER)
    await go(other)
    await go(origin)
    expect(prompt(s)).toBe("")
    expect(chipsShown(screen(s.h))).toBe(false)
    await s.h.app.saveDrafts()
    for (const text of shared.drafts.values()) expect(text).not.toContain("<mendcode_comments")
  })

  test("leaving a chat again before its draft came back does not bring the sent comment back, nor keep it in the draft", async () => {
    const { s, origin, other, go, shared, hold, release, pending } = await twoChats()
    await comment(s, OPUS, "slow")
    await typeText(s, "go on")
    await s.h.app.saveDrafts()
    await key(s, ENTER)
    await s.h.app.saveDrafts()
    hold(true)
    await go(other)
    await go(origin)
    expect(pending()).toBeGreaterThan(0)
    // Left while the draft is still being read, then the answers arrive late.
    await go(other)
    hold(false)
    release()
    await Bun.sleep(15)
    await go(origin)
    await s.h.app.saveDrafts()
    expectSpent(s, shared.drafts)
  })

  test("a chat whose draft was never read (left while opening) does not keep an old draft over a later send", async () => {
    const { s, origin, other, go, shared, hold, release } = await twoChats()
    await comment(s, OPUS, "first")
    await s.h.app.saveDrafts()
    hold(true)
    await go(other)
    // Opened and left again before the draft came back: the chat counts as still opening.
    await go(origin)
    await go(other)
    hold(false)
    release()
    await Bun.sleep(15)
    await go(origin)
    await s.h.app.saveDrafts()
    // The draft that was saved is back as a chip: this one is sent, and it is gone for good.
    await key(s, ENTER)
    await s.h.app.saveDrafts()
    expect(submitted(s)).toHaveLength(1)
    expect(shared.drafts.has(origin)).toBe(false)
    await go(other)
    await go(origin)
    expectSpent(s, shared.drafts)
  })

  test("a queued message pulled back brings its comment as a chip once, and sending it again leaves nothing", async () => {
    const { shared, reply } = holdable()
    const s = await scene(SIZE, { reply })
    const message = buildCommentMessage({ comments: [{ id: 1, quote: OPUS, text: "slow" }], general: "go on", lastItemId: undefined })
    const queueId = ids("queue")
    s.talk.emit({ type: "turn.started", turnId: ids("turn"), queueId: ids("queue") })
    s.talk.emit({ type: "queue.added", queueId, text: message, attachments: [] })
    s.talk.emit({ type: "queue.changed", queue: [{ queueId, preview: message.replace(/\s+/g, " ").slice(0, 200), attachments: 0 }] })
    await key(s, ALT_UP)
    s.talk.emit({ type: "queue.changed", queue: [] })
    expect(chipsShown(screen(s.h))).toBe(true)
    expect(prompt(s)).toBe("go on")
    await key(s, ENTER)
    await s.h.app.saveDrafts()
    expect(shared.drafts.has(s.h.sessionId)).toBe(false)
    expectSpent(s, shared.drafts)
  })

  test("↑ on the history entry of a sent comment shows readable text, not chips, and its draft carries no envelope", async () => {
    const { shared, reply } = holdable()
    const message = buildCommentMessage({ comments: [{ id: 1, quote: OPUS, text: "slow" }], general: "go on", lastItemId: undefined })
    const s = await scene(SIZE, {
      reply: (command) => (command.type === "prompt.history" ? { ok: true, result: { entries: [{ id: 1, kind: "sent", text: message }], prompts: [message] } } : reply(command)),
    })
    await key(s, UP)
    expect(chipsShown(screen(s.h))).toBe(false)
    await s.h.app.saveDrafts()
    // The raw envelope is the entry as the daemon holds it; it must never turn into a draft envelope that restores chips.
    for (const text of shared.drafts.values()) expect(text).not.toContain('draft="1"')
    await s.h.app.saveDrafts()
    expect(chipsShown(screen(s.h))).toBe(false)
  })
})
