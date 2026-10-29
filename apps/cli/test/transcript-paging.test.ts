import { describe, expect, test } from "bun:test"
import type { EventsWindow, SessionEvent, SessionId } from "@mendcode/protocol"
import type { WindowReply } from "@mendcode/client"
import { createTranscript } from "../src/view/transcript"
import { appHarness, conversation, ids, NOW } from "./session-ui-harness"

function log(sessionId = ids("session"), count = 100) {
  const events: SessionEvent[] = []
  const chat = conversation(sessionId, (event) => events.push(event))
  for (let n = 1; n <= count; n++) chat.exchange(`question ${n}`, `answer ${n}`)
  return { sessionId, events, chat }
}

function window(events: SessionEvent[], more: boolean, bounds: Partial<EventsWindow> = {}): WindowReply {
  return { ok: true, window: { events, firstSeq: events[0]?.seq ?? 0, lastSeq: events.at(-1)?.seq ?? 0, sessionLastSeq: events.at(-1)?.seq ?? 0, more, ...bounds } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function paged() {
  const source = log()
  const before: Array<{ sessionId: SessionId; seq: number }> = []
  const opened: SessionId[] = []
  const pending: Array<ReturnType<typeof deferred<WindowReply>>> = []
  const h = appHarness({
    sessionId: source.sessionId,
    height: 24,
    mode: "minimal",
    events: {
      loadWindow: async (id) => { opened.push(id); return window(source.events.slice(-200), true) },
      loadBefore: (sessionId, seq) => {
        before.push({ sessionId, seq })
        const page = deferred<WindowReply>()
        pending.push(page)
        return page.promise
      },
    },
  })
  return { ...h, source, before, opened, pending }
}

const pageUp = "\x1b[5~"
const home = "\x1b[H"
const end = "\x1b[F"
const wheelUp = "\x1b[<64;10;5M"
const settle = () => Bun.sleep(2)
const content = (h: ReturnType<typeof paged>) => h.text().map((row) => row.replace(/\s*(?:↑ earlier · scroll up|loading earlier…|start of session|↓ (?:latest|\d+ new)(?: · End)?).*$/, "").trimEnd())

describe("event paging in the terminal app", () => {
  test("opening a long session reads one default window before subscribing from its raw lastSeq", async () => {
    const h = paged()
    expect(h.subscriptions).toEqual([])
    await h.app.start()
    expect(h.opened).toEqual([h.sessionId])
    expect(h.subscriptions).toEqual([{ sessionId: h.sessionId, afterSeq: 600 }])
    expect(h.app.transcript.visibleCount).toBeLessThan(100)
    expect(h.app.transcript.blocks().some((block) => block.text === "question 1")).toBe(false)
    expect(h.text().join("\n")).toContain("answer 100")
    const next = h.source.events.length
    h.source.chat.exchange("live question", "live answer")
    for (const event of h.source.events.slice(next)) h.app.onEvent(event)
    expect(h.text().join("\n")).toContain("live answer")
    expect(h.before).toEqual([])
  })

  test("PageUp past the oldest loaded line fetches once; wheel and Home cannot duplicate it; prepend keeps the same screen lines", async () => {
    const h = paged()
    await h.app.start()
    for (let page = 0; page < 30 && h.before.length === 0; page++) await h.app.onKey(pageUp)
    const anchored = content(h)
    expect(h.before).toEqual([{ sessionId: h.sessionId, seq: 401 }])
    expect(h.text().join("\n")).toContain("loading earlier…")
    await h.app.onKey(wheelUp)
    await h.app.onKey(home)
    expect(h.before).toHaveLength(1)
    h.pending[0]!.resolve(window(h.source.events.slice(200, 400), true))
    await settle()
    expect(content(h)).toEqual(anchored)
    expect(h.app.transcript.blocks().some((block) => block.text === "question 35")).toBe(true)
    const loadedCount = h.app.transcript.visibleCount
    await h.app.onKey(end)
    await h.app.onKey(home)
    expect(h.before.map((call) => call.seq)).toEqual([401, 201])
    expect(h.app.transcript.visibleCount).toBe(loadedCount)
    h.pending[1]!.resolve(window(h.source.events.slice(0, 200), false))
    await settle()
    await h.app.onKey(home)
    expect(h.text().join("\n")).toContain("start of session")
    expect(h.text().join("\n")).toContain("question 1")
    await h.app.onKey(pageUp)
    await h.app.onKey(wheelUp)
    expect(h.before).toHaveLength(2)
  })

  test("live growth and a reader moving down while a page waits keep the current viewport anchored", async () => {
    const h = paged()
    await h.app.start()
    await h.app.onKey(home)
    expect(h.before).toHaveLength(1)
    const next = h.source.events.length
    h.source.chat.exchange("live question", "live answer")
    for (const event of h.source.events.slice(next)) h.app.onEvent(event)
    await h.app.onKey("\x1b[6~")
    const anchored = content(h)
    h.pending[0]!.resolve(window(h.source.events.slice(200, 400), true))
    await settle()
    expect(content(h)).toEqual(anchored)
    expect(h.app.transcript.lastSeq).toBe(606)
    await h.app.onKey(end)
    expect(h.text().join("\n")).toContain("live answer")
  })

  test("a session whose newest windows draw nothing is not opened blank: reading goes back until the chat shows", async () => {
    const source = log(ids("session"), 3)
    const first = source.events[0]!.seq
    // Twenty windows of records with nothing to draw sit after the conversation.
    const silent = 20
    const cursors: number[] = []
    const h = appHarness({
      sessionId: source.sessionId, height: 24, mode: "minimal",
      events: {
        loadWindow: async () => window([], true, { firstSeq: first + source.events.length + silent * 10, lastSeq: first + source.events.length + silent * 10 + 9, sessionLastSeq: first + source.events.length + silent * 10 + 9 }),
        loadBefore: async (_id, seq) => {
          cursors.push(seq)
          const left = Math.round((seq - first - source.events.length) / 10)
          return left > 0 ? window([], true, { firstSeq: seq - 10, lastSeq: seq - 1 }) : window(source.events, false)
        },
      },
    })
    await h.app.start()
    await settle()
    h.app.render()
    expect(cursors.length).toBe(silent + 1)
    expect(h.text().join("\n")).toContain("answer 3")
  })

  test("empty hidden pages advance their raw cursor, and an exhausted empty page shows start of session", async () => {
    const h = paged()
    await h.app.start()
    await h.app.onKey(home)
    h.pending[0]!.resolve(window([], true, { firstSeq: 201, lastSeq: 400, sessionLastSeq: 600 }))
    await settle()
    await h.app.onKey(wheelUp)
    expect(h.before.map((call) => call.seq)).toEqual([401, 201])
    h.pending[1]!.resolve(window([], false, { firstSeq: 1, lastSeq: 200, sessionLastSeq: 600 }))
    await settle()
    expect(h.text().join("\n")).toContain("start of session")
    await h.app.onKey(home)
    expect(h.before).toHaveLength(2)
  })

  test("a failed earlier page preserves content and cursor and permits retry", async () => {
    const h = paged()
    await h.app.start()
    await h.app.onKey(home)
    const blocks = h.app.transcript.blocks().map((block) => block.text)
    h.pending[0]!.reject(new Error("history disconnected"))
    await settle()
    expect(h.text().join("\n")).not.toContain("loading earlier…")
    expect(h.app.transcript.blocks().map((block) => block.text)).toEqual(blocks)
    await h.app.onKey(pageUp)
    expect(h.before.map((call) => call.seq)).toEqual([401, 401])
    h.pending[1]!.resolve(window([], false, { firstSeq: 1 }))
    await settle()
  })

  test("switching resets the window, cursor and viewport and ignores an earlier reply from the previous session", async () => {
    const first = log()
    const second = log(ids("session"), 2)
    const pending = deferred<WindowReply>()
    const opened: SessionId[] = []
    const before: number[] = []
    const h = appHarness({
      sessionId: first.sessionId,
      height: 24,
      mode: "minimal",
      reply: (command) => command.type === "session.create" ? { ok: true, result: { sessionId: second.sessionId } } : undefined,
      events: {
        loadWindow: async (id) => {
          opened.push(id)
          return id === first.sessionId ? window(first.events.slice(-200), true) : window(second.events, false)
        },
        loadBefore: (_id, seq) => { before.push(seq); return pending.promise },
      },
    })
    await h.app.start()
    await h.app.onKey(home)
    await h.type("/new\r")
    expect(h.app.sessionId).toBe(second.sessionId)
    expect(opened).toEqual([first.sessionId, second.sessionId])
    expect(h.subscriptions).toEqual([{ sessionId: first.sessionId, afterSeq: 600 }, { sessionId: second.sessionId, afterSeq: 12 }])
    expect(h.sentOf("client.unsubscribe")).toEqual([{ type: "client.unsubscribe", sessionId: first.sessionId }])
    pending.resolve(window(first.events.slice(200, 400), true))
    await settle()
    expect(h.app.transcript.blocks().some((block) => block.text === "answer 100")).toBe(false)
    expect(h.app.transcript.lastSeq).toBe(12)
    await h.app.onKey(home)
    expect(h.text().join("\n")).not.toContain("start of session")
    expect(before).toEqual([401])
  })

  test("raw lastSeq includes hidden events; a failed initial read never falls back to replaying the whole log", async () => {
    const sessionId = ids("session")
    let refused = true
    const h = appHarness({ sessionId, events: {
      loadWindow: async () => refused ? { ok: false, error: { code: "unknown_session", message: "session unavailable" } } : window([], false, { firstSeq: 9, lastSeq: 208 }),
      loadBefore: async () => window([], false),
    } })
    await h.app.start()
    expect(h.subscriptions).toEqual([])
    refused = false
    await h.app.start()
    expect(h.subscriptions).toEqual([{ sessionId, afterSeq: 208 }])
  })

  test("older embedders still subscribe from zero without event hooks", async () => {
    const h = appHarness()
    await h.app.start()
    expect(h.subscriptions).toEqual([{ sessionId: h.sessionId, afterSeq: 0 }])
  })
})

describe("transcript prepend at event boundaries", () => {
  test("every cut inside turns/items reconstructs the same projection; overlapping pages and replayed live events are ignored", () => {
    const source = log(ids("session"), 3)
    const turnId = ids("turn")
    const itemId = ids("item")
    source.chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    source.chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "shell" } })
    source.chat.emit({ type: "item.delta", itemId, text: "one\n" })
    source.chat.emit({ type: "item.delta", itemId, text: "two\n" })
    source.chat.emit({ type: "item.completed", itemId, text: "", status: "ok" })
    source.chat.emit({ type: "turn.completed", turnId })
    const full = createTranscript({ now: () => NOW })
    source.events.forEach(full.apply)
    for (let cut = 1; cut < source.events.length; cut++) {
      const t = createTranscript({ now: () => NOW })
      source.events.slice(cut).forEach(t.apply)
      t.prepend(source.events.slice(0, cut))
      expect(t.blocks()).toEqual(full.blocks())
      expect(t.viewport(90, 200)).toEqual(full.viewport(90, 200))
      const lastSeq = t.lastSeq
      t.prepend(source.events)
      source.events.forEach(t.apply)
      expect(t.blocks()).toEqual(full.blocks())
      expect(t.lastSeq).toBe(lastSeq)
    }
  })
})
