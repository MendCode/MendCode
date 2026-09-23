import { afterEach, expect, test } from "bun:test"
import { Flag } from "@mendcode/core/flag/flag"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"
import { putRecord } from "../../src/session/runtime-mailbox"
import { SessionID } from "../../src/session/schema"

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI
afterEach(() => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
})
test.each([false, true])(
  "backend statistics preserve filtering and reject invalid days (HttpApi=%s)",
  async (experimental) => {
    await using tmp = await tmpdir({ git: true })
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = experimental
    const app = experimental ? Server.Default().app : Server.Legacy().app
    const headers = { "x-opencode-directory": encodeURIComponent(tmp.path), "content-type": "application/json" }
    const created = await app.request("/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Stats fixture" }),
    })
    expect(created.status).toBe(200)
    const session = await created.json()
    const resolution = await app.request(`/continuity/${session.id}/model-resolution`, {
      method: "POST",
      headers,
      body: JSON.stringify({ explicitModel: "fixture/model", explicitVariant: "high" }),
    })
    expect({ status: resolution.status, error: resolution.ok ? undefined : await resolution.clone().text() }).toEqual({
      status: 200,
      error: undefined,
    })
    expect(await resolution.json()).toMatchObject({
      model: { providerID: "fixture", modelID: "model" },
      variant: "high",
    })
    putRecord({
      id: `job_${session.id}`,
      sessionID: SessionID.make(session.id),
      directory: tmp.path,
      kind: "job",
      generation: 0,
      status: "completed",
      data: { tool: "read", result: "private result" },
      timeCreated: 1,
      timeUpdated: 1,
    })
    for (let i = 0; i < 101; i++)
      putRecord({
        id: `note_${session.id}_${i}`,
        sessionID: SessionID.make(session.id),
        directory: tmp.path,
        kind: "note",
        generation: 0,
        status: "saved",
        data: {},
        timeCreated: i + 2,
        timeUpdated: i + 2,
      })
    const continuity = await app.request(`/continuity/${session.id}`, { headers })
    expect({ status: continuity.status, error: continuity.ok ? undefined : await continuity.clone().text() }).toEqual({
      status: 200,
      error: undefined,
    })
    const jobs = await continuity.json()
    expect(jobs.records).toHaveLength(1)
    expect(jobs.records[0].data).toEqual({ tool: "read" })
    const stats = await app.request("/usage?project=", { headers })
    expect({ status: stats.status, error: stats.ok ? undefined : await stats.clone().text() }).toEqual({
      status: 200,
      error: undefined,
    })
    expect(await stats.json()).toMatchObject({ totalSessions: 1, totalMessages: 0, totalCost: 0 })
    const other = await app.request("/usage?project=missing", { headers })
    expect(await other.json()).toMatchObject({ totalSessions: 0 })
    expect((await app.request("/usage?days=-1", { headers })).status).toBe(400)
    expect((await app.request("/usage?days=NaN", { headers })).status).toBe(400)
    await app.request(`/session/${session.id}`, { method: "DELETE", headers })
  },
  30_000,
)
