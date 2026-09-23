import { existsSync } from "fs"
import { appendFile, mkdir, readFile, readdir, writeFile, rename } from "fs/promises"
import { Flock } from "@mendcode/core/util/flock"
import { createHash, randomUUID } from "crypto"
import path from "path"
import { memoryPaths, readMemoryConfig, type MemoryScope } from "./config"
import { inferMemoryCategoryIDs } from "./categories"
import { readMemoryExtractionQueue, type MemoryExtractionState } from "./extraction-queue"

export type MemorySensitivity = "low" | "medium" | "high"

export type MemoryEntry = {
  id: string
  scope: MemoryScope
  text: string
  tags: string[]
  categoryIDs: string[]
  cwd: string | null
  files: string[]
  providerID: string | null
  modelID: string | null
  focusID: string | null
  source: string
  evidence: string | null
  confidence: number
  sensitivity: MemorySensitivity
  createdAt: string
  updatedAt: string
}

export type ArchivedMemoryEntry = MemoryEntry & {
  archivedAt: string
  archiveReason: string
  canonicalEntryID: string | null
}

export type MemoryStatus = {
  enabled: boolean
  configScope: "global" | "project"
  use: boolean
  generate: boolean
  input: boolean
  output: boolean
  promptModeIndependent: true
  scopes: MemoryScope[]
  maxPromptTokens: number
  maxEntries: number
  projectMaxEntries: number
  globalCompactionMaxEntries: number
  extractorRole: string
  consolidatorRole: string
  memoryDreamRole: string
  dreamConsolidationPolicy: string
  memoryAssistantRole: string
  paths: Record<string, string>
  summaries: Record<MemoryScope, { exists: boolean; bytes: number }>
  entries: Record<MemoryScope, { exists: boolean; count: number }>
  proposals: { exists: boolean; pending: number; applied: number; rejected: number }
  extraction: Record<MemoryExtractionState, number>
  callsProviders: false
  retrievalCallsProviders: false
  outputCallsProviders: boolean
  readsSecrets: false
  printsSecrets: false
}

const memoryWriteTails = new Map<string, Promise<void>>()

function serializeMemoryWrite<T>(file: string, operation: () => Promise<T>) {
  const previous = memoryWriteTails.get(file) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(() => Flock.withLock(
    `memory:${path.resolve(file)}`, operation,
    { dir: path.join(path.dirname(file), ".locks"), timeoutMs: 5_000 },
  ))
  const tail = next.then(() => {}, () => {})
  memoryWriteTails.set(file, tail)
  return next.finally(() => {
    if (memoryWriteTails.get(file) === tail) memoryWriteTails.delete(file)
  })
}

function nowID() {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
}

export function normalizeMemoryEntry(input: Partial<MemoryEntry> & { text: string; scope?: MemoryScope }): MemoryEntry {
  const now = new Date().toISOString()
  return {
    id: input.id || nowID(),
    scope: input.scope === "global" ? "global" : "project",
    text: input.text.trim(),
    tags: normalizeStringList(input.tags),
    categoryIDs: normalizeStringList((input as Partial<MemoryEntry>).categoryIDs).length
      ? normalizeStringList((input as Partial<MemoryEntry>).categoryIDs)
      : inferMemoryCategoryIDs({ text: input.text, tags: input.tags, source: input.source }),
    cwd: typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : null,
    files: normalizeStringList(input.files),
    providerID: typeof input.providerID === "string" && input.providerID.trim() ? input.providerID : null,
    modelID: typeof input.modelID === "string" && input.modelID.trim() ? input.modelID : null,
    focusID: typeof input.focusID === "string" && input.focusID.trim() ? input.focusID : null,
    source: typeof input.source === "string" && input.source.trim() ? input.source : "manual",
    evidence: typeof input.evidence === "string" && input.evidence.trim() ? input.evidence : null,
    confidence: typeof input.confidence === "number" && Number.isFinite(input.confidence) ? Math.max(0, Math.min(1, input.confidence)) : 0.7,
    sensitivity: input.sensitivity === "high" || input.sensitivity === "medium" ? input.sensitivity : "low",
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  }
}

function lineToEntry(line: string): MemoryEntry | null {
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed.text !== "string" || !parsed.text.trim()) return null
    return normalizeMemoryEntry(parsed)
  } catch {
    return null
  }
}

function lineToArchivedEntry(line: string): ArchivedMemoryEntry | null {
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed.text !== "string" || !parsed.text.trim()) return null
    if (typeof parsed.archivedAt !== "string" || !parsed.archivedAt.trim()) return null
    if (typeof parsed.archiveReason !== "string" || !parsed.archiveReason.trim()) return null
    return {
      ...normalizeMemoryEntry(parsed),
      archivedAt: parsed.archivedAt,
      archiveReason: parsed.archiveReason,
      canonicalEntryID: typeof parsed.canonicalEntryID === "string" && parsed.canonicalEntryID.trim() ? parsed.canonicalEntryID : null,
    }
  } catch {
    return null
  }
}

async function readTextIfExists(file: string) {
  if (!existsSync(file)) return ""
  return readFile(file, "utf8")
}

export async function readMemoryEntries(scope: MemoryScope, root?: string) {
  const paths = memoryPaths(root)
  const file = scope === "global" ? paths.globalEntries : paths.projectEntries
  const text = await readTextIfExists(file)
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map(lineToEntry).filter((entry): entry is MemoryEntry => Boolean(entry))
}

export async function readArchivedMemoryEntries(scope: MemoryScope, root?: string) {
  const paths = memoryPaths(root)
  const file = path.join(scope === "global" ? paths.globalDir : paths.projectDir, "archived.jsonl")
  const text = await readTextIfExists(file)
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map(lineToArchivedEntry).filter((entry): entry is ArchivedMemoryEntry => Boolean(entry))
}

export async function readMemorySummary(scope: MemoryScope, root?: string) {
  const paths = memoryPaths(root)
  const file = scope === "global" ? paths.globalSummary : paths.projectSummary
  return readTextIfExists(file)
}

export async function appendMemoryEntry(input: Partial<MemoryEntry> & { text: string; scope?: MemoryScope }, root?: string, options: { requireEmpty?: boolean } = {}) {
  const paths = memoryPaths(root)
  const entry = normalizeMemoryEntry(input)
  const file = entry.scope === "global" ? paths.globalEntries : paths.projectEntries
  return serializeMemoryWrite(file, async () => {
    if (options.requireEmpty && (await readMemoryEntries(entry.scope, root)).some((item) => item.id !== entry.id)) throw new Error("Auto-safe requires empty project memory; review the possible conflict")
    if (entry.source === "evolution") {
      const existing = (await readMemoryEntries(entry.scope, root)).find((item) => item.id === entry.id)
      if (existing) {
        if (existing.source !== entry.source || existing.text !== entry.text || existing.evidence !== entry.evidence) throw new Error(`Memory revision conflict: ${entry.id}`)
        return existing
      }
      if ((await readArchivedMemoryEntries(entry.scope, root)).some((item) => item.id === entry.id)) throw new Error("Retired Evolution memory cannot be reapplied")
    }
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify(entry)}\n`)
    await refreshMemoryIndex(root)
    return entry
  })
}

async function writeMemoryEntriesUnlocked(scope: MemoryScope, entries: MemoryEntry[], root?: string) {
  const paths = memoryPaths(root)
  const file = scope === "global" ? paths.globalEntries : paths.projectEntries
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""), { mode: 0o600 })
  await rename(temporary, file)
  await refreshMemoryIndex(root)
}

async function writeMemoryEntries(scope: MemoryScope, entries: MemoryEntry[], root?: string) {
  const file = scope === "global" ? memoryPaths(root).globalEntries : memoryPaths(root).projectEntries
  return serializeMemoryWrite(file, () => writeMemoryEntriesUnlocked(scope, entries, root))
}

export async function archiveMemoryEntries(
  scope: MemoryScope,
  selections: Array<{ id: string; reason: string; canonicalEntryID?: string | null; expectedRevision?: string }>,
  root?: string,
) {
  const paths = memoryPaths(root)
  const archiveFile = path.join(scope === "global" ? paths.globalDir : paths.projectDir, "archived.jsonl")
  return serializeMemoryWrite(scope === "global" ? paths.globalEntries : paths.projectEntries, async () => {
    const entries = await readMemoryEntries(scope, root)
    const requested = new Map(selections.filter((selection) => selection.id && selection.reason.trim()).map((selection) => [selection.id, selection]))
    const archived = entries.filter((entry) => requested.has(entry.id))
    for (const entry of archived) {
      const expected = requested.get(entry.id)!.expectedRevision
      if (expected && memoryEntryRevision(entry) !== expected) throw new Error(`Memory revision conflict: ${entry.id}; review before archiving`)
    }
    if (!archived.length) return { archived: [], skipped: selections.map((selection) => selection.id) }
    const existingArchived = await readArchivedMemoryEntries(scope, root)
    for (const entry of archived) {
      if (!requested.get(entry.id)?.expectedRevision) continue
      const prior = existingArchived.find((item) => item.id === entry.id)
      if (prior) {
        const { archivedAt: _at, archiveReason: _reason, canonicalEntryID: _canonical, ...original } = prior
        if (memoryEntryRevision(original) !== memoryEntryRevision(entry)) throw new Error(`Memory archive conflict: ${entry.id}`)
      }
    }
    const archivedIDs = new Set(existingArchived.map((entry) => entry.id))
    const archivedAt = new Date().toISOString()
    const records = archived
      .filter((entry) => !archivedIDs.has(entry.id))
      .map((entry) => ({ ...entry, archivedAt, archiveReason: requested.get(entry.id)!.reason.trim(), canonicalEntryID: requested.get(entry.id)!.canonicalEntryID ?? null } satisfies ArchivedMemoryEntry))
    if (records.length) {
      await mkdir(path.dirname(archiveFile), { recursive: true })
      const previous = await readTextIfExists(archiveFile)
      const temporary = `${archiveFile}.${randomUUID()}.tmp`
      await writeFile(temporary, `${previous}${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 })
      await rename(temporary, archiveFile)
    }
    await writeMemoryEntriesUnlocked(scope, entries.filter((entry) => !requested.has(entry.id)), root)
    return { archived: records, skipped: selections.filter((selection) => !records.some((entry) => entry.id === selection.id)).map((selection) => selection.id) }
  })
}

export async function restoreArchivedMemoryEntries(scope: MemoryScope, ids: string[], root?: string) {
  const paths = memoryPaths(root)
  return serializeMemoryWrite(scope === "global" ? paths.globalEntries : paths.projectEntries, async () => {
  const active = await readMemoryEntries(scope, root)
  const activeIDs = new Set(active.map((entry) => entry.id))
  const archived = await readArchivedMemoryEntries(scope, root)
  const restored = archived.filter((entry) => ids.includes(entry.id) && !activeIDs.has(entry.id))
  if (!restored.length) return { restored: [] }
  await writeMemoryEntriesUnlocked(scope, [...active, ...restored.map(({ archivedAt: _archivedAt, archiveReason: _archiveReason, canonicalEntryID: _canonicalEntryID, ...entry }) => entry)], root)
  return { restored }
  })
}

export function memoryEntryRevision(entry: MemoryEntry) {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex")
}

export async function updateMemoryEntry(scope: MemoryScope, id: string, patch: Partial<MemoryEntry>, root?: string, expectedRevision?: string) {
  const paths = memoryPaths(root)
  return serializeMemoryWrite(scope === "global" ? paths.globalEntries : paths.projectEntries, async () => {
  const entries = await readMemoryEntries(scope, root)
  const index = entries.findIndex((entry) => entry.id === id)
  if (index === -1) throw new Error(`Unknown ${scope} memory entry: ${id}`)
  const current = entries[index]!
  if (expectedRevision && memoryEntryRevision(current) !== expectedRevision) {
    throw new Error(`Memory revision conflict: ${id}; review the current entry before applying this update`)
  }
  const next = normalizeMemoryEntry({
    ...current,
    ...patch,
    id: current.id,
    scope,
    text: typeof patch.text === "string" ? patch.text : current.text,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  })
  entries[index] = next
  await writeMemoryEntriesUnlocked(scope, entries, root)
  return next
  })
}

export async function deleteMemoryEntry(scope: MemoryScope, id: string, root?: string) {
  const paths = memoryPaths(root)
  return serializeMemoryWrite(scope === "global" ? paths.globalEntries : paths.projectEntries, async () => {
  const entries = await readMemoryEntries(scope, root)
  const next = entries.filter((entry) => entry.id !== id)
  if (next.length === entries.length) throw new Error(`Unknown ${scope} memory entry: ${id}`)
  await writeMemoryEntriesUnlocked(scope, next, root)
  return { ok: true, id, scope }
  })
}

export async function refreshMemoryIndex(root?: string) {
  const paths = memoryPaths(root)
  const [globalEntries, projectEntries] = await Promise.all([
    readMemoryEntries("global", root),
    readMemoryEntries("project", root),
  ])
  const index = {
    version: 0,
    generatedAt: new Date().toISOString(),
    counts: {
      global: globalEntries.length,
      project: projectEntries.length,
    },
    entries: [...globalEntries, ...projectEntries].map((entry) => ({
      id: entry.id,
      scope: entry.scope,
      tags: entry.tags,
      categoryIDs: entry.categoryIDs,
      cwd: entry.cwd,
      files: entry.files,
      providerID: entry.providerID,
      modelID: entry.modelID,
      focusID: entry.focusID,
      sensitivity: entry.sensitivity,
      confidence: entry.confidence,
      updatedAt: entry.updatedAt,
      preview: entry.text.length > 160 ? `${entry.text.slice(0, 157)}...` : entry.text,
    })),
  }
  await mkdir(paths.projectDir, { recursive: true })
  await writeFile(paths.projectIndex, `${JSON.stringify(index, null, 2)}\n`)
  return index
}

async function fileInfo(file: string) {
  if (!existsSync(file)) return { exists: false, bytes: 0 }
  const text = await readFile(file, "utf8").catch(() => "")
  return { exists: true, bytes: Buffer.byteLength(text) }
}

export async function memoryStatus(root?: string): Promise<MemoryStatus> {
  const paths = memoryPaths(root)
  const config = await readMemoryConfig(paths.root)
  const [globalSummary, projectSummary, globalEntries, projectEntries] = await Promise.all([
    fileInfo(paths.globalSummary),
    fileInfo(paths.projectSummary),
    readMemoryEntries("global", paths.root).catch(() => []),
    readMemoryEntries("project", paths.root).catch(() => []),
  ])
  const extractionJobs = await readMemoryExtractionQueue(paths.root).catch(() => [])
  const proposalFiles = existsSync(paths.proposalsDir) ? await readdir(paths.proposalsDir).catch(() => []) : []
  const proposals = await Promise.all(proposalFiles.filter((file) => file.endsWith(".json")).map(async (file) => {
    try {
      return JSON.parse(await readFile(path.join(paths.proposalsDir, file), "utf8")) as { status?: string }
    } catch {
      return null
    }
  }))
  return {
    enabled: config.enabled,
    configScope: config.configScope,
    use: config.use,
    generate: config.generate,
    input: config.use,
    output: config.generate,
    promptModeIndependent: true,
    scopes: config.scopes,
    maxPromptTokens: config.maxPromptTokens,
    maxEntries: config.maxEntries,
    projectMaxEntries: config.projectMaxEntries,
    globalCompactionMaxEntries: config.globalCompactionMaxEntries,
    extractorRole: config.extractorRole,
    consolidatorRole: config.consolidatorRole,
    memoryDreamRole: config.memoryDreamRole,
    dreamConsolidationPolicy: config.dreamConsolidationPolicy,
    memoryAssistantRole: config.memoryAssistantRole,
    paths: {
      globalConfig: paths.globalConfig,
      globalSummary: paths.globalSummary,
      globalEntries: paths.globalEntries,
      projectSummary: path.relative(paths.root, paths.projectSummary),
      projectEntries: path.relative(paths.root, paths.projectEntries),
      projectConfig: path.relative(paths.root, paths.projectConfig),
    },
    summaries: { global: globalSummary, project: projectSummary },
    entries: {
      global: { exists: existsSync(paths.globalEntries), count: globalEntries.length },
      project: { exists: existsSync(paths.projectEntries), count: projectEntries.length },
    },
    proposals: {
      exists: existsSync(paths.proposalsDir),
      pending: proposals.filter((proposal) => proposal?.status === "pending").length,
      applied: proposals.filter((proposal) => proposal?.status === "applied").length,
      rejected: proposals.filter((proposal) => proposal?.status === "rejected").length,
    },
    extraction: {
      queued: extractionJobs.filter((job) => job.state === "queued").length,
      running: extractionJobs.filter((job) => job.state === "running").length,
      completed: extractionJobs.filter((job) => job.state === "completed").length,
      skipped: extractionJobs.filter((job) => job.state === "skipped").length,
      failed: extractionJobs.filter((job) => job.state === "failed").length,
    },
    callsProviders: false,
    retrievalCallsProviders: false,
    outputCallsProviders: config.enabled && config.generate && Boolean(config.extractorRole) && config.extractorRole !== "none",
    readsSecrets: false,
    printsSecrets: false,
  }
}
