import type { CodeOverview, GraphAutopilot, GraphIndexMode, IndexStatus } from "@mendcode/codegraph"
import type { Tool } from "@mendcode/tools"
import { createIndexGate } from "../../codegraph/src/index-gate"
import { graphToolDefinitions } from "../../codegraph/src/tool-definitions"

/** The gate and tool schemas are light; one shared indexer loads only for a query or enabled autopilot. */
export function createLazyCodegraph(options: {
  cacheDir: string
  publish(status: IndexStatus): void
  mode(cwd: string): GraphIndexMode
  enabled(): boolean
  log(message: string): void
}) {
  const gate = createIndexGate()
  const gateOf = (cwd: string, signal?: AbortSignal) => gate.check({ cwd, mode: options.mode(cwd), signal })
  let loaded: { tools: Tool[]; overview: CodeOverview; autopilot: GraphAutopilot } | undefined
  let loading: Promise<NonNullable<typeof loaded>> | undefined
  let stopped = false
  const load = () => loading ??= import("@mendcode/codegraph").then(({ createIndexer, scanHostCommand, createCodeGraphTools, createCodeOverview, createGraphAutopilot, pruneCaches }) => {
    const indexer = createIndexer({ cacheDir: options.cacheDir, now: Date.now, onIndex: options.publish, onProgress: options.publish, scanHost: scanHostCommand() })
    const autopilot = createGraphAutopilot({ indexer, gate: gateOf, enabled: () => !stopped && options.enabled(), log: options.log })
    // Caches of folders that are gone (a finished PR review's worktree, a lane) or unused for a month are deleted: once a minute after the
    // graph is first used in this daemon, then daily. Nothing runs in a daemon that never uses the graph.
    const prune = () => { if (!stopped) void pruneCaches({ cacheDir: options.cacheDir, now: Date.now() }).then((result) => { if (result.removed) options.log(`[GRAPH]: pruned ${result.removed} cache file(s) (${result.orphaned} folder gone, ${result.idle} unused, ${result.temporary} temporary)`) }).catch(() => undefined) }
    setTimeout(() => { prune(); setInterval(prune, 86_400_000).unref?.() }, 60_000).unref?.()
    return loaded = { autopilot, overview: createCodeOverview({ indexer }), tools: createCodeGraphTools({ cacheDir: options.cacheDir, indexer, gate: gateOf, autopilot }) }
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
  return { gate, tools, autopilot, overview }
}
