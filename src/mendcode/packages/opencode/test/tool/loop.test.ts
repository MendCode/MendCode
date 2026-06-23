import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import type { Tool } from "@/tool/tool"
import { LoopTool } from "../../src/tool/loop"
import { ToolRegistry } from "@/tool/registry"
import { Session } from "@/session/session"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_loop_parent"),
  messageID: MessageID.make("msg_loop_tool"),
  callID: "call_loop_tool",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("tool.loop", () => {
  it.live("registry exposes loop tool and activation creates a durable workflow", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ title: "Parent loop test" })
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((tool) => tool.id === LoopTool.id)
          if (!tool) throw new Error("Loop tool not found")

          const result = yield* tool.execute(
            {
              action: "activate",
              name: "Report-only file watch",
              objective: "Run 5 report-only inspections and summarize differences.",
              triggerMode: "manual",
              maxTurns: 5,
              maxRuntimeMs: 300000,
              maxChildren: 2,
              maxDepth: 1,
              model: "opencode/gpt-5#medium",
              agent: "build",
              permissionMode: "report-only",
              reportOnly: true,
              ensureService: false,
            },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          )

          expect(result.title).toContain("Activated loop")
          expect(result.metadata.workflowID).toStartWith("loop_")
          expect(result.metadata.rootSessionID).toStartWith("ses_")
          expect(result.metadata.state).toBe("active")
          expect(result.metadata.workflows?.[0]?.workflowID).toBe(result.metadata.workflowID)
          expect(result.metadata.workflows?.[0]?.maxTurns).toBe(5)
          expect(result.output).toContain("root_session_id:")
          expect(result.output).toContain("model: opencode/gpt-5#medium")
          expect(result.output).toContain("agent: build")
          expect(result.output).toContain("max_runtime_ms: 300000")
          expect(result.output).toContain("Loop service was not confirmed")

          const listed = yield* tool.execute(
            { action: "list" },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          )
          expect(listed.metadata.count).toBeGreaterThan(0)
          expect(listed.metadata.workflows?.[0]?.workflowID).toStartWith("loop_")
          expect(listed.metadata.workflows?.[0]?.rootSessionID).toStartWith("ses_")
        }),
      { git: true },
    ),
  )

  it.live("resolves the current session loop when control actions omit workflowID", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ title: "Parent loop stop test" })
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((tool) => tool.id === LoopTool.id)
          if (!tool) throw new Error("Loop tool not found")

          const activated = yield* tool.execute(
            {
              action: "activate",
              objective: "Inspect files every five minutes and report changes.",
              triggerMode: "interval",
              intervalMs: 300000,
              maxTurns: 10,
              permissionMode: "report-only",
              reportOnly: true,
              ensureService: false,
            },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          )

          expect(activated.metadata.workflowID).toStartWith("loop_")
          expect(activated.output).toContain("loop_name: Inspect files every five minutes and report changes.")

          const stopped = yield* tool.execute(
            {
              action: "stop",
              reason: "User asked to remove the current loop.",
            },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          )

          expect(stopped.metadata.workflowID).toBe(activated.metadata.workflowID)
          expect(stopped.metadata.state).toBe("stopped")
          expect(stopped.title).toContain("Loop stop")
        }),
      { git: true },
    ),
  )

  it.live("resolves contextual show when workflowID is omitted", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ title: "Parent loop show fallback test" })
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((tool) => tool.id === LoopTool.id)
          if (!tool) throw new Error("Loop tool not found")

          const activated = yield* tool.execute(
            {
              action: "activate",
              objective: "Show contextual loop without requiring a visible id.",
              triggerMode: "manual",
              maxTurns: 2,
              permissionMode: "report-only",
              reportOnly: true,
              ensureService: false,
            },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          )

          const shown = yield* tool.execute(
            { action: "show" },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          )

          expect(shown.title).toBe(`Loop ${activated.metadata.workflowID}`)
          expect(shown.metadata.workflowID).toBe(activated.metadata.workflowID)
          expect(shown.output).toContain("runs:")
        }),
      { git: true },
    ),
  )
})
