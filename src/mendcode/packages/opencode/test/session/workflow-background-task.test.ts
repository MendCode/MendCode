import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"

import { BackgroundTask } from "@/session/background-task"
import { Session } from "@/session/session"
import { Workflow } from "@/session/workflow"
import { WorkflowPlan } from "@/session/workflow-plan"
import * as WorkflowBackgroundTask from "@/session/workflow-background-task"
import * as WorkflowService from "@/session/workflow-service"
import { testEffect } from "../lib/effect"

const plan = {
  formatVersion: 1,
  name: "Background workflow",
  description: "Background lifecycle test",
  objective: "Keep the workflow root independent",
  phases: [{ id: "phase", ordinal: 1, name: "Phase", barrier: { kind: "all" }, taskIDs: ["task"] }],
  tasks: [{
    id: "task",
    phaseID: "phase",
    name: "Task",
    kind: "synthesize",
    prompt: "Inspect the project",
    dependsOn: [],
    output: { kind: "text" },
  }],
  finalTaskID: "task",
  completionCriteria: ["The inspection is complete"],
  requiredGates: [],
} as unknown as WorkflowPlan

const backgroundLayer = WorkflowBackgroundTask.layer.pipe(
  Layer.provideMerge(BackgroundTask.defaultLayer),
  Layer.provideMerge(Session.defaultLayer),
)
const it = testEffect(Layer.mergeAll(backgroundLayer, WorkflowService.defaultLayer))

describe("workflow background task adapter", () => {
  it.instance("keeps the root independent from the origin and links child attempts to BackgroundTask", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workflow = yield* WorkflowService.Service
      const adapter = yield* WorkflowBackgroundTask.Service
      const origin = yield* sessions.create({ title: "Origin" })
      const started = yield* workflow.start({ plan, originSessionID: origin.id })
      const root = yield* adapter.ensureRoot({ runID: started.run.id, title: started.definition.name })

      expect((yield* sessions.get(root.sessionID)).parentID).toBeUndefined()
      expect((yield* workflow.show(started.run.id)).run.rootSessionID).toBe(root.sessionID)

      const attempt = yield* adapter.startAttempt({
        runID: started.run.id,
        taskID: Workflow.WorkflowTaskID.make("task"),
        parentSessionID: root.sessionID,
        rootSessionID: root.sessionID,
        title: "Task",
        agent: "general",
        depth: 1,
      })
      expect((yield* sessions.get(attempt.sessionID)).parentID).toBe(root.sessionID)
      expect((yield* adapter.getAttempt({ sessionID: attempt.sessionID, generation: attempt.generation }))?.state).toBe("running")

      yield* adapter.finishAttempt({
        taskID: attempt.sessionID,
        generation: attempt.generation,
        state: "completed",
        result: { summary: "Done" },
      })
      expect((yield* adapter.getAttempt({ sessionID: attempt.sessionID, generation: attempt.generation }))?.state).toBe("completed")

      yield* sessions.remove(origin.id)
      expect((yield* sessions.get(root.sessionID)).id).toBe(root.sessionID)
    }),
  )
})
