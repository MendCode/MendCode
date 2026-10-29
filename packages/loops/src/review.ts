import type { Command, Loop, LoopGate, LoopGateWaiver } from "@mendcode/protocol"

export type LoopReviewInput = Omit<Extract<Command, { type: "loop.review" }>, "type" | "id" | "clientId" | "loopId">

export function reviewSettingsChanged(previous: Loop, next: Loop) {
  if (!previous.costBudget && !previous.rubric && !previous.approvalPolicy && !next.costBudget && !next.rubric && !next.approvalPolicy) return false
  const settings = (loop: Loop) => [
    loop.objective, loop.criteria ?? "", loop.budget, loop.checks ?? [], loop.audit ?? "none", loop.reportOnly ?? false, loop.workspace ?? "in-place",
    loop.costBudget?.maxTokens, loop.costBudget?.maxCost, loop.costBudget?.unknownCost ?? "block",
    loop.rubric?.passThreshold ?? 0.85,
    loop.rubric?.criteria.map((item) => [item.id, item.description, item.weight ?? 1, item.minScore ?? 0, item.evidenceRequired ?? []]) ?? [],
    loop.rubric?.mandatoryBlockers ?? [],
    [...(loop.approvalPolicy?.requireApprovalFor ?? [])].sort(),
  ]
  return JSON.stringify(settings(previous)) !== JSON.stringify(settings(next))
}

const patterns = { push: /\b(?:git\s+push|pushed?|push)\b/i, merge: /\b(?:merged?|merge)\b/i, deploy: /\b(?:deploy(?:ed|ment)?|production)\b/i, publish: /\b(?:publish(?:ed)?|release)\b/i, delete: /\b(?:delet(?:e|ed|ion)|remove(?:d)?|rm\s+-rf)\b/i }

export function approvalGate(loop: Loop): LoopGate | undefined {
  if (!loop.approvalPolicy?.requireApprovalFor.length) return undefined
  const run = loop.history.at(-1)
  const checkpoint = run?.checkpoint
  const corpus = [checkpoint?.summary, checkpoint?.next, ...(checkpoint?.evidence ?? [])].join("\n")
  const attempted = loop.approvalPolicy.requireApprovalFor.filter((action) => patterns[action].test(corpus))
  const missing = attempted.filter((action) => !run?.approvals?.some((entry) => entry.action === action && entry.evidence.checkpointHash === run.checkpointHash))
  return { id: "approval-policy", status: missing.length ? "fail" : "pass", ...(missing.length ? { failureClass: "policy", detail: `Approval required: ${missing.join(", ")}.` } : { detail: attempted.length ? `Approved: ${attempted.join(", ")}.` : "No approval-required action reported." }) }
}

export function protectedGate(gate: LoopGate) {
  return gate.failureClass === "budget" || gate.failureClass === "policy" || gate.failureClass === "integrity" || gate.id === "cost-budget" || gate.id === "approval-policy"
}

export function reviewSettingsGate(loop: Loop): LoopGate | undefined {
  return loop.reviewInvalidatedAt === undefined ? undefined : { id: "review-settings", status: "fail", failureClass: "integrity", detail: "Review settings changed; run again before reviewing the claim." }
}

/** Reviews stay bound to the latest finished run; safety gates are not quality waivers. */
export function reviewLoop(loop: Loop, input: LoopReviewInput, at: number): { ok: true; loop: Loop } | { ok: false; message: string } {
  const run = loop.history.at(-1)
  if (!input.reviewer.trim() || !input.reason.trim()) return { ok: false, message: "review needs a reviewer and reason" }
  if (loop.reviewInvalidatedAt !== undefined) return { ok: false, message: "review settings changed; run again before reviewing the claim" }
  if (!run || run.endedAt === undefined || run.run !== input.run || run.checkpointHash !== input.checkpointHash) return { ok: false, message: "stale run or checkpoint; reload before reviewing" }
  if (loop.state === "running" || loop.state === "verifying" || loop.state === "needs_input" || loop.state === "stopped" || loop.state === "completed") return { ok: false, message: `the loop is ${loop.state}; review its finished claim after verification` }
  if (input.action !== "approve" && run.checkpoint?.status !== "complete") return { ok: false, message: "review requires a completion proposal" }
  const evidence: LoopGateWaiver = { action: input.action, actor: input.reviewer.trim(), reason: input.reason.trim(), at, checkpointHash: input.checkpointHash }
  let approvals = run.approvals
  if (input.action === "approve") {
    if (!input.approvalAction || !loop.approvalPolicy?.requireApprovalFor.includes(input.approvalAction)) return { ok: false, message: "unknown approval action" }
    approvals = [...(approvals ?? []).filter((entry) => entry.action !== input.approvalAction), { action: input.approvalAction, evidence }]
  }
  let gates = run.gates ?? []
  const failed = gates.filter((gate) => gate.status === "fail")
  const targets = input.action === "waive" ? failed.filter((gate) => gate.id === input.gateId) : input.action === "accept" ? failed : []
  if (input.action === "waive" && targets.length !== 1) return { ok: false, message: "select one failed gate" }
  const critical = targets.find(protectedGate)
  if (critical) return { ok: false, message: `gate ${critical.id} is protected and cannot be waived` }
  if (input.action === "accept" && !targets.length && !gates.some((gate) => gate.waiver)) return { ok: false, message: "accept requires a failed quality gate or a prior waiver" }
  gates = gates.map((gate) => targets.includes(gate) ? { ...gate, status: "pass" as const, waiver: evidence } : gate)
  let updated: Loop = { ...loop, history: [...loop.history.slice(0, -1), { ...run, gates, ...(approvals ? { approvals } : {}) }], updatedAt: at }
  if (input.action === "approve") {
    const policy = approvalGate(updated)!
    gates = gates.map((gate) => gate.id === "approval-policy" ? { ...policy, waiver: evidence } : gate)
    updated = { ...updated, history: [...updated.history.slice(0, -1), { ...updated.history.at(-1)!, gates }] }
  }
  const { nextWakeAt: _wake, ...rest } = updated
  return { ok: true, loop: { ...rest, state: input.action === "accept" ? "completed" : "blocked", reason: `${input.action === "accept" ? "Completion accepted" : input.action === "approve" ? `Action ${input.approvalAction} approved` : `Gate ${input.gateId} waived`} by ${evidence.actor}: ${evidence.reason}`.slice(0, 500), ...(input.action === "accept" ? { override: { reason: evidence.reason, at } } : {}) } }
}
