import { createIndexer } from "./indexer"
import { fileOverview, type OverviewRequest } from "./overview"

/**
 * The host side of a hosted overview (`__codegraph-overview` in the compiled binary, `bun overview-host.ts` from source): reads one
 * request from stdin, brings the project's index up to date (and saves it) like the daemon's own indexer would, and writes the
 * overview as one JSON line. The index, the graph and their garbage leave with the process.
 */
export async function runOverviewHost() {
  const request = JSON.parse(await Bun.stdin.text()) as OverviewRequest
  const indexer = createIndexer({ cacheDir: request.cacheDir, now: Date.now, ...(request.maxFiles ? { maxFiles: request.maxFiles } : {}) })
  const graph = await indexer.graph({ cwd: request.cwd, signal: new AbortController().signal })
  const out = Bun.stdout.writer()
  out.write(`${JSON.stringify(fileOverview({ graph, limit: request.limit }))}\n`)
  await out.end()
}

if (import.meta.main) await runOverviewHost()
