import { expect, test } from "bun:test"
import { createSessionActor } from "../src/session-actor"
import { createHarness, createManualEngine, flush } from "./helpers"

test("a bounded nested operation abandons only its pending request; stale approvals cannot execute it", async () => {
  const h = createHarness(), manual = createManualEngine()
  const sessionId = h.ids("session"), clientId = h.ids("client")
  const actor = createSessionActor({ sessionId, clock: h.clock, scope: h.root.child("session"), engine: manual.engine, sink: h.sink, ids: h.ids })
  await actor.handle({ id: h.ids("command"), clientId, type: "user.submit", sessionId, text: "orchestrate", attachments: [] })
  await flush()
  const local = new AbortController(), input = manual.last().input
  const pending = input.ask({ kind: "approval", title: "write", detail: "a.ts", signal: local.signal })
  await flush()
  const request = h.events.find((event) => event.type === "server.request")!
  if (request.type !== "server.request") throw new Error("missing request")
  expect(actor.snapshot().foreground).toBe("waiting_approval")
  local.abort()
  await flush()
  expect(await pending).toEqual({ kind: "abandoned" })
  expect(actor.snapshot().foreground).toBe("generating")
  expect(input.signal.aborted).toBe(false)
  expect(h.events.filter((event) => event.type === "server.request.resolved")).toMatchObject([{ resolution: "abandoned", requestId: request.requestId }])
  expect(await actor.handle({ id: h.ids("command"), clientId, type: "request.resolve", sessionId, requestId: request.requestId, decision: { kind: "approve", scope: "once" } })).toMatchObject({ ok: false, code: "request_already_resolved" })
  manual.last().finish()
  await flush()
  expect(actor.snapshot().foreground).toBe("idle")
  h.root.dispose()
})

test("a request with an already aborted operation signal never reaches the client", async () => {
  const h = createHarness(), manual = createManualEngine()
  const sessionId = h.ids("session"), clientId = h.ids("client")
  const actor = createSessionActor({ sessionId, clock: h.clock, scope: h.root.child("session"), engine: manual.engine, sink: h.sink, ids: h.ids })
  await actor.handle({ id: h.ids("command"), clientId, type: "user.submit", sessionId, text: "go", attachments: [] })
  await flush()
  const abort = new AbortController()
  abort.abort()
  expect(await manual.last().input.ask({ kind: "question", title: "gone", detail: "", signal: abort.signal })).toEqual({ kind: "abandoned" })
  expect(h.events.some((event) => event.type === "server.request")).toBe(false)
  manual.last().finish()
  await flush()
  h.root.dispose()
})
