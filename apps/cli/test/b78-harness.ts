import { WorkflowPlan, summarizeWorkflow } from "@mendcode/protocol"
import { advanceMaps, createRun, finishTask, startTask } from "../../../packages/workflows/src/run"
import { b78MapPlan } from "../../../packages/workflows/test/b78-harness"
import { appHarness, ids, NOW, tempDir } from "./session-ui-harness"

export type B78Screen = "map" | "queue" | "barrier" | "preview"
export const B78_SCREENS: B78Screen[] = ["map", "queue", "barrier", "preview"]

export function b78Harness(width: number, height: number, screen: B78Screen = "map") {
  const plan = WorkflowPlan.parse(b78MapPlan({ overlapPolicy: "queue" }))
  let run = createRun({ workflowId: ids("workflow"), rootSessionId: ids("session"), plan, planHash: "abcd".repeat(16), directory: "/work/project", permission: "ask", at: NOW - 120_000 })
  run = startTask(run, "source", { at: NOW - 110_000, sessionId: ids("session") })
  if (screen === "queue") run = { ...run, state: "queued", queuedBehind: ids("workflow"), tasks: run.tasks.map((task) => ({ ...task, state: "pending", attempt: 0 })) }
  else if (screen === "barrier") run = finishTask(run, "source", { at: NOW - 100_000, outcome: "failed", reason: "workflow output does not match its schema" })
  else {
    run = finishTask(run, "source", { at: NOW - 100_000, outcome: "done", result: "Two files", output: { kind: "json", value: '["src/api.ts","src/client.ts"]' } })
    run = advanceMaps(run, NOW - 90_000)
    run = startTask(run, "review-1", { at: NOW - 80_000, sessionId: ids("session") })
    run = startTask(run, "review-2", { at: NOW - 80_000, sessionId: ids("session") })
    run = finishTask(run, "review-1", { at: NOW - 30_000, outcome: "done", result: "API reviewed", output: { kind: "artifact", artifactKind: "review", value: '{"file":"src/api.ts"}' } })
  }
  const summary = summarizeWorkflow(run)
  const preview = { name: plan.name, tasks: plan.tasks.map((task) => ({ id: task.id, kind: task.kind, ...(task.kind === "map" ? { map: { maxItems: task.map.maxItems } } : {}) })), phases: plan.phases, permission: "ask", checks: [], overlapPolicy: plan.overlapPolicy }
  const current = appHarness({ width, height, dataDir: tempDir("mend-b78-ui-"), directory: run.directory, reply: (command) => command.type === "workflow.list" ? { ok: true, result: { workflows: [summary] } } : command.type === "workflow.preview" ? { ok: true, result: { problems: [], summary: preview } } : command.type === "workflow.start" ? { ok: true, result: { workflow: summary } } : undefined })
  return { ...current, run, summary }
}
