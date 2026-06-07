import { existsSync } from "fs"
import { mkdir, readFile, readdir, writeFile } from "fs/promises"
import path from "path"
import { memoryPaths, readMemoryConfig, type MemoryScope } from "./config"

export type MemorySensitivity = "low" | "medium" | "high"

export type MemoryEntry = {
  id: string
  scope: MemoryScope
  text: string
  tags: string[]
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
  extractorRole: string
  consolidatorRole: string
  paths: Record<string, string>
  summaries: Record<MemoryScope, { exists: boolean; bytes: number }>
  entries: Record<MemoryScope, { exists: boolean; count: number }>
  proposals: { exists: boolean; pending: number; applied: number; rejected: number }
  callsProviders: false
  retrievalCallsProviders: false
  outputCallsProviders: boolean
  readsSecrets: false
  printsSecrets: false
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

export async function readMemorySummary(scope: MemoryScope, root?: string) {
  const paths = memoryPaths(root)
  const file = scope === "global" ? paths.globalSummary : paths.projectSummary
  return readTextIfExists(file)
}

export async function appendMemoryEntry(input: Partial<MemoryEntry> & { text: string; scope?: MemoryScope }, root?: string) {
  const paths = memoryPaths(root)
  const entry = normalizeMemoryEntry(input)
  const file = entry.scope === "global" ? paths.globalEntries : paths.projectEntries
  await mkdir(path.dirname(file), { recursive: true })
  const previous = await readTextIfExists(file)
  await writeFile(file, `${previous}${JSON.stringify(entry)}\n`)
  await refreshMemoryIndex(root)
  return entry
}

async function writeMemoryEntries(scope: MemoryScope, entries: MemoryEntry[], root?: string) {
  const paths = memoryPaths(root)
  const file = scope === "global" ? paths.globalEntries : paths.projectEntries
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""))
  await refreshMemoryIndex(root)
}

export async function updateMemoryEntry(scope: MemoryScope, id: string, patch: Partial<MemoryEntry>, root?: string) {
  const entries = await readMemoryEntries(scope, root)
  const index = entries.findIndex((entry) => entry.id === id)
  if (index === -1) throw new Error(`Unknown ${scope} memory entry: ${id}`)
  const current = entries[index]!
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
  await writeMemoryEntries(scope, entries, root)
  return next
}

export async function deleteMemoryEntry(scope: MemoryScope, id: string, root?: string) {
  const entries = await readMemoryEntries(scope, root)
  const next = entries.filter((entry) => entry.id !== id)
  if (next.length === entries.length) throw new Error(`Unknown ${scope} memory entry: ${id}`)
  await writeMemoryEntries(scope, next, root)
  return { ok: true, id, scope }
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
    extractorRole: config.extractorRole,
    consolidatorRole: config.consolidatorRole,
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
    callsProviders: false,
    retrievalCallsProviders: false,
    outputCallsProviders: config.enabled && config.generate && Boolean(config.extractorRole) && config.extractorRole !== "none",
    readsSecrets: false,
    printsSecrets: false,
  }
}
