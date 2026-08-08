import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Worktree } from "@/worktree"
import { eq } from "@/storage/db"
import {
  defaultLayer as loopWorkflowLayer,
  LoopID,
  RunID,
  Service as LoopWorkflowService,
  nextDailyWakeup,
  type CreateDraftInput,
  type FailureClass,
  type GoalStatus,
  type IngestSignalInput,
} from "@/session/loop"
import { LoopRunner } from "@/session/loop-runner"
import * as MessageV2 from "@/session/message-v2"
import { type PromptInput, SessionPrompt } from "@/session/prompt"
import * as Session from "@/session/session"
import { Database } from "@/storage/db"
import {
  BackgroundSessionTable,
  LoopArtifactTable,
  LoopEventTable,
  LoopRunTable,
  LoopThreadTable,
  LoopWorkflowTable,
  SessionTable,
  SessionStatusTable,
} from "@/session/session.sql"
import { WithInstance } from "../../src/project/with-instance"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { WorkspaceID } from "@/control-plane/schema"
import path from "path"
import { markPermissionPending, markPermissionResolved } from "@/session/pending-input"

function promptMessage(
  text?: string,
  overrides?: Partial<Pick<MessageV2.Assistant, "cost" | "modelID" | "providerID" | "tokens">>,
): MessageV2.WithParts {
  return {
    info: {
      id: "msg_test" as MessageV2.Assistant["id"],
      sessionID: "ses_test" as MessageV2.Assistant["sessionID"],
      role: "assistant",
      time: { created: Date.now() },
      parentID: "msg_parent" as MessageV2.Assistant["parentID"],
      modelID: overrides?.modelID ?? ("gpt-test" as MessageV2.Assistant["modelID"]),
      providerID: overrides?.providerID ?? ("openai" as MessageV2.Assistant["providerID"]),
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: overrides?.cost ?? 0,
      tokens: overrides?.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: text
      ? [
          {
            id: "part_test" as MessageV2.TextPart["id"],
            sessionID: "ses_test" as MessageV2.TextPart["sessionID"],
            messageID: "msg_test" as MessageV2.TextPart["messageID"],
            type: "text",
            text,
          },
        ]
      : [],
  }
}

function promptInputText(input: PromptInput | undefined) {
  return input?.parts.find((part): part is MessageV2.TextPartInput => part.type === "text")?.text
}

function run<A, E>(fx: Effect.Effect<A, E, LoopWorkflowService>) {
  return Effect.runPromise(fx.pipe(Effect.provide(loopWorkflowLayer)))
}

function runWithWorktree<A, E>(fx: Effect.Effect<A, E, LoopWorkflowService | Worktree.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Layer.mergeAll(loopWorkflowLayer, Worktree.defaultLayer))))
}

function runRunner<A, E>(
  fx: Effect.Effect<A, E, LoopRunner.Service | LoopWorkflowService | SessionPrompt.Service | Session.Service>,
  promptText?: string | MessageV2.WithParts | ((call: number) => string | MessageV2.WithParts),
) {
  let prompts = 0
  const promptCalls: PromptInput[] = []
  const promptLayer = Layer.succeed(
    SessionPrompt.Service,
    SessionPrompt.Service.of({
      cancel: () => Effect.void,
      cancelQueued: () => Effect.succeed(false),
      interrupt: () => Effect.void,
      prompt: (input: PromptInput) =>
        Effect.sync(() => {
          prompts++
          promptCalls.push(input)
          const response = typeof promptText === "function" ? promptText(prompts) : promptText
          return typeof response === "string" || response === undefined ? promptMessage(response) : response
        }),
      promptAsync: (input: PromptInput) =>
        Effect.sync(() => {
          prompts++
          promptCalls.push(input)
          const response = typeof promptText === "function" ? promptText(prompts) : promptText
          return typeof response === "string" || response === undefined ? promptMessage(response) : response
        }),
      loop: () => Effect.succeed(promptMessage()),
      shell: () => Effect.succeed(promptMessage()),
      command: () => Effect.succeed(promptMessage()),
      resolvePromptParts: () => Effect.succeed([]),
    }),
  )
  return Effect.runPromise(fx.pipe(Effect.provide(Layer.mergeAll(loopWorkflowLayer, LoopRunner.defaultLayer, Session.defaultLayer, promptLayer)))).then(
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
  updateAgent(id: LoopID, agent?: string) {
    return run(LoopWorkflowService.use((loop) => loop.updateAgent({ id, agent, reason: "test agent update" })))
  },
  stop(id: LoopID) {
    return run(LoopWorkflowService.use((loop) => loop.stop({ id, reason: "test stop" })))
  },
  delete(id: LoopID) {
    return run(LoopWorkflowService.use((loop) => loop.delete(id)))
  },
  list() {
    return run(LoopWorkflowService.use((loop) => loop.list()))
  },
  listGlobal() {
    return run(LoopWorkflowService.use((loop) => loop.listGlobal()))
  },
  listGlobalPage(input?: { offset?: number; limit?: number; selectedID?: LoopID; scope?: "all" | "project" }) {
    return run(LoopWorkflowService.use((loop) => loop.listGlobalPage(input)))
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
  startRunWithLease(id: LoopID, leaseHolder: string) {
    return run(LoopWorkflowService.use((loop) => loop.startRun({ id, trigger: "interval", reason: "test start", leaseHolder })))
  },
  ingestSignal(input: IngestSignalInput) {
    return run(LoopWorkflowService.use((loop) => loop.ingestSignal(input)))
  },
  completeRun(id: LoopID, runID: RunID, checkpoint?: { status?: GoalStatus; summary?: string }) {
    return run(LoopWorkflowService.use((loop) => loop.completeRun({ id, runID, reason: "test complete", checkpoint })))
  },
  failRun(id: LoopID, runID: RunID) {
    return run(LoopWorkflowService.use((loop) => loop.failRun({ id, runID, error: "boom" })))
  },
  failRunWithError(id: LoopID, runID: RunID, error: string, failureClass?: FailureClass) {
    return run(LoopWorkflowService.use((loop) => loop.failRun({ id, runID, error, failureClass })))
  },
  snapshot(id: LoopID, limit?: number) {
    return run(LoopWorkflowService.use((loop) => loop.snapshot(id, limit)))
  },
}

afterEach(async () => {
  await disposeAllInstances()
})

describe("loop workflow service", () => {
  test("calculates the next daily wakeup in the requested IANA timezone", () => {
    expect(nextDailyWakeup(Date.parse("2026-07-17T13:30:00Z"), "10:00", "America/New_York")).toBe(Date.parse("2026-07-17T14:00:00Z"))
    expect(nextDailyWakeup(Date.parse("2026-07-17T14:00:01Z"), "10:00", "America/New_York")).toBe(Date.parse("2026-07-18T14:00:00Z"))
    expect(nextDailyWakeup(Date.parse("2026-07-17T09:00:00Z"), "10:00", "UTC")).toBe(Date.parse("2026-07-17T10:00:00Z"))
  })

  test("skips a nonexistent DST wall-clock time instead of scheduling the wrong hour", () => {
    expect(nextDailyWakeup(Date.parse("2026-03-08T06:00:00Z"), "02:30", "America/New_York")).toBe(Date.parse("2026-03-09T06:30:00Z"))
  })

  test("activates daily loops with a durable next wakeup and due filtering", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Daily report",
          objective: "Generate the daily report.",
          trigger: { mode: "daily", dailyAt: "10:00", timezone: "UTC", intervalMs: 60_000 },
          budgetMode: "unbounded-monitor",
        })
        const active = await svc.activate(draft.id)
        expect(active.spec.trigger).toEqual({ mode: "daily", dailyAt: "10:00", timezone: "UTC" })
        expect(active.state).toBe("sleeping")
        expect(active.nextWakeup).toBeGreaterThan(Date.now())
        expect((await svc.due(active.nextWakeup! - 1)).map((item) => item.id)).not.toContain(active.id)
        expect((await svc.due(active.nextWakeup! + 1)).map((item) => item.id)).toContain(active.id)
      },
    })
  })

  test("rearms an interval wakeup from the injected scheduler clock", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const base = Date.parse("2026-07-31T12:00:00Z")
        const intervalMs = 60_000
        const draft = await svc.createDraft({
          name: "Fake clock monitor",
          objective: "Keep interval scheduling deterministic.",
          trigger: { mode: "interval", intervalMs },
          budgetMode: "unbounded-monitor",
        })
        const active = await run(LoopWorkflowService.use((loop) => loop.activate({ id: draft.id, reason: "fake clock", now: base })))
        expect(active.nextWakeup).toBe(base)

        const started = await run(LoopWorkflowService.use((loop) => loop.startRun({
          id: draft.id,
          trigger: "interval",
          reason: "fake clock run",
          now: base,
        })))
        const completedAt = base + 1_000
        await run(LoopWorkflowService.use((loop) => loop.completeRun({
          id: draft.id,
          runID: started.id,
          reason: "healthy checkpoint",
          now: completedAt,
          checkpoint: { status: "continue", summary: "Healthy checkpoint." },
        })))

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow).toMatchObject({
          state: "sleeping",
          phase: "waiting",
          nextWakeup: completedAt + intervalMs,
          scheduler: {
            lastWakeAttempt: base,
            nextWakeup: completedAt + intervalMs,
            lastRunID: started.id,
            lastRunState: "completed",
            degraded: false,
          },
        })
      },
    })
  })

  test("repairs an overdue interval wakeup and queues a catch-up run", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const base = Date.parse("2026-07-31T12:00:00Z")
        const draft = await svc.createDraft({
          name: "Overdue monitor",
          objective: "Recover an interval wake after a restart.",
          trigger: { mode: "interval", intervalMs: 60_000 },
          budgetMode: "unbounded-monitor",
        })
        await run(LoopWorkflowService.use((loop) => loop.activate({ id: draft.id, reason: "fake clock", now: base })))
        Database.use((db) => db.update(LoopWorkflowTable).set({
          state: "sleeping",
          phase: "waiting",
          next_wakeup: base - 1,
        }).where(eq(LoopWorkflowTable.id, draft.id)).run())

        const due = await run(LoopWorkflowService.use((loop) => loop.due({ now: base })))
        expect(due[0]).toMatchObject({ id: draft.id, state: "sleeping", phase: "catch_up", nextWakeup: base })
        expect((await svc.snapshot(draft.id)).events.at(-1)).toMatchObject({
          type: "wake",
          title: "Scheduled wakeup repaired",
        })
        const started = await run(LoopWorkflowService.use((loop) => loop.startRun({
          id: draft.id,
          trigger: "interval",
          reason: "catch up overdue wake",
          now: base,
        })))
        expect(started.state).toBe("working")
      },
    })
  })

  test("deduplicates repeated overdue ticks and re-arms the future cadence after catch-up", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const base = Date.parse("2026-07-31T12:00:00Z")
        const intervalMs = 60_000
        const draft = await svc.createDraft({
          name: "Deduplicated overdue monitor",
          objective: "Recover one catch-up run after duplicate scheduler ticks.",
          trigger: { mode: "interval", intervalMs },
          budgetMode: "unbounded-monitor",
        })
        await run(LoopWorkflowService.use((loop) => loop.activate({ id: draft.id, reason: "fake clock", now: base })))
        Database.use((db) => db.update(LoopWorkflowTable).set({
          state: "sleeping",
          phase: "waiting",
          next_wakeup: base - 1,
        }).where(eq(LoopWorkflowTable.id, draft.id)).run())

        const firstDue = await run(LoopWorkflowService.use((loop) => loop.due({ now: base })))
        const secondDue = await run(LoopWorkflowService.use((loop) => loop.due({ now: base })))
        expect(firstDue).toHaveLength(1)
        expect(secondDue).toHaveLength(1)
        expect((await svc.snapshot(draft.id)).events.filter((event) => event.title === "Scheduled wakeup repaired")).toHaveLength(1)

        const firstRun = await run(LoopWorkflowService.use((loop) => loop.startRun({
          id: draft.id,
          trigger: "interval",
          reason: "first catch-up tick",
          now: base,
        })))
        const duplicateRun = await run(LoopWorkflowService.use((loop) => loop.startRun({
          id: draft.id,
          trigger: "interval",
          reason: "duplicate catch-up tick",
          now: base,
        })))
        expect(duplicateRun.id).toBe(firstRun.id)

        await run(LoopWorkflowService.use((loop) => loop.completeRun({
          id: draft.id,
          runID: firstRun.id,
          reason: "catch-up completed",
          now: base + 1_000,
          checkpoint: { status: "continue", summary: "Catch-up completed." },
        })))
        expect((await svc.snapshot(draft.id)).workflow).toMatchObject({
          state: "sleeping",
          nextWakeup: base + 1_000 + intervalMs,
          scheduler: { degraded: false, nextWakeup: base + 1_000 + intervalMs },
        })
      },
    })
  })

  test("survives 48 half-hour boundaries and one service restart without duplicate runs", async () => {
    await using tmp = await tmpdir({ git: true })
    const base = Date.parse("2026-07-31T00:00:00Z")
    const intervalMs = 30 * 60 * 1000
    let workflowID: LoopID | undefined
    let nextScheduled = base
    const runIDs = new Set<string>()

    const runIntervals = async (start: number, end: number) => {
      await WithInstance.provide({
        directory: tmp.path,
        fn: async () => {
          let scheduled = nextScheduled
          for (let tick = start; tick < end; tick++) {
            const now = scheduled + 1
            const due = await svc.due(now)
            const duplicateDue = await svc.due(now)
            expect(due.map((item) => item.id)).toEqual([workflowID!])
            expect(duplicateDue.map((item) => item.id)).toEqual([workflowID!])

            const first = await run(LoopWorkflowService.use((loop) => loop.startRun({
              id: workflowID!,
              trigger: "interval",
              reason: `endurance tick ${tick}`,
              now,
            })))
            const duplicate = await run(LoopWorkflowService.use((loop) => loop.startRun({
              id: workflowID!,
              trigger: "interval",
              reason: `duplicate endurance tick ${tick}`,
              now,
            })))
            expect(duplicate.id).toBe(first.id)
            runIDs.add(first.id)

            const completedAt = now + 1_000
            await run(LoopWorkflowService.use((loop) => loop.completeRun({
              id: workflowID!,
              runID: first.id,
              reason: `completed endurance tick ${tick}`,
              now: completedAt,
              checkpoint: { status: "continue", summary: "Endurance checkpoint completed." },
            })))
            scheduled = completedAt + intervalMs
          }
          nextScheduled = scheduled
        },
      })
    }

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Scheduler endurance",
          objective: "Cross half-hour boundaries without duplicate scheduled runs.",
          trigger: { mode: "interval", intervalMs },
          budgetMode: "unbounded-monitor",
        })
        workflowID = draft.id
        await run(LoopWorkflowService.use((loop) => loop.activate({ id: draft.id, reason: "endurance start", now: base })))
      },
    })

    await runIntervals(0, 24)
    await disposeAllInstances()
    await runIntervals(24, 48)

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const snapshot = await svc.snapshot(workflowID!)
        expect(runIDs).toHaveLength(48)
        expect(snapshot.runs).toHaveLength(10)
        expect(snapshot.workflow).toMatchObject({ state: "sleeping", phase: "waiting", scheduler: { degraded: false } })
        expect(snapshot.workflow.nextWakeup).toBeGreaterThan(Date.parse("2026-08-01T00:00:00Z"))
      },
    })
  })

  test("records scheduler failures as degraded state without losing interval cadence", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const base = Date.parse("2026-07-31T12:00:00Z")
        const intervalMs = 60_000
        const draft = await svc.createDraft({
          name: "Degraded monitor",
          objective: "Keep the next wake visible after a scheduler failure.",
          trigger: { mode: "interval", intervalMs },
          budgetMode: "unbounded-monitor",
        })
        await run(LoopWorkflowService.use((loop) => loop.activate({ id: draft.id, reason: "fake clock", now: base })))

        const failed = await run(LoopWorkflowService.use((loop) => loop.recordSchedulerFailure({
          id: draft.id,
          error: "daemon dispatch failed",
          failureClass: "environment",
          now: base,
        })))
        const snapshot = await svc.snapshot(draft.id)
        expect(failed).toMatchObject({ state: "failed", phase: "scheduler_degraded", retry: { nextWakeup: base + intervalMs } })
        expect(snapshot.workflow).toMatchObject({
          state: "sleeping",
          phase: "scheduler_degraded",
          nextWakeup: base + intervalMs,
          scheduler: {
            lastRunID: failed.id,
            lastRunState: "failed",
            lastError: "daemon dispatch failed",
            degraded: true,
          },
        })
        expect(snapshot.events.at(-1)).toMatchObject({ title: "Loop scheduler degraded", level: "error" })
      },
    })
  })

  test("keeps execution lists project-scoped while exposing global dashboard entries", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    const firstDraft = await WithInstance.provide({
      directory: first.path,
      fn: () => svc.createDraft({ name: "First project loop", objective: "Watch the first project." }),
    })
    const secondDraft = await WithInstance.provide({
      directory: second.path,
      fn: () => svc.createDraft({ name: "Second project loop", objective: "Watch the second project." }),
    })

    await WithInstance.provide({
      directory: first.path,
      fn: async () => {
        expect((await svc.list()).map((item) => item.id)).toEqual([firstDraft.id])
        const global = await svc.listGlobal()
        expect(global.map((item) => item.id)).toEqual(expect.arrayContaining([firstDraft.id, secondDraft.id]))
        expect(global.find((item) => item.id === firstDraft.id)?.project.worktree).toBe(first.path)
        expect(global.find((item) => item.id === secondDraft.id)?.project.worktree).toBe(second.path)
      },
    })
  })

  test("can scope the global dashboard page to the current project", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    const firstDraft = await WithInstance.provide({
      directory: first.path,
      fn: () => svc.createDraft({ name: "First scoped loop", objective: "Keep the first project visible." }),
    })
    const secondDraft = await WithInstance.provide({
      directory: second.path,
      fn: () => svc.createDraft({ name: "Second scoped loop", objective: "Keep the second project visible." }),
    })

    await WithInstance.provide({
      directory: first.path,
      fn: async () => {
        const projectPage = await svc.listGlobalPage({ limit: 100, scope: "project" })
        expect(projectPage.history.map((item) => item.id)).toContain(firstDraft.id)
        expect(projectPage.history.map((item) => item.id)).not.toContain(secondDraft.id)
        expect(projectPage.page.total).toBe(1)
      },
    })
  })

  test("pages global history while retaining every TUI-active workflow and paused off-state rows", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const historyTotal = (await svc.listGlobalPage({ limit: 1 })).page.total
        const first = await svc.createDraft({ name: "First history", objective: "First terminal history row." })
        const second = await svc.createDraft({ name: "Second history", objective: "Second terminal history row." })
        const third = await svc.createDraft({ name: "Third history", objective: "Third terminal history row." })
        const sleeping = await svc.createDraft({ name: "Sleeping active", objective: "Remain visible with active loops." })
        await svc.activate(sleeping.id)
        const paused = await svc.createDraft({ name: "Paused active", objective: "Remain visible while paused." })
        await svc.activate(paused.id)
        await svc.pause(paused.id)
        const historyBase = Date.now() + 60_000
        Database.use((db) => {
          db.update(LoopWorkflowTable).set({ time_updated: historyBase }).where(eq(LoopWorkflowTable.id, first.id)).run()
          db.update(LoopWorkflowTable).set({ time_updated: historyBase + 1 }).where(eq(LoopWorkflowTable.id, second.id)).run()
          db.update(LoopWorkflowTable).set({ time_updated: historyBase + 2 }).where(eq(LoopWorkflowTable.id, third.id)).run()
          db.update(LoopWorkflowTable).set({ time_updated: historyBase + 3 }).where(eq(LoopWorkflowTable.id, paused.id)).run()
        })

        const firstPage = await svc.listGlobalPage({ offset: -10, limit: 999 })
        expect(firstPage.active.map((item) => item.id)).toContain(sleeping.id)
        expect(firstPage.active.map((item) => item.id)).not.toContain(paused.id)
        expect(firstPage.history.map((item) => item.id)).toEqual(expect.arrayContaining([first.id, second.id, third.id, paused.id]))
        expect(firstPage.page).toEqual({ offset: 0, limit: 100, total: historyTotal + 4 })

        const selectedPage = await svc.listGlobalPage({ limit: 1, selectedID: first.id })
        expect(selectedPage.page).toEqual({ offset: 3, limit: 1, total: historyTotal + 4 })
        expect(selectedPage.history.map((item) => item.id)).toEqual([first.id])

        const lastPage = await svc.listGlobalPage({ offset: 999_999, limit: 2 })
        expect(lastPage.page.offset).toBe(Math.floor((lastPage.page.total - 1) / 2) * 2)
        expect(lastPage.history).toHaveLength(lastPage.page.total % 2 || 2)
      },
    })
  })

  test("re-reads the dashboard page after reconciliation changes loop buckets", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Legacy active history row",
          objective: "Move into history during dashboard hydration.",
          policy: { maxTurns: 1 },
        })
        const active = await svc.activate(draft.id)
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
          db.update(LoopThreadTable)
            .set({ state: "working" })
            .where(eq(LoopThreadTable.workflow_id, draft.id))
            .run()
        })

        const page = await svc.listGlobalPage({ limit: 1, selectedID: draft.id })
        expect(page.active.map((item) => item.id)).not.toContain(draft.id)
        expect(page.history.map((item) => item.id)).toContain(draft.id)
        expect(page.page.total).toBeGreaterThan(0)
        expect((await svc.snapshot(draft.id)).workflow.state).toBe("completed")
      },
    })
  })

  test("uses id as a deterministic tiebreaker for equal updated timestamps", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const first = await svc.createDraft({ name: "Same time first", objective: "Older ID at identical timestamp." })
        const second = await svc.createDraft({ name: "Same time second", objective: "Newer ID at identical timestamp." })
        const updatedAt = Date.parse("2100-01-01T00:00:00Z")
        Database.use((db) => {
          db.update(LoopWorkflowTable).set({ time_updated: updatedAt }).where(eq(LoopWorkflowTable.id, first.id)).run()
          db.update(LoopWorkflowTable).set({ time_updated: updatedAt }).where(eq(LoopWorkflowTable.id, second.id)).run()
        })

        expect((await svc.list()).slice(0, 2).map((item) => item.id)).toEqual([second.id, first.id])
        expect((await svc.listGlobal()).slice(0, 2).map((item) => item.id)).toEqual([second.id, first.id])
        expect((await svc.listGlobalPage({ limit: 1 })).history.map((item) => item.id)).toEqual([second.id])
        expect((await svc.listGlobalPage({ limit: 1, selectedID: first.id })).page.offset).toBe(1)
      },
    })
  })

  test("creates a reviewable draft without activating it", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "PR babysitter",
          objective: "Watch PR #123 and surface actionable feedback.",
          trigger: { mode: "interval", intervalMs: 60_000 },
          policy: { approvedActions: ["push"] },
        })

        expect(draft.state).toBe("draft")
        expect(draft.rootSessionID).toBeUndefined()
        expect(draft.policy.requireApprovalFor).toContain("push")
        expect(draft.policy.requireApprovalFor).toContain("merge")
        expect(draft.policy.approvedActions).toEqual(["push"])

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.events).toHaveLength(1)
        expect(snapshot.events[0]).toMatchObject({ type: "created", title: "Loop draft created" })
      },
    })
  })

  test("updates the loop agent and can reset to default", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Agent editable loop",
          objective: "Keep this loop easy to retarget.",
          agent: "build",
        })

        const updated = await svc.updateAgent(draft.id, "fix")
        expect(updated.spec.agent).toBe("fix")

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.spec.agent).toBe("fix")
        expect(snapshot.events.find((event) => event.title === "Loop agent updated")?.data?.agent).toBe("fix")

        const reset = await svc.updateAgent(draft.id, "")
        expect(reset.spec.agent).toBeUndefined()
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
        expect(run.state).toBe("blocked")
        expect(run.phase).toBe("dispatcher_unavailable")
        expect(run.trigger).toBe("run-once")

        Database.use((db) =>
          db
            .update(SessionTable)
            .set({ model: { providerID: "openai", id: "gpt-test-loop", variant: "medium" } })
            .where(eq(SessionTable.id, active.rootSessionID!))
            .run(),
        )

        const snapshot = await svc.snapshot(active.id)
        expect(snapshot.workflow.metrics.turns).toBe(0)
        expect(snapshot.rootSession?.model).toEqual({ providerID: "openai", modelID: "gpt-test-loop", variant: "medium" })
        expect(snapshot.threads).toHaveLength(1)
        expect(snapshot.threads[0]).toMatchObject({ role: "root", sessionID: active.rootSessionID })
        expect(snapshot.events.map((event) => event.type)).toEqual(["created", "activated", "failed"])
      },
    })
  })

  test("run-once cannot mark a max-goal workflow complete by exhausting its budget", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Bounded manual goal",
          objective: "Complete only with validated goal evidence.",
          budgetMode: "max-goal",
          policy: { maxTurns: 1 },
        })
        await svc.activate(draft.id)

        const recorded = await svc.runOnce(draft.id)
        const snapshot = await svc.snapshot(draft.id)
        expect(recorded).toMatchObject({ state: "blocked", phase: "dispatcher_unavailable" })
        expect(snapshot.workflow).toMatchObject({ state: "blocked", phase: "dispatcher_unavailable" })
        expect(snapshot.workflow.evaluatorReason).toContain("loop runner service is unavailable")
      },
    })
  })

  test("run-once cannot clear blocked or paused workflow state", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const blocked = await svc.createDraft({
          name: "Blocked manual run",
          objective: "Remain blocked until an explicit retry decision.",
        })
        await svc.activate(blocked.id)
        const started = await svc.startRun(blocked.id)
        await svc.completeRun(blocked.id, started.id, {
          status: "blocked",
          summary: "A required dependency is unavailable.",
        })

        await expect(svc.runOnce(blocked.id)).rejects.toThrow()
        expect((await svc.snapshot(blocked.id)).workflow).toMatchObject({ state: "blocked", metrics: { turns: 1 } })

        const paused = await svc.createDraft({
          name: "Paused manual run",
          objective: "Stay paused until explicitly resumed.",
        })
        await svc.activate(paused.id)
        await svc.pause(paused.id)

        await expect(svc.runOnce(paused.id)).rejects.toThrow()
        expect((await svc.snapshot(paused.id)).workflow).toMatchObject({ state: "paused", metrics: { turns: 0 } })
      },
    })
  })

  test("persists workspace isolation metadata on workflow, root session, and root thread", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const workspaceID = WorkspaceID.ascending("wrk_loop_policy")
        const draft = await svc.createDraft({
          name: "Workspace policy loop",
          objective: "Make isolated edits when the workspace lifecycle is available.",
          workspaceID,
          workspace: { mode: "per-run-worktree" },
        })

        expect(draft.workspaceID).toBe(workspaceID)
        expect(draft.spec.workspace?.mode).toBe("per-run-worktree")

        const active = await svc.activate(draft.id)
        expect(active.workspaceID).toBe(workspaceID)

        const rootSession = Database.use((db) =>
          db.select({ workspaceID: SessionTable.workspace_id }).from(SessionTable).where(eq(SessionTable.id, active.rootSessionID!)).get(),
        )
        expect(rootSession?.workspaceID).toBe(workspaceID)

        const snapshot = await svc.snapshot(active.id)
        expect(snapshot.workflow.spec.workspace?.mode).toBe("per-run-worktree")
        expect(snapshot.threads[0]).toMatchObject({ role: "root", sessionID: active.rootSessionID, worktree: tmp.path })
      },
    })
  })

  test("creates and tracks a per-run worktree lease when a run starts", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await runWithWorktree(LoopWorkflowService.use((loop) => loop.createDraft({
          name: "Per-run worktree loop",
          objective: "Edit safely in an isolated worktree.",
          workspace: { mode: "per-run-worktree" },
        })))
        await runWithWorktree(LoopWorkflowService.use((loop) => loop.activate({ id: draft.id, reason: "test activate" })))

        const run = await runWithWorktree(LoopWorkflowService.use((loop) => loop.startRun({ id: draft.id, trigger: "manual", reason: "test isolated start" })))
        expect(run.workspaceLease).toMatchObject({
          workflowID: draft.id,
          runID: run.id,
          mode: "per-run-worktree",
          state: "active",
          retention: "retain_on_failure",
        })
        expect(run.workspaceLease?.path).toContain("worktree")
        expect(run.workspaceLease?.path).not.toBe(tmp.path)
        expect(run.workspaceLease?.branch).toStartWith("opencode/")

        const snapshot = await runWithWorktree(LoopWorkflowService.use((loop) => loop.snapshot(draft.id)))
        expect(snapshot.runs[0]?.workspaceLease?.path).toBe(run.workspaceLease?.path)
        expect(snapshot.threads[0]).toMatchObject({ runID: run.id, worktree: run.workspaceLease?.path, branch: run.workspaceLease?.branch })
        expect(snapshot.events.find((event) => event.title === "Loop run started")?.data?.workspaceLease).toMatchObject({
          mode: "per-run-worktree",
          state: "active",
        })

        if (run.workspaceLease?.path) {
          await runWithWorktree(Worktree.Service.use((worktree) => worktree.remove({ directory: run.workspaceLease!.path })))
        }
      },
    })
  })

  test("ingests external signals idempotently and schedules matching loops", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Signal listener",
          objective: "Wake when CI reports new information.",
          trigger: { mode: "external-signal" },
        })
        const active = await svc.activate(draft.id)
        expect(active.state).toBe("active")
        expect(active.nextWakeup).toBeUndefined()

        const beforeSignal = Date.now()
        const first = await svc.ingestSignal({
          source: "ci",
          type: "ci.check.failed",
          dedupeKey: "build-123",
          payloadSummary: "Unit tests failed on build 123",
          links: ["https://ci.example/build/123"],
        })
        const afterSignal = Date.now()
        expect(first.deduped).toBe(false)
        expect(first.signal.matches).toEqual([draft.id])
        expect(first.signal.receivedAt).toBeGreaterThanOrEqual(beforeSignal)
        expect(first.signal.receivedAt).toBeLessThanOrEqual(afterSignal)
        expect(first.matched[0]).toMatchObject({ id: draft.id, state: "sleeping", phase: "signal_received", nextWakeup: first.signal.receivedAt })
        expect((await svc.due(first.signal.receivedAt)).map((item) => item.id)).toContain(draft.id)

        const duplicate = await svc.ingestSignal({
          source: "ci",
          type: "ci.check.failed",
          dedupeKey: "build-123",
          payloadSummary: "Unit tests failed on build 123 again",
        })
        expect(duplicate.deduped).toBe(true)

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.events.filter((event) => event.type === "signal")).toHaveLength(1)
        expect(snapshot.artifacts.filter((artifact) => artifact.kind === "signal")).toHaveLength(1)
        expect(snapshot.artifacts.find((artifact) => artifact.kind === "signal")?.metadata).toMatchObject({
          source: "ci",
          type: "ci.check.failed",
          dedupeKey: "build-123",
        })
      },
    })
  })

  test("queues external signals that arrive while a loop is working or paused", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Queued signals",
          objective: "Do not lose signals received outside the idle state.",
          trigger: { mode: "external-signal" },
        })
        await svc.activate(draft.id)
        await svc.ingestSignal({ workflowID: draft.id, source: "ci", type: "ci.first", dedupeKey: "first" })
        const started = await svc.startRun(draft.id)
        const second = await svc.ingestSignal({ workflowID: draft.id, source: "ci", type: "ci.second", dedupeKey: "second" })
        const secondAt = second.signal.receivedAt
        await svc.completeRun(draft.id, started.id, { status: "continue", summary: "Processed the first signal." })

        let snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow).toMatchObject({ state: "sleeping", phase: "signal_received", nextWakeup: secondAt })
        expect((await svc.due(secondAt)).map((item) => item.id)).toContain(draft.id)

        await svc.pause(draft.id)
        const paused = await svc.ingestSignal({ workflowID: draft.id, source: "ci", type: "ci.paused", dedupeKey: "paused" })
        const pausedAt = paused.signal.receivedAt
        snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow).toMatchObject({ state: "paused", phase: "signal_received", nextWakeup: pausedAt })
        const resumed = await svc.resume(draft.id)
        expect(resumed).toMatchObject({ state: "sleeping", phase: "signal_received", nextWakeup: pausedAt })
      },
    })
  })

  test("keeps a queued external signal runnable when the active run fails", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Signal after failure",
          objective: "Retry without losing the next event.",
          trigger: { mode: "external-signal" },
        })
        await svc.activate(draft.id)
        await svc.ingestSignal({ workflowID: draft.id, source: "ci", type: "ci.first", dedupeKey: "first" })
        const started = await svc.startRun(draft.id)
        const queued = await svc.ingestSignal({ workflowID: draft.id, source: "ci", type: "ci.second", dedupeKey: "second" })
        const queuedAt = queued.signal.receivedAt
        await svc.failRunWithError(draft.id, started.id, "network timeout", "transient")

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow).toMatchObject({ state: "sleeping", phase: "signal_received", nextWakeup: queuedAt })
        expect((await svc.due(queuedAt)).map((item) => item.id)).toContain(draft.id)
      },
    })
  })

  test("skips external-signal worker execution when readiness has no pending signal", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Quiet signal listener",
          objective: "Only run when an external signal arrives.",
          trigger: { mode: "external-signal" },
        })
        await svc.activate(draft.id)

        const result = await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })), "should not run")
        expect(result.prompts).toBe(0)
        expect(result.value).toMatchObject({
          workflowID: draft.id,
          state: "skipped",
          summary: "External-signal loop has no pending normalized signal evidence to process.",
        })

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("active")
        expect(snapshot.workflow.phase).toBe("ready")
        expect(snapshot.events.find((event) => event.title === "Loop readiness skipped")?.summary).toBe(
          "External-signal loop has no pending normalized signal evidence to process.",
        )
        expect(snapshot.artifacts.find((artifact) => artifact.title === "Proactive readiness skipped")?.status).toBe("skipped")
        expect(snapshot.runs).toHaveLength(0)
      },
    })
  })

  test("records run usage and blocks when the cost budget is exceeded", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Cost ledger loop",
          objective: "Track model usage before completing.",
          budgetMode: "max-goal",
          costBudget: { maxCost: 0.01, maxTokens: 30 },
        })
        await svc.activate(draft.id)
        const runInfo = await svc.startRun(draft.id)

        const completed = await run(LoopWorkflowService.use((loop) => loop.completeRun({
          id: draft.id,
          runID: runInfo.id,
          reason: "usage test",
          checkpoint: { status: "complete", summary: "Done with usage evidence." },
          usage: {
            providerID: "openai",
            modelID: "gpt-test",
            cost: 0.02,
            tokens: { input: 10, output: 12, reasoning: 11, cacheRead: 2, cacheWrite: 1 },
          },
        })))

        expect(completed.usage).toMatchObject({ providerID: "openai", modelID: "gpt-test", cost: 0.02 })
        expect(completed.gateResults?.find((gate) => gate.id === "cost-budget")?.status).toBe("blocked")

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("blocked")
        expect(snapshot.workflow.metrics.cost).toBe(0.02)
        expect(snapshot.workflow.metrics.inputTokens).toBe(10)
        expect(snapshot.workflow.metrics.outputTokens).toBe(12)
        expect(snapshot.workflow.metrics.reasoningTokens).toBe(11)
        expect(snapshot.artifacts.find((artifact) => artifact.kind === "cost")?.metadata).toMatchObject({
          providerID: "openai",
          modelID: "gpt-test",
          totalTokens: 36,
        })
      },
    })
  })

  test("loop runner records model usage and blocks unapproved sensitive actions", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Approval hook loop",
          objective: "Complete only when policy is satisfied.",
          budgetMode: "max-goal",
          evaluation: { mode: "legacy", allowWorkerSelfComplete: true },
          policy: { requireApprovalFor: ["push"] },
        })
        await svc.activate(draft.id)

        const result = await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
          [
            "LOOP_CHECKPOINT:",
            "status: complete",
            "summary: I pushed the branch.",
            "evidence:",
            "- ran git push origin feature-loop",
            "next_action: stop",
            "confidence: high",
          ].join("\n"),
        )

        expect(result.value.state).toBe("blocked")
        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("blocked")
        expect(snapshot.workflow.phase).toBe("approval_required")
        expect(snapshot.runs[0]?.usage).toMatchObject({ providerID: "openai", modelID: "gpt-test" })
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "approval-policy")?.status).toBe("awaiting_approval")
      },
    })
  })

  test("startRun returns the active leased run instead of creating a duplicate", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Single runner",
          objective: "Avoid duplicate scheduler execution.",
          trigger: { mode: "interval", intervalMs: 120_000 },
        })
        await svc.activate(draft.id)

        const first = await svc.startRunWithLease(draft.id, "runner-a")
        const duplicate = await svc.startRunWithLease(draft.id, "runner-b")

        expect(duplicate.id).toBe(first.id)
        expect(duplicate.lease?.holder).toBe("runner-a")
        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("working")
        expect(snapshot.runs).toHaveLength(1)
        expect(snapshot.runs[0]?.lease?.holder).toBe("runner-a")
      },
    })
  })

  test("stale run leases are reconciled so crashed workflows can run again", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Crash recovery",
          objective: "Recover a stuck loop run.",
          trigger: { mode: "interval", intervalMs: 120_000 },
        })
        await svc.activate(draft.id)
        const stuck = await svc.startRunWithLease(draft.id, "runner-stale")
        const expired = Date.now() - 1
        Database.use((db) => {
          const row = db.select().from(LoopRunTable).where(eq(LoopRunTable.id, stuck.id)).get()!
          db.update(LoopRunTable)
            .set({
              data: {
                ...row.data,
                lease: {
                  holder: "runner-stale",
                  acquired: expired - 1_000,
                  heartbeat: expired - 1_000,
                  expires: expired,
                },
              },
            })
            .where(eq(LoopRunTable.id, stuck.id))
            .run()
        })

        const recovered = await svc.snapshot(draft.id)
        expect(recovered.workflow.state).toBe("sleeping")
        expect(recovered.workflow.phase).toBe("waiting")
        expect(recovered.workflow.metrics.failures).toBe(1)
        expect(recovered.runs[0]?.id).toBe(stuck.id)
        expect(recovered.runs[0]?.state).toBe("failed")
        expect(recovered.runs[0]?.phase).toBe("stale")
        expect(recovered.events.at(-1)?.title).toBe("Stale loop run recovered")

        const next = await svc.startRunWithLease(draft.id, "runner-fresh")
        expect(next.id).not.toBe(stuck.id)
        expect(next.lease?.holder).toBe("runner-fresh")
      },
    })
  })

  test("an expired wall-clock lease does not interrupt a live loop worker after sleep", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Sleep recovery",
          objective: "Keep a live process running after the machine wakes.",
          trigger: { mode: "interval", intervalMs: 120_000 },
        })
        await svc.activate(draft.id)
        const active = await svc.startRunWithLease(draft.id, `loop-runner:${process.pid}:sleep-test`)
        Database.use((db) => {
          const row = db.select().from(LoopRunTable).where(eq(LoopRunTable.id, active.id)).get()!
          db.update(LoopRunTable)
            .set({
              data: {
                ...row.data,
                lease: { ...row.data.lease!, heartbeat: 1, expires: 1 },
              },
            })
            .where(eq(LoopRunTable.id, active.id))
            .run()
        })

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("working")
        expect(snapshot.runs[0]).toMatchObject({ id: active.id, state: "working" })
      },
    })
  })

  test("needs-input loops recover when the permission-owning worker dies", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Permission crash recovery",
          objective: "Retry after a worker dies while awaiting permission.",
          trigger: { mode: "interval", intervalMs: 120_000 },
        })
        await svc.activate(draft.id)
        const worker = Bun.spawn(["true"])
        await worker.exited
        const active = await svc.startRunWithLease(draft.id, `loop-runner:${worker.pid}:permission-test`)
        Database.use((db) =>
          db.update(LoopWorkflowTable)
            .set({ state: "needs_input", phase: "needs_input" })
            .where(eq(LoopWorkflowTable.id, draft.id))
            .run(),
        )

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow).toMatchObject({ state: "sleeping", phase: "waiting" })
        expect(snapshot.runs[0]).toMatchObject({ id: active.id, state: "failed", phase: "stale" })
      },
    })
  })

  test("recovers a dead worker process before its lease expires and clears generating state", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Process crash recovery",
          objective: "Recover when the loop worker dies during generation.",
          trigger: { mode: "interval", intervalMs: 120_000 },
        })
        const active = await svc.activate(draft.id)
        const worker = Bun.spawn(["true"])
        await worker.exited
        const stuck = await svc.startRunWithLease(draft.id, `loop-runner:${worker.pid}:worker-token`)
        Database.use((db) => {
          const run = db.select().from(LoopRunTable).where(eq(LoopRunTable.id, stuck.id)).get()!
          const now = Date.now()
          db.update(LoopRunTable)
            .set({
              data: {
                ...run.data,
                lease: {
                  holder: `loop-runner:${worker.pid}:worker-token`,
                  acquired: now - 1_000,
                  heartbeat: now - 1_000,
                  expires: now + 60 * 60 * 1000,
                },
              },
            })
            .where(eq(LoopRunTable.id, stuck.id))
            .run()
          db.insert(SessionStatusTable)
            .values({
              session_id: active.rootSessionID!,
              time_created: now,
               time_updated: now,
               data: { type: "busy" },
            })
            .onConflictDoUpdate({
               target: SessionStatusTable.session_id,
               set: { time_updated: now, data: { type: "busy" } },
            })
            .run()
        })

        const recovered = await svc.snapshot(draft.id)
        expect(recovered.workflow).toMatchObject({ state: "sleeping", phase: "waiting", nextWakeup: expect.any(Number) })
        expect(recovered.runs[0]).toMatchObject({ id: stuck.id, state: "failed", phase: "stale" })
        expect(Database.use((db) => db.select().from(SessionStatusTable).where(eq(SessionStatusTable.session_id, active.rootSessionID!)).get())).toBeUndefined()
        expect(Database.use((db) => db.select().from(LoopThreadTable).where(eq(LoopThreadTable.workflow_id, draft.id)).get()?.state)).toBe("queued")
        expect(Database.use((db) => db.select().from(BackgroundSessionTable).where(eq(BackgroundSessionTable.session_id, active.rootSessionID!)).get()?.data.state)).toBe("queued")
      },
    })
  })

  test("stale leased runs are also reconciled while the workflow is paused mid-iteration", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Paused crash recovery",
          objective: "Honor pause after a crashed in-flight run.",
          trigger: { mode: "interval", intervalMs: 120_000 },
        })
        await svc.activate(draft.id)
        const stuck = await svc.startRunWithLease(draft.id, "runner-stale")
        await svc.pause(draft.id)
        const expired = Date.now() - 1
        Database.use((db) => {
          const row = db.select().from(LoopRunTable).where(eq(LoopRunTable.id, stuck.id)).get()!
          db.update(LoopRunTable)
            .set({
              data: {
                ...row.data,
                lease: {
                  holder: "runner-stale",
                  acquired: expired - 1_000,
                  heartbeat: expired - 1_000,
                  expires: expired,
                },
              },
            })
            .where(eq(LoopRunTable.id, stuck.id))
            .run()
        })

        const recovered = await svc.snapshot(draft.id)
        expect(recovered.workflow.state).toBe("paused")
        expect(recovered.workflow.phase).toBe("paused")
        expect(recovered.workflow.nextWakeup).toBeUndefined()
        expect(recovered.workflow.metrics.failures).toBe(1)
        expect(recovered.runs[0]?.id).toBe(stuck.id)
        expect(recovered.runs[0]?.state).toBe("failed")
        expect(recovered.runs[0]?.phase).toBe("stale")
        expect(recovered.events.at(-1)?.title).toBe("Stale loop run recovered")
      },
    })
  })

  test("late completions from reconciled stale runs do not mutate workflow state or append artifacts", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Ignore stale completion",
          objective: "Do not trust results from a recovered stale run.",
          trigger: { mode: "interval", intervalMs: 120_000 },
        })
        await svc.activate(draft.id)
        const stuck = await svc.startRunWithLease(draft.id, "runner-stale")
        const expired = Date.now() - 1
        Database.use((db) => {
          const row = db.select().from(LoopRunTable).where(eq(LoopRunTable.id, stuck.id)).get()!
          db.update(LoopRunTable)
            .set({
              data: {
                ...row.data,
                lease: {
                  holder: "runner-stale",
                  acquired: expired - 1_000,
                  heartbeat: expired - 1_000,
                  expires: expired,
                },
              },
            })
            .where(eq(LoopRunTable.id, stuck.id))
            .run()
        })

        const recovered = await svc.snapshot(draft.id)
        expect(recovered.workflow.state).toBe("sleeping")
        expect(recovered.runs[0]?.state).toBe("failed")
        expect(recovered.artifacts).toHaveLength(0)

        const late = await svc.completeRun(draft.id, stuck.id, {
          status: "complete",
          summary: "Too late; this worker lost its lease.",
        })

        expect(late.state).toBe("failed")
        expect(late.phase).toBe("stale")
        const finalSnapshot = await svc.snapshot(draft.id)
        expect(finalSnapshot.workflow.state).toBe("sleeping")
        expect(finalSnapshot.workflow.metrics.turns).toBe(0)
        expect(finalSnapshot.artifacts).toHaveLength(0)
        expect(finalSnapshot.events.at(-1)?.title).toBe("Stale loop run recovered")
      },
    })
  })

  test("late failures from reconciled stale runs do not schedule retries or overwrite workflow state", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Ignore stale failure",
          objective: "Do not trust failure callbacks from a recovered stale run.",
          trigger: { mode: "interval", intervalMs: 120_000 },
          policy: { maxTurns: 5 },
        })
        await svc.activate(draft.id)
        const stuck = await svc.startRunWithLease(draft.id, "runner-stale")
        const expired = Date.now() - 1
        Database.use((db) => {
          const row = db.select().from(LoopRunTable).where(eq(LoopRunTable.id, stuck.id)).get()!
          db.update(LoopRunTable)
            .set({
              data: {
                ...row.data,
                lease: {
                  holder: "runner-stale",
                  acquired: expired - 1_000,
                  heartbeat: expired - 1_000,
                  expires: expired,
                },
              },
            })
            .where(eq(LoopRunTable.id, stuck.id))
            .run()
        })

        const recovered = await svc.snapshot(draft.id)
        expect(recovered.workflow.state).toBe("sleeping")
        expect(recovered.runs[0]?.state).toBe("failed")

        const late = await svc.failRunWithError(draft.id, stuck.id, "Provider timeout while streaming response", "transient")

        expect(late.state).toBe("failed")
        expect(late.phase).toBe("stale")
        expect(late.retry).toBeUndefined()
        const finalSnapshot = await svc.snapshot(draft.id)
        expect(finalSnapshot.workflow.state).toBe("sleeping")
        expect(finalSnapshot.workflow.phase).toBe("waiting")
        expect(finalSnapshot.workflow.metrics.failures).toBe(1)
        expect(finalSnapshot.workflow.failureClass).toBeUndefined()
        expect(finalSnapshot.workflow.nextWakeup).toBeLessThanOrEqual(Date.now())
        expect(finalSnapshot.events.at(-1)?.title).toBe("Stale loop run recovered")
      },
    })
  })

  test("zero maxTurns cannot archive an interval loop before its first run", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Hourly watch",
          objective: "Run a briefing every hour.",
          trigger: { mode: "interval", intervalMs: 3_600_000 },
          policy: { maxTurns: 0 },
        })
        const active = await svc.activate(draft.id)

        expect(active.policy.maxTurns).toBe(30)
        expect(active.state).toBe("sleeping")
        expect(active.nextWakeup).toBeLessThanOrEqual(Date.now())
        expect((await svc.list()).find((item) => item.id === draft.id)).toMatchObject({ state: "sleeping" })
        expect((await svc.due(Date.now())).map((item) => item.id)).toContain(draft.id)
      },
    })
  })

  test("max-goal loops do not invent a budget when no cap is configured", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Uncapped goal",
          objective: "Keep working until the goal is verified.",
          budgetMode: "max-goal",
        })
        const active = await svc.activate(draft.id)

        expect(active.policy.maxTurns).toBeUndefined()
        expect(active.spec.costBudget).toBeUndefined()
      },
    })
  })

  test("unbounded monitor loops omit the turn cap even when maxTurns is supplied", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Unbounded hourly watch",
          objective: "Keep monitoring until stopped.",
          trigger: { mode: "interval", intervalMs: 3_600_000 },
          budgetMode: "unbounded-monitor",
          policy: { maxTurns: 1 },
        })
        const active = await svc.activate(draft.id)

        expect(active.policy.maxTurns).toBeUndefined()
        expect(active.state).toBe("sleeping")
        expect(active.nextWakeup).toBeLessThanOrEqual(Date.now())
        expect((await svc.list()).find((item) => item.id === draft.id)).toMatchObject({ state: "sleeping" })
      },
    })
  })

  test("unbounded interval monitors keep sleeping when a checkpoint reports complete", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Hourly monitor",
          objective: "Monitor forever until explicitly stopped.",
          trigger: { mode: "interval", intervalMs: 3_600_000 },
          budgetMode: "unbounded-monitor",
        })
        await svc.activate(draft.id)

        const started = await svc.startRun(draft.id)
        await svc.completeRun(draft.id, started.id, { status: "complete", summary: "Healthy check completed." })

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("sleeping")
        expect(snapshot.workflow.phase).toBe("waiting")
        expect(snapshot.workflow.nextWakeup).toBeGreaterThan(Date.now())
        expect(snapshot.workflow.metrics.turns).toBe(1)
        expect(snapshot.events.at(-1)?.data?.completed).toBe(false)
      },
    })
  })

  test("zero token caps do not block unbounded monitors and informational gates keep cadence", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Safe monitor budget",
          objective: "Keep monitoring without an accidental zero token cap.",
          trigger: { mode: "interval", intervalMs: 3_600_000 },
          budgetMode: "unbounded-monitor",
          costBudget: { maxTokens: 0 },
        })
        const active = await svc.activate(draft.id)
        expect(active.spec.costBudget).toBeUndefined()

        const started = await svc.startRun(draft.id)
        await run(LoopWorkflowService.use((loop) => loop.completeRun({
          id: draft.id,
          runID: started.id,
          reason: "Snapshots are stale; report blocked_stale_data.",
          checkpoint: { status: "blocked", summary: "Snapshots are stale; report blocked_stale_data." },
          gateResults: [{ id: "snapshot-freshness", status: "blocked", summary: "Inputs are stale.", failureClass: "quality" }],
        })))

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow).toMatchObject({ state: "sleeping", phase: "waiting" })
        expect(snapshot.runs[0]?.state).toBe("completed")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "snapshot-freshness")?.status).toBe("blocked")
      },
    })
  })

  test("unbounded scheduled monitors keep cadence when a checkpoint reports an informational blocker", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Blocked hourly monitor",
          objective: "Keep monitoring and report stale inputs without stopping the schedule.",
          trigger: { mode: "interval", intervalMs: 3_600_000 },
          budgetMode: "unbounded-monitor",
        })
        await svc.activate(draft.id)

        const started = await svc.startRun(draft.id)
        await svc.completeRun(draft.id, started.id, { status: "blocked", summary: "Inputs are stale; report blocked_stale_data." })

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("sleeping")
        expect(snapshot.workflow.phase).toBe("waiting")
        expect(snapshot.workflow.nextWakeup).toBeDefined()
        expect(snapshot.runs[0]?.state).toBe("completed")
        const nextWakeup = Number(snapshot.workflow.nextWakeup)
        expect(nextWakeup).toBeGreaterThan(Date.now())
        expect((await svc.due(nextWakeup + 1)).map((item) => item.id)).toContain(draft.id)
      },
    })
  })

  test("rehydrates legacy blocked scheduled monitors without losing their cadence", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Legacy blocked monitor",
          objective: "Recover a scheduled monitor persisted by an older runner.",
          trigger: { mode: "daily", dailyAt: "10:00", timezone: "UTC" },
          budgetMode: "unbounded-monitor",
        })
        await svc.activate(draft.id)
        Database.use((db) =>
          db.update(LoopWorkflowTable)
            .set({ next_wakeup: Date.now() - 1 })
            .where(eq(LoopWorkflowTable.id, draft.id))
            .run(),
        )
        const started = await svc.startRun(draft.id)
        await svc.completeRun(draft.id, started.id, { status: "blocked", summary: "Stale data was reported." })

        Database.use((db) => {
          const now = Date.now()
          const run = db.select().from(LoopRunTable).where(eq(LoopRunTable.id, started.id)).get()!
          db.update(LoopRunTable)
            .set({ state: "blocked", phase: "blocked", next_wakeup: null, time_updated: now, time_ended: now })
            .where(eq(LoopRunTable.id, run.id))
            .run()
          db.update(LoopWorkflowTable)
            .set({ state: "blocked", phase: "blocked", next_wakeup: null, time_updated: now })
            .where(eq(LoopWorkflowTable.id, draft.id))
            .run()
        })

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("sleeping")
        expect(snapshot.workflow.phase).toBe("waiting")
        expect(snapshot.workflow.nextWakeup).toBeDefined()
        expect(snapshot.events.at(-1)?.title).toBe("Scheduled monitor resumed")
      },
    })
  })

  test("rehydrates legacy zero token budget blocks as scheduled monitors", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Legacy zero token monitor",
          objective: "Recover a monitor that was blocked by an invalid zero cap.",
          trigger: { mode: "interval", intervalMs: 3_600_000 },
          budgetMode: "unbounded-monitor",
        })
        await svc.activate(draft.id)
        const started = await svc.startRun(draft.id)
        await svc.completeRun(draft.id, started.id, { status: "blocked", summary: "Stale data was reported." })

        Database.use((db) => {
          const now = Date.now()
          const run = db.select().from(LoopRunTable).where(eq(LoopRunTable.id, started.id)).get()!
          const workflow = db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, draft.id)).get()!
          db.update(LoopRunTable)
            .set({
              state: "blocked",
              phase: "blocked",
              next_wakeup: null,
              time_updated: now,
              time_ended: now,
              data: {
                ...run.data,
                gateResults: [{ id: "cost-budget", status: "blocked", summary: "Token budget exceeded (1/0).", failureClass: "budget" }],
              },
            })
            .where(eq(LoopRunTable.id, run.id))
            .run()
          db.update(LoopWorkflowTable)
            .set({
              state: "blocked",
              phase: "budget_exhausted",
              next_wakeup: null,
              time_updated: now,
              data: { ...workflow.data, spec: { ...workflow.data.spec, costBudget: { maxTokens: 0 } } },
            })
            .where(eq(LoopWorkflowTable.id, draft.id))
            .run()
        })

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow).toMatchObject({ state: "sleeping", phase: "waiting" })
        expect(snapshot.workflow.spec.costBudget).toBeUndefined()
        expect(snapshot.events.at(-1)?.title).toBe("Scheduled monitor resumed")
      },
    })
  })

  test("unbounded interval monitors stop only when checkpoint explicitly asks to stop", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Hourly monitor stop",
          objective: "Monitor until stop condition.",
          trigger: { mode: "interval", intervalMs: 3_600_000 },
          budgetMode: "unbounded-monitor",
        })
        await svc.activate(draft.id)

        const started = await svc.startRun(draft.id)
        await svc.completeRun(draft.id, started.id, { status: "stop", summary: "Stop condition met." })

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("stopped")
        expect(snapshot.workflow.phase).toBe("stopped")
        expect(snapshot.workflow.nextWakeup).toBeUndefined()
        expect(snapshot.events.at(-1)?.summary).toBe("Loop stopped after the checkpoint requested stop.")
      },
    })
  })

  test("due excludes non-interval loops without an explicit wakeup", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const manual = await svc.createDraft({
          name: "Manual loop",
          objective: "Only run on demand.",
          trigger: { mode: "manual" },
        })
        const signal = await svc.createDraft({
          name: "Signal loop",
          objective: "Wait for an explicit signal.",
          trigger: { mode: "external-signal" },
        })
        const interval = await svc.createDraft({
          name: "Interval loop",
          objective: "Wake on schedule.",
          trigger: { mode: "interval", intervalMs: 60_000 },
        })

        const activeManual = await svc.activate(manual.id)
        const activeSignal = await svc.activate(signal.id)
        const activeInterval = await svc.activate(interval.id)
        const due = await svc.due(Date.now())

        expect(activeManual.nextWakeup).toBeUndefined()
        expect(activeSignal.nextWakeup).toBeUndefined()
        expect(due.map((item) => item.id)).toContain(activeInterval.id)
        expect(due.map((item) => item.id)).not.toContain(activeManual.id)
        expect(due.map((item) => item.id)).not.toContain(activeSignal.id)
      },
    })
  })

  test("self-paced loops are due immediately and keep advancing after continue checkpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Self-paced goal",
          objective: "Keep working until the goal is verified.",
          trigger: { mode: "self-paced" },
          budgetMode: "max-goal",
          policy: { maxTurns: 3 },
        })
        const active = await svc.activate(draft.id)

        expect(active.state).toBe("sleeping")
        expect(active.nextWakeup).toBeLessThanOrEqual(Date.now())
        expect((await svc.due(Date.now())).map((item) => item.id)).toContain(draft.id)

        const checkpoint = [
          "Still working.",
          "LOOP_CHECKPOINT:",
          "status: continue",
          "summary: More work remains.",
          "evidence:",
          "- first pass completed",
          "next_action: continue",
          "confidence: medium",
        ].join("\n")
        await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })), checkpoint)

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.metrics.turns).toBe(1)
        expect(snapshot.workflow.state).toBe("sleeping")
        expect(snapshot.workflow.phase).toBe("waiting")
        expect(snapshot.workflow.nextWakeup).toBeLessThanOrEqual(Date.now())
        expect(snapshot.runs[0]?.trigger).toBe("self-paced")
        expect((await svc.due(Date.now())).map((item) => item.id)).toContain(draft.id)
      },
    })
  })

  test("self-paced unbounded monitors do not hot-loop without an interval", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Unbounded self-paced monitor",
          objective: "Do not burn turns without a cadence.",
          trigger: { mode: "self-paced" },
          budgetMode: "unbounded-monitor",
          policy: { maxTurns: 0 },
        })
        const active = await svc.activate(draft.id)

        expect(active.policy.maxTurns).toBeUndefined()
        expect(active.state).toBe("active")
        expect(active.nextWakeup).toBeUndefined()
        expect((await svc.due(Date.now())).map((item) => item.id)).not.toContain(draft.id)
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
        expect((await svc.resume(draft.id)).state).toBe("stopped")
        expect((await svc.activate(draft.id)).state).toBe("stopped")
        expect((await svc.pause(draft.id)).state).toBe("stopped")

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.events.map((event) => event.type)).toEqual(["created", "activated", "paused", "resumed", "stopped"])
      },
    })
  })

  test("stopping a working workflow terminates its active run and rejects late completion", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({ name: "Stop active run", objective: "Stop immediately when requested." })
        await svc.activate(draft.id)
        const started = await svc.startRun(draft.id)

        await svc.stop(draft.id)
        const late = await svc.completeRun(draft.id, started.id, { status: "complete", summary: "Too late." })
        const snapshot = await svc.snapshot(draft.id)
        expect(late.state).toBe("stopped")
        expect(snapshot.workflow.state).toBe("stopped")
        expect(snapshot.runs[0]).toMatchObject({ state: "stopped", phase: "stopped" })
        expect(snapshot.workflow.metrics.turns).toBe(0)
      },
    })
  })

  test("a retryable failure does not unpause a workflow mid-run", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({ name: "Paused retry", objective: "Stay paused after a transient failure." })
        await svc.activate(draft.id)
        const started = await svc.startRun(draft.id)
        await svc.pause(draft.id)
        const failed = await svc.failRunWithError(draft.id, started.id, "network timeout", "transient")

        let snapshot = await svc.snapshot(draft.id)
        expect(failed.retry?.nextWakeup).toBeDefined()
        expect(snapshot.workflow).toMatchObject({ state: "paused", phase: "paused", nextWakeup: failed.retry?.nextWakeup })
        await svc.resume(draft.id)
        snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow).toMatchObject({ state: "sleeping", phase: "waiting", nextWakeup: failed.retry?.nextWakeup })
      },
    })
  })

  test("delete removes a loop workflow and its dependent rows", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Delete me",
          objective: "Temporary workflow that should not stay in the database.",
        })
        const active = await svc.activate(draft.id)
        await svc.runOnce(active.id)

        const deleted = await svc.delete(active.id)
        expect(deleted.id).toBe(active.id)
        expect((await svc.list()).map((item) => item.id)).not.toContain(active.id)

        const rows = Database.use((db) => ({
          workflows: db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, active.id)).all().length,
          runs: db.select().from(LoopRunTable).where(eq(LoopRunTable.workflow_id, active.id)).all().length,
          events: db.select().from(LoopEventTable).where(eq(LoopEventTable.workflow_id, active.id)).all().length,
          threads: db.select().from(LoopThreadTable).where(eq(LoopThreadTable.workflow_id, active.id)).all().length,
          background: active.rootSessionID
            ? db.select().from(BackgroundSessionTable).where(eq(BackgroundSessionTable.session_id, active.rootSessionID)).all().length
            : 0,
          status: active.rootSessionID
            ? db.select().from(SessionStatusTable).where(eq(SessionStatusTable.session_id, active.rootSessionID)).all().length
            : 0,
          session: active.rootSessionID
            ? db.select().from(SessionTable).where(eq(SessionTable.id, active.rootSessionID)).all().length
            : 0,
        }))
        expect(rows).toEqual({ workflows: 0, runs: 0, events: 0, threads: 0, background: 0, status: 0, session: 0 })
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

        expect((await svc.due(active.nextWakeup)).map((item) => item.id)).toEqual([draft.id])
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
        Database.use((db) =>
          db.update(LoopWorkflowTable).set({ next_wakeup: Date.now() - 1 }).where(eq(LoopWorkflowTable.id, draft.id)).run(),
        )

        const failedStart = await svc.startRun(draft.id)
        const failed = await svc.failRun(draft.id, failedStart.id)
        expect(failed.state).toBe("failed")
        snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("failed")
        expect(snapshot.workflow.metrics.failures).toBe(1)
      },
    })
  })

  test("transient run failures schedule a retry with backoff instead of killing the workflow", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Retry transient failure",
          objective: "Retry provider hiccups safely.",
          trigger: { mode: "interval", intervalMs: 60_000 },
          policy: { maxTurns: 5 },
        })
        await svc.activate(draft.id)
        const started = await svc.startRun(draft.id)

        const failed = await svc.failRunWithError(draft.id, started.id, "Provider timeout while streaming response", "transient")

        expect(failed.state).toBe("failed")
        expect(failed.phase).toBe("retry_scheduled")
        expect(failed.failureClass).toBe("transient")
        expect(failed.retry?.attempt).toBe(1)
        expect(failed.retry?.backoffMs).toBe(30_000)
        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("sleeping")
        expect(snapshot.workflow.phase).toBe("retry_scheduled")
        expect(snapshot.workflow.failureClass).toBe("transient")
        expect(snapshot.workflow.nextWakeup).toBe(failed.retry?.nextWakeup)
        expect(snapshot.events.at(-1)?.title).toBe("Loop run retry scheduled")
        await expect(svc.startRun(draft.id)).rejects.toThrow()
        expect((await svc.due((failed.retry?.nextWakeup ?? 0) + 1)).map((item) => item.id)).toContain(draft.id)
      },
    })
  })

  test("retryable failures become terminal after the retry budget is exhausted", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Retry cap",
          objective: "Stop retrying persistent environment failures.",
          trigger: { mode: "interval", intervalMs: 60_000 },
          policy: { maxTurns: 5 },
        })
        await svc.activate(draft.id)

        const first = await svc.startRun(draft.id)
        const firstFailure = await svc.failRunWithError(draft.id, first.id, "ENOSPC writing loop artifact", "environment")
        Database.use((db) =>
          db.update(LoopWorkflowTable).set({ next_wakeup: (firstFailure.retry?.nextWakeup ?? Date.now()) - 60_000 }).where(eq(LoopWorkflowTable.id, draft.id)).run(),
        )
        const second = await svc.startRun(draft.id)
        const secondFailure = await svc.failRunWithError(draft.id, second.id, "ENOSPC writing loop artifact", "environment")
        Database.use((db) =>
          db.update(LoopWorkflowTable).set({ next_wakeup: (secondFailure.retry?.nextWakeup ?? Date.now()) - 60_000 }).where(eq(LoopWorkflowTable.id, draft.id)).run(),
        )
        const third = await svc.startRun(draft.id)
        const failed = await svc.failRunWithError(draft.id, third.id, "ENOSPC writing loop artifact", "environment")

        expect(failed.state).toBe("failed")
        expect(failed.phase).toBe("failed")
        expect(failed.retry).toBeUndefined()
        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("failed")
        expect(snapshot.workflow.metrics.failures).toBe(3)
        expect(snapshot.workflow.failureClass).toBe("environment")
      },
    })
  })

  test("policy and user-input failures block without retry", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const policyDraft = await svc.createDraft({
          name: "Policy blocked",
          objective: "Do not bypass approvals.",
          trigger: { mode: "interval", intervalMs: 60_000 },
        })
        await svc.activate(policyDraft.id)
        const policyRun = await svc.startRun(policyDraft.id)
        const policyFailure = await svc.failRunWithError(policyDraft.id, policyRun.id, "Approval required for destructive shell", "policy")
        expect(policyFailure.state).toBe("blocked")
        expect(policyFailure.phase).toBe("policy_blocked")
        const policySnapshot = await svc.snapshot(policyDraft.id)
        expect(policySnapshot.workflow.state).toBe("blocked")
        expect(policySnapshot.workflow.nextWakeup).toBeUndefined()

        const inputDraft = await svc.createDraft({
          name: "Needs input",
          objective: "Ask user when required.",
          trigger: { mode: "interval", intervalMs: 60_000 },
        })
        await svc.activate(inputDraft.id)
        const inputRun = await svc.startRun(inputDraft.id)
        const inputFailure = await svc.failRunWithError(inputDraft.id, inputRun.id, "Needs user input to choose a target branch", "user_input")
        expect(inputFailure.state).toBe("needs_input")
        expect(inputFailure.phase).toBe("needs_input")
        const inputSnapshot = await svc.snapshot(inputDraft.id)
        expect(inputSnapshot.workflow.state).toBe("needs_input")
        expect(inputSnapshot.workflow.nextWakeup).toBeUndefined()
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
        expect(executed.promptCalls[0]?.tools).toEqual({ loop: false })
        expect(promptInputText(executed.promptCalls[0])).toContain("Do not call the loop tool from inside a loop iteration")
        expect((await svc.snapshot(draft.id)).workflow.metrics.turns).toBe(1)
      },
    })
  })

  test("loop runner passes the scheduler clock through due dispatch", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const base = Date.parse("2026-07-31T12:00:00Z")
        const draft = await svc.createDraft({
          name: "Runner fake clock",
          objective: "Rearm the interval from the scheduler clock.",
          trigger: { mode: "interval", intervalMs: 60_000 },
          budgetMode: "unbounded-monitor",
        })
        await run(LoopWorkflowService.use((loop) => loop.activate({ id: draft.id, reason: "fake clock", now: base })))

        const result = await runRunner(
          LoopRunner.Service.use((runner) => runner.runDue({ now: base, limit: 1, execute: true })),
          [
            "LOOP_CHECKPOINT:",
            "status: continue",
            "summary: Healthy interval check.",
            "evidence:",
            "- scheduler check completed",
            "next_action: sleep_until_next_interval",
            "confidence: high",
          ].join("\n"),
        )

        expect(result.prompts).toBe(1)
        expect(result.value[0]).toMatchObject({ workflowID: draft.id, state: "completed" })
        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow).toMatchObject({
          state: "sleeping",
          nextWakeup: base + 60_000,
          scheduler: { lastRunID: result.value[0]?.runID, lastRunState: "completed", degraded: false },
        })
      },
    })
  })

  test("loop runner starts every due loop even when one prompt remains pending", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const base = Date.parse("2026-07-31T12:00:00Z")
        const drafts = await Promise.all([
          svc.createDraft({
            name: "Pending permission monitor",
            objective: "Wait for operator input without starving another loop.",
            trigger: { mode: "interval", intervalMs: 60_000 },
            budgetMode: "unbounded-monitor",
          }),
          svc.createDraft({
            name: "Independent monitor",
            objective: "Run even while another loop is waiting.",
            trigger: { mode: "interval", intervalMs: 60_000 },
            budgetMode: "unbounded-monitor",
          }),
        ])
        await Promise.all(drafts.map((draft) =>
          run(LoopWorkflowService.use((loop) => loop.activate({ id: draft.id, reason: "concurrency test", now: base }))),
        ))

        const releaseFirst = Promise.withResolvers<void>()
        const secondStarted = Promise.withResolvers<void>()
        let prompts = 0
        const checkpoint = [
          "LOOP_CHECKPOINT:",
          "status: continue",
          "summary: Concurrent scheduler check completed.",
          "evidence:",
          "- scheduler check completed",
          "next_action: sleep_until_next_interval",
          "confidence: high",
        ].join("\n")
        const promptLayer = Layer.succeed(
          SessionPrompt.Service,
          SessionPrompt.Service.of({
            cancel: () => Effect.void,
            cancelQueued: () => Effect.succeed(false),
            interrupt: () => Effect.void,
            prompt: () => Effect.promise(async () => {
              prompts++
              if (prompts === 1) await releaseFirst.promise
              else secondStarted.resolve()
              return promptMessage(checkpoint)
            }),
            promptAsync: () => Effect.succeed(promptMessage(checkpoint)),
            loop: () => Effect.succeed(promptMessage()),
            shell: () => Effect.succeed(promptMessage()),
            command: () => Effect.succeed(promptMessage()),
            resolvePromptParts: () => Effect.succeed([]),
          }),
        )
        const execution = Effect.runPromise(
          LoopRunner.Service.use((runner) => runner.runDue({ now: base, limit: 2, execute: true })).pipe(
            Effect.provide(Layer.mergeAll(loopWorkflowLayer, LoopRunner.defaultLayer, Session.defaultLayer, promptLayer)),
          ),
        )

        try {
          await Promise.race([
            secondStarted.promise,
            Bun.sleep(1_000).then(() => Promise.reject(new Error("second due loop was starved"))),
          ])
        } finally {
          releaseFirst.resolve()
        }

        const result = await execution
        expect(prompts).toBe(2)
        expect(result).toHaveLength(2)
        expect(result.every((item) => item.state === "completed")).toBe(true)
      },
    })
  })

  test("permission state is visible on a loop and approval resumes the same run", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Visible permission",
          objective: "Expose permission waits without ending the active run.",
          trigger: { mode: "interval", intervalMs: 60_000 },
        })
        const active = await svc.activate(draft.id)
        const run = await svc.startRunWithLease(draft.id, `loop-runner:${process.pid}:permission-state`)

        markPermissionPending({ sessionID: active.rootSessionID!, permission: "bash", patterns: ["uv run python"] }, 10)
        await Bun.sleep(20)
        const pending = await svc.snapshot(draft.id)
        expect(pending.workflow).toMatchObject({ state: "needs_input", phase: "needs_input" })
        expect(pending.runs[0]).toMatchObject({ id: run.id, state: "working" })
        expect(Database.use((db) =>
          db.select().from(BackgroundSessionTable).where(eq(BackgroundSessionTable.session_id, active.rootSessionID!)).get()?.data.state,
        )).toBe("needs_input")

        markPermissionResolved(active.rootSessionID!)
        const resumed = await svc.snapshot(draft.id)
        expect(resumed.workflow).toMatchObject({ state: "working", phase: "executing" })
        expect(resumed.runs[0]).toMatchObject({ id: run.id, state: "working" })
      },
    })
  })

  test("loop runner skips execution when another leased run is already active", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Active lease guard",
          objective: "Do not execute twice when a runner already holds the lease.",
          trigger: { mode: "interval", intervalMs: 60_000 },
        })
        await svc.activate(draft.id)
        const activeRun = await svc.startRunWithLease(draft.id, "runner-a")

        const skipped = await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })))

        expect(skipped.value).toMatchObject({
          workflowID: draft.id,
          runID: activeRun.id,
          state: "skipped",
        })
        expect(skipped.value.summary).toContain("skipping duplicate execution")
        expect(skipped.prompts).toBe(0)
        expect((await svc.snapshot(draft.id)).workflow.metrics.turns).toBe(0)
      },
    })
  })

  test("loop runner does not restart blocked workflows or spend another run", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Blocked safety gate",
          objective: "Do not restart after a safety gate blocks the workflow.",
          trigger: { mode: "interval", intervalMs: 60_000 },
        })
        await svc.activate(draft.id)
        const first = await svc.startRun(draft.id)
        await svc.completeRun(draft.id, first.id, {
          status: "blocked",
          summary: "A safety gate requires operator action.",
        })

        const skipped = await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })))

        expect(skipped.value).toMatchObject({ workflowID: draft.id, state: "skipped" })
        expect(skipped.value.summary).toContain("blocked")
        expect(skipped.prompts).toBe(0)
        expect((await svc.snapshot(draft.id)).runs).toHaveLength(1)
        await expect(svc.startRun(draft.id)).rejects.toThrow()
      },
    })
  })

  test("loop runner disables self-loop tool calls and mutating tools in report-only workflows", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Report-only monitor",
          objective: "Inspect status and report findings without editing files.",
          gates: ["report-only"],
          policy: {
            requireApprovalFor: ["edit", "write", "apply_patch", "shell", "subagent", "push", "merge", "release", "version-bump", "external-send", "destructive-shell", "broad-refactor"],
          },
        })
        await svc.activate(draft.id)

        const executed = await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true, reportOnly: true })))

        expect(executed.value.state).toBe("completed")
        expect(executed.promptCalls[0]?.tools).toEqual({
          loop: false,
          edit: false,
          write: false,
          apply_patch: false,
          bash: false,
          task: false,
          todowrite: false,
          memory: false,
          memory_graph: false,
        })
        expect(promptInputText(executed.promptCalls[0])).toContain("REPORT-ONLY MODE")
      },
    })
  })

  test("loop runner enforces shadow-mode non-mutation for read-only workspace loops", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Read-only shadow monitor",
          objective: "Inspect the repository and recommend safe next actions without mutations.",
          workspace: { mode: "read-only" },
          policy: { maxTurns: 2 },
        })
        await svc.activate(draft.id)

        const executed = await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })))

        expect(executed.value.state).toBe("completed")
        expect(executed.prompts).toBe(1)
        expect(executed.promptCalls[0]?.tools).toEqual({
          loop: false,
          edit: false,
          write: false,
          apply_patch: false,
          bash: false,
          task: false,
          todowrite: false,
          memory: false,
          memory_graph: false,
        })
        expect(promptInputText(executed.promptCalls[0])).toContain("REPORT-ONLY MODE")
        expect(promptInputText(executed.promptCalls[0])).toContain("Do not edit files")
        expect(promptInputText(executed.promptCalls[0])).toContain("Do not run mutating shell commands")
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
        expect(executed.promptCalls[0]?.tools).toEqual({ loop: false })
        expect(promptInputText(executed.promptCalls[0])).not.toContain("REPORT-ONLY MODE")
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
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "success-checks")?.status).toBe("pass")
        expect(snapshot.artifacts.map((artifact) => artifact.kind)).toEqual(["checkpoint", "gate", "gate"])
        expect(snapshot.artifacts.find((artifact) => artifact.kind === "checkpoint")?.evidence).toContain("bun test focused passed")
        expect(snapshot.artifacts.find((artifact) => artifact.title === "Gate: success-checks")?.status).toBe("pass")
        expect(snapshot.events.at(-1)?.summary).toBe("Loop completed after the goal checkpoint reported success.")
      },
    })
  })

  test("artifact ledger redacts secrets and truncates oversized evidence before persistence", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Artifact redaction",
          objective: "Persist safe evidence only.",
          budgetMode: "max-goal",
          policy: { maxTurns: 5 },
        })
        await svc.activate(draft.id)
        const started = await svc.startRun(draft.id)

        await run(LoopWorkflowService.use((loop) =>
          loop.completeRun({
            id: draft.id,
            runID: started.id,
            checkpoint: {
              status: "continue",
              summary: "Checked with Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
              evidence: [
                `token=secret-token-value ${"x".repeat(1_500)}`,
                'payload={"token":"json-secret-value"}',
                "validated with sk-abcdefghijklmnopqrstuvwxyz123456",
              ],
              nextAction: 'Retry after setting payload={"password":"hunter2"}',
            },
          }),
        ))

        const snapshot = await svc.snapshot(draft.id)
        const checkpoint = snapshot.artifacts.find((artifact) => artifact.kind === "checkpoint")
        expect(checkpoint?.summary).toContain("Authorization:[REDACTED]")
        expect(checkpoint?.summary).not.toContain("abcdefghijklmnopqrstuvwxyz")
        expect(checkpoint?.evidence?.[0]).toContain("token=[REDACTED]")
        expect(checkpoint?.evidence?.[0]).toContain("artifact truncated")
        expect(checkpoint?.evidence?.[1]).toContain("[REDACTED]")
        expect(checkpoint?.evidence?.[1]).not.toContain("json-secret-value")
        expect(checkpoint?.evidence?.[2]).toContain("[REDACTED_SECRET]")
        expect(JSON.stringify(checkpoint?.metadata)).toContain("[REDACTED]")
        expect(JSON.stringify(checkpoint?.metadata)).not.toContain("hunter2")
        expect(snapshot.runs[0]?.checkpoint?.summary).toContain("Authorization:[REDACTED]")
        expect(snapshot.runs[0]?.checkpoint?.evidence?.[0]).toContain("token=[REDACTED]")
        expect(JSON.stringify(snapshot.runs[0]?.checkpoint)).not.toContain("secret-token-value")
        expect(JSON.stringify(snapshot.runs[0]?.checkpoint)).not.toContain("hunter2")
        expect(JSON.stringify(snapshot.events.at(-1)?.data)).toContain("Authorization:[REDACTED]")
        expect(JSON.stringify(snapshot.events.at(-1)?.data)).not.toContain("secret-token-value")
        expect((snapshot.workflow.memory?.entries ?? []).some((entry) => entry.summary.includes("[REDACTED]"))).toBe(true)
      },
    })
  })

  test("artifact ledger prunes oldest artifacts after retention limit", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Artifact retention",
          objective: "Keep recent artifacts bounded.",
          budgetMode: "max-goal",
          policy: { maxTurns: 80 },
        })
        await svc.activate(draft.id)

        for (let index = 0; index < 45; index++) {
          const started = await svc.startRun(draft.id)
          await run(LoopWorkflowService.use((loop) =>
            loop.completeRun({
              id: draft.id,
              runID: started.id,
              checkpoint: {
                status: "continue",
                summary: `checkpoint ${index}`,
              },
              gateResults: [
                { id: `gate-a-${index}`, status: "pass", summary: `gate a ${index}`, failureClass: "none" },
                { id: `gate-b-${index}`, status: "skip", summary: `gate b ${index}`, failureClass: "none" },
              ],
            }),
          ))
        }

        const snapshot = await run(LoopWorkflowService.use((loop) => loop.snapshot(draft.id, 200)))
        expect(snapshot.artifacts).toHaveLength(120)
        expect(snapshot.artifacts[0]?.summary).not.toBe("checkpoint 0")
        expect(snapshot.artifacts.at(-1)?.summary).toBe("gate b 44")
        expect(snapshot.artifacts.map((artifact) => artifact.sequence)).toEqual([...snapshot.artifacts.map((artifact) => artifact.sequence)].sort((a, b) => a - b))
      },
    })
  })

  test("completeRun records runtime loop memory entries", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Memory lifecycle",
          objective: "Carry useful loop state between runs.",
          budgetMode: "max-goal",
          completionCriteria: ["state carried"],
          evaluation: { mode: "independent" },
          policy: { maxTurns: 3 },
        })
        await svc.activate(draft.id)
        const started = await svc.startRun(draft.id)

        await run(LoopWorkflowService.use((loop) =>
          loop.completeRun({
            id: draft.id,
            runID: started.id,
            checkpoint: {
              status: "complete",
              summary: "Implemented the memory path.",
              nextAction: "Rerun focused tests after fixing the parser.",
            },
            judgment: {
              status: "fail",
              summary: "Completion is not accepted because focused tests were not shown.",
              recommendedNextAction: "Run the focused tests and report their output.",
            },
            gateResults: [{ id: "independent-evaluator", status: "fail", summary: "Missing test evidence.", failureClass: "quality" }],
          }),
        ))

        const memory = (await svc.snapshot(draft.id)).workflow.memory?.entries ?? []
        expect(memory.map((entry) => entry.section)).toContain("tried")
        expect(memory.find((entry) => entry.section === "tried")?.summary).toBe("Implemented the memory path.")
        expect(memory.find((entry) => entry.section === "open")?.summary).toBe("Rerun focused tests after fixing the parser.")
        expect(memory.find((entry) => entry.section === "rejected")?.summary).toContain("Missing test evidence")
        expect(memory.find((entry) => entry.section === "rejected" && entry.source === "independent-evaluator")?.summary).toContain("not accepted")
      },
    })
  })

  test("runtime loop memory respects configured sections", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Scoped memory",
          objective: "Keep only open items.",
          budgetMode: "max-goal",
          memory: { sections: ["open"] },
          policy: { maxTurns: 3 },
        })
        await svc.activate(draft.id)
        const started = await svc.startRun(draft.id)

        await run(LoopWorkflowService.use((loop) =>
          loop.completeRun({
            id: draft.id,
            runID: started.id,
            checkpoint: {
              status: "continue",
              summary: "Checked the current state.",
              nextAction: "Implement the missing persistence hook.",
            },
          }),
        ))

        const memory = (await svc.snapshot(draft.id)).workflow.memory?.entries ?? []
        expect(memory).toHaveLength(1)
        expect(memory[0]?.section).toBe("open")
        expect(memory[0]?.summary).toBe("Implement the missing persistence hook.")
      },
    })
  })

  test("runner includes runtime loop memory in subsequent prompts", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Prompt memory",
          objective: "Continue work without forgetting previous runs.",
          budgetMode: "max-goal",
          policy: { maxTurns: 4 },
        })
        await svc.activate(draft.id)

        await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
          [
            "Still working.",
            "LOOP_CHECKPOINT:",
            "status: continue",
            "summary: Inspected the parser and found the missing memory hook.",
            "evidence:",
            "- parser path inspected",
            "next_action: Add the memory hook before the next run.",
            "confidence: medium",
          ].join("\n"),
        )

        const next = await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true, reportOnly: true })),
          "LOOP_CHECKPOINT:\nstatus: continue\nsummary: inspected\nevidence:\n- noop\nnext_action: continue\nconfidence: low",
        )

        const prompt = promptInputText(next.promptCalls[0])
        expect(prompt).toContain("Loop memory from previous runs:")
        expect(prompt).toContain("Inspected the parser and found the missing memory hook.")
        expect(prompt).toContain("Add the memory hook before the next run.")
      },
    })
  })

  test("stale run reconciliation preserves runtime loop memory", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Recovered memory",
          objective: "Keep loop memory after crash recovery.",
          budgetMode: "max-goal",
          policy: { maxTurns: 4 },
        })
        await svc.activate(draft.id)
        const first = await svc.startRun(draft.id)
        await run(LoopWorkflowService.use((loop) =>
          loop.completeRun({
            id: draft.id,
            runID: first.id,
            checkpoint: {
              status: "continue",
              summary: "Confirmed the missing persistence hook.",
              nextAction: "Add the persistence hook before retrying.",
            },
          }),
        ))

        const second = await svc.startRunWithLease(draft.id, "runner-stale")
        const expired = Date.now() - 1
        Database.use((db) => {
          const row = db.select().from(LoopRunTable).where(eq(LoopRunTable.id, second.id)).get()!
          db.update(LoopRunTable)
            .set({
              data: {
                ...row.data,
                lease: {
                  holder: "runner-stale",
                  acquired: expired - 1_000,
                  heartbeat: expired - 1_000,
                  expires: expired,
                },
              },
            })
            .where(eq(LoopRunTable.id, second.id))
            .run()
        })

        const snapshot = await svc.snapshot(draft.id)
        const memory = snapshot.workflow.memory?.entries ?? []
        expect(snapshot.workflow.state).toBe("active")
        expect(memory.find((entry) => entry.section === "tried")?.summary).toBe("Confirmed the missing persistence hook.")
        expect(memory.find((entry) => entry.section === "open")?.summary).toBe("Add the persistence hook before retrying.")
      },
    })
  })

  test("completeRun rolls back workflow updates if artifact persistence fails", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Artifact rollback",
          objective: "Prove completion updates stay atomic with artifact writes.",
          budgetMode: "max-goal",
          completionCriteria: ["done"],
          policy: { maxTurns: 3 },
        })
        await svc.activate(draft.id)
        const started = await svc.startRun(draft.id)

        Database.use((db) => db.run("DROP TABLE loop_artifact"))

        try {
          await expect(
            svc.completeRun(draft.id, started.id, {
              status: "complete",
              summary: "Checkpoint that should roll back with artifact failure.",
            }),
          ).rejects.toThrow()

          Database.use((db) => {
            const workflowRow = db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, draft.id)).get()!
            const runRow = db.select().from(LoopRunTable).where(eq(LoopRunTable.id, started.id)).get()!
            expect(workflowRow.state).toBe("working")
            expect(workflowRow.data.metrics.turns ?? 0).toBe(0)
            expect(runRow.state).toBe("working")
            expect(runRow.time_ended).toBeNull()
          })
        } finally {
          Database.use((db) => {
            db.run("CREATE TABLE loop_artifact (id text PRIMARY KEY NOT NULL, workflow_id text NOT NULL, run_id text, session_id text, sequence integer NOT NULL, kind text NOT NULL, title text NOT NULL, summary text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text, FOREIGN KEY (workflow_id) REFERENCES loop_workflow(id) ON DELETE cascade, FOREIGN KEY (run_id) REFERENCES loop_run(id) ON DELETE set null, FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE set null)")
            db.run("CREATE INDEX loop_artifact_workflow_sequence_idx ON loop_artifact (workflow_id, sequence)")
            db.run("CREATE INDEX loop_artifact_workflow_time_idx ON loop_artifact (workflow_id, time_created)")
            db.run("CREATE INDEX loop_artifact_run_idx ON loop_artifact (run_id)")
            db.run("CREATE INDEX loop_artifact_kind_idx ON loop_artifact (kind)")
          })
        }
      },
    })
  })

  test("max-goal loops trim configured success-check strings before matching evidence", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Trimmed success checks",
          objective: "Complete when padded success-check text still matches evidence.",
          budgetMode: "max-goal",
          completionCriteria: ["bug fixed"],
          successChecks: ["  bun test focused  "],
          evaluation: { mode: "deterministic" },
          policy: { maxTurns: 3 },
        })
        await svc.activate(draft.id)

        const checkpoint = [
          "Done.",
          "LOOP_CHECKPOINT:",
          "status: complete",
          "summary: Bug fixed.",
          "evidence:",
          "- bun test focused passed",
          "next_action: stop",
          "confidence: high",
        ].join("\n")
        await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })), checkpoint)

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("completed")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "success-checks")?.status).toBe("pass")
      },
    })
  })

  test("max-goal loops do not complete when success check evidence is missing", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Evidence gated goal",
          objective: "Finish only with deterministic success-check evidence.",
          budgetMode: "max-goal",
          completionCriteria: ["bug fixed"],
          successChecks: ["bun test focused"],
          evaluation: { mode: "deterministic" },
          policy: { maxTurns: 3 },
        })
        await svc.activate(draft.id)

        const checkpoint = [
          "Done.",
          "LOOP_CHECKPOINT:",
          "status: complete",
          "summary: Bug fixed.",
          "evidence:",
          "- changed the implementation",
          "next_action: stop",
          "confidence: high",
        ].join("\n")
        await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })), checkpoint)

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.metrics.turns).toBe(1)
        expect(snapshot.workflow.state).toBe("active")
        expect(snapshot.workflow.phase).toBe("ready")
        expect(snapshot.workflow.evaluatorReason).toContain("Completion gate did not pass")
        expect(snapshot.runs[0]?.state).toBe("completed")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "success-checks")).toMatchObject({
          status: "fail",
          failureClass: "quality",
        })
      },
    })
  })

  test("success-check gates require evidence bullets, not summary-only claims", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Summary-only evidence gate",
          objective: "Finish only with explicit validation evidence.",
          budgetMode: "max-goal",
          completionCriteria: ["bug fixed"],
          successChecks: ["bun test focused"],
          evaluation: { mode: "deterministic" },
          policy: { maxTurns: 3 },
        })
        await svc.activate(draft.id)

        const checkpoint = [
          "Done.",
          "LOOP_CHECKPOINT:",
          "status: complete",
          "summary: Bug fixed and bun test focused passed.",
          "evidence:",
          "- changed the implementation",
          "next_action: stop",
          "confidence: high",
        ].join("\n")
        await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })), checkpoint)

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("active")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "success-checks")?.status).toBe("fail")
      },
    })
  })

  test("success-check gates ignore surrounding whitespace in configured checks", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Trimmed success check",
          objective: "Finish only when the trimmed check is evidenced.",
          budgetMode: "max-goal",
          completionCriteria: ["bug fixed"],
          successChecks: ["  bun test focused  "],
          evaluation: { mode: "deterministic" },
          policy: { maxTurns: 3 },
        })
        await svc.activate(draft.id)

        const checkpoint = [
          "Done.",
          "LOOP_CHECKPOINT:",
          "status: complete",
          "summary: Bug fixed.",
          "evidence:",
          "- bun test focused passed",
          "next_action: stop",
          "confidence: high",
        ].join("\n")
        await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })), checkpoint)

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("completed")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "success-checks")?.status).toBe("pass")
      },
    })
  })

  test("checkpoint parsing accepts fenced and indented loop blocks", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Fenced checkpoint goal",
          objective: "Complete when the checkpoint is clearly satisfied.",
          budgetMode: "max-goal",
          completionCriteria: ["goal satisfied"],
          policy: { maxTurns: 3 },
        })
        await svc.activate(draft.id)

        const checkpoint = [
          "Done.",
          "LOOP_CHECKPOINT:",
          "```yaml",
          "  status: complete",
          "  summary: Fenced checkpoint parsed successfully.",
          "  evidence:",
          "    - focused validation passed",
          "  next action: stop",
          "  confidence: high",
          "```",
        ].join("\n")
        await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })), checkpoint)

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("completed")
        expect(snapshot.runs[0]?.checkpoint?.status).toBe("complete")
        expect(snapshot.runs[0]?.checkpoint?.nextAction).toBe("stop")
      },
    })
  })

  test("checkpoint parsing keeps evidence bullets after a blank line", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Blank-line checkpoint evidence",
          objective: "Complete when evidence survives common model spacing.",
          budgetMode: "max-goal",
          completionCriteria: ["goal satisfied"],
          successChecks: ["focused validation passed"],
          evaluation: { mode: "deterministic" },
          policy: { maxTurns: 3 },
        })
        await svc.activate(draft.id)

        const checkpoint = [
          "Done.",
          "LOOP_CHECKPOINT:",
          "status: complete",
          "summary: Blank-line evidence still parses.",
          "evidence:",
          "",
          "- focused validation passed",
          "next_action: stop",
          "confidence: high",
        ].join("\n")
        await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })), checkpoint)

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("completed")
        expect(snapshot.runs[0]?.checkpoint?.evidence).toEqual(["focused validation passed"])
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "success-checks")?.status).toBe("pass")
      },
    })
  })

  test("independent max-goal loops complete only after evaluator passes the proposal", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Judged goal",
          objective: "Finish only when the judge accepts the evidence.",
          budgetMode: "max-goal",
          completionCriteria: ["evidence supports completion"],
          policy: { maxTurns: 5 },
          evaluation: { mode: "independent", requireIndependentForCompletion: true },
        })
        const active = await svc.activate(draft.id)

        const worker = [
          "Done.",
          "LOOP_CHECKPOINT:",
          "status: complete",
          "summary: Worker believes the goal is complete.",
          "evidence:",
          "- focused validation passed",
          "next_action: stop",
          "confidence: high",
        ].join("\n")
        const judge = [
          "Verified.",
          "LOOP_JUDGMENT:",
          "status: pass",
          "summary: The evidence is sufficient for completion.",
          "evidence:",
          "- focused validation passed",
          "recommended_next_action: complete",
          "confidence: high",
        ].join("\n")

        const executed = await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
          (call) => (call === 1 ? worker : judge),
        )

        const rootSessionID = active.rootSessionID!
        expect(executed.prompts).toBe(2)
        expect(executed.value.state).toBe("completed")
        expect(executed.promptCalls[0]?.sessionID).toBe(rootSessionID)
        expect(executed.promptCalls[1]?.sessionID).not.toBe(rootSessionID)
        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("completed")
        expect(snapshot.runs[0]?.judgment?.status).toBe("pass")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "independent-evaluator")?.status).toBe("pass")
        expect(snapshot.artifacts.map((artifact) => artifact.kind)).toEqual(["checkpoint", "judgment", "gate", "gate"])
        expect(snapshot.artifacts.find((artifact) => artifact.kind === "judgment")?.source).toBe("evaluator")
        expect(snapshot.workflow.evaluatorReason).toBe("The evidence is sufficient for completion.")
      },
    })
  })

  test("independent evaluator usage counts toward loop metrics and usage artifacts", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Judged usage accounting",
          objective: "Count worker and evaluator usage together.",
          budgetMode: "max-goal",
          completionCriteria: ["evidence supports completion"],
          policy: { maxTurns: 5 },
          evaluation: { mode: "independent", requireIndependentForCompletion: true },
        })
        await svc.activate(draft.id)

        const worker = promptMessage(
          [
            "Done.",
            "LOOP_CHECKPOINT:",
            "status: complete",
            "summary: Worker believes the goal is complete.",
            "evidence:",
            "- focused validation passed",
            "next_action: stop",
            "confidence: high",
          ].join("\n"),
          {
            cost: 1.25,
            tokens: { input: 11, output: 7, reasoning: 3, cache: { read: 2, write: 1 } },
          },
        )
        const judge = promptMessage(
          [
            "Verified.",
            "LOOP_JUDGMENT:",
            "status: pass",
            "summary: The evidence is sufficient for completion.",
            "evidence:",
            "- focused validation passed",
            "recommended_next_action: complete",
            "confidence: high",
          ].join("\n"),
          {
            cost: 0.75,
            tokens: { input: 5, output: 4, reasoning: 2, cache: { read: 1, write: 0 } },
          },
        )

        await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
          (call) => (call === 1 ? worker : judge),
        )

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.metrics.cost).toBeCloseTo(2, 8)
        expect(snapshot.workflow.metrics.inputTokens).toBe(16)
        expect(snapshot.workflow.metrics.outputTokens).toBe(11)
        expect(snapshot.workflow.metrics.reasoningTokens).toBe(5)
        expect(snapshot.workflow.metrics.cacheReadTokens).toBe(3)
        expect(snapshot.workflow.metrics.cacheWriteTokens).toBe(1)
        expect(snapshot.runs[0]?.usage?.cost).toBeCloseTo(2, 8)
        expect(snapshot.runs[0]?.usage?.tokens).toEqual({
          input: 16,
          output: 11,
          reasoning: 5,
          cacheRead: 3,
          cacheWrite: 1,
        })
        expect(snapshot.artifacts.find((artifact) => artifact.kind === "cost")?.summary).toContain("cost=2.000000")
      },
    })
  })

  test("independent evaluator infrastructure failures are classified as retryable gate failures", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Evaluator infra failure",
          objective: "Retry completion verification when evaluator transport fails.",
          budgetMode: "max-goal",
          completionCriteria: ["evidence supports completion"],
          policy: { maxTurns: 5 },
          evaluation: { mode: "independent", requireIndependentForCompletion: true },
        })
        await svc.activate(draft.id)

        const worker = [
          "Done.",
          "LOOP_CHECKPOINT:",
          "status: complete",
          "summary: Worker believes the goal is complete.",
          "evidence:",
          "- focused validation passed",
          "next_action: stop",
          "confidence: high",
        ].join("\n")

        const executed = await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
          (call) => {
            if (call === 1) return worker
            throw new Error("Evaluator timeout while contacting provider")
          },
        )

        expect(executed.prompts).toBe(2)
        expect(executed.value.state).toBe("completed")
        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("active")
        expect(snapshot.runs[0]?.judgment?.status).toBe("uncertain")
        expect(snapshot.runs[0]?.judgment?.failureClass).toBe("transient")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "independent-evaluator")).toMatchObject({
          status: "blocked",
          failureClass: "transient",
        })
        expect(snapshot.workflow.evaluatorReason).toContain("Evaluator failed: Evaluator timeout while contacting provider")
      },
    })
  })

  test("independent evaluator pass still requires configured success-check evidence", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Judged success checks",
          objective: "Finish only when judge and success checks agree.",
          budgetMode: "max-goal",
          completionCriteria: ["verified fix"],
          successChecks: ["bun test focused"],
          policy: { maxTurns: 5 },
          evaluation: { mode: "independent", requireIndependentForCompletion: true },
        })
        await svc.activate(draft.id)

        const worker = [
          "Done.",
          "LOOP_CHECKPOINT:",
          "status: complete",
          "summary: Worker claims completion.",
          "evidence:",
          "- implementation updated",
          "next_action: stop",
          "confidence: high",
        ].join("\n")
        const judge = [
          "Looks acceptable.",
          "LOOP_JUDGMENT:",
          "status: pass",
          "summary: The implementation evidence is acceptable.",
          "evidence:",
          "- implementation updated",
          "recommended_next_action: complete",
          "confidence: high",
        ].join("\n")

        await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
          (call) => (call === 1 ? worker : judge),
        )

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("active")
        expect(snapshot.runs[0]?.judgment?.status).toBe("pass")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "independent-evaluator")?.status).toBe("pass")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "success-checks")?.status).toBe("fail")
        expect(snapshot.workflow.evaluatorReason).toContain("Completion gate did not pass")
      },
    })
  })

  test("independent evaluator can complete a blocked worker proposal when evidence satisfies the goal", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Judge overrides blocked worker",
          objective: "Trust independent evidence over worker uncertainty.",
          budgetMode: "max-goal",
          completionCriteria: ["artifact proves completion"],
          policy: { maxTurns: 5 },
          evaluation: { mode: "independent", requireIndependentForCompletion: true },
        })
        await svc.activate(draft.id)

        const started = await svc.startRun(draft.id)
        await run(LoopWorkflowService.use((loop) =>
          loop.completeRun({
            id: draft.id,
            runID: started.id,
            checkpoint: {
              status: "blocked",
              summary: "Worker could not decide whether the objective is done.",
              evidence: ["final artifact exists but worker is uncertain"],
              nextAction: "ask_user",
              confidence: "low",
            },
            judgment: {
              status: "pass",
              summary: "The final artifact proves the objective is complete.",
              evidence: ["final artifact satisfies the completion criteria"],
              recommendedNextAction: "complete",
              confidence: "high",
            },
            gateResults: [{ id: "independent-evaluator", status: "pass", summary: "Judge accepted final evidence.", failureClass: "none" }],
          }),
        ))

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("completed")
        expect(snapshot.workflow.phase).toBe("completed")
        expect(snapshot.runs[0]?.checkpoint?.status).toBe("blocked")
        expect(snapshot.runs[0]?.judgment?.status).toBe("pass")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "independent-evaluator")?.status).toBe("pass")
        expect(snapshot.workflow.evaluatorReason).toBe("The final artifact proves the objective is complete.")
      },
    })
  })

  test("runner still evaluates blocked worker proposals so a judge can close already-complete goals", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Runner judged blocked worker",
          objective: "Let the judge close already-complete work even if the worker reports blocked.",
          budgetMode: "max-goal",
          completionCriteria: ["artifact proves completion"],
          policy: { maxTurns: 5 },
          evaluation: { mode: "independent", requireIndependentForCompletion: true },
        })
        await svc.activate(draft.id)

        const worker = [
          "Need a second opinion.",
          "LOOP_CHECKPOINT:",
          "status: blocked",
          "summary: Worker is unsure whether the final artifact is sufficient.",
          "evidence:",
          "- final artifact exists but worker confidence is low",
          "next_action: ask_user",
          "confidence: low",
        ].join("\n")
        const judge = [
          "Verified.",
          "LOOP_JUDGMENT:",
          "status: pass",
          "summary: The final artifact proves the objective is complete.",
          "evidence:",
          "- final artifact satisfies the completion criteria",
          "recommended_next_action: complete",
          "confidence: high",
        ].join("\n")

        const executed = await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
          (call) => (call === 1 ? worker : judge),
        )

        expect(executed.prompts).toBe(2)
        expect(executed.value.state).toBe("completed")
        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("completed")
        expect(snapshot.workflow.phase).toBe("completed")
        expect(snapshot.runs[0]?.checkpoint?.status).toBe("blocked")
        expect(snapshot.runs[0]?.judgment?.status).toBe("pass")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "independent-evaluator")?.status).toBe("pass")
        expect(snapshot.workflow.evaluatorReason).toBe("The final artifact proves the objective is complete.")
      },
    })
  })

  test("blocked worker proposals with passing evaluator still require success-check evidence", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Blocked judged success checks",
          objective: "Do not close blocked work unless required validation evidence exists.",
          budgetMode: "max-goal",
          completionCriteria: ["artifact proves completion"],
          successChecks: ["focused validation passed"],
          policy: { maxTurns: 5 },
          evaluation: { mode: "independent", requireIndependentForCompletion: true },
        })
        await svc.activate(draft.id)

        const worker = [
          "Need a second opinion.",
          "LOOP_CHECKPOINT:",
          "status: blocked",
          "summary: Worker is unsure whether the final artifact is sufficient.",
          "evidence:",
          "- final artifact exists but worker confidence is low",
          "next_action: ask_user",
          "confidence: low",
        ].join("\n")
        const judge = [
          "Verified.",
          "LOOP_JUDGMENT:",
          "status: pass",
          "summary: The final artifact looks sufficient, but validation evidence is missing.",
          "evidence:",
          "- final artifact satisfies the completion criteria",
          "recommended_next_action: complete",
          "confidence: high",
        ].join("\n")

        const executed = await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
          (call) => (call === 1 ? worker : judge),
        )

        expect(executed.prompts).toBe(2)
        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("blocked")
        expect(snapshot.workflow.phase).toBe("blocked")
        expect(snapshot.runs[0]?.checkpoint?.status).toBe("blocked")
        expect(snapshot.runs[0]?.judgment?.status).toBe("pass")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "independent-evaluator")?.status).toBe("pass")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "success-checks")).toMatchObject({
          status: "fail",
          failureClass: "quality",
        })
        expect(snapshot.workflow.evaluatorReason).toBe("The final artifact looks sufficient, but validation evidence is missing.")
      },
    })
  })

  test("independent evaluator pass does not override needs-input worker checkpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Judge cannot skip required input",
          objective: "Do not complete when the worker still needs human input.",
          budgetMode: "max-goal",
          completionCriteria: ["human input is no longer required"],
          policy: { maxTurns: 5 },
          evaluation: { mode: "independent", requireIndependentForCompletion: true },
        })
        await svc.activate(draft.id)

        const started = await svc.startRun(draft.id)
        await run(LoopWorkflowService.use((loop) =>
          loop.completeRun({
            id: draft.id,
            runID: started.id,
            checkpoint: {
              status: "needs_input",
              summary: "Worker still needs a human decision before proceeding.",
              evidence: ["pending approval from user"],
              nextAction: "ask_user",
              confidence: "high",
            },
            judgment: {
              status: "pass",
              summary: "Existing artifacts look complete, but the worker asked for input.",
              evidence: ["artifact appears complete"],
              recommendedNextAction: "wait_for_user",
              confidence: "medium",
            },
            gateResults: [{ id: "independent-evaluator", status: "pass", summary: "Judge would otherwise accept the evidence.", failureClass: "none" }],
          }),
        ))

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("needs_input")
        expect(snapshot.workflow.phase).toBe("needs_input")
        expect(snapshot.runs[0]?.checkpoint?.status).toBe("needs_input")
        expect(snapshot.runs[0]?.judgment?.status).toBe("pass")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "independent-evaluator")?.status).toBe("pass")
        expect(snapshot.workflow.evaluatorReason).toBe("Worker still needs a human decision before proceeding.")
      },
    })
  })

  test("malformed independent evaluator output blocks unsafe worker self-completion", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Malformed judge output",
          objective: "Do not complete when evaluator output cannot be parsed.",
          budgetMode: "max-goal",
          completionCriteria: ["parseable evaluator pass"],
          policy: { maxTurns: 5 },
          evaluation: { mode: "independent", requireIndependentForCompletion: true },
        })
        await svc.activate(draft.id)

        const worker = [
          "Done.",
          "LOOP_CHECKPOINT:",
          "status: complete",
          "summary: Worker claims completion.",
          "evidence:",
          "- worker-only evidence",
          "next_action: stop",
          "confidence: high",
        ].join("\n")
        const malformedJudge = "Looks good to me, ship it."

        const executed = await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
          (call) => (call === 1 ? worker : malformedJudge),
        )

        expect(executed.prompts).toBe(2)
        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("active")
        expect(snapshot.workflow.phase).toBe("ready")
        expect(snapshot.runs[0]?.checkpoint?.status).toBe("complete")
        expect(snapshot.runs[0]?.judgment?.status).toBe("uncertain")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "independent-evaluator")).toMatchObject({
          status: "fail",
          failureClass: "quality",
        })
        expect(snapshot.workflow.evaluatorReason).toContain("Evaluator did not return a LOOP_JUDGMENT block")
      },
    })
  })

  test("judgment parsing accepts fenced and indented evaluator blocks", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Fenced judgment goal",
          objective: "Finish only when a fenced evaluator block passes.",
          budgetMode: "max-goal",
          completionCriteria: ["judge passes"],
          policy: { maxTurns: 5 },
          evaluation: { mode: "independent", requireIndependentForCompletion: true },
        })
        await svc.activate(draft.id)

        const worker = [
          "Done.",
          "LOOP_CHECKPOINT:",
          "status: complete",
          "summary: Worker proposes completion.",
          "evidence:",
          "- focused validation passed",
          "next_action: stop",
          "confidence: high",
        ].join("\n")
        const judge = [
          "Verified.",
          "LOOP_JUDGMENT:",
          "```yaml",
          "  status: pass",
          "  summary: Fenced judgment parsed successfully.",
          "  evidence:",
          "    - focused validation passed",
          "  recommended next action: complete",
          "  confidence: high",
          "```",
        ].join("\n")

        await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
          (call) => (call === 1 ? worker : judge),
        )

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("completed")
        expect(snapshot.runs[0]?.judgment?.status).toBe("pass")
        expect(snapshot.runs[0]?.judgment?.recommendedNextAction).toBe("complete")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "independent-evaluator")?.status).toBe("pass")
      },
    })
  })

  test("independent max-goal loops do not trust worker self-completion when evaluator fails", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Rejected goal",
          objective: "Do not complete without real evidence.",
          budgetMode: "max-goal",
          completionCriteria: ["real evidence exists"],
          policy: { maxTurns: 5 },
          evaluation: { mode: "independent", requireIndependentForCompletion: true },
        })
        await svc.activate(draft.id)

        const worker = [
          "Done.",
          "LOOP_CHECKPOINT:",
          "status: complete",
          "summary: Worker claims completion.",
          "evidence:",
          "- I think it is done",
          "next_action: stop",
          "confidence: high",
        ].join("\n")
        const judge = [
          "Not enough.",
          "LOOP_JUDGMENT:",
          "status: fail",
          "summary: The evidence is self-asserted and not sufficient.",
          "evidence:",
          "- missing concrete validation",
          "recommended_next_action: continue",
          "confidence: high",
        ].join("\n")

        await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
          (call) => (call === 1 ? worker : judge),
        )

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).toBe("active")
        expect(snapshot.workflow.phase).toBe("ready")
        expect(snapshot.runs[0]?.state).toBe("completed")
        expect(snapshot.runs[0]?.judgment?.status).toBe("fail")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "independent-evaluator")?.status).toBe("fail")
        expect(snapshot.workflow.evaluatorReason).toContain("Independent evaluator did not accept completion")
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
        expect(snapshot.runs[0]?.state).toBe("blocked")
        expect(snapshot.workflow.evaluatorReason).toContain("maximum iteration budget")
        expect(snapshot.events.at(-1)?.summary).toContain("maximum iteration budget")
      },
    })
  })

  test("budget exhaustion preserves failed success-check reasons in workflow, event, and runner summaries", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Budgeted gated goal",
          objective: "Finish only when verification evidence exists.",
          budgetMode: "max-goal",
          completionCriteria: ["verified done"],
          successChecks: ["bun test focused"],
          evaluation: { mode: "deterministic" },
          policy: { maxTurns: 1 },
        })
        await svc.activate(draft.id)

        const checkpoint = [
          "Done.",
          "LOOP_CHECKPOINT:",
          "status: complete",
          "summary: Worker claims completion without test evidence.",
          "evidence:",
          "- implementation updated",
          "next_action: stop",
          "confidence: high",
        ].join("\n")
        const executed = await runRunner(LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })), checkpoint)

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.metrics.turns).toBe(1)
        expect(snapshot.workflow.state).toBe("blocked")
        expect(snapshot.workflow.phase).toBe("budget_exhausted")
        expect(snapshot.runs[0]?.state).toBe("blocked")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "success-checks")).toMatchObject({
          status: "fail",
          failureClass: "quality",
        })
        expect(snapshot.workflow.evaluatorReason).toContain("completion gate did not pass")
        expect(snapshot.workflow.evaluatorReason).toContain("success-checks fail")
        expect(snapshot.events.at(-1)?.summary).toContain("completion gate did not pass")
        expect(executed.value.summary).toContain("completion gate did not pass")
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

        const rootSessionID = active.rootSessionID!
        expect(executed.prompts).toBe(2)
        expect(executed.promptCalls[0]?.sessionID).toBe(rootSessionID)
        expect(executed.promptCalls[1]?.sessionID).toBe(owner.id)
        expect(promptInputText(executed.promptCalls[1])).toContain("Loop workflow completed: Notify owner")
      },
    })
  })

  test("executes explicit validation commands before judgment and persists output evidence", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Executable validation",
          objective: "Complete only after a real command check passes.",
          budgetMode: "max-goal",
          validationChecks: [{ id: "diff-check", command: "git diff --check", timeoutMs: 10_000 }],
          evaluation: { mode: "deterministic" },
          policy: { maxTurns: 3 },
        })
        await svc.activate(draft.id)

        await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
          "LOOP_CHECKPOINT:\nstatus: complete\nsummary: Ready.\nevidence:\n- implementation inspected\nnext_action: stop\nconfidence: high",
        )

        const snapshot = await svc.snapshot(draft.id)
        const gate = snapshot.runs[0]?.gateResults?.find((item) => item.id === "validation:diff-check")
        expect(snapshot.workflow.state).toBe("completed")
        expect(gate).toMatchObject({ status: "pass", failureClass: "none" })
        expect(gate?.evidenceArtifacts).toHaveLength(1)
        expect(snapshot.artifacts.find((artifact) => artifact.id === gate?.evidenceArtifacts?.[0])).toMatchObject({
          kind: "command-output",
          status: "pass",
          source: "validation-runner",
        })
      },
    })
  })

  test("report-only workflows persist a policy gate without spawning validation commands", async () => {
    await using tmp = await tmpdir({ git: true })
    const marker = path.join(tmp.path, "validation-ran.txt")
    await Bun.write(
      path.join(tmp.path, "package.json"),
      JSON.stringify({ scripts: { check: `bun -e 'await Bun.write(${JSON.stringify(marker)}, "ran")'` } }),
    )
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Read-only validation",
          objective: "Inspect without executing project scripts.",
          budgetMode: "max-goal",
          workspace: { mode: "read-only" },
          validationChecks: [{ id: "project-check", command: "bun run check", timeoutMs: 10_000 }],
          evaluation: { mode: "deterministic" },
          policy: { maxTurns: 3 },
        })
        await svc.activate(draft.id)
        await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
          "LOOP_CHECKPOINT:\nstatus: complete\nsummary: Ready.\nevidence:\n- inspected only\nnext_action: stop\nconfidence: high",
        )

        const snapshot = await svc.snapshot(draft.id)
        expect(await Bun.file(marker).exists()).toBe(false)
        expect(snapshot.workflow).toMatchObject({ state: "blocked", phase: "blocked" })
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "validation:project-check")).toMatchObject({
          status: "blocked",
          failureClass: "policy",
        })
        expect(snapshot.artifacts.find((artifact) => artifact.kind === "command-output")?.text).toContain("Blocked in report-only mode")
      },
    })
  })

  test("executable validation does not inherit application secret environment variables", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(
      path.join(tmp.path, "package.json"),
      JSON.stringify({ scripts: { check: "bun -e 'process.exit(process.env.DATABASE_URL ? 42 : 0)'" } }),
    )
    const previous = process.env.DATABASE_URL
    process.env.DATABASE_URL = "postgres://user:secret@example.invalid/database"
    try {
      await WithInstance.provide({
        directory: tmp.path,
        fn: async () => {
          const draft = await svc.createDraft({
            name: "Secret-safe validation",
            objective: "Run validation without exposing the parent application environment.",
            budgetMode: "max-goal",
            validationChecks: [{ id: "secret-check", command: "bun run check", timeoutMs: 10_000 }],
            evaluation: { mode: "deterministic" },
            policy: { maxTurns: 3 },
          })
          await svc.activate(draft.id)
          await runRunner(
            LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
            "LOOP_CHECKPOINT:\nstatus: complete\nsummary: Ready.\nevidence:\n- implementation inspected\nnext_action: stop\nconfidence: high",
          )

          const snapshot = await svc.snapshot(draft.id)
          expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "validation:secret-check")).toMatchObject({
            status: "pass",
            failureClass: "none",
          })
        },
      })
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    }
  })

  test("fixed workflows do not report completion at the cap when a completion gate fails", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({ scripts: { check: "bun -e 'process.exit(1)'" } }))
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Fixed gated loop",
          objective: "Run one iteration without bypassing failed validation.",
          budgetMode: "fixed",
          validationChecks: [{ id: "project-check", command: "bun run check", timeoutMs: 10_000 }],
          policy: { maxTurns: 1 },
        })
        await svc.activate(draft.id)
        await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
          "LOOP_CHECKPOINT:\nstatus: complete\nsummary: Claimed complete.\nevidence:\n- attempted validation\nnext_action: stop\nconfidence: high",
        )

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow).toMatchObject({ state: "blocked", phase: "completion_gate_failed" })
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "validation:project-check")?.status).toBe("fail")
      },
    })
  })

  test("executable validation does not replace separate success-check evidence", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Validation plus inspection",
          objective: "Require both the command check and the configured inspection evidence.",
          budgetMode: "max-goal",
          successChecks: ["browser smoke passed"],
          validationChecks: [{ id: "diff-check", command: "git diff --check", timeoutMs: 10_000 }],
          evaluation: { mode: "independent", requireIndependentForCompletion: true },
          policy: { maxTurns: 3 },
        })
        await svc.activate(draft.id)
        const worker = "LOOP_CHECKPOINT:\nstatus: complete\nsummary: Ready.\nevidence:\n- implementation inspected\nnext_action: stop\nconfidence: high"
        const judge = "LOOP_JUDGMENT:\nstatus: pass\nsummary: Judge accepts the implementation evidence.\nevidence:\n- implementation inspected\nrecommended_next_action: complete\nconfidence: high"

        await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
          (call) => call === 1 ? worker : judge,
        )

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).not.toBe("completed")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "validation:diff-check")).toMatchObject({ status: "pass" })
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "success-checks")).toMatchObject({ status: "fail" })
      },
    })
  })

  test("runtime rubric blocks a passing judge when executable validation fails", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({ scripts: { check: "bun -e 'process.exit(1)'" } }))
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Rubric validation blocker",
          objective: "Never complete with a failing check.",
          budgetMode: "max-goal",
          validationChecks: [{ id: "project-check", command: "bun run check", timeoutMs: 10_000 }],
          evaluation: { mode: "independent", requireIndependentForCompletion: true },
          rubric: {
            passThreshold: 0.8,
            criteria: [{ id: "verification", description: "Executable validation passes.", weight: 1, minScore: 4, evidenceRequired: ["success check output"] }],
            mandatoryBlockers: ["configured validation failed"],
          },
          policy: { maxTurns: 3 },
        })
        await svc.activate(draft.id)
        const worker = "LOOP_CHECKPOINT:\nstatus: complete\nsummary: Claimed complete.\nevidence:\n- implementation updated\nnext_action: stop\nconfidence: high"
        const judge = "LOOP_JUDGMENT:\nstatus: pass\nsummary: Judge accepts the proposal.\nevidence:\n- implementation updated\nrecommended_next_action: complete\nconfidence: high"

        const executed = await runRunner(
          LoopRunner.Service.use((runner) => runner.runOne({ id: draft.id, execute: true })),
          (call) => call === 1 ? worker : judge,
        )

        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.workflow.state).not.toBe("completed")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "validation:project-check")).toMatchObject({ status: "fail", failureClass: "quality" })
        expect(snapshot.runs[0]?.rubricResult).toMatchObject({ status: "blocked", score: 0, threshold: 0.8 })
        expect(snapshot.runs[0]?.rubricResult?.blockers.find((blocker) => blocker.id === "configured validation failed")?.present).toBe(true)
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "rubric")?.status).toBe("blocked")
        expect(promptInputText(executed.promptCalls[1])).toContain("validation:project-check: fail")
      },
    })
  })

  test("human waiver and acceptance leave a durable override audit trail", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Audited override",
          objective: "Allow an operator to resolve a non-critical quality gate.",
          budgetMode: "max-goal",
          policy: { maxTurns: 3 },
        })
        await svc.activate(draft.id)
        const started = await svc.startRun(draft.id)
        await run(LoopWorkflowService.use((loop) => loop.completeRun({
          id: draft.id,
          runID: started.id,
          checkpoint: { status: "blocked", summary: "A flaky quality check blocked completion." },
          gateResults: [{ id: "flaky-quality", status: "blocked", summary: "Flaky check failed.", failureClass: "quality" }],
        })))

        const waived = await run(LoopWorkflowService.use((loop) => loop.override({
          id: draft.id,
          action: "waive",
          gateID: "flaky-quality",
          actor: "user:operator",
          reason: "Verified the failure is unrelated and accepted the risk.",
        })))
        expect(waived.state).toBe("active")
        let snapshot = await svc.snapshot(draft.id)
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "flaky-quality")).toMatchObject({
          status: "pass",
          waiver: { action: "waive", actor: "user:operator" },
        })

        const accepted = await run(LoopWorkflowService.use((loop) => loop.override({
          id: draft.id,
          action: "accept",
          actor: "user:operator",
          reason: "Accept completion after reviewing the waived gate.",
        })))
        expect(accepted.state).toBe("completed")
        snapshot = await svc.snapshot(draft.id)
        expect(snapshot.artifacts.filter((artifact) => artifact.kind === "override")).toHaveLength(2)
        expect(snapshot.events.filter((event) => event.title.startsWith("Loop override:"))).toHaveLength(2)
      },
    })
  })

  test("waiving one quality gate does not bypass a remaining safety-critical gate", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Partially waivable override",
          objective: "Keep approval gates blocked after a quality waiver.",
          budgetMode: "max-goal",
          policy: { maxTurns: 3 },
        })
        await svc.activate(draft.id)
        const started = await svc.startRun(draft.id)
        await run(LoopWorkflowService.use((loop) => loop.completeRun({
          id: draft.id,
          runID: started.id,
          checkpoint: { status: "blocked", summary: "Quality and approval gates are unresolved." },
          gateResults: [
            { id: "flaky-quality", status: "blocked", summary: "Flaky check failed.", failureClass: "quality" },
            { id: "approval-policy", status: "awaiting_approval", summary: "Release approval is required.", failureClass: "policy" },
          ],
        })))

        const waived = await run(LoopWorkflowService.use((loop) => loop.override({
          id: draft.id,
          action: "waive",
          gateID: "flaky-quality",
          actor: "user:operator",
          reason: "Accepted only the flaky quality result.",
        })))
        expect(waived).toMatchObject({ state: "needs_input", phase: "needs_input" })
        const snapshot = await svc.snapshot(draft.id)
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "flaky-quality")?.status).toBe("pass")
        expect(snapshot.runs[0]?.gateResults?.find((gate) => gate.id === "approval-policy")?.status).toBe("awaiting_approval")
      },
    })
  })

  test("external signal rate limiting rejects bursts after durable dedupe", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Rate-limited signals",
          objective: "Wake only for bounded external events.",
          trigger: { mode: "external-signal" },
        })
        await svc.activate(draft.id)
        const attempts = await Promise.all(["first", "replay"].map(() => svc.ingestSignal({
          workflowID: draft.id,
          source: "ci",
          type: "ci.check.failed",
          dedupeKey: "event-1",
          rateLimit: { maxEvents: 1, windowMs: 60_000 },
        })))
        const first = attempts.find((attempt) => !attempt.deduped)!
        const duplicate = attempts.find((attempt) => attempt.deduped)!
        const limited = await svc.ingestSignal({
          workflowID: draft.id,
          source: "ci",
          type: "ci.check.failed",
          dedupeKey: "event-2",
          rateLimit: { maxEvents: 1, windowMs: 60_000 },
        })

        expect(first).toMatchObject({ deduped: false, rateLimited: false })
        expect(duplicate).toMatchObject({ deduped: true, rateLimited: false })
        expect(limited).toMatchObject({ deduped: false, rateLimited: true })
        expect((await svc.snapshot(draft.id)).artifacts.filter((artifact) => artifact.kind === "signal")).toHaveLength(1)
      },
    })
  })

  test("artifact retention prunes non-critical evidence by age and byte budget", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const draft = await svc.createDraft({
          name: "Age and size retention",
          objective: "Bound non-critical command evidence.",
          retention: { maxAgeMs: 100, maxBytes: 1_800, maxArtifacts: 20 },
        })
        await svc.activate(draft.id)
        const started = await svc.startRun(draft.id)
        const record = (checkID: string) => run(LoopWorkflowService.use((loop) => loop.recordValidation({
          id: draft.id,
          runID: started.id,
          checkID,
          command: "git diff --check",
          status: "pass",
          summary: `${checkID} passed`,
          output: "x".repeat(900),
        })))
        const old = await record("old")
        Database.use((db) => db.update(LoopArtifactTable).set({ time_created: Date.now() - 10_000 }).where(eq(LoopArtifactTable.id, old.id)).run())
        await record("new-1")
        await record("new-2")
        expect((await svc.snapshot(draft.id, 50)).artifacts.filter((artifact) => artifact.kind === "command-output")).toHaveLength(3)
        await svc.completeRun(draft.id, started.id, { status: "continue", summary: "Validation run finished." })

        const artifacts = (await svc.snapshot(draft.id, 50)).artifacts.filter((artifact) => artifact.kind === "command-output")
        expect(artifacts.some((artifact) => artifact.id === old.id)).toBe(false)
        expect(artifacts.length).toBeLessThan(3)
      },
    })
  })

  test("validation command allowlist rejects shell composition and destructive commands", () => {
    expect(LoopRunner.loopValidationCommandAllowed("git diff --check")).toBe(true)
    expect(LoopRunner.loopValidationCommandAllowed("bun test test/session/loop.test.ts")).toBe(true)
    expect(LoopRunner.loopValidationCommandAllowed("bun test && rm -rf /tmp/example")).toBe(false)
    expect(LoopRunner.loopValidationCommandAllowed("git diff --check --output=/tmp/diff.txt")).toBe(false)
    expect(LoopRunner.loopValidationCommandAllowed("rm -rf /tmp/example")).toBe(false)
  })
})
