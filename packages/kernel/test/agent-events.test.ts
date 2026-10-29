import { describe, expect, test } from "bun:test"
import { createSessionActor } from "../src/session-actor"
import { createHarness, createManualEngine, flush } from "./helpers"

describe("SessionActor background sub-agent items", () => {
  test("after its turn ended, a sub-agent's items are recorded under that turn; other late items and unknown completions are dropped", async () => {
    const h = createHarness()
    const manual = createManualEngine()
    const sessionId = h.ids("session")
    const actor = createSessionActor({ sessionId, clock: h.clock, scope: h.root.child("session"), engine: manual.engine, sink: h.sink, ids: h.ids, cancelGraceMs: 1_000 })
    await actor.handle({ id: h.ids("command"), clientId: h.ids("client"), type: "user.submit", sessionId, text: "go", attachments: [] })
    await flush()
    const turnId = manual.last().input.turnId
    manual.last().finish()
    await flush()
    const parent = h.ids("item")
    const tool = h.ids("item")
    const before = h.events.length
    actor.agentEvent(turnId, { type: "item.started", itemId: tool, kind: "tool_call", meta: { tool: "read: a.ts", agentParent: parent } })
    actor.agentEvent(turnId, { type: "item.started", itemId: h.ids("item"), kind: "agent_message" })
    actor.agentEvent(turnId, { type: "item.completed", itemId: h.ids("item"), status: "ok", text: "stray" })
    actor.agentEvent(turnId, { type: "item.completed", itemId: tool, status: "ok", text: "done", meta: { agentParent: parent } })
    await flush()
    const late = h.events.slice(before)
    expect(late.map((event) => event.type)).toEqual(["item.started", "item.completed"])
    expect(late[0]).toMatchObject({ turnId, itemId: tool, meta: { agentParent: parent } })
    expect(late[1]).toMatchObject({ itemId: tool, text: "done" })
  })
})
