import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"

import { Bus } from "@/bus"
import { Database, eq } from "@/storage/db"
import { BackgroundTask } from "@/session/background-task"
import { BackgroundTaskEventTable, BackgroundTaskRunTable } from "@/session/background-task.sql"
import { MessageV2 } from "@/session/message-v2"
import { markPermissionAbandoned, markPermissionPending, reconcilePermissionAbandonment } from "@/session/pending-input"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { PermissionTable, WorkflowTaskAttemptTable, WorkflowRunTable } from "@/session/session.sql"
import { isTransientWorkflowError, Workflow } from "@/session/workflow"
import { WorkflowBackgroundTask } from "@/session/workflow-background-task"
import { WorkflowPlan } from "@/session/workflow-plan"
import { WorkflowRunner } from "@/session/workflow-runner"
import * as WorkflowScheduler from "@/session/workflow-scheduler"
import * as WorkflowService from "@/session/workflow-service"
import { WorkflowTaskExecutor } from "@/session/workflow-task-executor"
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

const transientGraph = () => {
  const plan = retryGraph()
  return {
    ...plan,
    name: "Default transient retry graph",
    tasks: [task("work", "work"), task("final", "final", ["work"], "synthesize")],
  } as unknown as WorkflowPlan
}

describe("workflow scheduler readiness", () => {
  test("recognizes restart and network failures as transient", () => {
    expect(isTransientWorkflowError("Runtime lease expired")).toBe(true)
    expect(isTransientWorkflowError("worker process exited before the task completed")).toBe(true)
    expect(isTransientWorkflowError("network request failed")).toBe(true)
    expect(isTransientWorkflowError("invalid workflow plan")).toBe(false)
  })

  test("recovers only runnable workflow states after a process restart", () => {
    expect(WorkflowRunner.shouldRecoverWorkflowRun("queued")).toBe(true)
    expect(WorkflowRunner.shouldRecoverWorkflowRun("working")).toBe(true)
    expect(WorkflowRunner.shouldRecoverWorkflowRun("awaiting_approval")).toBe(false)
    expect(WorkflowRunner.shouldRecoverWorkflowRun("paused")).toBe(false)
    expect(WorkflowRunner.shouldRecoverWorkflowRun("needs_input")).toBe(false)
    expect(WorkflowRunner.shouldRecoverWorkflowRun("blocked")).toBe(false)
    expect(WorkflowRunner.shouldRecoverWorkflowRun("completed")).toBe(false)
    expect(WorkflowRunner.shouldRecoverWorkflowRun("failed")).toBe(false)
    expect(WorkflowRunner.shouldRecoverWorkflowRun("stopped")).toBe(false)
  })

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

const bus = Bus.layer
const workflowLayer = WorkflowService.layer.pipe(Layer.provide(bus))
const schedulerLayer = WorkflowScheduler.layer.pipe(Layer.provideMerge(workflowLayer))
const it = testEffect(Layer.mergeAll(Session.defaultLayer, schedulerLayer, bus))
const unused = () => Effect.die("unused workflow recovery dependency")
const recoveryDeps = Layer.mergeAll(
  Session.defaultLayer,
  schedulerLayer,
  bus,
  Layer.succeed(
    WorkflowBackgroundTask.Service,
    WorkflowBackgroundTask.Service.of({
      ensureRoot: unused,
      startAttempt: unused,
      getAttempt: () => Effect.succeed(undefined),
      listChildren: () => Effect.succeed([]),
      finishAttempt: unused,
      cancelAttempt: () => Effect.succeed(undefined),
    }),
  ),
  Layer.succeed(WorkflowTaskExecutor.Service, WorkflowTaskExecutor.Service.of({ execute: unused })),
)
const recoveryRunnerLayer = WorkflowRunner.layer.pipe(Layer.provideMerge(recoveryDeps))
const recoveryIt = testEffect(Layer.mergeAll(recoveryDeps, recoveryRunnerLayer))
const backgroundLayer = BackgroundTask.layer.pipe(Layer.provideMerge(bus))
const permissionIt = testEffect(Layer.mergeAll(Session.defaultLayer, schedulerLayer, backgroundLayer, bus))

describe("workflow scheduler persistence", () => {
  recoveryIt.instance("finishes a working attempt from its persisted terminal assistant", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workflow = yield* WorkflowService.Service
      const scheduler = yield* WorkflowScheduler.Service
      const runner = yield* WorkflowRunner.Service
      const origin = yield* sessions.create({ title: "Origin" })
      const started = yield* workflow.start({
        originSessionID: origin.id,
        plan: {
          formatVersion: 1,
          name: "Recovery graph",
          description: "Recover a terminal assistant",
          objective: "Complete the persisted task",
          phases: [phase("final", 1, ["final"])],
          tasks: [task("final", "final", [], "synthesize")],
          finalTaskID: "final",
          completionCriteria: ["Recovered"],
          requiredGates: [],
        } as unknown as WorkflowPlan,
      })
      const claim = (yield* scheduler.tick(started.run.id)).claimed[0]
      if (!claim) throw new Error("Expected a recovery claim")
      const child = yield* sessions.create({ parentID: origin.id, title: "Recovered child" })
      yield* scheduler.markStarted({
        runID: claim.runID,
        taskID: claim.taskID,
        attemptID: claim.attemptID,
        backgroundTaskID: child.id,
        backgroundGeneration: 1,
      })
      const messageID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: child.id,
        role: "assistant",
        parentID: MessageID.ascending(),
        mode: "build",
        agent: "build",
        modelID: "test-model" as never,
        providerID: "test-provider" as never,
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
        time: { created: Date.now(), completed: Date.now() },
      } satisfies MessageV2.Assistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: child.id,
        messageID,
        type: "text",
        text: "Persisted task result",
      } satisfies MessageV2.TextPart)

      yield* runner.wake(started.run.id)
      yield* Effect.sleep("25 millis")

      const recovered = yield* workflow.show(started.run.id)
      expect(recovered.tasks[0]).toMatchObject({ state: "completed" })
      expect(recovered.run.state).toBe("completed")
    }),
  )

  recoveryIt.instance("fails a completed assistant that has no finish reason", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workflow = yield* WorkflowService.Service
      const scheduler = yield* WorkflowScheduler.Service
      const runner = yield* WorkflowRunner.Service
      const origin = yield* sessions.create({ title: "Origin" })
      const started = yield* workflow.start({
        originSessionID: origin.id,
        plan: {
          formatVersion: 1,
          name: "Interrupted recovery graph",
          description: "Recover a completed assistant without finish metadata",
          objective: "Fail the interrupted task",
          phases: [phase("final", 1, ["final"])],
          tasks: [task("final", "final", [], "synthesize")],
          finalTaskID: "final",
          completionCriteria: ["Interrupted task is classified"],
          requiredGates: [],
        } as unknown as WorkflowPlan,
      })
      const claim = (yield* scheduler.tick(started.run.id)).claimed[0]
      if (!claim) throw new Error("Expected a recovery claim")
      const child = yield* sessions.create({ parentID: origin.id, title: "Interrupted child" })
      yield* scheduler.markStarted({
        runID: claim.runID,
        taskID: claim.taskID,
        attemptID: claim.attemptID,
        backgroundTaskID: child.id,
        backgroundGeneration: 1,
      })
      const messageID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: child.id,
        role: "assistant",
        parentID: MessageID.ascending(),
        mode: "build",
        agent: "build",
        modelID: "test-model" as never,
        providerID: "test-provider" as never,
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now(), completed: Date.now() },
      } satisfies MessageV2.Assistant)

      yield* runner.run(started.run.id)

      const recovered = yield* workflow.show(started.run.id)
      expect(recovered.tasks[0]).toMatchObject({ state: "failed" })
      expect(recovered.run.state).toBe("failed")
    }),
  )

  permissionIt.instance("fails an abandoned permission atomically and idempotently", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workflow = yield* WorkflowService.Service
      const scheduler = yield* WorkflowScheduler.Service
      const background = yield* BackgroundTask.Service
      const origin = yield* sessions.create({ title: "Origin" })
      const child = yield* sessions.create({ parentID: origin.id, title: "Permission child" })
      const started = yield* workflow.start({
        originSessionID: origin.id,
        plan: {
          formatVersion: 1,
          name: "Permission abandonment graph",
          description: "Fail an attempt whose permission owner disappeared",
          objective: "Persist one coherent terminal transition",
          phases: [phase("final", 1, ["final"])],
          tasks: [task("final", "final", [], "synthesize")],
          finalTaskID: "final",
          completionCriteria: ["Permission abandonment is terminal"],
          requiredGates: [],
        } as unknown as WorkflowPlan,
      })
      const claim = (yield* scheduler.tick(started.run.id)).claimed[0]
      if (!claim) throw new Error("Expected a permission claim")
      const attempt = yield* background.start({
        taskID: child.id,
        parentSessionID: origin.id,
        title: "Permission child",
      })
      yield* background.markRunning({ taskID: child.id, generation: attempt.generation })
      yield* scheduler.markStarted({
        runID: claim.runID,
        taskID: claim.taskID,
        attemptID: claim.attemptID,
        backgroundTaskID: child.id,
        backgroundGeneration: attempt.generation,
      })

      markPermissionPending({ sessionID: child.id, permission: "bash", patterns: ["git status"] }, 0)
      yield* Effect.sleep("10 millis")
      expect((yield* workflow.show(started.run.id)).run.state).toBe("needs_input")

      markPermissionAbandoned(child.id)
      markPermissionAbandoned(child.id)

      const failed = yield* workflow.show(started.run.id)
      expect(failed.run.state).toBe("failed")
      expect(failed.tasks[0]).toMatchObject({ state: "failed" })
      const persistedAttempt = Database.use((db) =>
        db.select().from(WorkflowTaskAttemptTable).where(eq(WorkflowTaskAttemptTable.id, claim.attemptID)).get(),
      )
      expect(persistedAttempt).toMatchObject({
        state: "failed",
        reason: WorkflowService.WORKFLOW_PERMISSION_ABANDONED_REASON,
        background_generation: attempt.generation,
      })
      const persistedBackground = Database.use((db) =>
        db.select().from(BackgroundTaskRunTable).where(eq(BackgroundTaskRunTable.task_id, child.id)).get(),
      )
      expect(persistedBackground).toMatchObject({
        state: "interrupted",
        result: { summary: WorkflowService.WORKFLOW_PERMISSION_ABANDONED_REASON },
      })
      expect(failed.events.filter((event) => event.type === "workflow.run.failed")).toHaveLength(1)
      expect(
        Database.use((db) =>
          db
            .select()
            .from(BackgroundTaskEventTable)
            .where(eq(BackgroundTaskEventTable.task_id, child.id))
            .all()
            .filter((event) => event.type === "interrupted"),
        ),
      ).toHaveLength(1)
    }),
  )

  permissionIt.instance("repairs only a legacy abandonment without a live permission", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workflow = yield* WorkflowService.Service
      const scheduler = yield* WorkflowScheduler.Service
      const background = yield* BackgroundTask.Service
      const origin = yield* sessions.create({ title: "Origin" })
      const child = yield* sessions.create({ parentID: origin.id, title: "Legacy permission child" })
      const started = yield* workflow.start({
        originSessionID: origin.id,
        plan: {
          formatVersion: 1,
          name: "Legacy abandonment graph",
          description: "Repair a durable needs-input attempt",
          objective: "Fail only verified abandoned input",
          phases: [phase("final", 1, ["final"])],
          tasks: [task("final", "final", [], "synthesize")],
          finalTaskID: "final",
          completionCriteria: ["Legacy abandonment is repaired"],
          requiredGates: [],
        } as unknown as WorkflowPlan,
      })
      const claim = (yield* scheduler.tick(started.run.id)).claimed[0]
      if (!claim) throw new Error("Expected a legacy permission claim")
      const attempt = yield* background.start({
        taskID: child.id,
        parentSessionID: origin.id,
        title: "Legacy permission child",
      })
      yield* background.markRunning({ taskID: child.id, generation: attempt.generation })
      yield* scheduler.markStarted({
        runID: claim.runID,
        taskID: claim.taskID,
        attemptID: claim.attemptID,
        backgroundTaskID: child.id,
        backgroundGeneration: attempt.generation,
      })
      markPermissionPending({ sessionID: child.id, permission: "bash", patterns: ["git status"] }, 0)
      yield* Effect.sleep("10 millis")

      const now = Date.now()
      Database.use((db) => {
        const run = db.select().from(BackgroundTaskRunTable).where(eq(BackgroundTaskRunTable.task_id, child.id)).get()
        if (!run) throw new Error("Expected a background run")
        db.update(BackgroundTaskRunTable)
          .set({
            state: "interrupted",
            revision: run.revision + 1,
            owner_runtime_id: null,
            lease_expires_at: null,
            time_finished: now,
            time_updated: now,
            result: {
              summary: WorkflowService.WORKFLOW_PERMISSION_ABANDONED_REASON,
              error: "Permission owner stopped before replying",
              changedFiles: [],
              transcriptSessionID: child.id,
            },
          })
          .where(eq(BackgroundTaskRunTable.task_id, child.id))
          .run()
        db.insert(PermissionTable)
          .values({
            project_id: origin.projectID,
            time_created: now,
            time_updated: now,
            data: {
              version: 2,
              approved: [],
              requests: [
                {
                  info: {
                    id: "per_live" as never,
                    sessionID: child.id,
                    permission: "bash",
                    patterns: ["git status"],
                    metadata: {},
                    always: [],
                  },
                  ownerRuntimeID: `permission:${process.pid}:test`,
                  directory: "/tmp",
                  timeCreated: now,
                  timeUpdated: now,
                },
              ],
            },
          })
          .run()
      })

      reconcilePermissionAbandonment(child.id)
      expect((yield* workflow.show(started.run.id)).run.state).toBe("needs_input")

      Database.use((db) =>
        db.update(PermissionTable)
          .set({ time_updated: Date.now(), data: { version: 2, approved: [], requests: [] } })
          .where(eq(PermissionTable.project_id, origin.projectID))
          .run(),
      )
      reconcilePermissionAbandonment(child.id)
      reconcilePermissionAbandonment(child.id)

      const repaired = yield* workflow.show(started.run.id)
      expect(repaired.run.state).toBe("failed")
      expect(repaired.tasks[0]?.blocker).toBe(WorkflowService.WORKFLOW_PERMISSION_ABANDONED_REASON)
      expect(repaired.events.filter((event) => event.type === "workflow.run.failed")).toHaveLength(1)
    }),
  )

  it.instance("persists and clears the workflow session permission override independently", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workflow = yield* WorkflowService.Service
      const origin = yield* sessions.create({ title: "Origin" })
      const started = yield* workflow.start({ plan: graph(), originSessionID: origin.id })

      const overridden = yield* workflow.setPermissionMode({
        runID: started.run.id,
        sessionMode: "smart",
        actor: "test",
      })
      expect(overridden.run.permissionMode).toBe(started.run.permissionMode)
      expect(overridden.run.sessionPermissionMode).toBe("smart")

      const inherited = yield* workflow.setPermissionMode({
        runID: started.run.id,
        sessionMode: null,
        actor: "test",
      })
      expect(inherited.run.permissionMode).toBe(started.run.permissionMode)
      expect(inherited.run.sessionPermissionMode).toBeUndefined()
    }),
  )

  it.instance("rejects retry shortcuts for pending tasks and phases", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workflow = yield* WorkflowService.Service
      const origin = yield* sessions.create({ title: "Origin" })
      const started = yield* workflow.start({ plan: graph(), originSessionID: origin.id })

      const taskRetry = yield* workflow.retryTask({
        runID: started.run.id,
        taskID: Workflow.WorkflowTaskID.make("investigator_1"),
        actor: "test",
      }).pipe(Effect.exit)
      const phaseRetry = yield* workflow.retryPhase({
        runID: started.run.id,
        phaseID: Workflow.WorkflowPhaseID.make("research"),
        actor: "test",
      }).pipe(Effect.exit)

      expect(Exit.isFailure(taskRetry)).toBe(true)
      expect(Exit.isFailure(phaseRetry)).toBe(true)
      expect((yield* workflow.events(started.run.id)).filter((event) => event.title.includes("retry queued"))).toEqual([])
    }),
  )

  it.instance("publishes runner wakes when retrying a task or phase", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workflow = yield* WorkflowService.Service
      const scheduler = yield* WorkflowScheduler.Service
      const bus = yield* Bus.Service
      const origin = yield* sessions.create({ title: "Origin" })
      const started = yield* workflow.start({ plan: retryGraph(), originSessionID: origin.id })
      const claim = (yield* scheduler.tick(started.run.id)).claimed[0]
      if (!claim) throw new Error("Expected a workflow task claim")

      yield* scheduler.finish({
        runID: claim.runID,
        taskID: claim.taskID,
        attemptID: claim.attemptID,
        attempt: claim.attempt,
        state: "failed",
        failureClass: "permanent",
        error: "permanent failure",
      })

      const wakes: string[] = []
      const unsubscribe = yield* bus.subscribeCallback(WorkflowService.Event.RunWake, (event) => {
        wakes.push(event.properties.runID)
      })
      try {
        const taskRetry = yield* workflow.retryTask({
          runID: started.run.id,
          taskID: claim.taskID,
          actor: "test",
        })
        expect(taskRetry.run.state).toBe("queued")
        expect(taskRetry.tasks.find((task) => task.id === claim.taskID)?.state).toBe("pending")

        const phaseRetry = yield* workflow.retryPhase({
          runID: started.run.id,
          phaseID: Workflow.WorkflowPhaseID.make("work"),
          actor: "test",
        })
        expect(phaseRetry.run.state).toBe("queued")
        expect(phaseRetry.phases.find((phase) => phase.id === "work")?.state).toBe("pending")
        yield* Effect.sleep("10 millis")
      } finally {
        unsubscribe()
      }

      expect(wakes).toEqual([started.run.id, started.run.id])
    }),
  )

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
      expect((yield* workflow.show(started.run.id)).tasks.find((candidate) => candidate.id === claim.taskID)?.sessionID).toBe(
        SessionID.make(`ses_${claim.taskID}`),
      )
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
      const notifications = yield* workflow.pendingNotifications(origin.id)
      expect(notifications).toMatchObject([
        {
          parentSessionID: origin.id,
          runID: started.run.id,
          state: "completed",
          title: "Scheduler graph",
          background: true,
        },
      ])
      yield* workflow.acknowledgeNotifications(notifications.map((notification) => notification.eventID))
      expect(yield* workflow.pendingNotifications(origin.id)).toEqual([])
    }),
  )

  it.instance("publishes a runner wake when a task session unlocks downstream work", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workflow = yield* WorkflowService.Service
      const scheduler = yield* WorkflowScheduler.Service
      const bus = yield* Bus.Service
      const origin = yield* sessions.create({ title: "Origin" })
      const started = yield* workflow.start({ plan: retryGraph(), originSessionID: origin.id })
      const claim = (yield* scheduler.tick(started.run.id)).claimed[0]
      if (!claim) throw new Error("Expected a workflow task claim")

      const taskSessionID = SessionID.make(`ses_${started.run.id}_${claim.taskID}`)
      yield* scheduler.markStarted({
        runID: claim.runID,
        taskID: claim.taskID,
        attemptID: claim.attemptID,
        backgroundTaskID: taskSessionID,
        backgroundGeneration: 1,
      })

      const startedSnapshot = yield* workflow.show(started.run.id)
      expect(startedSnapshot.tasks.find((task) => task.id === claim.taskID)?.sessionID).toBe(taskSessionID)
      let resumeWakeRunID: string | undefined
      const unsubscribeResume = yield* bus.subscribeCallback(WorkflowService.Event.RunWake, (event) => {
        resumeWakeRunID = event.properties.runID
      })
      try {
        expect((yield* workflow.resume({ runID: started.run.id, actor: "test" })).run.state).toBe("working")
        yield* Effect.sleep("10 millis")
      } finally {
        unsubscribeResume()
      }
      expect(resumeWakeRunID).toBe(started.run.id)
      expect(yield* workflow.resumeTaskSession({ sessionID: taskSessionID })).toMatchObject({
        runID: started.run.id,
        taskID: claim.taskID,
        attemptID: claim.attemptID,
        backgroundGeneration: 1,
        runnerManaged: true,
      })
      expect(yield* workflow.resumeTaskSession({ sessionID: taskSessionID, backgroundGeneration: 2 })).toMatchObject({
        runID: started.run.id,
        taskID: claim.taskID,
        attemptID: claim.attemptID,
        attempt: claim.attempt,
        backgroundGeneration: 2,
      })

      let wakeRunID: string | undefined
      const unsubscribe = yield* bus.subscribeCallback(WorkflowService.Event.RunWake, (event) => {
        wakeRunID = event.properties.runID
      })
      try {
        yield* workflow.finishTaskSession({
          sessionID: taskSessionID,
          backgroundGeneration: 2,
          state: "completed",
          summary: "Task completed",
        })
        yield* Effect.sleep("10 millis")
      } finally {
        unsubscribe()
      }

      const after = yield* workflow.show(started.run.id)
      expect(after.tasks.find((task) => task.id === claim.taskID)?.state).toBe("completed")
      expect(after.run.state).toBe("queued")
      expect(wakeRunID).toBe(started.run.id)
    }),
  )

  it.instance("publishes a pure runner wake without resuming a paused workflow", () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowService.Service
      const bus = yield* Bus.Service
      const started = yield* workflow.start({ plan: retryGraph() })
      yield* workflow.pause({ runID: started.run.id, actor: "test" })

      let wakeRunID: string | undefined
      const unsubscribe = yield* bus.subscribeCallback(WorkflowService.Event.RunWake, (event) => {
        wakeRunID = event.properties.runID
      })
      try {
        yield* workflow.wake(started.run.id)
        yield* Effect.sleep("10 millis")
      } finally {
        unsubscribe()
      }

      expect(wakeRunID).toBe(started.run.id)
      expect((yield* workflow.show(started.run.id)).run.state).toBe("paused")
    }),
  )

  it.instance("reconciles a durable task session through the scheduler", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workflow = yield* WorkflowService.Service
      const scheduler = yield* WorkflowScheduler.Service
      const origin = yield* sessions.create({ title: "Origin" })
      const started = yield* workflow.start({ plan: retryGraph(), originSessionID: origin.id })
      const claim = (yield* scheduler.tick(started.run.id)).claimed[0]
      if (!claim) throw new Error("Expected a workflow task claim")
      const taskSessionID = SessionID.make(`ses_recovered_${claim.taskID}`)

      yield* scheduler.markStarted({
        runID: claim.runID,
        taskID: claim.taskID,
        attemptID: claim.attemptID,
        backgroundTaskID: taskSessionID,
        backgroundGeneration: 2,
      })
      yield* scheduler.finishSession({
        sessionID: taskSessionID,
        backgroundGeneration: 2,
        state: "completed",
        summary: "Recovered durable result",
      })

      const recovered = yield* workflow.show(started.run.id)
      expect(recovered.tasks.find((task) => task.id === claim.taskID)).toMatchObject({
        state: "completed",
      })
      expect(recovered.run.state).toBe("queued")
    }),
  )

  it.instance("returns the foreign lease expiry as the next scheduler wake", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workflow = yield* WorkflowService.Service
      const scheduler = yield* WorkflowScheduler.Service
      const origin = yield* sessions.create({ title: "Origin" })
      const started = yield* workflow.start({ plan: retryGraph(), originSessionID: origin.id })
      const leaseExpiresAt = Date.now() + 30_000
      Database.use((db) =>
        db
          .update(WorkflowRunTable)
          .set({ lease_holder: "foreign-runtime", lease_expires_at: leaseExpiresAt })
          .where(eq(WorkflowRunTable.id, started.run.id))
          .run(),
      )

      const tick = yield* scheduler.tick(started.run.id)
      expect(tick.claimed).toEqual([])
      expect(tick.nextWakeAt).toBe(leaseExpiresAt)
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

  it.instance("requeues a file-lock failure with the default transient recovery policy", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const workflow = yield* WorkflowService.Service
      const scheduler = yield* WorkflowScheduler.Service
      const origin = yield* sessions.create({ title: "Origin" })
      const started = yield* workflow.start({ plan: transientGraph(), originSessionID: origin.id })
      const claim = (yield* scheduler.tick(started.run.id)).claimed[0]
      if (!claim) throw new Error("Expected a transient task claim")

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
        failureClass: "transient",
        error: "file is locked; retry when the workspace is available",
      })

      const snapshot = yield* workflow.show(started.run.id)
      expect(snapshot.tasks.find((item) => item.id === claim.taskID)?.state).toBe("pending")
      const retry = yield* scheduler.tick(started.run.id)
      expect(retry.claimed).toHaveLength(0)
      expect(retry.nextWakeAt).toBeGreaterThan(Date.now())
    }),
  )
})
