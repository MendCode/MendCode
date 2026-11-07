import { describe, expect, test } from "bun:test"
import { createSessionActor } from "../src/session-actor"
import { createHarness, createManualEngine, flush, types } from "./helpers"

describe("SessionActor live output tokens", () => {
  test("an engine's running count reaches the live hook and is never stored; the usage that records it clears it", async () => {
    const h = createHarness()
    const manual = createManualEngine()
    const sessionId = h.ids("session")
    const clientId = h.ids("client")
    const live: Array<[string, number]> = []
    const actor = createSessionActor({ sessionId, clock: h.clock, scope: h.root.child("session"), engine: manual.engine, sink: h.sink, ids: h.ids, onLiveOutput: (turnId, output) => void live.push([turnId, output]) })
    await actor.handle({ id: h.ids("command"), clientId, type: "user.submit", sessionId, text: "go", attachments: [] })
    await flush()
    const turn = manual.last()
    const stored = h.events.length
    turn.input.emit({ type: "usage.live", output: 120 })
    turn.input.emit({ type: "usage.live", output: 420 })
    await flush()
    expect(live).toEqual([[turn.input.turnId, 120], [turn.input.turnId, 420]])
    expect(h.events.length).toBe(stored)
    turn.input.emit({ type: "usage", provider: "claude", model: "m", input: 1, output: 450, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    await flush()
    expect(live.at(-1)).toEqual([turn.input.turnId, 0])
    expect(types(h.events).filter((type) => type === "usage.recorded")).toHaveLength(1)
    expect(types(h.events)).not.toContain("usage.live")
    turn.finish()
  })
})

describe("SessionActor live output estimate", () => {
  async function started() {
    const h = createHarness()
    const manual = createManualEngine()
    const sessionId = h.ids("session")
    const live: Array<[number, boolean]> = []
    const actor = createSessionActor({ sessionId, clock: h.clock, scope: h.root.child("session"), engine: manual.engine, sink: h.sink, ids: h.ids, onLiveOutput: (_turnId, output, estimated) => void live.push([output, estimated === true]) })
    await actor.handle({ id: h.ids("command"), clientId: h.ids("client"), type: "user.submit", sessionId, text: "go", attachments: [] })
    await flush()
    return { h, live, turn: manual.last() }
  }

  test("the main agent's streamed words count at four characters a token, marked as an estimate, until the call's usage records them", async () => {
    const { h, live, turn } = await started()
    const text = h.ids("item")
    turn.input.emit({ type: "item.started", itemId: text, kind: "agent_message" })
    turn.input.emit({ type: "item.delta", itemId: text, text: "x".repeat(40) })
    turn.input.emit({ type: "item.delta", itemId: text, text: "x".repeat(2) })
    await flush()
    expect(live).toEqual([[10, true], [11, true]])
    turn.input.emit({ type: "usage", provider: "p", model: "m", input: 1, output: 12, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    turn.input.emit({ type: "item.delta", itemId: text, text: "x".repeat(8) })
    await flush()
    // The record took the call's figure (0 clears the live part); the next call's words start a new estimate, never added to the old one.
    expect(live.slice(2)).toEqual([[0, false], [2, true]])
    turn.finish()
  })

  test("an exact count covers the words before it; hidden thinking shows the engine's estimate, the larger of it and the reasoning's words", async () => {
    const { h, live, turn } = await started()
    const reasoning = h.ids("item")
    turn.input.emit({ type: "item.started", itemId: reasoning, kind: "reasoning" })
    turn.input.emit({ type: "usage.thinking", tokens: 50 })
    turn.input.emit({ type: "item.delta", itemId: reasoning, text: "x".repeat(40) })
    turn.input.emit({ type: "usage.thinking", tokens: 325 })
    await flush()
    expect(live).toEqual([[50, true], [325, true]])
    turn.input.emit({ type: "usage.live", output: 470 })
    await flush()
    expect(live.at(-1)).toEqual([470, false])
    turn.finish()
  })

  test("a sub-agent's words and tool output are not counted: only the main agent's answer and reasoning", async () => {
    const { h, live, turn } = await started()
    const agentText = h.ids("item")
    const tool = h.ids("item")
    turn.input.emit({ type: "item.started", itemId: agentText, kind: "agent_message", meta: { agentParent: "itm_parent" } })
    turn.input.emit({ type: "item.delta", itemId: agentText, text: "x".repeat(400) })
    turn.input.emit({ type: "item.started", itemId: tool, kind: "tool_call", meta: { tool: "shell" } })
    turn.input.emit({ type: "item.delta", itemId: tool, text: "y".repeat(400) })
    await flush()
    expect(live).toEqual([])
    turn.finish()
  })
})
