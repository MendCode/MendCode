import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { BackgroundSession } from "../../src/session/background"
import { Session as SessionNs } from "../../src/session/session"
import { WithInstance } from "../../src/project/with-instance"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service | BackgroundSession.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Layer.mergeAll(SessionNs.defaultLayer, BackgroundSession.defaultLayer))))
}

const svc = {
  createSession(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((session) => session.create(input)))
  },
  register(input: BackgroundSession.RegisterInput) {
    return run(BackgroundSession.Service.use((background) => background.register(input)))
  },
  get(sessionID: BackgroundSession.RegisterInput["sessionID"]) {
    return run(BackgroundSession.Service.use((background) => background.get(sessionID)))
  },
  list() {
    return run(BackgroundSession.Service.use((background) => background.list()))
  },
  remove(sessionID: BackgroundSession.RegisterInput["sessionID"]) {
    return run(BackgroundSession.Service.use((background) => background.remove(sessionID)))
  },
  acquireWriter(input: BackgroundSession.WriterInput) {
    return run(BackgroundSession.Service.use((background) => background.acquireWriter(input)))
  },
  releaseWriter(input: { sessionID: BackgroundSession.RegisterInput["sessionID"]; clientID: string }) {
    return run(BackgroundSession.Service.use((background) => background.releaseWriter(input)))
  },
}

afterEach(async () => {
  await disposeAllInstances()
})

describe("background sessions", () => {
  test("registers and lists background metadata without including normal sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const normal = await svc.createSession({ title: "foreground" })
        const background = await svc.createSession({ title: "background" })

        const info = await svc.register({
          sessionID: background.id,
          state: "working",
          summary: "running tests",
          pinned: true,
        })

        expect(info).toMatchObject({
          sessionID: background.id,
          state: "working",
          summary: "running tests",
          pinned: true,
        })

        expect(await svc.get(background.id)).toMatchObject({ sessionID: background.id, state: "working" })
        expect(await svc.get(normal.id)).toBeUndefined()

        const listed = await svc.list()
        expect(listed.map((item) => item.sessionID)).toContain(background.id)
        expect(listed.map((item) => item.sessionID)).not.toContain(normal.id)

        await svc.remove(background.id)
        expect(await svc.get(background.id)).toBeUndefined()
      },
    })
  })

  test("writer lease allows one attached writer and many read-only followers", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.createSession({ title: "lease" })
        await svc.register({ sessionID: session.id, state: "working" })

        const first = await svc.acquireWriter({ sessionID: session.id, clientID: "terminal-a", ttlMs: 60_000 })
        expect(first.acquired).toBe(true)
        if (!first.acquired) throw new Error("expected first lease acquisition")
        expect(first.info.writer?.clientID).toBe("terminal-a")

        const second = await svc.acquireWriter({ sessionID: session.id, clientID: "terminal-b", ttlMs: 60_000 })
        expect(second.acquired).toBe(false)
        expect(second.info?.writer?.clientID).toBe("terminal-a")

        expect(await svc.releaseWriter({ sessionID: session.id, clientID: "terminal-b" })).toBeUndefined()

        const released = await svc.releaseWriter({ sessionID: session.id, clientID: "terminal-a" })
        expect(released?.writer).toBeUndefined()

        const third = await svc.acquireWriter({ sessionID: session.id, clientID: "terminal-b", ttlMs: 60_000 })
        expect(third.acquired).toBe(true)
        if (!third.acquired) throw new Error("expected second terminal after release")
        expect(third.info.writer?.clientID).toBe("terminal-b")
      },
    })
  })

  test("deriveState prioritizes stopped/failed, pending input, and active work", () => {
    expect(BackgroundSession.deriveState({ background: failedBackground() })).toBe("failed")
    expect(BackgroundSession.deriveState({ pendingInput: 1 })).toBe("needs_input")
    expect(BackgroundSession.deriveState({ status: { type: "retry", attempt: 1, message: "retry", next: 0 } })).toBe(
      "needs_input",
    )
    expect(BackgroundSession.deriveState({ status: { type: "busy" } })).toBe("working")
    expect(BackgroundSession.deriveState({ background: completedBackground(), status: { type: "idle" } })).toBe(
      "completed",
    )
    expect(BackgroundSession.deriveState({ background: workingBackground() })).toBe("completed")
    expect(BackgroundSession.deriveState({ background: queuedBackground() })).toBe("queued")
  })
})

function failedBackground(): BackgroundSession.Info {
  return {
    sessionID: "session_failed" as BackgroundSession.Info["sessionID"],
    state: "failed",
    error: "boom",
    pinned: false,
    time: { created: 1, updated: 2 },
  }
}

function completedBackground(): BackgroundSession.Info {
  return {
    sessionID: "session_completed" as BackgroundSession.Info["sessionID"],
    state: "completed",
    pinned: false,
    time: { created: 1, updated: 2 },
  }
}

function workingBackground(): BackgroundSession.Info {
  return {
    sessionID: "session_working" as BackgroundSession.Info["sessionID"],
    state: "working",
    pinned: false,
    time: { created: 1, updated: 2 },
  }
}

function queuedBackground(): BackgroundSession.Info {
  return {
    sessionID: "session_queued" as BackgroundSession.Info["sessionID"],
    state: "queued",
    pinned: false,
    time: { created: 1, updated: 2 },
  }
}
