import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "@/storage/db"
import {
  defaultLayer as loopWorkflowLayer,
  LoopID,
  RunID,
  Service as LoopWorkflowService,
  type CreateDraftInput,
} from "@/session/loop"
import { LoopRunner } from "@/session/loop-runner"
import { SessionPrompt } from "@/session/prompt"
import * as Session from "@/session/session"
import { Database } from "@/storage/db"
import {
  BackgroundSessionTable,
  LoopRunTable,
  LoopThreadTable,
  LoopWorkflowTable,
  SessionTable,
  SessionStatusTable,
} from "@/session/session.sql"
import { WithInstance } from "../../src/project/with-instance"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

function run<A, E>(fx: Effect.Effect<A, E, LoopWorkflowService>) {
  return Effect.runPromise(fx.pipe(Effect.provide(loopWorkflowLayer)))
}

function runRunner<A, E>(
  fx: Effect.Effect<A, E, LoopRunner.Service | LoopWorkflowService | SessionPrompt.Service>,
  promptText?: string | ((call: number) => string),
) {
  let prompts = 0
  const promptCalls: any[] = []
  const promptLayer = Layer.succeed(
    SessionPrompt.Service,
    SessionPrompt.Service.of({
      cancel: () => Effect.void,
      prompt: (input: any) =>
        Effect.sync(() => {
          prompts++
          promptCalls.push(input)
          const text = typeof promptText === "function" ? promptText(prompts) : promptText
          return { info: {}, parts: text ? [{ type: "text", text }] : [] } as any
        }),
      loop: () => Effect.succeed({ info: {}, parts: [] } as any),
      shell: () => Effect.succeed({ info: {}, parts: [] } as any),
      command: () => Effect.succeed({ info: {}, parts: [] } as any),
      resolvePromptParts: () => Effect.succeed([]),
    }),
  )
  return Effect.runPromise(fx.pipe(Effect.provide(Layer.mergeAll(loopWorkflowLayer, LoopRunner.defaultLayer, promptLayer)))).then(
    (value) => ({ value, prompts, promptCalls }),
  )
}

const svc = {
  createDraft(input: CreateDraftInput) {
    return run(LoopWorkflowService.use((loop) => loop.createDraft(input)))
  },
  activate(id: LoopID) {
    return run(LoopWorkflowService.use((loop) => loop.activate({ id, reason: "test activate" })))
  },
  pause(id: LoopID) {
    return run(LoopWorkflowService.use((loop) => loop.pause({ id, reason: "test pause" })))
  },
  resume(id: LoopID) {
    return run(LoopWorkflowService.use((loop) => loop.resume({ id, reason: "test resume" })))
  },
  stop(id: LoopID) {
    return run(LoopWorkflowService.use((loop) => loop.stop({ id, reason: "test stop" })))
  },
  runOnce(id: LoopID) {
    return run(LoopWorkflowService.use((loop) => loop.runOnce({ id, reason: "test run once" })))
  },
  due(now?: number) {
    return run(LoopWorkflowService.use((loop) => loop.due({ now })))
  },
  startRun(id: LoopID) {
    return run(LoopWorkflowService.use((loop) => loop.startRun({ id, trigger: "interval", reason: "test start" })))
  },
  completeRun(id: LoopID, runID: RunID) {
    return run(LoopWorkflowService.use((loop) => loop.completeRun({ id, runID, reason: "test complete" })))
  },
  failRun(id: LoopID, runID: RunID) {
    return run(LoopWorkflowService.use((loop) => loop.failRun({ id, runID, error: "boom" })))
  },
  snapshot(id: LoopID) {
    return run(LoopWorkflowService.use((loop) => loop.snapshot(id)))
  },
}

afterEach(async () => {
  await disposeAllInstances()
})

describe("loop workflow service", () => {
  test("creates a reviewable draft without activating it", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "PR babysitter",
          objective: "Watch PR #123 and surface actionable feedback.",
          trigger: { mode: "interval", intervalMs: 60_000 },
        })

        expect(draft.state).toBe("draft")
        expect(draft.rootSessionID).toBeUndefined()
        expect(draft.policy.requireApprovalFor).toContain("push")
        expect(draft.policy.requireApprovalFor).toContain("merge")

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.events).toHaveLength(1)
        expect(snapshot.events[0]).toMatchObject({ type: "created", title: "Loop draft created" })
      },
    })
  })

  test("activates, records a root thread, and keeps monitor state durable", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Research watch",
          objective: "Check docs daily and report relevant changes.",
          trigger: { mode: "interval", intervalMs: 120_000 },
        })
        const active = await svc.activate(draft.id)

        expect(active.state).toBe("sleeping")
        expect(active.rootSessionID).toBeDefined()
        expect(active.nextWakeup).toBeLessThanOrEqual(Date.now())

        const run = await svc.runOnce(active.id)
        expect(run.state).toBe("completed")
        expect(run.trigger).toBe("run-once")

        Database.use((db) =>
          db
            .update(SessionTable)
            .set({ model: { providerID: "openai", id: "gpt-test-loop", variant: "medium" } })
            .where(eq(SessionTable.id, active.rootSessionID!))
            .run(),
        )

        const snapshot = await svc.snapshot(active.id)
        expect(snapshot.workflow.metrics.turns).toBe(1)
        expect(snapshot.rootSession?.model).toEqual({ providerID: "openai", modelID: "gpt-test-loop", variant: "medium" })
        expect(snapshot.threads).toHaveLength(1)
        expect(snapshot.threads[0]).toMatchObject({ role: "root", sessionID: active.rootSessionID })
        expect(snapshot.events.map((event) => event.type)).toEqual(["created", "activated", "wake"])
      },
    })
  })

  test("pause, resume, and stop are explicit workflow controls", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Daily maintenance",
          objective: "Summarize stale work every morning.",
        })

        const active = await svc.activate(draft.id)
        const paused = await svc.pause(draft.id)
        expect(paused.state).toBe("paused")

        const resumed = await svc.resume(draft.id)
        expect(resumed.state).toBe("active")

        const stopped = await svc.stop(draft.id)
        expect(stopped.state).toBe("stopped")

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.events.map((event) => event.type)).toEqual(["created", "activated", "paused", "resumed", "stopped"])
      },
    })
  })

  test("pause during a working run takes effect after the current iteration completes", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Mid-run pause",
          objective: "Pause after the active iteration settles.",
          trigger: { mode: "interval", intervalMs: 60_000 },
        })
        await svc.activate(draft.id)

        const started = await svc.startRun(draft.id)
        const paused = await svc.pause(draft.id)
        expect(paused.state).toBe("paused")

        const completed = await svc.completeRun(draft.id, started.id)
        expect(completed.state).toBe("completed")

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("paused")
        expect(snapshot.workflow.phase).toBe("paused")
        expect(snapshot.workflow.nextWakeup).toBeUndefined()
        expect(snapshot.workflow.metrics.turns).toBe(1)
        expect(snapshot.events.map((event) => event.type)).toEqual(["created", "activated", "started", "paused", "completed"])
        expect(snapshot.events.at(-1)?.summary).toBe("Loop paused after completing the current run.")
      },
    })
  })

  test("runner transitions mark due, working, completed, and failed state durably", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Build watch",
          objective: "Keep testing until green.",
          trigger: { mode: "interval", intervalMs: 60_000 },
        })
        const active = await svc.activate(draft.id)

        expect((await svc.due(Date.now())).map((item) => item.id)).toEqual([draft.id])
        expect((await svc.due((active.nextWakeup ?? 0) + 1)).map((item) => item.id)).toEqual([draft.id])

        const started = await svc.startRun(draft.id)
        expect(started.state).toBe("working")
        let snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("working")
        expect(snapshot.events.map((event) => event.type)).toContain("started")

        const completed = await svc.completeRun(draft.id, started.id)
        expect(completed.state).toBe("completed")
        snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.metrics.turns).toBe(1)
        expect(snapshot.workflow.state).toBe("sleeping")
        expect(snapshot.events.map((event) => event.type)).toContain("completed")

        const failedStart = await svc.startRun(draft.id)
        const failed = await svc.failRun(draft.id, failedStart.id)
        expect(failed.state).toBe("failed")
        snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("failed")
        expect(snapshot.workflow.metrics.failures).toBe(1)
      },
    })
  })

  test("completed runs stop the workflow when the iteration cap is reached", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Bounded watch",
          objective: "Run one checkpoint and stop.",
          policy: { maxTurns: 1 },
        })
        await svc.activate(draft.id)

        const started = await svc.startRun(draft.id)
        await svc.completeRun(draft.id, started.id)

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.metrics.turns).toBe(1)
        expect(snapshot.workflow.state).toBe("completed")
        expect(snapshot.workflow.phase).toBe("completed")
        expect(snapshot.workflow.nextWakeup).toBeUndefined()
      },
    })
  })

  test("existing over-budget active workflows are durably reconciled as completed", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Legacy overrun watch",
          objective: "Hydrate as completed after an old runner overran the cap.",
          policy: { maxTurns: 1 },
        })
        const active = await svc.activate(draft.id)
        const legacyRunID = RunID.make()
        Database.use((db) => {
          const row = db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, draft.id)).get()
          if (!row) throw new Error("missing loop row")
          db.update(LoopWorkflowTable)
            .set({
              state: "working",
              phase: "executing",
              next_wakeup: null,
              data: {
                ...row.data,
                metrics: { ...row.data.metrics, turns: 3 },
              },
            })
            .where(eq(LoopWorkflowTable.id, draft.id))
            .run()
          db.update(BackgroundSessionTable)
            .set({
              time_updated: Date.now(),
              data: { state: "working", summary: "Loop working: executing", pinned: true },
            })
            .where(eq(BackgroundSessionTable.session_id, active.rootSessionID!))
            .run()
          db.insert(SessionStatusTable)
            .values({
              session_id: active.rootSessionID!,
              time_created: Date.now(),
              time_updated: Date.now(),
              data: { type: "busy" },
            })
            .run()
          db.update(LoopThreadTable)
            .set({ state: "working" })
            .where(eq(LoopThreadTable.workflow_id, draft.id))
            .run()
          db.insert(LoopRunTable)
            .values({
              id: legacyRunID,
              workflow_id: draft.id,
              root_session_id: active.rootSessionID!,
              state: "working",
              trigger: "adaptive",
              phase: "executing",
              next_wakeup: null,
              time_created: Date.now(),
              time_updated: Date.now(),
              time_started: Date.now(),
              time_ended: null,
              data: { evaluatorReason: "legacy working run", budget: { turns: 3 } },
            })
            .run()
        })

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.metrics.turns).toBe(3)
        expect(snapshot.workflow.state).toBe("completed")
        expect(snapshot.workflow.phase).toBe("completed")
        expect(snapshot.workflow.nextWakeup).toBeUndefined()
        expect(snapshot.threads[0]).toMatchObject({ state: "completed" })
        expect((await svc.due(Date.now())).map((item) => item.id)).not.toContain(draft.id)

        const raw = Database.use((db) => ({
          workflow: db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, draft.id)).get(),
          background: db
            .select()
            .from(BackgroundSessionTable)
            .where(eq(BackgroundSessionTable.session_id, active.rootSessionID!))
            .get(),
          status: db.select().from(SessionStatusTable).where(eq(SessionStatusTable.session_id, active.rootSessionID!)).get(),
          thread: db.select().from(LoopThreadTable).where(eq(LoopThreadTable.workflow_id, draft.id)).get(),
          run: db.select().from(LoopRunTable).where(eq(LoopRunTable.workflow_id, draft.id)).get(),
        }))
        expect(raw.workflow?.state).toBe("completed")
        expect(raw.workflow?.phase).toBe("completed")
        expect(raw.background?.data.state).toBe("completed")
        expect(raw.status).toBeUndefined()
        expect(raw.thread?.state).toBe("completed")
        expect(raw.run?.state).toBe("stopped")

        const lateComplete = await svc.completeRun(draft.id, legacyRunID)
        expect(lateComplete.state).toBe("stopped")
        const afterLateComplete = await svc.snapshot(draft.id)
        expect(afterLateComplete.workflow.metrics.turns).toBe(3)
      },
    })
  })

  test("loop runner defaults to dry-run and requires execute to call the session prompt", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Safe probe",
          objective: "Inspect only unless execution is explicit.",
        })
        await svc.activate(draft.id)

        const dry = await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id })))
        expect(dry.value.state).toBe("skipped")
        expect(dry.prompts).toBe(0)
        expect((await svc.snapshot(draft.id)).workflow.metrics.turns).toBe(0)

        const executed = await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true, reportOnly: true })))
        expect(executed.value.state).toBe("completed")
        expect(executed.prompts).toBe(1)
        expect((await svc.snapshot(draft.id)).workflow.metrics.turns).toBe(1)
      },
    })
  })

  test("loop runner does not force report-only for workflows that explicitly allow implementation edits", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Implementation loop",
          objective: "Code and test the requested fix.",
          policy: {
            maxTurns: 3,
            requireApprovalFor: ["push", "merge", "release", "version-bump", "external-send", "destructive-shell", "broad-refactor"],
          },
        })
        await svc.activate(draft.id)

        const executed = await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true, reportOnly: true })))
        expect(executed.value.state).toBe("completed")
        expect(executed.prompts).toBe(1)
        expect(executed.promptCalls[0]?.tools).toBeUndefined()
        expect(executed.promptCalls[0]?.parts?.[0]?.text).not.toContain("REPORT-ONLY MODE")
      },
    })
  })

  test("max-goal loops complete early when the checkpoint proves the goal is done", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Goal budget",
          objective: "Fix the bug and verify it.",
          budgetMode: "max-goal",
          completionCriteria: ["bug fixed", "focused tests pass"],
          successChecks: ["bun test focused"],
          strategy: { targetTurns: 3, reserveTurns: 1 },
          policy: { maxTurns: 18 },
        })
        await svc.activate(draft.id)

        const checkpoint = [
          "Done.",
          "LOOP_CHECKPOINT:",
          "status: complete",
          "summary: Bug fixed and focused tests pass.",
          "evidence:",
          "- bun test focused passed",
          "next_action: stop",
          "confidence: high",
        ].join("\n")
        const executed = await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })), checkpoint)

        expect(executed.value.state).toBe("completed")
        expect(executed.prompts).toBe(1)
        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.metrics.turns).toBe(1)
        expect(snapshot.workflow.state).toBe("completed")
        expect(snapshot.workflow.phase).toBe("completed")
        expect(snapshot.workflow.evaluatorReason).toBe("Bug fixed and focused tests pass.")
        expect(snapshot.runs[0]?.evaluatorReason).toBe("Bug fixed and focused tests pass.")
        expect(snapshot.events.at(-1)?.summary).toBe("Loop completed after the goal checkpoint reported success.")
      },
    })
  })

  test("max-goal loops block instead of claiming success when the budget is exhausted", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Goal cap",
          objective: "Finish only when verified.",
          budgetMode: "max-goal",
          completionCriteria: ["verified done"],
          policy: { maxTurns: 1 },
        })
        await svc.activate(draft.id)

        const checkpoint = [
          "Still working.",
          "LOOP_CHECKPOINT:",
          "status: continue",
          "summary: More work remains.",
          "evidence:",
          "- tests still failing",
          "next_action: ask for more budget",
          "confidence: medium",
        ].join("\n")
        await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })), checkpoint)

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.metrics.turns).toBe(1)
        expect(snapshot.workflow.state).toBe("blocked")
        expect(snapshot.workflow.phase).toBe("budget_exhausted")
        expect(snapshot.workflow.evaluatorReason).toContain("maximum iteration budget")
        expect(snapshot.events.at(-1)?.summary).toContain("maximum iteration budget")
      },
    })
  })

  test("completed max-goal loops can wake the owner session with a summary", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const owner = await Effect.runPromise(
          Session.Service.use((session) => session.create({ title: "Loop owner" })).pipe(Effect.provide(Session.defaultLayer)),
        )
        const draft = await svc.createDraft({
          name: "Notify owner",
          objective: "Complete and report back.",
          ownerSessionID: owner.id,
          budgetMode: "max-goal",
          strategy: { notifyOwnerOnComplete: true },
          policy: { maxTurns: 5 },
        })
        const active = await svc.activate(draft.id)

        const checkpoint = [
          "Ready.",
          "LOOP_CHECKPOINT:",
          "status: complete",
          "summary: The loop goal is complete.",
          "evidence:",
          "- final validation passed",
          "next_action: stop",
          "confidence: high",
        ].join("\n")
        const executed = await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
          (call) => (call === 1 ? checkpoint : "Parent acknowledged."),
        )

        expect(executed.prompts).toBe(2)
        expect(executed.promptCalls[0]?.sessionID).toBe(active.rootSessionID)
        expect(executed.promptCalls[1]?.sessionID).toBe(owner.id)
        expect(executed.promptCalls[1]?.parts?.[0]?.text).toContain("Loop workflow completed: Notify owner")
      },
    })
  })
})
