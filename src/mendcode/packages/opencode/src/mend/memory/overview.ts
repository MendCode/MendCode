import { readMemoryConfig } from "./config"
import { DEFAULT_MEMORY_CATEGORIES, normalizeMemoryCategoryPolicies, readMemoryCategoryPolicies } from "./categories"
import { latestDreamStatus } from "./dream"
import { readMemoryFacts } from "./graph"
import { listMemoryProposals } from "./proposals"
import { memoryStatus, readMemoryEntries } from "./store"
import { memoryWorkspaceOverview } from "./workspaces"

export async function memoryOverview(root?: string) {
  const [status, config, globalEntries, projectEntries, proposals, facts, workspaces, dream, policies] = await Promise.all([
    memoryStatus(root),
    readMemoryConfig(root),
    readMemoryEntries("global", root).catch(() => []),
    readMemoryEntries("project", root).catch(() => []),
    listMemoryProposals(root, "all").catch(() => []),
    readMemoryFacts(root).catch(() => []),
    memoryWorkspaceOverview(root).catch(() => null),
    latestDreamStatus(root).catch(() => null),
    readMemoryCategoryPolicies(root).catch(() => normalizeMemoryCategoryPolicies({})),
  ])
  const categoryCounts = new Map<string, number>()
  for (const fact of facts) {
    for (const categoryID of fact.categoryIDs.length ? fact.categoryIDs : ["uncategorized"]) {
      categoryCounts.set(categoryID, (categoryCounts.get(categoryID) ?? 0) + 1)
    }
  }
  return {
    status,
    config,
    globalEntries,
    projectEntries,
    proposals,
    facts,
    workspaces,
    dream,
    categories: DEFAULT_MEMORY_CATEGORIES.map((category) => ({
      ...category,
      count: categoryCounts.get(category.id) ?? 0,
    })),
    policies,
  }
}
