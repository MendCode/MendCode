import { describe, expect, test } from "bun:test"
import type { EngineEvent } from "@mendcode/kernel"
import { EARLY_TOOL_CHARS, INPUT_PROGRESS_CHARS } from "@mendcode/protocol"
import { callTitle, createNativeEngine, memoryHistory, type ModelEvent } from "../src"
import { ids, scriptedProvider, stop, turn, writeTool } from "./harness"

/** A `write` whose input streams in 100-character pieces, the way a model writes a whole file. */
function streamedWrite(input: string, callId: string, whole = true): ModelEvent[] {
  const pieces: ModelEvent[] = []
  for (let at = 0; at < input.length; at += 100) pieces.push({ type: "tool_input", callId, name: "write", delta: input.slice(at, at + 100) })
  if (!whole) return pieces
  return [...pieces, { type: "tool_call", call: { callId, name: "write", args: JSON.parse(input) } }, { type: "finish", reason: "tool_calls" }]
}

const longInput = (path: string, size: number) => JSON.stringify({ path, content: "line\n".repeat(size / 5) })
const cards = (events: EngineEvent[]) => events.filter((event) => event.type === "item.started" && event.kind === "tool_call")

function engineWith(steps: Parameters<typeof scriptedProvider>[0]) {
  const log: string[] = []
  const { provider } = scriptedProvider(steps)
  const engine = createNativeEngine({ provider, tools: [writeTool(log)], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize" })
  return { engine, log }
}

describe("a call whose input the model is still writing", () => {
  test("opens its card early, says how much is written, and the run finishes that same card", async () => {
    const callId = ids("item")
    const input = longInput("a.ts", 6_000)
    const { engine, log } = engineWith([streamedWrite(input, callId), stop("done")])
    const { input: turnInput, events } = turn({ text: "write", mode: () => "full" })
    await engine.runTurn(turnInput)
    expect(log).toEqual(["a.ts"])
    const started = cards(events)
    expect(started).toHaveLength(1)
    const itemId = started[0]!.type === "item.started" ? started[0]!.itemId : undefined
    expect(started[0]).toMatchObject({ meta: { tool: callTitle({ callId, name: "write", args: { path: "a.ts" } }) } })
    // The card opened before the call was whole: its progress deltas come before the run's own events.
    const progress = events.flatMap((event) => (event.type === "item.delta" && event.itemId === itemId && event.input ? [event.input] : []))
    expect(progress.length).toBeGreaterThanOrEqual(2)
    expect(progress.at(-1)).toMatchObject({ chars: input.length, done: true })
    expect(progress.slice(0, -1).every((step) => step.chars >= EARLY_TOOL_CHARS && !step.done)).toBe(true)
    expect(progress.length - 1).toBeLessThanOrEqual(Math.ceil(input.length / INPUT_PROGRESS_CHARS))
    const completed = events.filter((event) => event.type === "item.completed" && event.itemId === itemId)
    expect(completed).toEqual([expect.objectContaining({ status: "ok", text: "wrote a.ts" })])
    expect(completed[0]).not.toMatchObject({ meta: { retitled: true } })
  })

  test("a short input keeps one card that opens when the call is whole", async () => {
    const callId = ids("item")
    const { engine } = engineWith([streamedWrite(JSON.stringify({ path: "b.ts", content: "x" }), callId), stop("done")])
    const { input, events } = turn({ text: "write", mode: () => "full" })
    await engine.runTurn(input)
    expect(cards(events)).toHaveLength(1)
    expect(events.some((event) => event.type === "item.delta" && event.input)).toBe(false)
  })

  test("a card named from part of the input is named again from the whole input", async () => {
    const callId = ids("item")
    // The content comes first, so the card opens before the path is written.
    const input = JSON.stringify({ content: "line\n".repeat(600), path: "late.ts" })
    const { engine } = engineWith([streamedWrite(input, callId), stop("done")])
    const { input: turnInput, events } = turn({ text: "write", mode: () => "full" })
    await engine.runTurn(turnInput)
    const itemId = (cards(events)[0] as Extract<EngineEvent, { type: "item.started" }>).itemId
    expect(events.find((event) => event.type === "item.completed" && event.itemId === itemId)).toMatchObject({ status: "ok", meta: { tool: callTitle({ callId, name: "write", args: { content: "", path: "late.ts" } }), retitled: true } })
  })

  test("a stream that fails before the input is whole closes the card without running anything", async () => {
    const callId = ids("item")
    const cut = streamedWrite(longInput("c.ts", 4_000), callId, false)
    const { engine, log } = engineWith([async function* () { yield* cut; throw new Error("[PROVIDER]: boom") }])
    const { input, events } = turn({ text: "write", mode: () => "full" })
    await engine.runTurn(input)
    expect(log).toEqual([])
    const itemId = (cards(events)[0] as Extract<EngineEvent, { type: "item.started" }>).itemId
    expect(events.filter((event) => event.type === "item.completed" && event.itemId === itemId)).toEqual([expect.objectContaining({ status: "error" })])
  })

  test("a cancel while the input streams closes the card as cancelled", async () => {
    const callId = ids("item")
    const abort = new AbortController()
    const cut = streamedWrite(longInput("d.ts", 4_000), callId, false)
    const { engine, log } = engineWith([async function* () { yield* cut; abort.abort(); yield* streamedWrite(longInput("d.ts", 4_000), callId) }])
    const { input, events } = turn({ text: "write", mode: () => "full", signal: abort.signal })
    await engine.runTurn(input)
    expect(log).toEqual([])
    const itemId = (cards(events)[0] as Extract<EngineEvent, { type: "item.started" }>).itemId
    expect(events.filter((event) => event.type === "item.completed" && event.itemId === itemId)).toEqual([expect.objectContaining({ status: "cancelled" })])
  })
})
