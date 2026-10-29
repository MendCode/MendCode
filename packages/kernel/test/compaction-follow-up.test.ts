import { expect, test } from "bun:test"
import type { TurnOutcome } from "../src/ports"
import { createSessionActor } from "../src/session-actor"
import { createHarness, createManualEngine, flush } from "./helpers"

function setup() {
  const h = createHarness()
  const manual = createManualEngine()
  const sessionId = h.ids("session")
  const clientId = h.ids("client")
  const actor = createSessionActor({ sessionId, clock: h.clock, scope: h.root.child("session"), engine: manual.engine, sink: h.sink, ids: h.ids })
  const command = (data: Record<string, unknown>) => actor.handle({ id: h.ids("command"), clientId, sessionId, ...data } as Parameters<typeof actor.handle>[0])
  const updates = () => h.events.filter((event) => event.type === "compaction.updated")
  return { h, manual, actor, command, updates }
}

for (const reason of ["manual", "auto"] as const) test(`${reason} compaction saves and sends the latest follow-up once, ahead of queued work`, async () => {
  const { h, manual, actor, command, updates } = setup()
  if (reason === "manual") await command({ type: "session.compact" })
  else {
    await command({ type: "user.submit", text: "start", attachments: [] })
    await flush()
    manual.requestCompaction()
    manual.last().finish()
  }
  await flush()
  const turnId = manual.last().input.turnId
  expect(updates().at(-1)).toMatchObject({ turnId, reason, state: "writing", followUp: "" })
  await command({ type: "user.submit", text: "queued work", attachments: [] })
  expect(await command({ type: "session.compaction.set", turnId, text: "old" })).toMatchObject({ ok: true })
  await command({ type: "session.compaction.set", turnId, text: "continue\nwith tests" })
  const count = updates().length
  await command({ type: "session.compaction.set", turnId, text: "continue\nwith tests" })
  expect(updates()).toHaveLength(count)
  manual.last().finish({ status: "ok", compacted: true })
  await flush()
  expect(updates().at(-1)).toMatchObject({ state: "packed", followUp: "continue\nwith tests", followUpQueueId: expect.any(String) })
  expect(manual.last().input.text).toBe("continue\nwith tests")
  expect(await command({ type: "session.compaction.set", turnId, text: "late" })).toMatchObject({ ok: false, code: "target_mismatch" })
  expect(h.events.filter((event) => event.type === "queue.added" && event.text === "continue\nwith tests")).toHaveLength(1)
  manual.last().finish()
  await flush()
  expect(manual.last().input.text).toBe("queued work")
  manual.last().finish()
  await flush()
  expect(actor.snapshot().foreground).toBe("idle")
  h.root.dispose()
})

for (const state of ["skipped", "failed", "cancelled", "interrupted"] as const) test(`${state} compaction retains the draft without sending it`, async () => {
  const { h, manual, actor, command, updates } = setup()
  await command({ type: "session.compact" })
  await flush()
  const turnId = manual.last().input.turnId
  await command({ type: "session.compaction.set", turnId, text: "keep this note" })
  if (state === "cancelled") await command({ type: "turn.cancel", turnId })
  else if (state === "interrupted") await actor.interrupt("transport")
  else manual.last().finish(state === "failed" ? { status: "error", code: "engine_error", message: "no summary" } as TurnOutcome : { status: "ok" })
  await flush()
  expect(updates().at(-1)).toMatchObject({ state, followUp: "keep this note" })
  expect(updates().at(-1)?.followUpQueueId).toBeUndefined()
  expect(h.events.filter((event) => event.type === "queue.added" && event.text === "keep this note")).toHaveLength(0)
  h.root.dispose()
})

test("a compaction the engine skipped carries its reason to the event", async () => {
  const { h, manual, command, updates } = setup()
  await command({ type: "session.compact" })
  await flush()
  manual.last().finish({ status: "ok", note: "Nothing to compact on this model yet" })
  await flush()
  expect(updates().at(-1)).toMatchObject({ state: "skipped", reason: "manual", note: "Nothing to compact on this model yet" })
  h.root.dispose()
})

test("a cleared scratchpad sends nothing, and a foreign turn cannot edit it", async () => {
  const { h, manual, command, updates } = setup()
  await command({ type: "session.compact" })
  await flush()
  const turnId = manual.last().input.turnId
  expect(await command({ type: "session.compaction.set", turnId: h.ids("turn"), text: "foreign" })).toMatchObject({ ok: false, code: "target_mismatch" })
  await command({ type: "session.compaction.set", turnId, text: "draft" })
  await command({ type: "session.compaction.set", turnId, text: "" })
  manual.last().finish({ status: "ok", compacted: true })
  await flush()
  expect(updates().at(-1)).toMatchObject({ state: "packed", followUp: "" })
  expect(updates().at(-1)?.followUpQueueId).toBeUndefined()
  h.root.dispose()
})
