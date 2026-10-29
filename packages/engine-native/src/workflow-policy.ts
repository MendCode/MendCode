import type { WorkflowTaskExecution } from "@mendcode/protocol"
import { permissionMatch, permissionName } from "./permission-rules"

const CHILD = new Set(["task", "loop", "workflow_start", "workflow_script", "workflow_control"])
const EDIT = new Set(["edit", "write", "apply_patch", "patch", "notebook_edit"])
const SHELL = new Set(["shell", "bash", "shell_session"])
const EXTERNAL = /^(mcp[_.]|custom__|external_send$|send$|tell$|notify$|post$|message$)/
const matches = (name: string, actions: string[]) => actions.some((action) => permissionMatch(name, action) || permissionMatch(permissionName(name), permissionName(action)))

export function workflowToolDenied(execution: WorkflowTaskExecution | undefined, name: string, permission?: "read" | "write" | "execute"): string | undefined {
  if (!execution) return undefined
  const policy = execution.permissions
  if (policy?.allowedTools && !policy.allowedTools.includes(name)) return `workflow tool allowlist excludes ${name}`
  if (execution.readOnly && (permission && permission !== "read" || EDIT.has(name) || SHELL.has(name) || CHILD.has(name) || EXTERNAL.test(name) || ["plan_submit", "plan_exit"].includes(name))) return `workflow workspace is read-only: ${name}`
  if (policy?.allowEdits === false && (permission === "write" || EDIT.has(name))) return `workflow edits are disabled: ${name}`
  if (policy?.allowMutatingCommands === false && (permission === "execute" || SHELL.has(name))) return `workflow commands are disabled: ${name}`
  if (policy?.allowExternalSend === false && EXTERNAL.test(name)) return `workflow external sends are disabled: ${name}`
  if (CHILD.has(name) && execution.budget && (execution.budget.maxChildren === 0 || execution.budget.maxDepth !== undefined && execution.budget.maxDepth <= 1)) return `workflow child budget excludes ${name}`
  return undefined
}

/** Approval requests remain requests even in full mode; approvedActions never increases the user's grant. */
export function workflowToolAsks(execution: WorkflowTaskExecution | undefined, name: string, permission?: "read" | "write" | "execute") {
  const policy = execution?.permissions
  return !!policy && (matches(name, policy.approvalRequiredFor ?? []) || permission !== "read" && policy.mode === "custom" && !matches(name, policy.approvedActions ?? []))
}
