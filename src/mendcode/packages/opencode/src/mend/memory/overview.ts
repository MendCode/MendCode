import { readMemoryConfig } from "./config"
import { DEFAULT_MEMORY_CATEGORIES, normalizeMemoryCategoryPolicies, readMemoryCategoryPolicies } from "./categories"
import { latestDreamStatus, readDreamRunDetails, readDreamRuns, type DreamRunDetail } from "./dream"
import { computeMemoryGraphHealth, readMemoryFacts, readMemoryGraph } from "./graph"
import { listMemoryProposals } from "./proposals"
import { memoryStatus, readMemoryEntries } from "./store"
import { memoryWorkspaceOverview } from "./workspaces"

function latestDreamActivity(detail: DreamRunDetail | null | undefined) {
  if (!detail) return null
  const completedAt = detail.run.completedAt ?? detail.events.at(-1)?.at ?? detail.run.startedAt
  const priority = (kind: string) => {
    if (kind === "completed" || kind === "failed" || kind === "failure") return 4
    if (kind === "memory-proposals" || kind.startsWith("graph-proposal")) return 3
    if (kind.startsWith("skipped") || kind === "created-proposal") return 2
    if (kind === "safety") return 0
    return 1
  }
  return [
    ...detail.events.map((event) => ({ at: event.at, kind: event.status, summary: event.message })),
    ...detail.decisions.map((decision) => ({ at: decision.at, kind: decision.status, summary: decision.reason })),
    ...detail.graphProposals.map((proposal) => ({ at: proposal.reviewedAt ?? proposal.createdAt, kind: `graph-proposal-${proposal.status}`, summary: `${proposal.status}: ${proposal.reason}` })),
    detail.proposals.length ? { at: completedAt, kind: "memory-proposals", summary: `${detail.proposals.length} memory proposals` } : null,
    { at: completedAt, kind: "safety", summary: `${detail.evidence.length} evidence refs, ${detail.safety?.redactions ?? 0} redactions` },
  ]
    .filter((item): item is { at: string; kind: string; summary: string } => Boolean(item?.at))
    .toSorted((a, b) => b.at.localeCompare(a.at) || priority(b.kind) - priority(a.kind))[0] ?? null
}

export async function memoryOverview(root?: string) {
  const [status, config, globalEntries, projectEntries, proposals, facts, graph, workspaces, dream, dreamRuns, dreamRunDetails, policies] = await Promise.all([
    memoryStatus(root),
    readMemoryConfig(root),
    readMemoryEntries("global", root).catch(() => []),
    readMemoryEntries("project", root).catch(() => []),
    listMemoryProposals(root, "all").catch(() => []),
    readMemoryFacts(root).catch(() => []),
    readMemoryGraph(root).catch(() => ({ facts: [], links: [], categories: DEFAULT_MEMORY_CATEGORIES, policies: normalizeMemoryCategoryPolicies({}) })),
    memoryWorkspaceOverview(root).catch(() => null),
    latestDreamStatus(root).catch(() => null),
    readDreamRuns(root).then((runs) => runs.slice(0, 8)).catch(() => []),
    readDreamRunDetails(root, 8).catch(() => []),
    readMemoryCategoryPolicies(root).catch(() => normalizeMemoryCategoryPolicies({})),
  ])
  const categoryCounts = new Map<string, number>()
  for (const fact of facts) {
    for (const categoryID of fact.categoryIDs.length ? fact.categoryIDs : ["uncategorized"]) {
      categoryCounts.set(categoryID, (categoryCounts.get(categoryID) ?? 0) + 1)
    }
  }
  const materializedFactIDs = new Set(graph.facts.map((fact) => fact.id))
  return {
    status,
    config,
    globalEntries,
    projectEntries,
    proposals,
    facts: facts.map((fact) => ({ ...fact, materialized: materializedFactIDs.has(fact.id) })),
    links: graph.links,
    graphHealth: computeMemoryGraphHealth({ graph, facts }),
    materializedFactCount: graph.facts.length,
    legacyDerivedFactCount: facts.filter((fact) => !materializedFactIDs.has(fact.id)).length,
    workspaces,
    dream,
    dreamRuns,
    dreamRunDetails,
    dreamLatestActivity: latestDreamActivity(dreamRunDetails[0]),
    categories: DEFAULT_MEMORY_CATEGORIES.map((category) => ({
      ...category,
      count: categoryCounts.get(category.id) ?? 0,
    })),
    policies,
  }
}
