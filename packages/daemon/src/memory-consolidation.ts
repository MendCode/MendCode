import { redactSecrets, type DreamReport, type MemoryEntry } from "@mendcode/protocol"
import { sharedMemoryRevision } from "@mendcode/store"
import { CONSOLIDATOR_BATCH, type ConsolidatorDecision, type SemanticConsolidator } from "./memory-consolidator"

const normalized = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()

function duplicate(left: string, right: string) {
  if (!left || !right) return false
  if (left.includes(right) || right.includes(left)) return true
  const a = new Set(left.split(" ").filter((word) => word.length > 3))
  const b = new Set(right.split(" ").filter((word) => word.length > 3))
  const common = [...a].filter((word) => b.has(word)).length
  return common >= 4 && common >= .8 * Math.min(a.size, b.size) && common >= .65 * Math.max(a.size, b.size)
}

type Decision = NonNullable<DreamReport["consolidation"]>["decisions"][number]

const isMerge = (decision: ConsolidatorDecision | undefined) => decision?.resolution === "merge" || decision?.resolution === "supersede"
const clip = (text: string) => text.slice(0, 200)

/**
 * Consolidates pending proposals. The host's gates (duplicates, redaction, sensitivity, scores, category, user/pinned targets) are
 * always authoritative. Without `semantic` they alone decide, which is v1's default consolidator. With it, the configured
 * `memoryConsolidator` model recommends per proposal: it may archive, point a duplicate at its canonical memory or ask for review,
 * and its scores can only tighten the gates, never loosen them. A batch the model cannot answer falls back to the gates.
 */
export async function consolidateMemory(input: {
  entries(): MemoryEntry[]
  policy: "disabled" | "preview" | "auto-consolidate"
  limit: number
  apply(memory: MemoryEntry): Promise<void>
  archive(memory: MemoryEntry): void
  semantic?: SemanticConsolidator
}): Promise<NonNullable<DreamReport["consolidation"]> & { fallback?: string }> {
  const entries = input.entries()
  const quality = (memory: MemoryEntry) => (memory.details?.confidence ?? .7) + (memory.details?.durability ?? .7) - (memory.details?.changeRisk ?? .3)
  const pending = entries.filter((memory) => memory.status === "pending").sort((a, b) => quality(b) - quality(a) || a.createdAt - b.createdAt || a.memoryId.localeCompare(b.memoryId))
  const report: NonNullable<DreamReport["consolidation"]> & { fallback?: string } = { policy: input.policy, pendingBefore: pending.length, pendingAfter: pending.length, applied: 0, archived: 0, decisions: [], mode: "deterministic" }
  if (input.policy === "disabled") return report
  const known = entries.filter((memory) => memory.status === "saved").map((memory) => ({ scope: memory.scope, text: normalized(memory.text) }))
  const batch = pending.slice(0, Math.min(50, input.limit))
  const advice = new Map<string, ConsolidatorDecision>()
  if (input.semantic && batch.length) {
    report.mode = "semantic"
    const saved = entries.filter((memory) => memory.status === "saved" && !memory.details?.action)
    for (let index = 0; index < batch.length; index += CONSOLIDATOR_BATCH) {
      const result = await input.semantic.decide({ proposals: batch.slice(index, index + CONSOLIDATOR_BATCH), saved, batchIndex: index / CONSOLIDATOR_BATCH, batchCount: Math.ceil(batch.length / CONSOLIDATOR_BATCH) })
      if ("fallback" in result) report.fallback ??= result.fallback
      else for (const [id, decision] of result.decisions) advice.set(id, decision)
    }
  }
  const savedIds = new Set(entries.filter((memory) => memory.status === "saved").map((memory) => memory.memoryId as string))
  const batchIds = new Set(batch.map((memory) => memory.memoryId as string))
  const outcomes = new Map<string, Decision["outcome"]>()
  const record = (decision: Decision) => { report.decisions.push(decision); outcomes.set(decision.memoryId, decision.outcome) }
  // A duplicate waits until its canonical proposal has an outcome, so merging never drops the only copy of a rejected fact.
  const ordered = [...batch].sort((a, b) => Number(isMerge(advice.get(a.memoryId))) - Number(isMerge(advice.get(b.memoryId))))
  for (const memory of ordered) {
    const current = input.entries().find((entry) => entry.memoryId === memory.memoryId)
    if (!current || sharedMemoryRevision(current) !== sharedMemoryRevision(memory)) {
      record({ memoryId: memory.memoryId, outcome: "failed", reason: "Proposal changed during consolidation" })
      continue
    }
    const text = normalized(memory.text)
    const model = advice.get(memory.memoryId)
    const scored = { confidence: Math.min(memory.details?.confidence ?? .7, model?.confidence ?? 1), durability: Math.min(memory.details?.durability ?? .7, model?.durability ?? 1), changeRisk: Math.max(memory.details?.changeRisk ?? .3, model?.changeRisk ?? 0) }
    const target = entries.find((entry) => entry.memoryId === memory.targetId)
    const unsafe = known.some((entry) => entry.scope === memory.scope && duplicate(entry.text, text)) && memory.kind !== "archive" ? "Already remembered" : memory.details?.action ? "Control proposal requires explicit approval"
      : redactSecrets(memory.text).count > 0 || /\[REDACTED/.test(memory.text) ? "Redacted memory requires review"
      : memory.details?.sensitivity === "medium" || memory.details?.sensitivity === "high" ? "Sensitive memory requires review"
      : scored.confidence < .9 ? "Confidence below .9"
      : scored.durability < .85 ? "Durability below .85"
      : scored.changeRisk > .2 ? "Change risk above .2"
      : !["commands", "stack", "constraints", "conventions"].includes(memory.category) ? "Category requires review"
      : target?.pinned || target?.source === "user" ? "User and pinned facts require explicit approval" : undefined
    // What the model recommended instead of applying: archive it, mark it a duplicate of a known memory, or leave it for a person.
    let verdict: { outcome: "archived" | "kept"; reason: string; canonicalId?: string } | undefined
    if (model && !memory.details?.action) {
      if (model.resolution === "archive" || model.resolution === "reject") verdict = { outcome: "archived", reason: `Model: ${model.reason}` }
      else if (model.resolution === "keep") verdict = { outcome: "kept", reason: `Model: ${model.reason}` }
      else if (model.resolution === "merge" || model.resolution === "supersede") {
        const canonical = model.canonicalId
        const canonicalOutcome = canonical ? outcomes.get(canonical) : undefined
        const usable = canonical !== undefined && (savedIds.has(canonical) || batchIds.has(canonical) && canonicalOutcome !== undefined && canonicalOutcome !== "archived" && canonicalOutcome !== "failed")
        verdict = usable ?{ outcome: "archived", reason: `Model: ${model.reason}`, canonicalId: canonical } : { outcome: "kept", reason: "Model named no usable canonical memory; left for review" }
      }
    }
    const by = verdict ? "model" as const : "host" as const
    const extra = { by, ...(verdict?.canonicalId ? { canonicalId: verdict.canonicalId } : {}) }
    if (input.policy === "preview") record({ memoryId: memory.memoryId, outcome: "preview", reason: clip(verdict ? `Would ${verdict.outcome === "kept" ? "keep pending" : "archive"}: ${verdict.reason}` : unsafe ?? "Eligible to apply"), ...extra })
    else if (verdict?.outcome === "kept") record({ memoryId: memory.memoryId, outcome: "kept", reason: clip(verdict.reason), ...extra })
    else {
      const archive = Boolean(verdict ?? unsafe)
      try {
        if (archive) { input.archive(memory); report.archived++ }
        else { await input.apply(memory); report.applied++ }
        record({ memoryId: memory.memoryId, outcome: archive ? "archived" : "applied", reason: clip(verdict?.reason ?? unsafe ?? "Host safety gates passed"), ...extra })
      } catch (error) { record({ memoryId: memory.memoryId, outcome: "failed", reason: redactSecrets(String(error)).text.slice(0, 200) }) }
    }
    known.push({ scope: memory.scope, text })
  }
  report.pendingAfter = input.entries().filter((memory) => memory.status === "pending").length
  return report
}
