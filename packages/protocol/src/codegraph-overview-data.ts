/**
 * The Galaxy panel's code mode (`codegraph.overview`, docs/sidebar.md): data and types only, so the thin terminal client and the daemon
 * share them. The reply is the project's most connected files and the import edges among them, bounded by the caps below.
 */

/** Hard caps of one `codegraph.overview` reply. A path longer than `path` is left out, never cut: a cut path could not be opened. */
export const CODEGRAPH_OVERVIEW = { files: 30, defaultFiles: 24, edges: 256, neighbours: 5, path: 240, reason: 200 } as const

/** One file of the overview. Every path is relative to the project directory, `/`-separated. */
export type CodegraphOverviewFile = {
  path: string
  /** Project files this file imports, and project files that import it (all of them, not only the ones listed here). */
  imports: number
  importedBy: number
  /** Call edges that cross this file's boundary, in either direction. */
  calls: number
  /** `imports + importedBy + calls`: what the files are ranked by. */
  degree: number
  symbols: number
  /** The most connected files it imports and is imported by, at most `CODEGRAPH_OVERVIEW.neighbours` each; they may be outside `files`. */
  topImports: string[]
  topImportedBy: string[]
}

export type CodegraphOverview =
  | {
      state: "ready"
      /** Most connected first, at most `CODEGRAPH_OVERVIEW.files`. */
      files: CodegraphOverviewFile[]
      /** Import edges among `files` as `[importer, imported]` indexes into it, at most `CODEGRAPH_OVERVIEW.edges`. */
      edges: Array<[number, number]>
      /** What the whole index holds. */
      total: { files: number; symbols: number }
      /** Import edges among `files` left out by the edge cap. */
      omittedEdges: number
      /** The index hit its file cap or skipped oversized or unreadable sources. */
      partial: boolean
      builtAt: number
    }
  /** Not a project (the home folder or above it) or the code graph is switched off: nothing was indexed. */
  | { state: "off"; reason: string }
  /** The build was tried and failed. */
  | { state: "failed"; reason: string }
