import { Bus } from "@/bus"
import { and, Database, eq, type TxOrDb } from "@/storage/db"
import {
  BackgroundTaskEventTable,
  BackgroundTaskRunTable,
  BackgroundTaskTable,
} from "./background-task.sql"
import { SessionID } from "./schema"
import {
  BackgroundSessionTable,
  LoopRunTable,
  LoopThreadTable,
  LoopWorkflowTable,
  WorkflowPhaseTable,
  WorkflowRunTable,
  WorkflowTaskAttemptTable,
  WorkflowTaskTable,
} from "./session.sql"
import { WORKFLOW_PERMISSION_ABANDONED_REASON } from "./workflow-service"

const pendingSummary = (permission: string, patterns: readonly string[]) =>
  `Permission required: ${permission}${patterns.length ? ` — ${patterns.join(", ")}` : ""}`

export const PERMISSION_PENDING_DELAY_MS = 5_000

type PendingPermission = {
  input: { sessionID: SessionID; permission: string; patterns: readonly string[] }
  timer: ReturnType<typeof setTimeout> | undefined
}

const pendingPermissions = new Map<SessionID, PendingPermission>()

function loopForSession(db: TxOrDb, sessionID: SessionID) {
  const direct = db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.root_session_id, sessionID)).get()
  if (direct) return direct
  const thread = db.select().from(LoopThreadTable).where(eq(LoopThreadTable.session_id, sessionID)).get()
  if (!thread) return
  return db.select().from(LoopWorkflowTable).where(eq(LoopWorkflowTable.id, thread.workflow_id)).get()
}

function updateLoopBackground(
  db: TxOrDb,
  sessionID: SessionID,
  state: "working" | "needs_input",
  summary: string,
  now: number,
) {
  const current = db.select().from(BackgroundSessionTable).where(eq(BackgroundSessionTable.session_id, sessionID)).get()
  if (!current) return
  db.update(BackgroundSessionTable)
    .set({ time_updated: now, data: { ...current.data, state, summary } })
    .where(eq(BackgroundSessionTable.session_id, sessionID))
    .run()
}

function updateBackgroundTask(
  db: TxOrDb,
  input: { sessionID: SessionID; state: "needs_input" | "running" | "interrupted"; summary: string; now: number },
) {
  const task = db.select().from(BackgroundTaskTable).where(eq(BackgroundTaskTable.task_id, input.sessionID)).get()
  if (!task) return
  const run = db.select().from(BackgroundTaskRunTable).where(
    and(
      eq(BackgroundTaskRunTable.task_id, input.sessionID),
      eq(BackgroundTaskRunTable.generation, task.current_generation),
    ),
  ).get()
  if (!run) return
  const allowed = input.state === "needs_input"
    ? run.state === "running"
    : input.state === "running"
      ? run.state === "needs_input"
      : run.state === "running" || run.state === "needs_input"
  if (!allowed) return
  const revision = run.revision + 1
  db.update(BackgroundTaskRunTable)
    .set({
      state: input.state,
      revision,
      time_updated: input.now,
      ...(input.state === "interrupted"
        ? {
            owner_runtime_id: null,
            lease_expires_at: null,
            time_finished: input.now,
            result: {
              summary: input.summary,
              error: "Permission owner stopped before replying",
              changedFiles: [],
              transcriptSessionID: input.sessionID,
            },
          }
        : {}),
    })
    .where(
      and(
        eq(BackgroundTaskRunTable.task_id, input.sessionID),
        eq(BackgroundTaskRunTable.generation, task.current_generation),
        eq(BackgroundTaskRunTable.revision, run.revision),
      ),
    )
    .run()
  db.update(BackgroundTaskTable)
    .set({ time_updated: input.now })
    .where(eq(BackgroundTaskTable.task_id, input.sessionID))
    .run()
  if (input.state === "running") {
    db.update(BackgroundTaskEventTable)
      .set({ time_acknowledged: input.now, time_updated: input.now })
      .where(
        and(
          eq(BackgroundTaskEventTable.task_id, input.sessionID),
          eq(BackgroundTaskEventTable.generation, task.current_generation),
          eq(BackgroundTaskEventTable.type, "needs_input"),
        ),
      )
      .run()
    return
  }
  db.insert(BackgroundTaskEventTable)
    .values({
      id: Bus.createID(),
      task_id: input.sessionID,
      generation: task.current_generation,
      revision,
      type: input.state,
      payload: {
        parentSessionID: task.parent_session_id,
        title: task.title,
        summary: input.summary,
        ...(input.state === "interrupted" ? { error: "Permission owner stopped before replying" } : {}),
        background: true,
      },
      time_created: input.now,
      time_updated: input.now,
      time_delivered: null,
      time_acknowledged: null,
    })
    .onConflictDoNothing()
    .run()
}

function reconcileWorkflow(
  db: TxOrDb,
  runID: string,
  now: number,
) {
  const run = db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, runID as never)).get()
  if (!run) return
  const phases = db.select().from(WorkflowPhaseTable).where(eq(WorkflowPhaseTable.run_id, run.id)).all()
  const tasks = db.select().from(WorkflowTaskTable).where(eq(WorkflowTaskTable.run_id, run.id)).all()
  for (const phase of phases) {
    const phaseTasks = tasks.filter((task) => task.phase_id === phase.id)
    const state = phaseTasks.some((task) => task.state === "needs_input")
      ? "needs_input" as const
      : phaseTasks.some((task) => task.state === "failed")
        ? "failed" as const
        : phaseTasks.some((task) => task.state === "blocked" || task.state === "stopped")
          ? "blocked" as const
          : phaseTasks.some((task) => task.state === "working")
            ? "working" as const
            : phaseTasks.some((task) => task.state === "queued")
              ? "queued" as const
              : phase.state
    db.update(WorkflowPhaseTable)
      .set({
        state,
        task_count: phaseTasks.length,
        queued_count: phaseTasks.filter((task) => task.state === "queued").length,
        working_count: phaseTasks.filter((task) => task.state === "working").length,
        completed_count: phaseTasks.filter((task) => task.state === "completed").length,
        failed_count: phaseTasks.filter((task) => task.state === "failed").length,
        blocked_count: phaseTasks.filter((task) => task.state === "blocked" || task.state === "stopped").length,
        time_updated: now,
        ...(state === "failed" || state === "blocked" ? { time_ended: now } : {}),
      })
      .where(and(eq(WorkflowPhaseTable.run_id, run.id), eq(WorkflowPhaseTable.id, phase.id)))
      .run()
  }
  const state = tasks.some((task) => task.state === "needs_input")
    ? "needs_input" as const
    : tasks.some((task) => task.state === "failed")
      ? "failed" as const
      : tasks.some((task) => task.state === "blocked" || task.state === "stopped")
        ? "blocked" as const
        : tasks.some((task) => task.state === "working" || task.state === "queued")
          ? "working" as const
          : run.state
  db.update(WorkflowRunTable)
    .set({
      state,
      time_updated: now,
      ...(state === "failed" ? { time_ended: now, lease_holder: null, lease_expires_at: null } : {}),
    })
    .where(eq(WorkflowRunTable.id, run.id))
    .run()
}

function updateWorkflowTask(
  db: TxOrDb,
  input: { sessionID: SessionID; state: "needs_input" | "working" | "failed"; summary: string; now: number },
) {
  const attempts = db.select().from(WorkflowTaskAttemptTable).where(eq(WorkflowTaskAttemptTable.background_task_id, input.sessionID)).all()
  for (const attempt of attempts) {
    const allowed = input.state === "needs_input"
      ? attempt.state === "working"
      : input.state === "working"
        ? attempt.state === "needs_input"
        : attempt.state === "working" || attempt.state === "needs_input"
    if (!allowed) continue
    db.update(WorkflowTaskAttemptTable)
      .set({
        state: input.state,
        time_updated: input.now,
        ...(attempt.data
          ? { data: { ...attempt.data, state: input.state, ...(input.state === "failed" ? { reason: input.summary } : {}) } }
          : {}),
        ...(input.state === "failed"
          ? { failure_class: "environment", reason: input.summary, time_completed: input.now }
          : {}),
      })
      .where(eq(WorkflowTaskAttemptTable.id, attempt.id))
      .run()
    const task = db.select().from(WorkflowTaskTable).where(
      and(eq(WorkflowTaskTable.run_id, attempt.run_id), eq(WorkflowTaskTable.id, attempt.task_id)),
    ).get()
    if (task && (task.state === "working" || task.state === "needs_input")) {
      db.update(WorkflowTaskTable)
        .set({
          state: input.state,
          time_updated: input.now,
          ...(input.state === "failed" ? { time_ended: input.now, data: { ...task.data, blocker: input.summary } } : {}),
        })
        .where(and(eq(WorkflowTaskTable.run_id, attempt.run_id), eq(WorkflowTaskTable.id, attempt.task_id)))
        .run()
    }
    reconcileWorkflow(db, attempt.run_id, input.now)
  }
}

function markPermissionPendingNow(input: { sessionID: SessionID; permission: string; patterns: readonly string[] }) {
  const now = Date.now()
  const summary = pendingSummary(input.permission, input.patterns)
  Database.transaction((db) => {
    const loop = loopForSession(db, input.sessionID)
    if (loop?.state === "working") {
      db.update(LoopWorkflowTable)
        .set({ state: "needs_input", phase: "needs_input", time_updated: now })
        .where(eq(LoopWorkflowTable.id, loop.id))
        .run()
      db.update(LoopThreadTable)
        .set({ state: "needs_input", time_updated: now })
        .where(eq(LoopThreadTable.workflow_id, loop.id))
        .run()
      if (loop.root_session_id) updateLoopBackground(db, loop.root_session_id, "needs_input", summary, now)
    }
    updateBackgroundTask(db, { sessionID: input.sessionID, state: "needs_input", summary, now })
    updateWorkflowTask(db, { sessionID: input.sessionID, state: "needs_input", summary, now })
  }, { behavior: "immediate" })
}

export function markPermissionPending(
  input: { sessionID: SessionID; permission: string; patterns: readonly string[] },
  delayMs = PERMISSION_PENDING_DELAY_MS,
) {
  const existing = pendingPermissions.get(input.sessionID)
  if (existing) {
    if (existing.timer !== undefined) existing.input = input
    return
  }
  const pending: PendingPermission = { input, timer: undefined }
  pendingPermissions.set(input.sessionID, pending)
  pending.timer = setTimeout(() => {
    if (pendingPermissions.get(input.sessionID) !== pending) return
    pending.timer = undefined
    markPermissionPendingNow(pending.input)
  }, delayMs)
}

function clearPendingPermission(sessionID: SessionID) {
  const pending = pendingPermissions.get(sessionID)
  if (!pending) return
  if (pending.timer !== undefined) clearTimeout(pending.timer)
  pendingPermissions.delete(sessionID)
}

export function markPermissionResolved(sessionID: SessionID) {
  const now = Date.now()
  clearPendingPermission(sessionID)
  Database.transaction((db) => {
    const loop = loopForSession(db, sessionID)
    const activeRun = loop
      ? db.select().from(LoopRunTable).where(eq(LoopRunTable.workflow_id, loop.id)).all().find((run) => run.state === "working")
      : undefined
    if (loop?.state === "needs_input" && activeRun) {
      db.update(LoopWorkflowTable)
        .set({ state: "working", phase: "executing", time_updated: now })
        .where(eq(LoopWorkflowTable.id, loop.id))
        .run()
      db.update(LoopThreadTable)
        .set({ state: "working", time_updated: now })
        .where(and(eq(LoopThreadTable.workflow_id, loop.id), eq(LoopThreadTable.state, "needs_input")))
        .run()
      if (loop.root_session_id) updateLoopBackground(db, loop.root_session_id, "working", "Loop working: executing", now)
    }
    updateBackgroundTask(db, { sessionID, state: "running", summary: "Permission resolved; execution resumed.", now })
    updateWorkflowTask(db, { sessionID, state: "working", summary: "Permission resolved; execution resumed.", now })
  }, { behavior: "immediate" })
}

export function markPermissionAbandoned(sessionID: SessionID) {
  const now = Date.now()
  const summary = WORKFLOW_PERMISSION_ABANDONED_REASON
  clearPendingPermission(sessionID)
  Database.transaction((db) => {
    updateBackgroundTask(db, { sessionID, state: "interrupted", summary, now })
    updateWorkflowTask(db, { sessionID, state: "needs_input", summary, now })
  }, { behavior: "immediate" })
}
