import { describe, expect, test } from "bun:test"
import type { EventsWindow, SessionEvent, SessionId } from "@mendcode/protocol"
import type { WindowReply } from "@mendcode/client"
import { createTranscript, RELEASE_AT, RELEASE_KEEP, WINDOW_STEP } from "../src/view/transcript"
import { appHarness, conversation, ids, NOW } from "./session-ui-harness"

/** A session of `count` exchanges: three blocks each (the prompt, the answer, the turn's end line). */
function log(count: number, sessionId = ids("session")) {
  const events: SessionEvent[] = []
  const chat = conversation(sessionId, (event) => events.push(event))
  for (let n = 1; n <= count; n++) chat.exchange(`question ${n}`, `answer ${n}`)
  return { sessionId, events, chat }
}

function window(events: SessionEvent[], more: boolean, bounds: Partial<EventsWindow> = {}): WindowReply {
  return { ok: true, window: { events, firstSeq: events[0]?.seq ?? 0, lastSeq: events.at(-1)?.seq ?? 0, sessionLastSeq: events.at(-1)?.seq ?? 0, more, ...bounds } }
}

const PAGE = 200
const home = "\x1b[H"
const end = "\x1b[F"
const pageUp = "\x1b[5~"
const settle = () => Bun.sleep(2)
const labels = /\s*(?:↑ \d+ earlier · scroll up|↑ earlier · scroll up|loading earlier…|start of session|↓ (?:latest|\d+ new)(?: · End)?).*$/

/** The app over a daemon that answers every page at once; `hold` makes the next page wait until it is resolved. */
function paged(count = 450) {
  const source = log(count)
  const cursors: number[] = []
  let held: { resolve(): void } | undefined
  let hold = false
  const pageBefore = (seq: number) => {
    const older = source.events.filter((event) => event.seq < seq)
    return window(older.slice(-PAGE), older.length > PAGE)
  }
  const h = appHarness({
    sessionId: source.sessionId,
    height: 24,
    mode: "minimal",
    events: {
      loadWindow: async () => window(source.events.slice(-PAGE), true),
      loadBefore: (_id: SessionId, seq: number) => {
        cursors.push(seq)
        if (!hold) return Promise.resolve(pageBefore(seq))
        hold = false
        return new Promise<WindowReply>((resolve) => { held = { resolve: () => resolve(pageBefore(seq)) } })
      },
    },
  })
  const content = () => h.text().map((row) => row.replace(labels, "").trimEnd())
  const texts = () => h.app.transcript.blocks().map((block) => block.text)
  async function readToTop() {
    for (let press = 0; press < 400 && !h.text().join("\n").includes("start of session"); press++) {
      await h.app.onKey(home)
      await settle()
    }
  }
  return { ...h, source, cursors, content, texts, readToTop, holdNext: () => { hold = true }, release: () => held?.resolve() }
}

describe("older history let go back at the bottom", () => {
  test("read to the top and back: the far history goes, the bottom screen stays, and going up fetches it again from the cut", async () => {
    const h = paged()
    await h.app.start()
    await settle()
    const opened = h.content()
    await h.readToTop()
    const whole = h.texts()
    const top = h.content()
    expect(whole).toContain("question 1")
    expect(whole.length).toBeGreaterThanOrEqual(RELEASE_AT)
    const pages = h.cursors.length

    await h.app.onKey(end)
    expect(h.content()).toEqual(opened)
    const kept = h.app.transcript.visibleCount
    expect(kept).toBeGreaterThanOrEqual(RELEASE_KEEP)
    expect(kept).toBeLessThan(RELEASE_KEEP + WINDOW_STEP)
    expect(h.texts()).toEqual(whole.slice(-kept))
    expect(h.cursors.length).toBe(pages)

    // The first page asked again starts right above what was kept, and the top says there is more, never the start.
    const firstKept = h.app.transcript.blocks()[0]!.seq!
    for (let press = 0; press < 200 && h.cursors.length === pages; press++) {
      await h.app.onKey(pageUp)
      expect(h.text().join("\n")).not.toContain("start of session")
    }
    expect(h.cursors[pages]).toBeLessThanOrEqual(firstKept)
    expect(h.cursors[pages]).toBeGreaterThan(h.cursors[pages - 1]!)
    await settle()
    await h.readToTop()
    expect(h.texts()).toEqual(whole)
    expect(h.content()).toEqual(top)
    await h.app.onKey(end)
    expect(h.content()).toEqual(opened)
  })

  test("a reader a few rows above the bottom keeps the same screen when the history above goes", async () => {
    const source = log(450)
    const t = createTranscript({ now: () => NOW })
    source.events.forEach(t.apply)
    t.loadOlder()
    t.loadOlder()
    t.loadOlder()
    t.loadOlder()
    const before = t.viewport(80, 24, 30)
    const total = t.totalLines(80)
    const count = t.visibleCount
    const cursor = t.release({ keep: RELEASE_KEEP, width: 80, rows: 30 + 24 * 3 })
    expect(cursor).toBeDefined()
    expect(t.visibleCount).toBeLessThan(count)
    expect(t.totalLines(80)).toBeLessThan(total)
    expect(t.viewport(80, 24, 30)).toEqual(before)
    // Nothing more goes until another step of blocks has come.
    expect(t.release({ keep: RELEASE_KEEP, width: 80, rows: 54 })).toBeUndefined()
    // The page fetched again restores the same transcript as a full read.
    const full = createTranscript({ now: () => NOW })
    source.events.forEach(full.apply)
    t.prepend(source.events.filter((event) => event.seq < cursor!))
    expect(t.blocks()).toEqual(full.blocks())
  })

  test("an item that began above the cut and ends below it moves the cut above its start, so its text is not doubled", () => {
    const source = log(300)
    const turnId = ids("turn")
    const itemId = ids("item")
    source.chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    source.chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "shell" } })
    source.chat.emit({ type: "item.delta", itemId, text: "alpha " })
    const started = source.events.find((event) => event.type === "item.started" && event.itemId === itemId)!.seq
    for (let n = 1; n <= 250; n++) source.chat.exchange(`later ${n}`, `reply ${n}`)
    source.chat.emit({ type: "item.delta", itemId, text: "beta" })
    source.chat.emit({ type: "item.completed", itemId, status: "ok" })
    source.chat.emit({ type: "turn.completed", turnId })
    const t = createTranscript({ now: () => NOW })
    source.events.forEach(t.apply)
    const cursor = t.release({ keep: RELEASE_KEEP, width: 80, rows: 72 })
    expect(cursor).toBeDefined()
    expect(cursor!).toBeLessThanOrEqual(started)
    expect(t.blocks().find((block) => block.itemId === itemId)?.text).toBe("alpha beta")
    t.prepend(source.events.filter((event) => event.seq < cursor!))
    expect(t.blocks().find((block) => block.itemId === itemId)?.text).toBe("alpha beta")
    const full = createTranscript({ now: () => NOW })
    source.events.forEach(full.apply)
    expect(t.blocks()).toEqual(full.blocks())
  })

  test("the newest prompt and everything after it stay, however long its turn", () => {
    const source = log(100)
    const turnId = ids("turn")
    source.chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    const prompt = ids("item")
    source.chat.emit({ type: "item.started", turnId, itemId: prompt, kind: "user_message" })
    source.chat.emit({ type: "item.completed", itemId: prompt, status: "ok", text: "the long task" })
    for (let n = 0; n < 1_000; n++) {
      const itemId = ids("item")
      source.chat.emit({ type: "item.started", turnId, itemId, kind: "agent_message" })
      source.chat.emit({ type: "item.completed", itemId, status: "ok", text: `step ${n}` })
    }
    const t = createTranscript({ now: () => NOW })
    source.events.forEach(t.apply)
    const cursor = t.release({ keep: RELEASE_KEEP, width: 80, rows: 72 })
    expect(cursor).toBeDefined()
    expect(t.blocks()[0]?.text).toBe("the long task")
    expect(t.visibleCount).toBe(1_001)
  })

  test("undoing a turn after a release, above or below the cut, shows what a full read shows once the history is back", () => {
    const source = log(450)
    const t = createTranscript({ now: () => NOW })
    source.events.forEach(t.apply)
    const cursor = t.release({ keep: RELEASE_KEEP, width: 80, rows: 72 })!
    expect(cursor).toBeDefined()
    const turnOf = (text: string) => {
      const item = source.events.find((event) => event.type === "item.completed" && event.text === text)!
      return (source.events.find((event) => event.type === "item.started" && "itemId" in item && event.itemId === item.itemId) as { turnId: string }).turnId
    }
    source.chat.undo(turnOf("question 2"))
    source.chat.undo(turnOf("question 440"))
    source.events.slice(-2).forEach(t.apply)
    expect(t.blocks().some((block) => block.text === "question 440")).toBe(false)
    t.prepend(source.events.filter((event) => event.seq < cursor))
    const full = createTranscript({ now: () => NOW })
    source.events.forEach(full.apply)
    expect(t.blocks()).toEqual(full.blocks())
    expect(t.viewport(80, 24, 0)).toEqual(full.viewport(80, 24, 0))
  })

  test("nothing goes while a page is on its way; the next move down after it lands lets go", async () => {
    const h = paged()
    await h.app.start()
    await settle()
    await h.readToTop()
    // Read once more from the cut, and hold the page that comes after the first.
    await h.app.onKey(end)
    const kept = h.app.transcript.visibleCount
    for (let press = 0; press < 40 && h.app.transcript.visibleCount < RELEASE_AT + WINDOW_STEP; press++) {
      await h.app.onKey(home)
      await settle()
    }
    h.holdNext()
    const asked = h.cursors.length
    for (let press = 0; press < 5 && h.cursors.length === asked; press++) await h.app.onKey(home)
    expect(h.cursors.length).toBe(asked + 1)
    const loaded = h.app.transcript.visibleCount
    await h.app.onKey(end)
    expect(h.app.transcript.visibleCount).toBe(loaded)
    h.release()
    await settle()
    await h.app.onKey(end)
    expect(h.app.transcript.visibleCount).toBeLessThan(loaded)
    expect(h.app.transcript.visibleCount).toBeLessThan(kept + WINDOW_STEP)
  })

  test("a reader following live output lets go at a turn's end once enough has arrived", async () => {
    const h = paged()
    await h.app.start()
    await settle()
    await h.readToTop()
    // Back at the bottom by the turn's own news, not a key: live turns arrive while the reader follows.
    await h.app.onKey(end)
    for (let n = 0; n < 150; n++) {
      const from = h.source.events.length
      h.source.chat.exchange(`live ${n}`, `live answer ${n}`)
      for (const event of h.source.events.slice(from)) h.app.onEvent(event)
    }
    expect(h.app.transcript.visibleCount).toBeLessThan(RELEASE_AT)
    expect(h.text().join("\n")).toContain("live answer 149")
  })
})
