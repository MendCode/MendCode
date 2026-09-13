import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import type { Permission } from "../../src/permission"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session/session"
import { MessageID, PartID } from "../../src/session/schema"
import { AgentCommand } from "../../src/session/agent-command"
import { TellTool } from "../../src/tool/tell"
import type { Tool } from "../../src/tool/tool"
import { ToolRegistry } from "../../src/tool/registry"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    ToolRegistry.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    AgentCommand.defaultLayer,
  ),
)

const model = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.tell", () => {
  it.live("forwards current, selected earlier, and local attachments", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const commands = yield* AgentCommand.Service
          const source = yield* sessions.create({ title: "sender" })
          const target = yield* sessions.create({ title: "receiver" })
          const earlier = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: source.id,
            agent: "build",
            model,
            time: { created: Date.now() - 2 },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: earlier.id,
            sessionID: source.id,
            type: "file",
            mime: "image/png",
            filename: "earlier.png",
            url: "data:image/png;base64,ZWarlier",
          })
          const current = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: source.id,
            agent: "build",
            model,
            time: { created: Date.now() - 1 },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: current.id,
            sessionID: source.id,
            type: "file",
            mime: "text/plain",
            filename: "current.txt",
            url: "data:text/plain;base64,Y3VycmVudA==",
          })
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            parentID: current.id,
            sessionID: source.id,
            mode: "build",
            agent: "build",
            cost: 0,
            path: { cwd: dir, root: dir },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.modelID,
            providerID: model.providerID,
            time: { created: Date.now() },
          })
          const local = path.join(dir, "local.json")
          yield* Effect.promise(() => Bun.write(local, "{}"))

          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: model.providerID,
            modelID: model.modelID,
            agent,
          })).find((item) => item.id === TellTool.id)
          if (!tool) throw new Error("tell tool not found")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const messages = yield* sessions.messages({ sessionID: source.id, view: "full" })
          const ctx: Tool.Context = {
            sessionID: source.id,
            messageID: assistant.id,
            callID: "call_tell",
            agent: "build",
            abort: AbortSignal.any([]),
            messages,
            metadata: () => Effect.void,
            ask: (request) => Effect.sync(() => void requests.push(request)),
          }

          const result = yield* tool.execute(
            {
              targetSessionID: target.id,
              userAttachments: ["earlier.png"],
              files: [local],
            },
            ctx,
          )
          const command = (yield* commands.list({ sourceSessionID: source.id })).find(
            (item) => item.type === "peer_message",
          )
          if (!command || command.type !== "peer_message") throw new Error("peer command not created")

          expect(result.output).toContain("attachments: 3")
          expect(command.payload.text).toBe("Shared attachments.")
          expect(command.payload.attachments).toEqual([
            {
              type: "file",
              mime: "text/plain",
              filename: "current.txt",
              url: "data:text/plain;base64,Y3VycmVudA==",
              source: undefined,
            },
            {
              type: "file",
              mime: "image/png",
              filename: "earlier.png",
              url: "data:image/png;base64,ZWarlier",
              source: undefined,
            },
            {
              type: "file",
              mime: "application/json",
              filename: "local.json",
              url: pathToFileURL(local).href,
              source: undefined,
            },
          ])
          expect(requests).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ permission: "read", patterns: [local] }),
            ]),
          )
        }),
      { git: true },
    ),
  )
})
