import { describe, expect, test } from "bun:test"
import { createIdFactory } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"

const ids = createIdFactory()
const plain = (line: Line) => line.map((span) => span.text).join("")

function harness() {
  const frames: Line[][] = []
  const screen = { size: { width: 90, height: 24 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const sessionId = ids("session")
  const app = createApp({ sessionId, screen, directory: "/work/app", exit() {}, schedule: () => undefined, glyphs: glyphs({}), now: () => 1_800_000_000_000, random: () => 0, mode: "balanced", send: (async () => ({ ok: true })) as never })
  let seq = 0
  const emit = (event: Record<string, unknown>) => app.onEvent({ sessionId, seq: ++seq, at: 1_800_000_000_000, ...event } as never)
  let layouts = 0
  const original = app.transcript.totalLines.bind(app.transcript)
  app.transcript.totalLines = (width: number) => { layouts++; return original(width) }
  const text = () => frames.at(-1)!.map(plain).join("\n")
  return { app, emit, layouts: () => layouts, text }
}

describe("a streamed reply", () => {
  test("costs a follower no layout per delta, and the frame still shows the whole reply", () => {
    const { app, emit, layouts, text } = harness()
    emit({ type: "turn.started", turnId: "turn_f", queueId: "queue_f" })
    emit({ type: "item.started", turnId: "turn_f", itemId: "item_f", kind: "agent_message" })
    const before = layouts()
    for (let i = 0; i < 40; i++) emit({ type: "item.delta", itemId: "item_f", text: `word${i} ` })
    expect(layouts()).toBe(before)
    app.render()
    expect(text()).toContain("word0 word1")
    expect(text()).toContain("word39")
  })

  test("a reader scrolled up still has every delta measured, so the view stays where it was", async () => {
    const { app, emit, layouts } = harness()
    emit({ type: "turn.started", turnId: "turn_s", queueId: "queue_s" })
    for (let n = 0; n < 12; n++) {
      emit({ type: "item.started", turnId: "turn_s", itemId: `item_old${n}`, kind: "agent_message" })
      emit({ type: "item.completed", itemId: `item_old${n}`, status: "ok", text: Array.from({ length: 6 }, (_, i) => `old ${n} line ${i}`).join("\n\n") })
    }
    emit({ type: "item.started", turnId: "turn_s", itemId: "item_s", kind: "agent_message" })
    app.render()
    await app.onKey("\x1b[5~")
    app.render()
    const before = layouts()
    for (let i = 0; i < 10; i++) emit({ type: "item.delta", itemId: "item_s", text: `fresh${i}\n\n` })
    expect(layouts() - before).toBeGreaterThanOrEqual(20)
  })

  test("events other than deltas are measured for a follower too", () => {
    const { emit, layouts } = harness()
    emit({ type: "turn.started", turnId: "turn_o", queueId: "queue_o" })
    const before = layouts()
    emit({ type: "item.started", turnId: "turn_o", itemId: "item_o", kind: "agent_message" })
    expect(layouts() - before).toBeGreaterThanOrEqual(2)
  })
})
