import { existsSync } from "fs"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { memoryPaths, readMemoryConfig, type DreamConsolidationPolicy, type MemoryConfig, type MemoryDreamWritePolicy, type MemoryScope } from "./config"
import { materializeLegacyMemoryFacts, readMemoryFacts, readMemoryGraph, upsertMemoryFactLink, type MemoryFact, type MemoryFactLink } from "./graph"
import { collectDreamFileEvidence, type DreamEvidenceRef, type DreamSourcePermissions } from "./dream-sources"
import { publishMemoryDreamEvent } from "./dream-events"
import { listMemoryProposals, proposeMemory, redactMemoryText, settleGeneratedMemoryProposal, type MemoryProposal } from "./proposals"
import { cleanupGeneratedMemoryEntries, deterministicDreamConsolidator, isMemoryMaintenanceInstruction, readDreamConsolidationRun, resolveMemoryConsolidator, runMemoryConsolidation, type DreamConsolidationModel, type DreamConsolidationRun } from "./dream-consolidation"
import { resolveModelRoles } from "../config/models"
import { runProviderAdapter } from "../runtime/provider-adapters"

const DREAM_FACT_CONTEXT_LIMIT = 32
const DREAM_PROPOSAL_CONTEXT_LIMIT = 32
const DREAM_DEFAULT_MAX_FILES = 4
const DREAM_DEFAULT_MAX_BYTES = 16_000

export type DreamRunStatus = "running" | "completed" | "failed" | "canceled" | "missed"

export type DreamRun = {
  id: string
  status: DreamRunStatus
  source: "manual" | "scheduled"
  role: "memoryDream"
  projectRoot: string | null
  workspaceID: string | null
  groupID: string | null
  startedAt: string
  completedAt: string | null
  proposals: string[]
  failureReason: string | null
  permissionSnapshot: DreamSourcePermissions
  writePolicySnapshot: MemoryDreamWritePolicy
}

export type DreamRunSafety = {
  reads: Array<{ sourceType: DreamEvidenceRef["sourceType"]; sourcePath: string | null; redacted: boolean }>
  skippedSources: string[]
  failures: string[]
  redactions: number
}

export type DreamRunProposalSummary = {
  id: string
  operation?: string
  scope?: MemoryScope
  text?: string
  status?: MemoryProposal["status"]
  resolution?: MemoryProposal["resolution"]
  appliedEntryID?: string | null
  reason?: string | null
}

export type DreamGraphProposalStatus = "pending" | "applied" | "rejected"

export type DreamGraphProposal = {
  id: string
  from: string
  to: string
  kind: MemoryFactLink["kind"]
  status: DreamGraphProposalStatus
  confidence: number
  reason: string
  evidenceRefs: string[]
  fromSummary: string
  toSummary: string
  createdAt: string
  reviewedAt?: string
  linkID?: string
  rejectionReason?: string
}

type StoredDreamGraphProposal = Omit<DreamGraphProposal, "status" | "evidenceRefs" | "reviewedAt" | "linkID" | "rejectionReason"> & {
  status?: DreamGraphProposalStatus
  evidenceRefs?: string[]
  reviewedAt?: string
  linkID?: string
  rejectionReason?: string
}

export type DreamRunDetail = {
  run: DreamRun
  events: DreamRunEvent[]
  evidence: DreamEvidenceRef[]
  proposals: DreamRunProposalSummary[]
  graphProposals: DreamGraphProposal[]
  decisions: DreamRunDecision[]
  consolidation?: DreamConsolidationRun | null
  safety: DreamRunSafety | null
}

export type DreamRunEvent = {
  at: string
  status: DreamRunStatus | "started" | "progress"
  message: string
}

export type DreamRunDecisionStatus = "created-proposal" | "auto-applied-proposal" | "skipped-duplicate" | "skipped-policy"

export type DreamRunDecision = {
  at: string
  status: DreamRunDecisionStatus
  policy: MemoryDreamWritePolicy
  text: string
  scope: MemoryScope
  categoryIDs: string[]
  reason: string
  confidence: number
  durability: number
  changeRisk: number
  evidenceRefs: string[]
  proposalID?: string
  entryID?: string
  duplicateOf?: {
    id: string
    sourceType: "memory" | "proposal" | "candidate"
    status?: string
  }
}

export type DreamCandidate = {
  text: string
  reason?: string
  confidence?: number
  durability?: number
  changeRisk?: number
  categoryIDs?: string[]
  scope?: MemoryScope
  evidenceRefs?: string[]
  recommendedDisposition?: "auto-apply" | "pending" | "skip"
}

export type DreamGraphCandidate = {
  from: string
  to: string
  kind: MemoryFactLink["kind"]
  confidence: number
  reason: string
  evidenceRefs: string[]
}

export type DreamModelResult = {
  candidates: DreamCandidate[]
  graphLinks: DreamGraphCandidate[]
}

export type DreamModelAdapter = (input: {
  facts: Awaited<ReturnType<typeof readMemoryFacts>>
  proposals: Awaited<ReturnType<typeof listMemoryProposals>>
  evidence: DreamEvidenceRef[]
}) => Promise<DreamCandidate[] | DreamModelResult>

export type DreamModelRoleResult =
  | {
    ok: true
    roleName: string
    providerID: string
    modelID: string
    authMode: string
  }
  | {
    ok: false
    reason: string
  }

const DREAM_MODEL_INSTRUCTIONS = [
  "You are MendCode Dream, a memory-maintenance model.",
  "You have bounded, redacted context only. Do not request tools, shell, Git, MCP, filesystem, or source edits.",
  "Return JSON only as {\"candidates\":[...],\"graphLinks\":[...]}; do not include markdown or prose.",
  "Prefer fewer durable candidates over transient status, logs, todos, implementation details, or guesses.",
  "Each candidate must include text, reason, confidence, durability, changeRisk, categoryIDs, scope, evidenceRefs, and recommendedDisposition.",
  "Each graph link must use existing fact ids and include from, to, kind, confidence, reason, and evidenceRefs.",
  "Treat global facts as reusable principles and project facts as local implementations; when a project instantiates a global principle, prefer one specific related bridge instead of connecting every node.",
  "Only propose a graph link for a specific semantic relationship. Sharing a category alone is not sufficient evidence.",
  "Never invent fact ids or use graph links to delete or merge canonical facts; duplicate memory proposals must use the consolidation path.",
  "Never create a memory candidate that is an instruction to consolidate, deduplicate, recategorize, archive, retire, merge, or canonicalize memories; the host consolidator handles maintenance directly.",
  "Use recommendedDisposition=pending unless the candidate is clearly safe for the configured host policy.",
].join("\n")

function dreamModelNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback
}

function dreamModelStringList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
}

export function parseDreamModelOutput(outputText: string): DreamModelResult {
  const trimmed = outputText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  if (!trimmed) return { candidates: [], graphLinks: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("[")
    const end = trimmed.lastIndexOf("]")
    if (start === -1 || end <= start) return { candidates: [], graphLinks: [] }
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return { candidates: [], graphLinks: [] }
    }
  }
  const values = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).candidates)
      ? (parsed as Record<string, unknown>).candidates as unknown[]
      : []
  const candidates = values
    .flatMap((value) => {
      if (!value || typeof value !== "object") return []
      const item = value as Record<string, unknown>
      if (typeof item.text !== "string" || !item.text.trim()) return []
      const scope = item.scope === "global" || item.scope === "project" ? item.scope : "project"
      const recommendedDisposition = item.recommendedDisposition === "auto-apply" || item.recommendedDisposition === "skip" ? item.recommendedDisposition : "pending"
      return [{
        text: item.text.trim(),
        reason: typeof item.reason === "string" && item.reason.trim() ? item.reason.trim() : undefined,
        confidence: dreamModelNumber(item.confidence, 0.7),
        durability: dreamModelNumber(item.durability, 0.7),
        changeRisk: dreamModelNumber(item.changeRisk, 0.3),
        categoryIDs: dreamModelStringList(item.categoryIDs),
        scope,
        evidenceRefs: dreamModelStringList(item.evidenceRefs),
        recommendedDisposition,
      } satisfies DreamCandidate]
    })
    .slice(0, 8)
  const graphValues = parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).graphLinks)
    ? (parsed as Record<string, unknown>).graphLinks as unknown[]
    : []
  const graphLinks = graphValues.flatMap((value): DreamGraphCandidate[] => {
    if (!value || typeof value !== "object") return []
    const item = value as Record<string, unknown>
    if (typeof item.from !== "string" || typeof item.to !== "string" || item.from === item.to) return []
    const kind = item.kind === "conflicts" || item.kind === "supersedes" || item.kind === "supports" ? item.kind : "related"
    if (typeof item.reason !== "string" || !item.reason.trim()) return []
    return [{
      from: item.from,
      to: item.to,
      kind,
      confidence: dreamModelNumber(item.confidence, 0.7),
      reason: item.reason.trim().slice(0, 1_000),
      evidenceRefs: dreamModelStringList(item.evidenceRefs),
    }]
  }).slice(0, 8)
  return { candidates, graphLinks }
}

export function parseDreamCandidates(outputText: string) {
  return parseDreamModelOutput(outputText).candidates
}

function dreamModelPrompt(input: Parameters<DreamModelAdapter>[0]) {
  return [
    "<dream_context>",
    JSON.stringify({
      facts: input.facts.map((fact) => ({ id: fact.id, scope: fact.scope, text: redactMemoryText(fact.normalizedSummary).text, categoryIDs: fact.categoryIDs, confidence: fact.confidence, durability: fact.durability, sensitivity: fact.sensitivity })),
      proposals: input.proposals.map((proposal) => ({ id: proposal.id, status: proposal.status, operation: proposal.operation, scope: proposal.scope, text: redactMemoryText(proposal.text).text, categoryIDs: proposal.categoryIDs, confidence: proposal.confidence, durability: proposal.durability, changeRisk: proposal.changeRisk, sensitivity: proposal.sensitivity })),
      evidence: input.evidence.map((item) => ({ id: item.id, sourceType: item.sourceType, sourcePath: item.sourcePath, excerpt: redactMemoryText(item.excerpt).text, redacted: item.redacted })),
    }),
    "</dream_context>",
  ].join("\n")
}

export async function resolveMemoryDreamRole(root?: string): Promise<DreamModelRoleResult> {
  const paths = memoryPaths(root)
  const config = await readMemoryConfig(paths.root)
  if (!config.memoryDreamRole || config.memoryDreamRole === "none") return { ok: false, reason: "memory Dream role disabled" }
  const resolved = await resolveModelRoles(paths.root)
  if (!resolved.enabled) return { ok: false, reason: "memory Dream model not configured" }
  const role = resolved.roles[config.memoryDreamRole]
  if (!role?.configured || !role.providerID || !role.modelID) return { ok: false, reason: `memory Dream role not configured: ${config.memoryDreamRole}` }
  return {
    ok: true,
    roleName: config.memoryDreamRole,
    providerID: role.providerID,
    modelID: role.modelID,
    authMode: role.authMode || (role.providerID === "openai" ? "provider-oauth-or-token" : "api-key"),
  }
}

async function configuredDreamModel(root: string | undefined): Promise<DreamModelAdapter | null> {
  const role = await resolveMemoryDreamRole(root)
  if (!role.ok) return null
  return async (input) => {
    const result = await runProviderAdapter(memoryPaths(root).root, {
      providerID: role.providerID,
      modelID: role.modelID,
      authMode: role.authMode,
      instructions: DREAM_MODEL_INSTRUCTIONS,
      prompt: dreamModelPrompt(input),
    }).catch((error) => ({
      ok: false as const,
      status: 1,
      statusText: "memory Dream failed",
      errorPreview: error instanceof Error ? error.message : String(error),
    }))
    if (!result.ok) throw new Error(result.errorPreview || result.statusText || "memory Dream failed")
    return parseDreamModelOutput(result.outputText || "")
  }
}

function nowID(prefix = "dream") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function dreamDir(root?: string) {
  return path.join(memoryPaths(root).globalDir, "dream")
}

function dreamRunDir(root: string | undefined, id: string) {
  return path.join(dreamDir(root), "runs", id)
}

function normalizeDreamRun(input: Partial<DreamRun> & Pick<DreamRun, "id">): DreamRun {
  const startedAt = typeof input.startedAt === "string" && input.startedAt.trim() ? input.startedAt : typeof input.completedAt === "string" && input.completedAt.trim() ? input.completedAt : new Date(0).toISOString()
  return {
    id: input.id,
    status: input.status === "running" || input.status === "failed" || input.status === "canceled" || input.status === "missed" ? input.status : "completed",
    source: input.source === "scheduled" ? "scheduled" : "manual",
    role: "memoryDream",
    projectRoot: typeof input.projectRoot === "string" && input.projectRoot.trim() ? input.projectRoot : null,
    workspaceID: typeof input.workspaceID === "string" && input.workspaceID.trim() ? input.workspaceID : null,
    groupID: typeof input.groupID === "string" && input.groupID.trim() ? input.groupID : null,
    startedAt,
    completedAt: typeof input.completedAt === "string" && input.completedAt.trim() ? input.completedAt : null,
    proposals: Array.isArray(input.proposals) ? input.proposals.filter((proposal): proposal is string => typeof proposal === "string" && proposal.trim().length > 0) : [],
    failureReason: typeof input.failureReason === "string" && input.failureReason.trim() ? input.failureReason : null,
    permissionSnapshot: typeof input.permissionSnapshot === "object" && input.permissionSnapshot !== null ? input.permissionSnapshot : {},
    writePolicySnapshot: input.writePolicySnapshot === "auto-safe" || input.writePolicySnapshot === "model-decides" || input.writePolicySnapshot === "disabled" ? input.writePolicySnapshot : "pending",
  }
}

async function appendJsonl(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  const previous = existsSync(file) ? await readFile(file, "utf8").catch(() => "") : ""
  await writeFile(file, `${previous}${JSON.stringify(value)}\n`)
}

async function readJsonIfExists<T>(file: string): Promise<T | null> {
  if (!existsSync(file)) return null
  return JSON.parse(await readFile(file, "utf8")) as T
}

async function readJsonlIfExists<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) return []
  return (await readFile(file, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as T
      } catch {
        return null
      }
    })
    .filter((item): item is T => Boolean(item))
}

function normalizeDreamPermissions(root: string | undefined, permissions: DreamSourcePermissions | undefined): DreamSourcePermissions {
  const defaults: DreamSourcePermissions = root ? { files: true, roots: [root], maxFiles: DREAM_DEFAULT_MAX_FILES, maxBytes: DREAM_DEFAULT_MAX_BYTES } : {}
  return {
    ...defaults,
    ...(permissions ?? {}),
    roots: permissions?.roots ?? defaults.roots,
  }
}

function normalizedText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()
}

function dreamFingerprint(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^\s*project convention from [^:]+:\s*/i, "")
    .replace(/[`*_()[\]{}.,:;!?'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function isNearDreamDuplicate(candidate: string, existing: string) {
  const normalized = dreamFingerprint(candidate)
  const current = dreamFingerprint(existing)
  if (!normalized || !current) return false
  if (normalized === current) return true
  if (normalized.length >= 24 && current.includes(normalized)) return true
  if (current.length >= 24 && normalized.includes(current)) return true
  const candidateTerms = new Set(normalized.split(" ").filter((term) => term.length > 3))
  const existingTerms = new Set(current.split(" ").filter((term) => term.length > 3))
  if (candidateTerms.size < 5 || existingTerms.size < 5) return false
  const overlap = [...candidateTerms].filter((term) => existingTerms.has(term)).length
  return overlap / Math.min(candidateTerms.size, existingTerms.size) >= 0.72
}

function dreamDuplicateFor(input: {
  text: string
  categoryIDs: string[]
  scope: MemoryScope
  facts: Awaited<ReturnType<typeof readMemoryFacts>>
  proposals: Awaited<ReturnType<typeof listMemoryProposals>>
  priorCandidates: Array<{ id: string; text: string }>
}) {
  const categoryIDs = new Set(input.categoryIDs)
  const proposal = input.proposals.find((item) => {
    const sameScope = item.scope === input.scope
    const sharesCategory = item.categoryIDs.some((categoryID) => categoryIDs.has(categoryID))
    return (sameScope || sharesCategory) && isNearDreamDuplicate(input.text, item.text)
  })
  if (proposal) return { id: proposal.id, sourceType: "proposal" as const, status: proposal.status }
  const fact = input.facts.find((item) => {
    const sameScope = item.scope === input.scope
    const sharesCategory = item.categoryIDs.some((categoryID) => categoryIDs.has(categoryID))
    return (sameScope || sharesCategory) && isNearDreamDuplicate(input.text, item.text)
  })
  if (fact) return { id: fact.id, sourceType: "memory" as const }
  const candidate = input.priorCandidates.find((item) => isNearDreamDuplicate(input.text, item.text))
  if (candidate) return { id: candidate.id, sourceType: "candidate" as const }
  return undefined
}

function dreamLineCategory(line: string) {
  if (/\b(test|typecheck|build|run|command|script|bun|npm|pnpm)\b/i.test(line)) return "project.commands"
  if (/\b(secret|credential|token|password|security|auth)\b/i.test(line)) return "project.security"
  if (/\b(branch|release|version|changelog|commit|pr)\b/i.test(line)) return "project.release"
  if (/\b(module|service|architecture|database|schema|api|runtime)\b/i.test(line)) return "project.architecture"
  if (/\b(framework|dependency|package|sdk|typescript|react|next|solid|bun)\b/i.test(line)) return "project.stack"
  return "project.constraints"
}

function durableDreamLines(evidence: DreamEvidenceRef) {
  return evidence.excerpt
    .split("\n")
    .map((line) => line.replace(/^\s*[-*#>]+\s*/, "").trim())
    .filter((line) => line.length >= 24 && line.length <= 220)
    .filter((line) => /\b(always|never|must|should|prefer|use|run|command|test|typecheck|default branch|do not|don't|schema|module|service|security|secret|memory|config)\b/i.test(line))
    .slice(0, 4)
}

function defaultDreamCandidates(input: {
  facts: Awaited<ReturnType<typeof readMemoryFacts>>
  proposals: Awaited<ReturnType<typeof listMemoryProposals>>
  evidence: DreamEvidenceRef[]
}): DreamCandidate[] {
  const remembered = normalizedText([
    ...input.facts.map((fact) => fact.normalizedSummary),
    ...input.proposals.map((proposal) => proposal.text),
  ].join("\n"))
  const seen = new Set<string>()
  return input.evidence
    .filter((item) => item.sourceType === "file")
    .flatMap((item) => durableDreamLines(item).map((line) => ({ item, line })))
    .filter(({ line }) => {
      const key = normalizedText(line).slice(0, 180)
      if (!key || key.length < 18 || seen.has(key) || remembered.includes(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 3)
    .map(({ item, line }) => ({
      scope: "project" as const,
      text: `Project convention from ${path.basename(item.sourcePath ?? "project file")}: ${line}`,
      categoryIDs: [dreamLineCategory(line)],
      evidenceRefs: [item.id],
      confidence: 0.68,
      durability: 0.72,
      changeRisk: 0.25,
      reason: "Dream scanned safe project files and found a durable convention missing from saved memory.",
    }))
}

function sharedCategoryIDs(a: MemoryFact, b: MemoryFact) {
  const categories = new Set(b.categoryIDs)
  return a.categoryIDs.filter((categoryID) => categoryID !== "uncategorized" && categories.has(categoryID))
}

function semanticTerms(value: string) {
  const generic = new Set([
    "facts", "graph", "memory", "policy", "project", "global", "should", "mendcode", "user", "usuario", "users", "status", "tail", "last", "latest", "ultimo", "ultima", "visible", "mode", "broad",
    "para", "desde", "sobre", "entre", "cuando", "solo", "debe", "deben", "deber", "usar", "usa", "using", "with", "from", "into", "only", "must", "this", "that", "same", "como", "esta", "este", "toda", "todos",
  ])
  const normalized = value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  return new Set(normalized.split(/[^\p{L}\p{N}_@/-]+/u).filter((term) => term.length > 3 && !generic.has(term)))
}

function semanticOverlap(a: MemoryFact, b: MemoryFact) {
  const left = semanticTerms(a.normalizedSummary)
  const right = semanticTerms(b.normalizedSummary)
  const shared = [...left].filter((term) => right.has(term))
  return {
    terms: shared,
    score: shared.length / Math.max(1, Math.min(left.size, right.size)),
  }
}

function selectDreamFactContext(input: {
  facts: MemoryFact[]
  connectedFactIDs?: Set<string>
  suggestedIDs?: Set<string>
}) {
  const connectedFactIDs = input.connectedFactIDs ?? new Set<string>()
  const suggestedIDs = input.suggestedIDs ?? new Set<string>()
  const ranked = input.facts
    .filter((fact) => fact.sensitivity === "low" && !fact.stale)
    .toSorted((a, b) => Number(suggestedIDs.has(b.id)) - Number(suggestedIDs.has(a.id)) || Number(connectedFactIDs.has(a.id)) - Number(connectedFactIDs.has(b.id)) || b.confidence - a.confidence || b.durability - a.durability || a.retrievalPriority - b.retrievalPriority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const scopeQuota = Math.floor(DREAM_FACT_CONTEXT_LIMIT / 2)
  const selected = ["global", "project"].flatMap((scope) => ranked.filter((fact) => fact.scope === scope).slice(0, scopeQuota))
  const selectedIDs = new Set(selected.map((fact) => fact.id))
  return [...selected, ...ranked.filter((fact) => !selectedIDs.has(fact.id))].slice(0, DREAM_FACT_CONTEXT_LIMIT)
}

function isLikelyDuplicateDreamGraphRelation(from: MemoryFact, to: MemoryFact, reason = "") {
  if (from.scope !== to.scope) return false
  if (isNearDreamDuplicate(from.normalizedSummary, to.normalizedSummary)) return true
  if (semanticOverlap(from, to).score >= 0.65) return true
  return /\b(?:duplicate|near[- ]duplicate|duplicad[oa]s?|equivalent|equivalente|consolidat|consolidar|canonical|canónica|canónico)\b/i.test(reason)
    || /\b(?:same|mism[ao])\b.{0,80}\b(?:policy|rule|content|memory|política|regla|contenido|memoria)\b/i.test(reason)
}

function existingGraphLinkKeys(links: MemoryFactLink[]) {
  return new Set(links.flatMap(graphLinkKeys))
}

function graphLinkKeys(input: Pick<MemoryFactLink, "from" | "to" | "kind">) {
  const key = `${input.from}\u0000${input.to}\u0000${input.kind}`
  if (input.kind !== "related" && input.kind !== "conflicts") return [key]
  return [key, `${input.to}\u0000${input.from}\u0000${input.kind}`]
}

function orderRelatedEndpoints(from: MemoryFact, to: MemoryFact, kind: MemoryFactLink["kind"]) {
  if (kind !== "related") return { from, to }
  if (from.scope !== to.scope && (from.scope === "global" || to.scope === "global")) {
    return from.scope === "global" ? { from, to } : { from: to, to: from }
  }
  return { from, to }
}

function projectBridgeKey(fact: MemoryFact) {
  return fact.scope === "project" ? fact.ownerWorkspaceIDs[0] ?? "project:unscoped" : null
}

function isGlobalProjectPair(from: MemoryFact, to: MemoryFact) {
  return from.scope !== to.scope && (from.scope === "global" || to.scope === "global")
}

function normalizeDreamGraphProposal(input: StoredDreamGraphProposal): DreamGraphProposal {
  return {
    ...input,
    status: input.status === "applied" || input.status === "rejected" ? input.status : "pending",
    evidenceRefs: Array.isArray(input.evidenceRefs) ? input.evidenceRefs.filter((ref): ref is string => typeof ref === "string" && ref.length > 0) : [],
    reviewedAt: typeof input.reviewedAt === "string" && input.reviewedAt.trim() ? input.reviewedAt : undefined,
    linkID: typeof input.linkID === "string" && input.linkID.trim() ? input.linkID : undefined,
    rejectionReason: typeof input.rejectionReason === "string" && input.rejectionReason.trim() ? input.rejectionReason : undefined,
  }
}

export function inferDreamGraphProposals(input: {
  facts: MemoryFact[]
  links: MemoryFactLink[]
  evidence: DreamEvidenceRef[]
  suggestions?: DreamGraphCandidate[]
  now?: Date
}) {
  const existing = existingGraphLinkKeys(input.links)
  const evidenceIDs = new Set(input.evidence.map((item) => item.id))
  const allFactByID = new Map(input.facts.map((fact) => [fact.id, fact]))
  const connected = new Set(input.links.flatMap((link) => [link.from, link.to]))
  const bridgedProjects = new Set(input.links.flatMap((link) => {
    const from = allFactByID.get(link.from)
    const to = allFactByID.get(link.to)
    if (!from || !to || !isGlobalProjectPair(from, to)) return []
    const project = from.scope === "project" ? from : to
    const key = projectBridgeKey(project)
    return key ? [key] : []
  }))
  const facts = selectDreamFactContext({ facts: input.facts, connectedFactIDs: connected, suggestedIDs: new Set((input.suggestions ?? []).flatMap((suggestion) => [suggestion.from, suggestion.to])) })
  const factByID = new Map(facts.map((fact) => [fact.id, fact]))
  const proposals: DreamGraphProposal[] = []
  for (const suggestion of input.suggestions ?? []) {
    const from = factByID.get(suggestion.from)
    const to = factByID.get(suggestion.to)
    if (!from || !to || from.id === to.id) continue
    const endpoints = orderRelatedEndpoints(from, to, suggestion.kind)
    const keys = graphLinkKeys({ from: endpoints.from.id, to: endpoints.to.id, kind: suggestion.kind })
    if (suggestion.kind === "related" && isLikelyDuplicateDreamGraphRelation(endpoints.from, endpoints.to, suggestion.reason)) {
      keys.forEach((key) => existing.add(key))
      continue
    }
    const bridgeKey = suggestion.kind === "related" && isGlobalProjectPair(endpoints.from, endpoints.to)
      ? projectBridgeKey(endpoints.from.scope === "project" ? endpoints.from : endpoints.to)
      : null
    if (bridgeKey && bridgedProjects.has(bridgeKey)) continue
    if (keys.some((key) => existing.has(key))) continue
    proposals.push({
      id: nowID("dreamlink"),
      from: endpoints.from.id,
      to: endpoints.to.id,
      kind: suggestion.kind,
      status: "pending",
      confidence: suggestion.confidence,
      reason: suggestion.reason,
      evidenceRefs: suggestion.evidenceRefs.filter((ref) => evidenceIDs.has(ref) || ref.startsWith("dream:") || ref.startsWith("file:")),
      fromSummary: endpoints.from.normalizedSummary,
      toSummary: endpoints.to.normalizedSummary,
      createdAt: (input.now ?? new Date()).toISOString(),
    })
    keys.forEach((key) => existing.add(key))
    connected.add(from.id)
    connected.add(to.id)
    if (bridgeKey) bridgedProjects.add(bridgeKey)
    if (proposals.length >= 8) return proposals
  }
  const candidates = facts.flatMap((from, index) => facts.slice(index + 1).flatMap((to) => {
    const shared = sharedCategoryIDs(from, to)
    const crossScope = from.scope !== to.scope && (from.scope === "global" || to.scope === "global")
    if (!shared.length && !crossScope) return []
    const overlap = semanticOverlap(from, to)
    if (overlap.terms.length < 2) return []
    if (crossScope && overlap.score < 0.25) return []
    const kind: MemoryFactLink["kind"] = "related"
    if (isLikelyDuplicateDreamGraphRelation(from, to)) return []
    const endpoints = orderRelatedEndpoints(from, to, kind)
    const bridgeKey = crossScope ? projectBridgeKey(endpoints.from.scope === "project" ? endpoints.from : endpoints.to) : null
    if (bridgeKey && bridgedProjects.has(bridgeKey)) return []
    const key = `${endpoints.from.id}\u0000${endpoints.to.id}\u0000${kind}`
    if (existing.has(key)) return []
    return [{ from: endpoints.from, to: endpoints.to, shared, overlap, crossScope, bridgeKey, kind, key }]
  }))
  while (candidates.length && proposals.length < 8) {
    candidates.sort((a, b) => {
      const bridgeA = Number(Boolean(a.bridgeKey && !bridgedProjects.has(a.bridgeKey)))
      const bridgeB = Number(Boolean(b.bridgeKey && !bridgedProjects.has(b.bridgeKey)))
      const isolatedA = Number(!connected.has(a.from.id)) + Number(!connected.has(a.to.id))
      const isolatedB = Number(!connected.has(b.from.id)) + Number(!connected.has(b.to.id))
      return bridgeB - bridgeA
        || isolatedB - isolatedA
        || ((b.from.confidence + b.to.confidence) - (a.from.confidence + a.to.confidence))
        || b.shared.length - a.shared.length
        || a.key.localeCompare(b.key)
    })
    const candidateIndex = candidates.findIndex((candidate) => !candidate.bridgeKey || !bridgedProjects.has(candidate.bridgeKey))
    if (candidateIndex === -1) break
    const candidate = candidates.splice(candidateIndex, 1)[0]!
    proposals.push({
      id: nowID("dreamlink"),
      from: candidate.from.id,
      to: candidate.to.id,
      kind: candidate.kind,
      status: "pending",
      confidence: Math.min(0.98, Math.max(0.5, ((candidate.from.confidence + candidate.to.confidence) / 2) - 0.03 + Math.min(0.08, candidate.overlap.score * 0.2))),
      reason: candidate.crossScope
        ? `Cross-scope semantic overlap (${candidate.overlap.terms.slice(0, 4).join(", ")}) bridges global and project memory`
        : `Semantic overlap (${candidate.overlap.terms.slice(0, 4).join(", ")}) within ${candidate.shared.slice(0, 3).join(", ")}`,
      evidenceRefs: [...candidate.from.provenance, ...candidate.to.provenance]
        .filter((ref) => evidenceIDs.has(ref) || ref.startsWith("dream:") || ref.startsWith("file:"))
        .slice(0, 4),
      fromSummary: candidate.from.normalizedSummary,
      toSummary: candidate.to.normalizedSummary,
      createdAt: (input.now ?? new Date()).toISOString(),
    })
    connected.add(candidate.from.id)
    connected.add(candidate.to.id)
    if (candidate.bridgeKey) bridgedProjects.add(candidate.bridgeKey)
  }
  return proposals
}

function dreamGraphProposalAutoApplySafety(input: {
  proposal: DreamGraphProposal
  facts: MemoryFact[]
  config: MemoryConfig
  consolidationPolicy: DreamConsolidationPolicy
}) {
  if (input.consolidationPolicy !== "auto-consolidate" && input.config.dreamWritePolicy !== "auto-safe") return false
  const reversibleRelated = input.proposal.kind === "related"
  if (!reversibleRelated && input.config.dreamWritePolicy !== "auto-safe") return false
  const minConfidence = reversibleRelated ? input.config.dreamGraphAutoApplyMinConfidence : input.config.dreamAutoApplyMinConfidence
  const minDurability = reversibleRelated ? input.config.dreamGraphAutoApplyMinDurability : input.config.dreamAutoApplyMinDurability
  if (input.proposal.confidence + 1e-9 < minConfidence) return false
  const factByID = new Map(input.facts.map((fact) => [fact.id, fact]))
  const facts = [factByID.get(input.proposal.from), factByID.get(input.proposal.to)]
  if (facts.some((fact) => !fact || fact.stale)) return false
  const endpoints = facts.filter((fact): fact is MemoryFact => Boolean(fact))
  if (endpoints.some((fact) => fact.sensitivity !== "low" && input.config.dreamAutoApplyBlockedSensitivity.includes(fact.sensitivity))) return false
  if (endpoints.some((fact) => fact.confidence < Math.min(0.7, minConfidence))) return false
  if (endpoints.some((fact) => fact.durability < minDurability)) return false
  if (endpoints.some((fact) => fact.changeRisk > input.config.dreamAutoApplyMaxChangeRisk)) return false
  const overlap = semanticOverlap(endpoints[0]!, endpoints[1]!)
  if (reversibleRelated && (overlap.terms.length < 2 || (overlap.score < 0.4 && input.proposal.evidenceRefs.length === 0))) return false
  if (reversibleRelated) return true
  if (isGlobalProjectPair(endpoints[0]!, endpoints[1]!)) return false
  const shared = sharedCategoryIDs(endpoints[0]!, endpoints[1]!)
  return shared.some((categoryID) => input.config.dreamAutoApplyAllowedCategories.includes(categoryID))
}

async function writeRun(root: string | undefined, run: DreamRun) {
  const dir = dreamRunDir(root, run.id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`)
  return run
}

async function writeRunProposals(root: string | undefined, runID: string, proposals: MemoryProposal[]) {
  const dir = dreamRunDir(root, runID)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "proposals.json"), `${JSON.stringify(proposals.map((proposal) => ({
    id: proposal.id,
    operation: proposal.operation,
    scope: proposal.scope,
    text: proposal.text,
    status: proposal.status,
    resolution: proposal.resolution,
    appliedEntryID: proposal.appliedEntryID,
    reason: proposal.reason,
  })), null, 2)}\n`)
}

async function writeRunDecisions(root: string | undefined, runID: string, decisions: DreamRunDecision[]) {
  const dir = dreamRunDir(root, runID)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "decisions.json"), `${JSON.stringify(decisions, null, 2)}\n`)
}

async function writeRunGraphProposals(root: string | undefined, runID: string, proposals: DreamGraphProposal[]) {
  const dir = dreamRunDir(root, runID)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "graph-proposals.json"), `${JSON.stringify(proposals.map(normalizeDreamGraphProposal), null, 2)}\n`)
}

async function writeSafety(root: string | undefined, runID: string, input: { evidence: DreamEvidenceRef[]; skipped: string[]; failures: string[] }) {
  const dir = dreamRunDir(root, runID)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "safety.json"), `${JSON.stringify({
    reads: input.evidence.map((item) => ({ sourceType: item.sourceType, sourcePath: item.sourcePath, redacted: item.redacted })),
    skippedSources: input.skipped,
    failures: input.failures,
    redactions: input.evidence.filter((item) => item.redacted).length,
  }, null, 2)}\n`)
}

export async function readDreamRuns(root?: string) {
  const runsRoot = path.join(dreamDir(root), "runs")
  if (!existsSync(runsRoot)) return []
  const entries = await import("fs/promises").then((fs) => fs.readdir(runsRoot)).catch(() => [])
  const runs = await Promise.all(entries.map((entry) => readFile(path.join(runsRoot, entry, "run.json"), "utf8")
    .then((text) => normalizeDreamRun(JSON.parse(text) as DreamRun))
    .catch(() => null)))
  const rootFilter = root ? memoryPaths(root).root : null
  return runs
    .filter((run): run is DreamRun => Boolean(run?.id))
    .filter((run) => !rootFilter || run.projectRoot === rootFilter)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export async function readDreamRunDetail(root: string | undefined, id: string, runInput?: DreamRun): Promise<DreamRunDetail | null> {
  const dir = dreamRunDir(root, id)
  const run = runInput ? normalizeDreamRun(runInput) : await readJsonIfExists<DreamRun>(path.join(dir, "run.json")).then((value) => value ? normalizeDreamRun(value) : null).catch(() => null)
  if (!run?.id) return null
  if (root && run.projectRoot !== memoryPaths(root).root) return null
  const [events, evidence, proposals, graphProposals, decisions, safety, consolidation] = await Promise.all([
    readJsonlIfExists<DreamRunEvent>(path.join(dir, "events.jsonl")),
    readJsonlIfExists<DreamEvidenceRef>(path.join(dir, "evidence.jsonl")),
    readJsonIfExists<DreamRunProposalSummary[]>(path.join(dir, "proposals.json")).catch(() => null),
    readJsonIfExists<StoredDreamGraphProposal[]>(path.join(dir, "graph-proposals.json")).catch(() => null),
    readJsonIfExists<DreamRunDecision[]>(path.join(dir, "decisions.json")).catch(() => null),
    readJsonIfExists<DreamRunSafety>(path.join(dir, "safety.json")).catch(() => null),
    readDreamConsolidationRun(root, id),
  ])
  return { run, events, evidence, proposals: proposals ?? [], graphProposals: (graphProposals ?? []).map(normalizeDreamGraphProposal), decisions: decisions ?? [], consolidation, safety }
}

export async function applyDreamGraphProposal(runID: string, proposalID: string, root?: string) {
  const detail = await readDreamRunDetail(root, runID)
  if (!detail) throw new Error(`Dream run not found: ${runID}`)
  const proposal = detail.graphProposals.find((item) => item.id === proposalID)
  if (!proposal) throw new Error(`Dream graph proposal not found: ${proposalID}`)
  if (proposal.status === "rejected") throw new Error(`Dream graph proposal ${proposalID} was rejected`)
  if (proposal.status === "applied" && proposal.linkID) return { proposal, linkID: proposal.linkID }
  const graph = await readMemoryGraph(root)
  const materialized = new Set(graph.facts.map((fact) => fact.id))
  if (!materialized.has(proposal.from) || !materialized.has(proposal.to)) {
    throw new Error("Dream graph proposal cannot be applied because one or both facts are no longer materialized")
  }
  const proposalKeys = new Set(graphLinkKeys(proposal))
  const existing = graph.links.find((link) => graphLinkKeys(link).some((key) => proposalKeys.has(key)))
  const link = existing ?? await upsertMemoryFactLink({ from: proposal.from, to: proposal.to, kind: proposal.kind }, root)
  const reviewedAt = new Date().toISOString()
  const proposals = detail.graphProposals.map((item) => item.id === proposalID
    ? { ...item, status: "applied" as const, reviewedAt, linkID: link.id, rejectionReason: undefined }
    : item)
  await writeRunGraphProposals(root, runID, proposals)
  return { proposal: proposals.find((item) => item.id === proposalID)!, linkID: link.id }
}

export async function rejectDreamGraphProposal(runID: string, proposalID: string, root?: string, rejectionReason?: string) {
  const detail = await readDreamRunDetail(root, runID)
  if (!detail) throw new Error(`Dream run not found: ${runID}`)
  const proposal = detail.graphProposals.find((item) => item.id === proposalID)
  if (!proposal) throw new Error(`Dream graph proposal not found: ${proposalID}`)
  if (proposal.status === "applied") throw new Error(`Dream graph proposal ${proposalID} was already applied`)
  const reviewedAt = new Date().toISOString()
  const proposals = detail.graphProposals.map((item) => item.id === proposalID
    ? { ...item, status: "rejected" as const, reviewedAt, rejectionReason: rejectionReason?.trim() || "Rejected during memory graph review" }
    : item)
  await writeRunGraphProposals(root, runID, proposals)
  return proposals.find((item) => item.id === proposalID)!
}

export async function readDreamRunDetails(root?: string, limit = Number.MAX_SAFE_INTEGER) {
  const runs = await readDreamRuns(root)
  const selected = runs.slice(0, Math.max(0, limit))
  const details: Array<DreamRunDetail | null> = []
  for (let index = 0; index < selected.length; index += 8) {
    details.push(...await Promise.all(selected.slice(index, index + 8).map((run) => readDreamRunDetail(root, run.id, run))))
  }
  return details.filter((detail): detail is DreamRunDetail => Boolean(detail))
}

export async function latestDreamStatus(root?: string) {
  const runs = await readDreamRuns(root)
  return runs[0] ?? null
}

export async function runMemoryDream(input: {
  root?: string
  source?: "manual" | "scheduled"
  workspaceID?: string | null
  groupID?: string | null
  permissions?: DreamSourcePermissions
  model?: DreamModelAdapter
  consolidator?: DreamConsolidationModel
  consolidationPolicy?: DreamConsolidationPolicy
  now?: Date
} = {}) {
  const root = input.root
  const id = nowID()
  const startedAt = (input.now ?? new Date()).toISOString()
  const permissions = normalizeDreamPermissions(root, input.permissions)
  const config = await readMemoryConfig(root)
  const consolidationPolicy = input.consolidationPolicy ?? config.dreamConsolidationPolicy
  const created: MemoryProposal[] = []
  const decisions: DreamRunDecision[] = []
  let graphProposals: DreamGraphProposal[] = []
  let safetyInput: { evidence: DreamEvidenceRef[]; skipped: string[]; failures: string[] } = { evidence: [], skipped: [], failures: [] }
  let cleanupSummary = "memory cleanup skipped"
  let run: DreamRun = {
    id,
    status: "running",
    source: input.source ?? "manual",
    role: "memoryDream",
    projectRoot: memoryPaths(root).root,
    workspaceID: input.workspaceID ?? null,
    groupID: input.groupID ?? null,
    startedAt,
    completedAt: null,
    proposals: [],
    failureReason: null,
    permissionSnapshot: permissions,
    writePolicySnapshot: config.dreamWritePolicy,
  }
  await writeRun(root, run)
  await appendJsonl(path.join(dreamRunDir(root, id), "events.jsonl"), { at: startedAt, status: "started", message: "Dream started" } satisfies DreamRunEvent)
  publishMemoryDreamEvent({ root: memoryPaths(root).root, runID: id, status: "started", message: "Dream started" })

  try {
    if (consolidationPolicy === "auto-consolidate") {
      const cleanup = await cleanupGeneratedMemoryEntries(root)
      cleanupSummary = cleanup.archived.length ? `memory cleanup archived ${cleanup.archived.length} redundant entries` : "memory cleanup found no redundant entries"
      if (cleanup.archived.length) {
        await appendJsonl(path.join(dreamRunDir(root, id), "events.jsonl"), { at: new Date().toISOString(), status: "progress", message: `Dream ${cleanupSummary}` } satisfies DreamRunEvent)
        publishMemoryDreamEvent({ root: memoryPaths(root).root, runID: id, status: "progress", message: `Dream ${cleanupSummary}` })
      }
    }
    await materializeLegacyMemoryFacts(root)
    const [allFacts, graph, allProposals, files] = await Promise.all([
      readMemoryFacts(root),
      readMemoryGraph(root),
      listMemoryProposals(root, "all"),
      collectDreamFileEvidence(permissions),
    ])
    const connectedFactIDs = new Set(graph.links.flatMap((link) => [link.from, link.to]))
    const graphFacts = selectDreamFactContext({ facts: graph.facts, connectedFactIDs })
    const graphFactIDs = new Set(graphFacts.map((fact) => fact.id))
    const facts = [...graphFacts, ...allFacts.filter((fact) => !graphFactIDs.has(fact.id))].slice(0, DREAM_FACT_CONTEXT_LIMIT)
    const proposals = allProposals.slice(0, DREAM_PROPOSAL_CONTEXT_LIMIT)
    const evidence: DreamEvidenceRef[] = [
      ...facts.map((fact) => ({
        id: `memory:${fact.id}`,
        sourceType: "memory" as const,
        sourcePath: null,
        excerpt: fact.normalizedSummary,
        hash: fact.id,
        redacted: false,
      })),
      ...proposals.map((proposal) => ({
        id: `proposal:${proposal.id}`,
        sourceType: "proposal" as const,
        sourcePath: null,
        excerpt: proposal.text,
        hash: proposal.id,
        redacted: proposal.redactions.length > 0,
      })),
      ...files.evidence,
    ]
    const dir = dreamRunDir(root, id)
    await appendJsonl(path.join(dir, "events.jsonl"), { at: new Date().toISOString(), status: "progress", message: `Collected ${evidence.length} evidence refs` } satisfies DreamRunEvent)
    publishMemoryDreamEvent({ root: memoryPaths(root).root, runID: id, status: "progress", message: `Collected ${evidence.length} evidence refs` })
    await writeFile(path.join(dir, "evidence.jsonl"), evidence.map((item) => JSON.stringify(item)).join("\n") + (evidence.length ? "\n" : ""))
    safetyInput = { evidence, skipped: files.skipped, failures: [] }
    await writeSafety(root, id, safetyInput)
    const model = input.model ?? (await configuredDreamModel(root)) ?? defaultDreamCandidates
    const modelOutput = await model({ facts, proposals, evidence })
    const candidates = Array.isArray(modelOutput) ? modelOutput : modelOutput.candidates
    const graphSuggestions = Array.isArray(modelOutput) ? [] : modelOutput.graphLinks
    const priorCandidates: Array<{ id: string; text: string }> = []
    for (const candidate of candidates.slice(0, 5)) {
      const scope = candidate.scope ?? "project"
      const categoryIDs = candidate.categoryIDs ?? []
      const evidenceRefs = [`dream:${id}`, ...(candidate.evidenceRefs ?? [])]
      const candidateText = redactMemoryText(candidate.text).text
      if (isMemoryMaintenanceInstruction(candidate.text, { categoryIDs }) || isMemoryMaintenanceInstruction(candidate.reason ?? "", { categoryIDs })) {
        const reason = "Dream skipped a memory-maintenance instruction; the host consolidator handles it without saving it as a memory."
        decisions.push({
          at: new Date().toISOString(),
          status: "skipped-policy",
          policy: config.dreamWritePolicy,
          text: candidateText,
          scope,
          categoryIDs,
          reason,
          confidence: candidate.confidence ?? 0.8,
          durability: candidate.durability ?? 0.85,
          changeRisk: candidate.changeRisk ?? 0.15,
          evidenceRefs,
        })
        priorCandidates.push({ id: `maintenance:${decisions.length}`, text: candidate.text })
        await appendJsonl(path.join(dir, "events.jsonl"), { at: new Date().toISOString(), status: "progress", message: reason } satisfies DreamRunEvent)
        continue
      }
      const duplicateOf = dreamDuplicateFor({ text: candidate.text, categoryIDs, scope, facts: allFacts, proposals: allProposals, priorCandidates })
      if (duplicateOf) {
        decisions.push({
          at: new Date().toISOString(),
          status: "skipped-duplicate",
          policy: config.dreamWritePolicy,
          text: candidateText,
          scope,
          categoryIDs,
          reason: `Skipped duplicate proposal: matched existing ${duplicateOf.sourceType}`,
          confidence: candidate.confidence ?? 0.8,
          durability: candidate.durability ?? 0.85,
          changeRisk: candidate.changeRisk ?? 0.15,
          evidenceRefs,
          duplicateOf,
        })
        priorCandidates.push({ id: duplicateOf.id, text: candidate.text })
        await appendJsonl(path.join(dir, "events.jsonl"), { at: new Date().toISOString(), status: "progress", message: `Skipped duplicate proposal: matched existing ${duplicateOf.sourceType}` } satisfies DreamRunEvent)
        continue
      }
      if (config.dreamWritePolicy === "disabled" || (config.dreamWritePolicy === "model-decides" && candidate.recommendedDisposition === "skip")) {
        const reason = config.dreamWritePolicy === "disabled" ? "Dream write policy disabled writes for this candidate." : "Dream model recommended skipping this candidate."
        decisions.push({
          at: new Date().toISOString(),
          status: "skipped-policy",
          policy: config.dreamWritePolicy,
          text: candidateText,
          scope,
          categoryIDs,
          reason,
          confidence: candidate.confidence ?? 0.8,
          durability: candidate.durability ?? 0.85,
          changeRisk: candidate.changeRisk ?? 0.15,
          evidenceRefs,
        })
        priorCandidates.push({ id: `candidate:${decisions.length}`, text: candidate.text })
        await appendJsonl(path.join(dir, "events.jsonl"), { at: new Date().toISOString(), status: "progress", message: reason } satisfies DreamRunEvent)
        continue
      }
      const proposal = await proposeMemory({
        scope,
        text: candidate.text,
        tags: ["dream", ...categoryIDs],
        categoryIDs,
        source: "memory-dream",
        evidence: `dream:${id}`,
        evidenceRefs,
        confidence: candidate.confidence ?? 0.8,
        durability: candidate.durability ?? 0.85,
        changeRisk: candidate.changeRisk ?? 0.15,
        reason: candidate.reason ?? "Dream proposed memory maintenance.",
      }, root)
      const settled = await settleGeneratedMemoryProposal({
        proposal,
        policy: config.dreamWritePolicy,
        recommendedDisposition: candidate.recommendedDisposition,
        minConfidence: config.dreamAutoApplyMinConfidence,
        minDurability: config.dreamAutoApplyMinDurability,
        maxChangeRisk: config.dreamAutoApplyMaxChangeRisk,
        allowedCategories: config.dreamAutoApplyAllowedCategories,
        blockedSensitivity: config.dreamAutoApplyBlockedSensitivity,
      }, root)
      created.push(settled.proposal)
      priorCandidates.push({ id: settled.proposal.id, text: settled.proposal.text })
      decisions.push({
        at: new Date().toISOString(),
        status: settled.autoApplied ? "auto-applied-proposal" : "created-proposal",
        policy: config.dreamWritePolicy,
        text: settled.proposal.text,
        scope: settled.proposal.scope,
        categoryIDs: settled.proposal.categoryIDs,
        reason: `${settled.proposal.reason ?? "Dream proposed memory maintenance."} (${settled.reason})`,
        confidence: settled.proposal.confidence,
        durability: settled.proposal.durability,
        changeRisk: settled.proposal.changeRisk,
        evidenceRefs: settled.proposal.evidenceRefs,
        proposalID: settled.proposal.id,
        entryID: settled.entry?.id,
      })
    }
    let consolidationSummary = "consolidation disabled"
    if (consolidationPolicy !== "disabled") {
      const pendingForConsolidation = await listMemoryProposals(root, "pending")
      const resolvedConsolidator = input.consolidator ? null : await resolveMemoryConsolidator(root)
      if (!pendingForConsolidation.length) {
        consolidationSummary = "consolidation found no pending proposals"
      } else {
        const consolidationModel = input.consolidator ?? (resolvedConsolidator?.ok
          ? async (modelInput: Parameters<DreamConsolidationModel>[0]) => {
            const recommendations = await resolvedConsolidator.model(modelInput).catch(() => [])
            const expectedIDs = new Set(modelInput.proposals.map((proposal) => proposal.id))
            const resolvedIDs = new Set<string>()
            const acceptedRecommendations = recommendations.filter((decision) => {
              if (!decision.proposalID) return true
              if (!expectedIDs.has(decision.proposalID) || resolvedIDs.has(decision.proposalID)) return false
              resolvedIDs.add(decision.proposalID)
              return true
            })
            const fallback = await deterministicDreamConsolidator(modelInput)
            return [...acceptedRecommendations, ...fallback.filter((decision) => !decision.proposalID || !resolvedIDs.has(decision.proposalID))]
          }
          : deterministicDreamConsolidator)
        const consolidation = await runMemoryConsolidation({
          root,
          runID: id,
          policy: consolidationPolicy,
          model: consolidationModel,
          evidence,
          now: input.now,
        })
        consolidationSummary = consolidation.status === "failed"
          ? `consolidation failed: ${consolidation.failureReason || "unknown failure"}`
          : `consolidation ${consolidation.status}: ${consolidation.resolved} resolved, ${consolidation.pendingAfter} pending`
        await appendJsonl(path.join(dir, "events.jsonl"), { at: new Date().toISOString(), status: consolidation.status === "failed" ? "failed" : "progress", message: `Dream ${consolidationSummary}` } satisfies DreamRunEvent)
        publishMemoryDreamEvent({ root: memoryPaths(root).root, runID: id, status: consolidation.status === "failed" ? "failed" : "progress", message: `Dream ${consolidationSummary}` })
        if (consolidation.status === "failed") throw new Error(consolidation.failureReason || "Dream consolidation failed")
      }
    }

    const [latestFacts, latestGraph, latestProposals] = await Promise.all([
      readMemoryFacts(root),
      readMemoryGraph(root),
      listMemoryProposals(root, "all"),
    ])
    const latestConnected = new Set(latestGraph.links.flatMap((link) => [link.from, link.to]))
    const suggestedIDs = new Set(graphSuggestions.flatMap((suggestion) => [suggestion.from, suggestion.to]))
    const latestGraphFacts = selectDreamFactContext({ facts: latestGraph.facts, connectedFactIDs: latestConnected, suggestedIDs })
    graphProposals = inferDreamGraphProposals({ facts: latestGraphFacts, links: latestGraph.links, evidence, suggestions: graphSuggestions, now: input.now })
    await writeRunGraphProposals(root, id, graphProposals)
    let autoAppliedGraphLinks = 0
    let autoRejectedGraphLinks = 0
    const autoReviewGraph = consolidationPolicy === "auto-consolidate"
    for (const proposal of graphProposals) {
      if (dreamGraphProposalAutoApplySafety({ proposal, facts: latestFacts, config, consolidationPolicy })) {
        await applyDreamGraphProposal(id, proposal.id, root)
        autoAppliedGraphLinks++
        continue
      }
      if (autoReviewGraph) {
        await rejectDreamGraphProposal(id, proposal.id, root, "Dream automatically rejected the graph link because it failed the semantic or safety gate.")
        autoRejectedGraphLinks++
      }
    }
    if (autoAppliedGraphLinks || autoRejectedGraphLinks) {
      graphProposals = (await readDreamRunDetail(root, id))?.graphProposals ?? graphProposals
    }
    if (graphProposals.length) {
      const pendingGraphLinks = graphProposals.filter((proposal) => proposal.status === "pending").length
      const message = `Dream evaluated ${graphProposals.length} graph links: ${autoAppliedGraphLinks} applied, ${autoRejectedGraphLinks} rejected, ${pendingGraphLinks} pending review`
      await appendJsonl(path.join(dir, "events.jsonl"), { at: new Date().toISOString(), status: "progress", message } satisfies DreamRunEvent)
      publishMemoryDreamEvent({ root: memoryPaths(root).root, runID: id, status: "progress", message })
    }
    const liveProposalByID = new Map(latestProposals.map((proposal) => [proposal.id, proposal]))
    await writeRunProposals(root, id, created.map((proposal) => liveProposalByID.get(proposal.id) ?? proposal))
    await writeRunDecisions(root, id, decisions)
    const completedAt = new Date().toISOString()
    run = { ...run, status: "completed", completedAt, proposals: created.map((proposal) => proposal.id) }
    await writeRun(root, run)
    const skipped = decisions.filter((decision) => decision.status === "skipped-duplicate" || decision.status === "skipped-policy").length
    const autoApplied = decisions.filter((decision) => decision.status === "auto-applied-proposal").length
    const completionMessage = `Dream completed with ${created.length} proposals, ${autoApplied} auto-applied, ${skipped} skipped, ${graphProposals.length} graph decisions, ${consolidationSummary}, ${cleanupSummary}`
    await appendJsonl(path.join(dir, "events.jsonl"), { at: completedAt, status: "completed", message: completionMessage } satisfies DreamRunEvent)
    publishMemoryDreamEvent({ root: memoryPaths(root).root, runID: id, status: "completed", message: completionMessage, proposalCount: created.length })
    return run
  } catch (error) {
    const completedAt = new Date().toISOString()
    run = { ...run, status: "failed", completedAt, failureReason: error instanceof Error ? error.message : String(error), proposals: created.map((proposal) => proposal.id) }
    await writeRun(root, run)
    const liveProposals = await listMemoryProposals(root, "all").catch(() => [])
    const liveByID = new Map(liveProposals.map((proposal) => [proposal.id, proposal]))
    await writeRunProposals(root, id, created.map((proposal) => liveByID.get(proposal.id) ?? proposal))
    await writeRunDecisions(root, id, decisions)
    await writeRunGraphProposals(root, id, graphProposals)
    await appendJsonl(path.join(dreamRunDir(root, id), "events.jsonl"), { at: completedAt, status: "failed", message: run.failureReason ?? "Dream failed" } satisfies DreamRunEvent)
    publishMemoryDreamEvent({ root: memoryPaths(root).root, runID: id, status: "failed", message: run.failureReason ?? "Dream failed" })
    safetyInput = { ...safetyInput, failures: [run.failureReason ?? "Dream failed"] }
    await writeSafety(root, id, safetyInput)
    return run
  }
}
