import { existsSync } from "fs"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { memoryPaths, readMemoryConfig, type MemoryConfig, type MemoryDreamWritePolicy, type MemoryScope } from "./config"
import { readMemoryFacts, readMemoryGraph, upsertMemoryFactLink, type MemoryFact, type MemoryFactLink } from "./graph"
import { collectDreamFileEvidence, type DreamEvidenceRef, type DreamSourcePermissions } from "./dream-sources"
import { publishMemoryDreamEvent } from "./dream-events"
import { listMemoryProposals, proposeMemory, redactMemoryText, settleGeneratedMemoryProposal, type MemoryProposal } from "./proposals"

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

export type DreamModelAdapter = (input: {
  facts: Awaited<ReturnType<typeof readMemoryFacts>>
  proposals: Awaited<ReturnType<typeof listMemoryProposals>>
  evidence: DreamEvidenceRef[]
}) => Promise<DreamCandidate[]>

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

function existingGraphLinkKeys(links: MemoryFactLink[]) {
  return new Set(links.flatMap(graphLinkKeys))
}

function graphLinkKeys(input: Pick<MemoryFactLink, "from" | "to" | "kind">) {
  const key = `${input.from}\u0000${input.to}\u0000${input.kind}`
  if (input.kind !== "related" && input.kind !== "conflicts") return [key]
  return [key, `${input.to}\u0000${input.from}\u0000${input.kind}`]
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
  now?: Date
}) {
  const existing = existingGraphLinkKeys(input.links)
  const evidenceIDs = new Set(input.evidence.map((item) => item.id))
  const facts = input.facts
    .filter((fact) => fact.sensitivity === "low" && !fact.stale)
    .toSorted((a, b) => b.confidence - a.confidence || b.durability - a.durability || a.retrievalPriority - b.retrievalPriority || a.id.localeCompare(b.id))
    .slice(0, 18)
  const connected = new Set(input.links.flatMap((link) => [link.from, link.to]))
  const candidates = facts.flatMap((from, index) => facts.slice(index + 1).flatMap((to) => {
    const shared = sharedCategoryIDs(from, to)
    if (!shared.length) return []
    const kind: MemoryFactLink["kind"] = "related"
    const key = `${from.id}\u0000${to.id}\u0000${kind}`
    if (existing.has(key)) return []
    return [{ from, to, shared, kind, key }]
  }))
  const proposals: DreamGraphProposal[] = []
  while (candidates.length && proposals.length < 8) {
    candidates.sort((a, b) => {
      const isolatedA = Number(!connected.has(a.from.id)) + Number(!connected.has(a.to.id))
      const isolatedB = Number(!connected.has(b.from.id)) + Number(!connected.has(b.to.id))
      return isolatedB - isolatedA
        || ((b.from.confidence + b.to.confidence) - (a.from.confidence + a.to.confidence))
        || b.shared.length - a.shared.length
        || a.key.localeCompare(b.key)
    })
    const candidate = candidates.shift()!
    proposals.push({
      id: nowID("dreamlink"),
      from: candidate.from.id,
      to: candidate.to.id,
      kind: candidate.kind,
      status: "pending",
      confidence: Math.min(0.82, Math.max(0.5, ((candidate.from.confidence + candidate.to.confidence) / 2) - 0.08 + Math.min(0.1, candidate.shared.length * 0.03))),
      reason: `Shared memory category: ${candidate.shared.slice(0, 3).join(", ")}`,
      evidenceRefs: [...candidate.from.provenance, ...candidate.to.provenance]
        .filter((ref) => evidenceIDs.has(ref) || ref.startsWith("dream:") || ref.startsWith("file:"))
        .slice(0, 4),
      fromSummary: candidate.from.normalizedSummary,
      toSummary: candidate.to.normalizedSummary,
      createdAt: (input.now ?? new Date()).toISOString(),
    })
    connected.add(candidate.from.id)
    connected.add(candidate.to.id)
  }
  return proposals
}

function dreamGraphProposalAutoApplySafety(input: {
  proposal: DreamGraphProposal
  facts: MemoryFact[]
  config: MemoryConfig
}) {
  if (input.config.dreamWritePolicy !== "auto-safe") return false
  const factByID = new Map(input.facts.map((fact) => [fact.id, fact]))
  const facts = [factByID.get(input.proposal.from), factByID.get(input.proposal.to)]
  if (facts.some((fact) => !fact || fact.stale)) return false
  const endpoints = facts.filter((fact): fact is MemoryFact => Boolean(fact))
  if (endpoints.some((fact) => fact.sensitivity !== "low" && input.config.dreamAutoApplyBlockedSensitivity.includes(fact.sensitivity))) return false
  if (endpoints.some((fact) => fact.confidence < input.config.dreamAutoApplyMinConfidence)) return false
  if (endpoints.some((fact) => fact.durability < input.config.dreamAutoApplyMinDurability)) return false
  if (endpoints.some((fact) => fact.changeRisk > input.config.dreamAutoApplyMaxChangeRisk)) return false
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
  await writeFile(path.join(dir, "proposals.json"), `${JSON.stringify(proposals.map((proposal) => ({ id: proposal.id, operation: proposal.operation, scope: proposal.scope, text: proposal.text })), null, 2)}\n`)
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
  const [events, evidence, proposals, graphProposals, decisions, safety] = await Promise.all([
    readJsonlIfExists<DreamRunEvent>(path.join(dir, "events.jsonl")),
    readJsonlIfExists<DreamEvidenceRef>(path.join(dir, "evidence.jsonl")),
    readJsonIfExists<DreamRunProposalSummary[]>(path.join(dir, "proposals.json")).catch(() => null),
    readJsonIfExists<StoredDreamGraphProposal[]>(path.join(dir, "graph-proposals.json")).catch(() => null),
    readJsonIfExists<DreamRunDecision[]>(path.join(dir, "decisions.json")).catch(() => null),
    readJsonIfExists<DreamRunSafety>(path.join(dir, "safety.json")).catch(() => null),
  ])
  return { run, events, evidence, proposals: proposals ?? [], graphProposals: (graphProposals ?? []).map(normalizeDreamGraphProposal), decisions: decisions ?? [], safety }
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

export async function readDreamRunDetails(root?: string, limit = 8) {
  const runs = await readDreamRuns(root)
  const details = await Promise.all(runs.slice(0, Math.max(0, limit)).map((run) => readDreamRunDetail(root, run.id, run)))
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
  now?: Date
} = {}) {
  const root = input.root
  const id = nowID()
  const startedAt = (input.now ?? new Date()).toISOString()
  const permissions = normalizeDreamPermissions(root, input.permissions)
  const config = await readMemoryConfig(root)
  const created: MemoryProposal[] = []
  const decisions: DreamRunDecision[] = []
  let graphProposals: DreamGraphProposal[] = []
  let safetyInput: { evidence: DreamEvidenceRef[]; skipped: string[]; failures: string[] } = { evidence: [], skipped: [], failures: [] }
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
    const [allFacts, graph, allProposals, files] = await Promise.all([
      readMemoryFacts(root),
      readMemoryGraph(root),
      listMemoryProposals(root, "all"),
      collectDreamFileEvidence(permissions),
    ])
    const facts = allFacts.slice(0, DREAM_FACT_CONTEXT_LIMIT)
    const graphFacts = graph.facts.slice(0, DREAM_FACT_CONTEXT_LIMIT)
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
    const model = input.model ?? defaultDreamCandidates
    const candidates = await model({ facts, proposals, evidence })
    graphProposals = inferDreamGraphProposals({ facts: graphFacts, links: graph.links, evidence, now: input.now })
    await writeRunGraphProposals(root, id, graphProposals)
    let autoAppliedGraphLinks = 0
    if (config.dreamWritePolicy === "auto-safe") {
      for (const proposal of graphProposals) {
        if (!dreamGraphProposalAutoApplySafety({ proposal, facts: graphFacts, config })) continue
        await applyDreamGraphProposal(id, proposal.id, root)
        autoAppliedGraphLinks++
      }
      if (autoAppliedGraphLinks) {
        graphProposals = (await readDreamRunDetail(root, id))?.graphProposals ?? graphProposals
      }
    }
    if (graphProposals.length) {
      const pendingGraphLinks = graphProposals.length - autoAppliedGraphLinks
      const message = `Dream proposed ${graphProposals.length} graph links: ${autoAppliedGraphLinks} auto-applied, ${pendingGraphLinks} pending review`
      await appendJsonl(path.join(dir, "events.jsonl"), { at: new Date().toISOString(), status: "progress", message } satisfies DreamRunEvent)
      publishMemoryDreamEvent({ root: memoryPaths(root).root, runID: id, status: "progress", message })
    }
    const priorCandidates: Array<{ id: string; text: string }> = []
    for (const candidate of candidates.slice(0, 5)) {
      const scope = candidate.scope ?? "project"
      const categoryIDs = candidate.categoryIDs ?? []
      const evidenceRefs = [`dream:${id}`, ...(candidate.evidenceRefs ?? [])]
      const candidateText = redactMemoryText(candidate.text).text
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
    await writeRunProposals(root, id, created)
    await writeRunDecisions(root, id, decisions)
    const completedAt = new Date().toISOString()
    run = { ...run, status: "completed", completedAt, proposals: created.map((proposal) => proposal.id) }
    await writeRun(root, run)
    const skipped = decisions.filter((decision) => decision.status === "skipped-duplicate" || decision.status === "skipped-policy").length
    const autoApplied = decisions.filter((decision) => decision.status === "auto-applied-proposal").length
    await appendJsonl(path.join(dir, "events.jsonl"), { at: completedAt, status: "completed", message: `Dream completed with ${created.length} proposals, ${autoApplied} auto-applied, ${skipped} skipped, policy ${config.dreamWritePolicy}` } satisfies DreamRunEvent)
    publishMemoryDreamEvent({ root: memoryPaths(root).root, runID: id, status: "completed", message: `Dream completed with ${created.length} proposals, ${autoApplied} auto-applied, ${skipped} skipped, policy ${config.dreamWritePolicy}`, proposalCount: created.length })
    return run
  } catch (error) {
    const completedAt = new Date().toISOString()
    run = { ...run, status: "failed", completedAt, failureReason: error instanceof Error ? error.message : String(error), proposals: created.map((proposal) => proposal.id) }
    await writeRun(root, run)
    await writeRunProposals(root, id, created)
    await writeRunDecisions(root, id, decisions)
    await writeRunGraphProposals(root, id, graphProposals)
    await appendJsonl(path.join(dreamRunDir(root, id), "events.jsonl"), { at: completedAt, status: "failed", message: run.failureReason ?? "Dream failed" } satisfies DreamRunEvent)
    publishMemoryDreamEvent({ root: memoryPaths(root).root, runID: id, status: "failed", message: run.failureReason ?? "Dream failed" })
    safetyInput = { ...safetyInput, failures: [run.failureReason ?? "Dream failed"] }
    await writeSafety(root, id, safetyInput)
    return run
  }
}
