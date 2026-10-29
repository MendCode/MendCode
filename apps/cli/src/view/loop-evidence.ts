import type { Loop } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { clip } from "./deck"
import { wrap } from "./wrap"

const row = (label: string, value: string): Line => [{ text: `${label}  `, fg: "primary" }, { text: value, fg: "text" }]

export function budgetRows(loop: Loop, width: number): Line[] {
  const usage = loop.usage ?? { tokens: 0, costMicros: 0, unknownCostCalls: 0 }
  return [
    row("Tokens", `${loop.runs && !loop.usage ? "unrecorded" : usage.tokens.toLocaleString("en-US")}${loop.costBudget?.maxTokens !== undefined ? ` / ${loop.costBudget.maxTokens.toLocaleString("en-US")}` : " · cap off"}`),
    row("USD", `${loop.runs && !loop.usage ? "unrecorded" : `$${(usage.costMicros / 1_000_000).toFixed(6)}`}${loop.costBudget?.maxCost !== undefined ? ` / $${loop.costBudget.maxCost}` : " · cap off"}`),
    ...(loop.usage?.unreportedTurns ? [row("Unreported", `${loop.usage.unreportedTurns} turns · tokens unknown`)] : []),
    row("Unknown price", `${usage.unknownCostCalls} calls${loop.costBudget?.maxCost !== undefined ? ` · ${loop.costBudget.unknownCost ?? "block"}` : ""}`),
    ...(loop.approvalPolicy?.requireApprovalFor.length ? [row("Approval", loop.approvalPolicy.requireApprovalFor.join(", "))] : []),
    ...(loop.reviewInvalidatedAt !== undefined ? [row("Review", "Settings changed")] : []),
  ].map((line) => clip(line, width))
}

export function evidenceRows(loop: Loop, width: number): Line[] {
  const run = loop.history.at(-1)
  const rows: Line[] = []
  const how = [loop.checks?.length ? `${loop.checks.length} checks` : "", loop.audit === "independent" ? "independent audit" : ""].filter(Boolean)
  if (how.length) rows.push(row("Verify", how.join(" · ")))
  if (!run) return [[{ text: "No runs yet", fg: "muted" }]]
  if (run.checkpointHash) rows.push(row(`Run ${run.run}`, run.checkpointHash.slice(0, 16)))
  for (const gate of run.gates ?? []) {
    rows.push([{ text: `${gate.status === "pass" ? "✓" : "✗"} `, fg: gate.status === "pass" ? "success" : "error" }, { text: gate.id, fg: "text" }, ...(gate.failureClass ? [{ text: ` · ${gate.failureClass}`, fg: "muted" as const }] : [])])
    if (gate.detail) rows.push(...wrap(gate.detail.replace(/\s+/g, " "), Math.max(1, width - 2)).slice(0, 2).map((text): Line => [{ text: `  ${text}`, fg: "body" }]))
    if (gate.waiver) rows.push(row(gate.waiver.action, `${gate.waiver.actor}: ${gate.waiver.reason}`))
  }
  if (run.audit && !run.gates?.some((gate) => gate.id === "independent-audit")) rows.push(row("audit", run.audit.workspaceChanged ? "void: workspace changed" : run.audit.verdict), ...wrap(run.audit.findings, width).slice(0, 2).map((text): Line => [{ text, fg: "body" }]))
  const rubric = run.rubricResult
  if (rubric) {
    rows.push([], row(loop.rubric?.name ?? "Rubric", `${rubric.status} · ${Math.round(rubric.score * 100)}% / ${Math.round(rubric.threshold * 100)}%`))
    for (const criterion of rubric.criteria) {
      rows.push(row(criterion.id, `${criterion.score}/${criterion.maxScore} · ${criterion.passed ? "pass" : "fail"}`))
      rows.push(...wrap(criterion.reason, Math.max(1, width - 2)).slice(0, 2).map((text): Line => [{ text: `  ${text}`, fg: criterion.passed ? "body" : "warning" }]))
      if (criterion.evidence.length) rows.push(row("Evidence", criterion.evidence.join(" · ")))
    }
    for (const blocker of rubric.blockers.filter((entry) => entry.present)) rows.push(row("Blocker", blocker.id))
  } else if (loop.rubric?.criteria.length) rows.push(row("Rubric", `${loop.rubric.criteria.length} criteria · not evaluated`))
  for (const approval of run.approvals ?? []) rows.push(row(`Approved ${approval.action}`, `${approval.evidence.actor}: ${approval.evidence.reason}`))
  return rows.map((line) => clip(line, width))
}
