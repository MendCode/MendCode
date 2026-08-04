import { afterEach, describe, expect, test } from "bun:test"
import { HttpRouter } from "effect/unstable/http"
import { Flag } from "@mendcode/core/flag/flag"

import { Server } from "../../src/server/server"
import { ExperimentalHttpApiServer } from "../../src/server/routes/instance/httpapi/server"
import { WithInstance } from "../../src/project/with-instance"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const originalServerPassword = Flag.OPENCODE_SERVER_PASSWORD
const originalEnvServerPassword = process.env.OPENCODE_SERVER_PASSWORD

const plan = {
  formatVersion: 1,
  name: "Route workflow",
  description: "Exercise the workflow API",
  objective: "Validate and queue a bounded workflow",
  phases: [
    {
      id: "phase_research",
      ordinal: 1,
      name: "Research",
      barrier: { kind: "all" },
      taskIDs: ["task_research", "task_synthesis"],
    },
  ],
  tasks: [
    {
      id: "task_research",
      phaseID: "phase_research",
      name: "Research",
      kind: "agent",
      prompt: "Inspect the repository",
      dependsOn: [],
      output: { kind: "text" },
    },
    {
      id: "task_synthesis",
      phaseID: "phase_research",
      name: "Synthesize",
      kind: "synthesize",
      prompt: "Summarize the research",
      dependsOn: ["task_research"],
      inputs: [{ taskID: "task_research", required: true }],
      output: { kind: "text" },
    },
  ],
  finalTaskID: "task_synthesis",
  completionCriteria: ["The task is complete"],
  requiredGates: [],
}

afterEach(async () => {
  Flag.OPENCODE_SERVER_PASSWORD = originalServerPassword
  if (originalEnvServerPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = originalEnvServerPassword
  await disposeAllInstances()
})

describe("workflow routes", () => {
  test("legacy routes preview, save, start, inspect, and control a run", async () => {
    Flag.OPENCODE_SERVER_PASSWORD = undefined
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Legacy().app
        const headers = { "content-type": "application/json" }

        const previewResponse = await app.request("/workflow/preview", {
          method: "POST",
          headers,
          body: JSON.stringify({ plan }),
        })
        expect(previewResponse.status).toBe(200)
        expect(await previewResponse.json()).toMatchObject({ phaseCount: 1, taskCount: 2 })

        const saveResponse = await app.request("/workflow/save", {
          method: "POST",
          headers,
          body: JSON.stringify({ plan, name: "Saved route workflow" }),
        })
        expect(saveResponse.status).toBe(200)
        const receipt = await saveResponse.json() as { definitionID: string; revisionID: string; revision: number }
        expect(receipt.revision).toBe(1)

        const startResponse = await app.request("/workflow/start", {
          method: "POST",
          headers,
          body: JSON.stringify({ revisionID: receipt.revisionID }),
        })
        expect(startResponse.status).toBe(200)
        const started = await startResponse.json() as { run: { id: string; state: string }; events: unknown[] }
        expect(started.run.state).toBe("queued")
        expect(started.events).toHaveLength(1)

        const listResponse = await app.request("/workflow")
        expect(listResponse.status).toBe(200)
        expect((await listResponse.json() as Array<{ run: { id: string } }>)).toHaveLength(1)

        const eventsResponse = await app.request(`/workflow/${started.run.id}/events?limit=1`)
        expect(eventsResponse.status).toBe(200)
        expect(await eventsResponse.json()).toHaveLength(1)

        const pauseResponse = await app.request(`/workflow/${started.run.id}/pause`, {
          method: "POST",
          headers,
          body: JSON.stringify({ reason: "operator pause" }),
        })
        expect(pauseResponse.status).toBe(200)
        expect((await pauseResponse.json() as { run: { state: string } }).run.state).toBe("paused")

        const resumeResponse = await app.request(`/workflow/${started.run.id}/resume`, {
          method: "POST",
          headers,
          body: JSON.stringify({ reason: "operator resume" }),
        })
        expect(resumeResponse.status).toBe(200)
        expect((await resumeResponse.json() as { run: { state: string } }).run.state).toBe("queued")
      },
    })
  })

  test("Effect HttpApi exposes the same workflow snapshot contract", async () => {
    Flag.OPENCODE_SERVER_PASSWORD = undefined
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const handler = HttpRouter.toWebHandler(ExperimentalHttpApiServer.routes, { disableLogger: true }).handler
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
        const request = (path: string, init?: RequestInit) => handler(
          new Request(new URL(path, "http://localhost"), { ...init, headers: { ...headers, ...init?.headers } }),
          ExperimentalHttpApiServer.context,
        )

        const response = await request("/workflow/preview", {
          method: "POST",
          body: JSON.stringify({ plan }),
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ phaseCount: 1, taskCount: 2 })

        const startResponse = await request("/workflow/start", {
          method: "POST",
          body: JSON.stringify({ plan }),
        })
        expect(startResponse.status).toBe(200)
        const snapshot = await startResponse.json() as { run: { id: string }; definition: { name: string } }
        expect(snapshot.definition.name).toBe("Route workflow")

        const showResponse = await request(`/workflow/${snapshot.run.id}`)
        expect(showResponse.status).toBe(200)
        expect((await showResponse.json() as { run: { id: string } }).run.id).toBe(snapshot.run.id)
      },
    })
  })
})
