import { ModelChoice, RestWorkflowPlan, WorkflowPlan, type WorkflowArtifactSelector, type WorkflowPlan as NativePlan, type WorkflowRetryPolicy, type WorkflowRevisionReceipt } from "@mendcode/protocol"

export class UnsupportedWorkflowPlan extends Error {}
const nativeId = (id: string, index: number, prefix: string) => /^[a-z][a-z0-9_-]{0,39}$/.test(id) ? id : `${prefix}-${index + 1}`

/** Required gates with no human task of the same id: each becomes a native approval task in a first phase. */
export const standaloneGates = (plan: Pick<RestWorkflowPlan, "requiredGates" | "tasks">) => plan.requiredGates.filter((gate) => !plan.tasks.some((task) => task.kind === "human" && task.id === gate))
export const GATE_PREFIX = "gate:"
export const GATE_PHASE = "gates"

export function workflowRestIds(plan: RestWorkflowPlan) {
  // Indexed IDs avoid collisions with donor names that already look like generated IDs.
  const tasks = new Map<string, string>([...plan.tasks.map((task, index): [string, string] => [task.id, `task-${index + 1}`]), ...standaloneGates(plan).map((gate, index): [string, string] => [`${GATE_PREFIX}${gate}`, `gate-${index + 1}`])])
  const phases = new Map(plan.phases.map((phase, index) => [phase.id, `phase-${index + 1}`]))
  return { tasks, phases }
}

const retryPolicy = (retry: RestWorkflowPlan["tasks"][number]["retry"]): WorkflowRetryPolicy | undefined => {
  if (!retry) return undefined
  if (retry.maxAttempts !== undefined && retry.maxAttempts > 6) throw new UnsupportedWorkflowPlan("Per-task retry maxAttempts above 6 exceeds the native attempt limit")
  if (retry.backoffMs !== undefined && retry.backoffMs > 3_600_000) throw new UnsupportedWorkflowPlan("Per-task retry backoff above one hour exceeds the native limit")
  // The donor retries transient failures three times, one second apart, when neither maxAttempts nor retryOn is given.
  if (retry.maxAttempts === undefined) return retry.retryOn === undefined ? { maxAttempts: 3, backoffMs: retry.backoffMs ?? 1_000, retryOn: ["transient"] } : undefined
  return { maxAttempts: retry.maxAttempts, backoffMs: retry.backoffMs ?? 0, retryOn: retry.retryOn?.length ? retry.retryOn : ["transient", "environment"] }
}

export function nativeWorkflowPlan(value: RestWorkflowPlan | NativePlan, catalog: Array<{ id: string; provider?: string }> = []): { plan: NativePlan; restPlan?: RestWorkflowPlan } {
  if (!("formatVersion" in value)) return { plan: WorkflowPlan.parse(value) }
  const source = RestWorkflowPlan.parse(value)
  if (new Set(source.requiredGates).size !== source.requiredGates.length) throw new Error("Duplicate required gate")
  for (const task of source.tasks.filter((entry) => entry.kind === "human")) {
    if (task.output.kind !== "none" && task.output.kind !== "text") throw new UnsupportedWorkflowPlan("Human tasks return a text note or nothing; JSON and artifact outputs are not supported")
    if (task.inputs?.length) throw new UnsupportedWorkflowPlan("Human tasks cannot select inputs from other tasks")
  }
  if (source.phases.some((phase, i, phases) => phases.some((other, j) => j !== i && other.ordinal === phase.ordinal))) throw new Error("Duplicate phase ordinal")
  if (new Set(source.tasks.map((task) => task.id)).size !== source.tasks.length || new Set(source.phases.map((phase) => phase.id)).size !== source.phases.length) throw new Error("Duplicate workflow identifier")
  const final = source.tasks.find((task) => task.id === source.finalTaskID)
  if (final?.kind !== "synthesize" || final.output.kind === "none") throw new Error("finalTaskID must name a synthesis task with output")
  for (const task of source.tasks) {
    const phase = source.phases.find((phase) => phase.id === task.phaseID)
    if (!phase?.taskIDs.includes(task.id) || source.phases.filter((phase) => phase.taskIDs.includes(task.id)).length !== 1) throw new Error("Task must belong to exactly its declared phase")
    if (task.kind === "map" && (!task.map || task.output.kind !== "json")) throw new Error("Map task requires a map specification and JSON output")
    if (task.kind !== "map" && task.map) throw new Error("Only map tasks may declare map specifications")
    if (task.output.kind === "json" && !task.output.schema) throw new Error("JSON output requires a schema")
  }
  const bound = source.tasks.reduce((sum, task) => sum + (task.map?.maxItems ?? 0), source.tasks.length)
  if (source.budget?.maxFanOut !== undefined && source.budget.maxFanOut < bound) throw new Error("Workflow fan-out exceeds maxFanOut")
  const ids = workflowRestIds(source)
  const taskId = (id: string) => { const result = ids.tasks.get(id); if (!result) throw new Error("Unknown task reference"); return result }
  const selector = (input: { taskID: string; path?: string | undefined; projection?: string | undefined; required?: boolean | undefined }): WorkflowArtifactSelector => {
    const { taskID, ...rest } = input
    return { ...rest, taskId: taskId(taskID) }
  }
  const model = (input: RestWorkflowPlan["model"]) => {
    if (!input) return undefined
    const found = catalog.find((entry) => entry.provider === input.providerID && [input.modelID, `${input.providerID}:${input.modelID}`].includes(entry.id))
    if (!found) throw new Error("Unknown workflow provider/model pair")
    return ModelChoice.parse({ model: found.id, ...(input.variant ? { variant: input.variant } : {}), ...(input.reasoning ? { effort: input.reasoning } : {}) })
  }
  const route = (input: Pick<RestWorkflowPlan["tasks"][number], "model" | "agentProfile" | "allowedTools" | "workspace" | "permissions" | "budget">) => ({ model: model(input.model), agent: input.agentProfile, allowedTools: input.allowedTools, workspace: input.workspace, permissions: input.permissions, budget: input.budget })
  const criteria = source.completion?.criteria?.map((criterion, index) => ({ id: nativeId(criterion.id, index, "criterion"), text: criterion.description, owners: criterion.ownerTaskIDs?.map(taskId) })) ?? source.completionCriteria.map((text, i) => ({ id: `criterion-${i + 1}`, text, owners: [taskId(source.finalTaskID)] }))
  const { maxConcurrency, maxFanOut: _fanOut, retention, ...budget } = source.budget ?? {}
  const gates = standaloneGates(source).map((gate) => ({ id: taskId(`${GATE_PREFIX}${gate}`), title: `Approve ${gate}`.slice(0, 80), kind: "human", prompt: `Approval gate "${gate}": approve to let this workflow run, or reject to stop it.`, needs: [] }))
  const plan = WorkflowPlan.parse({
    name: source.name, objective: source.objective,
    tasks: [...gates, ...source.tasks.map((task) => {
      const common = { id: taskId(task.id), title: task.name, needs: task.dependsOn.map(taskId) }
      if (task.kind === "human") return { ...common, kind: "human", prompt: task.prompt }
      if (task.kind === "map" && task.map) return { ...common, kind: "map", workspace: task.workspace, map: { source: selector(task.map.source), maxItems: task.map.maxItems, taskTemplate: { title: task.name, prompt: task.map.taskTemplate.prompt, mode: ["verify", "validate"].includes(task.map.taskTemplate.kind) ? "read" : "work", output: task.map.taskTemplate.output, retry: retryPolicy(task.map.taskTemplate.retry), ...route(task.map.taskTemplate) } } }
      return { ...common, kind: "agent", prompt: task.prompt, mode: ["verify", "validate"].includes(task.kind) ? "read" : "work", output: task.output, inputs: task.inputs?.map(selector), retry: retryPolicy(task.retry), ...route(task) }
    })],
    phases: [...(gates.length ? [{ id: GATE_PHASE, title: "Approval gates", tasks: gates.map((gate) => gate.id), barrier: { kind: "all" } }] : []), ...[...source.phases].sort((a, b) => a.ordinal - b.ordinal).map((phase) => ({ id: ids.phases.get(phase.id), title: phase.name, tasks: phase.taskIDs.map(taskId), barrier: phase.barrier }))],
    contract: { criteria, checks: source.completion?.validationChecks?.map((check, i) => ({ id: nativeId(check.id, i, "check"), command: check.command, ...(check.timeoutMs ? { timeoutSeconds: Math.ceil(check.timeoutMs / 1000) } : {}) })) ?? [], audit: source.completion ? "independent" : "auto", ...(source.completion?.maxAuditAttempts ? { maxAudits: source.completion.maxAuditAttempts } : {}) },
    model: model(source.model), workspace: source.workspace, permissions: source.permissions,
    ...(source.budget ? { budget } : {}), ...(retention ? { retention } : {}), maxConcurrent: maxConcurrency ?? Math.max(1, Math.min(bound, 4)), overlapPolicy: source.overlapPolicy,
  })
  return { plan, restPlan: source }
}

export function restPlanOf(receipt: WorkflowRevisionReceipt): RestWorkflowPlan | undefined {
  return receipt.restPlan ? RestWorkflowPlan.parse(receipt.restPlan) : undefined
}

export function workflowRestPreview(plan: NativePlan, restPlan?: RestWorkflowPlan) {
  const tasks = plan.tasks.map((task) => task.kind === "map" ? task.map.taskTemplate : task)
  const policies = [plan.permissions, ...tasks.flatMap((task) => "permissions" in task ? [task.permissions] : [])]
  return {
    phaseCount: plan.phases?.length ?? 1, taskCount: plan.tasks.length,
    taskUpperBound: plan.tasks.reduce((count, task) => count + (task.kind === "map" ? task.map.maxItems : 1), 0),
    maxConcurrency: Math.min(plan.maxConcurrent ?? 2, plan.tasks.reduce((count, task) => count + (task.kind === "map" ? task.map.maxItems : 1), 0)),
    maxFanOut: restPlan?.budget?.maxFanOut ?? plan.tasks.reduce((count, task) => count + (task.kind === "map" ? task.map.maxItems : 1), 0),
    sideEffectClasses: [...new Set(policies.flatMap((policy) => [policy?.allowEdits || policy?.allowMutatingCommands ? "filesystem-or-shell" : undefined, policy?.allowExternalSend ? "external-send" : undefined, policy?.approvalRequiredFor?.length ? "approval-required" : undefined].filter((value): value is string => !!value)))],
    ...(plan.budget?.maxTokens !== undefined ? { estimatedTokenLimit: plan.budget.maxTokens } : {}), ...(plan.budget?.maxCost !== undefined ? { estimatedCostLimit: plan.budget.maxCost } : {}),
  }
}
