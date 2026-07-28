import { existsSync } from "fs"
import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises"
import path from "path"
import { memoryPaths, readMemoryConfig, type GeneratedMemoryWritePolicy, type MemoryConfig, type MemoryScope } from "./config"
import { appendMemoryEntry, deleteMemoryEntry, readMemoryEntries, updateMemoryEntry, type MemoryEntry, type MemorySensitivity } from "./store"
import { DEFAULT_MEMORY_CATEGORIES, inferMemoryCategoryIDs, normalizeMemoryCategoryIDs, scopeReasonForMemory } from "./categories"
import { connectMemoryFactToRelatedFact, legacyScopeForFact, readMemoryFacts, readMemoryGraph, upsertMemoryFact, upsertMemoryFactLink, type MemoryFactLink } from "./graph"
import { configureDreamScheduleFromText, type DreamScheduleState } from "./dream-scheduler"
import { resolveModelRoles } from "../config/models"
import { runProviderAdapter } from "../runtime/provider-adapters"
import { dreamServiceStart, type DreamServicePlan } from "../runtime/dream-service"

export type MemoryProposalStatus = "pending" | "applied" | "rejected"
export type MemoryProposalResolution = "pending" | "applied" | "rejected" | "archived" | "superseded"
export type MemoryProposalOperation = "add" | "update" | "remove" | "merge" | "split" | "verify" | "expire" | "recategorize" | "relink" | "demote-scope" | "promote-scope"
export type GeneratedMemoryDisposition = "auto-apply" | "pending" | "skip"

export type MemoryProposal = {
  id: string
  version: 0
  status: MemoryProposalStatus
  resolution?: MemoryProposalResolution
  resolutionReason?: string | null
  resolvedAt?: string | null
  supersededBy?: string | null
  operation: MemoryProposalOperation
  scope: MemoryScope
  text: string
  tags: string[]
  categoryIDs: string[]
  scopeReason: string
  cwd: string | null
  files: string[]
  source: string
  evidence: string | null
  confidence: number
  durability: number
  changeRisk: number
  reason: string | null
  evidenceRefs: string[]
  policyDecision: "pending" | "auto-applied" | "manual-only" | "disabled"
  sensitivity: MemorySensitivity
  redactions: string[]
  createdAt: string
  updatedAt: string
  targetEntryID: string | null
  targetEntryScope: MemoryScope | null
  targetEntryIDs: string[]
  appliedEntryID: string | null
}

export type ProposeMemoryInput = {
  operation?: MemoryProposalOperation
  text: string
  scope?: MemoryScope
  targetEntryID?: string | null
  targetEntryScope?: MemoryScope | null
  targetEntryIDs?: string[]
  tags?: string[]
  categoryIDs?: string[]
  cwd?: string | null
  files?: string[]
  source?: string
  evidence?: string | null
  confidence?: number
  durability?: number
  changeRisk?: number
  reason?: string | null
  evidenceRefs?: string[]
  policyDecision?: MemoryProposal["policyDecision"]
}

export type ProposeMemoriesFromTextInput = Omit<ProposeMemoryInput, "text"> & {
  text: string
  maxProposals?: number
}

export type MemoryExtractorRoleResult =
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

export type AutoMemoryResult = {
  enabled: boolean
  output: boolean
  skipped: boolean
  reason: string | null
  proposals: MemoryProposal[]
  callsProviders: boolean
  writesMemory: boolean
}

export type ApplyMemoryProposalInput = {
  startDreamService?: () => Promise<DreamServicePlan>
  connectRelated?: boolean
  relatedCategoryIDs?: string[]
}

export type ApplyMemoryProposalResult = {
  proposal: MemoryProposal
  entry: MemoryEntry | null
  dreamSchedule: DreamScheduleState | null
  dreamService: DreamServicePlan | null
}

export const MEMORY_EXTRACTION_POLICY = [
  "Only propose memory that should remain useful far into the future.",
  "Keep only durable user preferences, stable project decisions, recurring constraints, long-lived repo facts, safety rules, and workflow conventions.",
  "Be highly selective: prefer one consolidated memory, and never propose more than two memories from one conversation.",
  "Reject uncertain facts, likely-to-change details, hypotheses, guesses, stale conclusions, and anything that may be wrong after the current task evolves.",
  "Do not require explicit memory wording in any language; strong future-facing preferences and rules are valid candidates.",
  "Reject anything about what just happened, what is currently happening, what was just checked, what should be done next, or what was already answered.",
  "Reject temporary state, one-off task details, status updates, todo-like recommendations, transient debugging context, raw logs, secrets, and anything already present in saved memory.",
  "A proposal must be self-contained, specific, and useful without the surrounding chat. If it would not help a future session, return nothing.",
  "Generated proposals are policy-gated: the app may leave them pending, auto-apply obviously safe adds, skip them, or follow your recommendedDisposition when configured to model-decides.",
].join("\n")

function nowID(prefix = "memprop") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
}

function redactionPatterns() {
  return [
    { label: "env-assignment", pattern: /\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s"'`]+/g },
    { label: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
    { label: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
    { label: "generic-token", pattern: /\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*[^\s"'`]+/gi },
  ]
}

export function redactMemoryText(text: string) {
  let redacted = text.trim()
  const redactions: string[] = []
  for (const { label, pattern } of redactionPatterns()) {
    if (!pattern.test(redacted)) continue
    pattern.lastIndex = 0
    redacted = redacted.replace(pattern, `[REDACTED:${label}]`)
    redactions.push(label)
  }
  return { text: redacted, redactions: [...new Set(redactions)] }
}

function sensitivityFor(redactions: string[], text: string): MemorySensitivity {
  if (redactions.length) return "high"
  if (/\b(auth|secret|token|credential|password|keychain|keepass|env)\b/i.test(text)) return "medium"
  return "low"
}

function proposalPath(root: string | undefined, id: string) {
  return path.join(memoryPaths(root).proposalsDir, `${id}.json`)
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T
}

function normalizeMemoryProposal(input: Partial<MemoryProposal> & Pick<MemoryProposal, "id">): MemoryProposal {
  const text = typeof input.text === "string" && input.text.trim() ? input.text.trim() : ""
  const tags = normalizeStringList(input.tags)
  const source = typeof input.source === "string" && input.source.trim() ? input.source : "manual-proposal"
  const categoryIDs = normalizeMemoryCategoryIDs(input.categoryIDs?.length ? input.categoryIDs : inferMemoryCategoryIDs({ text, tags, source }))
  const createdAt = typeof input.createdAt === "string" && input.createdAt.trim() ? input.createdAt : typeof input.updatedAt === "string" && input.updatedAt.trim() ? input.updatedAt : new Date(0).toISOString()
  const updatedAt = typeof input.updatedAt === "string" && input.updatedAt.trim() ? input.updatedAt : createdAt
  const status = input.status === "applied" || input.status === "rejected" ? input.status : "pending"
  const resolution = input.resolution === "applied" || input.resolution === "rejected" || input.resolution === "archived" || input.resolution === "superseded"
    ? input.resolution
    : status === "applied"
      ? "applied"
      : status === "rejected"
        ? "rejected"
        : "pending"
  return {
    id: input.id,
    version: 0,
    status,
    resolution,
    resolutionReason: typeof input.resolutionReason === "string" && input.resolutionReason.trim() ? input.resolutionReason.trim() : null,
    resolvedAt: typeof input.resolvedAt === "string" && input.resolvedAt.trim() ? input.resolvedAt : null,
    supersededBy: typeof input.supersededBy === "string" && input.supersededBy.trim() ? input.supersededBy : null,
    operation: input.operation ?? "add",
    scope: input.scope === "global" ? "global" : "project",
    text,
    tags,
    categoryIDs,
    scopeReason: input.scopeReason || scopeReasonForMemory({ requestedScope: input.scope === "global" ? "global" : "project", text, tags }).reason,
    cwd: typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : null,
    files: normalizeStringList(input.files),
    source,
    evidence: typeof input.evidence === "string" && input.evidence.trim() ? input.evidence.trim() : null,
    confidence: typeof input.confidence === "number" && Number.isFinite(input.confidence) ? Math.max(0, Math.min(1, input.confidence)) : 0.7,
    durability: typeof input.durability === "number" && Number.isFinite(input.durability) ? Math.max(0, Math.min(1, input.durability)) : 0.7,
    changeRisk: typeof input.changeRisk === "number" && Number.isFinite(input.changeRisk) ? Math.max(0, Math.min(1, input.changeRisk)) : 0.3,
    reason: typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : null,
    evidenceRefs: normalizeStringList(input.evidenceRefs),
    policyDecision: input.policyDecision === "auto-applied" || input.policyDecision === "manual-only" || input.policyDecision === "disabled" ? input.policyDecision : "pending",
    sensitivity: input.sensitivity === "high" || input.sensitivity === "medium" || input.sensitivity === "low" ? input.sensitivity : sensitivityFor(normalizeStringList(input.redactions), text),
    redactions: normalizeStringList(input.redactions),
    createdAt,
    updatedAt,
    targetEntryID: typeof input.targetEntryID === "string" && input.targetEntryID.trim() ? input.targetEntryID.trim() : null,
    targetEntryScope: input.targetEntryScope === "global" || input.targetEntryScope === "project" ? input.targetEntryScope : null,
    targetEntryIDs: normalizeStringList(input.targetEntryIDs).length ? normalizeStringList(input.targetEntryIDs) : typeof input.targetEntryID === "string" && input.targetEntryID.trim() ? [input.targetEntryID.trim()] : [],
    appliedEntryID: typeof input.appliedEntryID === "string" && input.appliedEntryID.trim() ? input.appliedEntryID.trim() : null,
  }
}

async function writeProposal(proposal: MemoryProposal, root?: string) {
  const paths = memoryPaths(root)
  const normalized = normalizeMemoryProposal(proposal)
  await mkdir(paths.proposalsDir, { recursive: true })
  await writeFile(proposalPath(paths.root, normalized.id), `${JSON.stringify(normalized, null, 2)}\n`)
  return normalized
}

export async function proposeMemory(input: ProposeMemoryInput, root?: string) {
  const paths = memoryPaths(root)
  const redacted = redactMemoryText(input.text)
  if (!redacted.text) throw new Error("Cannot propose empty memory text")
  const now = new Date().toISOString()
  const proposal: MemoryProposal = {
    id: nowID(),
    version: 0,
    status: "pending",
    resolution: "pending",
    resolutionReason: null,
    resolvedAt: null,
    supersededBy: null,
    operation: input.operation === "update" || input.operation === "remove" || input.operation === "merge" || input.operation === "split" || input.operation === "verify" || input.operation === "expire" || input.operation === "recategorize" || input.operation === "relink" || input.operation === "demote-scope" || input.operation === "promote-scope" ? input.operation : "add",
    scope: scopeReasonForMemory({ requestedScope: input.scope, text: redacted.text, tags: input.tags }).scope,
    text: redacted.text,
    tags: normalizeStringList(input.tags),
    categoryIDs: normalizeMemoryCategoryIDs(input.categoryIDs?.length ? input.categoryIDs : inferMemoryCategoryIDs({ text: redacted.text, tags: input.tags, source: input.source })),
    scopeReason: scopeReasonForMemory({ requestedScope: input.scope, text: redacted.text, tags: input.tags }).reason,
    cwd: typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : paths.root,
    files: normalizeStringList(input.files),
    source: typeof input.source === "string" && input.source.trim() ? input.source : "manual-proposal",
    evidence: typeof input.evidence === "string" && input.evidence.trim() ? input.evidence.trim() : null,
    confidence: typeof input.confidence === "number" && Number.isFinite(input.confidence) ? Math.max(0, Math.min(1, input.confidence)) : redacted.redactions.length ? 0.45 : 0.7,
    durability: typeof input.durability === "number" && Number.isFinite(input.durability) ? Math.max(0, Math.min(1, input.durability)) : 0.7,
    changeRisk: typeof input.changeRisk === "number" && Number.isFinite(input.changeRisk) ? Math.max(0, Math.min(1, input.changeRisk)) : 0.3,
    reason: typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : null,
    evidenceRefs: normalizeStringList(input.evidenceRefs),
    policyDecision: generatedPolicyDecision(input.policyDecision),
    sensitivity: sensitivityFor(redacted.redactions, input.text),
    redactions: redacted.redactions,
    createdAt: now,
    updatedAt: now,
    targetEntryID: typeof input.targetEntryID === "string" && input.targetEntryID.trim() ? input.targetEntryID.trim() : null,
    targetEntryScope: input.targetEntryScope === "global" || input.targetEntryScope === "project" ? input.targetEntryScope : null,
    targetEntryIDs: normalizeStringList(input.targetEntryIDs).length ? normalizeStringList(input.targetEntryIDs) : typeof input.targetEntryID === "string" && input.targetEntryID.trim() ? [input.targetEntryID.trim()] : [],
    appliedEntryID: null,
  }
  return writeProposal(proposal, paths.root)
}

function memoryFingerprint(text: string) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[`*_()[\]{}.,:;!?'"-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function extractJsonObject(text: string) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  if (!trimmed) return ""
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start === -1 || end <= start) return trimmed
  return trimmed.slice(start, end + 1)
}

function isNearDuplicate(candidate: string, existing: string[]) {
  const normalized = memoryFingerprint(candidate)
  if (!normalized) return true
  return existing.some((item) => {
    if (item === normalized) return true
    if (item.includes(normalized) || normalized.includes(item)) return true
    const candidateTerms = new Set(normalized.split(" ").filter((term) => term.length > 3))
    const existingTerms = new Set(item.split(" ").filter((term) => term.length > 3))
    const candidateCodeTerms = new Set(normalized.split(" ").filter((term) => /[_./-]/.test(term) || /\b(js|css|docker|frontend|backend|forgejo|zerobase|webpack|makefile)\b/i.test(term)))
    const existingCodeTerms = new Set(item.split(" ").filter((term) => /[_./-]/.test(term) || /\b(js|css|docker|frontend|backend|forgejo|zerobase|webpack|makefile)\b/i.test(term)))
    if (candidateCodeTerms.size >= 2 && existingCodeTerms.size >= 2) {
      let codeOverlap = 0
      for (const term of candidateCodeTerms) if (existingCodeTerms.has(term)) codeOverlap++
      if (codeOverlap >= 2) return true
    }
    if (candidateTerms.size < 5 || existingTerms.size < 5) return false
    let overlap = 0
    for (const term of candidateTerms) if (existingTerms.has(term)) overlap++
    return overlap / Math.min(candidateTerms.size, existingTerms.size) >= 0.72
  })
}

export function memoryExtractorFailureReason(error: unknown) {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "")
  const reason = raw.replace(/\s+/g, " ").trim()
  if (!reason) return "memory extractor model failed"
  if (/MENDCODE_OPENAI_OAUTH_CLIENT_ID|OPENAI_OAUTH_CLIENT_ID|ChatGPT subscription OAuth/i.test(reason))
    return "memory extractor auth missing"
  if (/OPENAI_API_KEY/i.test(reason)) return "memory extractor API key missing"
  if (/auth mode is not implemented/i.test(reason)) return "memory extractor auth unsupported"
  return reason.slice(0, 240)
}

export function extractorPrompt() {
  return [
    "You are MendCode's memory extractor.",
    MEMORY_EXTRACTION_POLICY,
    "",
    "Return strict JSON only:",
    '{"proposals":[{"shouldRemember":true,"operation":"add|update|remove|verify|expire|recategorize|demote-scope","scope":"project|global","categoryIDs":["project.commands"],"targetEntryID":"existing-memory-id-or-null","targetEntryScope":"project|global|null","text":"durable memory text or removal reason","tags":["short-tag"],"durability":0.0,"confidence":0.0,"changeRisk":0.0,"recommendedDisposition":"auto-apply|pending|skip","reason":"why this is worth changing"}]}',
    "",
    "Allowed memory categories (use only these exact IDs; this extractor cannot create categories):",
    ...DEFAULT_MEMORY_CATEGORIES.filter((category) => category.id !== "uncategorized").map(
      (category) => `- ${category.id}: ${category.description} Allowed scopes: ${category.allowedScopes.join(", ")}.`,
    ),
    "- uncategorized: compatibility fallback only. Use it only when no semantic category above applies.",
    "",
    "Rules:",
    "- Return an empty proposals array unless the input contains genuinely durable future-use information that should be remembered indefinitely.",
    "- Only set shouldRemember=true when durability is at least 0.8, confidence is at least 0.75, and changeRisk is at most 0.25.",
    "- Do not require explicit memory wording. If the user says something is very important, says always/never, gives a future workflow rule, states a durable preference, or corrects how the assistant should behave in future sessions, treat it as a strong memory candidate.",
    "- Repo-scoped workflow rules, recurring event/condition/action instructions, and future validation requirements are strong project memory candidates even if the assistant only acknowledges them briefly.",
    "- Assistant text such as 'I will not save this yet' is not a reason to skip. Extract from the user's durable instruction, not from whether the assistant remembered to save it.",
    "- Review saved_memory and pending_memory before proposing. If either already contains an equivalent fact, return an empty proposals array.",
    "- Saved global memories apply across projects. Saved project memories and pending project proposals apply to this repo. Use that scope evidence when checking duplicates.",
    "- If the user repeats or lightly rephrases a durable preference that is not in saved_memory or pending_memory, propose operation=add once.",
    "- For operation=add, distill the durable instruction into a self-contained memory that captures the scope, trigger/condition, expected behavior, and any important constraint without copying transient chat phrasing.",
    "- If the user corrects, narrows, expands, or replaces an existing saved memory, propose operation=update with the saved entry id in targetEntryID and the complete replacement text.",
    "- If the user explicitly says an existing saved memory is wrong, obsolete, no longer true, or should be forgotten/removed, propose operation=remove with the saved entry id in targetEntryID.",
    "- Never use operation=update or operation=remove without a concrete targetEntryID from saved_memory.",
    "- Prefer a single consolidated proposal. Return two only when there are two clearly separate durable memories. Never return more than two.",
    "- Do not split related details into multiple memories; merge them into one precise memory.",
    "- Set recommendedDisposition=auto-apply only for obvious low-risk add memories that are durable, low-sensitivity, non-secret, highly confident, and not a rewrite/removal of existing memory.",
    "- Set recommendedDisposition=pending for updates, removals, security-sensitive memories, broad behavior changes, or anything useful but not completely obvious.",
    "- Set recommendedDisposition=skip when the candidate should not be saved after all.",
    "- Do not propose uncertain, provisional, likely-to-change, disputed, weakly inferred, or recently discovered facts unless the user clearly frames them as a future preference, rule, or decision.",
    "- Scope must be conservative. Use project by default.",
    "- Use project for repo/app/product-specific facts, architecture, setup, env/deploy behavior, local paths, commands, files, docs, framework choices, or limitations.",
    "- Use global only for durable user preferences, communication style, safety rules, or workflows that should follow the user across unrelated repos.",
    "- If the memory mentions a specific project/repo/product name, choose project unless the text is explicitly a cross-project preference.",
    "- Do not propose memories from recent events, current status, temporary blockers, findings from the current task, task lists, or next-step recommendations.",
    "- Do not memorize the existence or contents of files unless the user explicitly asks to remember a durable rule, constraint, or preference from them.",
    "- Memory should describe durable facts/preferences, not todos or summaries of recent work.",
    "- Do not propose text copied from an assistant answer unless the user explicitly asks to remember it.",
    "- Do not propose anything already covered by existing memory.",
    "- Do not include markdown, prose, or code fences.",
  ].join("\n")
}

type ExtractedMemoryProposal = {
  shouldRemember: boolean
  operation: MemoryProposalOperation
  scope: MemoryScope
  targetEntryID: string | null
  targetEntryScope: MemoryScope | null
  text: string
  tags: string[]
  categoryIDs: string[]
  durability: number
  confidence: number
  changeRisk: number
  recommendedDisposition: GeneratedMemoryDisposition
  reason: string | null
}

function parseExtractorJSON(text: string, maxProposals = 2): ExtractedMemoryProposal[] {
  const trimmed = extractJsonObject(text)
  if (!trimmed) return []
  let parsed: any
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  const proposals = Array.isArray(parsed?.proposals) ? parsed.proposals : []
  const limit = Math.max(0, Math.min(2, maxProposals))
  return proposals
    .filter((item: any) => typeof item?.text === "string" && item.text.trim().length >= 16)
    .map((item: any): ExtractedMemoryProposal => {
      const tags = normalizeStringList(item.tags)
      const categoryIDs = normalizeMemoryCategoryIDs(item.categoryIDs)
      return {
        shouldRemember: item.shouldRemember === true,
        operation: item.operation === "update" || item.operation === "remove" || item.operation === "verify" || item.operation === "expire" || item.operation === "recategorize" || item.operation === "demote-scope" ? item.operation : "add",
        scope: item.scope === "global" ? "global" as const : "project" as const,
        targetEntryID: typeof item.targetEntryID === "string" && item.targetEntryID.trim() ? item.targetEntryID.trim() : null,
        targetEntryScope: item.targetEntryScope === "global" ? "global" as const : item.targetEntryScope === "project" ? "project" as const : null,
        text: item.text.trim(),
        tags,
        categoryIDs: categoryIDs.length === 1 && categoryIDs[0] === "uncategorized"
          ? inferMemoryCategoryIDs({ text: item.text, tags, source: "model-extract" })
          : categoryIDs,
        durability: typeof item.durability === "number" && Number.isFinite(item.durability) ? Math.max(0, Math.min(1, item.durability)) : 0,
        confidence: typeof item.confidence === "number" && Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : 0,
        changeRisk: typeof item.changeRisk === "number" && Number.isFinite(item.changeRisk) ? Math.max(0, Math.min(1, item.changeRisk)) : 1,
        recommendedDisposition: item.recommendedDisposition === "auto-apply" || item.recommendedDisposition === "skip" ? item.recommendedDisposition : "pending",
        reason: typeof item.reason === "string" && item.reason.trim() ? item.reason.trim().slice(0, 240) : null,
      }
    })
    .filter((item: ExtractedMemoryProposal) =>
      item.shouldRemember &&
      item.durability >= 0.8 &&
      item.confidence >= 0.75 &&
      item.changeRisk <= 0.25 &&
      (item.operation === "add" || Boolean(item.targetEntryID)),
    )
    .slice(0, limit)
}

function candidateUserText(text: string) {
  const match = text.match(/USER:\s*([\s\S]*?)(?:\n\nASSISTANT:|$)/i)
  return (match?.[1] ?? text).trim()
}

function fallbackExtractorProposal(input: ProposeMemoriesFromTextInput, existingFingerprints: string[]): ExtractedMemoryProposal[] {
  const userText = candidateUserText(input.text)
  const isRepoRule = /\b(para este repo|for this repo|in this repo|en este repo)\b/i.test(userText)
  const isFutureRule = /\b(cuando|siempre|nunca|de ahora en adelante|always|never|when)\b/i.test(userText)
  if (!isRepoRule || !isFutureRule) return []
  const text = userText
    .replace(/\bNo uses comandos de memoria;?\s*/i, "")
    .replace(/\bNo guardes memoria manualmente;?\s*/i, "")
    .replace(/\bDo not use memory commands;?\s*/i, "")
    .replace(/\bresponde solo:\s*entendido\.?/i, "")
    .replace(/\brespond only:\s*understood\.?/i, "")
    .replace(/\s+/g, " ")
    .trim()
  if (text.length < 16 || isNearDuplicate(text, existingFingerprints)) return []
  return [{
    shouldRemember: true,
    operation: "add",
    scope: input.scope === "global" ? "global" : "project",
    targetEntryID: null,
    targetEntryScope: null,
    text,
    tags: ["workflow", "auto"],
    categoryIDs: inferMemoryCategoryIDs({ text, tags: ["workflow", "auto"], source: input.source }),
    durability: 0.9,
    confidence: 0.8,
    changeRisk: 0.15,
    recommendedDisposition: "pending",
    reason: "Explicit repo-scoped future workflow rule.",
  }]
}

function generatedPolicyDecision(value: unknown): MemoryProposal["policyDecision"] {
  return value === "auto-applied" || value === "manual-only" || value === "disabled" ? value : "pending"
}

function graphLinkKindFromProposal(proposal: MemoryProposal): MemoryFactLink["kind"] {
  const tag = proposal.tags.find((item) => item.startsWith("graph-kind:"))?.slice("graph-kind:".length)
  return tag === "conflicts" || tag === "supersedes" || tag === "supports" ? tag : "related"
}

function graphLinkKeys(input: Pick<MemoryFactLink, "from" | "to" | "kind">) {
  const key = `${input.from}\u0000${input.to}\u0000${input.kind}`
  if (input.kind !== "related" && input.kind !== "conflicts") return [key]
  return [key, `${input.to}\u0000${input.from}\u0000${input.kind}`]
}

function generatedMemoryAutoApplySafety(input: {
  proposal: MemoryProposal
  minConfidence: number
  minDurability: number
  maxChangeRisk: number
  allowedCategories: string[]
  blockedSensitivity: Array<"medium" | "high">
}) {
  if (input.proposal.operation !== "add") return { ok: false, reason: "only add proposals can auto-apply" }
  if (input.proposal.targetEntryID || input.proposal.targetEntryIDs.length) return { ok: false, reason: "targeted memory changes require review" }
  if (input.proposal.redactions.length) return { ok: false, reason: "redacted memory requires review" }
  if (input.proposal.sensitivity !== "low" && input.blockedSensitivity.includes(input.proposal.sensitivity)) return { ok: false, reason: `${input.proposal.sensitivity} sensitivity requires review` }
  if (input.proposal.confidence < input.minConfidence) return { ok: false, reason: "confidence below auto-apply threshold" }
  if (input.proposal.durability < input.minDurability) return { ok: false, reason: "durability below auto-apply threshold" }
  if (input.proposal.changeRisk > input.maxChangeRisk) return { ok: false, reason: "change risk above auto-apply threshold" }
  if (input.allowedCategories.length && !input.proposal.categoryIDs.some((categoryID) => input.allowedCategories.includes(categoryID))) return { ok: false, reason: "category is not auto-apply allowed" }
  return { ok: true, reason: "safe to auto-apply" }
}

async function markProposalPolicyDecision(proposal: MemoryProposal, policyDecision: MemoryProposal["policyDecision"], root?: string) {
  const next = { ...proposal, policyDecision, updatedAt: new Date().toISOString() }
  await writeProposal(next, root)
  return next
}

export async function settleGeneratedMemoryProposal(input: {
  proposal: MemoryProposal
  policy: GeneratedMemoryWritePolicy
  recommendedDisposition?: GeneratedMemoryDisposition
  minConfidence: number
  minDurability: number
  maxChangeRisk: number
  allowedCategories: string[]
  blockedSensitivity: Array<"medium" | "high">
}, root?: string) {
  if (input.policy === "disabled") return { proposal: await markProposalPolicyDecision(input.proposal, "disabled", root), entry: null, autoApplied: false, reason: "memory write policy disabled" }
  if (input.policy === "model-decides" && input.recommendedDisposition === "skip") return { proposal: await markProposalPolicyDecision(input.proposal, "disabled", root), entry: null, autoApplied: false, reason: "model recommended skipping" }
  const wantsAutoApply = input.policy === "auto-safe" || (input.policy === "model-decides" && input.recommendedDisposition === "auto-apply")
  if (!wantsAutoApply) return { proposal: await markProposalPolicyDecision(input.proposal, "pending", root), entry: null, autoApplied: false, reason: "pending by write policy" }
  const safety = generatedMemoryAutoApplySafety(input)
  if (!safety.ok) return { proposal: await markProposalPolicyDecision(input.proposal, "manual-only", root), entry: null, autoApplied: false, reason: safety.reason }
  const marked = await markProposalPolicyDecision(input.proposal, "auto-applied", root)
  const applied = await applyMemoryProposal(marked.id, root, {
    connectRelated: true,
    relatedCategoryIDs: input.allowedCategories,
  })
  return { proposal: applied.proposal, entry: applied.entry, autoApplied: true, reason: safety.reason }
}

function memoryPolicyInput(config: MemoryConfig) {
  return {
    policy: config.memoryWritePolicy,
    minConfidence: config.memoryAutoApplyMinConfidence,
    minDurability: config.memoryAutoApplyMinDurability,
    maxChangeRisk: config.memoryAutoApplyMaxChangeRisk,
    allowedCategories: config.memoryAutoApplyAllowedCategories,
    blockedSensitivity: config.memoryAutoApplyBlockedSensitivity,
  }
}

export async function resolveMemoryExtractorRole(root?: string): Promise<MemoryExtractorRoleResult> {
  const paths = memoryPaths(root)
  const config = await readMemoryConfig(paths.root)
  if (!config.extractorRole || config.extractorRole === "none") {
    return { ok: false, reason: "memory extractor disabled" }
  }

  const resolved = await resolveModelRoles(paths.root)
  const role = resolved.roles[config.extractorRole]
  if (!resolved.enabled || !role?.configured || !role.providerID || !role.modelID) {
    return { ok: false, reason: `memory extractor role not configured: ${config.extractorRole}` }
  }
  return {
    ok: true,
    roleName: config.extractorRole,
    providerID: role.providerID,
    modelID: role.modelID,
    authMode: role.authMode || (role.providerID === "openai" ? "provider-oauth-or-token" : "api-key"),
  }
}

export async function readMemoryExtractorContext(root?: string) {
  const paths = memoryPaths(root)
  const [globalEntries, projectEntries, proposals] = await Promise.all([
    readMemoryEntries("global", paths.root).catch(() => []),
    readMemoryEntries("project", paths.root).catch(() => []),
    listMemoryProposals(paths.root, "all").catch(() => []),
  ])
  const saved = [...globalEntries, ...projectEntries]
  const pending = proposals.filter((proposal) => proposal.status === "pending")
  const historical = proposals.filter((proposal) => proposal.status !== "pending")
  const existing = [
    "<saved_memory>",
    ...saved.map((item) => `- [saved][${item.scope}][${item.id}] ${item.text}`),
    saved.length ? "" : "- none",
    "</saved_memory>",
    "",
    "<pending_memory>",
    ...pending.map((item) => `- [pending][${item.scope}][${item.id}][${item.operation ?? "add"}] ${item.text}`),
    pending.length ? "" : "- none",
    "</pending_memory>",
    "",
    "<historical_memory_proposals>",
    ...historical.map((item) => `- [${item.status}][${item.scope}][${item.id}][${item.operation ?? "add"}] ${item.text}`),
    historical.length ? "" : "- none",
    "</historical_memory_proposals>",
  ].join("\n")
  const existingItems = [...saved, ...proposals]
  const existingFingerprints = existingItems.map((item) => memoryFingerprint(item.text)).filter(Boolean)
  return { existing, existingFingerprints }
}

export function memoryExtractorCandidateMessage(input: ProposeMemoriesFromTextInput, existing: string) {
  return [
    "<memory_context>",
    existing || "- none",
    "</memory_context>",
    "",
    "<candidate_turn>",
    input.text,
    "</candidate_turn>",
  ].join("\n")
}

export async function proposeMemoriesFromExtractorText(
  input: ProposeMemoriesFromTextInput,
  outputText: string,
  root?: string,
  existingFingerprints?: string[],
) {
  const paths = memoryPaths(root)
  const config = await readMemoryConfig(paths.root)
  if (config.memoryWritePolicy === "disabled") return { proposals: [], candidates: 0, callsProviders: true as const, readsSecrets: false as const, writesMemory: false as const, skipped: true, reason: "memory write policy disabled" }
  const fingerprints = new Set(existingFingerprints ?? (await readMemoryExtractorContext(paths.root)).existingFingerprints)
  const extracted: ExtractedMemoryProposal[] = []
  const parsed = parseExtractorJSON(outputText || "", input.maxProposals ?? 2)
  const candidates = parsed.length ? parsed : fallbackExtractorProposal(input, [...fingerprints])
  let duplicateCandidates = 0
  for (const item of candidates) {
    if (item.operation === "add" && isNearDuplicate(item.text, [...fingerprints])) {
      duplicateCandidates++
      continue
    }
    extracted.push(item)
    fingerprints.add(memoryFingerprint(item.text))
  }
  const proposals: MemoryProposal[] = []
  let autoApplied = 0
  let skippedByPolicy = 0
  for (const item of extracted) {
    if (config.memoryWritePolicy === "model-decides" && item.recommendedDisposition === "skip") {
      skippedByPolicy++
      continue
    }
    const proposal = await proposeMemory({
      operation: item.operation,
      scope: item.scope,
      targetEntryID: item.targetEntryID,
      targetEntryScope: item.targetEntryScope,
      text: item.text,
      tags: [...normalizeStringList(input.tags), ...item.tags],
      categoryIDs: item.categoryIDs,
      cwd: input.cwd,
      files: input.files,
      source: input.source || "model-extract",
      evidence: input.evidence,
      confidence: item.confidence,
      durability: item.durability,
      changeRisk: item.changeRisk,
      reason: item.reason,
    }, paths.root)
    const settled = await settleGeneratedMemoryProposal({
      proposal,
      recommendedDisposition: item.recommendedDisposition,
      ...memoryPolicyInput(config),
    }, paths.root)
    if (settled.autoApplied) autoApplied++
    proposals.push(settled.proposal)
  }
  const reason = proposals.length
    ? null
    : duplicateCandidates > 0
      ? "memory candidates already match saved memory or earlier proposals"
      : skippedByPolicy > 0
        ? "memory write policy skipped candidates"
        : "no durable memory candidates"
  return { proposals, candidates: extracted.length, callsProviders: true as const, readsSecrets: false as const, writesMemory: autoApplied > 0, skipped: false, reason }
}

export async function proposeMemoriesWithExtractor(input: ProposeMemoriesFromTextInput, root?: string) {
  const paths = memoryPaths(root)
  const config = await readMemoryConfig(paths.root)
  if (config.memoryWritePolicy === "disabled") {
    return { proposals: [], candidates: 0, callsProviders: false as const, readsSecrets: false as const, writesMemory: false as const, skipped: true, reason: "memory write policy disabled" }
  }
  const role = await resolveMemoryExtractorRole(paths.root)
  if (!role.ok) {
    return { proposals: [], candidates: 0, callsProviders: false as const, readsSecrets: false as const, writesMemory: false as const, skipped: true, reason: role.reason }
  }

  const context = await readMemoryExtractorContext(paths.root)

  const result = await runProviderAdapter(paths.root, {
    providerID: role.providerID,
    modelID: role.modelID,
    authMode: role.authMode,
    instructions: extractorPrompt(),
    messages: [{
      role: "user",
      content: memoryExtractorCandidateMessage(input, context.existing),
    }],
  }).catch((error) => ({
    ok: false as const,
    status: 1,
    statusText: "memory extractor failed",
    errorPreview: memoryExtractorFailureReason(error),
    telemetry: { elapsedMs: null, usage: null, cost: null },
  }))
  if (!result.ok) {
    return { proposals: [], candidates: 0, callsProviders: true as const, readsSecrets: false as const, writesMemory: false as const, skipped: true, reason: memoryExtractorFailureReason(result.errorPreview || result.statusText) }
  }

  return proposeMemoriesFromExtractorText({
    ...input,
    source: input.source || `model-extract:${role.roleName}`,
  }, result.outputText || "", paths.root, context.existingFingerprints)
}

function transcriptFromMessages(messages: Array<{ role?: string; content?: unknown }>) {
  return messages
    .map((message) => {
      const role = typeof message.role === "string" ? message.role.toUpperCase() : "UNKNOWN"
      const content = typeof message.content === "string" ? message.content : ""
      return content.trim() ? `${role}: ${content}` : ""
    })
    .filter(Boolean)
    .join("\n\n")
}

export async function autoProposeMemoriesFromSession(session: any, root?: string): Promise<AutoMemoryResult> {
  const paths = memoryPaths(root)
  const config = await readMemoryConfig(paths.root)
  if (!config.enabled || !config.generate) {
    return { enabled: config.enabled, output: config.generate, skipped: true, reason: "memory output disabled", proposals: [], callsProviders: false, writesMemory: false }
  }
  const messages = Array.isArray(session?.messages) ? session.messages : []
  if (messages.length < 2) {
    return { enabled: config.enabled, output: config.generate, skipped: true, reason: "not enough session messages", proposals: [], callsProviders: false, writesMemory: false }
  }
  const evidence = `chat:${session.id || "unknown"}:messages:${messages.length}`
  const existing = await listMemoryProposals(paths.root, "all")
  if (existing.some((proposal) => proposal.evidence === evidence)) {
    return { enabled: config.enabled, output: config.generate, skipped: true, reason: "session already proposed", proposals: [], callsProviders: false, writesMemory: false }
  }
  const result = await proposeMemoriesWithExtractor({
    scope: "project",
    text: transcriptFromMessages(messages),
    tags: ["chat", "auto"],
    cwd: paths.root,
    source: "auto-chat-extract",
    evidence,
    maxProposals: 2,
  }, paths.root)
  return { enabled: config.enabled, output: config.generate, skipped: result.skipped ?? false, reason: result.reason ?? null, proposals: result.proposals, callsProviders: result.callsProviders, writesMemory: result.writesMemory }
}

async function walkMemoryFiles(dir: string, limit = 120): Promise<string[]> {
  const out: string[] = []
  async function walk(current: string) {
    if (out.length >= limit) return
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (out.length >= limit) break
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "rollout_summaries") continue
        await walk(file)
      } else if (/\.(md|txt|json|jsonl)$/i.test(entry.name)) {
        const info = await stat(file).catch(() => null)
        if (info && info.size > 0 && info.size <= 256_000) out.push(file)
      }
    }
  }
  await walk(dir)
  return out
}

export async function importCodexMemories(input: { codexMemoryDir?: string; apply?: boolean; maxProposals?: number } = {}, root?: string) {
  const paths = memoryPaths(root)
  const home = process.env.HOME || ""
  const codexMemoryDir = input.codexMemoryDir || path.join(home, ".codex", "memories")
  const maxProposals = Math.max(1, Math.min(50, input.maxProposals ?? 20))
  if (!existsSync(codexMemoryDir)) {
    return { codexMemoryDir, exists: false, apply: input.apply === true, candidates: [], proposals: [], callsProviders: false as const, writesMemory: false as const }
  }
  const files = await walkMemoryFiles(codexMemoryDir)
  const candidates: Array<{ file: string; text: string }> = []
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => "")
    if (text.trim()) candidates.push({ file: path.relative(codexMemoryDir, file), text: text.trim().slice(0, 12_000) })
    if (candidates.length >= maxProposals) break
  }
  const extracted = input.apply && candidates.length
    ? await proposeMemoriesWithExtractor({
      scope: "global",
      text: candidates.map((candidate) => `<file path="${candidate.file}">\n${candidate.text}\n</file>`).join("\n\n"),
      tags: ["codex-import"],
      cwd: paths.root,
      source: "codex-memory-import",
      evidence: codexMemoryDir,
      maxProposals,
    }, paths.root)
    : null
  return {
    codexMemoryDir,
    exists: true,
    apply: input.apply === true,
    candidates,
    proposals: extracted?.proposals ?? [],
    callsProviders: extracted?.callsProviders ?? false,
    skipped: extracted?.skipped ?? !input.apply,
    reason: extracted?.reason ?? (input.apply ? null : "preview only"),
    writesMemory: false as const,
  }
}

export async function listMemoryProposals(root?: string, status?: MemoryProposalStatus | "all") {
  const paths = memoryPaths(root)
  if (!existsSync(paths.proposalsDir)) return []
  const files = await readdir(paths.proposalsDir).catch(() => [])
  const proposals = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => readJson<MemoryProposal>(path.join(paths.proposalsDir, file)).catch(() => null)))
  return proposals
    .filter((proposal): proposal is MemoryProposal => Boolean(proposal?.id))
    .map(normalizeMemoryProposal)
    .filter((proposal) => !status || status === "all" || proposal.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function readMemoryProposal(id: string, root?: string) {
  if (!id) throw new Error("Missing memory proposal id")
  const file = proposalPath(root, id)
  if (!existsSync(file)) throw new Error(`Unknown memory proposal: ${id}`)
  return normalizeMemoryProposal(await readJson<MemoryProposal>(file))
}

export async function updateMemoryProposal(id: string, patch: Partial<Pick<MemoryProposal, "operation" | "scope" | "text" | "tags" | "categoryIDs" | "confidence" | "durability" | "changeRisk" | "reason" | "targetEntryID" | "targetEntryScope" | "targetEntryIDs">>, root?: string) {
  const proposal = await readMemoryProposal(id, root)
  if (proposal.status !== "pending") throw new Error(`Memory proposal ${id} is ${proposal.status}`)
  const scope = patch.scope === "global" ? "global" : patch.scope === "project" ? "project" : proposal.scope
  const tags = patch.tags ? normalizeStringList(patch.tags) : proposal.tags
  const redacted = redactMemoryText(typeof patch.text === "string" && patch.text.trim() ? patch.text.trim() : proposal.text)
  const targetEntryID = patch.targetEntryID !== undefined ? patch.targetEntryID : proposal.targetEntryID
  const targetEntryScope = patch.targetEntryScope !== undefined ? patch.targetEntryScope : proposal.targetEntryScope
  const targetEntryIDs = patch.targetEntryIDs !== undefined
    ? normalizeStringList(patch.targetEntryIDs)
    : targetEntryID
      ? [targetEntryID]
      : proposal.targetEntryIDs
  const next: MemoryProposal = {
    ...proposal,
    operation: patch.operation ?? proposal.operation,
    scope,
    text: redacted.text,
    tags,
    categoryIDs: patch.categoryIDs ? normalizeMemoryCategoryIDs(patch.categoryIDs) : proposal.categoryIDs,
    scopeReason: scopeReasonForMemory({ requestedScope: scope, text: redacted.text, tags }).reason,
    confidence: typeof patch.confidence === "number" && Number.isFinite(patch.confidence) ? Math.max(0, Math.min(1, patch.confidence)) : proposal.confidence,
    durability: typeof patch.durability === "number" && Number.isFinite(patch.durability) ? Math.max(0, Math.min(1, patch.durability)) : proposal.durability,
    changeRisk: typeof patch.changeRisk === "number" && Number.isFinite(patch.changeRisk) ? Math.max(0, Math.min(1, patch.changeRisk)) : proposal.changeRisk,
    reason: typeof patch.reason === "string" && patch.reason.trim() ? patch.reason.trim() : proposal.reason,
    sensitivity: sensitivityFor(redacted.redactions, redacted.text),
    redactions: redacted.redactions,
    targetEntryID,
    targetEntryScope,
    targetEntryIDs,
    updatedAt: new Date().toISOString(),
  }
  await writeProposal(next, root)
  return next
}

export async function resolveMemoryProposal(input: {
  id: string
  resolution: Exclude<MemoryProposalResolution, "pending" | "applied">
  reason: string
  supersededBy?: string | null
}, root?: string) {
  const proposal = await readMemoryProposal(input.id, root)
  if (proposal.status !== "pending") return proposal
  const resolvedAt = new Date().toISOString()
  return writeProposal({
    ...proposal,
    status: "rejected",
    resolution: input.resolution,
    resolutionReason: input.reason.trim() || null,
    resolvedAt,
    supersededBy: input.supersededBy ?? null,
    updatedAt: resolvedAt,
  }, root)
}

export async function archiveMemoryProposal(id: string, root?: string, reason = "Archived by Dream consolidation") {
  return resolveMemoryProposal({ id, resolution: "archived", reason }, root)
}

export async function supersedeMemoryProposal(id: string, supersededBy: string, root?: string, reason = "Superseded by Dream consolidation") {
  return resolveMemoryProposal({ id, resolution: "superseded", supersededBy, reason }, root)
}

export async function applyMemoryProposal(id: string, root?: string, input: ApplyMemoryProposalInput = {}): Promise<ApplyMemoryProposalResult> {
  const proposal = await readMemoryProposal(id, root)
  if (proposal.status !== "pending") throw new Error(`Memory proposal ${id} is ${proposal.status}`)
  const operation = proposal.operation ?? "add"
  let entry: MemoryEntry | null = null
  let dreamSchedule: DreamScheduleState | null = null
  let dreamService: DreamServicePlan | null = null
  const dreamScheduleProposal = proposal.tags.includes("dream-dry-run")
  const dreamServiceProposal = proposal.tags.includes("dream-service-start")
  const graphUpsertProposal = proposal.tags.includes("graph-upsert")
  const graphLinkProposal = proposal.tags.includes("graph-link")
  if (dreamScheduleProposal && dreamServiceProposal) throw new Error(`Dream proposal ${id} must split schedule and service activation into separate approvals`)
  if (graphUpsertProposal && graphLinkProposal) throw new Error(`Graph proposal ${id} must split fact and link changes into separate approvals`)
  const dreamControl = dreamScheduleProposal || dreamServiceProposal
  if (dreamScheduleProposal) {
    dreamSchedule = await configureDreamScheduleFromText(root, proposal.text)
  }
  if (dreamServiceProposal) {
    if (proposal.scope !== "global") throw new Error(`Dream service proposal ${id} must use global scope`)
    dreamService = await (input.startDreamService ?? dreamServiceStart)()
  }
  if (dreamControl) {
    const next: MemoryProposal = { ...proposal, operation, status: "applied", updatedAt: new Date().toISOString(), appliedEntryID: null }
    await writeProposal(next, root)
    return { proposal: next, entry, dreamSchedule, dreamService }
  }
  if (graphUpsertProposal) {
    const fact = await upsertMemoryFact({
      scope: proposal.scope,
      text: proposal.text,
      categoryIDs: proposal.categoryIDs,
      provenance: [proposal.evidence, ...proposal.evidenceRefs].filter((item): item is string => Boolean(item)),
      confidence: proposal.confidence,
      durability: proposal.durability,
      changeRisk: proposal.changeRisk,
      sensitivity: proposal.sensitivity,
    }, root)
    const next: MemoryProposal = { ...proposal, operation, status: "applied", updatedAt: new Date().toISOString(), appliedEntryID: fact.id }
    await writeProposal(next, root)
    return { proposal: next, entry, dreamSchedule, dreamService }
  }
  if (graphLinkProposal) {
    const [from, to] = proposal.targetEntryIDs
    if (!from || !to) throw new Error(`Graph link proposal ${id} requires two fact ids`)
    const factIDs = new Set((await readMemoryFacts(root)).map((fact) => fact.id))
    if (!factIDs.has(from) || !factIDs.has(to)) throw new Error(`Graph link proposal ${id} references missing fact ids`)
    const kind = graphLinkKindFromProposal(proposal)
    const keys = new Set(graphLinkKeys({ from, to, kind }))
    const graph = await readMemoryGraph(root)
    const existing = graph.links.find((link) => graphLinkKeys(link).some((key) => keys.has(key)))
    await (existing ? Promise.resolve(existing) : upsertMemoryFactLink({ from, to, kind }, root))
    const next: MemoryProposal = { ...proposal, operation, status: "applied", updatedAt: new Date().toISOString(), appliedEntryID: null }
    await writeProposal(next, root)
    return { proposal: next, entry, dreamSchedule, dreamService }
  }
  if (operation === "add") {
    entry = await appendMemoryEntry({
      scope: proposal.scope,
      text: proposal.text,
      tags: proposal.tags,
      categoryIDs: proposal.categoryIDs,
      cwd: proposal.cwd,
      files: proposal.files,
      source: proposal.source,
      evidence: proposal.evidence,
      confidence: proposal.confidence,
      sensitivity: proposal.sensitivity,
    }, root)
  } else if (operation === "update") {
    if (!proposal.targetEntryID) throw new Error(`Memory proposal ${id} is missing targetEntryID`)
    entry = await updateMemoryEntry(proposal.targetEntryScope ?? proposal.scope, proposal.targetEntryID, {
      text: proposal.text,
      tags: proposal.tags,
      categoryIDs: proposal.categoryIDs,
      cwd: proposal.cwd,
      files: proposal.files,
      source: proposal.source,
      evidence: proposal.evidence,
      confidence: proposal.confidence,
      sensitivity: proposal.sensitivity,
    }, root)
  } else if (operation === "remove" || operation === "expire") {
    if (!proposal.targetEntryID) throw new Error(`Memory proposal ${id} is missing targetEntryID`)
    await deleteMemoryEntry(proposal.targetEntryScope ?? proposal.scope, proposal.targetEntryID, root)
  } else if (operation === "verify" || operation === "recategorize") {
    if (!proposal.targetEntryID) throw new Error(`Memory proposal ${id} is missing targetEntryID`)
    entry = await updateMemoryEntry(proposal.targetEntryScope ?? proposal.scope, proposal.targetEntryID, {
      tags: proposal.tags,
      categoryIDs: proposal.categoryIDs,
      evidence: proposal.evidence,
      confidence: proposal.confidence,
    }, root)
  } else if (operation === "demote-scope" || operation === "promote-scope") {
    if (!proposal.targetEntryID) throw new Error(`Memory proposal ${id} is missing targetEntryID`)
    const fromScope = proposal.targetEntryScope ?? (operation === "demote-scope" ? "global" : "project")
    await deleteMemoryEntry(fromScope, proposal.targetEntryID, root)
    entry = await appendMemoryEntry({
      scope: operation === "demote-scope" ? "project" : "global",
      text: proposal.text,
      tags: proposal.tags,
      categoryIDs: proposal.categoryIDs,
      cwd: proposal.cwd,
      files: proposal.files,
      source: proposal.source,
      evidence: proposal.evidence,
      confidence: proposal.confidence,
      sensitivity: proposal.sensitivity,
    }, root)
  } else {
    if (!proposal.targetEntryID) throw new Error(`Memory proposal ${id} is missing targetEntryID`)
    entry = await updateMemoryEntry(proposal.targetEntryScope ?? proposal.scope, proposal.targetEntryID, {
      text: proposal.text,
      tags: proposal.tags,
      categoryIDs: proposal.categoryIDs,
      evidence: proposal.evidence,
      confidence: proposal.confidence,
    }, root)
  }
  if (entry) {
    const fact = await upsertMemoryFact({
      id: `legacy_${entry.id}`,
      legacyEntryID: entry.id,
      scope: legacyScopeForFact(entry.scope),
      ownerWorkspaceIDs: entry.scope === "project" && entry.cwd ? [entry.cwd] : [],
      categoryIDs: proposal.categoryIDs,
      text: entry.text,
      provenance: [proposal.evidence, ...proposal.evidenceRefs].filter((item): item is string => Boolean(item)),
      confidence: entry.confidence,
      durability: proposal.durability,
      changeRisk: proposal.changeRisk,
      sensitivity: entry.sensitivity,
      legacyMaterialized: true,
    }, root)
    if (input.connectRelated) await connectMemoryFactToRelatedFact(fact.id, root, input.relatedCategoryIDs)
  }
  const next: MemoryProposal = { ...proposal, operation, status: "applied", updatedAt: new Date().toISOString(), appliedEntryID: entry?.id ?? null }
  await writeProposal(next, root)
  return { proposal: next, entry, dreamSchedule, dreamService }
}

export async function rejectMemoryProposal(id: string, root?: string) {
  const proposal = await readMemoryProposal(id, root)
  if (proposal.status !== "pending") throw new Error(`Memory proposal ${id} is ${proposal.status}`)
  const resolvedAt = new Date().toISOString()
  const next: MemoryProposal = { ...proposal, status: "rejected", resolution: "rejected", resolutionReason: "Rejected by memory review", resolvedAt, updatedAt: resolvedAt }
  await writeProposal(next, root)
  return next
}
