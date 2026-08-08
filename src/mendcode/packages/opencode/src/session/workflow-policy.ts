import { Permission } from "@/permission"
import type { WorkflowPermissionPolicy, WorkflowTask, WorkflowWorkspacePolicy } from "./workflow"

const EDIT_TOOLS = ["edit", "write", "apply_patch"] as const
const MUTATING_TOOLS = ["bash", "shell"] as const
const CHILD_TOOLS = ["task", "loop"] as const
const EXTERNAL_SIDE_EFFECT_TOOLS = ["external_send", "send", "notify", "post", "message", "mcp_*"] as const

const approvalPermission = (action: string) => {
  const normalized = action.trim().toLowerCase()
  if (normalized === "edit" || normalized === "write" || normalized === "apply_patch") return "edit"
  if (normalized === "shell" || normalized === "bash" || normalized === "destructive-shell") return "bash"
  if (normalized === "subagent" || normalized === "task") return "task"
  return action.trim()
}

const sideEffectRules = (permission: string, action: Permission.Action): Permission.Rule[] => [
  { permission, pattern: "*", action },
]

export const effectivePolicy = (
  workflow: WorkflowPermissionPolicy | undefined,
  task: WorkflowPermissionPolicy | undefined,
): WorkflowPermissionPolicy | undefined => {
  if (!workflow && !task) return undefined
  const mode =
    workflow?.mode === "report-only" || task?.mode === "report-only"
      ? ("report-only" as const)
      : workflow?.mode === "custom" || task?.mode === "custom"
        ? ("custom" as const)
        : ("normal" as const)
  const allowedTools =
    workflow?.allowedTools && task?.allowedTools
      ? workflow.allowedTools.filter((tool) => task.allowedTools?.includes(tool))
      : (workflow?.allowedTools ?? task?.allowedTools)
  const required = Array.from(
    new Set([...(workflow?.approvalRequiredFor ?? []), ...(task?.approvalRequiredFor ?? [])].map(approvalPermission)),
  )
  const approved =
    workflow?.approvedActions && task?.approvedActions
      ? workflow.approvedActions
          .filter((action) =>
            task.approvedActions?.some((candidate) => approvalPermission(candidate) === approvalPermission(action)),
          )
          .map(approvalPermission)
      : (workflow?.approvedActions ?? task?.approvedActions)?.map(approvalPermission)
  return {
    mode,
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(required.length ? { approvalRequiredFor: required } : {}),
    ...(approved?.length ? { approvedActions: approved } : {}),
    ...(workflow?.allowEdits === false || task?.allowEdits === false || mode === "report-only"
      ? { allowEdits: false }
      : {}),
    ...(workflow?.allowMutatingCommands === false || task?.allowMutatingCommands === false || mode === "report-only"
      ? { allowMutatingCommands: false }
      : {}),
    ...(workflow?.allowExternalSend === false || task?.allowExternalSend === false || mode === "report-only"
      ? { allowExternalSend: false }
      : {}),
  }
}

export const permissionPolicyForMode = (
  policy: WorkflowPermissionPolicy | undefined,
  mode: WorkflowPermissionPolicy["mode"] | undefined,
): WorkflowPermissionPolicy | undefined => {
  if (!mode) return policy
  if (mode === "normal") {
    return {
      mode,
      ...(policy?.allowedTools === undefined ? {} : { allowedTools: policy.allowedTools }),
      allowEdits: true,
      allowMutatingCommands: true,
      allowExternalSend: true,
    }
  }
  if (mode === "report-only") {
    return {
      mode,
      ...(policy?.allowedTools === undefined ? {} : { allowedTools: policy.allowedTools }),
    }
  }
  return policy ?? { mode }
}

export const effectiveWorkspace = (
  workflow: WorkflowWorkspacePolicy | undefined,
  task: WorkflowWorkspacePolicy | undefined,
): WorkflowWorkspacePolicy | undefined => {
  if (!workflow) return task
  if (!task || workflow.mode === task.mode) return workflow
  if (workflow.mode === "read-only" || task.mode === "read-only") return { mode: "read-only" }
  if (workflow.mode === "in-place") return task
  return workflow
}

export const permissionRules = (
  policy: WorkflowPermissionPolicy | undefined,
  workspace: WorkflowWorkspacePolicy | undefined,
): Permission.Ruleset => {
  if (!policy && !workspace) return []
  const reportOnly = policy?.mode === "report-only" || workspace?.mode === "read-only"
  const approved = new Set((policy?.approvedActions ?? []).map(approvalPermission))
  const required = new Set(policy?.approvalRequiredFor ?? [])
  const rules: Permission.Ruleset = []

  if (policy?.allowedTools !== undefined) {
    rules.push(...sideEffectRules("*", "deny"))
    for (const tool of policy.allowedTools) {
      rules.push(...sideEffectRules(approvalPermission(tool), "allow"))
    }
  }

  if (policy?.mode === "normal" && policy.allowedTools === undefined) {
    for (const tool of EDIT_TOOLS) rules.push(...sideEffectRules(tool === "write" ? "edit" : tool, "allow"))
    for (const tool of MUTATING_TOOLS) rules.push(...sideEffectRules(tool, "allow"))
    for (const tool of CHILD_TOOLS) rules.push(...sideEffectRules(tool, "allow"))
    for (const tool of EXTERNAL_SIDE_EFFECT_TOOLS) rules.push(...sideEffectRules(tool, "allow"))
  }

  for (const action of required) {
    const permission = approvalPermission(action)
    rules.push(...sideEffectRules(permission, approved.has(permission) ? "allow" : "ask"))
  }

  if (reportOnly || policy?.allowEdits === false) {
    for (const tool of EDIT_TOOLS) rules.push(...sideEffectRules(tool === "write" ? "edit" : tool, "deny"))
  }
  if (reportOnly || policy?.allowMutatingCommands === false) {
    for (const tool of MUTATING_TOOLS) rules.push(...sideEffectRules(tool, "deny"))
  }
  if (reportOnly || policy?.allowExternalSend === false) {
    for (const tool of EXTERNAL_SIDE_EFFECT_TOOLS) rules.push(...sideEffectRules(tool, "deny"))
  }
  if (reportOnly) {
    for (const tool of CHILD_TOOLS) rules.push(...sideEffectRules(tool, "deny"))
    rules.push(...sideEffectRules("mcp_*", "deny"))
  }

  return rules
}

export const allowedToolFlags = (
  policy: WorkflowPermissionPolicy | undefined,
  workspace: WorkflowWorkspacePolicy | undefined,
  requested: readonly string[] | undefined,
) => {
  const candidates = requested ?? []
  return candidates.length === 0
    ? undefined
    : Object.fromEntries(
        candidates.map((tool) => [
          tool,
          Permission.evaluate(approvalPermission(tool), "*", permissionRules(policy, workspace)).action !== "deny",
        ]),
      )
}

export const workspaceInstruction = (workspace: WorkflowWorkspacePolicy | undefined) => {
  if (workspace?.mode === "read-only")
    return "Workspace policy: read-only. Inspect and report only; do not edit files or run mutating shell commands."
  if (workspace?.mode === "per-loop-worktree")
    return "Workspace policy: per-loop-worktree. Do not create, promote, or remove worktrees from this task."
  if (workspace?.mode === "per-run-worktree")
    return "Workspace policy: per-run-worktree. Do not create, promote, or remove worktrees from this task."
  return "Workspace policy: in-place. Keep changes minimal and auditable."
}

export const taskPolicy = (input: {
  readonly workflow?: WorkflowPermissionPolicy
  readonly task: WorkflowTask
  readonly workspace?: WorkflowWorkspacePolicy
  readonly maxDepth?: number
}) => {
  const taskPermissions = input.task.permissions
    ? {
        ...input.task.permissions,
        ...(input.task.allowedTools === undefined
          ? {}
          : {
              allowedTools: input.task.permissions.allowedTools
                ? input.task.permissions.allowedTools.filter((tool) => input.task.allowedTools?.includes(tool))
                : input.task.allowedTools,
            }),
      }
    : input.task.allowedTools === undefined
      ? undefined
      : { mode: "custom" as const, allowedTools: input.task.allowedTools }
  const policy = effectivePolicy(input.workflow, taskPermissions)
  const workspace = effectiveWorkspace(input.workspace, input.task.workspace)
  const permission = permissionRules(policy, workspace)
  if (input.maxDepth !== undefined && input.maxDepth <= 1) permission.push(...sideEffectRules("task", "deny"))
  return {
    policy,
    permission,
    tools: allowedToolFlags(policy, workspace, input.task.allowedTools),
    workspace,
  }
}

export * as WorkflowPolicy from "./workflow-policy"
