export type WorkflowReceiptState =
  | "planning"
  | "awaiting_approval"
  | "queued"
  | "working"
  | "needs_input"
  | "blocked"
  | "paused"
  | "completed"
  | "failed"
  | "stopped"
  | string

export type WorkflowReceiptSnapshot = {
  definition: {
    name: string
    description?: string
  }
  revision: {
    plan: {
      objective: string
      model?: { providerID: string; modelID: string; variant?: string }
      completion?: { confirmation?: "same-run" | "next-run" }
    }
  }
  run: {
    id: string
    state: WorkflowReceiptState
    originSessionID?: string
    rootSessionID?: string
    createdAt: number
    updatedAt: number
    completion?: {
      status: string
      generation: number
      auditAttempts: number
      summary?: string
      failedCriteria?: readonly string[]
      auditLease?: { holder: string; expiresAt: number }
      createdAt?: number
      updatedAt?: number
    }
  }
  phases: readonly {
    id?: string
    ordinal?: number
    name?: string
    taskIDs?: readonly string[]
    state: string
    counts: { total: number; queued: number; working: number; completed: number; failed: number; blocked: number }
  }[]
  tasks: readonly {
    id?: string
    name?: string
    phaseID?: string
    state: string
    blocker?: string
    attempt?: number
    sessionID?: string
    startedAt?: number
    completedAt?: number
  }[]
  events?: readonly { summary: string; type: string; createdAt: number }[]
  usage?: { inputTokens?: number; outputTokens?: number; cost?: number }
}

export function workflowReceiptLayout(width: number) {
  const available = Math.max(24, Math.floor(width))
  return {
    compact: available < 72,
    width: Math.min(96, Math.max(32, available - 2)),
    valueWidth: Math.max(12, available - 18),
  }
}

export function workflowReceiptCounts(snapshot: Pick<WorkflowReceiptSnapshot, "tasks" | "phases">) {
  const counts = snapshot.tasks.reduce(
    (result, task) => {
      result.total += 1
      if (task.state === "completed") result.completed += 1
      if (task.state === "working") result.working += 1
      if (task.state === "queued") result.queued += 1
      if (task.state === "blocked" || task.state === "stopped") result.blocked += 1
      if (task.state === "failed") result.failed += 1
      if (task.state === "needs_input") result.needsInput += 1
      return result
    },
    { total: 0, queued: 0, working: 0, completed: 0, failed: 0, blocked: 0, needsInput: 0 },
  )
  return {
    ...counts,
    phases: snapshot.phases.length,
    completedPhases: snapshot.phases.filter((phase) => phase.state === "completed").length,
  }
}

export function workflowReceiptProgress(snapshot: Pick<WorkflowReceiptSnapshot, "tasks">) {
  const counts = workflowReceiptCounts({ tasks: snapshot.tasks, phases: [] })
  if (counts.total === 0) return "0/0 tasks"
  return `${counts.completed}/${counts.total} tasks`
}

export function workflowReceiptStateLabel(state: WorkflowReceiptState) {
  return state.replaceAll("_", " ")
}

const WORKFLOW_ACTIVITY_FRAMES = ["|", "/", "-", "\\"] as const

export function workflowReceiptStateIsAnimated(state: WorkflowReceiptState) {
  return state === "planning" || state === "working"
}

export function workflowReceiptStateIsTerminal(state: WorkflowReceiptState) {
  return state === "completed" || state === "failed" || state === "stopped"
}

export function workflowReceiptStateMarker(state: WorkflowReceiptState, frame = 0) {
  if (workflowReceiptStateIsAnimated(state)) {
    return `[${WORKFLOW_ACTIVITY_FRAMES[Math.abs(frame) % WORKFLOW_ACTIVITY_FRAMES.length]}]`
  }
  if (state === "completed") return "[x]"
  if (state === "failed") return "[!]"
  if (state === "needs_input" || state === "awaiting_approval") return "[?]"
  if (state === "paused") return "[=]"
  if (state === "blocked" || state === "stopped") return "[-]"
  if (state === "queued" || state === "pending") return "[ ]"
  return "[~]"
}

export type WorkflowReceiptPhaseDiagramRow = {
  kind: "phase" | "connector" | "overflow"
  text: string
  state?: string
}

export type WorkflowReceiptPhaseInput = {
  id?: string
  ordinal?: number
  name?: string
  taskIDs?: readonly string[]
  state?: string
  counts?: { total: number; queued: number; working: number; completed: number; failed: number; blocked: number }
}

export function workflowReceiptFallbackPhases(input: {
  live?: readonly WorkflowReceiptPhaseInput[]
  metadata?: readonly WorkflowReceiptPhaseInput[]
  plan?: readonly WorkflowReceiptPhaseInput[]
}): WorkflowReceiptSnapshot["phases"] {
  const phases = input.live?.length ? input.live : input.metadata?.length ? input.metadata : input.plan ?? []
  return phases.map((phase, index) => ({
    id: phase.id,
    ordinal: phase.ordinal ?? index + 1,
    name: phase.name,
    taskIDs: phase.taskIDs,
    state: phase.state ?? "pending",
    counts: phase.counts ?? {
      total: phase.taskIDs?.length ?? 0,
      queued: 0,
      working: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
    },
  }))
}

export function workflowReceiptPhaseDiagram(
  snapshot: Pick<WorkflowReceiptSnapshot, "phases">,
  frame = 0,
  limit = 8,
): WorkflowReceiptPhaseDiagramRow[] {
  const shown = snapshot.phases.slice(0, Math.max(1, limit))
  const rows = shown.flatMap((phase, index): WorkflowReceiptPhaseDiagramRow[] => {
    const ordinal = String(phase.ordinal ?? index + 1).padStart(2, "0")
    const name = (phase.name || phase.id || "phase").replace(/\s+/g, " ").trim()
    const phaseRow = {
      kind: "phase" as const,
      state: phase.state,
      text: `${workflowReceiptStateMarker(phase.state, frame)} ${ordinal} ${name}  ${phase.counts.completed}/${phase.counts.total}`,
    }
    if (index === shown.length - 1) return [phaseRow]
    return [phaseRow, { kind: "connector", text: "     |" }]
  })
  const hidden = snapshot.phases.length - shown.length
  if (hidden > 0) rows.push({ kind: "overflow", text: `     +-- ${hidden} more phase${hidden === 1 ? "" : "s"}` })
  return rows
}

export function workflowReceiptElapsed(snapshot: Pick<WorkflowReceiptSnapshot, "run">, now = Date.now()) {
  const end = ["completed", "failed", "stopped"].includes(snapshot.run.state) ? snapshot.run.updatedAt : now
  return Math.max(0, end - snapshot.run.createdAt)
}

export function workflowReceiptNextAction(snapshot: WorkflowReceiptSnapshot, now = Date.now()) {
  const blocker = snapshot.tasks.find((task) => task.blocker)?.blocker
  if (blocker) return blocker
  if (snapshot.run.state === "needs_input" || snapshot.run.state === "awaiting_approval") return "Operator input or approval required."
  if (snapshot.run.state === "blocked") return "Inspect the blocker before resuming."
  if (snapshot.run.state === "paused" && snapshot.run.completion?.status === "auditing") {
    return "Resume the paused completion audit."
  }
  if (snapshot.run.completion?.status === "candidate") return "Run the fresh completion audit before closing."
  if (snapshot.run.completion?.status === "auditing") {
    const lease = snapshot.run.completion.auditLease
    if (lease && lease.expiresAt <= now) return "Completion audit stalled; resume to reclaim the expired audit lease."
    if (!lease) return "Completion audit is queued for an auditor."
    return "Fresh completion audit is inspecting current evidence."
  }
  if (snapshot.run.completion?.status === "rejected")
    return "Repair the failed completion criteria and regenerate the final evidence."
  if (snapshot.run.state === "paused") return "Resume when the workflow is ready to continue."
  if (snapshot.run.state === "completed") return "Review the final artifact."
  if (snapshot.run.state === "failed") return "Retry the failed task or phase."
  if (snapshot.run.state === "stopped") return "Restart the workflow if more work is needed."
  return snapshot.events?.[0]?.summary ?? "Workflow execution is in progress."
}

export function workflowReceiptUsage(snapshot: Pick<WorkflowReceiptSnapshot, "usage">) {
  const usage = snapshot.usage
  if (!usage) return "usage pending"
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  const cost = usage.cost === undefined ? undefined : `$${usage.cost.toFixed(4)}`
  return [tokens ? `${tokens} tokens` : undefined, cost].filter(Boolean).join(" · ") || "usage pending"
}
