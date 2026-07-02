import { readMemoryConfig } from "./config"
import { DEFAULT_MEMORY_CATEGORIES, normalizeMemoryCategoryPolicies, readMemoryCategoryPolicies } from "./categories"
import { latestDreamStatus, readDreamRunDetails, readDreamRuns } from "./dream"
import { readMemoryFacts, readMemoryGraph } from "./graph"
import { listMemoryProposals } from "./proposals"
import { memoryStatus, readMemoryEntries } from "./store"
import { memoryWorkspaceOverview } from "./workspaces"

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
    materializedFactCount: graph.facts.length,
    legacyDerivedFactCount: facts.filter((fact) => !materializedFactIDs.has(fact.id)).length,
    workspaces,
    dream,
    dreamRuns,
    dreamRunDetails,
    categories: DEFAULT_MEMORY_CATEGORIES.map((category) => ({
      ...category,
      count: categoryCounts.get(category.id) ?? 0,
    })),
    policies,
  }
}
