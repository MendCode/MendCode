/**
 * The code graph's counts per project directory, as the daemon holds them for the footer (`codegraph` segment). The graph indexes lazily on
 * the first graph tool of a project and refreshes incrementally; the indexer calls `publish` only then, so a terminal learns the counts when
 * the index changes and is never asked per frame. A folder the index gate skips is published once as `skipped` with its reason. Nothing
 * here walks a project or reads a file.
 */
export type CodegraphStatus =
  | { directory: string; state: "indexing" | "indexed"; files: number; symbols: number; edges: number; partial: boolean }
  | { directory: string; state: "skipped"; reason: string }
type Incoming =
  | { cwd: string; state: "indexing" | "indexed" | "none"; files: number; symbols: number; edges: number; partial: boolean }
  | { cwd: string; state: "skipped"; reason: string }

/** Directories remembered at once; the least recently reported goes first. */
export const CODEGRAPH_STATUS_LIMIT = 64

export function createCodegraphStatus() {
  const latest = new Map<string, CodegraphStatus>()
  const listeners = new Set<(status: CodegraphStatus | { directory: string; state: "none" }) => void>()
  return {
    publish(incoming: Incoming) {
      const directory = incoming.cwd
      if (incoming.state === "none") {
        latest.delete(directory)
        for (const listener of listeners) listener({ directory, state: "none" })
        return
      }
      const status: CodegraphStatus = incoming.state === "skipped" ? { directory, state: "skipped", reason: incoming.reason } : { directory, state: incoming.state, files: incoming.files, symbols: incoming.symbols, edges: incoming.edges, partial: incoming.partial }
      latest.delete(directory)
      latest.set(directory, status)
      while (latest.size > CODEGRAPH_STATUS_LIMIT) latest.delete(latest.keys().next().value as string)
      for (const listener of listeners) listener(status)
    },
    /** The last status of one directory, if any. */
    get: (directory: string): CodegraphStatus | undefined => latest.get(directory),
    /** What a client that just connected is told. */
    snapshot: (): CodegraphStatus[] => [...latest.values()],
    subscribe(listener: (status: CodegraphStatus | { directory: string; state: "none" }) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
export type CodegraphStatusHub = ReturnType<typeof createCodegraphStatus>
