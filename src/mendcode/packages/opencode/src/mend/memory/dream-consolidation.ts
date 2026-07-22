import { existsSync } from "fs"
import { mkdir, readFile, rename, writeFile } from "fs/promises"
import path from "path"
import { memoryPaths, readMemoryConfig, type DreamConsolidationPolicy, type MemoryConfig, type MemoryScope } from "./config"
import { readMemoryFacts, type MemoryFact } from "./graph"
import type { DreamEvidenceRef } from "./dream-sources"
import { readMemoryEntries, type MemoryEntry } from "./store"
import {
  applyMemoryProposal,
  archiveMemoryProposal,
  listMemoryProposals,
  proposeMemory,
  rejectMemoryProposal,
  supersedeMemoryProposal,
  updateMemoryProposal,
  type MemoryProposal,
  type MemoryProposalOperation,
} from "./proposals"
import { listMemorySessionDigests, markMemorySessionDigestsConsumed, type MemorySessionDigest } from "./session-digests"
import { redactMemoryText } from "./proposals"
import { resolveModelRoles } from "../config/models"
import { runProviderAdapter } from "../runtime/provider-adapters"

const CONSOLIDATION_BATCH_SIZE = 24
const CONSOLIDATION_RETRY_BATCH_SIZE = 8
const CONSOLIDATION_MAX_RETRY_ROUNDS = 2
const CONSOLIDATION_CONTEXT_LIMIT = 64

function proposalTargetKey(proposal: MemoryProposal) {
  return proposal.targetEntryID ? `${proposal.targetEntryScope ?? proposal.scope}:${proposal.targetEntryID}` : null
}

function proposalRemovesTarget(proposal: MemoryProposal) {
  return proposal.operation === "remove" || proposal.operation === "expire"
}

export type DreamConsolidationResolution = "apply" | "archive" | "reject" | "supersede" | "update" | "remove" | "add" | "merge"

export type DreamConsolidationDecision = {
  proposalID?: string
  entryID?: string
  resolution: DreamConsolidationResolution
  operation?: MemoryProposalOperation
  scope?: MemoryScope
  targetEntryID?: string | null
  targetEntryScope?: MemoryScope | null
  canonicalProposalID?: string | null
  text?: string
  tags?: string[]
  categoryIDs?: string[]
  confidence?: number
  durability?: number
  changeRisk?: number
  reason: string
  evidenceRefs?: string[]
}

export type DreamConsolidationModelInput = {
  runID: string
  root: string | undefined
  batchIndex: number
  batchCount: number
  entries: MemoryEntry[]
  facts: MemoryFact[]
  proposals: MemoryProposal[]
  historicalProposals: MemoryProposal[]
  digests: MemorySessionDigest[]
  evidence: DreamEvidenceRef[]
}

export type DreamConsolidationModel = (input: DreamConsolidationModelInput) => Promise<DreamConsolidationDecision[]>

export type DreamConsolidationDecisionStatus = "applied" | "archived" | "rejected" | "superseded" | "preview" | "failed"

export type DreamConsolidationDecisionRecord = {
  at: string
  status: DreamConsolidationDecisionStatus
  resolution: DreamConsolidationResolution
  proposalID?: string
  entryID?: string
  operation?: MemoryProposalOperation
  reason: string
  evidenceRefs: string[]
  canonicalProposalID?: string
}

export type DreamConsolidationRun = {
  id: string
  parentRunID: string | null
  status: "running" | "completed" | "failed" | "preview"
  policy: DreamConsolidationPolicy
  projectRoot: string | null
  startedAt: string
  completedAt: string | null
  pendingBefore: number
  pendingAfter: number
  resolved: number
  applied: number
  archived: number
  rejected: number
  superseded: number
  digestIDs: string[]
  decisions: DreamConsolidationDecisionRecord[]
  failureReason: string | null
}

function consolidationFile(root: string | undefined, runID: string) {
  return path.join(memoryPaths(root).globalDir, "dream", "runs", runID, "consolidation.json")
}

function boundedNumber(value: unknown, fallback: number, min = 0, max = 1) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
}

function resolution(value: unknown): DreamConsolidationResolution | null {
  return value === "apply" || value === "archive" || value === "reject" || value === "supersede" || value === "update" || value === "remove" || value === "add" || value === "merge" ? value : null
}

function operation(value: unknown): MemoryProposalOperation | undefined {
  return value === "add" || value === "update" || value === "remove" || value === "merge" || value === "split" || value === "verify" || value === "expire" || value === "recategorize" || value === "relink" || value === "demote-scope" || value === "promote-scope" ? value : undefined
}

function normalizeDecision(input: unknown): DreamConsolidationDecision | null {
  if (!input || typeof input !== "object") return null
  const value = input as Record<string, unknown>
  const decisionResolution = resolution(value.resolution)
  if (!decisionResolution || typeof value.reason !== "string" || !value.reason.trim()) return null
  const proposalID = typeof value.proposalID === "string" && value.proposalID.trim() ? value.proposalID.trim() : undefined
  const entryID = typeof value.entryID === "string" && value.entryID.trim() ? value.entryID.trim() : undefined
  if (!proposalID && !entryID && decisionResolution !== "add") return null
  return {
    proposalID,
    entryID,
    resolution: decisionResolution,
    operation: operation(value.operation),
    scope: value.scope === "global" || value.scope === "project" ? value.scope : undefined,
    targetEntryID: typeof value.targetEntryID === "string" && value.targetEntryID.trim() ? value.targetEntryID.trim() : null,
    targetEntryScope: value.targetEntryScope === "global" || value.targetEntryScope === "project" ? value.targetEntryScope : null,
    canonicalProposalID: typeof value.canonicalProposalID === "string" && value.canonicalProposalID.trim() ? value.canonicalProposalID.trim() : null,
    text: typeof value.text === "string" && value.text.trim() ? value.text.trim() : undefined,
    tags: stringList(value.tags),
    categoryIDs: stringList(value.categoryIDs),
    confidence: boundedNumber(value.confidence, 0.7),
    durability: boundedNumber(value.durability, 0.7),
    changeRisk: boundedNumber(value.changeRisk, 0.3),
    reason: value.reason.trim().slice(0, 1_000),
    evidenceRefs: stringList(value.evidenceRefs),
  }
}

export function parseDreamConsolidationOutput(outputText: string) {
  const trimmed = outputText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start === -1 || end <= start) return []
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return []
    }
  }
  const values: unknown[] = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).decisions) ? (parsed as Record<string, unknown>).decisions as unknown[] : []
  return values.map(normalizeDecision).filter((item): item is DreamConsolidationDecision => Boolean(item))
}

function promptText(value: string) {
  return redactMemoryText(value).text.replace(/\s+/g, " ").trim().slice(0, 2_000)
}

function consolidationPrompt(input: DreamConsolidationModelInput) {
  return [
    "<dream_consolidation_context>",
    JSON.stringify({
      runID: input.runID,
      batchIndex: input.batchIndex,
      batchCount: input.batchCount,
      entries: input.entries.map((entry) => ({ id: entry.id, scope: entry.scope, text: promptText(entry.text), categoryIDs: entry.categoryIDs, confidence: entry.confidence, sensitivity: entry.sensitivity })),
      facts: input.facts.map((fact) => ({ id: fact.id, scope: fact.scope, text: promptText(fact.normalizedSummary), categoryIDs: fact.categoryIDs, confidence: fact.confidence, sensitivity: fact.sensitivity })),
      proposals: input.proposals.map((proposal) => ({ id: proposal.id, operation: proposal.operation, scope: proposal.scope, text: promptText(proposal.text), categoryIDs: proposal.categoryIDs, targetEntryID: proposal.targetEntryID, confidence: proposal.confidence, durability: proposal.durability, changeRisk: proposal.changeRisk, sensitivity: proposal.sensitivity, reason: promptText(proposal.reason || "") })),
      historicalProposals: input.historicalProposals.map((proposal) => ({ id: proposal.id, resolution: proposal.resolution, operation: proposal.operation, scope: proposal.scope, text: promptText(proposal.text) })),
      digests: input.digests.map((digest) => ({ id: digest.id, sessionID: digest.sessionID, summary: promptText(digest.summary), decisions: digest.decisions.map(promptText), corrections: digest.corrections.map(promptText), validations: digest.validations.map(promptText), files: digest.files })),
      evidence: input.evidence.map((item) => ({ id: item.id, sourceType: item.sourceType, sourcePath: item.sourcePath, excerpt: promptText(item.excerpt), redacted: item.redacted })),
    }),
    "</dream_consolidation_context>",
  ].join("\n")
}

const CONSOLIDATOR_INSTRUCTIONS = [
  "You are MendCode Dream's memory consolidator.",
  "You have read-only context and no tools. Never request shell, Git, MCP, filesystem, or source edits.",
  "Return JSON only in the shape {\"decisions\":[...]}; do not include markdown or prose.",
  "Return exactly one decision for every proposal in the current batch using its proposalID.",
  "Use resolution=apply for a safe existing proposal, update/remove for a targeted change, merge or supersede for duplicates, and archive/reject for uncertain, stale, contradictory, noisy, sensitive, or unsupported material.",
  "Use canonicalProposalID when merging or superseding. Never invent target IDs.",
  "Prefer fewer durable memories over transient status, logs, todos, implementation details, or guesses.",
  "A decision is a recommendation only; deterministic host safety gates are authoritative.",
].join("\n")

export async function resolveMemoryConsolidator(root?: string) {
  const config = await readMemoryConfig(root)
  const resolved = await resolveModelRoles(memoryPaths(root).root)
  const roleNames = [...new Set([config.consolidatorRole, config.memoryDreamRole, "memoryDream", "memoryExtractor", "small", "default"])]
  const selected = roleNames
    .filter((name) => name && name !== "none")
    .map((name) => ({ name, role: (resolved.roles as Record<string, { providerID?: string | null; modelID?: string | null; authMode?: string | null; configured?: boolean }>)[name] }))
    .find((item) => item.role?.configured && item.role.providerID && item.role.modelID)
  if (!selected?.role?.providerID || !selected.role.modelID) return { ok: false as const, reason: "Dream consolidation role is not configured" }
  const providerID = selected.role.providerID
  const modelID = selected.role.modelID
  const authMode = selected.role.authMode || (selected.role.providerID === "openai" ? "provider-oauth-or-token" : "api-key")
  return {
    ok: true as const,
    roleName: selected.name,
    providerID,
    modelID,
    model: async (input: DreamConsolidationModelInput) => {
      const result = await runProviderAdapter(memoryPaths(root).root, {
        providerID,
        modelID,
        authMode,
        instructions: CONSOLIDATOR_INSTRUCTIONS,
        prompt: consolidationPrompt(input),
      }).catch((error) => ({ ok: false as const, status: 1, statusText: "Dream consolidator failed", errorPreview: error instanceof Error ? error.message : String(error) }))
      if (!result.ok) throw new Error(result.errorPreview || result.statusText || "Dream consolidator failed")
      return parseDreamConsolidationOutput(result.outputText || "")
    },
  }
}

function writeDecisionRecord(input: {
  decision: DreamConsolidationDecision
  status: DreamConsolidationDecisionStatus
  reason?: string
  proposalID?: string
  entryID?: string
}) {
  return {
    at: new Date().toISOString(),
    status: input.status,
    resolution: input.decision.resolution,
    proposalID: input.proposalID ?? input.decision.proposalID,
    entryID: input.entryID ?? input.decision.entryID,
    operation: input.decision.operation,
    reason: input.reason ?? input.decision.reason,
    evidenceRefs: input.decision.evidenceRefs ?? [],
    canonicalProposalID: input.decision.canonicalProposalID ?? undefined,
  } satisfies DreamConsolidationDecisionRecord
}

function initialRun(root: string | undefined, runID: string, policy: DreamConsolidationPolicy, pendingBefore: number, digestIDs: string[]): DreamConsolidationRun {
  return {
    id: `consolidation_${runID}`,
    parentRunID: runID,
    status: "running",
    policy,
    projectRoot: memoryPaths(root).root,
    startedAt: new Date().toISOString(),
    completedAt: null,
    pendingBefore,
    pendingAfter: pendingBefore,
    resolved: 0,
    applied: 0,
    archived: 0,
    rejected: 0,
    superseded: 0,
    digestIDs,
    decisions: [],
    failureReason: null,
  }
}

async function writeRun(root: string | undefined, parentRunID: string, run: DreamConsolidationRun) {
  const file = consolidationFile(root, parentRunID)
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
  return run
}

export async function readDreamConsolidationRun(root: string | undefined, runID: string) {
  const file = consolidationFile(root, runID)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(await readFile(file, "utf8")) as DreamConsolidationRun
  } catch {
    return null
  }
}

function safetyReason(input: {
  proposal?: MemoryProposal
  decision: DreamConsolidationDecision
  config: MemoryConfig
}) {
  const proposal = input.proposal
  const textValue = input.decision.text ?? proposal?.text ?? ""
  const redacted = redactMemoryText(textValue)
  if (redacted.redactions.length) return "redacted memory requires archival/review"
  if (proposal?.tags.includes("dream-service-start") || proposal?.tags.includes("dream-dry-run")) return "Dream control proposals cannot be auto-consolidated"
  if (proposal?.sensitivity === "medium" || proposal?.sensitivity === "high") return `${proposal.sensitivity} sensitivity requires archival/review`
  if (boundedNumber(input.decision.confidence, proposal?.confidence ?? 0.7) < input.config.dreamAutoApplyMinConfidence) return "confidence below consolidation threshold"
  if (boundedNumber(input.decision.durability, proposal?.durability ?? 0.7) < input.config.dreamAutoApplyMinDurability) return "durability below consolidation threshold"
  if (boundedNumber(input.decision.changeRisk, proposal?.changeRisk ?? 0.3) > input.config.dreamAutoApplyMaxChangeRisk) return "change risk above consolidation threshold"
  if (input.config.dreamAutoApplyAllowedCategories.length) {
    const categories = input.decision.categoryIDs?.length ? input.decision.categoryIDs : proposal?.categoryIDs ?? []
    if (!categories.some((categoryID) => input.config.dreamAutoApplyAllowedCategories.includes(categoryID))) return "category is not consolidation allowed"
  }
  return null
}

async function applyExistingProposal(input: {
  decision: DreamConsolidationDecision
  proposal: MemoryProposal
  root?: string
  config: MemoryConfig
}) {
  const decision = input.decision
  if (decision.resolution === "archive") return { status: "archived" as const, proposal: await archiveMemoryProposal(input.proposal.id, input.root, decision.reason), reason: decision.reason }
  if (decision.resolution === "reject") return { status: "rejected" as const, proposal: await rejectMemoryProposal(input.proposal.id, input.root), reason: decision.reason }
  if (decision.resolution === "supersede" || decision.resolution === "merge") {
    if (!decision.canonicalProposalID) return { status: "archived" as const, proposal: await archiveMemoryProposal(input.proposal.id, input.root, "Missing canonical proposal for merge; archived safely"), reason: "Missing canonical proposal for merge; archived safely" }
    return { status: "superseded" as const, proposal: await supersedeMemoryProposal(input.proposal.id, decision.canonicalProposalID, input.root, decision.reason), reason: decision.reason }
  }
  const unsafe = safetyReason(input)
  if (unsafe) return { status: "archived" as const, proposal: await archiveMemoryProposal(input.proposal.id, input.root, unsafe), reason: unsafe }
  const needsPatch = decision.text || decision.scope || decision.tags?.length || decision.categoryIDs?.length || decision.targetEntryID || decision.targetEntryScope || decision.operation || decision.confidence !== undefined || decision.durability !== undefined || decision.changeRisk !== undefined
  if (needsPatch) {
    await updateMemoryProposal(input.proposal.id, {
      operation: decision.operation ?? (decision.resolution === "update" ? "update" : decision.resolution === "remove" ? "remove" : input.proposal.operation),
      scope: decision.scope,
      targetEntryID: decision.targetEntryID,
      targetEntryScope: decision.targetEntryScope,
      text: decision.text,
      tags: decision.tags,
      categoryIDs: decision.categoryIDs,
      confidence: decision.confidence,
      durability: decision.durability,
      changeRisk: decision.changeRisk,
      reason: decision.reason,
    }, input.root)
  }
  const applied = await applyMemoryProposal(input.proposal.id, input.root, {
    connectRelated: true,
    relatedCategoryIDs: input.config.dreamAutoApplyAllowedCategories,
  })
  return { status: "applied" as const, proposal: applied.proposal, reason: decision.reason }
}

async function applyDirectDecision(input: {
  decision: DreamConsolidationDecision
  entries: MemoryEntry[]
  root?: string
  runID: string
  config: MemoryConfig
}) {
  const decision = input.decision
  const target = decision.entryID ? input.entries.find((entry) => entry.id === decision.entryID) : undefined
  if (decision.resolution !== "add" && !target) throw new Error(`Consolidation target entry not found: ${decision.entryID || "missing"}`)
  const operation = decision.operation ?? (decision.resolution === "remove" ? "remove" : decision.resolution === "update" ? "update" : "add")
  const textValue = decision.text ?? target?.text ?? "Consolidated memory"
  const redacted = redactMemoryText(textValue)
  const synthetic = await proposeMemory({
    operation,
    scope: decision.scope ?? target?.scope ?? "project",
    targetEntryID: target?.id,
    targetEntryScope: target?.scope,
    text: redacted.text,
    tags: decision.tags ?? target?.tags ?? ["dream-consolidation"],
    categoryIDs: decision.categoryIDs ?? target?.categoryIDs ?? [],
    confidence: decision.confidence,
    durability: decision.durability,
    changeRisk: decision.changeRisk,
    source: "memory-dream-consolidation",
    evidence: `dream-consolidation:${input.runID}`,
    evidenceRefs: decision.evidenceRefs,
    reason: decision.reason,
  }, input.root)
  const unsafe = safetyReason({ decision: { ...decision, text: redacted.text }, proposal: synthetic, config: input.config })
  if (unsafe) return { status: "archived" as const, proposal: await archiveMemoryProposal(synthetic.id, input.root, unsafe), reason: unsafe }
  const applied = await applyMemoryProposal(synthetic.id, input.root, {
    connectRelated: true,
    relatedCategoryIDs: input.config.dreamAutoApplyAllowedCategories,
  })
  return { status: "applied" as const, proposal: applied.proposal, reason: decision.reason }
}

export async function runMemoryConsolidation(input: {
  root?: string
  runID: string
  policy?: DreamConsolidationPolicy
  model?: DreamConsolidationModel
  evidence?: DreamEvidenceRef[]
  now?: Date
}): Promise<DreamConsolidationRun> {
  const config = await readMemoryConfig(input.root)
  const policy = input.policy ?? config.dreamConsolidationPolicy
  const [entries, facts, allProposals, digests] = await Promise.all([
    Promise.all([readMemoryEntries("global", input.root), readMemoryEntries("project", input.root)]).then((groups) => groups.flat()),
    readMemoryFacts(input.root),
    listMemoryProposals(input.root, "all"),
    listMemorySessionDigests(input.root),
  ])
  const pending = allProposals
    .filter((proposal) => proposal.status === "pending")
    .sort((left, right) => {
      const leftTarget = proposalTargetKey(left)
      const rightTarget = proposalTargetKey(right)
      if (leftTarget && leftTarget === rightTarget && proposalRemovesTarget(left) !== proposalRemovesTarget(right)) return proposalRemovesTarget(left) ? 1 : -1
      return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    })
  let run = initialRun(input.root, input.runID, policy, pending.length, digests.map((digest) => digest.id))
  await writeRun(input.root, input.runID, run)
  if (policy === "disabled") {
    run = { ...run, status: "completed", completedAt: (input.now ?? new Date()).toISOString(), failureReason: null }
    return writeRun(input.root, input.runID, run)
  }
  if (!pending.length && !entries.length && !digests.length) {
    run = { ...run, status: policy === "preview" ? "preview" : "completed", completedAt: (input.now ?? new Date()).toISOString() }
    return writeRun(input.root, input.runID, run)
  }
  if (!input.model) {
    run = { ...run, status: "failed", completedAt: (input.now ?? new Date()).toISOString(), failureReason: "Dream consolidation model is not configured" }
    return writeRun(input.root, input.runID, run)
  }
  const batches: MemoryProposal[][] = []
  for (let index = 0; index < pending.length; index += CONSOLIDATION_BATCH_SIZE) batches.push(pending.slice(index, index + CONSOLIDATION_BATCH_SIZE))
  if (!batches.length) batches.push([])
  try {
    for (let index = 0; index < batches.length; index++) {
      const batch = batches[index]!
      const modelInput = (proposals: MemoryProposal[], compact = false) => ({
        runID: input.runID,
        root: input.root,
        batchIndex: index,
        batchCount: batches.length,
        entries: (compact ? entries.filter((entry) => proposals.some((proposal) => proposal.targetEntryID === entry.id)) : entries).slice(0, compact ? 16 : CONSOLIDATION_CONTEXT_LIMIT),
        facts: (compact ? [] : facts).slice(0, CONSOLIDATION_CONTEXT_LIMIT),
        proposals,
        historicalProposals: compact ? [] : allProposals.filter((proposal) => proposal.status !== "pending").slice(0, CONSOLIDATION_CONTEXT_LIMIT),
        digests: compact ? [] : digests.slice(0, CONSOLIDATION_CONTEXT_LIMIT),
        evidence: (input.evidence ?? []).slice(0, compact ? 16 : undefined),
      })
      let decisions = await input.model(modelInput(batch))
      const byProposal = new Map<string, DreamConsolidationDecision>()
      for (const decision of decisions) {
        if (decision.proposalID) {
          if (byProposal.has(decision.proposalID)) throw new Error(`Duplicate consolidation decision for proposal ${decision.proposalID}`)
          byProposal.set(decision.proposalID, decision)
        }
      }
      let missing = batch.filter((proposal) => !byProposal.has(proposal.id))
      for (let retryRound = 0; retryRound < CONSOLIDATION_MAX_RETRY_ROUNDS && missing.length; retryRound++) {
        for (let retryIndex = 0; retryIndex < missing.length; retryIndex += CONSOLIDATION_RETRY_BATCH_SIZE) {
          const retryBatch = missing.slice(retryIndex, retryIndex + CONSOLIDATION_RETRY_BATCH_SIZE)
          const retryDecisions = await input.model(modelInput(retryBatch, true))
          for (const decision of retryDecisions) {
            if (decision.proposalID && !byProposal.has(decision.proposalID) && retryBatch.some((proposal) => proposal.id === decision.proposalID)) {
              byProposal.set(decision.proposalID, decision)
              decisions = [...decisions, decision]
            }
          }
        }
        missing = batch.filter((proposal) => !byProposal.has(proposal.id))
      }
      for (const proposal of batch) {
        const decision = byProposal.get(proposal.id)
        if (!decision) throw new Error(`Consolidator did not resolve proposal ${proposal.id}`)
        const result = policy === "preview"
          ? { status: "preview" as const, reason: decision.reason }
          : await applyExistingProposal({ decision, proposal, root: input.root, config })
        const record = writeDecisionRecord({ decision, status: result.status, proposalID: proposal.id, reason: result.reason })
        run = {
          ...run,
          decisions: [...run.decisions, record],
          resolved: policy === "preview" ? run.resolved : run.resolved + 1,
          applied: result.status === "applied" ? run.applied + 1 : run.applied,
          archived: result.status === "archived" ? run.archived + 1 : run.archived,
          rejected: result.status === "rejected" ? run.rejected + 1 : run.rejected,
          superseded: result.status === "superseded" ? run.superseded + 1 : run.superseded,
        }
      }
      const direct = decisions.filter((decision) => !decision.proposalID && (decision.entryID || decision.resolution === "add"))
      for (const decision of direct) {
        const result = policy === "preview"
          ? { status: "preview" as const, reason: decision.reason }
          : await applyDirectDecision({ decision, entries, root: input.root, runID: input.runID, config })
        const record = writeDecisionRecord({ decision, status: result.status, reason: result.reason })
        run = {
          ...run,
          decisions: [...run.decisions, record],
          applied: result.status === "applied" ? run.applied + 1 : run.applied,
          archived: result.status === "archived" ? run.archived + 1 : run.archived,
        }
      }
      await writeRun(input.root, input.runID, run)
    }
    const pendingAfter = (await listMemoryProposals(input.root, "pending")).length
    run = {
      ...run,
      status: policy === "preview" ? "preview" : pendingAfter === 0 ? "completed" : "failed",
      completedAt: (input.now ?? new Date()).toISOString(),
      pendingAfter,
      failureReason: pendingAfter === 0 || policy === "preview" ? null : "Consolidation completed without resolving every pending proposal",
    }
    if (run.status === "completed") await markMemorySessionDigestsConsumed(run.digestIDs, input.runID, input.root)
    return writeRun(input.root, input.runID, run)
  } catch (error) {
    const pendingAfter = await listMemoryProposals(input.root, "pending").then((items) => items.length).catch(() => pending.length)
    run = {
      ...run,
      status: "failed",
      completedAt: (input.now ?? new Date()).toISOString(),
      pendingAfter,
      failureReason: error instanceof Error ? error.message : String(error),
    }
    return writeRun(input.root, input.runID, run)
  }
}
