import { existsSync } from "fs"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { memoryPaths, type MemoryScope } from "./config"
import { readMemoryFacts } from "./graph"
import { collectDreamFileEvidence, type DreamEvidenceRef, type DreamSourcePermissions } from "./dream-sources"
import { publishMemoryDreamEvent } from "./dream-events"
import { listMemoryProposals, proposeMemory, type MemoryProposal } from "./proposals"

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

export type DreamRunDetail = {
  run: DreamRun
  events: DreamRunEvent[]
  evidence: DreamEvidenceRef[]
  proposals: DreamRunProposalSummary[]
  safety: DreamRunSafety | null
}

export type DreamRunEvent = {
  at: string
  status: DreamRunStatus | "started" | "progress"
  message: string
}

export type DreamModelAdapter = (input: {
  facts: Awaited<ReturnType<typeof readMemoryFacts>>
  proposals: Awaited<ReturnType<typeof listMemoryProposals>>
  evidence: DreamEvidenceRef[]
}) => Promise<Array<{ text: string; reason?: string; confidence?: number; durability?: number; changeRisk?: number; categoryIDs?: string[]; scope?: MemoryScope; evidenceRefs?: string[] }>>

function nowID(prefix = "dream") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function dreamDir(root?: string) {
  return path.join(memoryPaths(root).globalDir, "dream")
}

function dreamRunDir(root: string | undefined, id: string) {
  return path.join(dreamDir(root), "runs", id)
}

function normalizeDreamRun(input: DreamRun): DreamRun {
  return {
    ...input,
    projectRoot: typeof input.projectRoot === "string" && input.projectRoot.trim() ? input.projectRoot : null,
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
}) {
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
  const [events, evidence, proposals, safety] = await Promise.all([
    readJsonlIfExists<DreamRunEvent>(path.join(dir, "events.jsonl")),
    readJsonlIfExists<DreamEvidenceRef>(path.join(dir, "evidence.jsonl")),
    readJsonIfExists<DreamRunProposalSummary[]>(path.join(dir, "proposals.json")).catch(() => null),
    readJsonIfExists<DreamRunSafety>(path.join(dir, "safety.json")).catch(() => null),
  ])
  return { run, events, evidence, proposals: proposals ?? [], safety }
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
  const created: MemoryProposal[] = []
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
  }
  await writeRun(root, run)
  await appendJsonl(path.join(dreamRunDir(root, id), "events.jsonl"), { at: startedAt, status: "started", message: "Dream started" } satisfies DreamRunEvent)
  publishMemoryDreamEvent({ root: memoryPaths(root).root, runID: id, status: "started", message: "Dream started" })

  try {
    let [allFacts, allProposals, files] = await Promise.all([
      readMemoryFacts(root),
      listMemoryProposals(root, "all"),
      collectDreamFileEvidence(permissions),
    ])
    const facts = allFacts.slice(0, DREAM_FACT_CONTEXT_LIMIT)
    const proposals = allProposals.slice(0, DREAM_PROPOSAL_CONTEXT_LIMIT)
    allFacts = []
    allProposals = []
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
    await writeSafety(root, id, { evidence, skipped: files.skipped, failures: [] })
    const model = input.model ?? defaultDreamCandidates
    const candidates = await model({ facts, proposals, evidence })
    for (const candidate of candidates.slice(0, 5)) {
      created.push(await proposeMemory({
        scope: candidate.scope ?? "project",
        text: candidate.text,
        tags: ["dream", ...(candidate.categoryIDs ?? [])],
        source: "memory-dream",
        evidence: `dream:${id}`,
        evidenceRefs: [`dream:${id}`, ...(candidate.evidenceRefs ?? [])],
        confidence: candidate.confidence ?? 0.8,
        durability: candidate.durability ?? 0.85,
        changeRisk: candidate.changeRisk ?? 0.15,
        reason: candidate.reason ?? "Dream proposed memory maintenance.",
      }, root))
    }
    await writeRunProposals(root, id, created)
    const completedAt = new Date().toISOString()
    run = { ...run, status: "completed", completedAt, proposals: created.map((proposal) => proposal.id) }
    await writeRun(root, run)
    await appendJsonl(path.join(dir, "events.jsonl"), { at: completedAt, status: "completed", message: `Dream completed with ${created.length} proposals` } satisfies DreamRunEvent)
    publishMemoryDreamEvent({ root: memoryPaths(root).root, runID: id, status: "completed", message: `Dream completed with ${created.length} proposals`, proposalCount: created.length })
    return run
  } catch (error) {
    const completedAt = new Date().toISOString()
    run = { ...run, status: "failed", completedAt, failureReason: error instanceof Error ? error.message : String(error), proposals: created.map((proposal) => proposal.id) }
    await writeRun(root, run)
    await writeRunProposals(root, id, created)
    await appendJsonl(path.join(dreamRunDir(root, id), "events.jsonl"), { at: completedAt, status: "failed", message: run.failureReason ?? "Dream failed" } satisfies DreamRunEvent)
    publishMemoryDreamEvent({ root: memoryPaths(root).root, runID: id, status: "failed", message: run.failureReason ?? "Dream failed" })
    await writeSafety(root, id, { evidence: [], skipped: [], failures: [run.failureReason ?? "Dream failed"] })
    return run
  }
}
