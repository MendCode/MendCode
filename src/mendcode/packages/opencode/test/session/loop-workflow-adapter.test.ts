import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { LoopRunner } from "@/session/loop-runner"
import { LoopWorkflow, Service as LoopWorkflowService } from "@/session/loop"
import { SessionPrompt, type PromptInput } from "@/session/prompt"
import * as Session from "@/session/session"
import { WorkflowRunner } from "@/session/workflow-runner"
import { WorkflowService } from "@/session/workflow-service"
import { WorkflowDefinitionID, WorkflowRevisionID, WorkflowRunID, WorkflowTaskID, type WorkflowRun } from "@/session/workflow"
import type { WorkflowPlan } from "@/session/workflow-plan"
import { WithInstance } from "../../src/project/with-instance"
import { tmpdir } from "../fixture/fixture"

const finalTaskID = WorkflowTaskID.make("adapter-final")
const definitionID = WorkflowDefinitionID.make("adapter-definition")
const revisionID = WorkflowRevisionID.make("adapter-revision")

const plan: WorkflowPlan = {
  formatVersion: 1,
  name: "Loop adapter workflow",
  description: "A workflow used by the loop adapter test.",
  objective: "Complete the adapter test workflow.",
  phases: [],
  tasks: [],
  finalTaskID,
  completionCriteria: ["the workflow run completes"],
  requiredGates: [],
}

function snapshot(state: WorkflowRun["state"], runID: WorkflowRunID, loopRunID?: string): WorkflowService.WorkflowSnapshot {
  return {
    definition: {
      id: definitionID,
      projectID: "project_test",
      name: plan.name,
      description: plan.description,
      source: "manual",
      saved: false,
      createdAt: 1,
      updatedAt: 1,
    },
    revision: {
      id: revisionID,
      definitionID,
      revision: 1,
      plan,
      planHash: "adapter-test",
      immutable: true,
      createdAt: 1,
    },
    run: {
      id: runID,
      definitionID,
      revisionID,
      revision: 1,
      state,
      ...(loopRunID === undefined ? {} : { loopRunID }),
      createdAt: 1,
      updatedAt: 1,
    },
    preview: {
      phaseCount: 0,
      taskCount: 0,
      taskUpperBound: 0,
      maxConcurrency: 1,
      maxFanOut: 1,
      sideEffectClasses: [],
    },
    phases: [],
    tasks: [],
    artifacts: [],
    events: [],
    gates: [],
  }
}

function promptLayer() {
  const message = {
    info: {
      id: "msg_adapter_test" as never,
      sessionID: "ses_adapter_test" as never,
      role: "assistant" as const,
      time: { created: Date.now() },
      parentID: "msg_parent" as never,
      modelID: "adapter-model" as never,
      providerID: "adapter-provider" as never,
      mode: "build" as const,
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [],
  }
  return Layer.succeed(
    SessionPrompt.Service,
    SessionPrompt.Service.of({
      cancel: () => Effect.void,
      cancelQueued: () => Effect.succeed(false),
      interrupt: () => Effect.void,
      prompt: (_input: PromptInput) => Effect.succeed(message),
      promptAsync: (_input: PromptInput) => Effect.succeed(message),
      loop: () => Effect.succeed(message),
      shell: () => Effect.succeed(message),
      command: () => Effect.succeed(message),
      resolvePromptParts: () => Effect.succeed([]),
    }),
  )
}

function unused(..._args: readonly unknown[]) {
  return Effect.die("unused workflow service method")
}

function adapterLayers(input: {
  start: (input: WorkflowService.WorkflowStartInput) => Effect.Effect<WorkflowService.WorkflowSnapshot, never>
  show: (runID: WorkflowRunID) => Effect.Effect<WorkflowService.WorkflowSnapshot, never>
  runner: (runID: string) => Effect.Effect<void, never>
}) {
  return Layer.mergeAll(
    LoopWorkflow.defaultLayer,
    LoopRunner.defaultLayer,
    Session.defaultLayer,
    promptLayer(),
    Layer.succeed(
      WorkflowService.Service,
      WorkflowService.Service.of({
        preview: unused,
        save: unused,
        start: input.start,
        list: unused,
        show: input.show,
        remove: unused,
        setWorkspaceLease: unused,
        events: unused,
        artifacts: unused,
        pause: unused,
        resume: unused,
        stop: unused,
        retryTask: unused,
        retryPhase: unused,
      }),
    ),
    Layer.succeed(
      WorkflowRunner.Service,
      WorkflowRunner.Service.of({
        start: () => Effect.void,
        run: input.runner,
        stop: () => Effect.void,
      }),
    ),
  )
}

function runLoop<A, E>(effect: Effect.Effect<A, E, LoopWorkflowService>) {
  return Effect.runPromise(effect.pipe(Effect.provide(LoopWorkflow.defaultLayer)))
}

describe("loop workflow adapter", () => {
  test("starts a referenced workflow and maps its completed result", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await runLoop(
          LoopWorkflowService.use((loop) =>
            loop.createDraft({
              name: "Referenced workflow loop",
              objective: "Run the saved workflow.",
              workflow: { revisionID },
            }),
          ),
        )
        await runLoop(LoopWorkflowService.use((loop) => loop.activate({ id: draft.id, reason: "adapter test" })))

        let startInput: WorkflowService.WorkflowStartInput | undefined
        let executedRunID: string | undefined
        const result = await Effect.runPromise(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })).pipe(
            Effect.provide(
              adapterLayers({
                start: (input) =>
                  Effect.sync(() => {
                    startInput = input
                    return snapshot("queued", WorkflowRunID.make("adapter-run"), input.loopRunID)
                  }),
                show: (runID) => Effect.succeed(snapshot("completed", runID, startInput?.loopRunID)),
                runner: (runID) =>
                  Effect.sync(() => {
                    executedRunID = runID
                  }),
              }),
            ),
          ),
        )

        expect(result.state).toBe("completed")
        expect(startInput).toMatchObject({
          revisionID,
          loopID: draft.id,
          overlapKey: `${draft.id}:${result.runID}`,
        })
        expect(startInput?.originSessionID).toBeDefined()
        expect(startInput?.loopRunID).toBe(result.runID)
        expect(executedRunID).toBeDefined()
        expect((await runLoop(LoopWorkflowService.use((loop) => loop.get(draft.id)))).metrics.turns).toBe(1)
      },
    })
  })

  test("skips an overlapping referenced workflow without running it", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await runLoop(
          LoopWorkflowService.use((loop) =>
            loop.createDraft({
              name: "Overlapping workflow loop",
              objective: "Do not duplicate the workflow.",
              workflow: { revisionID, overlapKey: "shared-workflow" },
            }),
          ),
        )
        await runLoop(LoopWorkflowService.use((loop) => loop.activate({ id: draft.id, reason: "adapter overlap test" })))

        let runnerCalls = 0
        const result = await Effect.runPromise(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })).pipe(
            Effect.provide(
              adapterLayers({
                start: (input) => Effect.succeed(snapshot("queued", WorkflowRunID.make("existing-run"), "another-loop-run")),
                show: (runID) => Effect.succeed(snapshot("completed", runID)),
                runner: () =>
                  Effect.sync(() => {
                    runnerCalls++
                  }),
              }),
            ),
          ),
        )

        expect(result.state).toBe("skipped")
        expect(result.summary).toContain("overlap")
        expect(runnerCalls).toBe(0)
      },
    })
  })
})
