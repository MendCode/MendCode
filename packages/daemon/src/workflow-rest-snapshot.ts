import { summarizeWorkflow, type LedgerPage, type WorkflowPlan, type WorkflowRetryPolicy, type WorkflowRevisionReceipt, type WorkflowRun } from "@mendcode/protocol"
import { GATE_PREFIX, restPlanOf, workflowRestIds, workflowRestPreview } from "./workflow-rest-plan"

const taskState = { pending: "pending", running: "working", needs_input: "needs_input", done: "completed", failed: "failed", skipped: "blocked", stopped: "stopped" } as const
const usage = (tasks: WorkflowRun["tasks"]) => tasks.reduce((sum, task) => ({ inputTokens: sum.inputTokens + (task.usage?.input ?? 0), outputTokens: sum.outputTokens + (task.usage?.output ?? 0), cost: sum.cost + (task.usage?.costMicros ?? 0) / 1_000_000 }), { inputTokens: 0, outputTokens: 0, cost: 0 })

function donorModel(model: WorkflowPlan["model"]) {
  if (!model) return undefined
  const colon = model.model.indexOf(":")
  if (colon < 1) return undefined
  return { providerID: model.model.slice(0, colon), modelID: model.model.slice(colon + 1), ...(model.variant ? { variant: model.variant } : {}), ...(model.effort ? { reasoning: model.effort } : {}) }
}

const donorRetry = (retry: WorkflowRetryPolicy | undefined) => retry ? { retry: { maxAttempts: retry.maxAttempts, backoffMs: retry.backoffMs, retryOn: retry.retryOn } } : {}

export function workflowRestPlan(receipt: WorkflowRevisionReceipt) {
  const donor = restPlanOf(receipt)
  if (donor) return donor
  const plan = receipt.plan
  const phases = plan.phases ?? [{ id: "main", title: plan.name, tasks: plan.tasks.map((task) => task.id), barrier: { kind: "all" as const } }]
  const finalTaskID = plan.tasks.at(-1)!.id
  return {
    formatVersion: 1, name: plan.name, description: receipt.definition.description, objective: plan.objective,
    phases: phases.map((phase, index) => ({ id: phase.id, ordinal: index + 1, name: phase.title, barrier: phase.barrier, taskIDs: phase.tasks })),
    tasks: plan.tasks.map((task) => ({
      id: task.id, phaseID: phases.find((phase) => phase.tasks.includes(task.id))!.id, name: task.title,
      kind: task.kind === "check" ? "validate" : task.kind === "map" ? "map" : task.kind === "human" ? "human" : task.id === finalTaskID ? "synthesize" : "agent",
      prompt: task.kind === "check" ? task.command : task.kind === "map" ? task.map.taskTemplate.prompt : task.prompt, dependsOn: task.needs,
      output: task.kind === "agent" ? task.output ?? { kind: "text" } : task.kind === "map" ? { kind: "json" } : task.kind === "human" ? { kind: "text" } : { kind: "none" },
      ...(task.kind === "agent" ? { model: donorModel(task.model), agentProfile: task.agent, allowedTools: task.allowedTools, workspace: task.workspace, permissions: task.permissions, budget: task.budget, inputs: task.inputs?.map(({ taskId, ...selector }) => ({ ...selector, taskID: taskId })) } : {}),
      ...(task.kind === "agent" || task.kind === "check" ? donorRetry(task.retry) : task.kind === "map" ? donorRetry(task.map.taskTemplate.retry) : {}),
    })), finalTaskID, completionCriteria: typeof plan.contract === "object" ? plan.contract.criteria.map((criterion) => criterion.text) : [], requiredGates: [],
    model: donorModel(plan.model), workspace: plan.workspace, permissions: plan.permissions, budget: { ...plan.budget, maxConcurrency: plan.maxConcurrent, ...(plan.retention ? { retention: plan.retention } : {}) }, overlapPolicy: plan.overlapPolicy,
  }
}

export function workflowRestReceipt(receipt: WorkflowRevisionReceipt) {
  return { definitionID: receipt.definitionId, revisionID: receipt.revisionId, revision: receipt.revision, plan: workflowRestPlan(receipt), preview: workflowRestPreview(receipt.plan, restPlanOf(receipt)) }
}

export function workflowRestSnapshot(run: WorkflowRun, receipt: WorkflowRevisionReceipt, events: LedgerPage, artifacts: LedgerPage) {
  const donor = restPlanOf(receipt), plan = workflowRestPlan(receipt)
  const ids = donor ? workflowRestIds(donor) : undefined
  const taskId = (id: string) => ids ? [...ids.tasks].find(([, native]) => native === id)?.[0] ?? id.replace(/^(task-\d+)(-\d+)$/, (_, parent, suffix) => `${[...ids.tasks].find(([, native]) => native === parent)?.[0] ?? parent}${suffix}`) : id
  const phaseId = (id: string) => ids ? [...ids.phases].find(([, native]) => native === id)?.[0] ?? id : id
  const isGate = (task: WorkflowRun["tasks"][number]) => taskId(task.id).startsWith(GATE_PREFIX)
  const phases = plan.phases.map((phase) => {
    const tasks = run.tasks.filter((task) => phase.taskIDs.includes(taskId(task.mapParentId ?? task.id)) && !task.mapRetired)
    const states = tasks.map((task) => taskState[task.state])
    const count = (state: string) => states.filter((value) => value === state).length
    const nativePhase = summarizeWorkflow(run).phases?.find((entry) => phaseId(entry.id) === phase.id)
    const state = nativePhase?.state === "done" ? "completed" : run.state === "paused" ? "paused" : states.includes("needs_input") ? "needs_input" : states.includes("working") ? "working" : states.includes("failed") ? "failed" : states.every((value) => value === "completed") ? "completed" : states.every((value) => value === "stopped") ? "stopped" : "pending"
    return { id: phase.id, ordinal: phase.ordinal, name: phase.name, description: "description" in phase ? phase.description : undefined, barrier: phase.barrier, state, counts: { total: tasks.length, queued: count("pending"), working: count("working") + count("needs_input"), completed: count("completed"), failed: count("failed"), blocked: count("blocked") }, ...(tasks.some((task) => task.usage) ? { usage: usage(tasks) } : {}) }
  })
  return {
    definition: { id: receipt.definitionId, projectID: run.directory, name: receipt.definition.name, description: receipt.definition.description, source: receipt.definition.source, ownerSessionID: receipt.definition.ownerSessionId, currentRevision: receipt.definition.currentRevision, saved: receipt.definition.saved, createdAt: receipt.definition.createdAt, updatedAt: receipt.definition.updatedAt },
    revision: { id: receipt.revisionId, definitionID: receipt.definitionId, revision: receipt.revision, plan, planHash: receipt.planHash, immutable: true, createdAt: receipt.createdAt },
    run: { id: run.workflowId, definitionID: receipt.definitionId, revisionID: receipt.revisionId, revision: receipt.revision, originSessionID: run.originSessionId, rootSessionID: run.rootSessionId, loopID: run.loopId, loopRunID: run.loopRunId, permissionMode: run.permissionMode ?? run.plan.permissions?.mode, sessionPermissionMode: run.sessionPermission ? { ask: "approval", edits: "smart", full: "full_access" }[run.sessionPermission] : undefined, state: run.state === "running" || run.state === "verifying" ? "working" : run.state, currentPhaseID: phases.find((phase) => phase.state !== "completed")?.id, createdAt: run.startedAt, updatedAt: run.updatedAt },
    preview: workflowRestPreview(run.plan, donor), phases,
    tasks: run.tasks.filter((task) => !task.mapRetired && !isGate(task)).map((task) => {
      const spec = plan.tasks.find((entry) => entry.id === taskId(task.mapParentId ?? task.id))
      return { ...spec, id: taskId(task.id), name: task.title, phaseID: spec?.phaseID ?? "main", dependsOn: task.needs.map(taskId), state: taskState[task.state], attempt: task.attempt, sessionID: task.sessionId, startedAt: task.startedAt, completedAt: task.endedAt, blocker: task.reason, ...(task.usage ? { usage: usage([task]) } : {}), ...(task.output ? { value: task.output } : {}) }
    }),
    events: events.entries.map((entry) => ({ id: `${run.workflowId}:event:${entry.sequence}`, sequence: entry.sequence, level: entry.kind.includes("failed") ? "error" : entry.kind.includes("permissions") ? "decision" : "info", type: entry.kind, title: entry.title, summary: entry.summary, createdAt: entry.at, data: entry.data })),
    artifacts: artifacts.entries.map((entry) => ({ id: `${run.workflowId}:artifact:${entry.sequence}`, runID: run.workflowId, taskID: entry.taskId ? taskId(entry.taskId) : undefined, kind: entry.kind, summary: entry.summary, status: entry.data.state === "failed" || entry.data.status === "fail" ? "invalid" : entry.kind === "task-output" || entry.kind === "plan" || entry.kind === "task-spec" || entry.data.state === "done" ? "valid" : "pending", schemaValidated: false, outputRefs: [], evidence: [], sessionID: entry.sessionId, attempt: typeof entry.data.attempt === "number" && entry.data.attempt > 0 ? entry.data.attempt : undefined, createdAt: entry.at, data: entry.data })),
    gates: [
      // Approval gates the user answers (standalone required gates and human tasks that name one) come first.
      ...run.tasks.filter((task) => task.kind === "human" && (isGate(task) || donor?.requiredGates.includes(taskId(task.id)))).map((task) => ({ id: taskId(task.id).replace(GATE_PREFIX, ""), state: task.state === "done" ? "pass" : task.state === "failed" ? "fail" : "blocked", required: true, reason: task.reason ?? (task.state === "done" ? task.result : undefined) })),
      ...run.verifications.flatMap((round) => round.gates.map((gate) => ({ id: `${round.round}:${gate.id}`, state: gate.status === "pass" ? "pass" : gate.status === "fail" ? "fail" : "blocked", required: true, reason: gate.detail }))),
    ],
    ...(run.tasks.some((task) => task.usage) ? { usage: usage(run.tasks) } : {}),
    native: { permission: run.permission, state: run.state, plan: run.plan, verifications: run.verifications },
    pagination: { events: { nextBefore: events.nextBefore, truncated: events.truncated }, artifacts: { nextBefore: artifacts.nextBefore, truncated: artifacts.truncated } },
  }
}
