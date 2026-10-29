import type { CommandInput, CommandReply } from "@mendcode/client"
import type { GlobalEvent } from "@mendcode/protocol"
import { parseAutomation, runAutomation, type AutomationDeps } from "../src/automation"
import { createCatalogPrompt } from "../src/catalog-prompts"
import type { CatalogPrompt } from "../src/catalog-automation"
import type { Line } from "../src/ui/theme"

export const CATALOG_MODELS = { engine: "native", selectable: true, models: [
  { id: "gpt-6-luna", name: "GPT-6 Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 272000 },
  { id: "openrouter:google/gemini-3-pro", name: "Gemini 3 Pro", provider: "openrouter", efforts: [], contextWindow: 1000000 },
  { id: "ollama:llama3:8b", name: "Llama 3", provider: "ollama", efforts: [] },
], defaults: { model: "gpt-6-luna" }, roles: {} }
export const CATALOG_PROVIDERS = { providers: [
  { id: "openrouter", name: "OpenRouter", type: "openai-compatible", configured: true, enabled: true, authReady: true, authMode: "api-key", models: 1, requiredEnv: ["OPENROUTER_API_KEY"], presentEnv: ["OPENROUTER_API_KEY"], credentialStored: true },
  { id: "ollama", name: "Ollama", type: "openai-compatible", configured: true, enabled: true, authReady: true, authMode: "api-key", models: 1, requiredEnv: [], presentEnv: [], credentialStored: false },
  { id: "chatgpt", name: "ChatGPT", type: "native", configured: true, enabled: true, authReady: true, authMode: "chatgpt-subscription-oauth", models: 1, requiredEnv: [], presentEnv: [], credentialStored: false },
], callsProviders: false, secretsPrinted: false }
export const CATALOG_MCP = { servers: [
  { name: "local", command: "bun /tmp/tools.ts", enabled: true, state: "stopped", tools: 0, stderr: [] },
  { name: "docs", command: "https://docs.example/mcp", transport: "remote", enabled: true, state: "stopped", auth: "none", tools: 0, stderr: [] },
  { name: "expired", command: "https://expired.example/mcp", transport: "remote", enabled: true, state: "stopped", auth: "none", authStored: true, authExpiresAt: 1, tools: 0, stderr: [] },
  { name: "off", command: "https://off.example/mcp", transport: "remote", enabled: false, state: "stopped", tools: 0, stderr: [] },
] }

export function catalogHarness(options: { send?(command: CommandInput): CommandReply | Promise<CommandReply>; prompts?: (string | undefined)[] } = {}) {
  const sent: CommandInput[] = []
  const out: string[] = [], err: string[] = [], prompts: CatalogPrompt[] = []
  let global: ((event: GlobalEvent) => void) | undefined
  let interrupt: (() => void) | undefined
  const deps: AutomationDeps = {
    cwd: "/work/catalog", now: () => 100000, out: { write: (text) => { out.push(text) } }, err: { write: (text) => { err.push(text) } }, listen: () => {},
    listenGlobal: (handler) => { global = handler }, onInterrupt: (handler) => { interrupt = handler },
    ...(options.prompts ? { prompt: async (request: CatalogPrompt) => { prompts.push(request); return options.prompts!.shift() } } : {}),
    client: { subscribe: async () => ({ ok: true }), send: async (command) => {
      sent.push(command)
      if (options.send) return options.send(command)
      const result = command.type === "models.list" ? CATALOG_MODELS
        : command.type === "providers.catalog" ? CATALOG_PROVIDERS
        : command.type === "providers.list" ? { providers: [{ id: "openrouter", enabled: true, models: [{ id: "google/gemini-3-pro" }] }, { id: "ollama", enabled: true, models: [{ id: "llama3:8b" }] }] }
        : command.type === "providers.test" ? { ok: true, latencyMs: 1, model: command.model }
        : command.type === "mcp.status" ? { ...CATALOG_MCP, issues: [] }
        : command.type === "mcp.add" ? { name: command.name, path: "/tmp/project/.mendcode/mcp.json", writesConfig: !command.dryRun }
        : command.type === "models.config.get" || command.type === "models.default.set" ? { engine: "native", selectable: true, roles: {}, defaults: { model: "gpt-6-luna" }, effective: { main: { model: "gpt-6-luna" } }, failures: [], warnings: [], presets: [{ name: "openai-codex-subscription-gpt-6-astra", provider: "openai", model: "gpt-6-astra", authMode: "chatgpt-subscription-oauth", available: false }] }
        : {}
      return { ok: true, result }
    } },
  }
  return { deps, sent, out, err, prompts, push: (event: GlobalEvent) => global?.(event), interrupt: () => interrupt?.(), hasGlobal: () => Boolean(global),
    run: async (args: string[]) => { const parsed = parseAutomation(args); if (parsed.ok !== true) throw new Error(JSON.stringify(parsed)); return runAutomation(parsed.command, deps) },
  }
}

export function catalogPromptHarness(request: CatalogPrompt, width = 100, height = 30) {
  const frames: Line[][] = []
  let value: string | undefined, finished = false, cursor: { row: number; col: number } | undefined
  const app = createCatalogPrompt({ request, size: () => ({ width, height }), draw: (rows, nextCursor) => { frames.push(rows); cursor = nextCursor }, finish: (next) => { value = next; finished = true } })
  app.render()
  return { app, frames, text: () => frames.at(-1)!.map((line) => line.map((span) => span.text).join("")), value: () => value, finished: () => finished, cursor: () => cursor }
}
