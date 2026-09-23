import type { ResolvedCompoundProfile } from "@/mend/config/compound-models"

import { completionValidationCommandAllowed } from "./completion-validation"
import type { WorkflowPlan } from "./workflow-plan"
import type { WorkflowCompoundTask, WorkflowTask } from "./workflow"

export type CompoundPlanIssue = {
  readonly code:
    | "compound-kind"
    | "compound-output"
    | "compound-model-ambiguous"
    | "compound-workspace"
    | "compound-checks"
    | "compound-check-command"
    | "compound-profile"
    | "compound-resolution"
    | "compound-concurrency"
  readonly path: readonly string[]
  readonly message: string
}

export type CompoundSnapshot = NonNullable<ResolvedCompoundProfile>["snapshot"]

const issue = (
  code: CompoundPlanIssue["code"],
  path: readonly string[],
  message: string,
): CompoundPlanIssue => ({ code, path, message })

const resolvedProfile = (task: WorkflowTask, profile?: ResolvedCompoundProfile) => {
  if (profile) return profile.snapshot
  const resolved = task.compound?.resolved
  return resolved && typeof resolved === "object" ? (resolved as CompoundSnapshot) : undefined
}

export function validateCompoundTask(input: {
  readonly task: WorkflowTask
  readonly plan?: WorkflowPlan
  readonly profile?: ResolvedCompoundProfile
}): readonly CompoundPlanIssue[] {
  const { task, plan } = input
  const compound = task.compound
  if (!compound) return []
  const issues: CompoundPlanIssue[] = []
  // `human` is the private compatibility sentinel produced by materialize.
  if (task.kind !== "agent" && task.kind !== "human") {
    issues.push(issue("compound-kind", ["tasks", task.id, "kind"], "Compound execution is only allowed for agent tasks."))
  }
  if (task.output.kind !== "text") {
    issues.push(issue("compound-output", ["tasks", task.id, "output"], "Compound tasks must produce bounded textual candidates."))
  }
  if (task.model) {
    issues.push(issue("compound-model-ambiguous", ["tasks", task.id, "model"], "A compound task cannot override its profile primary model."))
  }
  if (task.workspace?.mode !== "per-run-worktree") {
    issues.push(issue("compound-workspace", ["tasks", task.id, "workspace", "mode"], "Compound tasks require a per-run-worktree workspace."))
  }
  if (!compound.profile.trim()) {
    issues.push(issue("compound-profile", ["tasks", task.id, "compound", "profile"], "Compound profile name cannot be empty."))
  }
  if (compound.validationChecks.length === 0) {
    issues.push(issue("compound-checks", ["tasks", task.id, "compound", "validationChecks"], "Compound tasks require at least one deterministic validation check."))
  }
  const checkIDs = new Set<string>()
  for (const [index, check] of compound.validationChecks.entries()) {
    if (!check.id.trim() || checkIDs.has(check.id)) {
      issues.push(issue("compound-checks", ["tasks", task.id, "compound", "validationChecks", String(index), "id"], "Validation check IDs must be unique and non-empty."))
    }
    checkIDs.add(check.id)
    if (!check.command.trim() || !completionValidationCommandAllowed(check.command)) {
      issues.push(issue("compound-check-command", ["tasks", task.id, "compound", "validationChecks", String(index), "command"], "Compound validation commands must use the existing deterministic allowlist."))
    }
  }
  if (plan?.budget?.maxConcurrency !== 1) {
    issues.push(issue("compound-concurrency", ["budget", "maxConcurrency"], "Compound workflows require maxConcurrency=1."))
  }
  const snapshot = resolvedProfile(task, input.profile)
  if (!snapshot) {
    issues.push(issue("compound-resolution", ["tasks", task.id, "compound", "resolved"], "Compound execution requires a resolved immutable profile snapshot."))
  } else if (snapshot.name !== compound.profile) {
    issues.push(issue("compound-resolution", ["tasks", task.id, "compound", "profile"], "Resolved profile snapshot does not match the requested profile."))
  }
  return issues
}

export function materializeCompoundTask(input: {
  readonly task: WorkflowTask
  readonly plan: WorkflowPlan
  readonly profile?: ResolvedCompoundProfile
}): { readonly task?: WorkflowTask; readonly issues: readonly CompoundPlanIssue[] } {
  const issues = validateCompoundTask(input)
  if (issues.length) return { issues }
  const compound = input.task.compound!
  const snapshot = resolvedProfile(input.task, input.profile)!
  return {
    task: {
      ...input.task,
      kind: "human",
      compound: {
        ...compound,
        configHash: compound.configHash ?? (input.profile?.configHash ?? undefined),
        resolved: snapshot as any,
      },
    },
    issues,
  }
}

export function materializeCompoundPlan(
  plan: WorkflowPlan,
  profiles: Readonly<Record<string, ResolvedCompoundProfile>> = {},
): { readonly plan?: WorkflowPlan; readonly issues: readonly CompoundPlanIssue[] } {
  const issues: CompoundPlanIssue[] = []
  const tasks = plan.tasks.map((task) => {
    if (!task.compound) return task
    const result = materializeCompoundTask({ task, plan, profile: profiles[task.compound.profile] })
    issues.push(...result.issues)
    return result.task ?? task
  })
  return issues.length ? { issues } : { plan: { ...plan, tasks }, issues }
}

export function isCompoundTask(task: Pick<WorkflowTask, "compound">) {
  return task.compound !== undefined
}
