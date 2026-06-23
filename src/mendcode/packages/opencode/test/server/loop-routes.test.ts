import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { WithInstance } from "../../src/project/with-instance"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import type { LoopWorkflow } from "../../src/session/loop"
import { HttpRouter } from "effect/unstable/http"
import { ExperimentalHttpApiServer } from "../../src/server/routes/instance/httpapi/server"

afterEach(async () => {
  await disposeAllInstances()
})

describe("loop routes", () => {
  test("draft, activate, run once, events, and stop", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Legacy().app

        const draftResponse = await app.request("/loop/draft", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "PR babysitter",
            objective: "Watch PR comments and report actionable work.",
            trigger: { mode: "interval", intervalMs: 60_000 },
          }),
        })
        expect(draftResponse.status).toBe(200)
        const draft = (await draftResponse.json()) as LoopWorkflow.Info
        expect(draft.state).toBe("draft")

        const listResponse = await app.request("/loop")
        expect(listResponse.status).toBe(200)
        const list = (await listResponse.json()) as LoopWorkflow.Info[]
        expect(list.map((loop) => loop.id)).toContain(draft.id)

        const activateResponse = await app.request(`/loop/${draft.id}/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "test activate", ensureService: false }),
        })
        expect(activateResponse.status).toBe(200)
        const active = (await activateResponse.json()) as LoopWorkflow.Info
        expect(active.rootSessionID).toBeDefined()
        expect(active.state).toBe("sleeping")

        const runResponse = await app.request(`/loop/${draft.id}/run-once`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "test run" }),
        })
        expect(runResponse.status).toBe(200)
        expect((await runResponse.json()) as LoopWorkflow.RunInfo).toMatchObject({ trigger: "run-once", state: "completed" })

        const eventsResponse = await app.request(`/loop/${draft.id}/events`)
        expect(eventsResponse.status).toBe(200)
        const events = (await eventsResponse.json()) as LoopWorkflow.JournalEvent[]
        expect(events.map((event) => event.type)).toEqual(["created", "activated", "wake"])

        const stopResponse = await app.request(`/loop/${draft.id}/stop`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "done" }),
        })
        expect(stopResponse.status).toBe(200)
        expect((await stopResponse.json()) as LoopWorkflow.Info).toMatchObject({ state: "stopped" })
      },
    })
  })

  test("effect httpapi raw loop route lists and controls workflows", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const legacy = Server.Legacy().app
        const handler = HttpRouter.toWebHandler(ExperimentalHttpApiServer.routes, { disableLogger: true }).handler
        const effect = {
          request(input: string | URL | Request, init?: RequestInit) {
            return handler(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init), ExperimentalHttpApiServer.context)
          },
        }
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

        const draftResponse = await legacy.request("/loop/draft", {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "Effect dashboard loop",
            objective: "Verify Effect raw route can serve the loops dashboard.",
            trigger: { mode: "interval", intervalMs: 60_000 },
          }),
        })
        expect(draftResponse.status).toBe(200)
        const draft = (await draftResponse.json()) as LoopWorkflow.Info

        const listResponse = await effect.request("/loop", { headers })
        expect(listResponse.status).toBe(200)
        const list = (await listResponse.json()) as LoopWorkflow.Info[]
        expect(list.map((loop) => loop.id)).toContain(draft.id)

        const snapshotResponse = await effect.request(`/loop/${draft.id}`, { headers })
        expect(snapshotResponse.status).toBe(200)
        expect((await snapshotResponse.json()) as LoopWorkflow.Snapshot).toMatchObject({
          workflow: { id: draft.id, name: "Effect dashboard loop" },
        })

        const stopResponse = await effect.request(`/loop/${draft.id}/stop`, {
          method: "POST",
          headers,
          body: JSON.stringify({ reason: "dashboard stop" }),
        })
        expect(stopResponse.status).toBe(200)
        expect((await stopResponse.json()) as LoopWorkflow.Info).toMatchObject({ state: "stopped" })
      },
    })
  })
})
