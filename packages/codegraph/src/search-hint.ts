import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { cacheName } from "./cache-name"
import type { Graph, GraphNode } from "./graph"
import type { Indexer } from "./indexer"
import { loc } from "./query"

/** The bounds of the block a text search gets from the graph (docs/code-graph.md, "Graph answers in a text search"). */
export const SEARCH_HINT = {
  /** Identifiers answered per search. */
  identifiers: 3,
  /** Callers listed for an identifier's first definition. */
  callers: 5,
  /** Further definitions of the same name listed after the first. */
  others: 2,
  /** A name declared in more places than this is not one symbol the graph can point at. */
  ambiguous: 4,
  lines: 25,
  bytes: 2048,
  /** What one lookup may take; past it the search goes on without the block. */
  budgetMs: 50,
} as const

const HEADER = "[code graph] Where the searched names are declared and who calls them (graph_find and graph_callers give more):"

export type SearchHint = { text: string; /** Identifiers the block answers. */ identifiers: number }

const weight = (graph: Graph, node: GraphNode) => Number(node.exported) * 100 + (graph.callers.get(node.id)?.length ?? 0) + (graph.callees.get(node.id)?.length ?? 0)

/** The declarations the graph holds under exactly this name (`name` or `Class.method`), the most used first; none when the name is too common to be one symbol. */
function declarations(graph: Graph, term: string): GraphNode[] {
  const short = term.includes(".") ? term.slice(term.lastIndexOf(".") + 1) : term
  const found = (graph.byName.get(short) ?? []).filter((node) => node.name === term || node.label === term)
  if (!found.length || found.length > SEARCH_HINT.ambiguous) return []
  return [...found].sort((a, b) => weight(graph, b) - weight(graph, a) || a.path.localeCompare(b.path) || a.start - b.start)
}

const callersOf = (graph: Graph, node: GraphNode): GraphNode[] =>
  (graph.callers.get(node.id) ?? []).map((id) => graph.byId.get(id)).filter((caller): caller is GraphNode => caller !== undefined).sort((a, b) => a.path.localeCompare(b.path) || a.start - b.start)

/** The files a block for `terms` would cite, so their freshness can be checked before it is written. */
export function searchHintFiles({ graph, terms }: { graph: Graph; terms: readonly string[] }): string[] {
  const paths = new Set<string>()
  for (const term of terms) {
    const found = declarations(graph, term)
    for (const node of found.slice(0, 1 + SEARCH_HINT.others)) paths.add(node.path)
    if (found[0]) for (const caller of callersOf(graph, found[0]).slice(0, SEARCH_HINT.callers * 2)) paths.add(caller.path)
  }
  return [...paths]
}

/**
 * The block for the identifiers of one text search: per name the graph knows (at most three), its declaration and its first callers.
 * `stale` holds the files changed since they were indexed: their lines are left out, since a line number that moved is worse than none.
 * Undefined when the graph is sure of nothing; never longer than `SEARCH_HINT.lines` lines or `SEARCH_HINT.bytes` bytes.
 */
export function searchHint({ graph, terms, stale, note }: { graph: Graph; terms: readonly string[]; stale?: ReadonlySet<string> | undefined; /** A second line of the block (where its paths start). */ note?: string | undefined }): SearchHint | undefined {
  const lines = note ? [HEADER, note.slice(0, 300)] : [HEADER]
  let bytes = Buffer.byteLength(lines.join("\n"))
  let identifiers = 0
  const add = (line: string) => {
    if (lines.length >= SEARCH_HINT.lines || bytes + Buffer.byteLength(line) + 1 > SEARCH_HINT.bytes) return false
    lines.push(line)
    bytes += Buffer.byteLength(line) + 1
    return true
  }
  for (const term of terms) {
    if (identifiers >= SEARCH_HINT.identifiers) break
    const found = declarations(graph, term).filter((node) => !stale?.has(node.path))
    const first = found[0]
    if (!first) continue
    const callers = callersOf(graph, first)
    const total = callers.length
    if (!add(`${first.label}  ${first.kind}  ${loc(first)}${first.exported ? "  export" : ""}${total ? `  ${total} caller${total === 1 ? "" : "s"}` : "  no callers in the graph"}`)) break
    identifiers++
    for (const caller of callers.filter((node) => !stale?.has(node.path)).slice(0, SEARCH_HINT.callers)) if (!add(`  called by ${caller.label}  ${loc(caller)}`)) break
    for (const other of found.slice(1, 1 + SEARCH_HINT.others)) if (!add(`  also declared: ${other.kind} ${other.label}  ${loc(other)}`)) break
  }
  return identifiers ? { text: lines.join("\n"), identifiers } : undefined
}

/** The folder at or above `directory` that has a graph cache file; nothing is built for this. */
function indexedRoot(cacheDir: string, exists: (file: string) => boolean, directory: string): string | undefined {
  for (let dir = directory, depth = 0; depth < 32; dir = join(dir, ".."), depth++) {
    if (exists(join(cacheDir, cacheName(dir)))) return dir
    if (join(dir, "..") === dir) return undefined
  }
  return undefined
}

async function staleFiles(graph: Graph, root: string, paths: readonly string[]): Promise<Set<string>> {
  const stale = new Set<string>()
  await Promise.all(paths.map(async (path) => {
    const indexed = graph.files.get(path)
    const now = await stat(join(root, path)).catch(() => undefined)
    if (!indexed || !now || now.mtimeMs !== indexed.mtimeMs || now.size !== indexed.size) stale.add(path)
  }))
  return stale
}

/**
 * The graph's answer for the identifiers of a text search run in `cwd`, from the index that already exists (in memory, else its cache
 * file, loaded once): no walk, no scan, no build. Undefined when the folder has no index, the graph knows none of the names, or the
 * answer is not there within `budgetMs`: a cache file still loading then serves the next search. `indexer` is asked for only once a
 * search names identifiers in a folder that has a cache file, so the caller may load the indexer's module there.
 */
export function createSearchHints({ cacheDir, indexer, exists = existsSync, allowed, budgetMs = SEARCH_HINT.budgetMs }: {
  cacheDir: string
  indexer: () => Indexer | Promise<Indexer>
  exists?: ((file: string) => boolean) | undefined
  /** Whether the indexed folder may still be read from the graph (the index gate: `/graph off`). */
  allowed?: ((root: string) => boolean) | undefined
  budgetMs?: number | undefined
}) {
  return async function hint({ cwd, terms }: { cwd: string; terms: readonly string[] }): Promise<SearchHint | undefined> {
    if (!terms.length) return undefined
    const work = (async () => {
      const root = indexedRoot(cacheDir, exists, cwd)
      if (!root || allowed?.(root) === false) return undefined
      const graph = await (await indexer()).cached(root)
      if (!graph) return undefined
      const stale = await staleFiles(graph, root, searchHintFiles({ graph, terms }))
      // A search run below the indexed folder reads paths relative to its own directory: say where these start.
      return searchHint({ graph, terms, stale, ...(root !== cwd ? { note: `(paths are relative to ${root})` } : {}) })
    })().catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), budgetMs) })
    try {
      return await Promise.race([work, late])
    } finally {
      clearTimeout(timer)
    }
  }
}
