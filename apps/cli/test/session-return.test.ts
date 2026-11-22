import { afterAll, describe, expect, test } from "bun:test"
import type { EventsWindow, SessionEvent, SessionId, SessionSummary } from "@mendcode/protocol"
import type { WindowReply } from "@mendcode/client"
import { DEFAULT_TUI_PROFILE, type TuiProfile } from "../src/view/tui-profile"
import { createTranscript } from "../src/view/transcript"
import { createSessionCache, keepable, KEPT_BLOCKS_MAX, KEPT_EVENTS_MAX, KEPT_SESSIONS, KEPT_TEXT_MAX, type KeptSession } from "../src/ui/app/session-cache"
import { appHarness, cleanTemps, conversation, ids, NOW } from "./session-ui-harness"

afterAll(cleanTemps)

const directory = "/work/app"
const settle = () => Bun.sleep(2)
const pageUp = "\x1b[5~"

/** One chat's daemon log: what the window read hides (undone turns, markers) and what the catch-up read returns whole. */
function chatLog(title: string, exchanges: number) {
  const sessionId = ids("session")
  const events: SessionEvent[] = []
  const chat = conversation(sessionId, (event) => events.push(event))
  const turns: string[] = []
  for (let n = 1; n <= exchanges; n++) turns.push(chat.exchange(`${title} question ${n}`, `${title} answer ${n}`).turnId)
  return { sessionId, title, events, chat, turns }
}
type ChatLog = ReturnType<typeof chatLog>

function visible(events: SessionEvent[]) {
  const undone = new Set<string>()
  for (const event of events) {
    if (event.type === "turn.reverted") undone.add(event.turnId)
    if (event.type === "turn.restored") undone.delete(event.turnId)
  }
  return events.filter((event) => event.type !== "turn.reverted" && event.type !== "turn.restored" && !("turnId" in event && undone.has(event.turnId as string)))
}

function window(events: SessionEvent[], more: boolean, sessionLastSeq: number, bounds: Partial<EventsWindow> = {}): WindowReply {
  return { ok: true, window: { events, firstSeq: events[0]?.seq ?? 0, lastSeq: events.at(-1)?.seq ?? 0, sessionLastSeq, more, ...bounds } }
}

/** A terminal on the first of `chats`, every chat of one folder, switched with the TUI control's session select. */
function terminal(chats: ChatLog[], options: { start?: SessionId; height?: number; gap?: () => boolean; profile?: Partial<TuiProfile> } = {}) {
  const byId = new Map(chats.map((chat) => [chat.sessionId as string, chat]))
  const opened: string[] = []
  const after: Array<{ sessionId: string; seq: number; limit: number }> = []
  const deleted = new Set<string>()
  const sessions = (): SessionSummary[] => chats.filter((chat) => !deleted.has(chat.sessionId)).map((chat, at) => ({ sessionId: chat.sessionId, title: chat.title, directory, createdAt: NOW, updatedAt: NOW - at * 60_000, lastSeq: chat.events.at(-1)?.seq ?? 0, state: "idle", queued: 0 }))
  const h = appHarness({
    width: 120, height: options.height ?? 30, mode: "balanced", directory, tuiControl: true,
    sessionId: options.start ?? chats[0]!.sessionId,
    ...(options.profile ? { hostProfile: { ...DEFAULT_TUI_PROFILE, ...options.profile } } : {}),
    reply: (command) => {
      if (command.type === "session.list") return { ok: true, result: { sessions: sessions() } }
      if (command.type === "session.get") return { ok: true, result: { session: sessions().find((entry) => entry.sessionId === command.sessionId), entries: [] } }
      if (command.type === "session.delete") { deleted.add(command.sessionId); return { ok: true } }
      return undefined
    },
    events: {
      loadWindow: async (id) => {
        opened.push(id)
        const log = byId.get(id)!
        if (deleted.has(id)) return { ok: false, error: { code: "unknown_session", message: "unknown session" } }
        const shown = visible(log.events)
        return window(shown.slice(-200), shown.length > 200, log.events.at(-1)?.seq ?? 0)
      },
      loadBefore: async (id, seq) => {
        const log = byId.get(id)!
        const older = visible(log.events).filter((event) => event.seq < seq)
        return window(older.slice(-200), older.length > 200, log.events.at(-1)?.seq ?? 0)
      },
      loadAfter: async (id, seq, limit) => {
        after.push({ sessionId: id, seq, limit })
        const log = byId.get(id)!
        if (deleted.has(id)) return { ok: false, error: { code: "unknown_session", message: "unknown session" } }
        const newer = log.events.filter((event) => event.seq > seq)
        const page = newer.slice(0, limit)
        const more = options.gap?.() ?? newer.length > limit
        return window(page, more, log.events.at(-1)?.seq ?? 0, page.length ? {} : { firstSeq: seq, lastSeq: seq })
      },
    },
  })
  const control = async (sessionId: SessionId) => {
    await h.app.onGlobal({ type: "tui.control.request", directory, requestID: ids("command"), request: { path: "/tui/publish", body: { type: "tui.session.select", properties: { sessionID: sessionId } } }, gseq: 0, at: NOW })
    await settle()
    h.app.render()
  }
  /** The transcript rows on screen, without the sidebar, top bar and prompt (they show which chat is selected, not what it holds). */
  const chatRows = () => h.text().map((row) => row.slice(32).trimEnd())
  return { ...h, opened, after, deleted, switchTo: control, chatRows, windowsOf: (id: string) => opened.filter((entry) => entry === id).length }
}

describe("the kept chats", () => {
  test("hold their limit, newest last; the oldest goes first and a taken one is no longer held", () => {
    const cache = createSessionCache(3)
    const entry = {} as KeptSession
    const [a, b, c, d] = [ids("session"), ids("session"), ids("session"), ids("session")]
    for (const id of [a, b, c]) cache.keep(id, entry)
    cache.keep(a, entry)
    cache.keep(d, entry)
    expect([a, b, c, d].map((id) => cache.has(id))).toEqual([true, false, true, true])
    expect(cache.take(c)).toBe(entry)
    expect(cache.has(c)).toBe(false)
    expect(cache.size).toBe(2)
    expect(KEPT_SESSIONS).toBe(4)
  })

  test("a chat that read many events, holds many blocks or much text is not kept", () => {
    const small = createTranscript()
    const chat = conversation(ids("session"), (event) => small.apply(event))
    for (let n = 0; n < 10; n++) chat.exchange(`question ${n}`, `answer ${n}`)
    expect(keepable(small, 40)).toBe(true)
    expect(keepable(small, KEPT_EVENTS_MAX + 1)).toBe(false)
    const many = createTranscript()
    const busy = conversation(ids("session"), (event) => many.apply(event))
    for (let n = 0; n < KEPT_BLOCKS_MAX / 2 + 1; n++) busy.exchange("q", "a")
    expect(keepable(many, 0)).toBe(false)
    const long = createTranscript()
    conversation(ids("session"), (event) => long.apply(event)).exchange("q", "x".repeat(KEPT_TEXT_MAX + 1))
    expect(keepable(long, 0)).toBe(false)
  })
})

describe("going back to a recently left chat", () => {
  test("A → B → A reads A's window once, catches up after its last event and subscribes from there", async () => {
    const a = chatLog("alpha", 30)
    const b = chatLog("beta", 30)
    const h = terminal([a, b])
    await h.app.start()
    await settle()
    expect(h.windowsOf(a.sessionId)).toBe(1)
    await h.switchTo(b.sessionId)
    expect(h.app.sessionId).toBe(b.sessionId)
    expect(h.windowsOf(b.sessionId)).toBe(1)
    await h.switchTo(a.sessionId)
    expect(h.app.sessionId).toBe(a.sessionId)
    expect(h.windowsOf(a.sessionId)).toBe(1)
    expect(h.after).toEqual([{ sessionId: a.sessionId, seq: a.events.at(-1)!.seq, limit: 1000 }])
    expect(h.subscriptions.at(-1)).toEqual({ sessionId: a.sessionId, afterSeq: a.events.at(-1)!.seq })
    expect(h.text().join("\n")).toContain("alpha answer 30")
    // B was left in turn: going back to it reads no window either.
    await h.switchTo(b.sessionId)
    expect(h.windowsOf(b.sessionId)).toBe(1)
    expect(h.text().join("\n")).toContain("beta answer 30")
  })

  /** The same chat opened afresh (from B, so the chrome is the same): the rows a return must draw. */
  async function freshRows(chats: ChatLog[], from: SessionId, to: SessionId) {
    const fresh = terminal(chats, { start: from })
    await fresh.app.start()
    await settle()
    await fresh.switchTo(to)
    expect(fresh.windowsOf(to)).toBe(1)
    return fresh.chatRows()
  }

  test("what came in while away shows on return as a fresh open shows it, in order and once", async () => {
    const a = chatLog("alpha", 20)
    const b = chatLog("beta", 20)
    const h = terminal([a, b])
    await h.app.start()
    await settle()
    await h.switchTo(b.sessionId)
    // While B is on screen, A answers twice more; a late live event of A (sent before the unsubscribe landed) reaches the app too.
    const lastSeq = a.events.at(-1)!.seq
    a.chat.exchange("alpha question away", "alpha answer away")
    a.chat.exchange("alpha question later", "alpha answer later")
    for (const event of a.events.filter((event) => event.seq > lastSeq)) h.app.onEvent(event)
    await h.switchTo(a.sessionId)
    expect(h.windowsOf(a.sessionId)).toBe(1)
    const returned = h.chatRows()
    const shown = returned.join("\n")
    expect(shown.indexOf("alpha answer away")).toBeGreaterThan(-1)
    expect(shown.indexOf("alpha answer away")).toBeLessThan(shown.indexOf("alpha answer later"))
    expect(shown.split("alpha answer later").length - 1).toBe(1)
    expect(h.app.transcript.lastSeq).toBe(a.events.at(-1)!.seq)
    expect(returned).toEqual(await freshRows([a, b], b.sessionId, a.sessionId))
  })

  test("a turn started while away with an approval waiting, and a queued message, show as on a fresh open; a resolved one leaves", async () => {
    const a = chatLog("alpha", 10)
    const b = chatLog("beta", 10)
    const h = terminal([a, b])
    await h.app.start()
    await settle()
    await h.switchTo(b.sessionId)
    const turnId = ids("turn")
    const requestId = ids("request")
    a.chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    a.chat.emit({ type: "item.started", turnId, itemId: ids("item"), kind: "user_message" })
    a.chat.emit({ type: "server.request", requestId, turnId, kind: "approval", title: "Run tests", detail: "bun test focused.test.ts" })
    a.chat.emit({ type: "queue.changed", queue: [{ queueId: ids("queue"), preview: "then lint it", attachments: 0 }] })
    await h.switchTo(a.sessionId)
    expect(h.windowsOf(a.sessionId)).toBe(1)
    expect(h.app.transcript.activeTurn).toBe(turnId as never)
    const returned = h.chatRows()
    expect(returned.join("\n")).toContain("Run tests")
    expect(returned).toEqual(await freshRows([a, b], b.sessionId, a.sessionId))

    // Answered from another terminal while away: the card is gone on return, as on a fresh open.
    await h.switchTo(b.sessionId)
    a.chat.emit({ type: "server.request.resolved", requestId, turnId, decision: { kind: "approval", approved: true } })
    a.chat.emit({ type: "turn.completed", turnId })
    await h.switchTo(a.sessionId)
    expect(h.windowsOf(a.sessionId)).toBe(1)
    expect(h.app.transcript.activeTurn).toBeUndefined()
    const settled = h.chatRows()
    expect(settled.join("\n")).not.toContain("bun test focused.test.ts")
    expect(settled).toEqual(await freshRows([a, b], b.sessionId, a.sessionId))
  })

  test("an undo made while away is read as a fresh open reads it: the window again, with no marker of the change", async () => {
    const a = chatLog("alpha", 20)
    const b = chatLog("beta", 20)
    const h = terminal([a, b])
    await h.app.start()
    await settle()
    await h.switchTo(b.sessionId)
    a.chat.undo(a.turns.at(-1)!)
    await h.switchTo(a.sessionId)
    expect(h.windowsOf(a.sessionId)).toBe(2)
    const returned = h.chatRows()
    expect(returned.join("\n")).not.toContain("alpha answer 20")
    expect(returned).toEqual(await freshRows([a, b], b.sessionId, a.sessionId))
  })

  test("a reader scrolled up comes back to the same rows; a reader at the bottom follows it, new output included", async () => {
    const a = chatLog("alpha", 40)
    const b = chatLog("beta", 40)
    const h = terminal([a, b])
    await h.app.start()
    await settle()
    await h.app.onKey(pageUp)
    await h.app.onKey(pageUp)
    h.app.render()
    const read = h.chatRows()
    expect(read.join("\n")).not.toContain("alpha answer 40")
    await h.switchTo(b.sessionId)
    a.chat.exchange("alpha question away", "alpha answer away")
    await h.switchTo(a.sessionId)
    expect(h.windowsOf(a.sessionId)).toBe(1)
    const back = h.chatRows()
    // The rows read before leaving are on screen again (the new-output hint may sit below them). The ages in the gutter count
    // from the newest message, so the answer that came meanwhile moves them; the rows themselves stay.
    const body = (rows: string[]) => rows.slice(1, -8).map((row) => row.replace(/^[^│]*│/, ""))
    expect(body(back)).toEqual(body(read))
    expect(back.join("\n")).not.toContain("alpha answer away")

    // B was left at its bottom: new output while away is what it shows on return.
    b.chat.exchange("beta question away", "beta answer away")
    await h.switchTo(b.sessionId)
    expect(h.windowsOf(b.sessionId)).toBe(1)
    expect(h.text().join("\n")).toContain("beta answer away")
  })

  test("only the last four chats left are kept: the fifth one back opens from its window again", async () => {
    const chats = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].map((title) => chatLog(title, 5))
    const h = terminal(chats)
    await h.app.start()
    await settle()
    for (const chat of chats.slice(1)) await h.switchTo(chat.sessionId)
    // Left in order: alpha, beta, gamma, delta, epsilon. Alpha is the one past the four kept.
    await h.switchTo(chats[0]!.sessionId)
    expect(h.windowsOf(chats[0]!.sessionId)).toBe(2)
    expect(h.text().join("\n")).toContain("alpha answer 5")
    for (const chat of chats.slice(2, 5)) {
      await h.switchTo(chat.sessionId)
      expect(h.windowsOf(chat.sessionId)).toBe(1)
    }
  })

  test("a chat deleted while away is forgotten, and one the daemon no longer has is not drawn from memory", async () => {
    const a = chatLog("alpha", 5)
    const b = chatLog("beta", 5)
    const c = chatLog("gamma", 5)
    const h = terminal([a, b, c])
    await h.app.start()
    await settle()
    await h.switchTo(b.sessionId)
    await h.switchTo(c.sessionId)
    // Alpha is deleted from the sessions page: it is no longer kept.
    await h.type("/sessions\r")
    await settle()
    h.app.render()
    expect(h.app.page).toBe("sessions")
    for (let step = 0; step < 6 && !h.text().some((row) => row.includes("❯ · alpha")); step++) await h.type("\x1b[B")
    await h.type("\x04")
    await h.type("y")
    await settle()
    expect(h.sentOf("session.delete")).toMatchObject([{ sessionId: a.sessionId }])
    await h.type("\x1b")
    // Beta is gone from the daemon without this terminal knowing: the return reads it again instead of drawing what it kept.
    h.deleted.add(b.sessionId)
    await h.switchTo(b.sessionId)
    expect(h.after.filter((call) => call.sessionId === b.sessionId)).toHaveLength(1)
    expect(h.windowsOf(b.sessionId)).toBe(2)
    expect(h.app.transcript.blocks()).toHaveLength(0)
    expect(h.text().join("\n")).not.toContain("beta answer 5")
    // The deleted chat, were it opened again (a stale link), is not taken from memory either.
    h.deleted.delete(a.sessionId)
    await h.switchTo(a.sessionId)
    expect(h.after.filter((call) => call.sessionId === a.sessionId)).toHaveLength(0)
    expect(h.windowsOf(a.sessionId)).toBe(2)
  })

  test("a chat opened by a switch, and one kept, are drawn with the profile's look", async () => {
    const a = chatLog("alpha", 3)
    const b = chatLog("beta", 3)
    const h = terminal([a, b], { profile: { userLabel: "OPERATOR" } })
    h.app.applySettings({})
    await h.app.start()
    await settle()
    h.app.render()
    expect(h.text().join("\n")).toContain("OPERATOR alpha question 3")
    await h.switchTo(b.sessionId)
    expect(h.text().join("\n")).toContain("OPERATOR beta question 3")
    await h.switchTo(a.sessionId)
    expect(h.windowsOf(a.sessionId)).toBe(1)
    expect(h.text().join("\n")).toContain("OPERATOR alpha question 3")
  })

  test("a kept chat that shows a secret asks for its tails again on return, as a fresh open does", async () => {
    const a = chatLog("alpha", 3)
    a.chat.exchange("use ‹secret:1› for the deploy", "done")
    const b = chatLog("beta", 3)
    const h = terminal([a, b])
    await h.app.start()
    await settle()
    const asked = () => h.sentOf("secrets.list").filter((command) => (command as { sessionId: string }).sessionId === a.sessionId).length
    expect(asked()).toBe(1)
    await h.switchTo(b.sessionId)
    await h.switchTo(a.sessionId)
    expect(h.windowsOf(a.sessionId)).toBe(1)
    expect(asked()).toBe(2)
  })

  test("a gap longer than one catch-up page opens the chat from its window", async () => {
    const a = chatLog("alpha", 5)
    const b = chatLog("beta", 5)
    let gap = false
    const h = terminal([a, b], { gap: () => gap })
    await h.app.start()
    await settle()
    await h.switchTo(b.sessionId)
    a.chat.exchange("alpha question away", "alpha answer away")
    gap = true
    await h.switchTo(a.sessionId)
    expect(h.windowsOf(a.sessionId)).toBe(2)
    expect(h.text().join("\n")).toContain("alpha answer away")
  })
})
