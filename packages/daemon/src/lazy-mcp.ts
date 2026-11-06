import type { LoadedMcpConfig, McpManager } from "@mendcode/mcp"

/** Empty catalog/status probes at the prompt need config, not clients, transports or OAuth. */
export function createLazyMcp(options: {
  configLoader(directory: string): Promise<LoadedMcpConfig> | LoadedMcpConfig
  load(configLoader: (directory: string) => Promise<LoadedMcpConfig> | LoadedMcpConfig): Promise<McpManager>
}): McpManager {
  let manager: McpManager | undefined
  let loading: Promise<McpManager> | undefined
  const configs = new Map<string, Promise<LoadedMcpConfig>>()
  const configLoader = (directory: string) => {
    let config = configs.get(directory)
    if (!config) {
      config = Promise.resolve(options.configLoader(directory))
      configs.set(directory, config)
      void config.catch(() => { if (configs.get(directory) === config) configs.delete(directory) })
    }
    return config
  }
  const load = () => loading ??= options.load((directory) => {
    const cached = configs.get(directory)
    configs.delete(directory)
    return cached ?? options.configLoader(directory)
  }).then((value) => manager = value)
  async function configured(directory: string, fresh = false) {
    if (loading) return { manager: await loading }
    if (fresh) configs.delete(directory)
    const config = await configLoader(directory)
    return Object.keys(config.servers).length || config.blocked?.length ? { manager: await load() } : { config }
  }
  return {
    async status(directory) { const ready = await configured(directory, true); return ready.manager ? ready.manager.status(directory) : { servers: [], issues: ready.config!.errors } },
    async catalog(directory) { const ready = await configured(directory); return ready.manager ? ready.manager.catalog(directory) : { resources: [], templates: [], prompts: [], issues: ready.config!.errors } },
    async listTools(directory) { const ready = await configured(directory); return ready.manager ? ready.manager.listTools(directory) : { tools: [], issues: ready.config!.errors } },
    async listPrompts(directory) { const ready = await configured(directory); return ready.manager ? ready.manager.listPrompts(directory) : { prompts: [], issues: ready.config!.errors } },
    cachedPrompts: (directory) => manager?.cachedPrompts(directory) ?? [],
    running: () => manager?.running() ?? [],
    async invalidate(directory) {
      // The real manager drops every config even when only one directory's clients are reconciled.
      configs.clear()
      await (loading ? (await loading).invalidate(directory) : undefined)
    },
    async stop() { await (loading ? (await loading).stop() : undefined) },
    async suspend(input) { configs.clear(); await (loading ? (await loading).suspend(input) : undefined) },
    connect: async (input) => (await load()).connect!(input),
    disconnect: async (input) => (await load()).disconnect!(input),
    finishAuth: async (input) => (await load()).finishAuth!(input),
    waitAuth: async (input) => (await load()).waitAuth!(input),
    readResource: async (input) => (await load()).readResource(input),
    getPromptResult: async (input) => (await load()).getPromptResult(input),
    debug: async (input) => (await load()).debug(input),
    getPrompt: async (input) => (await load()).getPrompt(input),
    callTool: async (input) => (await load()).callTool(input),
    restart: async (input) => (await load()).restart(input),
    startAuth: async (input) => (await load()).startAuth(input),
    cancelAuth: async (input) => (await load()).cancelAuth(input),
    forgetAuth: async (input) => (await load()).forgetAuth(input),
  }
}
