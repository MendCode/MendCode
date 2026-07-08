import { afterEach, describe, expect, mock, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "@/session/session"
import type { BackgroundSession } from "@/session/background"
import type { AgentViewMetadata } from "@/session/agent-view-metadata"
import type { AgentCommand } from "@/session/agent-command"
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

  test("background routes register, list, and allow multiple writable terminals", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({ title: "background route" })
        const foreground = await svc.create({ title: "foreground route" })
        await using other = await tmpdir({ git: true })
        const sibling = await WithInstance.provide({
          directory: other.path,
          fn: () => svc.create({ title: "sibling background" }),
        })
        const app = Server.Default().app
        const localHeaders = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
        const siblingHeaders = { "x-opencode-directory": other.path, "content-type": "application/json" }

        const registered = await app.request(`/session/${session.id}/background`, {
          method: "POST",
          headers: localHeaders,
          body: JSON.stringify({ state: "working", summary: "running tests", pinned: true }),
        })
        expect(registered.status).toBe(200)
        expect((await registered.json()) as BackgroundSession.Info).toMatchObject({
          sessionID: session.id,
          state: "working",
          summary: "running tests",
          pinned: true,
        })

        const activeOutsideWindow = await app.request(
          `/session/agent-view?roots=true&directory=${encodeURIComponent(tmp.path)}&start=${Date.now() + 60_000}`,
          { headers: localHeaders },
        )
        expect(activeOutsideWindow.status).toBe(200)
        expect(((await activeOutsideWindow.json()) as BackgroundSession.Entry[]).map((item) => item.sessionID)).toContain(session.id)

        const metadata = await app.request(`/session/${session.id}/agent-view/metadata`, {
          method: "PATCH",
          headers: localHeaders,
          body: JSON.stringify({ title: "Coordinator label", tags: ["ops", "ops", "api"], group: "sprint-1", priority: "high" }),
        })
        expect(metadata.status).toBe(200)
        expect((await metadata.json()) as AgentViewMetadata.Info).toMatchObject({
          sessionID: session.id,
          title: "Coordinator label",
          tags: ["ops", "api"],
          group: "sprint-1",
          priority: "high",
        })

        const metadataRead = await app.request(`/session/${session.id}/agent-view/metadata`, { headers: localHeaders })
        expect(metadataRead.status).toBe(200)
        expect((await metadataRead.json()) as AgentViewMetadata.Info).toMatchObject({ title: "Coordinator label" })

        const metadataList = await app.request("/session/agent-view/metadata", { headers: localHeaders })
        expect(metadataList.status).toBe(200)
        expect(((await metadataList.json()) as AgentViewMetadata.Info[]).map((item) => item.sessionID)).toContain(session.id)

        const command = await app.request(`/session/${session.id}/agent-command`, {
          method: "POST",
          headers: localHeaders,
          body: JSON.stringify({ sourceSessionID: foreground.id, type: "rename", payload: { title: "Worker label" } }),
        })
        expect(command.status).toBe(200)
        const commandBody = (await command.json()) as AgentCommand.Info
        expect(commandBody).toMatchObject({
          sourceSessionID: foreground.id,
          targetSessionID: session.id,
          type: "rename",
          state: "pending",
          permissions: ["agent_view.metadata.patch"],
          policy: { decision: "same_workspace", permissions: ["agent_view.metadata.patch"] },
        })

        const policy = await app.request("/session/agent-command/policy", { headers: localHeaders })
        expect(policy.status).toBe(200)
        expect(await policy.json()).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "request_summary", decision: "safe_auto" }),
          expect.objectContaining({ type: "rename", decision: "same_workspace" }),
          expect.objectContaining({ type: "tag", decision: "same_workspace" }),
          expect.objectContaining({ type: "pause_after_turn", decision: "approval_required" }),
          expect.objectContaining({ type: "stop", decision: "approval_required" }),
          expect.objectContaining({ type: "send_message", decision: "approval_required" }),
        ]))

        const inbox = await app.request(`/session/${session.id}/agent-command`, { headers: localHeaders })
        expect(inbox.status).toBe(200)
        expect(((await inbox.json()) as AgentCommand.Info[]).map((item) => item.id)).toEqual([commandBody.id])

        const acceptedCommand = await app.request(`/session/${session.id}/agent-command/${commandBody.id}`, {
          method: "PATCH",
          headers: localHeaders,
          body: JSON.stringify({ state: "accepted" }),
        })
        expect(acceptedCommand.status).toBe(200)
        expect((await acceptedCommand.json()) as AgentCommand.Info).toMatchObject({
          state: "completed",
          result: "Renamed target Agent View row.",
        })

        const completedCommand = await app.request(`/session/${session.id}/agent-command/${commandBody.id}`, {
          method: "PATCH",
          headers: localHeaders,
          body: JSON.stringify({ state: "completed", result: "done" }),
        })
        expect(completedCommand.status).toBe(200)
        expect((await completedCommand.json()) as AgentCommand.Info).toMatchObject({ state: "completed", result: "done" })

        const invalidTransition = await app.request(`/session/${session.id}/agent-command/${commandBody.id}`, {
          method: "PATCH",
          headers: localHeaders,
          body: JSON.stringify({ state: "running" }),
        })
        expect(invalidTransition.status).toBe(400)

        const filteredCommands = await app.request(`/session/agent-command?sourceSessionID=${foreground.id}&state=completed`, {
          headers: localHeaders,
        })
        expect(filteredCommands.status).toBe(200)
        expect(((await filteredCommands.json()) as AgentCommand.Info[]).map((item) => item.id)).toEqual([commandBody.id])

        const foregroundMetadata = await app.request(`/session/${foreground.id}/agent-view/metadata`, {
          method: "PATCH",
          headers: localHeaders,
          body: JSON.stringify({ title: "Foreground label", tags: ["fg"] }),
        })
        expect(foregroundMetadata.status).toBe(200)

        const siblingRegistered = await WithInstance.provide({
          directory: other.path,
          fn: () =>
            app.request(`/session/${sibling.id}/background`, {
              method: "POST",
              headers: siblingHeaders,
              body: JSON.stringify({ state: "working", summary: "elsewhere" }),
            }),
        })
        expect(siblingRegistered.status).toBe(200)

        const listed = await app.request("/session/background", { headers: localHeaders })
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
          metadata: {
            title: "Worker label",
            tags: ["ops", "api"],
          },
        })

        const aggregate = await app.request(`/session/agent-view?roots=true&directory=${encodeURIComponent(tmp.path)}`, {
          headers: localHeaders,
        })
        expect(aggregate.status).toBe(200)
        const aggregateItems = (await aggregate.json()) as BackgroundSession.Entry[]
        expect(aggregateItems.map((item) => item.sessionID)).toContain(session.id)
        expect(aggregateItems.map((item) => item.sessionID)).toContain(foreground.id)
        expect(aggregateItems.map((item) => item.sessionID)).not.toContain(sibling.id)
        expect(aggregateItems.find((item) => item.sessionID === foreground.id)).toMatchObject({
          sessionID: foreground.id,
          state: "completed",
          session: { title: "foreground route", directory: tmp.path },
          metadata: { title: "Foreground label", tags: ["fg"] },
        })

        const first = await app.request(`/session/${session.id}/background/writer`, {
          method: "POST",
          headers: localHeaders,
          body: JSON.stringify({ clientID: "terminal-a", ttlMs: 60_000 }),
        })
        expect(first.status).toBe(200)
        expect(await first.json()).toMatchObject({ acquired: true, info: { writer: { clientID: "terminal-a" } } })

        const metadataCommand = await app.request(`/session/${session.id}/agent-command`, {
          method: "POST",
          headers: localHeaders,
          body: JSON.stringify({ sourceSessionID: foreground.id, type: "tag", payload: { tags: ["owned"] } }),
        })
        expect(metadataCommand.status).toBe(200)
        expect((await metadataCommand.json()) as AgentCommand.Info).toMatchObject({
          state: "pending",
          policy: {
            decision: "same_workspace",
          },
        })

        const second = await app.request(`/session/${session.id}/background/writer`, {
          method: "POST",
          headers: localHeaders,
          body: JSON.stringify({ clientID: "terminal-b", ttlMs: 60_000 }),
        })
        expect(second.status).toBe(200)
        expect(await second.json()).toMatchObject({ acquired: true, info: { writer: { clientID: "terminal-b" } } })

        const released = await app.request(`/session/${session.id}/background/writer`, {
          method: "DELETE",
          headers: localHeaders,
          body: JSON.stringify({ clientID: "terminal-b" }),
        })
        expect(released.status).toBe(200)
        expect(((await released.json()) as BackgroundSession.Info).writer ?? null).toBeNull()

        await svc.remove(session.id)
      },
    })
  })
})
