import { isAbsolute } from "node:path"
import { CODEGRAPH_OVERVIEW, type CodegraphOverview, type CodegraphOverviewFile } from "@mendcode/protocol/wire"
import { errorMessage } from "@mendcode/tools"
import type { Graph } from "./graph"
import type { Indexer } from "./indexer"
import { holdsHome } from "./index-gate"

type Ready = Extract<CodegraphOverview, { state: "ready" }>
type Counts = { path: string; imports: number; importedBy: number; calls: number; degree: number; symbols: number }

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
/** A path the reply can carry whole and a terminal can draw: within the cap and free of control characters. */
const listable = (path: string) => path.length <= CODEGRAPH_OVERVIEW.path && !/[\x00-\x1f\x7f-\x9f]/.test(path)

/**
 * The most connected files of a built graph and the links among them, then the unconnected files that hold symbols. A file's degree is the number of distinct project files it is joined to: the ones it
 * imports, the ones that import it and the ones a call crosses to (`calls` counts those calls, for the Focus line only). A link `[a, b]` means `a` imports `b` or calls into it, so languages whose
 * imports are not resolved to files (Go, Rust) still connect. One pass over the files and the call edges; the reply is bounded by
 * `CODEGRAPH_OVERVIEW` whatever the project's size.
 */
export function fileOverview({ graph, limit = CODEGRAPH_OVERVIEW.defaultFiles }: { graph: Graph; limit?: number | undefined }): Ready {
  const counts = new Map<string, Counts>()
  /** The distinct files each file is joined to. Ranking by these, not by call counts, keeps one chatty helper or a test harness from outranking the files a project hangs on. */
  const joined = new Map<string, Set<string>>()
  for (const file of graph.files.values()) {
    const importers = graph.importers.get(file.path) ?? []
    joined.set(file.path, new Set([...file.imports, ...importers].filter((path) => path !== file.path)))
    counts.set(file.path, { path: file.path, imports: file.imports.length, importedBy: importers.length, calls: 0, degree: 0, symbols: file.symbols })
  }
  /** `from\0to` for every pair of files joined by a call. */
  const callLinks = new Set<string>()
  for (const [from, targets] of graph.callees) {
    const source = graph.byId.get(from)?.path
    const own = source === undefined ? undefined : counts.get(source)
    if (!own) continue
    for (const target of targets) {
      const path = graph.byId.get(target)?.path
      const other = path === undefined || path === source ? undefined : counts.get(path)
      if (!other) continue
      own.calls++
      other.calls++
      joined.get(source!)!.add(path!)
      joined.get(path!)!.add(source!)
      callLinks.add(`${source}\0${path}`)
    }
  }
  for (const file of counts.values()) file.degree = joined.get(file.path)!.size
  // Connected files first; a project whose files barely link (scripts, a skill, docs with code) still shows its files, the ones with
  // the most symbols first, instead of an empty galaxy next to a graph that says it indexed them.
  const ranked = (a: Counts, b: Counts) => b.degree - a.degree || b.symbols - a.symbols || a.path.localeCompare(b.path)
  const count = Math.max(1, Math.min(CODEGRAPH_OVERVIEW.files, Math.floor(limit)))
  const top = [...counts.values()].filter((file) => (file.degree > 0 || file.symbols > 0) && listable(file.path)).sort(ranked).slice(0, count)
  const neighbours = (paths: readonly string[]) => paths.flatMap((path) => (listable(path) && counts.has(path) ? [counts.get(path)!] : [])).sort(ranked).slice(0, CODEGRAPH_OVERVIEW.neighbours).map((file) => file.path)
  const files = top.map((file): CodegraphOverviewFile => ({
    ...file,
    topImports: neighbours(graph.files.get(file.path)?.imports ?? []),
    topImportedBy: neighbours(graph.importers.get(file.path) ?? []),
  }))
  const at = new Map(files.map((file, index) => [file.path, index]))
  const edges: Array<[number, number]> = []
  let omittedEdges = 0
  files.forEach((file, from) => {
    const imported = new Set(graph.files.get(file.path)?.imports ?? [])
    files.forEach((other, to) => {
      if (to === from || !(imported.has(other.path) || callLinks.has(`${file.path}\0${other.path}`))) return
      if (edges.length < CODEGRAPH_OVERVIEW.edges) edges.push([from, at.get(other.path)!])
      else omittedEdges++
    })
  })
  return { state: "ready", files, edges, total: { files: graph.files.size, symbols: graph.nodes.length }, omittedEdges, partial: graph.partial, builtAt: graph.builtAt }
}

export type CodeOverview = (args: { directory: string; limit?: number | undefined; signal: AbortSignal }) => Promise<CodegraphOverview>

/**
 * `codegraph.overview` for a daemon: an explicit request for the code graph of `directory`, so it builds or refreshes the index like a
 * graph tool does, and like them refuses the home folder and the directories above it without reading anything.
 */
export function createCodeOverview({ indexer, home }: { indexer: Indexer; home?: string | undefined }): CodeOverview {
  return async ({ directory, limit, signal }) => {
    if (!isAbsolute(directory)) return { state: "failed", reason: "the directory is not an absolute path" }
    // The reason is short on purpose: the panel's row is about 50 cells and says `Code graph is off here · not a project`.
    if (holdsHome(directory, home)) return { state: "off", reason: "not a project" }
    try {
      return fileOverview({ graph: await indexer.graph({ cwd: directory, signal }), limit })
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return { state: "failed", reason: "cancelled" }
      return { state: "failed", reason: clip(errorMessage(error).replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").trim() || "unknown error", CODEGRAPH_OVERVIEW.reason) }
    }
  }
}
