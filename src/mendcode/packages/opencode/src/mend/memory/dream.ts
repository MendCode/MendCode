import { existsSync } from "fs"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { memoryPaths } from "./config"
import { readMemoryFacts } from "./graph"
import { collectDreamFileEvidence, type DreamEvidenceRef, type DreamSourcePermissions } from "./dream-sources"
import { publishMemoryDreamEvent } from "./dream-events"
import { listMemoryProposals, proposeMemory, type MemoryProposal } from "./proposals"

export type DreamRunStatus = "running" | "completed" | "failed" | "canceled" | "missed"

export type DreamRun = {
  id: string
  status: DreamRunStatus
  source: "manual" | "scheduled"
  role: "memoryDream"
  workspaceID: string | null
  groupID: string | null
  startedAt: string
  completedAt: string | null
  proposals: string[]
  failureReason: string | null
  permissionSnapshot: DreamSourcePermissions
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
}) => Promise<Array<{ text: string; reason?: string; confidence?: number; durability?: number; changeRisk?: number; categoryIDs?: string[] }>>

function nowID(prefix = "dream") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function dreamDir(root?: string) {
  return path.join(memoryPaths(root).projectDir, "dream")
}

function dreamRunDir(root: string | undefined, id: string) {
  return path.join(dreamDir(root), "runs", id)
}

async function appendJsonl(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  const previous = existsSync(file) ? await readFile(file, "utf8").catch(() => "") : ""
  await writeFile(file, `${previous}${JSON.stringify(value)}\n`)
}

async function writeRun(root: string | undefined, run: DreamRun) {
  const dir = dreamRunDir(root, run.id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`)
  return run
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
    .then((text) => JSON.parse(text) as DreamRun)
    .catch(() => null)))
  return runs.filter((run): run is DreamRun => Boolean(run?.id)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
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
} = {}) {
  const root = input.root
  const id = nowID()
  const startedAt = new Date().toISOString()
  let run: DreamRun = {
    id,
    status: "running",
    source: input.source ?? "manual",
    role: "memoryDream",
    workspaceID: input.workspaceID ?? null,
    groupID: input.groupID ?? null,
    startedAt,
    completedAt: null,
    proposals: [],
    failureReason: null,
    permissionSnapshot: input.permissions ?? {},
  }
  await writeRun(root, run)
  await appendJsonl(path.join(dreamRunDir(root, id), "events.jsonl"), { at: startedAt, status: "started", message: "Dream started" } satisfies DreamRunEvent)
  publishMemoryDreamEvent({ root: memoryPaths(root).root, runID: id, status: "started", message: "Dream started" })

  try {
    const [facts, proposals, files] = await Promise.all([
      readMemoryFacts(root),
      listMemoryProposals(root, "all"),
      collectDreamFileEvidence(input.permissions ?? {}),
    ])
    const evidence: DreamEvidenceRef[] = [
      ...facts.slice(0, 80).map((fact) => ({
        id: `memory:${fact.id}`,
        sourceType: "memory" as const,
        sourcePath: null,
        excerpt: fact.normalizedSummary,
        hash: fact.id,
        redacted: false,
      })),
      ...proposals.slice(0, 80).map((proposal) => ({
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
    const model = input.model ?? (async () => [])
    const candidates = await model({ facts, proposals, evidence })
    const created: MemoryProposal[] = []
    for (const candidate of candidates) {
      created.push(await proposeMemory({
        scope: "project",
        text: candidate.text,
        tags: ["dream", ...(candidate.categoryIDs ?? [])],
        source: "memory-dream",
        evidence: `dream:${id}`,
        confidence: candidate.confidence ?? 0.8,
        durability: candidate.durability ?? 0.85,
        changeRisk: candidate.changeRisk ?? 0.15,
        reason: candidate.reason ?? "Dream proposed memory maintenance.",
      }, root))
    }
    await writeFile(path.join(dir, "proposals.json"), `${JSON.stringify(created.map((proposal) => ({ id: proposal.id, operation: proposal.operation, scope: proposal.scope, text: proposal.text })), null, 2)}\n`)
    run = { ...run, status: "completed", completedAt: new Date().toISOString(), proposals: created.map((proposal) => proposal.id) }
    await writeRun(root, run)
    await appendJsonl(path.join(dir, "events.jsonl"), { at: run.completedAt, status: "completed", message: `Dream completed with ${created.length} proposals` } satisfies DreamRunEvent)
    publishMemoryDreamEvent({ root: memoryPaths(root).root, runID: id, status: "completed", message: `Dream completed with ${created.length} proposals`, proposalCount: created.length })
    return run
  } catch (error) {
    run = { ...run, status: "failed", completedAt: new Date().toISOString(), failureReason: error instanceof Error ? error.message : String(error) }
    await writeRun(root, run)
    await appendJsonl(path.join(dreamRunDir(root, id), "events.jsonl"), { at: run.completedAt, status: "failed", message: run.failureReason ?? "Dream failed" } satisfies DreamRunEvent)
    publishMemoryDreamEvent({ root: memoryPaths(root).root, runID: id, status: "failed", message: run.failureReason ?? "Dream failed" })
    await writeSafety(root, id, { evidence: [], skipped: [], failures: [run.failureReason ?? "Dream failed"] })
    return run
  }
}
