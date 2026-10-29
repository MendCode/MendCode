import { afterAll, describe, expect, test } from "bun:test"
import type { CommandReply, WindowReply } from "@mendcode/client"
import type { EventsWindow, SessionEvent, SessionId, SessionSummary } from "@mendcode/protocol"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const reply = (result: unknown) => ({ ok: true, result }) as CommandReply

function log(sessionId: SessionId, count: number) {
  const events: SessionEvent[] = []
  const chat = conversation(sessionId, (event) => events.push(event))
  for (let n = 1; n <= count; n++) chat.exchange(`question ${n}`, `answer ${n}`)
  return events
}

/** The daemon's window rule: the newest `limit` events, or the `limit` just before a seq. */
function windowOf(events: SessionEvent[], before: number | undefined, limit: number): WindowReply {
  const pool = before === undefined ? events : events.filter((event) => event.seq < before)
  const slice = pool.slice(-limit)
  const window: EventsWindow = { events: slice, firstSeq: slice[0]?.seq ?? 0, lastSeq: slice.at(-1)?.seq ?? 0, sessionLastSeq: events.at(-1)?.seq ?? 0, more: pool.length > slice.length }
  return { ok: true, window }
}

function twoSessions(options: { dataDir?: string; limit?: number; hold?: Array<() => void> } = {}) {
  const first = ids("session")
  const second = ids("session")
  const logs = new Map<SessionId, SessionEvent[]>([[first, log(first, 40)], [second, log(second, 30)]])
  const sessions: SessionSummary[] = [first, second].map((sessionId, index) => ({ sessionId, title: index ? "Second" : "First", directory: "/work/app", createdAt: NOW, updatedAt: NOW - index * 60_000, lastSeq: logs.get(sessionId)!.length, state: "idle", queued: 0 }))
  const h = appHarness({
    width: 180,
    height: 50,
    mode: "balanced",
    sessionId: first,
    dataDir: options.dataDir ?? tempDir(),
    directory: "/work/app",
    reply: (command) => command.type === "session.list" ? reply({ sessions }) : undefined,
    events: {
      loadWindow: async (id) => {
        if (options.hold && id === second && options.hold.length) await new Promise<void>((resolve) => options.hold!.push(resolve))
        return windowOf(logs.get(id)!, undefined, options.limit ?? 60)
      },
      loadBefore: async (id, seq) => windowOf(logs.get(id)!, seq, options.limit ?? 60),
    },
  })
  h.app.applySettings({})
  return { ...h, first, second, logs }
}

describe("switching chats keeps the whole history", () => {
  test("switch away and back: earlier messages render and scrolling up loads older ones", async () => {
    const h = twoSessions()
    await h.app.start()
    await Bun.sleep(5)
    h.app.render()
    expect(h.text().join("\n")).toContain("answer 40")
    await h.type("\x1b[D\x1b[B\r")
    expect(h.app.sessionId).toBe(h.second)
    await Bun.sleep(5)
    h.app.render()
    expect(h.text().join("\n")).toContain("answer 30")
    await h.type("\x1b[D\x1b[A\r")
    expect(h.app.sessionId).toBe(h.first)
    await Bun.sleep(5)
    h.app.render()
    expect(h.text().join("\n")).toContain("answer 40")
    expect(h.app.transcript.blocks().filter((block) => block.kind === "user_message").length).toBeGreaterThan(5)
    for (let round = 0; round < 3; round++) {
      for (let n = 0; n < 40; n++) await h.app.onKey("\x1b[5~")
      await Bun.sleep(5)
    }
    expect(h.app.transcript.blocks().some((block) => block.text === "question 1")).toBe(true)
  })

  test("live events that reach the new session before its window lands do not displace the history", async () => {
    const hold: Array<() => void> = [() => {}]
    const h = twoSessions({ hold })
    await h.app.start()
    await Bun.sleep(5)
    void h.app.onInput("\x1b[D\x1b[B\r")
    await Bun.sleep(20)
    expect(h.app.sessionId).toBe(h.second)
    // The daemon still streams the session (a subscription that outlived a reconnect): its newest events arrive first.
    const live = h.logs.get(h.second)!.slice(-7)
    for (const event of live) h.app.onEvent(event)
    hold.slice(1).forEach((release) => release())
    await Bun.sleep(5)
    h.app.render()
    const users = h.app.transcript.blocks().filter((block) => block.kind === "user_message")
    expect(users.length).toBeGreaterThan(5)
    expect(h.text().join("\n")).toContain("answer 30")
  })

  test("a short first window is topped up until the screen is full", async () => {
    const h = twoSessions({ limit: 14 })
    await h.app.start()
    await Bun.sleep(10)
    expect(h.app.transcript.blocks().filter((block) => block.kind === "user_message").length).toBeGreaterThan(4)
  })

  test("submit-scroll clear does not carry its cut point into another chat", async () => {
    const dir = tempDir()
    writeTuiProfile(dir, { ...DEFAULT_TUI_PROFILE, submitScroll: "clear" })
    const h = twoSessions({ dataDir: dir })
    await h.app.start()
    await Bun.sleep(5)
    await h.type("one more\r")
    const turnId = ids("turn")
    h.app.onEvent({ type: "item.started", sessionId: h.first, seq: 1000, at: NOW, turnId, itemId: ids("item"), kind: "user_message" } as never)
    await h.type("\x1b[D\x1b[B\r")
    expect(h.app.sessionId).toBe(h.second)
    await Bun.sleep(5)
    h.app.render()
    expect(h.text().join("\n")).toContain("answer 28")
  })
})
