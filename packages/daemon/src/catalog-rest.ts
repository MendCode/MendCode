import type { CatalogRestInput, RestTool } from "@mendcode/protocol"
import type { EnginePort } from "@mendcode/kernel"
import type { McpControl } from "./daemon"
import type { ProviderService } from "./providers"
import type { ProviderAuthService } from "./provider-auth"
import type { DaemonExtensions } from "./extensions"
import type { ModelCatalog } from "./models"

export class CatalogRestError extends Error {
  constructor(readonly code: "unsupported" | "invalid_command" | "target_mismatch" | "busy", message: string) { super(message) }
}

const DNS_NAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
/** GitHub Enterprise domain (or a loopback fake origin) to the Copilot API endpoint the provider calls. */
function copilotEnterpriseApi(value: string) {
  let url: URL
  try { url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`) } catch { throw new CatalogRestError("invalid_command", "Invalid enterprise URL") }
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, "")) throw new CatalogRestError("invalid_command", "Invalid enterprise URL")
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return url.origin
  if (url.protocol !== "https:" || url.port || !DNS_NAME.test(url.hostname)) throw new CatalogRestError("invalid_command", "Enterprise URL must be an HTTPS domain")
  return `https://copilot-api.${url.hostname}`
}
const METADATA_KEYS: Record<string, readonly string[]> = { azure: ["resourceName"], "cloudflare-workers-ai": ["accountId"], "cloudflare-ai-gateway": ["accountId", "gatewayId"] }
/** v1 API-credential metadata mapped to the native public provider settings that hold the same routing values. */
function apiMetadata(type: string | undefined, provider: string, metadata: Record<string, string> | undefined): Record<string, unknown> {
  const entries = Object.entries(metadata ?? {})
  if (!entries.length) return {}
  const kind = type === "azure" ? "azure" : provider
  const allowed = METADATA_KEYS[kind]
  if (!allowed || entries.some(([key]) => !allowed.includes(key))) throw new CatalogRestError("invalid_command", "Unsupported credential metadata for this provider")
  const value = Object.fromEntries(entries)
  return kind === "azure" ? { azure: value } : kind === "cloudflare-workers-ai" ? { cloudflareWorkersAi: value } : { cloudflareAiGateway: value }
}

/** Reuses native services; donor-shaped HTTP is only a projection of this full-authority command. */
export function createCatalogRest(options: {
  providers?: ProviderService | undefined
  auth: ProviderAuthService
  extensions: DaemonExtensions
  catalog: ModelCatalog
  engine: EnginePort
  mcp?: McpControl | undefined
  lsp?: { status?(directory: string): import("@mendcode/protocol").RestLspStatus[] } | undefined
  commands(directory: string): Promise<unknown[]>
  changed(directory: string, server: string): void
}) {
  const pending = new Map<string, { method: number; flowId?: string; expires: number; provider: string }>()
  const keyOf = (directory: string, provider: string) => `${directory}\0${provider}`
  const unsupported = (message: string): never => { throw new CatalogRestError("unsupported", message) }
  async function methods(directory: string) {
    const native = options.auth.methods()
    const result: Record<string, Array<{ type: "api" | "oauth"; label: string; prompts?: unknown[] }>> = Object.fromEntries(Object.entries(native).map(([provider, entries]) => [provider, entries.map(({ type, label }) => ({ type, label }))]))
    for (const entry of await options.extensions.authMethods(directory)) result[entry.provider] = entry.methods.map(({ type, label, prompts }) => ({ type, label, prompts }))
    return result
  }
  async function providerList(directory: string) {
    const inventory = options.providers?.inventory?.() ?? []
    const configured = options.providers?.list() ?? []
    const available = options.providers?.catalog?.() ?? configured
    const catalog = options.catalog.list()
    const subscription = options.auth.chatgpt.status()
    const all = inventory.map((entry) => {
      const config = available.find((value) => value.id === entry.id)
      const models = config?.models ?? catalog.filter((model) => model.provider === entry.id).map((model) => ({ ...model, id: model.id.startsWith(`${entry.id}:`) ? model.id.slice(entry.id.length + 1) : model.id }))
      return { id: entry.id, name: entry.name, source: config?.source ?? "config", env: entry.requiredEnv, options: {}, models: Object.fromEntries(models.map((model) => [model.id, { ...model, providerID: entry.id }])), configured: entry.configured, enabled: entry.enabled && entry.authReady }
    })
    const pluginAuth = await options.extensions.authMethods(directory)
    const pluginModels = await options.extensions.providerModels(directory)
    for (const id of new Set([...pluginAuth.map((entry) => entry.provider), ...pluginModels.flatMap((entry) => entry.provider ? [entry.provider] : [])])) {
      const owned = pluginAuth.find((entry) => entry.provider === id)
      const models = Object.fromEntries(pluginModels.filter((entry) => entry.provider === id).map((entry) => [entry.id.slice(id.length + 1), { ...entry, id: entry.id.slice(id.length + 1), providerID: id }]))
      const existing = all.find((entry) => entry.id === id)
      if (existing) { existing.models = { ...existing.models, ...models }; existing.configured ||= Boolean(owned?.authenticated); existing.enabled ||= Boolean(owned?.authenticated) }
      else all.push({ id, name: id, source: "config", env: [], options: {}, models, configured: true, enabled: Boolean(owned?.authenticated) })
    }
    const models = catalog.filter((entry) => !entry.provider && !entry.engine)
    if (models.length) all.push({ id: "chatgpt", name: "ChatGPT", source: "config", env: [], options: {}, models: Object.fromEntries(models.map((model) => [model.id, { ...model, providerID: "chatgpt" }])), configured: subscription.state === "authorized", enabled: subscription.state === "authorized" })
    const connected = all.filter((entry) => entry.enabled).map((entry) => entry.id)
    const defaults = Object.fromEntries(all.flatMap((entry) => {
      const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]
      const model = Object.keys(entry.models).sort((a, b) => priority.findIndex((name) => b.includes(name)) - priority.findIndex((name) => a.includes(name)) || Number(!a.includes("latest")) - Number(!b.includes("latest")) || b.localeCompare(a))[0]
      return model ? [[entry.id, model]] : []
    }))
    return { all, default: defaults, connected }
  }
  async function oauth(directory: string, input: Extract<CatalogRestInput, { operation: "oauth-authorize" | "oauth-callback" }>, signal: AbortSignal) {
    const key = keyOf(directory, input.provider)
    for (const [id, flow] of pending) if (flow.expires <= Date.now()) pending.delete(id)
    if (input.operation === "oauth-callback") {
      const flow = pending.get(key)
      if (!flow || flow.method !== input.method) throw new CatalogRestError("invalid_command", "No pending provider authorization for this method")
      try {
        if (flow.flowId) {
          const result = await options.extensions.authComplete(directory, flow.flowId, input.code)
          if (!result.authenticated) throw new CatalogRestError("invalid_command", "Provider authorization failed")
        } else {
          if (input.code) {
            if (flow.provider === "github-copilot") throw new CatalogRestError("invalid_command", "Device authorization does not accept a code")
            await options.auth.chatgpt.complete(input.code)
          }
          const deadline = Date.now() + 55_000
          while (true) {
            signal.throwIfAborted()
            const status = flow.provider === "github-copilot" ? options.auth.copilot.status() : options.auth.chatgpt.status()
            if (status.state === "authorized") break
            if (status.state !== "pending") throw new CatalogRestError("invalid_command", "Provider authorization failed or cancelled")
            if (Date.now() >= deadline) throw new CatalogRestError("busy", "Provider authorization still pending; retry callback")
            await Bun.sleep(25)
          }
        }
        pending.delete(key)
        return { value: true }
      } catch (error) {
        if (!(error instanceof CatalogRestError && error.code === "busy")) pending.delete(key)
        throw error
      }
    }
    if (pending.has(key)) throw new CatalogRestError("busy", "Provider authorization already pending")
    if (pending.size >= 32) throw new CatalogRestError("busy", "Provider authorization limit")
    const plugin = (await options.extensions.authMethods(directory)).find((entry) => entry.provider === input.provider)
    const method = plugin ? plugin.methods[input.method] : options.auth.methods()[input.provider]?.[input.method]
    if (!method || method.type !== "oauth") throw new CatalogRestError("invalid_command", "Choose an OAuth method")
    if (pending.has(key)) throw new CatalogRestError("busy", "Provider authorization already pending")
    const flow = { method: input.method, expires: Date.now() + 10 * 60_000, provider: input.provider }
    pending.set(key, flow)
    try {
      if (plugin) {
        const result = await options.extensions.authStart(directory, input.provider, input.method, input.inputs ?? {})
        if (!("flowId" in result) || !result.flowId || !result.url) throw new CatalogRestError("invalid_command", "Provider authorization did not start")
        pending.set(key, { method: input.method, flowId: result.flowId, expires: Date.now() + 10 * 60_000, provider: input.provider })
        return { value: { url: result.url, method: result.method, instructions: result.instructions } }
      }
      if (!("id" in method) || !("available" in method) || !method.available) return unsupported("Provider OAuth adapter unavailable or not configured")
      const result = await options.auth.authorize(input.provider, method.id, false)
      pending.set(key, { method: input.method, expires: result.expiresAt, provider: input.provider })
      return { value: { url: result.url, method: "auto", instructions: result.instructions } }
    } catch (error) {
      pending.delete(key)
      throw error
    }
  }
  return {
    async run(directory: string, input: CatalogRestInput, signal: AbortSignal): Promise<Record<string, unknown>> {
      signal.throwIfAborted()
      if (input.operation === "providers" || input.operation === "config-providers") {
        const result = await providerList(directory)
        return { value: input.operation === "providers" ? result : { providers: result.all.filter((entry) => entry.configured), default: Object.fromEntries(Object.entries(result.default).filter(([id]) => result.all.some((entry) => entry.id === id && entry.configured))) } }
      }
      if (input.operation === "commands") return { value: await options.commands(directory) }
      if (input.operation === "auth-methods") return { value: await methods(directory) }
      if (input.operation === "lsp") return { value: options.lsp?.status?.(directory) ?? [] }
      if (input.operation === "tools" || input.operation === "tool-ids") {
        if (!options.engine.catalogTools) return unsupported("Tool catalog requires a native engine")
        if (input.operation === "tools" && (!input.provider || !input.model)) throw new CatalogRestError("invalid_command", "Provider and model required")
        const catalog = [...options.catalog.list(), ...await options.extensions.providerModels(directory)]
        const model = input.model ? catalog.find((entry) => entry.id === `${input.provider}:${input.model}` || entry.id === input.model && (entry.provider === input.provider || !entry.provider && input.provider === "chatgpt")) : undefined
        if (input.model && !model) throw new CatalogRestError("invalid_command", "Unknown provider/model")
        if (model?.engine) return unsupported("External engine owns its tool catalog")
        const tools: RestTool[] = model?.tool_call === false ? [] : await options.engine.catalogTools({ directory, ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}) })
        return { value: input.operation === "tool-ids" ? tools.map((tool) => tool.id) : tools }
      }
      if (input.operation === "oauth-authorize" || input.operation === "oauth-callback") return oauth(directory, input, signal)
      if (input.operation === "auth-set") {
        const credential = input.credential
        if (credential.type === "wellknown") {
          // Stored privately as an environment-style credential; a configured provider is pointed at it, never at the process environment.
          try { options.auth.metadata.set({ provider: input.provider, env: credential.key, token: credential.token }) }
          catch { throw new CatalogRestError("invalid_command", "Invalid well-known credential") }
          if (options.providers?.inventory?.().some((entry) => entry.id === input.provider) && !options.providers.set({ id: input.provider, apiKeyEnv: credential.key }).ok) throw new CatalogRestError("invalid_command", "Provider rejected the well-known credential")
          pending.delete(keyOf(directory, input.provider))
          return { value: true }
        }
        const plugin = (await options.extensions.authMethods(directory)).find((entry) => entry.provider === input.provider)
        if (plugin) {
          if (credential.type === "api" && credential.metadata && Object.keys(credential.metadata).length || credential.type === "oauth" && credential.enterpriseUrl) return unsupported("Credential metadata requires a provider adapter")
          options.extensions.authSet(input.provider, credential.type === "api" ? { type: "api", key: credential.key } : { type: "oauth", access: credential.access, refresh: credential.refresh, expires: credential.expires, ...(credential.accountId ? { accountId: credential.accountId } : {}) })
        }
        else if (credential.type === "oauth" && ["chatgpt", "openai"].includes(input.provider)) {
          if (credential.enterpriseUrl) return unsupported("Enterprise OAuth requires a provider adapter")
          options.auth.chatgpt.setCredential(credential)
        }
        else if (credential.type === "oauth" && ["github-copilot", "github-copilot-enterprise"].includes(input.provider)) {
          const endpoint = credential.enterpriseUrl ? copilotEnterpriseApi(credential.enterpriseUrl) : undefined
          try { options.auth.copilot.setCredential({ access: credential.access, ...(!endpoint && credential.refresh && credential.refresh !== credential.access ? { refresh: credential.refresh } : {}), expires: credential.expires }) }
          catch { throw new CatalogRestError("invalid_command", "Copilot credential rejected") }
          if (options.providers) {
            const result = options.providers.set({ id: "github-copilot", enabled: true, ...(endpoint ? { baseUrl: endpoint } : {}) })
            if (!result.ok) throw new CatalogRestError("invalid_command", "Copilot endpoint rejected")
          }
        }
        else if (credential.type === "api" && options.providers) {
          const adapter = options.providers.inventory?.().find((entry) => entry.id === input.provider)
          const set = { id: input.provider, apiKey: credential.key, ...apiMetadata(adapter?.type, input.provider, credential.metadata) }
          const result = options.providers.set(set)
          if (!result.ok) throw new CatalogRestError("invalid_command", "Provider credential rejected; configure the provider first")
        } else return unsupported("Credential adapter unavailable for this provider/type")
        pending.delete(keyOf(directory, input.provider))
        return { value: true }
      }
      if (input.operation === "auth-remove") {
        if (["chatgpt", "openai"].includes(input.provider)) options.auth.chatgpt.logout()
        if (["github-copilot", "github-copilot-enterprise"].includes(input.provider)) options.auth.copilot.logout()
        options.auth.metadata.remove(input.provider)
        if (options.providers?.list().some((entry) => entry.id === input.provider)) options.providers.set({ id: input.provider, apiKey: "" })
        options.extensions.authRemove(input.provider)
        pending.delete(keyOf(directory, input.provider))
        return { value: true }
      }
      if ("server" in input) {
        const mcp = options.mcp
        if (!mcp) return unsupported("MCP control unavailable")
        const target = { directory, server: input.server }
        let server
        if (input.operation === "mcp-connect") server = await (mcp.connect?.(target) ?? mcp.restart(target))
        else if (input.operation === "mcp-disconnect") server = mcp.disconnect ? await mcp.disconnect(target) : unsupported("MCP disconnect unavailable")
        else if (input.operation === "mcp-callback") server = mcp.finishAuth ? await mcp.finishAuth({ ...target, code: input.code }) : unsupported("MCP OAuth callback unavailable")
        else if (input.operation === "mcp-authenticate") {
          if (!mcp.startAuth) return unsupported("MCP OAuth unavailable")
          const pending = (await mcp.status(directory)).servers.find((server) => server.name === input.server)?.auth === "pending"
          if (pending && mcp.waitAuth) {
            server = await mcp.waitAuth({ ...target, signal: AbortSignal.any([signal, AbortSignal.timeout(55_000)]) })
            options.changed(directory, input.server)
            return { value: server }
          }
          const started = await mcp.startAuth(target)
          options.changed(directory, input.server)
          void started.completion.then(() => options.changed(directory, input.server), () => options.changed(directory, input.server))
          return { authorization: started.url }
        }
        options.changed(directory, input.server)
        if (input.operation === "mcp-connect" && server?.state !== "running") throw new CatalogRestError("invalid_command", "MCP connection failed; inspect status")
        return { value: input.operation === "mcp-connect" || input.operation === "mcp-disconnect" ? true : server }
      }
      throw new CatalogRestError("invalid_command", "Unknown catalog operation")
    },
  }
}
