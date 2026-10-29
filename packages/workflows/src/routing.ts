import type { WorkflowPermissionPolicy, WorkflowPlan, WorkflowRun, WorkflowTaskBudget, WorkflowTaskExecution, WorkflowTaskSpec, WorkflowTaskUsage } from "@mendcode/protocol"
import { agentSpecs } from "./composition"

const RANK = { ask: 0, edits: 1, full: 2 }
const intersect = (a?: string[], b?: string[]) => a && b ? a.filter((name) => b.includes(name)) : a ?? b

/** Restrictions compose; an explicit task request can never increase the run's grant. */
export function taskExecution(run: WorkflowRun, spec: WorkflowTaskSpec): WorkflowTaskExecution {
  const plan = run.plan
  const task = spec.kind === "agent" ? spec : undefined
  const a = plan.permissions
  const b = task?.permissions
  const specWorkspace = spec.kind === "human" ? undefined : spec.workspace
  const readOnly = task?.mode === "read" || a?.mode === "report-only" || b?.mode === "report-only" || plan.workspace?.mode === "read-only" || specWorkspace?.mode === "read-only"
  const permissions: WorkflowPermissionPolicy | undefined = a || b || task?.allowedTools ? {
    mode: readOnly ? "report-only" : a?.mode === "custom" || b?.mode === "custom" ? "custom" : "normal",
    ...(intersect(intersect(a?.allowedTools, b?.allowedTools), task?.allowedTools) !== undefined ? { allowedTools: intersect(intersect(a?.allowedTools, b?.allowedTools), task?.allowedTools) } : {}),
    approvalRequiredFor: [...new Set([...(a?.approvalRequiredFor ?? []), ...(b?.approvalRequiredFor ?? [])])],
    ...(intersect(a?.approvedActions, b?.approvedActions) ? { approvedActions: intersect(a?.approvedActions, b?.approvedActions) } : {}),
    ...(readOnly || a?.allowEdits === false || b?.allowEdits === false ? { allowEdits: false } : {}),
    ...(readOnly || a?.allowMutatingCommands === false || b?.allowMutatingCommands === false ? { allowMutatingCommands: false } : {}),
    ...(readOnly || a?.allowExternalSend === false || b?.allowExternalSend === false ? { allowExternalSend: false } : {}),
  } : undefined
  const requested = task?.permission ?? run.permission
  const workspace = readOnly ? { mode: "read-only" as const } : plan.workspace && plan.workspace.mode !== "in-place" ? plan.workspace : specWorkspace ?? plan.workspace ?? { mode: "in-place" as const }
  const budget: WorkflowTaskBudget = {}
  for (const key of ["maxTurns", "maxRuntimeMs", "maxTokens", "maxCost", "maxChildren", "maxDepth"] as const) {
    const limits = [plan.budget?.[key], task?.budget?.[key]].filter((value): value is number => value !== undefined)
    if (limits.length) budget[key] = Math.min(...limits)
  }
  return {
    directory: run.directory,
    workspace,
    readOnly,
    permission: RANK[requested] < RANK[run.permission] ? requested : run.permission,
    ...(task?.model ?? plan.model ? { model: task?.model ?? plan.model } : {}),
    ...(task?.engine ? { engine: task.engine } : {}),
    ...(task?.agent ?? plan.agent ? { agent: task?.agent ?? plan.agent } : {}),
    ...(permissions ? { permissions } : {}),
    ...(Object.keys(budget).length ? { budget } : {}),
  }
}

/** Reject contradictory policies at preview/save, rather than silently promising broader authority. */
export function routingProblems(plan: WorkflowPlan): string[] {
  const problems: string[] = []
  const policy = (value: WorkflowPermissionPolicy | undefined, label: string) => {
    if (value?.mode === "report-only" && (value.allowEdits || value.allowMutatingCommands || value.allowExternalSend)) problems.push(`${label}: report-only cannot allow side effects`)
  }
  policy(plan.permissions, "permissions")
  if (typeof plan.contract === "object" && plan.contract.checks.length && (plan.permissions?.mode === "report-only" || plan.permissions?.allowMutatingCommands === false || plan.workspace?.mode === "read-only")) problems.push("contract checks: host commands are disabled by the workflow policy")
  for (const task of plan.tasks) {
    if (task.kind === "check") {
      if (plan.permissions?.mode === "report-only" || plan.permissions?.allowMutatingCommands === false || plan.workspace?.mode === "read-only" || task.workspace?.mode === "read-only") problems.push(`check task "${task.id}": host commands are disabled by the workflow policy`)
      continue
    }
  }
  for (const task of agentSpecs(plan)) {
    policy(task.permissions, `task "${task.id}" permissions`)
    for (const flag of ["allowEdits", "allowMutatingCommands", "allowExternalSend"] as const) if (plan.permissions?.[flag] === false && task.permissions?.[flag] === true) problems.push(`task "${task.id}": cannot enable ${flag} disabled by the workflow`)
    if (plan.permissions?.mode === "report-only" && task.permissions && task.permissions.mode !== "report-only") problems.push(`task "${task.id}": cannot widen a report-only workflow`)
    if (plan.workspace?.mode === "read-only" && task.workspace && task.workspace.mode !== "read-only") problems.push(`task "${task.id}": cannot widen a read-only workspace`)
  }
  return problems
}

export const emptyTaskUsage = (): WorkflowTaskUsage => ({ input: 0, output: 0, calls: 0, children: 0 })

export function totalTaskUsage(run: WorkflowRun): WorkflowTaskUsage {
  return run.tasks.reduce((sum, task) => {
    const usage = task.usage ?? emptyTaskUsage()
    return { input: sum.input + usage.input, output: sum.output + usage.output, calls: sum.calls + usage.calls, children: sum.children + usage.children, costMicros: (sum.costMicros ?? 0) + (usage.costMicros ?? 0), costUnknown: sum.costUnknown || usage.costUnknown || false }
  }, emptyTaskUsage())
}

/** Once a reported limit is consumed, stop before another call or side effect. Unknown prices fail closed. */
export function budgetReason(budget: WorkflowTaskBudget | undefined, usage: WorkflowTaskUsage, includeCalls = true): string | undefined {
  if (!budget) return undefined
  if (budget.maxRuntimeMs === 0) return "task runtime limit exceeded"
  if (budget.maxTokens !== undefined && usage.input + usage.output >= budget.maxTokens) return `token budget exhausted (${usage.input + usage.output}/${budget.maxTokens})`
  if (budget.maxCost !== undefined && usage.costUnknown) return "cost budget cannot be enforced: provider price is unknown"
  if (budget.maxCost !== undefined && (usage.costMicros ?? 0) >= Math.round(budget.maxCost * 1_000_000)) return `cost budget exhausted ($${((usage.costMicros ?? 0) / 1_000_000).toFixed(4)}/$${budget.maxCost})`
  if (includeCalls && budget.maxTurns !== undefined && usage.calls >= budget.maxTurns) return `model-call budget exhausted (${usage.calls}/${budget.maxTurns})`
  return undefined
}
