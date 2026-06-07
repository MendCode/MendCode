import { afterEach, describe, expect, mock, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "@/session/session"
import type { BackgroundSession } from "@/session/background"
import type { SessionID } from "../../src/session/schema"
import * as Log from "@mendcode/core/util/log"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  remove(id: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.remove(id)))
  },
}

afterEach(async () => {
  mock.restore()
  await disposeAllInstances()
})

describe("session action routes", () => {
  test("abort route returns success", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/abort`, { method: "POST" })

        expect(res.status).toBe(200)
        expect(await res.json()).toBe(true)

        await svc.remove(session.id)
      },
    })
  })

  test("background routes register, list, and guard writer lease", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({ title: "background route" })
        const app = Server.Default().app

        const registered = await app.request(`/session/${session.id}/background`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: "working", summary: "running tests", pinned: true }),
        })
        expect(registered.status).toBe(200)
        expect((await registered.json()) as BackgroundSession.Info).toMatchObject({
          sessionID: session.id,
          state: "working",
          summary: "running tests",
          pinned: true,
        })

        const listed = await app.request("/session/background")
        expect(listed.status).toBe(200)
        const items = (await listed.json()) as BackgroundSession.Entry[]
        expect(items.map((item) => item.sessionID)).toContain(session.id)
        expect(items.find((item) => item.sessionID === session.id)).toMatchObject({
          sessionID: session.id,
          state: "completed",
          summary: "running tests",
          session: {
            title: "background route",
            directory: tmp.path,
          },
        })

        const first = await app.request(`/session/${session.id}/background/writer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientID: "terminal-a", ttlMs: 60_000 }),
        })
        expect(first.status).toBe(200)
        expect(await first.json()).toMatchObject({ acquired: true, info: { writer: { clientID: "terminal-a" } } })

        const second = await app.request(`/session/${session.id}/background/writer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientID: "terminal-b", ttlMs: 60_000 }),
        })
        expect(second.status).toBe(200)
        expect(await second.json()).toMatchObject({ acquired: false, info: { writer: { clientID: "terminal-a" } } })

        const released = await app.request(`/session/${session.id}/background/writer`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientID: "terminal-a" }),
        })
        expect(released.status).toBe(200)
        expect(((await released.json()) as BackgroundSession.Info).writer ?? null).toBeNull()

        await svc.remove(session.id)
      },
    })
  })
})
