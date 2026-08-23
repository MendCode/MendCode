import { activityLabelForTool, SESSION_ACTIVITY_WAITING } from "@/session/status"
import {
  workflowReceiptCounts,
  workflowReceiptElapsed,
  workflowReceiptNextAction,
  workflowReceiptProgress,
  workflowReceiptStateLabel,
  type WorkflowReceiptSnapshot,
} from "./workflow-receipt"

type WorkflowActivityStatus = {
  type: string
  kind?: string
  message?: string
}

type WorkflowActiveTool = {
  tool: string
  status: "pending" | "running"
}

type WorkflowCompletionActivity = WorkflowReceiptSnapshot["run"]["completion"]

function workflowDuration(value: number) {
  const seconds = Math.max(0, Math.round(value / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const minuteRemainder = minutes % 60
  return minuteRemainder ? `${hours}h ${minuteRemainder}m` : `${hours}h`
}

export function workflowTimeAgo(timestamp: number | undefined, now = Date.now()) {
  if (!timestamp) return "unknown"
  return `${workflowDuration(now - timestamp)} ago`
}

export function workflowCompletionAuditActivity(input: {
  runState: string
  completion?: WorkflowCompletionActivity
  now?: number
}) {
  const completion = input.completion
  if (!completion) return
  if (completion.status === "candidate") return `queued · generation ${completion.generation} · fresh audit pending`
  if (completion.status !== "auditing") return

  const attempt = Math.max(1, completion.auditAttempts)
  if (input.runState === "paused") return `paused · audit attempt ${attempt}`
  if (input.runState === "needs_input") return `waiting for input · audit attempt ${attempt}`
  if (input.runState === "awaiting_approval") return `waiting for approval · audit attempt ${attempt}`

  const lease = completion.auditLease
  if (!lease) return `queued · audit attempt ${attempt} · waiting for auditor`
  const now = input.now ?? Date.now()
  if (lease.expiresAt <= now) {
    return `stalled · audit attempt ${attempt} · lease expired ${workflowDuration(now - lease.expiresAt)} ago`
  }
  return `running · audit attempt ${attempt} · lease ${workflowDuration(lease.expiresAt - now)} left`
}

export function workflowCurrentActivity(input: {
  runState: string
  statuses: readonly WorkflowActivityStatus[]
  activeTools?: readonly WorkflowActiveTool[]
  pendingPermissions?: number
  waitingTasks?: number
  completion?: WorkflowCompletionActivity
  now?: number
}) {
  const pendingPermissions = input.pendingPermissions ?? 0
  const runningTool = input.activeTools?.findLast((tool) => tool.status === "running" && tool.tool !== "task")
  if (runningTool) return activityLabelForTool(runningTool.tool)

  if (pendingPermissions > 0) {
    return `${pendingPermissions} permission request${pendingPermissions === 1 ? "" : "s"} waiting`
  }

  const activeTool = input.activeTools?.findLast((tool) => tool.status === "running" || tool.status === "pending")
  if (activeTool) return activityLabelForTool(activeTool.tool)

  const waitingTasks = input.waitingTasks ?? 0
  if (waitingTasks > 0) return `${waitingTasks} task${waitingTasks === 1 ? "" : "s"} waiting for input`
  if (input.runState === "awaiting_approval") return "Workflow approval required"
  if (input.runState === "needs_input") return "Workflow waiting for input"

  const compacting = input.statuses.find((status) => status.type === "busy" && status.kind === "compaction")
  if (compacting) return compacting.message || "AI is compacting context"

  const busy = input.statuses.find(
    (status) =>
      status.type === "busy" &&
      status.message !== SESSION_ACTIVITY_WAITING &&
      status.kind !== "subagent-wait" &&
      status.kind !== "mflow-wait",
  )
  if (busy) return busy.message || "AI is working"

  const retrying = input.statuses.find((status) => status.type === "retry")
  if (retrying) return retrying.message ? `AI retrying · ${retrying.message}` : "AI retrying"

  if (input.statuses.some((status) => status.type === "busy" && status.kind === "subagent-wait")) {
    return "Working with a subagent"
  }
  if (input.statuses.some((status) => status.type === "busy" && status.kind === "mflow-wait")) {
    return "Working with file locks"
  }
  return workflowCompletionAuditActivity({
    runState: input.runState,
    completion: input.completion,
    now: input.now,
  })
}

export function workflowRequestErrorText(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  if (!error || typeof error !== "object") return "Workflow request failed."
  const value = error as {
    message?: unknown
    data?: { message?: unknown } | null
    errors?: readonly { message?: unknown }[]
  }
  if (typeof value.message === "string" && value.message) return value.message
  if (typeof value.data?.message === "string" && value.data.message) return value.data.message
  const message = value.errors?.find((item) => typeof item.message === "string" && item.message)?.message
  return typeof message === "string" ? message : "Workflow request failed."
}

export function workflowMonitorLayout(input: { width: number; height: number }) {
  const width = Math.max(24, Math.floor(input.width))
  const compact = width < 96 || input.height < 22
  const stacked = width < 120 || input.height < 24
  const listWidth = stacked ? width : Math.max(24, Math.min(32, Math.floor(width * 0.24)))
  return {
    compact,
    stacked,
    listWidth,
    detailWidth: Math.max(28, width - listWidth - 3),
  }
}

export function workflowMonitorTaskCounts(snapshot?: Pick<WorkflowReceiptSnapshot, "tasks">) {
  if (!snapshot) return { total: 0, queued: 0, working: 0, completed: 0, failed: 0, blocked: 0, needsInput: 0 }
  return workflowReceiptCounts({ tasks: snapshot.tasks, phases: [] })
}

export function workflowMonitorRows(snapshot?: WorkflowReceiptSnapshot, now = Date.now()): Array<[string, string]> {
  if (!snapshot) return [] as Array<[string, string]>
  const counts = workflowMonitorTaskCounts(snapshot)
  const elapsed = workflowReceiptElapsed(snapshot, now)
  const audit = workflowCompletionAuditActivity({
    runState: snapshot.run.state,
    completion: snapshot.run.completion,
    now,
  })
  return [
    ["state", workflowReceiptStateLabel(snapshot.run.state)],
    [
      "completion",
      snapshot.run.completion
        ? `${snapshot.run.completion.status} · gen ${snapshot.run.completion.generation} · ${snapshot.run.completion.auditAttempts} audit${snapshot.run.completion.auditAttempts === 1 ? "" : "s"}`
        : "legacy same-run",
    ],
    ...(audit ? [["audit", audit] as [string, string]] : []),
    ...(snapshot.run.completion?.updatedAt
      ? [["audit update", workflowTimeAgo(snapshot.run.completion.updatedAt, now)] as [string, string]]
      : []),
    ["progress", workflowReceiptProgress(snapshot)],
    [
      "phases",
      `${snapshot.phases.filter((phase) => phase.state === "completed").length}/${snapshot.phases.length} complete`,
    ],
    ["active", `${counts.working} working · ${counts.queued} queued`],
    ["blocked", `${counts.blocked} blocked · ${counts.failed} failed · ${counts.needsInput} input`],
    ["elapsed", `${Math.round(elapsed / 1000)}s`],
    ["next", workflowReceiptNextAction(snapshot, now)],
  ]
}

export function workflowMonitorTaskRows(snapshot: WorkflowReceiptSnapshot, phaseID?: string) {
  const phaseTaskIDs = phaseID
    ? new Set(snapshot.phases.find((phase) => phase.id === phaseID)?.taskIDs ?? [])
    : undefined
  const phases = snapshot.phases.toSorted((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0))
  const phaseOrder = new Map(phases.flatMap((phase, index) => (phase.id ? [[phase.id, index] as const] : [])))
  const taskOrder = new Map(
    phases.flatMap((phase, phaseIndex) =>
      (phase.taskIDs ?? []).map((taskID, taskIndex) => [taskID, { phaseIndex, taskIndex }] as const),
    ),
  )
  const originalOrder = new Map(snapshot.tasks.flatMap((task, index) => (task.id ? [[task.id, index] as const] : [])))
  const rows = snapshot.tasks
    .flatMap((task) =>
      task.id && task.name && task.phaseID
        ? [
            {
              id: task.id,
              state: task.state,
              name: task.name,
              phaseID: task.phaseID,
              blocker: task.blocker,
              attempt: task.attempt,
              startedAt: task.startedAt,
            },
          ]
        : [],
    )
    .filter((task) => !phaseTaskIDs || phaseTaskIDs.has(task.id))
  return rows.toSorted((left, right) => {
    const leftTaskOrder = taskOrder.get(left.id)
    const rightTaskOrder = taskOrder.get(right.id)
    const leftPhaseIndex = leftTaskOrder?.phaseIndex ?? phaseOrder.get(left.phaseID) ?? Number.MAX_SAFE_INTEGER
    const rightPhaseIndex = rightTaskOrder?.phaseIndex ?? phaseOrder.get(right.phaseID) ?? Number.MAX_SAFE_INTEGER
    if (leftPhaseIndex !== rightPhaseIndex) return leftPhaseIndex - rightPhaseIndex
    if (leftTaskOrder && rightTaskOrder && leftTaskOrder.taskIndex !== rightTaskOrder.taskIndex) {
      return leftTaskOrder.taskIndex - rightTaskOrder.taskIndex
    }
    return (originalOrder.get(left.id) ?? 0) - (originalOrder.get(right.id) ?? 0)
  })
}

export function workflowMonitorResumeTarget(snapshot: WorkflowReceiptSnapshot) {
  if (snapshot.run.state !== "failed") return { kind: "resume" } as const
  const task = workflowMonitorTaskRows(snapshot).find((item) => item.state === "failed")
  if (task) return { kind: "retry-task", taskID: task.id, name: task.name } as const
  const phase = snapshot.phases
    .filter((item) => item.id && item.state === "failed")
    .toSorted((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0))[0]
  if (phase?.id) return { kind: "retry-phase", phaseID: phase.id, name: phase.name ?? phase.id } as const
  return { kind: "unavailable" } as const
}

export function workflowMonitorSessionID(snapshot?: WorkflowReceiptSnapshot) {
  if (!snapshot) return
  const priority = (state: string) => {
    if (state === "working") return 4
    if (state === "needs_input" || state === "blocked" || state === "failed") return 3
    if (state === "queued") return 2
    return 1
  }
  return (
    snapshot.tasks
      .filter((task): task is WorkflowReceiptSnapshot["tasks"][number] & { sessionID: string } =>
        Boolean(task.sessionID),
      )
      .toSorted(
        (left, right) =>
          priority(right.state) - priority(left.state) ||
          (right.startedAt ?? right.completedAt ?? 0) - (left.startedAt ?? left.completedAt ?? 0),
      )[0]?.sessionID ??
    snapshot.run.originSessionID ??
    snapshot.run.rootSessionID
  )
}

export function workflowMonitorAuditSessionID(input: {
  rootSessionID?: string
  sessions: readonly {
    id: string
    parentID?: string
    title: string
    time?: { created?: number; updated?: number }
  }[]
}) {
  if (!input.rootSessionID) return
  const descendants = new Set([input.rootSessionID])
  let changed = true
  while (changed) {
    changed = false
    for (const session of input.sessions) {
      if (!session.parentID || !descendants.has(session.parentID) || descendants.has(session.id)) continue
      descendants.add(session.id)
      changed = true
    }
  }
  return input.sessions
    .filter((session) => descendants.has(session.id) && session.title.startsWith("Completion audit:"))
    .toSorted(
      (left, right) =>
        (right.time?.updated ?? right.time?.created ?? 0) - (left.time?.updated ?? left.time?.created ?? 0),
    )[0]?.id
}

export function workflowTaskSessionContext(input: {
  sessionID: string
  workflows: readonly {
    definition: { name?: string }
    revision: { plan: { phases?: readonly { taskIDs?: readonly string[] }[] } }
    run: { id: string }
    tasks: readonly { id: string; name?: string; sessionID?: string }[]
  }[]
}) {
  for (const workflow of input.workflows) {
    const tasksByID = new Map(workflow.tasks.map((task) => [task.id, task] as const))
    const plannedIDs = workflow.revision.plan.phases?.flatMap((phase) => phase.taskIDs ?? []) ?? []
    const planned = new Set(plannedIDs)
    const tasks = [
      ...plannedIDs.flatMap((taskID) => {
        const task = tasksByID.get(taskID)
        return task ? [task] : []
      }),
      ...workflow.tasks.filter((task) => !planned.has(task.id)),
    ]
    const index = tasks.findIndex((task) => task.sessionID === input.sessionID)
    if (index < 0) continue
    const task = tasks[index]
    return {
      runID: workflow.run.id,
      workflowName: workflow.definition.name || "Workflow",
      taskID: task.id,
      taskName: task.name || task.id,
      taskIndex: index,
      taskCount: tasks.length,
      sessionIDs: tasks.flatMap((item) => (item.sessionID ? [item.sessionID] : [])),
    }
  }
}

export function workflowTaskSiblingSessionID(input: {
  sessionID: string
  sessionIDs: readonly string[]
  direction: -1 | 1
}) {
  if (input.sessionIDs.length < 2) return
  const index = input.sessionIDs.indexOf(input.sessionID)
  if (index < 0) return
  return input.sessionIDs[(index + input.direction + input.sessionIDs.length) % input.sessionIDs.length]
}

export function workflowParentSessionID(input: {
  sessionID: string
  parentSessionID?: string
  workflows: readonly { run: { rootSessionID?: string; originSessionID?: string } }[]
}) {
  const rootSessionID = input.parentSessionID ?? input.sessionID
  return (
    input.workflows.find((item) => item.run.rootSessionID === rootSessionID)?.run.originSessionID ??
    input.parentSessionID
  )
}

export function workflowMonitorFooter(compact: boolean) {
  return compact
    ? "↑↓/jk select · Enter/o task chat · c creator · m permission mode · p/u/x control · t/f retry task/phase · d delete · r refresh · q/Esc back"
    : "↑↓/jk select · Enter/o task chat · c creator · m permission mode · p pause · u resume · x stop · t retry task · f retry phase · d delete · r refresh · q/Esc back"
}
