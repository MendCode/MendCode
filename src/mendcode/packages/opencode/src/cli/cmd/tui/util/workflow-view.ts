import { workflowReceiptCounts, workflowReceiptElapsed, workflowReceiptNextAction, workflowReceiptProgress, workflowReceiptStateLabel, type WorkflowReceiptSnapshot } from "./workflow-receipt"

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

export function workflowMonitorRows(snapshot?: WorkflowReceiptSnapshot): Array<[string, string]> {
  if (!snapshot) return [] as Array<[string, string]>
  const counts = workflowMonitorTaskCounts(snapshot)
  const elapsed = workflowReceiptElapsed(snapshot)
  return [
    ["state", workflowReceiptStateLabel(snapshot.run.state)],
    ["progress", workflowReceiptProgress(snapshot)],
    ["phases", `${snapshot.phases.filter((phase) => phase.state === "completed").length}/${snapshot.phases.length} complete`],
    ["active", `${counts.working} working · ${counts.queued} queued`],
    ["blocked", `${counts.blocked} blocked · ${counts.failed} failed · ${counts.needsInput} input`],
    ["elapsed", `${Math.round(elapsed / 1000)}s`],
    ["next", workflowReceiptNextAction(snapshot)],
  ]
}

export function workflowMonitorTaskRows(snapshot: WorkflowReceiptSnapshot, phaseID?: string) {
  const phaseTaskIDs = phaseID ? new Set(snapshot.phases.find((phase) => phase.id === phaseID)?.taskIDs ?? []) : undefined
  return snapshot.tasks
    .flatMap((task) => task.id && task.name && task.phaseID ? [{ id: task.id, state: task.state, name: task.name, phaseID: task.phaseID, blocker: task.blocker, attempt: task.attempt }] : [])
    .filter((task) => !phaseTaskIDs || phaseTaskIDs.has(task.id))
}

export function workflowMonitorSessionID(snapshot?: WorkflowReceiptSnapshot) {
  if (!snapshot) return
  const priority = (state: string) => {
    if (state === "working") return 4
    if (state === "needs_input" || state === "blocked" || state === "failed") return 3
    if (state === "queued") return 2
    return 1
  }
  return snapshot.tasks
    .filter((task): task is WorkflowReceiptSnapshot["tasks"][number] & { sessionID: string } => Boolean(task.sessionID))
    .toSorted((left, right) =>
      priority(right.state) - priority(left.state)
      || (right.startedAt ?? right.completedAt ?? 0) - (left.startedAt ?? left.completedAt ?? 0),
    )[0]?.sessionID ?? snapshot.run.rootSessionID
}

export function workflowMonitorFooter(compact: boolean) {
  return compact
    ? "↑↓/jk select · Enter/o task chat · c creator · p/u/x control · t/f retry · d delete · r refresh · q/Esc back"
    : "↑↓/jk select · Enter/o task chat · c creator · p pause · u resume · x stop · t task · f phase · d delete · r refresh · q/Esc back"
}
