import { describe, expect, test } from "bun:test"

import { Permission } from "@/permission"
import { WorkflowPolicy } from "@/session/workflow-policy"
import { WorkflowPhaseID, WorkflowTaskID, type WorkflowTask } from "@/session/workflow"

const task = (overrides: Partial<WorkflowTask> = {}): WorkflowTask => ({
  id: WorkflowTaskID.make("policy-task"),
  phaseID: WorkflowPhaseID.make("policy-phase"),
  name: "Policy task",
  kind: "agent",
  prompt: "Inspect the workspace.",
  dependsOn: [],
  output: { kind: "text" },
  ...overrides,
})

describe("workflow policy", () => {
  test("denies report-only side effects and child escalation", () => {
    const rules = WorkflowPolicy.permissionRules({ mode: "report-only" }, { mode: "read-only" })

    expect(Permission.evaluate("edit", "*", rules).action).toBe("deny")
    expect(Permission.evaluate("bash", "*", rules).action).toBe("deny")
    expect(Permission.evaluate("task", "*", rules).action).toBe("deny")
    expect(Permission.evaluate("mcp_github", "*", rules).action).toBe("deny")
    expect(Permission.evaluate("external_send", "*", rules).action).toBe("deny")
  })

  test("keeps approval-required actions pending until explicitly approved", () => {
    const pending = WorkflowPolicy.permissionRules({
      mode: "custom",
      approvalRequiredFor: ["edit", "push"],
    }, undefined)
    const approved = WorkflowPolicy.permissionRules({
      mode: "custom",
      approvalRequiredFor: ["edit", "push"],
      approvedActions: ["edit"],
    }, undefined)

    expect(Permission.evaluate("edit", "*", pending).action).toBe("ask")
    expect(Permission.evaluate("bash", "*", pending).action).toBe("ask")
    expect(Permission.evaluate("edit", "*", approved).action).toBe("allow")
    expect(Permission.evaluate("bash", "*", approved).action).toBe("ask")
  })

  test("normalizes approval aliases without widening unrelated permissions", () => {
    const rules = WorkflowPolicy.permissionRules({
      mode: "custom",
      approvalRequiredFor: ["write"],
      approvedActions: ["edit"],
    }, undefined)

    expect(Permission.evaluate("edit", "*", rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "*", rules).action).toBe("ask")
  })

  test("denies configured external sends even outside report-only mode", () => {
    const rules = WorkflowPolicy.permissionRules({ mode: "custom", allowExternalSend: false }, undefined)

    expect(Permission.evaluate("mcp_github", "*", rules).action).toBe("deny")
    expect(Permission.evaluate("external_send", "*", rules).action).toBe("deny")
  })

  test("fails closed when an allowed tool list is declared", () => {
    const rules = WorkflowPolicy.permissionRules({ mode: "custom", allowedTools: ["read", "write"] }, undefined)

    expect(Permission.evaluate("read", "*", rules).action).toBe("allow")
    expect(Permission.evaluate("edit", "*", rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "*", rules).action).toBe("deny")
    expect(Permission.evaluate("mcp_github", "*", rules).action).toBe("deny")
  })

  test("intersects task tool access with workflow access", () => {
    const result = WorkflowPolicy.taskPolicy({
      workflow: { mode: "custom", allowedTools: ["read", "bash"] },
      task: task({ allowedTools: ["read", "write"] }),
    })

    expect(result.policy?.allowedTools).toEqual(["read"])
    expect(Permission.evaluate("read", "*", result.permission).action).toBe("allow")
    expect(Permission.evaluate("bash", "*", result.permission).action).toBe("deny")
    expect(Permission.evaluate("edit", "*", result.permission).action).toBe("deny")
  })

  test("does not widen an isolated workflow workspace", () => {
    const result = WorkflowPolicy.taskPolicy({
      workspace: { mode: "per-run-worktree" },
      task: task({ workspace: { mode: "in-place" } }),
    })

    expect(result.workspace).toEqual({ mode: "per-run-worktree" })
  })

  test("returns deny-aware tool flags", () => {
    expect(
      WorkflowPolicy.allowedToolFlags(
        { mode: "custom", allowedTools: ["read"] },
        undefined,
        ["read", "bash"],
      ),
    ).toEqual({ read: true, bash: false })
  })
})
