import type { FormatterManager, LspManager } from "@mendcode/lsp"
import type { createAfterWrite } from "../../lsp/src/tool"
import type { Tool } from "@mendcode/tools"
import { lspToolDefinitions } from "../../lsp/src/tool-definitions"

/** Status and shutdown must not initialize a language service that nobody used. */
export function createLazyLsp(options: { cacheDir: string; warmUp: () => boolean }) {
  let manager: LspManager | undefined
  let loading: Promise<LspManager> | undefined
  let stopped = false
  const load = () => loading ??= import("../../lsp/src/manager").then(async ({ createLspManager }) => {
    manager = createLspManager({ cacheDir: options.cacheDir })
    if (stopped) await manager.stop()
    return manager
  })
  const lsp: LspManager = {
    query: async (input) => (await load()).query(input),
    diagnostics: async (input) => (await load()).diagnostics(input),
    workspaceSymbols: async (input) => manager?.workspaceSymbols(input) ?? { result: [] },
    live: async (input) => manager?.live(input),
    status: (cwd) => manager?.status?.(cwd) ?? [],
    running: () => manager?.running() ?? [],
    warm(input) {
      if (stopped || !input.paths.length) return
      if (manager) return manager.warm(input)
      // Like the real manager: read the live policy after the write's continuation, not during it.
      setTimeout(() => {
        try {
          if (stopped || input.enabled && !input.enabled()) return
          void load().then((service) => { if (!stopped) service.warm(input) }).catch(() => undefined)
        } catch { /* warm-up never fails a write */ }
      }, 0)
    },
    async stop() { stopped = true; await (loading ? (await loading).stop() : undefined) },
  }
  let formats: Promise<FormatterManager> | undefined
  let formatsStopped = false
  const loadFormatter = () => formats ??= import("../../lsp/src/formatter").then(async ({ createFormatterManager }) => {
    const service = createFormatterManager()
    if (formatsStopped) await service.stop()
    return service
  })
  const formatter: FormatterManager = {
    status: async (input) => (await loadFormatter()).status(input),
    file: async (input) => (await loadFormatter()).file(input),
    async stop() { formatsStopped = true; await (formats ? (await formats).stop() : undefined) },
  }
  let hook: ReturnType<typeof createAfterWrite> | undefined
  let hookLoading: Promise<ReturnType<typeof createAfterWrite>> | undefined
  const loadHook = () => hookLoading ??= import("../../lsp/src/tool").then(({ createAfterWrite }) => hook = createAfterWrite({ manager: lsp, formatter, budgetMs: 4_000, diagnosticsWaitMs: 300, warmUp: options.warmUp }))
  const afterWrite: ReturnType<typeof createAfterWrite> = Object.assign(
    async (input: Parameters<ReturnType<typeof createAfterWrite>>[0]) => (await loadHook())(input),
    { late: (sessionId?: string) => hook?.late(sessionId) },
  )
  let tools: Promise<{ lsp: Tool; diagnostics: Tool }> | undefined
  const loadTools = () => tools ??= import("../../lsp/src/tool").then(({ createLspTool, createDiagnosticsTool }) => ({ lsp: createLspTool(lsp), diagnostics: createDiagnosticsTool(lsp) }))
  const lspTool: Tool = { ...lspToolDefinitions.lsp, execute: async (input, context) => (await loadTools()).lsp.execute(input, context) }
  const diagnosticsTool: Tool = { ...lspToolDefinitions.diagnostics, execute: async (input, context) => (await loadTools()).diagnostics.execute(input, context) }
  return { lsp, formatter, afterWrite, lspTool, diagnosticsTool }
}
