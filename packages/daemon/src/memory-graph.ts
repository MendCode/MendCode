import type { MemoryEntry, MemoryGraphHealth, MemoryGraphReport, MemoryLink } from "@mendcode/protocol"

/** Nodes a graph report carries; the rest are counted in the health but not sent. */
export const MAX_GRAPH_NODES = 200

export function graphHealth(nodes: readonly MemoryEntry[], links: readonly MemoryLink[]): MemoryGraphHealth {
  const ids = new Set(nodes.map((node) => node.memoryId))
  const valid = links.filter((link) => ids.has(link.from) && ids.has(link.to))
  const touched = new Set(valid.flatMap((link) => [link.from, link.to]))
  const isolated = nodes.length - touched.size
  return {
    nodes: nodes.length,
    links: valid.length,
    connected: touched.size,
    isolated,
    conflicts: valid.filter((link) => link.kind === "conflicts").length,
    state: nodes.length === 0 ? "empty" : touched.size === 0 ? "disconnected" : isolated === 0 ? "connected" : "partial",
  }
}

/** The saved memories as a graph: most linked first (then newest), capped, with only the links among the kept nodes. */
export function memoryGraph(memories: readonly MemoryEntry[], links: readonly MemoryLink[]): MemoryGraphReport {
  const saved = memories.filter((memory) => memory.status === "saved")
  const degree = new Map<string, number>()
  for (const link of links) for (const id of [link.from, link.to]) degree.set(id, (degree.get(id) ?? 0) + 1)
  const nodes = [...saved].sort((a, b) => (degree.get(b.memoryId) ?? 0) - (degree.get(a.memoryId) ?? 0) || b.updatedAt - a.updatedAt).slice(0, MAX_GRAPH_NODES)
  const kept = new Set(nodes.map((node) => node.memoryId))
  return { nodes, links: links.filter((link) => kept.has(link.from) && kept.has(link.to)), health: graphHealth(saved, links) }
}
