import { readMemoryConfig } from "./config"
import { DEFAULT_MEMORY_CATEGORIES, normalizeMemoryCategoryPolicies, readMemoryCategoryPolicies, readMemoryCategoryPolicyLayers } from "./categories"
import { latestDreamStatus, readDreamRunDetails, readDreamRuns, resolveMemoryDreamRole, type DreamRunDetail } from "./dream"
import { computeMemoryGraphHealth, isMemoryGraphVisibleFact, materializeLegacyMemoryFacts, readMemoryFacts, readMemoryGraph, type MemoryFact, type MemoryFactLink } from "./graph"
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

export type MemoryGraphOverviewWorkspace = {
  id: string
  root: string
  displayName: string
}

export type MemoryGraphOverviewFact = MemoryFact & {
  factID: string
  sourceRoots: string[]
  materialized: boolean
}

export type MemoryGraphOverviewLink = MemoryFactLink & {
  sourceRoot: string
}

function graphNodeID(workspaceID: string, fact: Pick<MemoryFact, "id" | "scope">) {
  return fact.scope === "global" ? `global:${fact.id}` : `${workspaceID}:${fact.id}`
}

export async function memoryGraphOverview(workspaces: MemoryGraphOverviewWorkspace[]) {
  const snapshots = await Promise.all(workspaces.map(async (workspace) => {
    const materializedGraph = await materializeLegacyMemoryFacts(workspace.root).catch(() => null)
    const graph = materializedGraph?.graph ?? await readMemoryGraph(workspace.root).catch(() => ({ facts: [], links: [], categories: DEFAULT_MEMORY_CATEGORIES, policies: normalizeMemoryCategoryPolicies({}) }))
    const facts = (await readMemoryFacts(workspace.root).catch(() => [])).filter(isMemoryGraphVisibleFact)
    const materialized = new Set(graph.facts.map((fact) => fact.id))
    const byID = new Map(facts.map((fact) => [fact.id, fact]))
    return { workspace, facts, graph, materialized, byID }
  }))
  const factByNodeID = new Map<string, MemoryGraphOverviewFact>()
  for (const snapshot of snapshots) {
    for (const fact of snapshot.facts) {
      const nodeID = graphNodeID(snapshot.workspace.id, fact)
      const existing = factByNodeID.get(nodeID)
      const owners = fact.scope === "global"
        ? fact.ownerWorkspaceIDs
        : [...new Set([...fact.ownerWorkspaceIDs, snapshot.workspace.id])]
      factByNodeID.set(nodeID, {
        ...(existing ?? fact),
        ...fact,
        id: nodeID,
        factID: fact.id,
        ownerWorkspaceIDs: [...new Set([...(existing?.ownerWorkspaceIDs ?? []), ...owners])],
        sourceRoots: [...new Set([...(existing?.sourceRoots ?? []), snapshot.workspace.root])],
        materialized: Boolean(existing?.materialized || snapshot.materialized.has(fact.id)),
      })
    }
  }
  const links = new Map<string, MemoryGraphOverviewLink>()
  for (const snapshot of snapshots) {
    for (const link of snapshot.graph.links) {
      const from = snapshot.byID.get(link.from)
      const to = snapshot.byID.get(link.to)
      if (!from || !to) continue
      const mapped = {
        ...link,
        id: `${snapshot.workspace.id}:${link.id}`,
        from: graphNodeID(snapshot.workspace.id, from),
        to: graphNodeID(snapshot.workspace.id, to),
        sourceRoot: snapshot.workspace.root,
      }
      const key = `${mapped.from}\u0000${mapped.to}\u0000${mapped.kind}`
      if (!links.has(key)) links.set(key, mapped)
    }
  }
  const facts = [...factByNodeID.values()]
  const graphLinks = [...links.values()]
  const materializedFacts = facts.filter((fact) => fact.materialized)
  const categoryCounts = new Map<string, number>()
  for (const fact of facts) {
    for (const categoryID of fact.categoryIDs.length ? fact.categoryIDs : ["uncategorized"]) {
      categoryCounts.set(categoryID, (categoryCounts.get(categoryID) ?? 0) + 1)
    }
  }
  return {
    facts,
    links: graphLinks,
    graphHealth: computeMemoryGraphHealth({ graph: { facts: materializedFacts, links: graphLinks }, facts }),
    materializedFactCount: materializedFacts.length,
    legacyDerivedFactCount: facts.length - materializedFacts.length,
    categories: DEFAULT_MEMORY_CATEGORIES.map((category) => ({ ...category, count: categoryCounts.get(category.id) ?? 0 })),
    workspaces,
  }
}

export async function memoryOverview(root?: string) {
  const [status, config, globalEntries, projectEntries, proposals, facts, graph, workspaces, dream, dreamRuns, dreamRunDetails, policies, policyLayers, dreamRole] = await Promise.all([
    memoryStatus(root),
    readMemoryConfig(root),
    readMemoryEntries("global", root).catch(() => []),
    readMemoryEntries("project", root).catch(() => []),
    listMemoryProposals(root, "all").catch(() => []),
    readMemoryFacts(root).catch(() => []),
    readMemoryGraph(root).catch(() => ({ facts: [], links: [], categories: DEFAULT_MEMORY_CATEGORIES, policies: normalizeMemoryCategoryPolicies({}) })),
    memoryWorkspaceOverview(root).catch(() => null),
    latestDreamStatus(root).catch(() => null),
    readDreamRuns(root).catch(() => []),
    readDreamRunDetails(root).catch(() => []),
    readMemoryCategoryPolicies(root).catch(() => normalizeMemoryCategoryPolicies({})),
    readMemoryCategoryPolicyLayers(root).catch(() => null),
    resolveMemoryDreamRole(root).catch((error) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) })),
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
    dreamRole,
    categories: DEFAULT_MEMORY_CATEGORIES.map((category) => ({
      ...category,
      count: categoryCounts.get(category.id) ?? 0,
    })),
    policies,
    policyLayers,
  }
}
