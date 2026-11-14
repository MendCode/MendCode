import { expect, test } from "bun:test"
import { createSessionActor } from "../src/session-actor"
import { SPARE_AGENTS, sparesAgents } from "../src/ports"
import { createHarness, createManualEngine, flush } from "./helpers"

function setup() {
  const h = createHarness()
  const manual = createManualEngine()
  const sessionId = h.ids("session")
  const actor = createSessionActor({ sessionId, clock: h.clock, scope: h.root.child("session"), engine: manual.engine, sink: h.sink, ids: h.ids, cancelGraceMs: 1_000 })
  const run = async () => {
    await actor.handle({ id: h.ids("command"), clientId: h.ids("client"), type: "user.submit", sessionId, text: "work", attachments: [] })
    await flush()
    return manual.last().input
  }
  const cancel = (turnId: never, spareAgents?: true) => actor.handle({ id: h.ids("command"), clientId: h.ids("client"), type: "turn.cancel", sessionId, turnId, ...(spareAgents ? { spareAgents } : {}) })
  return { run, cancel }
}

test("a cancel that spares the agents reaches the engine as the turn's abort reason; a plain cancel does not", async () => {
  const spared = setup()
  const first = await spared.run()
  expect(await spared.cancel(first.turnId as never, true)).toEqual({ ok: true })
  expect(first.signal.aborted).toBe(true)
  expect(first.signal.reason).toBe(SPARE_AGENTS)
  expect(sparesAgents(first.signal)).toBe(true)

  const plain = setup()
  const second = await plain.run()
  await plain.cancel(second.turnId as never)
  expect(second.signal.aborted).toBe(true)
  expect(sparesAgents(second.signal)).toBe(false)
})
