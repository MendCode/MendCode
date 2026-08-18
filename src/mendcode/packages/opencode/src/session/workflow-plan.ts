import { Schema, Types } from "effect"

import { zod } from "@/util/effect-zod"
import { NonNegativeInt, PositiveInt, withStatics } from "@/util/schema"
import {
  WorkflowArtifactSelector,
  WorkflowBudget,
  WorkflowDefinitionID,
  WorkflowModelRoute,
  WorkflowOverlapPolicy,
  WorkflowOutputContract,
  WorkflowPermissionPolicy,
  WorkflowPhase,
  WorkflowRevisionID,
  WorkflowTask,
  WorkflowTaskID,
  WorkflowTaskTemplate,
  WorkflowWorkspacePolicy,
} from "./workflow"
export const WorkflowPlan = Schema.Struct({
  formatVersion: PositiveInt.annotate({ description: "Workflow plan format version. Use 1." }),
  name: Schema.String.annotate({ description: "Concise workflow display name." }),
  description: Schema.String.annotate({ description: "What the workflow does and its boundaries." }),
  objective: Schema.String.annotate({ description: "Durable outcome the complete workflow must achieve." }),
  phases: Schema.Array(WorkflowPhase).annotate({ description: "Ordered execution stages. Each phase must list all of its task IDs." }),
  tasks: Schema.Array(WorkflowTask).annotate({ description: "Complete DAG of workflow tasks. Every task must belong to one phase." }),
  finalTaskID: WorkflowTaskID.annotate({ description: "Existing synthesize task that produces the workflow's final non-none output." }),
  completionCriteria: Schema.Array(Schema.String).annotate({ description: "Concrete criteria that prove the workflow finished successfully. Must not be empty." }),
  requiredGates: Schema.Array(Schema.String).annotate({ description: "Approval gates required before execution. Use [] for immediate execution." }),
  model: Schema.optional(WorkflowModelRoute),
  workspace: Schema.optional(WorkflowWorkspacePolicy),
  permissions: Schema.optional(WorkflowPermissionPolicy),
  budget: Schema.optional(WorkflowBudget).annotate({ description: "Optional execution limits. Omit unless limits are required; maxFanOut must cover bounded task and map fan-out." }),
  overlapPolicy: Schema.optional(WorkflowOverlapPolicy),
}).pipe(withStatics((schema) => ({ zod: zod(schema) })))
export type WorkflowPlan = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowPlan>>

export const WorkflowRevision = Schema.Struct({
  id: WorkflowRevisionID,
  definitionID: WorkflowDefinitionID,
  revision: PositiveInt,
  plan: WorkflowPlan,
  planHash: Schema.String,
  immutable: Schema.Boolean,
  createdAt: NonNegativeInt,
})
export type WorkflowRevision = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowRevision>>

export const WorkflowPlanPreview = Schema.Struct({
  phaseCount: Schema.Int,
  taskCount: Schema.Int,
  taskUpperBound: Schema.Int,
  maxConcurrency: Schema.Int,
  maxFanOut: Schema.Int,
  sideEffectClasses: Schema.Array(Schema.String),
  estimatedTokenLimit: Schema.optional(Schema.Int),
  estimatedCostLimit: Schema.optional(Schema.Number),
})
export type WorkflowPlanPreview = Types.DeepMutable<Schema.Schema.Type<typeof WorkflowPlanPreview>>

export type WorkflowPlanValidationCode =
  | "invalid-identifier"
  | "duplicate-identifier"
  | "missing-reference"
  | "missing-artifact-dependency"
  | "dependency-cycle"
  | "invalid-phase"
  | "invalid-phase-dependency"
  | "invalid-barrier"
  | "invalid-final-task"
  | "invalid-completion-criteria"
  | "unsupported-output"
  | "unsafe-fan-out"
  | "policy-contradiction"

export interface WorkflowPlanValidationIssue {
  readonly code: WorkflowPlanValidationCode
  readonly message: string
  readonly path: readonly string[]
}

export interface WorkflowPlanValidationResult {
  readonly valid: boolean
  readonly issues: readonly WorkflowPlanValidationIssue[]
  readonly preview?: WorkflowPlanPreview
}

const identifierPattern = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/

const issue = (
  code: WorkflowPlanValidationCode,
  message: string,
  path: readonly string[] = [],
): WorkflowPlanValidationIssue => ({ code, message, path })

const hasDuplicate = <T>(values: readonly T[]) => new Set(values).size !== values.length

const isJsonOutput = (output: WorkflowTask["output"]) => output.kind === "json"

const sideEffectClasses = (plan: WorkflowPlan) => {
  const classes = new Set<string>()
  const policies = [plan.permissions, ...plan.tasks.map((task) => task.permissions)]
  for (const policy of policies) {
    if (policy?.allowEdits || policy?.allowMutatingCommands) classes.add("filesystem-or-shell")
    if (policy?.allowExternalSend) classes.add("external-send")
    if (policy?.approvalRequiredFor?.length) classes.add("approval-required")
  }
  return [...classes]
}

const taskUpperBound = (plan: WorkflowPlan) =>
  plan.tasks.reduce((total, task) => total + (task.kind === "map" && task.map ? task.map.maxItems : 1), 0)

const validateOutput = (output: WorkflowOutputContract, label: string, path: readonly string[]) => {
  const issues: WorkflowPlanValidationIssue[] = []
  if (output.kind === "json" && !output.schema) {
    issues.push(issue("unsupported-output", `JSON output for ${label} must declare a schema`, [...path, "schema"]))
  }
  if (output.kind === "artifact" && (!output.artifactKind || output.artifactKind.trim().length === 0)) {
    issues.push(issue("unsupported-output", `Artifact output for ${label} must use a non-empty artifact kind`, [...path, "artifactKind"]))
  }
  return issues
}

const validateSelector = (
  selector: WorkflowArtifactSelector,
  taskIDs: ReadonlySet<string>,
  label: string,
  path: readonly string[],
) => {
  if (taskIDs.has(selector.taskID)) return []
  return [issue("missing-reference", `${label} references missing task ${selector.taskID}`, [...path, "taskID"])]
}

const validatePermission = (permissions: WorkflowPermissionPolicy | undefined, label: string, path: readonly string[]) => {
  if (permissions?.mode !== "report-only") return []
  if (!permissions.allowEdits && !permissions.allowMutatingCommands && !permissions.allowExternalSend) return []
  return [issue("policy-contradiction", `Report-only policy for ${label} cannot allow side effects`, path)]
}

const validatePolicyInheritance = (
  workflow: WorkflowPlan,
  task: WorkflowTask,
  path: readonly string[],
) => {
  const issues: WorkflowPlanValidationIssue[] = []
  const workflowPermissions = workflow.permissions
  const taskPermissions = task.permissions
  if (workflowPermissions?.mode === "report-only" && taskPermissions?.mode !== undefined && taskPermissions.mode !== "report-only") {
    issues.push(issue("policy-contradiction", `Task ${task.id} cannot widen a report-only workflow`, [...path, "mode"]))
  }
  if (workflowPermissions?.allowEdits === false && taskPermissions?.allowEdits === true) {
    issues.push(issue("policy-contradiction", `Task ${task.id} cannot enable edits disabled by the workflow`, [...path, "allowEdits"]))
  }
  if (workflowPermissions?.allowMutatingCommands === false && taskPermissions?.allowMutatingCommands === true) {
    issues.push(issue("policy-contradiction", `Task ${task.id} cannot enable mutating commands disabled by the workflow`, [...path, "allowMutatingCommands"]))
  }
  if (workflowPermissions?.allowExternalSend === false && taskPermissions?.allowExternalSend === true) {
    issues.push(issue("policy-contradiction", `Task ${task.id} cannot enable external sends disabled by the workflow`, [...path, "allowExternalSend"]))
  }
  if (workflow?.workspace?.mode === "read-only" && task.workspace?.mode !== undefined && task.workspace.mode !== "read-only") {
    issues.push(issue("policy-contradiction", `Task ${task.id} cannot widen a read-only workflow workspace`, ["tasks", task.id, "workspace", "mode"]))
  }
  if (workflowPermissions?.approvedActions && taskPermissions?.approvedActions) {
    const approved = new Set(workflowPermissions.approvedActions)
    for (const action of taskPermissions.approvedActions) {
      if (!approved.has(action)) {
        issues.push(issue("policy-contradiction", `Task ${task.id} cannot approve an action not approved by the workflow`, [...path, "approvedActions"]))
      }
    }
  }
  return issues
}

const validateTemplate = (template: WorkflowTaskTemplate, label: string, path: readonly string[]) =>
  validateOutput(template.output, label, [...path, "output"])

export const validateWorkflowPlan = (plan: WorkflowPlan): WorkflowPlanValidationResult => {
  const issues: WorkflowPlanValidationIssue[] = []
  const phases = new Map<string, WorkflowPhase>()
  const tasks = new Map<string, WorkflowTask>()
  const taskIDs = new Set(plan.tasks.map((task) => task.id))
  const phaseOrdinals = new Set<number>()

  if (plan.phases.length === 0) issues.push(issue("invalid-phase", "A workflow plan must contain at least one phase", ["phases"]))
  if (plan.tasks.length === 0) issues.push(issue("invalid-phase", "A workflow plan must contain at least one task", ["tasks"]))
  if (plan.completionCriteria.length === 0) {
    issues.push(issue("invalid-completion-criteria", "A workflow plan must define at least one completion criterion", ["completionCriteria"]))
  }
  if (plan.completionCriteria.some((criterion) => criterion.trim().length === 0)) {
    issues.push(issue("invalid-completion-criteria", "Completion criteria cannot be empty", ["completionCriteria"]))
  }
  if (hasDuplicate(plan.requiredGates)) {
    issues.push(issue("duplicate-identifier", "Required gates must have unique identifiers", ["requiredGates"]))
  }

  for (const [index, phase] of plan.phases.entries()) {
    if (!identifierPattern.test(phase.id)) issues.push(issue("invalid-identifier", `Invalid phase identifier: ${phase.id}`, ["phases", String(index), "id"]))
    if (phases.has(phase.id)) issues.push(issue("duplicate-identifier", `Duplicate phase identifier: ${phase.id}`, ["phases", String(index), "id"]))
    phases.set(phase.id, phase)
    if (phaseOrdinals.has(phase.ordinal)) issues.push(issue("invalid-phase", `Duplicate phase ordinal: ${phase.ordinal}`, ["phases", String(index), "ordinal"]))
    phaseOrdinals.add(phase.ordinal)
    if (phase.taskIDs.length === 0) issues.push(issue("invalid-phase", `Phase ${phase.id} contains no tasks`, ["phases", String(index), "taskIDs"]))
    if (hasDuplicate(phase.taskIDs)) issues.push(issue("duplicate-identifier", `Phase ${phase.id} repeats a task identifier`, ["phases", String(index), "taskIDs"]))

    if (phase.barrier.kind === "quorum" && phase.barrier.quorum > phase.taskIDs.length) {
      issues.push(issue("invalid-barrier", `Phase ${phase.id} quorum exceeds its task count`, ["phases", String(index), "barrier", "quorum"]))
    }
    if (phase.barrier.kind === "condition" && phase.barrier.expression.trim().length === 0) {
      issues.push(issue("invalid-barrier", `Phase ${phase.id} has an empty barrier condition`, ["phases", String(index), "barrier", "expression"]))
    }
  }

  for (const [index, task] of plan.tasks.entries()) {
    if (!identifierPattern.test(task.id)) issues.push(issue("invalid-identifier", `Invalid task identifier: ${task.id}`, ["tasks", String(index), "id"]))
    if (tasks.has(task.id)) issues.push(issue("duplicate-identifier", `Duplicate task identifier: ${task.id}`, ["tasks", String(index), "id"]))
    tasks.set(task.id, task)
    const phase = phases.get(task.phaseID)
    if (!phase) {
      issues.push(issue("missing-reference", `Task ${task.id} references missing phase ${task.phaseID}`, ["tasks", String(index), "phaseID"]))
    } else if (!phase.taskIDs.includes(task.id)) {
      issues.push(issue("invalid-phase", `Phase ${phase.id} does not list task ${task.id}`, ["tasks", String(index), "phaseID"]))
    }

    if (hasDuplicate(task.dependsOn)) issues.push(issue("duplicate-identifier", `Task ${task.id} repeats a dependency`, ["tasks", String(index), "dependsOn"]))
    for (const dependency of task.dependsOn) {
      if (!tasks.has(dependency) && !plan.tasks.some((candidate) => candidate.id === dependency)) {
        issues.push(issue("missing-reference", `Task ${task.id} references missing dependency ${dependency}`, ["tasks", String(index), "dependsOn"]))
      }
    }

    for (const [inputIndex, selector] of (task.inputs ?? []).entries()) {
      issues.push(...validateSelector(selector, taskIDs, `Task ${task.id}`, ["tasks", String(index), "inputs", String(inputIndex)]))
    }
    issues.push(...validateOutput(task.output, `task ${task.id}`, ["tasks", String(index), "output"]))
    if (task.output.kind === "none" && task.kind === "synthesize") {
      issues.push(issue("unsupported-output", `Synthesis task ${task.id} must produce an output`, ["tasks", String(index), "output"]))
    }

    if (task.kind === "map") {
      if (!task.map) issues.push(issue("unsafe-fan-out", `Map task ${task.id} must define a bounded map specification`, ["tasks", String(index), "map"]))
      if (!isJsonOutput(task.output)) {
        issues.push(issue("unsupported-output", `Map task ${task.id} must emit a JSON descriptor output`, ["tasks", String(index), "output"]))
      }
      if (task.map) {
        issues.push(...validateSelector(task.map.source, taskIDs, `Map task ${task.id}`, ["tasks", String(index), "map", "source"]))
        issues.push(...validateTemplate(task.map.taskTemplate, `map task ${task.id}`, ["tasks", String(index), "map", "taskTemplate"]))
        if (task.map.maxItems > (plan.budget?.maxFanOut ?? 0)) {
          issues.push(issue("unsafe-fan-out", `Map task ${task.id} exceeds the plan fan-out budget`, ["tasks", String(index), "map", "maxItems"]))
        }
      }
    } else if (task.map) {
      issues.push(issue("invalid-phase", `Only map tasks may define a map specification`, ["tasks", String(index), "map"]))
    }

    issues.push(...validatePermission(task.permissions, `task ${task.id}`, ["tasks", String(index), "permissions"]))
    issues.push(...validatePolicyInheritance(plan, task, ["tasks", String(index), "permissions"]))
  }

  for (const phase of plan.phases) {
    for (const taskID of phase.taskIDs) {
      if (!tasks.has(taskID)) issues.push(issue("missing-reference", `Phase ${phase.id} references missing task ${taskID}`, ["phases", phase.id, "taskIDs"]))
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (taskID: string, path: readonly string[]) => {
    if (visiting.has(taskID)) {
      issues.push(issue("dependency-cycle", `Dependency cycle detected: ${[...path, taskID].join(" -> ")}`, ["tasks", taskID, "dependsOn"]))
      return
    }
    if (visited.has(taskID)) return
    const task = tasks.get(taskID)
    if (!task) return
    visiting.add(taskID)
    for (const dependency of task.dependsOn) visit(dependency, [...path, taskID])
    visiting.delete(taskID)
    visited.add(taskID)
  }
  for (const task of plan.tasks) visit(task.id, [])

  for (const [index, task] of plan.tasks.entries()) {
    const dependencies = new Set<string>()
    const pending = [...task.dependsOn]
    while (pending.length) {
      const dependencyID = pending.pop()!
      if (dependencies.has(dependencyID)) continue
      dependencies.add(dependencyID)
      const dependency = tasks.get(dependencyID)
      if (dependency) pending.push(...dependency.dependsOn)
    }
    const selectors = [...(task.inputs ?? []), ...(task.map ? [task.map.source] : [])]
    for (const selector of selectors) {
      if (!tasks.has(selector.taskID) || dependencies.has(selector.taskID)) continue
      issues.push(
        issue(
          "missing-artifact-dependency",
          `Task ${task.id} references artifacts from ${selector.taskID} without depending on that producer`,
          ["tasks", String(index), "dependsOn"],
        ),
      )
    }
  }

  for (const task of plan.tasks) {
    const phase = phases.get(task.phaseID)
    for (const dependencyID of task.dependsOn) {
      const dependency = tasks.get(dependencyID)
      const dependencyPhase = dependency ? phases.get(dependency.phaseID) : undefined
      if (phase && dependencyPhase && dependencyPhase.ordinal > phase.ordinal) {
        issues.push(issue("invalid-phase-dependency", `Task ${task.id} depends on a task in a later phase`, ["tasks", task.id, "dependsOn"]))
      }
    }
  }

  const finalTask = tasks.get(plan.finalTaskID)
  if (!finalTask) {
    issues.push(issue("missing-reference", `Final task does not exist: ${plan.finalTaskID}`, ["finalTaskID"]))
  } else if (finalTask.kind !== "synthesize") {
    issues.push(issue("invalid-final-task", `Final task ${plan.finalTaskID} must be a synthesis task`, ["finalTaskID"]))
  }

  issues.push(...validatePermission(plan.permissions, "workflow", ["permissions"]))
  if (plan.overlapPolicy === "replace" && plan.permissions?.mode === "report-only") {
    issues.push(issue("policy-contradiction", "Report-only workflows cannot use replace overlap policy", ["overlapPolicy"]))
  }

  const upperBound = taskUpperBound(plan)
  const maxFanOut = plan.budget?.maxFanOut ?? upperBound
  if (upperBound > maxFanOut) issues.push(issue("unsafe-fan-out", "The plan task upper bound exceeds its fan-out budget", ["budget", "maxFanOut"]))

  const preview: WorkflowPlanPreview = {
    phaseCount: plan.phases.length,
    taskCount: plan.tasks.length,
    taskUpperBound: upperBound,
    maxConcurrency: plan.budget?.maxConcurrency ?? Math.max(1, Math.min(upperBound, 32)),
    maxFanOut,
    sideEffectClasses: sideEffectClasses(plan),
    ...(plan.budget?.maxTokens === undefined ? {} : { estimatedTokenLimit: plan.budget.maxTokens }),
    ...(plan.budget?.maxCost === undefined ? {} : { estimatedCostLimit: plan.budget.maxCost }),
  }

  return issues.length > 0 ? { valid: false, issues } : { valid: true, issues, preview }
}

export const assertValidWorkflowPlan = (plan: WorkflowPlan): WorkflowPlanPreview => {
  const result = validateWorkflowPlan(plan)
  if (!result.valid || !result.preview) {
    throw new Error(result.issues.map((entry) => `${entry.code}: ${entry.message}`).join("; "))
  }
  return result.preview
}

export * as WorkflowPlanContract from "./workflow-plan"
