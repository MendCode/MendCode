import { describe, expect, test } from "bun:test"
import { createSessionActor } from "../src/session-actor"
import { createHarness, createManualEngine, flush, types } from "./helpers"

function setup() {
  const h = createHarness()
  const manual = createManualEngine()
  const sessionId = h.ids("session")
  const clientId = h.ids("client")
  const flags: boolean[] = []
  const actor = createSessionActor({ sessionId, clock: h.clock, scope: h.root.child("session"), engine: manual.engine, sink: h.sink, ids: h.ids, cancelGraceMs: 1_000, onPause: (paused) => flags.push(paused) })
  const submit = (text: string) => actor.handle({ id: h.ids("command"), clientId, type: "user.submit", sessionId, text, attachments: [] })
  return { h, manual, actor, sessionId, submit, flags }
}

describe("SessionActor pause", () => {
  test("a running turn finishes, then queued prompts wait until resume", async () => {
    const { h, manual, actor, submit, flags } = setup()
    await submit("first")
    await flush()
    expect(await actor.pause(true)).toBe(true)
    await submit("second")
    manual.last().finish()
    await flush()
    expect(types(h.events).filter((type) => type === "turn.completed")).toHaveLength(1)
    expect(types(h.events).filter((type) => type === "turn.started")).toHaveLength(1)
    expect(actor.snapshot()).toMatchObject({ foreground: "queued", paused: true })
    expect(actor.snapshot().queue).toHaveLength(1)
    expect(await actor.pause(false)).toBe(false)
    await flush()
    expect(manual.last().input.text).toBe("second")
    expect(actor.snapshot().paused).toBe(false)
    expect(flags).toEqual([true, false])
  })

  test("a paused idle session takes a prompt without starting it, and notices wait too", async () => {
    const { manual, actor, submit } = setup()
    await actor.pause(true)
    await submit("hold me")
    expect(await actor.notify("[a notice]", undefined, true)).toBeUndefined()
    await flush()
    expect(manual.turns).toHaveLength(0)
    expect(actor.snapshot().foreground).toBe("queued")
    expect(await actor.steer({ text: "go", label: "goal", meta: {} })).toBe(false)
    await actor.pause(false)
    await flush()
    expect(manual.last().input.text).toBe("hold me")
  })

  test("resume releases a user-cancel hold, and pausing twice reports one change", async () => {
    const { manual, actor, sessionId, submit, flags } = setup()
    await submit("work")
    await flush()
    const turnId = manual.last().input.turnId
    await actor.handle({ id: "cmd_x" as never, clientId: "cli_x" as never, type: "turn.cancel", sessionId, turnId })
    await flush()
    await submit("after cancel")
    await actor.pause(true)
    await actor.pause(true)
    expect(flags).toEqual([true])
    expect(actor.snapshot()).toMatchObject({ held: false, paused: true })
    await actor.pause(false)
    await flush()
    expect(manual.last().input.text).toBe("after cancel")
  })

  test("a disposed actor answers not paused", async () => {
    const { h, actor } = setup()
    h.root.dispose()
    expect(await actor.pause(true)).toBe(false)
  })

  test("a command posted just before the actor is disposed is answered, not dropped, and the snapshot counted it", async () => {
    const { h, actor, submit } = setup()
    const pending = submit("posted in the same pass")
    expect(actor.snapshot().mailbox).toBe(1)
    h.root.dispose()
    expect(await pending).toMatchObject({ ok: false, code: "unknown_session" })
  })
})
