import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { Session } from "@/session/session"
import { Workflow } from "@/session/workflow"
import { WorkflowPlan } from "@/session/workflow-plan"
import * as WorkflowScheduler from "@/session/workflow-scheduler"
import * as WorkflowService from "@/session/workflow-service"
import { testEffect } from "../lib/effect"

const phase = (id: string, ordinal: number, taskIDs: string[]) => ({
  id,
  ordinal,
  name: id,
  barrier: { kind: "all" as const },
  taskIDs,
})

const task = (id: string, phaseID: string, dependsOn: string[] = [], kind: "agent" | "synthesize" | "verify" = "agent") => ({
  id,
  phaseID,
  name: id,
  kind,
  prompt: `Execute ${id}`,
  dependsOn,
  output: { kind: "text" as const },
})

const graph = () => {
  const investigators = Array.from({ length: 8 }, (_, index) => `investigator_${index + 1}`)
  const verifiers = Array.from({ length: 6 }, (_, index) => `verifier_${index + 1}`)
  const tasks = [
    ...investigators.map((id) => task(id, "research")),
    task("draft", "draft", investigators, "synthesize"),
    ...verifiers.map((id) => task(id, "verify", ["draft"], "verify")),
    task("final", "final", verifiers, "synthesize"),
  ]
  const plan = {
    formatVersion: 1,
    name: "Scheduler graph",
    description: "DAG scheduler test",
    objective: "Exercise phase barriers",
    phases: [
      phase("research", 1, investigators),
      phase("draft", 2, ["draft"]),
      phase("verify", 3, verifiers),
      phase("final", 4, ["final"]),
    ],
    tasks,
    finalTaskID: "final",
    completionCriteria: ["The final synthesis is complete"],
    requiredGates: [],
    budget: { maxConcurrency: 8, maxFanOut: 16 },
  }
  return plan as unknown as WorkflowPlan
}

const retryGraph = () => {
  const plan = {
    formatVersion: 1,
    name: "Retry scheduler graph",
    description: "Scheduler retry test",
    objective: "Exercise durable retry readiness",
    phases: [
      phase("work", 1, ["work"]),
      phase("final", 2, ["final"]),
    ],
    tasks: [
      {
        ...task("work", "work"),
        retry: { maxAttempts: 2, backoffMs: 60_000, retryOn: ["environment"] as const },
      },
      task("final", "final", ["work"], "synthesize"),
    ],
    finalTaskID: "final",
    completionCriteria: ["The final synthesis is complete"],
    requiredGates: [],
    budget: { maxConcurrency: 1, maxFanOut: 2 },
  }
  return plan as unknown as WorkflowPlan
}

describe("workflow scheduler readiness", () => {
  test("keeps dependencies and phase barriers strict while honoring concurrency", () => {
    const first = WorkflowScheduler.readyTaskIDs({
      phases: [
        { id: "research", ordinal: 1, taskIDs: ["a", "b"], barrier: { kind: "all" }, state: "pending" },
        { id: "draft", ordinal: 2, taskIDs: ["c"], barrier: { kind: "all" }, state: "pending" },
      ],
      tasks: [
        { id: "a", phaseID: "research", dependsOn: [], state: "pending" },
        { id: "b", phaseID: "research", dependsOn: [], state: "pending" },
        { id: "c", phaseID: "draft", dependsOn: ["a", "b"], state: "pending" },
      ],
      maxConcurrency: 1,
    })
    expect(first).toEqual(["a"])

    const afterResearch = WorkflowScheduler.readyTaskIDs({
      phases: [
        { id: "research", ordinal: 1, taskIDs: ["a", "b"], barrier: { kind: "all" }, state: "completed" },
        { id: "draft", ordinal: 2, taskIDs: ["c"], barrier: { kind: "all" }, state: "pending" },
      ],
      tasks: [
        { id: "a", phaseID: "research", dependsOn: [], state: "completed" },
        { id: "b", phaseID: "research", dependsOn: [], state: "completed" },
        { id: "c", phaseID: "draft", dependsOn: ["a", "b"], state: "pending" },
      ],
      maxConcurrency: 2,
    })
    expect(afterResearch).toEqual(["c"])
  })
})

const schedulerLayer = WorkflowScheduler.layer.pipe(Layer.provideMerge(WorkflowService.defaultLayer))
const it = testEffect(Layer.mergeAll(Session.defaultLayer, schedulerLayer))

describe("workflow scheduler persistence", () => {
  it.instance("blocks before claiming work when the run token budget is exhausted", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workflow = yield* WorkflowService.Service
      const scheduler = yield* WorkflowScheduler.Service
      const origin = yield* sessions.create({ title: "Origin" })
      const started = yield* workflow.start({
        plan: {
          formatVersion: 1,
          name: "Token budget",
          description: "Run budget test",
          objective: "Stop before scheduling over budget",
          phases: [phase("work", 1, ["work"]), phase("final", 2, ["final"])],
          tasks: [task("work", "work"), task("final", "final", ["work"], "synthesize")],
          finalTaskID: "final",
          completionCriteria: ["The final task is complete"],
          requiredGates: [],
          budget: { maxConcurrency: 1, maxFanOut: 2, maxTokens: 0 },
        } as unknown as WorkflowPlan,
        originSessionID: origin.id,
      })

      const tick = yield* scheduler.tick(started.run.id)
      expect(tick.claimed).toHaveLength(0)
      expect(tick.state).toBe("blocked")
      expect((yield* workflow.show(started.run.id)).run.state).toBe("blocked")
      expect((yield* workflow.events(started.run.id)).some((event) => event.title === "Workflow budget exhausted")).toBe(true)
    }),
  )

  it.instance("blocks the run when a task exceeds its own token budget", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workflow = yield* WorkflowService.Service
      const scheduler = yield* WorkflowScheduler.Service
      const origin = yield* sessions.create({ title: "Origin" })
      const started = yield* workflow.start({
        plan: {
          formatVersion: 1,
          name: "Task token budget",
          description: "Task budget test",
          objective: "Block the run when a task exceeds its limit",
          phases: [phase("work", 1, ["work"]), phase("final", 2, ["final"])],
          tasks: [{ ...task("work", "work"), budget: { maxTokens: 1 } }, task("final", "final", ["work"], "synthesize")],
          finalTaskID: "final",
          completionCriteria: ["The final task is complete"],
          requiredGates: [],
          budget: { maxConcurrency: 1, maxFanOut: 2 },
        } as unknown as WorkflowPlan,
        originSessionID: origin.id,
      })
      const claim = (yield* scheduler.tick(started.run.id)).claimed[0]
      if (!claim) throw new Error("Expected a task claim")

      yield* scheduler.markStarted({
        runID: claim.runID,
        taskID: claim.taskID,
        attemptID: claim.attemptID,
        backgroundTaskID: `ses_${claim.taskID}`,
        backgroundGeneration: 1,
      })
      yield* scheduler.finish({
        runID: claim.runID,
        taskID: claim.taskID,
        attemptID: claim.attemptID,
        attempt: claim.attempt,
        state: "completed",
        usage: { inputTokens: 2 },
      })

      const snapshot = yield* workflow.show(started.run.id)
      expect(snapshot.tasks.find((candidate) => candidate.id === claim.taskID)?.state).toBe("blocked")
      expect(snapshot.run.state).toBe("blocked")
      expect((yield* scheduler.tick(started.run.id)).claimed).toHaveLength(0)
    }),
  )

  it.instance("claims the investigator wave once and releases the next phase only after completion", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workflow = yield* WorkflowService.Service
      const scheduler = yield* WorkflowScheduler.Service
      const origin = yield* sessions.create({ title: "Origin" })
      const started = yield* workflow.start({ plan: graph(), originSessionID: origin.id })
      const complete = (claims: readonly WorkflowScheduler.WorkflowTaskClaim[]) =>
        Effect.forEach(
          claims,
          (claim) =>
            Effect.gen(function* () {
              yield* scheduler.markStarted({
                runID: claim.runID,
                taskID: claim.taskID,
                attemptID: claim.attemptID,
                backgroundTaskID: `ses_${claim.taskID}`,
                backgroundGeneration: 1,
              })
              yield* scheduler.finish({
                runID: claim.runID,
                taskID: claim.taskID,
                attemptID: claim.attemptID,
                attempt: claim.attempt,
                state: "completed",
                summary: `${claim.taskID} complete`,
              })
            }),
          { concurrency: 1, discard: true },
        )

      const first = yield* scheduler.tick(started.run.id)
      expect(first.state).toBe("working")
      expect(first.claimed).toHaveLength(8)
      expect((yield* scheduler.tick(started.run.id)).claimed).toHaveLength(0)

      yield* complete(first.claimed)

      const next = yield* scheduler.tick(started.run.id)
      expect(next.claimed.map((claim) => claim.taskID)).toEqual([Workflow.WorkflowTaskID.make("draft")])
      yield* complete(next.claimed)

      const verifiers = yield* scheduler.tick(started.run.id)
      expect(verifiers.claimed).toHaveLength(6)
      yield* complete(verifiers.claimed)

      const final = yield* scheduler.tick(started.run.id)
      expect(final.claimed.map((claim) => claim.taskID)).toEqual([Workflow.WorkflowTaskID.make("final")])
      yield* complete(final.claimed)

      expect((yield* workflow.show(started.run.id)).run.state).toBe("completed")
    }),
  )

  it.instance("keeps an explicitly stopped run terminal when an in-flight task finishes", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workflow = yield* WorkflowService.Service
      const scheduler = yield* WorkflowScheduler.Service
      const origin = yield* sessions.create({ title: "Origin" })
      const started = yield* workflow.start({ plan: graph(), originSessionID: origin.id })
      const claim = (yield* scheduler.tick(started.run.id)).claimed[0]
      if (!claim) throw new Error("Expected an investigator claim")

      yield* workflow.stop({ runID: started.run.id, reason: "operator stop", actor: "test" })
      yield* scheduler.finish({
        runID: claim.runID,
        taskID: claim.taskID,
        attemptID: claim.attemptID,
        attempt: claim.attempt,
        state: "completed",
        summary: "Finished after stop",
      })

      expect((yield* workflow.show(started.run.id)).run.state).toBe("stopped")
    }),
  )

  it.instance("persists retry backoff and exposes the next scheduler wake", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workflow = yield* WorkflowService.Service
      const scheduler = yield* WorkflowScheduler.Service
      const origin = yield* sessions.create({ title: "Origin" })
      const started = yield* workflow.start({ plan: retryGraph(), originSessionID: origin.id })
      const claim = (yield* scheduler.tick(started.run.id)).claimed[0]
      if (!claim) throw new Error("Expected a retryable task claim")

      yield* scheduler.markStarted({
        runID: claim.runID,
        taskID: claim.taskID,
        attemptID: claim.attemptID,
        backgroundTaskID: `ses_${claim.taskID}`,
        backgroundGeneration: 1,
      })
      yield* scheduler.finish({
        runID: claim.runID,
        taskID: claim.taskID,
        attemptID: claim.attemptID,
        attempt: claim.attempt,
        state: "failed",
        failureClass: "environment",
        error: "temporary failure",
      })

      const retry = yield* scheduler.tick(started.run.id)
      expect(retry.claimed).toHaveLength(0)
      expect(retry.nextWakeAt).toBeGreaterThan(Date.now())
      expect((yield* workflow.show(started.run.id)).tasks.find((task) => task.id === claim.taskID)?.state).toBe("pending")
    }),
  )
})
