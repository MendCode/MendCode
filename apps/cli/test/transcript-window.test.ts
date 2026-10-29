import { describe, expect, test } from "bun:test"
import { createTranscript, createViewState, WINDOW_BLOCKS, WINDOW_STEP } from "../src/view/transcript"
import { glyphs } from "../src/ui/theme"
import { appHarness, conversation, ids, NOW } from "./session-ui-harness"

const sessionId = ids("session")

function transcriptWith(build: (chat: ReturnType<typeof conversation>) => void) {
  const t = createTranscript({ glyphs: glyphs({}), now: () => NOW })
  build(conversation(sessionId, (event) => t.apply(event)))
  return t
}
const visibleText = (t: ReturnType<typeof createTranscript>, height = 200, offset = 0, width = 100) => t.viewport(width, height, offset).map((line) => line.text).filter((line) => line.trim())

describe("undone turns in the transcript", () => {
  test("a run of undone turns is one marker with the count of messages; restoring one splits the run", () => {
    let turns: string[] = []
    const t = transcriptWith((chat) => {
      turns = [chat.exchange("one", "a1"), chat.exchange("two", "a2"), chat.exchange("three", "a3")].map((x) => x.turnId)
      chat.undo(turns[1]!)
      chat.undo(turns[2]!)
    })
    let text = visibleText(t).join("\n")
    expect(text).toContain("a1")
    expect(text).not.toContain("a2")
    expect(text).not.toContain("a3")
    expect(visibleText(t).filter((line) => line.includes("undone ·"))).toHaveLength(1)
    expect(text).toContain("undone · 2 messages")
    // Redo of the last turn alone: the first undone turn stays hidden, its marker stands before the restored one.
    t.apply({ sessionId, seq: 10_000, at: NOW, type: "turn.restored", turnId: turns[2]! } as never)
    text = visibleText(t).join("\n")
    const order = ["a1", "undone · 1 message", "a3"].map((needle) => text.indexOf(needle))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(text).not.toContain("a2")
  })

  test("a turn started after an undo appears below the marker", () => {
    const t = transcriptWith((chat) => {
      const first = chat.exchange("one", "a1")
      chat.exchange("two", "a2")
      chat.undo(first.turnId)
      chat.exchange("three", "a3")
    })
    const text = visibleText(t).join("\n")
    expect(text.indexOf("undone · 1 message")).toBeLessThan(text.indexOf("a2"))
    expect(text.indexOf("a2")).toBeLessThan(text.indexOf("a3"))
    expect(text).not.toContain("a1")
  })

  test("the marker is a single thin row, not a block", () => {
    const t = transcriptWith((chat) => chat.undo(chat.exchange("one", "a1").turnId))
    const rows = t.viewport(100, 50).filter((line) => line.text.includes("undone"))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text.length).toBeLessThan(40)
  })

  test("a message only undone and restored again leaves the transcript as it was", () => {
    const plainRun = transcriptWith((chat) => {
      chat.exchange("one", "a1")
      chat.exchange("two", "a2")
    })
    const toggled = transcriptWith((chat) => {
      chat.exchange("one", "a1")
      const second = chat.exchange("two", "a2")
      chat.undo(second.turnId)
      chat.redo(second.turnId)
    })
    expect(visibleText(toggled)).toEqual(visibleText(plainRun))
  })
})

describe("the laid-out window over a long session", () => {
  const exchanges = 300
  const long = () => {
    const items: string[] = []
    const t = transcriptWith((chat) => {
      for (let n = 1; n <= exchanges; n++) items.push(chat.exchange(`question ${n}`, `answer ${n}`).itemId)
    })
    return { t, items }
  }

  test("only the newest blocks are laid out; the older ones wait", () => {
    const { t } = long()
    expect(t.visibleCount).toBe(exchanges * 3)
    expect(t.olderBlocks).toBe(exchanges * 3 - WINDOW_BLOCKS)
    const windowed = t.totalLines(100)
    const bottom = visibleText(t, 12)
    while (t.loadOlder() > 0);
    expect(t.olderBlocks).toBe(0)
    expect(t.totalLines(100)).toBeGreaterThan(windowed)
    // The bottom of the transcript is the same with the window open or shut.
    expect(visibleText(t, 12)).toEqual(bottom)
    expect(bottom.join("\n")).toContain("answer 300")
  })

  test("scrolling to the top of the window shows its first block, then loadOlder adds a step above it", () => {
    const { t } = long()
    const before = t.olderBlocks
    const total = t.totalLines(100)
    const top = t.viewport(100, 8, total - 8).map((line) => line.text).join("\n")
    expect(top).not.toContain("question 1\n")
    expect(t.loadOlder()).toBe(WINDOW_STEP)
    expect(t.olderBlocks).toBe(before - WINDOW_STEP)
    // Offsets count from the bottom, so the same offset still shows the same lines.
    expect(t.viewport(100, 8, total - 8).map((line) => line.text).join("\n")).toBe(top)
    expect(t.totalLines(100)).toBeGreaterThan(total)
  })

  test("the last slice is whatever is left, and then there is nothing older", () => {
    const { t } = long()
    let added = 0
    for (let step = t.loadOlder(); step > 0; step = t.loadOlder()) added += step
    expect(added).toBe(exchanges * 3 - WINDOW_BLOCKS)
    expect(t.loadOlder()).toBe(0)
  })

  test("a short session has no window to speak of", () => {
    const t = transcriptWith((chat) => {
      for (let n = 0; n < 10; n++) chat.exchange(`q${n}`, `a${n}`)
    })
    expect(t.olderBlocks).toBe(0)
    expect(t.loadOlder()).toBe(0)
  })

  test("offsetFor reaches a block above the window by widening it, and puts that block on the first row", () => {
    const { t, items } = long()
    expect(t.olderBlocks).toBeGreaterThan(0)
    const offset = t.offsetFor(items[4]! as never, 100, 10)!
    expect(offset).toBeGreaterThan(0)
    expect(t.olderBlocks).toBeLessThanOrEqual(4 * 3)
    const rows = t.viewport(100, 10, offset)
    expect(rows.find((line) => line.text.trim())!.text).toContain("› ")
    expect(rows.map((line) => line.text).join("\n")).toContain("question 5")
    expect(rows.map((line) => line.text).join("\n")).not.toContain("question 4\n")
  })

  test("offsetFor for an undone or unknown item is undefined", () => {
    let undone: { itemId: string } | undefined
    const t = transcriptWith((chat) => {
      chat.exchange("one", "a1")
      const second = chat.exchange("two", "a2")
      chat.undo(second.turnId)
      undone = second
    })
    expect(t.offsetFor(undone!.itemId as never, 100, 10)).toBeUndefined()
    expect(t.offsetFor("item_nope" as never, 100, 10)).toBeUndefined()
  })

  test("pinWindow keeps the window's top where it was when new blocks arrive; without it the window slides", () => {
    const pinned = long()
    const sliding = long()
    for (const [{ t }, pin] of [[pinned, true], [sliding, false]] as const) {
      const first = t.olderBlocks
      const chat = conversation(sessionId, (event) => t.apply({ ...event, seq: 100_000 + event.seq }))
      chat.exchange("late question", "late answer")
      if (pin) t.pinWindow(first)
    }
    expect(pinned.t.olderBlocks).toBe(exchanges * 3 - WINDOW_BLOCKS)
    expect(sliding.t.olderBlocks).toBe(exchanges * 3 + 3 - WINDOW_BLOCKS)
  })

  test("a session view follows the bottom, is moved by a jump, and is not sent below the bottom by an undo", () => {
    const view = createViewState()
    view.scroll("s", 10, 100)
    expect(view.get("s")).toMatchObject({ offset: 10, follow: false })
    view.onGrowth("s", -25)
    expect(view.get("s")).toMatchObject({ offset: 0, follow: true })
    view.jump("s", 40, 30)
    expect(view.get("s")).toMatchObject({ offset: 30, follow: false })
    view.jump("s", 0, 30)
    expect(view.get("s").follow).toBe(true)
  })
})

describe("scrolling up in the app over a long session", () => {
  test("reaching the top of the window shows a label, the next page up lays out older blocks, Home reaches the very first message", async () => {
    const h = appHarness({ height: 30 })
    const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
    for (let n = 1; n <= 300; n++) chat.exchange(`question ${n}`, `answer ${n}`)
    const older = () => h.app.transcript.olderBlocks
    expect(older()).toBe(900 - WINDOW_BLOCKS)
    expect(h.text().join("\n")).not.toContain("earlier")
    for (let page = 0; page < 200 && !h.text().some((row) => row.includes("earlier · scroll up")); page++) await h.app.onKey("\x1b[5~")
    expect(h.text().some((row) => row.includes(`↑ ${900 - WINDOW_BLOCKS} earlier · scroll up`))).toBe(true)
    expect(older()).toBe(900 - WINDOW_BLOCKS)
    await h.app.onKey("\x1b[5~")
    expect(older()).toBe(900 - WINDOW_BLOCKS - WINDOW_STEP)
    expect(h.text().join("\n")).not.toContain(`${900 - WINDOW_BLOCKS} earlier`)
    await h.app.onKey("\x1b[H")
    expect(older()).toBe(0)
    expect(h.text().join("\n")).toContain("question 1\n".trim())
    expect(h.text().some((row) => /question 1\s*$/.test(row))).toBe(true)
    await h.app.onKey("\x1b[F")
    expect(h.text().join("\n")).toContain("answer 300")
  })
})
