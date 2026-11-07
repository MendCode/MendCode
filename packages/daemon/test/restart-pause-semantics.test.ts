import { describe, expect, test } from "bun:test"
import type { PendingResume } from "@mendcode/store"
import { createSessionActor } from "../../kernel/src/session-actor"
import { createHarness, createManualEngine, flush } from "../../kernel/test/helpers"
import { createRestartResume, RESUME_TEXT } from "../src/restart-resume"

describe("pause-after-turn across an orderly restart (no daemon)", () => {
  for (const pauseAgain of [false, true]) {
    test(`an active paused turn resumes after restart; a fresh pause blocks it (${pauseAgain ? "paused again" : "not paused again"})`, async () => {
      const h = createHarness()
      const manual = createManualEngine()
      const sessionId = h.ids("session")
      const oldScope = h.root.child("before restart")
      const actor = createSessionActor({ sessionId, clock: h.clock, scope: oldScope, engine: manual.engine, sink: h.sink, ids: h.ids })
      const rows = new Map<string, PendingResume>()
      let current = actor
      const resumer = () => createRestartResume({
        store: {
          resumes: {
            put: (entry) => { rows.set(entry.sessionId, entry) },
            list: (limit) => [...rows.values()].slice(0, limit),
            remove: (id) => { rows.delete(id) },
          },
          launchers: { get: () => undefined },
          hasSession: (id) => id === sessionId,
        },
        enabled: () => true,
        now: () => h.clock.now(),
        lastTurn: () => {
          const index = h.events.findLastIndex((event) => event.type === "turn.started")
          return index < 0 ? undefined : h.events.slice(index)
        },
        resume: (_id, text) => current.steer({ text, label: "daemon restarted · resumed", meta: { restart: "resume" }, afterRestart: true }),
        tell: async () => {},
        title: () => "paused work",
        queueId: () => h.ids("queue"),
        log: () => {},
      })
      try {
        await actor.handle({ id: h.ids("command"), clientId: h.ids("client"), type: "user.submit", sessionId, text: "work", attachments: [] })
        await flush()
        const turn = manual.last()
        // The drain's hold followed by an explicit user pause: both leave the active turn alone.
        await actor.pause(true, true)
        await actor.pause(true)
        expect(actor.snapshot()).toMatchObject({ paused: true, turnId: turn.input.turnId, stopping: false })
        expect(turn.input.signal.aborted).toBe(false)

        const before = resumer()
        before.record(sessionId, turn.input.turnId)
        before.stop()
        await actor.interrupt("restart", "daemon_shutdown")
        await flush()
        expect(h.events).toContainEqual(expect.objectContaining({ type: "turn.interrupted", turnId: turn.input.turnId, cause: "daemon_shutdown" }))
        oldScope.dispose()

        current = createSessionActor({ sessionId, clock: h.clock, scope: h.root.child("after restart"), engine: manual.engine, sink: h.sink, ids: h.ids })
        expect(current.snapshot().paused).toBe(false)
        if (pauseAgain) await current.pause(true)
        await resumer().start()
        await flush()
        expect(rows.size).toBe(0)
        expect(manual.turns).toHaveLength(pauseAgain ? 1 : 2)
        if (!pauseAgain) expect(manual.last().input.text).toBe(RESUME_TEXT)
        else expect(current.snapshot()).toMatchObject({ paused: true, turnId: undefined })
      } finally {
        h.root.dispose()
      }
    })
  }

  test("a completed paused turn leaves its recovered queue held, not running", async () => {
    const h = createHarness()
    const manual = createManualEngine()
    const sessionId = h.ids("session")
    const oldScope = h.root.child("before restart")
    const actor = createSessionActor({ sessionId, clock: h.clock, scope: oldScope, engine: manual.engine, sink: h.sink, ids: h.ids })
    const submit = (text: string) => actor.handle({ id: h.ids("command"), clientId: h.ids("client"), type: "user.submit", sessionId, text, attachments: [] })
    try {
      await submit("work")
      await flush()
      await actor.pause(true, true)
      await actor.pause(true)
      await submit("next")
      manual.last().finish()
      await flush()
      expect(actor.snapshot()).toMatchObject({ paused: true, turnId: undefined })
      expect(manual.turns).toHaveLength(1)
      const queueId = actor.snapshot().queue[0]!
      expect(queueId).toBeDefined()
      oldScope.dispose()

      const restored = createSessionActor({ sessionId, clock: h.clock, scope: h.root.child("after restart"), engine: manual.engine, sink: h.sink, ids: h.ids, restoredQueue: [{ queueId, text: "next", attachments: [] }] })
      await flush()
      expect(restored.snapshot()).toMatchObject({ paused: false, held: true, turnId: undefined, queue: [queueId] })
      expect(manual.turns).toHaveLength(1)
      await restored.pause(false)
      await flush()
      expect(manual.last().input.text).toBe("next")
      expect(manual.turns).toHaveLength(2)
    } finally {
      h.root.dispose()
    }
  })
})
