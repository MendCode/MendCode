import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, SessionID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Session } from "@/session/session"
import type { Tool } from "@/tool/tool"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

const baseContext: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_ai_config_tool"),
  messageID: MessageID.make("msg_ai_config_tool"),
  callID: "call_ai_config_tool",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.ai_config", () => {
  it.live("asks for the actual discovered target and leaves denied apply unchanged", () =>
    provideTmpdirInstance((directory) => Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const tool = (yield* registry.tools({ providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.6"),
        agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
      })).find((item) => item.id === "ai_config")
      if (!tool) throw new Error("AI tool missing")
      const ctx = { ...baseContext, sessionID: session.id, ask: () => Effect.void }
      const inventory = JSON.parse((yield* tool.execute({ action: "inspect" }, ctx)).output) as {
        configSources: Array<{ path: string; exists: boolean; digest: string }>
      }
      const target = inventory.configSources.find((item) => item.exists && item.path.startsWith(directory))
      if (!target) throw new Error("Fixture config not found")
      const before = yield* Effect.promise(() => Bun.file(target.path).text())
      const request = { action: "apply", scope: "project", expectedHash: target.digest, patch: { compaction: { strategy: "portable" } } }
      let approvals = 0
      const denied = yield* Effect.exit(tool.execute(request, { ...ctx, ask: (permission) => Effect.gen(function* () {
        approvals++
        expect(permission.metadata.target).toBe(target.path)
        expect(permission.metadata.expectedHash).toBe(target.digest)
        expect(permission.always).toEqual([])
        return yield* Effect.die(new Error("User denied"))
      }) }))
      expect(denied._tag).toBe("Failure")
      expect(yield* Effect.promise(() => Bun.file(target.path).text())).toBe(before)
      const result = yield* tool.execute(request, { ...ctx, ask: () => Effect.sync(() => { approvals++ }) })
      expect(JSON.parse(result.output).changed).toBe(true)
      expect(approvals).toBe(2)
    }), { git: true, config: { formatter: false, lsp: false } }),
  )

  it.live("exposes the native tool and performs a redacted inspect without provider calls", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: ProviderID.make("openai"),
            modelID: ModelID.make("gpt-5.6"),
            agent,
          })).find((item) => item.id === "ai_config")
          if (!tool) throw new Error("AI configuration tool not found")

          expect(tool.description).toContain("Inspect actual provider/model configuration")
          expect(tool.description).toContain("Apply never starts a workflow")

          const result = yield* tool.execute(
            { action: "inspect" },
            {
              ...baseContext,
              ask: () => Effect.void,
            },
          )
          const inventory = JSON.parse(result.output) as {
            version: number
            configSources: Array<{ path: string }>
          }
          expect(result.metadata.action).toBe("inspect")
          expect(inventory.version).toBe(1)
          expect(inventory.configSources.some((source) => source.path.includes(directory))).toBe(true)
          expect(result.output).not.toContain("access_token")
          expect(result.output).not.toContain("refresh_token")
        }),
      { git: true },
    ),
  )
})
