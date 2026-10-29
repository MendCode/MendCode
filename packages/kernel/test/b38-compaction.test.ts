import { expect, test } from "bun:test"
import { createSessionActor } from "../src/session-actor"
import { createHarness, createManualEngine, flush } from "./helpers"

test("plugin autocontinue=false suppresses a saved follow-up after successful compaction", async () => {
  const h = createHarness()
  const manual = createManualEngine()
  const sessionId = h.ids("session")
  const clientId = h.ids("client")
  const actor = createSessionActor({ sessionId, clock: h.clock, scope: h.root.child("session"), engine: manual.engine, sink: h.sink, ids: h.ids })
  await actor.handle({ id: h.ids("command"), clientId, type: "session.compact", sessionId })
  await flush()
  expect(manual.last().phase).toBe("compaction")
  await actor.handle({ id: h.ids("command"), clientId, type: "session.compaction.set", sessionId, turnId: manual.last().input.turnId, text: "continue work" })
  manual.last().finish({ status: "ok", compacted: true, continueAfterCompact: false })
  await flush()
  expect(manual.turns).toHaveLength(1)
  expect(h.events.some((event) => event.type === "queue.added" && event.text === "continue work")).toBe(false)
  expect(actor.snapshot().foreground).toBe("idle")
  h.root.dispose()
})
