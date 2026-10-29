import { expect, test } from "bun:test"
import { createTranscript, ROWS_CACHE_BLOCKS } from "../src/view/transcript"
import { glyphs } from "../src/ui/theme"
import { conversation, ids, NOW } from "./session-ui-harness"
import type { SessionEvent } from "@mendcode/protocol"

const sessionId = ids("session")
const EXCHANGES = Math.ceil(ROWS_CACHE_BLOCKS / 2) + 150
const WIDTH = 90
const HEIGHT = 30

function longTranscript() {
  const t = createTranscript({ glyphs: glyphs({}), now: () => NOW })
  const chat = conversation(sessionId, (event) => t.apply(event))
  for (let i = 0; i < EXCHANGES; i++) chat.exchange(`question ${i}`, `answer ${i}\n\n- point a of ${i}\n- point b of ${i}\n\n${"a sentence long enough to wrap at a narrow width ".repeat(3)}`)
  while (t.loadOlder()) continue
  return { t, chat }
}

/** Every row of the laid-out history, page by page from the bottom up. */
function pagesUp(t: ReturnType<typeof createTranscript>) {
  const total = t.totalLines(WIDTH)
  const pages: string[][] = []
  for (let offset = 0; offset < total; offset += HEIGHT) pages.push(t.viewport(WIDTH, HEIGHT, offset).map((line) => line.text))
  return pages
}

test("a history longer than the rows cache reads the same on every pass, and its row counts do not move", () => {
  const { t } = longTranscript()
  expect(t.visibleCount).toBeGreaterThan(ROWS_CACHE_BLOCKS)
  const total = t.totalLines(WIDTH)
  const first = pagesUp(t)
  // The first pass laid out every block and evicted the oldest rows; the second finds some blocks without rows.
  const second = pagesUp(t)
  expect(second).toEqual(first)
  expect(t.totalLines(WIDTH)).toBe(total)
  const text = first.flat().join("\n")
  expect(text).toContain("question 0")
  expect(text).toContain(`answer ${EXCHANGES - 1}`)
  expect(text).toContain("point b of 0")
})

test("a block whose rows were given back is laid out again when it comes into view, and a new message keeps the counts right", () => {
  const { t, chat } = longTranscript()
  pagesUp(t)
  const top = t.viewport(WIDTH, HEIGHT, t.totalLines(WIDTH) - HEIGHT).map((line) => line.text).join("\n")
  expect(top).toContain("question 0")
  const before = t.totalLines(WIDTH)
  chat.exchange("one more question", "one more answer")
  const after = t.totalLines(WIDTH)
  expect(after).toBeGreaterThan(before)
  // The counts came from numbers kept after the eviction; the rows laid out from scratch have to agree with them.
  expect(pagesUp(t).flat().length).toBeGreaterThanOrEqual(after)
  expect(t.viewport(WIDTH, HEIGHT, 0).map((line) => line.text).join("\n")).toContain("one more answer")
})

test("the width changing invalidates counts kept without rows", () => {
  const { t } = longTranscript()
  pagesUp(t)
  const atWidth = t.totalLines(WIDTH)
  const narrow = t.totalLines(40)
  const wide = t.totalLines(140)
  expect(narrow).toBeGreaterThan(wide)
  expect(t.totalLines(WIDTH)).toBe(atWidth)
})

/** Turns that think before answering: the reasoning is longer than either cap, so its rows depend on the viewport's height. */
function thinkingTranscript(turns: number) {
  const t = createTranscript({ glyphs: glyphs({}), now: () => NOW })
  const log: SessionEvent[] = []
  const chat = conversation(sessionId, (event) => {
    log.push(event)
    t.apply(event)
  })
  for (let i = 0; i < turns; i++) {
    const turnId = ids("turn")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    for (const [kind, text] of [["user_message", `question ${i}`], ["reasoning", Array.from({ length: 30 }, (_, line) => `thought ${line} of ${i}`).join("\n")], ["agent_message", `answer ${i}`]] as const) {
      const itemId = ids("item")
      chat.emit({ type: "item.started", turnId, itemId, kind })
      chat.emit({ type: "item.completed", itemId, status: "ok", text })
    }
    chat.emit({ type: "turn.completed", turnId })
  }
  while (t.loadOlder()) continue
  return { t, chat, log }
}

test("two heights asked for in one frame (the sticky prompt's row) lay out the same rows as a transcript that only saw one", () => {
  const { t, chat, log } = thinkingTranscript(80)
  const turnId = ids("turn")
  const itemId = ids("item")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "item.started", turnId, itemId, kind: "agent_message" })
  for (let delta = 0; delta < 30; delta++) {
    chat.emit({ type: "item.delta", itemId, text: `word${delta} ` })
    for (const [height, offset] of [[HEIGHT, 0], [HEIGHT - 1, 0], [HEIGHT, 7 * delta], [HEIGHT - 1, 7 * delta]] as const) {
      const fresh = thinkingTranscript(0).t
      // The fresh transcript replays the same log and is asked for one height only.
      for (const event of log) fresh.apply(event)
      while (fresh.loadOlder()) continue
      expect(t.viewport(WIDTH, height, offset).map((line) => line.text)).toEqual(fresh.viewport(WIDTH, height, offset).map((line) => line.text))
      expect(t.totalLines(WIDTH)).toBe(fresh.totalLines(WIDTH))
    }
  }
})
