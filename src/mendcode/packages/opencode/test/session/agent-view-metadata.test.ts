import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentViewMetadata } from "../../src/session/agent-view-metadata"
import { Session as SessionNs } from "../../src/session/session"
import { WithInstance } from "../../src/project/with-instance"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service | AgentViewMetadata.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Layer.mergeAll(SessionNs.defaultLayer, AgentViewMetadata.defaultLayer))))
}

const svc = {
  createSession(input?: SessionNs.CreateInput) {
    return run(Effect.gen(function* () {
      const session = yield* SessionNs.Service
      return yield* session.create(input)
    }))
  },
  get(sessionID: AgentViewMetadata.PatchInput["sessionID"]) {
    return run(Effect.gen(function* () {
      const metadata = yield* AgentViewMetadata.Service
      return yield* metadata.get(sessionID)
    }))
  },
  list() {
    return run(Effect.gen(function* () {
      const metadata = yield* AgentViewMetadata.Service
      return yield* metadata.list()
    }))
  },
  patch(input: AgentViewMetadata.PatchInput) {
    return run(Effect.gen(function* () {
      const metadata = yield* AgentViewMetadata.Service
      return yield* metadata.patch(input)
    }))
  },
}

afterEach(async () => {
  await disposeAllInstances()
})

describe("Agent View metadata", () => {
  test("patches safe metadata without changing the session title", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.createSession({ title: "Original transcript title" })

        const info = await svc.patch({
          sessionID: session.id,
          title: "  Coordinator label  ",
          tags: ["frontend", "frontend", "  api  ", ""],
          group: " sprint-1 ",
          priority: "high",
          notes: "review before shipping",
          pinned: true,
        })

        expect(info).toMatchObject({
          sessionID: session.id,
          title: "Coordinator label",
          tags: ["frontend", "api"],
          group: "sprint-1",
          priority: "high",
          notes: "review before shipping",
          pinned: true,
          archived: false,
        })
        expect((await svc.get(session.id))?.title).toBe("Coordinator label")
        expect((await svc.list()).map((item) => item.sessionID)).toContain(session.id)

        const storedSession = await run(Effect.gen(function* () {
          const sessionSvc = yield* SessionNs.Service
          return yield* sessionSvc.get(session.id)
        }))
        expect(storedSession.title).toBe("Original transcript title")
      },
    })
  })

  test("clears metadata fields idempotently", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.createSession({ title: "clear metadata" })
        await svc.patch({ sessionID: session.id, title: "Visible label", tags: ["ops"], archived: true })

        const cleared = await svc.patch({ sessionID: session.id, title: null, tags: null, archived: null })

        expect(cleared).toMatchObject({
          sessionID: session.id,
          tags: [],
          pinned: false,
          archived: false,
        })
        expect(cleared.title).toBeUndefined()
        expect(await svc.get(session.id)).toBeUndefined()
      },
    })
  })

  test("clearing the last metadata fields removes the row", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.createSession({ title: "event metadata" })
        await svc.patch({ sessionID: session.id, title: "Visible label" })
        const cleared = await svc.patch({ sessionID: session.id, title: null })
        expect(cleared.title).toBeUndefined()
        expect(await svc.get(session.id)).toBeUndefined()
      },
    })
  })
})
