import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createIdFactory, MAX_FRAME_BYTES, visibleEvents, type EventsWindow, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { boot, openSession, say, stop, until, type NativeHarness } from "./native-harness"

const harnesses: NativeHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup()
})

async function session(texts: string[]) {
  const h = await boot({ steps: texts.map((text) => stop(`answer to ${text}`)) })
  harnesses.push(h)
  const sessionId = await openSession(h)
  for (const text of texts) await say(h, sessionId, text)
  return { h, sessionId }
}

const windowOf = (ack: { ok: boolean; result?: unknown }) => (ack as { ok: true; result: EventsWindow }).result
const errorOf = (ack: { ok: boolean }) => (ack as { ok: false; error: { code: string; message: string } }).error
const seqs = (events: SessionEvent[]) => events.map((event) => event.seq)

describe("session.events paging", () => {
  test("without a cursor it is the newest window; before pages back without gaps or repeats until the start of the log", async () => {
    const { h, sessionId } = await session(["one", "two", "three"])
    const all = h.store.readAfter(sessionId, 0, 10_000)
    const newest = windowOf(await h.client.send({ type: "session.events", sessionId, limit: 7 }))
    expect(seqs(newest.events)).toEqual(seqs(all.slice(-7)))
    expect(newest).toMatchObject({ firstSeq: all.at(-7)!.seq, lastSeq: all.at(-1)!.seq, sessionLastSeq: all.at(-1)!.seq, more: true })

    const pages = [newest]
    while (pages[0]!.more) pages.unshift(windowOf(await h.client.send({ type: "session.events", sessionId, before: pages[0]!.firstSeq, limit: 7 })))
    expect(seqs(pages.flatMap((page) => page.events))).toEqual(seqs(all))
    expect(pages[0]!.firstSeq).toBe(1)
    // Every page but the oldest (what is left of the log) is full.
    expect(pages.slice(1).every((page) => page.events.length === 7)).toBe(true)
    // Nothing older than the start.
    expect(windowOf(await h.client.send({ type: "session.events", sessionId, before: 1 }))).toMatchObject({ events: [], more: false })
  })

  test("after pages forward from a cursor; the last page says there is no more", async () => {
    const { h, sessionId } = await session(["one", "two"])
    const all = h.store.readAfter(sessionId, 0, 10_000)
    const first = windowOf(await h.client.send({ type: "session.events", sessionId, after: 0, limit: 5 }))
    expect(seqs(first.events)).toEqual(seqs(all.slice(0, 5)))
    expect(first.more).toBe(true)
    const collected = [...first.events]
    let cursor = first.lastSeq
    for (let page = first; page.more; ) {
      page = windowOf(await h.client.send({ type: "session.events", sessionId, after: cursor, limit: 5 }))
      collected.push(...page.events)
      cursor = page.lastSeq
    }
    expect(seqs(collected)).toEqual(seqs(all))
    // A cursor at the end: no events, and the cursor stays where it was.
    expect(windowOf(await h.client.send({ type: "session.events", sessionId, after: cursor }))).toMatchObject({ events: [], more: false, firstSeq: cursor, lastSeq: cursor })
  })

  test("the default window is 200 events; limit is capped at 1000; before and after exclude each other; unknown sessions are refused", async () => {
    const { h, sessionId } = await session(["one"])
    const sent = (extra: Record<string, unknown>) => h.client.send({ type: "session.events", sessionId, ...extra } as never)
    expect(errorOf(await sent({ limit: 1001 })).code).toBe("invalid_command")
    expect(errorOf(await sent({ limit: 0 })).code).toBe("invalid_command")
    expect(errorOf(await sent({ before: 5, after: 2 })).code).toBe("invalid_command")
    expect(errorOf(await h.client.send({ type: "session.events", sessionId: createIdFactory()("session") })).code).toBe("unknown_session")
    expect(windowOf(await sent({})).events.length).toBeLessThanOrEqual(200)
    expect(windowOf(await sent({ limit: 1000 })).more).toBe(false)
  })

  test("undone turns are left out like visibleEvents does, wherever the window cuts; the markers never appear; includeReverted shows them", async () => {
    const { h, sessionId } = await session(["one", "two", "three"])
    const undone = await h.client.send({ type: "session.undo", sessionId })
    expect(undone.ok).toBe(true)
    const all = h.store.readAfter(sessionId, 0, 10_000)
    const expected = seqs(visibleEvents(all))
    // A client that pages in small windows, cutting through the undone turn, sees exactly what the whole log shows.
    const pages: EventsWindow[] = []
    for (let page = windowOf(await h.client.send({ type: "session.events", sessionId, limit: 4 })); ; ) {
      pages.unshift(page)
      if (!page.more) break
      page = windowOf(await h.client.send({ type: "session.events", sessionId, before: page.firstSeq, limit: 4 }))
    }
    expect(seqs(pages.flatMap((page) => page.events))).toEqual(expected)
    expect(pages.flatMap((page) => page.events).some((event) => event.type === "turn.reverted")).toBe(false)
    // The raw bounds still count the hidden events, so the next page starts right after them.
    expect(pages.at(-1)!.lastSeq).toBe(all.at(-1)!.seq)

    const raw = windowOf(await h.client.send({ type: "session.events", sessionId, limit: 1000, includeReverted: true }))
    expect(seqs(raw.events)).toEqual(seqs(all))
    expect(raw.events.some((event) => event.type === "turn.reverted")).toBe(true)
  })

  test("redo brings the undone turn back into the window", async () => {
    const { h, sessionId } = await session(["one", "two"])
    const count = async () => windowOf(await h.client.send({ type: "session.events", sessionId, limit: 1000 })).events.filter((event) => event.type === "turn.started").length
    expect(await count()).toBe(2)
    await h.client.send({ type: "session.undo", sessionId })
    expect(await count()).toBe(1)
    await h.client.send({ type: "session.redo", sessionId })
    expect(await count()).toBe(2)
  })

  test("a window is cut to what one frame can carry and says there is more", async () => {
    const big = "x".repeat(58_000)
    const h = await boot({ steps: [stop(big), stop(big), stop(big), stop(big), stop(big), stop(big)] })
    harnesses.push(h)
    const sessionId = await openSession(h)
    for (let i = 0; i < 6; i++) await say(h, sessionId, `q${i}`)
    const ack = await h.client.send({ type: "session.events", sessionId, limit: 1000 })
    expect(ack.ok).toBe(true)
    const newest = windowOf(ack)
    expect(Buffer.byteLength(JSON.stringify(newest))).toBeLessThan(MAX_FRAME_BYTES)
    expect(newest.more).toBe(true)
    expect(newest.lastSeq).toBe(newest.sessionLastSeq)
    // The cut drops the oldest events of the window, so paging back continues right before what was returned.
    const older = windowOf(await h.client.send({ type: "session.events", sessionId, before: newest.firstSeq, limit: 1000 }))
    expect(older.lastSeq).toBe(newest.firstSeq - 1)
  })
})

describe("client window helpers", () => {
  test("the default tail is bounded and subscribing replays events appended between the read and subscribe", async () => {
    const h = await boot()
    harnesses.push(h)
    const sessionId = await openSession(h)
    const ids = createIdFactory()
    for (let n = 0; n < 110; n++) {
      const turnId = ids("turn")
      const itemId = ids("item")
      h.store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
      h.store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "agent_message" })
      h.store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text: `answer ${n}` })
      h.store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
    }
    const streamed: SessionEvent[] = []
    const viewer = createClient({ socketPath: path.join(h.dir, "mendd.sock"), name: "paged-viewer", onEvent: (event) => void streamed.push(event) })
    await viewer.connect()
    try {
      const latest = await viewer.loadWindow(sessionId)
      if (!latest.ok) throw new Error("window refused")
      expect(latest.window.events).toHaveLength(200)
      expect(latest.window.more).toBe(true)
      expect(latest.window.firstSeq).toBeGreaterThan(1)
      h.store.sessionSink.append({ type: "session.permission", sessionId, mode: "smart" })
      const appended = h.store.readAfter(sessionId, latest.window.lastSeq, 10)
      expect(appended).toHaveLength(1)
      expect((await viewer.subscribe(sessionId, latest.window.lastSeq)).ok).toBe(true)
      await until(() => streamed.length === appended.length)
      expect(streamed).toEqual(appended)
    } finally {
      viewer.close()
    }
  })

  test("loadWindow, loadBefore and loadAfter wrap session.events; subscribing from the window's lastSeq streams only what is new", async () => {
    const { h, sessionId } = await session(["one", "two"])
    h.steps.push(stop("answer to three"))
    const streamed: SessionEvent[] = []
    const viewer = createClient({ socketPath: path.join(h.dir, "mendd.sock"), name: "viewer", onEvent: (event) => void streamed.push(event) })
    await viewer.connect()
    try {
      const all = h.store.readAfter(sessionId, 0, 10_000)
      const latest = await viewer.loadWindow(sessionId, 6)
      if (!latest.ok) throw new Error("window refused")
      expect(seqs(latest.window.events)).toEqual(seqs(all.slice(-6)))
      const back = await viewer.loadBefore(sessionId, latest.window.firstSeq, 6)
      if (!back.ok) throw new Error("window refused")
      expect(seqs(back.window.events)).toEqual(seqs(all.slice(-12, -6)))
      const forward = await viewer.loadAfter(sessionId, back.window.lastSeq, 3)
      if (!forward.ok) throw new Error("window refused")
      expect(seqs(forward.window.events)).toEqual(seqs(all.slice(-6, -3)))

      await viewer.subscribe(sessionId, latest.window.lastSeq)
      await say(h, sessionId, "three")
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(streamed.length).toBeGreaterThan(0)
      expect(streamed[0]!.seq).toBe(latest.window.lastSeq + 1)
      expect(seqs(streamed)).toEqual(seqs(h.store.readAfter(sessionId, latest.window.lastSeq, 10_000)))

      const refused = await viewer.loadWindow(createIdFactory()("session") as SessionId)
      expect(refused).toMatchObject({ ok: false, error: { code: "unknown_session" } })
    } finally {
      viewer.close()
    }
  })
})
