import type { WorkflowSummary } from "@mendcode/protocol"
import { appHarness, ids, NOW, tempDir } from "./session-ui-harness"

export function b21Harness(width: number, height: number, state: WorkflowSummary["state"] = "running", empty = false) {
  const run: WorkflowSummary = {
    workflowId: ids("workflow"), name: "API rewrite", directory: "/work/project", objective: "Move the API callers to the typed client",
    planHash: "abcdef0123456789".repeat(4), definitionId: "wfd_api-rewrite", revisionId: "wfr_api-rewrite-v2", revision: 2,
    permission: "ask", state, rootSessionId: ids("session"),
    contract: { criteria: 2, checks: 1, audit: "auto", maxRepairs: 2, maxAudits: 2 },
    tasks: [
      { id: "survey", title: "Survey API callers", kind: "agent", mode: "read", needs: [], state: "done", attempt: 1, sessionId: ids("session"), startedAt: NOW - 120_000, endedAt: NOW - 100_000 },
      { id: "port", title: "Port API callers", kind: "agent", mode: "work", needs: ["survey"], state: state === "failed" ? "failed" : "running", attempt: 2, sessionId: ids("session"), startedAt: NOW - 90_000, ...(state === "failed" ? { endedAt: NOW - 10_000, reason: "Client schema mismatch" } : { latest: "edit src/client.ts" }) },
      { id: "unit", title: "Client tests", kind: "check", needs: ["port"], state: state === "failed" ? "skipped" : "pending", attempt: 0 },
    ],
    rounds: 0, repairs: 0, maxConcurrent: 2, startedAt: NOW - 120_000, updatedAt: NOW,
    ...(state === "failed" ? { reason: "Client schema mismatch" } : {}),
  }
  const h = appHarness({ width, height, dataDir: tempDir("mend-b21-ui-"), directory: run.directory, reply: (command) => command.type === "workflow.list" ? { ok: true, result: { workflows: empty ? [] : [run] } } : undefined })
  return { ...h, run }
}
