import { describe, expect, test } from "bun:test"
import { createIdFactory, RewindReport, revertedTurnIds, SessionExportResult, TimelineEntry, visibleEvents, type SessionEvent } from "../src"

const ids = createIdFactory()
const sessionId = ids("session")
let seq = 0
const at = 1_000
const base = () => ({ sessionId, seq: ++seq, at })

function turnEvents(text: string) {
  const turnId = ids("turn")
  const itemId = ids("item")
  const answer = ids("item")
  const requestId = ids("request")
  const events: SessionEvent[] = [
    { ...base(), type: "turn.started", turnId, queueId: ids("queue") },
    { ...base(), type: "item.started", turnId, itemId, kind: "user_message" },
    { ...base(), type: "item.completed", itemId, status: "ok", text },
    { ...base(), type: "server.request", requestId, turnId, kind: "approval", title: "run", detail: "" },
    { ...base(), type: "server.request.resolved", requestId, resolution: "approved" },
    { ...base(), type: "item.started", turnId, itemId: answer, kind: "agent_message" },
    { ...base(), type: "item.delta", itemId: answer, text: "re" },
    { ...base(), type: "item.completed", itemId: answer, status: "ok", text: `re: ${text}` },
    { ...base(), type: "usage.recorded", turnId, provider: "p", model: "m", input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    { ...base(), type: "turn.completed", turnId },
  ]
  return { turnId, events }
}

const texts = (events: SessionEvent[]) => events.flatMap((event) => (event.type === "item.completed" && event.text ? [event.text] : []))

describe("undone turns", () => {
  test("a reverted turn is hidden with everything that belongs to it, and the markers themselves never show", () => {
    const one = turnEvents("one")
    const two = turnEvents("two")
    const three = turnEvents("three")
    const queue: SessionEvent = { ...base(), type: "queue.changed", queue: [] }
    const log: SessionEvent[] = [
      ...one.events,
      ...two.events,
      queue,
      { ...base(), type: "turn.reverted", turnId: two.turnId },
      ...three.events,
    ]
    expect([...revertedTurnIds(log)]).toEqual([two.turnId])
    const shown = visibleEvents(log)
    expect(texts(shown)).toEqual(["one", "re: one", "three", "re: three"])
    expect(shown.filter((event) => event.type === "turn.started").map((event) => (event as { turnId: string }).turnId)).toEqual([one.turnId, three.turnId])
    // No stray delta, request or usage of the hidden turn; events of no turn stay.
    expect(shown.length).toBe(one.events.length + three.events.length + 1)
    expect(shown).toContain(queue)
    expect(shown.some((event) => event.type === "turn.reverted" || event.type === "turn.restored")).toBe(false)
  })

  test("a restored turn is visible again, and a turn undone twice stays hidden", () => {
    const one = turnEvents("one")
    const log: SessionEvent[] = [...one.events, { ...base(), type: "turn.reverted", turnId: one.turnId }, { ...base(), type: "turn.restored", turnId: one.turnId }]
    expect(revertedTurnIds(log).size).toBe(0)
    expect(texts(visibleEvents(log))).toEqual(["one", "re: one"])
    const again: SessionEvent[] = [...log, { ...base(), type: "turn.reverted", turnId: one.turnId }]
    expect(texts(visibleEvents(again))).toEqual([])
  })

  test("a log with no markers comes back unchanged (as a copy)", () => {
    const one = turnEvents("one")
    const shown = visibleEvents(one.events)
    expect(shown).toEqual(one.events)
    expect(shown).not.toBe(one.events)
  })
})

describe("query schemas", () => {
  test("timeline entries, rewind reports and export results validate what the daemon sends", () => {
    const turnId = ids("turn")
    const itemId = ids("item")
    expect(TimelineEntry.safeParse({ turnId, itemId, at: 5, preview: "hello", reverted: false }).success).toBe(true)
    expect(TimelineEntry.safeParse({ turnId, itemId, at: 5, preview: "hello" }).success).toBe(false)
    const report = { turnIds: [turnId], itemId, files: { restored: ["a.ts"], removed: [], skipped: [{ path: "b.png", reason: "binary" }] }, history: { messages: 2, tracked: true }, shellUntracked: false, notes: [] }
    expect(RewindReport.safeParse(report).success).toBe(true)
    expect(RewindReport.safeParse({ ...report, files: { ...report.files, skipped: [{ path: "x", reason: "because" }] } }).success).toBe(false)
    expect(RewindReport.safeParse({ ...report, turnIds: [] }).success).toBe(false)
    expect(SessionExportResult.safeParse({ format: "json", text: "{}", turns: 0, truncated: false }).success).toBe(true)
  })
})
