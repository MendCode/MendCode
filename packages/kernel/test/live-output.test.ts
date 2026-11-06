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
