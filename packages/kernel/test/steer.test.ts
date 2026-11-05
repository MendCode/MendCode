import { describe, expect, test } from "bun:test"
import { createSessionActor } from "../src/session-actor"
import { createHarness, createManualEngine, flush, turnIds, types } from "./helpers"

function setup() {
  const h = createHarness()
  const manual = createManualEngine()
  const sessionId = h.ids("session")
  const clientId = h.ids("client")
  const actor = createSessionActor({ sessionId, clock: h.clock, scope: h.root.child("session"), engine: manual.engine, sink: h.sink, ids: h.ids, cancelGraceMs: 1_000 })
  const submit = (text: string) => actor.handle({ id: h.ids("command"), clientId, type: "user.submit", sessionId, text, attachments: [] })
  const steering = { text: "FULL STEERING TEXT", label: "goal · continuing", meta: { goal: "continuation" } }
  return { h, manual, actor, sessionId, clientId, submit, steering }
}

describe("SessionActor steering turns", () => {
  test("a free session starts the turn at once: the engine gets the full text, the transcript only the label, and nothing is queued", async () => {
    const { h, manual, actor, steering } = setup()
    expect(await actor.steer(steering)).toBe(true)
    await flush()
    expect(manual.last().input.text).toBe("FULL STEERING TEXT")
    expect(types(h.events)).not.toContain("queue.added")
    expect(types(h.events)).not.toContain("queue.changed")
    const item = h.events.find((event) => event.type === "item.started")
    expect(item).toMatchObject({ kind: "user_message", meta: { notice: true, goal: "continuation" } })
    expect(h.events.find((event) => event.type === "item.completed")).toMatchObject({ text: "goal · continuing" })
    expect(actor.snapshot().foreground).toBe("generating")
    manual.last().finish()
    await flush()
    expect(types(h.events)).toContain("turn.completed")
    expect(actor.snapshot().foreground).toBe("idle")
  })

  test("it is refused while a turn runs or messages are queued: queued messages always go first", async () => {
    const { h, manual, actor, submit, steering } = setup()
    await submit("first")
    await flush()
    expect(await actor.steer(steering)).toBe(false)
    await submit("second")
    manual.last().finish()
    await flush()
    // The queued message started by itself; the steering is refused again.
    expect(manual.last().input.text).toBe("second")
    expect(await actor.steer(steering)).toBe(false)
    manual.last().finish()
    await flush()
    expect(turnIds(h.events)).toHaveLength(2)
    expect(await actor.steer(steering)).toBe(true)
  })

  test("a user cancel holds the session: steering is refused unless it is forced, and a forced one starts", async () => {
    const { manual, actor, submit, steering, sessionId } = setup()
    await submit("work")
    await flush()
    const turnId = manual.last().input.turnId
    await actor.handle({ id: "cmd_x" as never, clientId: "cli_x" as never, type: "turn.cancel", sessionId, turnId })
    await flush()
    expect(actor.snapshot()).toMatchObject({ foreground: "idle", held: true })
    expect(await actor.steer(steering)).toBe(false)
    expect(await actor.steer({ ...steering, force: true })).toBe(true)
    await flush()
    expect(actor.snapshot().held).toBe(false)
    expect(manual.last().input.text).toBe("FULL STEERING TEXT")
  })

  test("a forced steering still waits for queued messages, and a disposed actor refuses", async () => {
    const { h, actor, steering, submit } = setup()
    await submit("one")
    await submit("two")
    await flush()
    expect(await actor.steer({ ...steering, force: true })).toBe(false)
    h.root.dispose()
    expect(await actor.steer(steering)).toBe(false)
  })

  test("a turn carried on after a restart goes ahead of the queue the restart restored and releases it; the queued message follows", async () => {
    const h = createHarness()
    const manual = createManualEngine()
    const restoredQueue = [{ queueId: h.ids("queue"), text: "queued while the turn ran", attachments: [] }]
    const actor = createSessionActor({ sessionId: h.ids("session"), clock: h.clock, scope: h.root.child("session"), engine: manual.engine, sink: h.sink, ids: h.ids, cancelGraceMs: 1_000, restoredQueue })
    const steering = { text: "RESUME", label: "daemon restarted · resumed", meta: { restart: "resume" } }
    expect(actor.snapshot()).toMatchObject({ held: true, queue: [restoredQueue[0]!.queueId] })
    // Any other steering still waits for the restored queue.
    expect(await actor.steer(steering)).toBe(false)
    expect(await actor.steer({ ...steering, force: true })).toBe(false)
    expect(await actor.steer({ ...steering, afterRestart: true })).toBe(true)
    await flush()
    expect(manual.last().input.text).toBe("RESUME")
    expect(actor.snapshot().held).toBe(false)
    manual.last().finish()
    await flush()
    expect(manual.last().input.text).toBe("queued while the turn ran")
  })

  test("a carried-on turn does not pass a hold a cancel set", async () => {
    const { manual, actor, submit, steering, sessionId } = setup()
    await submit("work")
    await submit("next")
    await flush()
    await actor.handle({ id: "cmd_x" as never, clientId: "cli_x" as never, type: "turn.cancel", sessionId, turnId: manual.last().input.turnId })
    await flush()
    expect(actor.snapshot()).toMatchObject({ held: true })
    expect(await actor.steer({ ...steering, afterRestart: true })).toBe(false)
  })
})
