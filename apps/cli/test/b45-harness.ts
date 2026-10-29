import type { ModelsReport, WorkflowSummary } from "@mendcode/protocol"
import { appHarness, ids, NOW, tempDir } from "./session-ui-harness"

export function b45Harness(width: number, height: number, failed = false) {
  const report: ModelsReport = { engine: "native", selectable: true, defaults: { model: "local/main" }, models: [{ id: "local/main", name: "Main", efforts: ["low", "high"] }, { id: "local/workflow", name: "Workflow", efforts: ["low", "high"], variants: { deep: { effort: "high" } } }], roles: { workflow: { model: "local/workflow", variant: "deep" } } }
  const run: WorkflowSummary = {
    workflowId: ids("workflow"), name: "API rewrite", directory: "/work/project", objective: "Port API callers and verify their contract", planHash: "abcd".repeat(16),
    permission: "ask", state: failed ? "failed" : "running", rootSessionId: ids("session"), rounds: 0, repairs: 0, startedAt: NOW - 120_000, updatedAt: NOW,
    tasks: [{ id: "port", title: "Port callers", kind: "agent", mode: "work", needs: [], state: failed ? "failed" : "running", attempt: 1, startedAt: NOW - 60_000, sessionId: ids("session"),
      execution: { directory: "/work/data/workflows/workspaces/wf_api/port", workspace: { mode: "per-run-worktree" }, permission: "ask", readOnly: false, agent: "general", model: { model: "local/workflow", variant: "deep", effort: "high" }, permissions: { mode: "custom", allowedTools: ["read", "edit"], approvalRequiredFor: ["edit"], allowExternalSend: false }, budget: { maxTokens: 20_000, maxCost: 0.5, maxTurns: 10, maxRuntimeMs: 120_000, maxChildren: 0, maxDepth: 1 } },
      usage: { input: failed ? 19_000 : 4_000, output: failed ? 1_000 : 500, calls: 2, children: 0, costMicros: 10_000 },
      ...(failed ? { reason: "token budget exhausted (20000/20000)", endedAt: NOW } : { latest: "edit src/client.ts" }),
    }, { id: "verify", title: "Verify API", kind: "agent", mode: "read", needs: ["port"], state: failed ? "skipped" : "pending", attempt: 0 }],
    ...(failed ? { reason: "task budget exhausted" } : {}),
  }
  const h = appHarness({ width, height, dataDir: tempDir("mend-b45-ui-"), directory: run.directory, reply: (command) => command.type === "workflow.list" ? { ok: true, result: { workflows: [run] } } : command.type === "models.list" ? { ok: true, result: report } : undefined })
  return { ...h, run, report }
}
