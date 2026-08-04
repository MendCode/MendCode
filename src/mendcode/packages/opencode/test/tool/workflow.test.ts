import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { ModelID, ProviderID } from "@/provider/schema"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { WorkflowRunner } from "@/session/workflow-runner"
import { WorkflowPlan } from "@/session/workflow-plan"
import { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const plan = Schema.decodeUnknownSync(WorkflowPlan)({
  formatVersion: 1,
  name: "Tool workflow",
  description: "Exercise the workflow tool",
  objective: "Create and inspect one workflow run",
  phases: [
    {
      id: "synthesis",
      ordinal: 1,
      name: "Synthesis",
      barrier: { kind: "all" },
      taskIDs: ["final-task"],
    },
  ],
  tasks: [
    {
      id: "final-task",
      phaseID: "synthesis",
      name: "Synthesize",
      kind: "synthesize",
      prompt: "Summarize the workflow inputs.",
      dependsOn: [],
      output: { kind: "json", schema: { type: "object" } },
    },
  ],
  finalTaskID: "final-task",
  completionCriteria: ["The synthesis output is recorded."],
  requiredGates: [],
})

const baseContext: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_workflow_tool_parent"),
  messageID: MessageID.make("msg_workflow_tool"),
  callID: "call_workflow_tool",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.workflow", () => {
  const it = testEffect(
    Layer.mergeAll(
      ToolRegistry.defaultLayer,
      Session.defaultLayer,
      CrossSpawnSpawner.defaultLayer,
      Layer.succeed(
        WorkflowRunner.Service,
        WorkflowRunner.Service.of({
          start: (runID) => Effect.sync(() => void runID),
          run: () => Effect.void,
          stop: () => Effect.void,
        }),
      ),
    ),
  )

  it.live("previews, saves, starts, and lists workflow runs", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ title: "Workflow tool parent" })
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: ProviderID.opencode,
            modelID: ModelID.make("gpt-5"),
            agent,
          })).find((item) => item.id === "workflow")
          if (!tool) throw new Error("Workflow tool not found")

          const context = { ...baseContext, sessionID: parent.id, ask: () => Effect.void }
          const preview = yield* tool.execute({ action: "preview", plan }, context)
          expect(preview.metadata.phaseCount).toBe(1)
          expect(preview.metadata.taskCount).toBe(1)
          expect(preview.output).toContain("max_concurrency")

          const saved = yield* tool.execute({ action: "save", plan }, context)
          expect(saved.title).toContain("Saved workflow revision")
          expect(saved.metadata.revisionID).toBeString()
          if (!saved.metadata.revisionID) throw new Error("Workflow revision was not returned")

          const started = yield* tool.execute({ action: "start", revisionID: saved.metadata.revisionID }, context)
          expect(started.title).toContain("Started workflow")
          expect(started.metadata.state).toBe("queued")
          expect(started.output).toContain("run_id:")

          const listed = yield* tool.execute({ action: "list" }, context)
          expect(listed.metadata.count).toBe(1)
          expect(listed.output).toContain(started.metadata.runID)
        }),
      { git: true },
    ),
  )
})
