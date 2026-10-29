import type { Loop, LoopAudit, LoopCheckpoint, LoopGate, LoopRubricResult } from "@mendcode/protocol"

/** Runtime evidence, scored on v1's 0/5 scale. Worker scores are never authoritative. */
export function evaluateRubric(loop: Loop, checkpoint: LoopCheckpoint, gates: readonly LoopGate[], audit?: LoopAudit): LoopRubricResult | undefined {
  const rubric = loop.rubric
  if (!rubric || !rubric.criteria.length && !rubric.mandatoryBlockers?.length || checkpoint.status !== "complete") return undefined
  const evidence = [...(checkpoint.evidence ?? []), ...(audit?.verdict === "pass" && !audit.workspaceChanged && audit.findings ? [audit.findings] : [])]
  const checks = gates.filter((gate) => loop.checks?.includes(gate.id))
  const checksPass = checks.length === (loop.checks?.length ?? 0) && checks.every((gate) => gate.status === "pass")
  const corpus = [...evidence, ...gates.map((gate) => `${gate.id} ${gate.status} ${gate.detail ?? ""}`)].join("\n").toLowerCase()
  const met = (requirement: string) => {
    const key = requirement.trim().toLowerCase()
    if (key === "checkpoint evidence") return !!checkpoint.evidence?.length
    if (key === "success checks") return checksPass
    if (key === "validation output" || key === "success check output") return checksPass && checks.every((gate) => !!gate.detail)
    if (key === "policy gate status") return gates.filter((gate) => gate.id === "approval-policy").every((gate) => gate.status === "pass")
    if (key === "independent audit") return audit?.verdict === "pass" && !audit.workspaceChanged
    if (key.startsWith("gate:")) return gates.find((gate) => gate.id.toLowerCase() === key.slice(5))?.status === "pass"
    return !!key && corpus.includes(key)
  }
  const weighted = rubric.criteria.map((criterion) => {
    const requirements = criterion.evidenceRequired?.map((item) => item.trim()).filter(Boolean) ?? []
    const found = requirements.filter(met)
    const missing = requirements.filter((item) => !met(item))
    const present = requirements.length ? !missing.length : evidence.length > 0
    const score = present ? 5 : 0
    return { id: criterion.id, score, maxScore: 5 as const, passed: present && score >= (criterion.minScore ?? 0), reason: present ? "Required runtime evidence is present." : `Missing required evidence: ${missing.join(", ") || "concrete completion evidence"}.`.slice(0, 1_000), evidence: (requirements.length ? found : evidence).slice(0, 10).map((item) => item.slice(0, 1_000)), weight: criterion.weight ?? 1 }
  })
  const blockers = (rubric.mandatoryBlockers ?? []).map((id) => {
    const key = id.toLowerCase()
    const present = /configured validation failed/.test(key) ? checks.some((gate) => gate.status !== "pass")
      : /self[- ]assertion/.test(key) ? evidence.length === 0 || /self[- ]assert/.test(corpus)
        : /approval-required action/.test(key) ? gates.some((gate) => gate.id === "approval-policy" && gate.status !== "pass")
          : /secrets? or credentials? exposed/.test(key) ? /(?:bearer\s+[a-z0-9._~+/=-]{8,}|sk-[a-z0-9_-]{8,}|password\s*[:=]\s*\S+)/i.test(corpus)
            : corpus.includes(key)
    return { id, present, reason: `Mandatory blocker ${present ? "detected" : "not detected"}: ${id}.`.slice(0, 500) }
  })
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0)
  const score = total > 0 ? weighted.reduce((sum, entry) => sum + entry.score / 5 * entry.weight, 0) / total : blockers.some((entry) => entry.present) ? 0 : 1
  const threshold = rubric.passThreshold ?? 0.85
  return { status: blockers.some((entry) => entry.present) ? "blocked" : score >= threshold && weighted.every((entry) => entry.passed) ? "pass" : "fail", score, threshold, criteria: weighted.map(({ weight: _weight, ...entry }) => entry), blockers }
}

export function rubricGate(result: LoopRubricResult | undefined): LoopGate | undefined {
  if (!result) return undefined
  return { id: "rubric", status: result.status === "pass" ? "pass" : "fail", ...(result.status === "pass" ? {} : { failureClass: result.status === "blocked" ? "integrity" as const : "quality" as const }), detail: `${Math.round(result.score * 100)}% / ${Math.round(result.threshold * 100)}%${result.status === "blocked" ? ` · ${result.blockers.filter((entry) => entry.present).map((entry) => entry.id).join(", ")}` : ""}`.slice(0, 2_000) }
}
