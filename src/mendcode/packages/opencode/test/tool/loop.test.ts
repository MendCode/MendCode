import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { Effect, Exit, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import type { Tool } from "@/tool/tool"
import { LoopTool } from "../../src/tool/loop"
import { ToolRegistry } from "@/tool/registry"
import { Session } from "@/session/session"
import { LoopWorkflow } from "@/session/loop"
import { MessageV2 } from "@/session/message-v2"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
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

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, Session.defaultLayer, LoopWorkflow.defaultLayer, CrossSpawnSpawner.defaultLayer))

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

          const updatedAgent = yield* tool.execute(
            {
              action: "update_agent",
              workflowID: result.metadata.workflowID,
              agent: "fix",
            },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          )
          expect(updatedAgent.title).toContain("Updated loop agent")
          expect(updatedAgent.metadata.agent).toBe("fix")
          expect(updatedAgent.output).toContain("agent: fix")

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

  it.live("shows latest run context, changed files, and loop message", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const sessions = yield* Session.Service
          const workflows = yield* LoopWorkflow.Service
          const parent = yield* sessions.create({ title: "Parent loop context test" })
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
              objective: "Inspect the repo and report changed files.",
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
          const workflowID = activated.metadata.workflowID
          const rootSessionID = activated.metadata.rootSessionID
          if (!workflowID || !rootSessionID) throw new Error("Loop did not activate with a root session")

          yield* sessions.setSummary({
            sessionID: rootSessionID,
            summary: {
              additions: 12,
              deletions: 3,
              files: 2,
              diffs: [
                { file: "src/loop-context.ts", additions: 10, deletions: 1, status: "modified", patch: "@@ fake" },
                { file: "test/loop-context.test.ts", additions: 2, deletions: 2, status: "added", patch: "@@ fake" },
              ],
            },
          })

          const userID = MessageID.ascending()
          yield* sessions.updateMessage({
            id: userID,
            role: "user",
            sessionID: rootSessionID,
            agent: "build",
            model: { providerID: ProviderID.opencode, modelID: ModelID.make("gpt-5") },
            time: { created: Date.now() },
          } satisfies MessageV2.User)
          const assistantID = MessageID.ascending()
          yield* sessions.updateMessage({
            id: assistantID,
            role: "assistant",
            parentID: userID,
            sessionID: rootSessionID,
            mode: "build",
            agent: "build",
            cost: 0,
            path: { cwd: "/tmp", root: "/tmp" },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelID.make("gpt-5"),
            providerID: ProviderID.opencode,
            time: { created: Date.now(), completed: Date.now() },
            finish: "stop",
          } satisfies MessageV2.Assistant)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistantID,
            sessionID: rootSessionID,
            type: "text",
            text: "Último reporte del loop: cambié dos archivos y dejé la validación lista.",
          })

          const run = yield* workflows.startRun({ id: workflowID, trigger: "manual", reason: "Manual context test." })
          yield* workflows.completeRun({
            id: workflowID,
            runID: run.id,
            reason: "Context summary from checkpoint.",
            checkpoint: {
              status: "continue",
              summary: "Se tocaron dos archivos del contexto del loop.",
              evidence: ["src/loop-context.ts changed", "test/loop-context.test.ts changed"],
              nextAction: "Run focused tests.",
              confidence: "high",
            },
          })

          const shown = yield* tool.execute(
            { action: "show", workflowID },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          )

          expect(shown.output).toContain("<loop_context>")
          expect(shown.output).toContain("latest_checkpoint:")
          expect(shown.output).toContain("summary: Se tocaron dos archivos del contexto del loop.")
          expect(shown.output).toContain("src/loop-context.ts (+10 -1 modified)")
          expect(shown.output).toContain("latest_loop_message:")
          expect(shown.output).toContain("Último reporte del loop")
          expect(shown.metadata.latestCheckpoint?.nextAction).toBe("Run focused tests.")
          expect((shown.metadata.changedFiles ?? []).map((file: { file: string }) => file.file)).toContain("test/loop-context.test.ts")
          expect(shown.metadata.lastMessage).toContain("cambié dos archivos")

          const listed = yield* tool.execute(
            { action: "list" },
            {
              ...baseCtx,
              sessionID: parent.id,
              ask: () => Effect.void,
            },
          )
          const listedWorkflow = listed.metadata.workflows?.find((item: { workflowID: string }) => item.workflowID === workflowID)
          expect(listed.output).toContain("last_summary: Context summary from checkpoint.")
          expect(listedWorkflow?.latestCheckpoint?.summary).toBe("Se tocaron dos archivos del contexto del loop.")
          expect(listedWorkflow?.lastMessage).toContain("Último reporte del loop")
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
