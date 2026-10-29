import { posix } from "node:path"
import type { Graph, GraphNode } from "./graph"
import type { Language, SymbolKind } from "./types"

export const loc = (node: GraphNode): string => (node.start > 0 ? `${node.path}:${node.start}` : node.path)

export const inDegree = ({ graph, id }: { graph: Graph; id: string }): number => graph.callers.get(id)?.length ?? 0
const outDegree = ({ graph, id }: { graph: Graph; id: string }): number => graph.callees.get(id)?.length ?? 0

/** Whether `path` is `prefix` itself or inside it; an empty prefix matches everything. */
export function under({ path, prefix }: { path: string; prefix: string | undefined }): boolean {
  if (!prefix) return true
  return path === prefix || path.startsWith(`${prefix}/`)
}

/** A project-relative POSIX path from a model-supplied one (`./src/`, absolute inside cwd), or undefined when it points outside. */
export function projectRelative({ cwd, input }: { cwd: string; input: string }): string | undefined {
  const root = cwd.replaceAll("\\", "/")
  const raw = input.replaceAll("\\", "/")
  const absolute = raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)
  const rel = absolute ? posix.relative(root, raw) : posix.normalize(raw)
  if (rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel)) return undefined
  return rel === "." || rel === "" ? "" : rel.replace(/\/$/, "")
}

const splitWords = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase())

/** How well `node` matches `query`: 0 means no match, higher is better. */
export function scoreName({ graph, node, query }: { graph: Graph; node: GraphNode; query: string }): number {
  query = query.trim()
  if (!query) return 0
  const q = query.toLowerCase()
  const name = node.name.toLowerCase()
  const label = node.label.toLowerCase()
  let score = 0
  if (node.name === query || node.label === query) score = 100
  else if (name === q || label === q) score = 90
  else if (name.startsWith(q)) score = 70
  else if (name.includes(q)) score = 50
  else if (label.includes(q)) score = 45
  else {
    const wanted = splitWords(query)
    const have = new Set(splitWords(node.label))
    if (wanted.length > 0 && wanted.every((word) => have.has(word) || name.includes(word))) score = 30
  }
  if (score === 0) return 0
  if (node.exported) score += 4
  if (node.kind === "function" || node.kind === "class" || node.kind === "method") score += 1
  return score + Math.min(inDegree({ graph, id: node.id }), 20) * 0.2
}

export function findSymbols({
  graph,
  query,
  path,
  kind,
}: {
  graph: Graph
  query: string
  path?: string | undefined
  kind?: SymbolKind | undefined
}): Array<{ node: GraphNode; score: number }> {
  const scored: Array<{ node: GraphNode; score: number }> = []
  for (const node of graph.nodes) {
    if (kind && node.kind !== kind) continue
    if (!under({ path: node.path, prefix: path })) continue
    const score = scoreName({ graph, node, query })
    if (score > 0) scored.push({ node, score })
  }
  return scored.sort((a, b) => b.score - a.score || a.node.path.localeCompare(b.node.path) || a.node.start - b.node.start)
}

/** The node a model means by `symbol` (id, `name`, or `Class.method`), with other candidates. */
export function resolveSymbol({ graph, symbol, path }: { graph: Graph; symbol: string; path?: string | undefined }): { node: GraphNode; others: GraphNode[] } | { suggestions: GraphNode[] } {
  const exact = graph.byId.get(symbol)
  if (exact && under({ path: exact.path, prefix: path })) return { node: exact, others: [] }
  const name = symbol.includes("#") ? symbol.slice(symbol.indexOf("#") + 1) : symbol
  const filePart = symbol.includes("#") ? symbol.slice(0, symbol.indexOf("#")) : path
  const short = name.includes(".") ? (name.split(".").pop() as string) : name
  const pool = graph.byName.get(short) ?? []
  const candidates = pool.filter((node) => (node.label === name || node.name === name) && under({ path: node.path, prefix: filePart }) && under({ path: node.path, prefix: path }))
  if (candidates.length === 0) {
    return { suggestions: findSymbols({ graph, query: short, path: filePart }).filter((entry) => under({ path: entry.node.path, prefix: path })).slice(0, 5).map((entry) => entry.node) }
  }
  const weight = (node: GraphNode) => Number(node.exported) * 100 + inDegree({ graph, id: node.id }) + outDegree({ graph, id: node.id })
  const ordered = [...candidates].sort((a, b) => weight(b) - weight(a) || a.path.localeCompare(b.path))
  return { node: ordered[0] as GraphNode, others: ordered.slice(1) }
}

export type TraversalRow = { node: GraphNode; depth: number; via: GraphNode }

/** Breadth-first walk over call edges: `in` follows callers, `out` follows callees. */
export function traverseCalls({
  graph,
  start,
  direction,
  depth,
  cap,
}: {
  graph: Graph
  start: GraphNode | GraphNode[]
  direction: "in" | "out"
  depth: number | "all"
  cap: number
}): { rows: TraversalRow[]; more: number } {
  const edges = direction === "in" ? graph.callers : graph.callees
  const roots = Array.isArray(start) ? start : [start]
  const seen = new Set<string>(roots.map((node) => node.id))
  const rows: TraversalRow[] = []
  let frontier: GraphNode[] = roots
  let more = 0
  const levels = depth === "all" ? Infinity : depth
  for (let level = 1; level <= levels && frontier.length > 0; level++) {
    const next: GraphNode[] = []
    for (const via of frontier) {
      const targets = [...(edges.get(via.id) ?? [])]
        .map((id) => graph.byId.get(id))
        .filter((node): node is GraphNode => node !== undefined)
        .sort((a, b) => a.path.localeCompare(b.path) || a.start - b.start)
      for (const node of targets) {
        if (seen.has(node.id)) continue
        seen.add(node.id)
        if (rows.length >= cap) more++
        else rows.push({ node, depth: level, via })
        // A presentation cap must not prune the traversal or undercount the hidden blast radius.
        next.push(node)
      }
    }
    frontier = next
  }
  return { rows, more }
}

export type DirSummary = { dir: string; files: number; languages: Partial<Record<Language, number>> }
export type ProjectMap = { files: number; symbols: number; dirs: DirSummary[]; hubs: Array<{ node: GraphNode; callers: number }> }

const CALLABLE_KINDS: ReadonlySet<SymbolKind> = new Set(["function", "class", "method", "variable", "struct"])

export function projectMap({ graph, scope, depth, hubLimit }: { graph: Graph; scope?: string | undefined; depth: number; hubLimit: number }): ProjectMap {
  const dirs = new Map<string, DirSummary>()
  let files = 0
  let symbols = 0
  for (const file of graph.files.values()) {
    if (!under({ path: file.path, prefix: scope })) continue
    files++
    symbols += file.symbols
    const segments = posix.dirname(file.path).split("/").filter((segment) => segment !== ".")
    const dir = segments.length === 0 ? "." : segments.slice(0, depth).join("/")
    const entry = dirs.get(dir) ?? { dir, files: 0, languages: {} }
    entry.files++
    entry.languages[file.language] = (entry.languages[file.language] ?? 0) + 1
    dirs.set(dir, entry)
  }
  const hubs = graph.nodes
    .filter((node) => CALLABLE_KINDS.has(node.kind) && under({ path: node.path, prefix: scope }))
    .map((node) => ({ node, callers: inDegree({ graph, id: node.id }) }))
    .filter((entry) => entry.callers > 0)
    .sort((a, b) => b.callers - a.callers || a.node.label.localeCompare(b.node.label) || a.node.path.localeCompare(b.node.path))
    .slice(0, hubLimit)
  const sorted = [...dirs.values()].sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir))
  return { files, symbols, dirs: sorted, hubs }
}
