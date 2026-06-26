import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { Effect, Exit, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import type { Tool } from "@/tool/tool"
import { LoopTool } from "../../src/tool/loop"
import { ToolRegistry } from "@/tool/registry"
import { Session } from "@/session/session"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
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
            providerID: ProviderID.opencode,
            modelID: ModelID.make("gpt-5"),
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
              budgetMode: "fixed",
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
          expect(result.output).toContain("budget_mode: fixed")
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

  it.live("uses normal execution for explicit edit objectives even without permissionMode", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ title: "Parent edit loop test" })
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: ProviderID.opencode,
            modelID: ModelID.make("gpt-5"),
            agent,
          })).find((tool) => tool.id === LoopTool.id)
          if (!tool) throw new Error("Loop tool not found")

          const result = yield* tool.execute(
            {
              action: "activate",
              objective: "Fix the loop bug by editing files and writing regression tests.",
              triggerMode: "manual",
              maxTurns: 3,
              ensureService: false,
            },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          )

          expect(result.metadata.permissionMode).toBe("normal")
          expect(result.metadata.workflows?.[0]?.permissionMode).toBe("normal")
          expect(result.metadata.budgetMode).toBe("max-goal")
        }),
      { git: true },
    ),
  )

  it.live("keeps report-only when the objective only says to report changes", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ title: "Parent report loop test" })
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: ProviderID.opencode,
            modelID: ModelID.make("gpt-5"),
            agent,
          })).find((tool) => tool.id === LoopTool.id)
          if (!tool) throw new Error("Loop tool not found")

          const result = yield* tool.execute(
            {
              action: "activate",
              objective: "Inspect files every five minutes and report changes.",
              triggerMode: "manual",
              maxTurns: 3,
              ensureService: false,
            },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          )

          expect(result.metadata.permissionMode).toBe("report-only")
          expect(result.metadata.workflows?.[0]?.permissionMode).toBe("report-only")
        }),
      { git: true },
    ),
  )

  it.live("still infers normal execution for make changes phrasing", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ title: "Parent make changes loop test" })
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: ProviderID.opencode,
            modelID: ModelID.make("gpt-5"),
            agent,
          })).find((tool) => tool.id === LoopTool.id)
          if (!tool) throw new Error("Loop tool not found")

          const result = yield* tool.execute(
            {
              action: "activate",
              objective: "Make changes to fix the loop bug and run tests.",
              triggerMode: "manual",
              maxTurns: 3,
              ensureService: false,
            },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          )

          expect(result.metadata.permissionMode).toBe("normal")
          expect(result.metadata.workflows?.[0]?.permissionMode).toBe("normal")
        }),
      { git: true },
    ),
  )

  it.live("normalizes zero maxTurns for interval monitors and rejects fixed zero caps", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ title: "Parent zero budget loop test" })
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: ProviderID.opencode,
            modelID: ModelID.make("gpt-5"),
            agent,
          })).find((tool) => tool.id === LoopTool.id)
          if (!tool) throw new Error("Loop tool not found")

          const activated = yield* tool.execute(
            {
              action: "activate",
              objective: "Run an hourly status monitor until stopped.",
              triggerMode: "interval",
              intervalMs: 3_600_000,
              maxTurns: 0,
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

          expect(activated.metadata.state).toBe("sleeping")
          expect(activated.metadata.workflows?.[0]?.maxTurns).toBeUndefined()
          expect(activated.metadata.budgetMode).toBe("unbounded-monitor")
          expect(activated.output).toContain("max_turns: unlimited")

          const fixedZero = yield* tool.execute(
            {
              action: "activate",
              objective: "Run exactly zero inspections.",
              triggerMode: "manual",
              maxTurns: 0,
              budgetMode: "fixed",
              permissionMode: "report-only",
              reportOnly: true,
              ensureService: false,
            },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          ).pipe(Effect.exit)

          expect(Exit.isFailure(fixedZero)).toBe(true)
        }),
      { git: true },
    ),
  )

  it.live("keeps report-only when the objective explicitly forbids edits", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ title: "Parent report-only phrase loop test" })
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: ProviderID.opencode,
            modelID: ModelID.make("gpt-5"),
            agent,
          })).find((tool) => tool.id === LoopTool.id)
          if (!tool) throw new Error("Loop tool not found")

          const result = yield* tool.execute(
            {
              action: "activate",
              objective: "Report-only inspection: identify the bug and do not edit files even if you could fix it.",
              triggerMode: "manual",
              maxTurns: 2,
              ensureService: false,
            },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          )

          expect(result.metadata.permissionMode).toBe("report-only")
          expect(result.metadata.workflows?.[0]?.permissionMode).toBe("report-only")
        }),
      { git: true },
    ),
  )

  it.live("reports custom permission mode in show and list metadata", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ title: "Parent custom permission loop test" })
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: ProviderID.opencode,
            modelID: ModelID.make("gpt-5"),
            agent,
          })).find((tool) => tool.id === LoopTool.id)
          if (!tool) throw new Error("Loop tool not found")

          const activated = yield* tool.execute(
            {
              action: "activate",
              objective: "Fix the loop bug with a guarded edit workflow.",
              triggerMode: "manual",
              maxTurns: 3,
              permissionMode: "custom",
              gates: ["edit only files under src/tool and stop for approval before broader changes"],
              ensureService: false,
            },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          )

          expect(activated.metadata.permissionMode).toBe("custom")
          expect(activated.metadata.workflows?.[0]?.permissionMode).toBe("custom")

          const listed = yield* tool.execute(
            { action: "list" },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          )

          const listedWorkflow = listed.metadata.workflows?.find(
            (item: { workflowID?: string; permissionMode?: string }) => item.workflowID === activated.metadata.workflowID,
          )
          expect(listedWorkflow?.permissionMode).toBe("custom")
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
            providerID: ProviderID.opencode,
            modelID: ModelID.make("gpt-5"),
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

          const deleted = yield* tool.execute(
            {
              action: "delete",
              reason: "User wants to remove stopped loop clutter.",
            },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          )

          expect(deleted.metadata.workflowID).toBe(activated.metadata.workflowID)
          expect(deleted.title).toContain("Deleted loop")

          const listed = yield* tool.execute(
            { action: "list" },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          )
          expect(listed.metadata.workflows?.map((item: { workflowID?: string }) => item.workflowID)).not.toContain(
            activated.metadata.workflowID,
          )
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
            providerID: ProviderID.opencode,
            modelID: ModelID.make("gpt-5"),
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
