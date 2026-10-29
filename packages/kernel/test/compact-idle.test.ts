import { describe, expect, test } from "bun:test"
import type { SessionEvent } from "@mendcode/protocol"
import { createSessionActor } from "../src/session-actor"
import { realClock } from "../src/clock"
import { createHarness, createManualEngine, flush } from "./helpers"

function setup() {
  const h = createHarness()
  const manual = createManualEngine()
  const sessionId = h.ids("session")
  const clientId = h.ids("client")
  const actor = createSessionActor({ sessionId, clock: h.clock, scope: h.root.child("session"), engine: manual.engine, sink: h.sink, ids: h.ids })
  const submit = (text: string) => actor.handle({ id: h.ids("command"), clientId, type: "user.submit", sessionId, text, attachments: [] })
  const compactions = () => h.events.filter((event): event is Extract<SessionEvent, { type: "compaction.updated" }> => event.type === "compaction.updated")
  return { h, manual, sessionId, clientId, actor, submit, compactions }
}

describe("compactIdle: a compaction the daemon starts in an idle session", () => {
  test("starts a compaction turn marked idle, asks the engine for an idle compaction and never touches the queue", async () => {
    const { h, manual, actor, compactions } = setup()
    expect(await actor.compactIdle()).toBe(true)
    await flush()
    expect(manual.last().phase).toBe("compaction")
    expect((manual.last().input as { idle?: boolean }).idle).toBe(true)
    expect(actor.snapshot().foreground).toBe("compacting")
    expect(h.events.some((event) => event.type === "queue.added" || event.type === "queue.changed")).toBe(false)
    manual.last().finish({ status: "ok", compacted: true })
    await flush()
    expect(compactions().map((event) => [event.reason, event.idle, event.state])).toEqual([["auto", true, "writing"], ["auto", true, "packed"]])
    expect(actor.snapshot().foreground).toBe("idle")
    h.root.dispose()
  })

  test("a manual /compact is not marked idle", async () => {
    const { h, manual, sessionId, clientId, actor, compactions } = setup()
    await actor.handle({ id: h.ids("command"), clientId, type: "session.compact", sessionId })
    await flush()
    expect((manual.last().input as { idle?: boolean }).idle).toBeUndefined()
    expect(compactions()[0]).toMatchObject({ reason: "manual", state: "writing" })
    expect(compactions()[0]!.idle).toBeUndefined()
    h.root.dispose()
  })

  test("does not start while a turn runs, while a message is queued or while the session is paused", async () => {
    const { h, manual, actor, submit, compactions } = setup()
    await submit("work")
    await flush()
    expect(await actor.compactIdle()).toBe(false)
    await submit("next")
    manual.last().finish()
    await flush()
    // The queued message started its own turn: still not free.
    expect(await actor.compactIdle()).toBe(false)
    manual.last().finish()
    await flush()
    await actor.pause(true)
    expect(await actor.compactIdle()).toBe(false)
    expect(compactions()).toEqual([])
    expect(manual.turns.every((turn) => turn.phase === "turn")).toBe(true)
    h.root.dispose()
  })

  test("a message sent while it runs waits behind it, as behind /compact, and runs when it ends", async () => {
    const { h, manual, actor, submit } = setup()
    expect(await actor.compactIdle()).toBe(true)
    await flush()
    await submit("hello")
    await flush()
    expect(manual.turns).toHaveLength(1)
    expect(actor.snapshot().queue).toHaveLength(1)
    expect(actor.snapshot().foreground).toBe("compacting")
    manual.last().finish({ status: "ok", compacted: true })
    await flush()
    expect(manual.turns).toHaveLength(2)
    expect(manual.last().phase).toBe("turn")
    expect(manual.last().input.text).toBe("hello")
    h.root.dispose()
  })

  test("a session held by a user cancel stays held: its waiting notice is not released by the compaction", async () => {
    const { h, manual, actor, submit } = setup()
    await submit("work")
    await flush()
    await actor.handle({ id: h.ids("command"), clientId: h.ids("client"), type: "turn.cancel", sessionId: actor.sessionId, turnId: manual.last().input.turnId })
    await flush()
    expect(actor.snapshot().held).toBe(true)
    expect(await actor.compactIdle()).toBe(true)
    await flush()
    await actor.notify("background task ended", undefined, false, undefined, true)
    manual.last().finish({ status: "ok", compacted: true })
    await flush()
    expect(actor.snapshot().held).toBe(true)
    expect(actor.snapshot().queue).toHaveLength(1)
    expect(manual.turns.filter((turn) => turn.phase === "turn")).toHaveLength(1)
    h.root.dispose()
  })
})

test("a real timer can be detached from the process's life", () => {
  const timer = realClock.setTimer(60_000, () => {})
  expect(typeof timer.unref).toBe("function")
  timer.unref!()
  timer.cancel()
})
