import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { ModelID, ProviderID } from "@/provider/schema"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { WorkflowRunner } from "@/session/workflow-runner"
import { WorkflowPlan } from "@/session/workflow-plan"
import { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import { resolveWorkflowOriginSessionID } from "@/tool/workflow"
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
  test("maps the current origin alias to the invoking session", () => {
    const current = SessionID.make("ses_workflow_tool_current")
    expect(resolveWorkflowOriginSessionID(undefined, current)).toBe(current)
    expect(resolveWorkflowOriginSessionID("current", current)).toBe(current)
    expect(resolveWorkflowOriginSessionID(" CURRENT ", current)).toBe(current)
    expect(resolveWorkflowOriginSessionID("ses_other", current)).toBe(SessionID.make("ses_other"))
  })

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
          setPermissionMode: () => Effect.die("unused workflow runner method"),
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
          expect(tool.description).toContain("Do not poll")
          expect(tool.description).toContain("Every task includes dependsOn")
          expect(tool.description).toContain("maxFanOut")

          const context = { ...baseContext, sessionID: parent.id, ask: () => Effect.void }
          const preview = yield* tool.execute({ action: "preview", plan }, context)
          expect(preview.metadata.phaseCount).toBe(1)
          expect(preview.metadata.taskCount).toBe(1)
          expect(preview.metadata.phases?.[0]).toMatchObject({ ordinal: 1, name: "Synthesis", state: "pending" })
          expect(preview.output).toContain("max_concurrency")
          expect(preview.output).toContain("preview_only: true")

          const gated = yield* Effect.exit(
            tool.execute({ action: "start", plan: { ...plan, requiredGates: ["manual-approval"] } }, context),
          )
          expect(gated._tag).toBe("Failure")
          expect((yield* tool.execute({ action: "list" }, context)).metadata.count).toBe(0)

          const saved = yield* tool.execute({ action: "save", plan }, context)
          expect(saved.title).toContain("Saved workflow revision")
          expect(saved.metadata.revisionID).toBeString()
          if (!saved.metadata.revisionID) throw new Error("Workflow revision was not returned")

          const started = yield* tool.execute(
            { action: "start", revisionID: saved.metadata.revisionID, originSessionID: "current" },
            context,
          )
          expect(started.title).toContain("Started workflow")
          expect(started.metadata.state).toBe("queued")
          expect(started.metadata.phases?.[0]).toMatchObject({ ordinal: 1, name: "Synthesis", state: "pending" })
          expect(started.output).toContain("run_id:")
          expect(started.output).toContain("execution_mode: detached")
          expect(started.output).toContain("do not poll")

          const listed = yield* tool.execute({ action: "list" }, context)
          expect(listed.metadata.count).toBe(1)
          expect(listed.output).toContain(started.metadata.runID)

          if (!started.metadata.runID) throw new Error("Workflow run was not returned")
          const stopped = yield* tool.execute({ action: "stop", runID: started.metadata.runID }, context)
          expect(stopped.metadata.state).toBe("stopped")
          const deleted = yield* tool.execute({ action: "delete", runID: started.metadata.runID }, context)
          expect(deleted.title).toContain("Deleted workflow")
          const empty = yield* tool.execute({ action: "list" }, context)
          expect(empty.metadata.count).toBe(0)
        }),
      { git: true },
    ),
  )
})
