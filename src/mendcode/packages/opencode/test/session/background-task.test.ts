import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Scope } from "effect"
import { BackgroundTask, reduceRun, type RunValue } from "@/session/background-task"
import { markPermissionPending, markPermissionResolved } from "@/session/pending-input"
import { BackgroundTaskEventTable, BackgroundTaskRunTable, BackgroundTaskTable } from "@/session/background-task.sql"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionTable } from "@/session/session.sql"
import { Database, eq } from "@/storage/db"
import { testEffect } from "../lib/effect"

const baseRun: RunValue = {
  state: "running",
  control_intent: "none",
  revision: 2,
  owner_runtime_id: "runtime-1",
  lease_expires_at: 10_000,
  result: null,
  time_started: 100,
  time_finished: null,
  time_updated: 100,
}

describe("background task reducer", () => {
  test("cancel intent is idempotent and terminal states are absorbing", () => {
    const requested = reduceRun(baseRun, { type: "request_cancel" }, 200)
    expect(requested.value.control_intent).toBe("cancel")
    expect(requested.value.revision).toBe(3)
    expect(reduceRun(requested.value, { type: "request_cancel" }, 300)).toEqual({
      value: requested.value,
      changed: false,
      stateChanged: false,
    })

    const completed = reduceRun(
      requested.value,
      {
        type: "finish",
        state: "completed",
        result: { changedFiles: [], transcriptSessionID: SessionID.make("ses_child"), summary: "done" },
      },
      400,
    )
    const losingCancel = reduceRun(
      completed.value,
      {
        type: "finish",
        state: "cancelled",
        result: { changedFiles: [], transcriptSessionID: SessionID.make("ses_child") },
      },
      500,
    )
    expect(completed.value.state).toBe("completed")
    expect(losingCancel.changed).toBe(false)
    expect(losingCancel.value.state).toBe("completed")
  })
})

const it = testEffect(Layer.mergeAll(Session.defaultLayer, BackgroundTask.defaultLayer))

describe("background task service", () => {
  it.instance("persists generations, wakes waiters, and emits one terminal event", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tasks = yield* BackgroundTask.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child", agent: "general" })
      const first = yield* tasks.start({
        taskID: child.id,
        parentSessionID: parent.id,
        title: "Inspect cache",
        agent: "general",
      })
      expect(first).toMatchObject({ generation: 1, revision: 1, state: "queued" })
      const running = yield* tasks.markRunning({ taskID: child.id, generation: first.generation })
      expect(running).toMatchObject({ revision: 2, state: "running" })

      const scope = yield* Scope.Scope
      const waiter = yield* tasks.wait({ taskID: child.id, timeoutMs: 2_000 }).pipe(Effect.forkIn(scope))
      const completed = yield* tasks.finish({
        taskID: child.id,
        generation: first.generation,
        state: "completed",
        background: true,
        result: { summary: "Cache is healthy.", changedFiles: ["src/cache.ts", "src/cache.ts"] },
      })
      const waited = yield* Fiber.join(waiter)
      expect(waited).toMatchObject({ timedOut: false, snapshot: { state: "completed", revision: 3 } })
      expect(completed.result).toMatchObject({ summary: "Cache is healthy.", changedFiles: ["src/cache.ts"] })
      const events = Database.use((db) =>
        db.select().from(BackgroundTaskEventTable).where(eq(BackgroundTaskEventTable.task_id, child.id)).all(),
      )
      expect(events).toHaveLength(1)
      expect(events[0]?.time_delivered).toBeNumber()
      expect(events[0]?.payload).toMatchObject({ background: true })
      expect(yield* tasks.pendingNotifications(parent.id)).toMatchObject([
        { eventID: events[0]?.id, taskID: child.id, parentSessionID: parent.id, state: "completed" },
      ])
      yield* tasks.acknowledgeNotifications([events[0]!.id])
      expect(yield* tasks.pendingNotifications(parent.id)).toEqual([])
      expect(
        Database.use((db) =>
          db.select().from(BackgroundTaskEventTable).where(eq(BackgroundTaskEventTable.id, events[0]!.id)).get(),
        )?.time_acknowledged,
      ).toBeNumber()

      const second = yield* tasks.start({
        taskID: child.id,
        parentSessionID: parent.id,
        title: "Inspect cache again",
        agent: "general",
      })
      expect(second).toMatchObject({ generation: 2, revision: 1, state: "queued" })
    }),
  )

  it.instance("persists owner-wake dismissal across task event replay", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tasks = yield* BackgroundTask.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
      const run = yield* tasks.start({
        taskID: child.id,
        parentSessionID: parent.id,
        startRunning: true,
        title: "Dismissed child",
      })
      yield* tasks.finish({
        taskID: child.id,
        generation: run.generation,
        state: "completed",
        background: true,
        result: { summary: "Done" },
      })
      expect(yield* tasks.pendingNotifications(parent.id)).toHaveLength(1)

      yield* tasks.dismissNotifications(parent.id)

      expect(yield* tasks.pendingNotifications(parent.id)).toEqual([])
      expect(
        Database.use((db) =>
          db.select().from(BackgroundTaskTable).where(eq(BackgroundTaskTable.task_id, child.id)).get(),
        )?.time_dismissed,
      ).toBeNumber()
    }),
  )

  it.instance("scopes replayable notifications to the current instance", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tasks = yield* BackgroundTask.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
      const run = yield* tasks.start({
        taskID: child.id,
        parentSessionID: parent.id,
        startRunning: true,
        title: "Foreign instance child",
      })
      yield* tasks.finish({
        taskID: child.id,
        generation: run.generation,
        state: "completed",
        background: true,
        result: { summary: "Done" },
      })
      expect(yield* tasks.pendingNotifications()).toHaveLength(1)

      Database.use((db) =>
        db.update(SessionTable).set({ directory: "/other-instance" }).where(eq(SessionTable.id, parent.id)).run(),
      )

      expect(yield* tasks.pendingNotifications()).toEqual([])
      expect(yield* tasks.pendingNotifications(parent.id)).toEqual([])
    }),
  )

  it.instance("keeps exactly one terminal winner across cancel and completion", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tasks = yield* BackgroundTask.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
      const run = yield* tasks.start({ taskID: child.id, parentSessionID: parent.id, title: "Race" })
      yield* tasks.markRunning({ taskID: child.id, generation: run.generation })
      const requested = yield* tasks.requestCancel({ taskID: child.id })
      const duplicate = yield* tasks.requestCancel({ taskID: child.id })
      expect(duplicate?.revision).toBe(requested?.revision)

      const completed = yield* tasks.finish({
        taskID: child.id,
        generation: run.generation,
        state: "completed",
        result: { summary: "Completion won." },
      })
      const cancelled = yield* tasks.finish({
        taskID: child.id,
        generation: run.generation,
        state: "cancelled",
        result: { error: "Too late" },
      })
      expect(completed.state).toBe("completed")
      expect(cancelled).toEqual(completed)
      expect(
        Database.use((db) =>
          db.select().from(BackgroundTaskEventTable).where(eq(BackgroundTaskEventTable.task_id, child.id)).all(),
        ),
      ).toHaveLength(1)
    }),
  )

  it.instance("times out a wait without cancelling the task", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tasks = yield* BackgroundTask.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
      const run = yield* tasks.start({ taskID: child.id, parentSessionID: parent.id, title: "Slow task" })
      yield* tasks.markRunning({ taskID: child.id, generation: run.generation })
      const result = yield* tasks.wait({ taskID: child.id, timeoutMs: 10 })
      expect(result).toMatchObject({ timedOut: true, snapshot: { state: "running", controlIntent: "none" } })
      expect((yield* tasks.get(child.id))?.state).toBe("running")
    }),
  )

  it.instance("admits active children atomically and can start without a queued gap", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tasks = yield* BackgroundTask.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const firstChild = yield* sessions.create({ parentID: parent.id, title: "First child" })
      const secondChild = yield* sessions.create({ parentID: parent.id, title: "Second child" })
      const first = yield* tasks.start({
        taskID: firstChild.id,
        parentSessionID: parent.id,
        rootSessionID: parent.id,
        depth: 1,
        limits: { maxChildren: 1, maxDescendants: 2 },
        startRunning: true,
        title: "First child",
      })
      expect(first).toMatchObject({ state: "running", rootSessionID: parent.id, depth: 1 })

      const rejected = yield* tasks
        .start({
          taskID: secondChild.id,
          parentSessionID: parent.id,
          rootSessionID: parent.id,
          depth: 1,
          limits: { maxChildren: 1, maxDescendants: 2 },
          startRunning: true,
          title: "Second child",
        })
        .pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
    }),
  )

  it.instance("reclaims an expired runtime lease as an explicit interruption", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tasks = yield* BackgroundTask.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Expired child" })
      const run = yield* tasks.start({
        taskID: child.id,
        parentSessionID: parent.id,
        startRunning: true,
        title: "Expired child",
      })
      Database.use((db) =>
        db
          .update(BackgroundTaskRunTable)
          .set({ owner_runtime_id: "99999999:expired-test", lease_expires_at: 10 })
          .where(eq(BackgroundTaskRunTable.task_id, child.id))
          .run(),
      )

      const reclaimed = yield* tasks.reclaimExpired({ now: 11 })
      expect(reclaimed).toHaveLength(1)
      expect(reclaimed[0]).toMatchObject({
        taskID: child.id,
        generation: run.generation,
        state: "interrupted",
        result: { error: "Runtime lease expired" },
      })
      expect(yield* tasks.pendingNotifications(parent.id)).toMatchObject([
        { taskID: child.id, parentSessionID: parent.id, state: "interrupted", background: true },
      ])
    }),
  )

  it.instance("does not interrupt a live runtime only because wall-clock time advanced during sleep", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tasks = yield* BackgroundTask.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Sleeping child" })
      yield* tasks.start({
        taskID: child.id,
        parentSessionID: parent.id,
        startRunning: true,
        title: "Sleeping child",
      })
      Database.use((db) =>
        db.update(BackgroundTaskRunTable)
          .set({ lease_expires_at: 10 })
          .where(eq(BackgroundTaskRunTable.task_id, child.id))
          .run(),
      )

      expect(yield* tasks.reclaimExpired({ now: 11 })).toHaveLength(0)
      expect(yield* tasks.get(child.id)).toMatchObject({ state: "running" })
    }),
  )

  it.instance("does not publish needs-input when permission resolves before the delay", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tasks = yield* BackgroundTask.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Permission child" })
      yield* tasks.start({
        taskID: child.id,
        parentSessionID: parent.id,
        startRunning: true,
        title: "Permission child",
      })

      markPermissionPending({ sessionID: child.id, permission: "bash", patterns: ["uv run python"] }, 10)
      expect(yield* tasks.get(child.id)).toMatchObject({ state: "running" })
      markPermissionResolved(child.id)
      yield* Effect.promise(() => Bun.sleep(20))

      expect(yield* tasks.get(child.id)).toMatchObject({ state: "running" })
      expect(yield* tasks.pendingNotifications(parent.id)).toHaveLength(0)
    }),
  )

  it.instance("persists needs-input after permission remains pending and resumes the same subagent", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tasks = yield* BackgroundTask.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Permission child" })
      yield* tasks.start({
        taskID: child.id,
        parentSessionID: parent.id,
        startRunning: true,
        title: "Permission child",
      })

      markPermissionPending({ sessionID: child.id, permission: "bash", patterns: ["uv run python"] }, 10)
      expect(yield* tasks.get(child.id)).toMatchObject({ state: "running" })
      yield* Effect.promise(() => Bun.sleep(20))

      expect(yield* tasks.get(child.id)).toMatchObject({ state: "needs_input" })
      expect(yield* tasks.pendingNotifications(parent.id)).toMatchObject([
        { taskID: child.id, state: "needs_input", background: true },
      ])

      markPermissionResolved(child.id)
      expect(yield* tasks.get(child.id)).toMatchObject({ state: "running" })
      expect(yield* tasks.pendingNotifications(parent.id)).toHaveLength(0)
    }),
  )

  it.instance("resumes a pending permission task on the same background generation", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tasks = yield* BackgroundTask.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Permission child" })
      const started = yield* tasks.start({
        taskID: child.id,
        parentSessionID: parent.id,
        startRunning: true,
        title: "Permission child",
      })

      markPermissionPending({ sessionID: child.id, permission: "bash", patterns: ["uv run python"] }, 10)
      yield* Effect.promise(() => Bun.sleep(20))
      expect(yield* tasks.get(child.id)).toMatchObject({ generation: started.generation, state: "needs_input" })

      const resumed = yield* tasks.resume({ taskID: child.id, generation: started.generation })
      expect(resumed).toMatchObject({ generation: started.generation, state: "running" })
      expect(yield* tasks.pendingNotifications(parent.id)).toHaveLength(0)
      markPermissionResolved(child.id)
    }),
  )
})
