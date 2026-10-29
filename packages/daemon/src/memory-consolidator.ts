import { redactSecrets, type MemoryEntry } from "@mendcode/protocol"

/** What the configured `memoryConsolidator` model may recommend for one pending proposal; the host's safety gates stay authoritative. */
export type ConsolidatorDecision = {
  memoryId: string
  resolution: "apply" | "archive" | "reject" | "merge" | "supersede" | "keep"
  /** The proposal or saved memory a merge/supersede points at; never trusted unless it is a known id. */
  canonicalId?: string
  reason: string
  confidence?: number
  durability?: number
  changeRisk?: number
}

export type ConsolidatorBatchResult = { decisions: Map<string, ConsolidatorDecision> } | { fallback: string }

/** Proposals per model call, and the saved memories shown as read-only context (v1: 24 and 64). */
export const CONSOLIDATOR_BATCH = 24
export const CONSOLIDATOR_CONTEXT = 64

const RESOLUTIONS = new Set(["apply", "archive", "reject", "merge", "supersede", "keep"])
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const unit = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined)
const safeText = (text: string, max: number) => clip(redactSecrets(text).text.replace(/\s+/g, " ").trim(), max)

/** One consolidation batch as a prompt: pending proposals to decide plus saved memories as context, redacted and bounded. */
export function consolidatorPrompt(input: { batch: MemoryEntry[]; saved: MemoryEntry[]; batchIndex: number; batchCount: number }) {
  const proposal = (memory: MemoryEntry) => ({ memoryId: memory.memoryId, scope: memory.scope, category: memory.category, text: safeText(memory.text, 600), confidence: memory.details?.confidence, durability: memory.details?.durability, changeRisk: memory.details?.changeRisk, sensitivity: memory.details?.sensitivity, ...(memory.kind ? { kind: memory.kind } : {}), ...(memory.targetId ? { targetId: memory.targetId } : {}) })
  const saved = input.saved.slice(0, CONSOLIDATOR_CONTEXT).map((memory) => ({ memoryId: memory.memoryId, scope: memory.scope, category: memory.category, text: safeText(memory.text, 300) }))
  return ["<dream_consolidation_context>", JSON.stringify({ batchIndex: input.batchIndex, batchCount: input.batchCount, saved, proposals: input.batch.map(proposal) }), "</dream_consolidation_context>"].join("\n")
}

/** Decisions from a model reply for the ids of one batch; anything off-batch, malformed or repeated is dropped. */
export function parseConsolidatorOutput(text: string, batchIds: ReadonlySet<string>): Map<string, ConsolidatorDecision> {
  const decisions = new Map<string, ConsolidatorDecision>()
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  let parsed: unknown
  try { parsed = JSON.parse(clean) } catch {
    const start = clean.indexOf("{")
    const end = clean.lastIndexOf("}")
    if (start === -1 || end <= start) return decisions
    try { parsed = JSON.parse(clean.slice(start, end + 1)) } catch { return decisions }
  }
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { decisions?: unknown }).decisions) ? (parsed as { decisions: unknown[] }).decisions : []
  for (const item of list.slice(0, CONSOLIDATOR_BATCH * 2)) {
    if (!item || typeof item !== "object") continue
    const value = item as Record<string, unknown>
    const memoryId = typeof value.memoryId === "string" ? value.memoryId : ""
    if (!batchIds.has(memoryId) || decisions.has(memoryId) || typeof value.resolution !== "string" || !RESOLUTIONS.has(value.resolution)) continue
    const reason = typeof value.reason === "string" ? safeText(value.reason, 160) : ""
    if (!reason) continue
    const canonicalId = typeof value.canonicalId === "string" && value.canonicalId.length <= 64 && value.canonicalId !== memoryId ? value.canonicalId : undefined
    const confidence = unit(value.confidence)
    const durability = unit(value.durability)
    const changeRisk = unit(value.changeRisk)
    decisions.set(memoryId, { memoryId, resolution: value.resolution as ConsolidatorDecision["resolution"], reason, ...(canonicalId ? { canonicalId } : {}), ...(confidence !== undefined ? { confidence } : {}), ...(durability !== undefined ? { durability } : {}), ...(changeRisk !== undefined ? { changeRisk } : {}) })
  }
  return decisions
}

/**
 * The semantic stage: one tool-free model call per batch through `call` (a budgeted meter). A refused call, a provider error or
 * a reply without any usable decision gives `{ fallback }` so the host gates alone decide that batch.
 */
export function createSemanticConsolidator(input: { call(prompt: string, step: string): Promise<{ text: string } | { refused: string }> }) {
  return {
    async decide(batch: { proposals: MemoryEntry[]; saved: MemoryEntry[]; batchIndex: number; batchCount: number }): Promise<ConsolidatorBatchResult> {
      let reply: { text: string } | { refused: string }
      try { reply = await input.call(consolidatorPrompt({ batch: batch.proposals, saved: batch.saved, batchIndex: batch.batchIndex, batchCount: batch.batchCount }), "Consolidation") }
      catch (error) { return { fallback: safeText(error instanceof Error ? error.message : String(error), 160) || "Consolidator failed" } }
      if ("refused" in reply) return { fallback: safeText(reply.refused, 160) }
      const decisions = parseConsolidatorOutput(reply.text, new Set(batch.proposals.map((memory) => memory.memoryId)))
      return decisions.size ? { decisions } : { fallback: "Consolidator returned no usable decisions" }
    },
  }
}
export type SemanticConsolidator = ReturnType<typeof createSemanticConsolidator>
