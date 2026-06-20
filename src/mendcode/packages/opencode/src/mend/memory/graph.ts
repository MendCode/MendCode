import { existsSync } from "fs"
import { mkdir, readFile, rename, writeFile } from "fs/promises"
import path from "path"
import { memoryPaths, type MemoryScope } from "./config"
import { DEFAULT_MEMORY_CATEGORIES, inferMemoryCategoryIDs, memoryCategoryByID, normalizeMemoryCategoryIDs, normalizeMemoryCategoryPolicies, type MemoryFactScope } from "./categories"
import { readMemoryEntries, type MemoryEntry } from "./store"

export type MemoryFact = {
  id: string
  legacyEntryID: string | null
  scope: MemoryFactScope
  ownerWorkspaceIDs: string[]
  ownerGroupIDs: string[]
  categoryIDs: string[]
  text: string
  normalizedSummary: string
  provenance: string[]
  createdAt: string
  updatedAt: string
  verifiedAt: string | null
  confidence: number
  durability: number
  changeRisk: number
  sensitivity: "low" | "medium" | "high"
  stale: boolean
  retrievalPriority: number
  legacyMaterialized: boolean
}

export type MemoryFactLink = {
  id: string
  from: string
  to: string
  kind: "related" | "conflicts" | "supersedes" | "supports"
  createdAt: string
}

export type MemoryGraph = {
  facts: MemoryFact[]
  links: MemoryFactLink[]
  categories: typeof DEFAULT_MEMORY_CATEGORIES
  policies: ReturnType<typeof normalizeMemoryCategoryPolicies>
}

function graphDir(root?: string) {
  return path.join(memoryPaths(root).projectDir, "graph")
}

function graphFile(root: string | undefined, name: string) {
  return path.join(graphDir(root), name)
}

function nowID(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeSummary(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 240)
}

async function atomicWrite(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, text)
  await rename(tmp, file)
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  if (!existsSync(file)) return fallback
  return JSON.parse(await readFile(file, "utf8")) as T
}

function factFromLegacyEntry(entry: MemoryEntry): MemoryFact {
  const categoryIDs = inferMemoryCategoryIDs({ text: entry.text, tags: entry.tags, source: entry.source })
  const priority = Math.min(...categoryIDs.map((id) => memoryCategoryByID(id).promptPriority))
  return {
    id: `legacy_${entry.id}`,
    legacyEntryID: entry.id,
    scope: entry.scope,
    ownerWorkspaceIDs: entry.scope === "project" && entry.cwd ? [entry.cwd] : [],
    ownerGroupIDs: [],
    categoryIDs,
    text: entry.text,
    normalizedSummary: normalizeSummary(entry.text),
    provenance: [entry.evidence, entry.source].filter((item): item is string => Boolean(item)),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    verifiedAt: null,
    confidence: entry.confidence,
    durability: 0.8,
    changeRisk: 0.2,
    sensitivity: entry.sensitivity,
    stale: false,
    retrievalPriority: priority,
    legacyMaterialized: true,
  }
}

export function normalizeMemoryFact(input: Partial<MemoryFact> & { text: string }): MemoryFact {
  const now = new Date().toISOString()
  const categoryIDs = normalizeMemoryCategoryIDs(input.categoryIDs)
  return {
    id: typeof input.id === "string" && input.id ? input.id : nowID("memfact"),
    legacyEntryID: typeof input.legacyEntryID === "string" && input.legacyEntryID ? input.legacyEntryID : null,
    scope: input.scope === "global" || input.scope === "workspace" || input.scope === "group-view" ? input.scope : "project",
    ownerWorkspaceIDs: Array.isArray(input.ownerWorkspaceIDs) ? input.ownerWorkspaceIDs.filter((item): item is string => typeof item === "string" && item.length > 0) : [],
    ownerGroupIDs: Array.isArray(input.ownerGroupIDs) ? input.ownerGroupIDs.filter((item): item is string => typeof item === "string" && item.length > 0) : [],
    categoryIDs,
    text: input.text.trim(),
    normalizedSummary: input.normalizedSummary || normalizeSummary(input.text),
    provenance: Array.isArray(input.provenance) ? input.provenance.filter((item): item is string => typeof item === "string" && item.length > 0) : [],
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
    verifiedAt: input.verifiedAt || null,
    confidence: typeof input.confidence === "number" && Number.isFinite(input.confidence) ? Math.max(0, Math.min(1, input.confidence)) : 0.7,
    durability: typeof input.durability === "number" && Number.isFinite(input.durability) ? Math.max(0, Math.min(1, input.durability)) : 0.8,
    changeRisk: typeof input.changeRisk === "number" && Number.isFinite(input.changeRisk) ? Math.max(0, Math.min(1, input.changeRisk)) : 0.2,
    sensitivity: input.sensitivity === "high" || input.sensitivity === "medium" ? input.sensitivity : "low",
    stale: input.stale === true,
    retrievalPriority: typeof input.retrievalPriority === "number" && Number.isFinite(input.retrievalPriority)
      ? input.retrievalPriority
      : Math.min(...categoryIDs.map((id) => memoryCategoryByID(id).promptPriority)),
    legacyMaterialized: input.legacyMaterialized === true,
  }
}

export async function readMemoryGraph(root?: string): Promise<MemoryGraph> {
  const factsFile = graphFile(root, "facts.jsonl")
  const linksFile = graphFile(root, "links.jsonl")
  const categories = await readJson(graphFile(root, "categories.json"), DEFAULT_MEMORY_CATEGORIES).catch(() => DEFAULT_MEMORY_CATEGORIES)
  const policies = normalizeMemoryCategoryPolicies(await readJson(graphFile(root, "policies.json"), {}).catch(() => ({})))
  const factText = existsSync(factsFile) ? await readFile(factsFile, "utf8").catch(() => "") : ""
  const linkText = existsSync(linksFile) ? await readFile(linksFile, "utf8").catch(() => "") : ""
  const facts = factText.split("\n").filter(Boolean).map((line) => {
    try {
      const parsed = JSON.parse(line)
      return typeof parsed?.text === "string" ? normalizeMemoryFact(parsed) : null
    } catch {
      return null
    }
  }).filter((fact): fact is MemoryFact => Boolean(fact))
  const links = linkText.split("\n").filter(Boolean).map((line) => {
    try {
      const parsed = JSON.parse(line) as MemoryFactLink
      return parsed?.id && parsed.from && parsed.to ? parsed : null
    } catch {
      return null
    }
  }).filter((link): link is MemoryFactLink => Boolean(link))
  return { facts, links, categories, policies }
}

export async function writeMemoryGraph(graph: Pick<MemoryGraph, "facts" | "links" | "policies">, root?: string) {
  const dir = graphDir(root)
  await mkdir(dir, { recursive: true })
  await atomicWrite(path.join(dir, "facts.jsonl"), graph.facts.map((fact) => JSON.stringify(normalizeMemoryFact(fact))).join("\n") + (graph.facts.length ? "\n" : ""))
  await atomicWrite(path.join(dir, "links.jsonl"), graph.links.map((link) => JSON.stringify(link)).join("\n") + (graph.links.length ? "\n" : ""))
  await atomicWrite(path.join(dir, "categories.json"), `${JSON.stringify(DEFAULT_MEMORY_CATEGORIES, null, 2)}\n`)
  await atomicWrite(path.join(dir, "policies.json"), `${JSON.stringify(normalizeMemoryCategoryPolicies(graph.policies), null, 2)}\n`)
}

export async function upsertMemoryFact(input: Partial<MemoryFact> & { text: string }, root?: string) {
  const graph = await readMemoryGraph(root)
  const fact = normalizeMemoryFact(input)
  const index = graph.facts.findIndex((item) => item.id === fact.id)
  const facts = [...graph.facts]
  if (index === -1) facts.push(fact)
  else facts[index] = { ...fact, updatedAt: new Date().toISOString() }
  await writeMemoryGraph({ ...graph, facts }, root)
  return fact
}

export async function legacyFacts(root?: string) {
  const [globalEntries, projectEntries] = await Promise.all([
    readMemoryEntries("global", root).catch(() => []),
    readMemoryEntries("project", root).catch(() => []),
  ])
  return [...globalEntries, ...projectEntries].map(factFromLegacyEntry)
}

export async function readMemoryFacts(root?: string) {
  const [graph, legacy] = await Promise.all([
    readMemoryGraph(root).catch(() => ({ facts: [], links: [], categories: DEFAULT_MEMORY_CATEGORIES, policies: normalizeMemoryCategoryPolicies({}) })),
    legacyFacts(root),
  ])
  const seen = new Set(graph.facts.map((fact) => fact.legacyEntryID).filter(Boolean))
  return [...graph.facts, ...legacy.filter((fact) => !seen.has(fact.legacyEntryID))]
}

export async function validateMemoryGraph(root?: string) {
  const graph = await readMemoryGraph(root)
  const factIDs = new Set(graph.facts.map((fact) => fact.id))
  const issues: Array<{ code: string; message: string; repairable: boolean }> = []
  for (const fact of graph.facts) {
    for (const categoryID of fact.categoryIDs) {
      if (!DEFAULT_MEMORY_CATEGORIES.some((category) => category.id === categoryID)) {
        issues.push({ code: "invalid-category", message: `Fact ${fact.id} references unknown category ${categoryID}`, repairable: true })
      }
    }
  }
  for (const link of graph.links) {
    if (!factIDs.has(link.from) || !factIDs.has(link.to)) {
      issues.push({ code: "missing-link-target", message: `Link ${link.id} references missing fact`, repairable: true })
    }
  }
  return { ok: issues.length === 0, issues }
}

export async function repairMemoryGraph(root?: string) {
  const graph = await readMemoryGraph(root)
  const factIDs = new Set(graph.facts.map((fact) => fact.id))
  const facts = graph.facts.map((fact) => normalizeMemoryFact({
    ...fact,
    categoryIDs: normalizeMemoryCategoryIDs(fact.categoryIDs),
  }))
  const links = graph.links.filter((link) => factIDs.has(link.from) && factIDs.has(link.to))
  await writeMemoryGraph({ ...graph, facts, links }, root)
  return { facts: facts.length, links: links.length }
}

export function legacyScopeForFact(scope: MemoryFactScope): MemoryScope {
  return scope === "global" ? "global" : "project"
}
