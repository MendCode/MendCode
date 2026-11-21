import { resolve } from "node:path"
import type { CodeOverview, GraphAutopilot, GraphIndexMode, Indexer, IndexStatus, SearchHint } from "@mendcode/codegraph"
import type { Tool } from "@mendcode/tools"
import { createIndexGate } from "../../codegraph/src/index-gate"
import { graphToolDefinitions } from "../../codegraph/src/tool-definitions"

/** The gate and tool schemas are light; one shared indexer loads only for a query or enabled autopilot. */
export function createLazyCodegraph(options: {
  cacheDir: string
  publish(status: IndexStatus): void
  mode(cwd: string): GraphIndexMode
  enabled(): boolean
  /** Whether a text search gets the graph's answer for its identifiers (feature `codegraph`); absent: never. */
  searchOn?(): boolean
  /** What one such answer may take (default: codegraph's `SEARCH_HINT.budgetMs`); tests on a loaded machine give more. */
  searchBudgetMs?: number
  log(message: string): void
}) {
  const gate = createIndexGate()
  const gateOf = (cwd: string, signal?: AbortSignal) => gate.check({ cwd, mode: options.mode(cwd), signal })
  let loaded: { tools: Tool[]; overview: CodeOverview; autopilot: GraphAutopilot; indexer: Indexer } | undefined
  let loading: Promise<NonNullable<typeof loaded>> | undefined
  let stopped = false
  const load = () => loading ??= import("@mendcode/codegraph").then(({ createIndexer, scanHostCommand, createCodeGraphTools, createCodeOverview, createGraphAutopilot, pruneCaches }) => {
    const indexer = createIndexer({ cacheDir: options.cacheDir, now: Date.now, onIndex: options.publish, onProgress: options.publish, scanHost: scanHostCommand() })
    const autopilot = createGraphAutopilot({ indexer, gate: gateOf, enabled: () => !stopped && options.enabled(), log: options.log })
    // Caches of folders that are gone (a finished PR review's worktree, a lane) or unused for a month are deleted: once a minute after the
    // graph is first used in this daemon, then daily. Nothing runs in a daemon that never uses the graph.
    const prune = () => { if (!stopped) void pruneCaches({ cacheDir: options.cacheDir, now: Date.now() }).then((result) => { if (result.removed) options.log(`[GRAPH]: pruned ${result.removed} cache file(s) (${result.orphaned} folder gone, ${result.idle} unused, ${result.temporary} temporary)`) }).catch(() => undefined) }
    setTimeout(() => { prune(); setInterval(prune, 86_400_000).unref?.() }, 60_000).unref?.()
    return loaded = { indexer, autopilot, overview: createCodeOverview({ indexer }), tools: createCodeGraphTools({ cacheDir: options.cacheDir, indexer, gate: gateOf, autopilot }) }
  })
  const autopilot: GraphAutopilot = {
    note(input) {
      if (stopped || !options.enabled()) return
      void load().then((service) => { if (!stopped) service.autopilot.note(input) }).catch(() => undefined)
    },
    need: async (input) => stopped || !options.enabled() ? { ready: true } : (await load()).autopilot.need(input),
    state: (cwd) => loaded?.autopilot.state(cwd) ?? "none",
    async idle(cwd) { await (loading ? (await loading).autopilot.idle(cwd) : undefined) },
    reconsider: () => loaded?.autopilot.reconsider(),
    stop() { stopped = true; loaded?.autopilot.stop() },
  }
  const tools: Tool[] = Object.values(graphToolDefinitions).map((definition) => ({
    ...definition,
    async execute(input, context) {
      const tool = (await load()).tools.find((tool) => tool.name === definition.name)!
      return tool.execute(input, context)
    },
  }))
  const overview: CodeOverview = async (input) => (await load()).overview(input)
  let hints: Promise<(input: { cwd: string; terms: readonly string[] }) => Promise<SearchHint | undefined>> | undefined
  /**
   * The graph's answer for the identifiers of one text search (docs/code-graph.md, "Graph answers in a text search"): a shell command
   * that runs grep or rg, or a search tool's `pattern`. Three steps, each loading only what it needs: the command is tested for a
   * search word here, its identifiers are read by a module with no imports, and the indexer loads only when they name something in a
   * folder that already has a cache file. Nothing is built, walked or scanned, and the answer is dropped when it is not there in time.
   */
  async function searchHint(input: { cwd: string; command?: string | undefined; pattern?: string | undefined }): Promise<SearchHint | undefined> {
    if (stopped || !options.searchOn?.()) return undefined
    if (input.pattern === undefined && (input.command === undefined || !SEARCH_WORD.test(input.command))) return undefined
    try {
      const { patternTerms, searchPlan } = await import("../../codegraph/src/search-terms")
      const plan = input.pattern !== undefined ? { terms: patternTerms(input.pattern), directories: [] as string[] } : searchPlan(input.command ?? "")
      if (!plan.terms.length || !plan.directories) return undefined
      const { terms } = plan
      // The search reads the folder a `cd` or `git -C` moved it to, not the one the command started in: the graph is that folder's.
      const cwd = plan.directories.reduce((from, directory) => resolve(from, directory), input.cwd)
      hints ??= import("../../codegraph/src/search-hint").then(({ createSearchHints }) => createSearchHints({
        cacheDir: options.cacheDir,
        indexer: async () => (await load()).indexer,
        allowed: (root) => gate.peek({ cwd: root, mode: options.mode(root) })?.index !== false,
        budgetMs: options.searchBudgetMs,
      }))
      return await (await hints)({ cwd, terms })
    } catch {
      return undefined
    }
  }
  return { gate, tools, autopilot, overview, searchHint }
}

/** A command line that may hold a text search; the parser (codegraph's search-terms.ts) is loaded only past this test. */
const SEARCH_WORD = /(?:grep|\brg|\bag|\back)\b/
