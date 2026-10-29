import type { CommandInput } from "@mendcode/client"
import type { McpConfigInput, McpStatusReport, ModelInfo, ModelsConfigReport, ModelsReport, ProviderAdapter, ProviderInfo, ProvidersCatalogReport, ProviderAuthMethod } from "@mendcode/protocol"
import type { AutomationDeps, Common } from "./automation"
import type { CatalogAutomation } from "./catalog-args"
import { modelRef } from "@mendcode/protocol/wire"
import { createProviderAuthAutomation } from "./provider-auth-automation"

export type CatalogPrompt = { title: string; label: string; options?: { value: string; label: string; hint?: string }[]; secret?: boolean; optional?: boolean; initial?: string; multiple?: boolean; bordered?: boolean; validate?(text: string): string | undefined }
type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; message: string; code: string }
export type CatalogContext = AutomationDeps & { directory: string; request(command: CommandInput): Promise<Reply>; result(data: Record<string, unknown>, human: string): number; fail(message: string, exit?: number, code?: string): number }
class Cancelled extends Error {}
class Usage extends Error {}
const lines = (rows: string[]) => rows.length ? `${rows.join("\n")}\n` : ""
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
const pretty = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`

export function modelReference(model: ModelInfo) {
  const provider = model.provider ?? model.engine ?? "chatgpt"
  const id = model.provider ? model.id.slice(model.provider.length + 1) : model.id
  return { provider, id, ref: modelRef(model) }
}

export function mcpRows(report: McpStatusReport) {
  const rows = report.servers.map((server) => `${server.name}  ${server.needsTrust ? "needs trust" : server.enabled ? server.state : "disabled"}  ${server.tools} tools${server.auth ? `  OAuth: ${server.authExpiresAt !== undefined && server.authExpiresAt <= Date.now() ? "expired" : server.auth}` : ""}\n  ${clean(server.command)}${server.lastError ? `\n  ${clean(server.lastError)}` : ""}`)
  rows.push(...report.issues.map((issue) => `${issue.server ?? issue.source}: ${clean(issue.message)}`))
  return lines(rows.length ? rows : ["No MCP servers configured"])
}

/** All catalog actions go through the daemon; prompts are an injectable terminal surface. */
export function createCatalogAutomation(ctx: CatalogContext) {
  const auth = createProviderAuthAutomation(ctx)
  return async (command: CatalogAutomation & Common): Promise<number> => {
    const { request, result, fail, directory } = ctx
    const ask = async (prompt: CatalogPrompt) => {
      if (command.json || !ctx.prompt) throw new Usage(`interactive ${prompt.label.toLowerCase()} needs a terminal or explicit arguments`)
      const value = await ctx.prompt(prompt)
      if (value === undefined) throw new Cancelled()
      const problem = prompt.validate?.(value)
      if (problem) throw new Usage(problem)
      return value
    }
    try {
      if (command.kind === "catalog.auth") return auth.run(command)
      if (command.kind === "catalog.models") {
        const before = await request({ type: "models.list" })
        if (!before.ok) return fail(before.message, 1, before.code)
        let report = before.result as unknown as ModelsReport
        if (command.provider && !command.refresh && !report.models.some((entry) => modelReference(entry).provider === command.provider)) return fail(`Provider not found: ${command.provider}`)
        const refreshed: string[] = []
        if (command.refresh) {
          const found = await request({ type: "providers.list" })
          if (!found.ok) return fail(found.message, 1, found.code)
          const providers = (found.result.providers as ProviderInfo[]).filter((provider) => provider.enabled && (!command.provider || command.provider === provider.id))
          if (!providers.length) return fail("no refreshable API provider; subscription catalogs are read from the adapter's cache", 1, "unsupported")
          for (const provider of providers) {
            const reply = await request({ type: "providers.refresh", provider: provider.id })
            if (!reply.ok) return fail(reply.message, 1, reply.code)
            refreshed.push(provider.id)
          }
          const after = await request({ type: "models.list" })
          if (!after.ok) return fail(after.message, 1, after.code)
          report = after.result as unknown as ModelsReport
        }
        const models = report.models.filter((model) => !command.provider || modelReference(model).provider === command.provider).sort((a, b) => modelReference(a).ref.localeCompare(modelReference(b).ref))
        return result({ models: models.map((model) => ({ ...model, reference: modelReference(model).ref })), refreshed }, lines(models.map((model) => `${modelReference(model).ref}${command.verbose ? `\n${JSON.stringify(model, null, 2)}` : ""}`)))
      }
      if (command.kind === "catalog.models.control") {
        const reply = await request(command.operation === "set-default" ? { type: "models.default.set", directory, provider: command.provider!, model: command.model!, ...(command.authMode ? { authMode: command.authMode } : {}), dryRun: command.dryRun }
          : command.operation === "use-preset" ? { type: "models.default.set", directory, preset: command.preset!, dryRun: command.dryRun } : { type: "models.config.get", directory })
        if (!reply.ok) return fail(reply.message, 1, reply.code)
        const report = reply.result as unknown as ModelsConfigReport
        const data = command.operation === "presets" ? { presets: report.presets } : command.operation === "status" ? { engine: report.engine, selectable: report.selectable, configuredRoles: report.roles, effective: report.effective, warnings: report.warnings } : reply.result
        const code = result(data, pretty(data))
        return command.operation === "plan" && report.failures.length ? 1 : code
      }
      if (command.kind === "catalog.providers") {
        if (command.url) {
          const url = new URL(command.url)
          if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.protocol !== "https:") return fail("Provider metadata login needs https, or a loopback URL", 1, "unsupported")
          const reply = await request({ type: "providers.auth.metadata", url: command.url, execute: command.execute })
          return reply.ok ? result(reply.result, pretty(reply.result)) : fail(reply.message, 1, reply.code)
        }
        const listed = await request({ type: "providers.catalog" })
        if (!listed.ok) return fail(listed.message, 1, listed.code)
        const report = listed.result as unknown as ProvidersCatalogReport
        let providers = report.providers.filter((provider) => !command.provider || provider.id === command.provider || provider.name.toLowerCase() === command.provider.toLowerCase())
        if (command.provider && !providers.length && !(command.operation === "login" && command.providerType && command.baseUrl)) return fail(`Provider not found: ${command.provider}`)
        if (command.operation === "logout" || command.operation === "login") {
          const candidates = command.operation === "logout" ? providers.filter((provider) => provider.credentialStored) : providers
          const provider = command.provider ? providers[0]?.id ?? command.provider : candidates.length ? await ask({ title: command.operation === "logout" ? "Remove credential" : "Add credential", label: "Provider", options: candidates.map((provider) => ({ value: provider.id, label: provider.name, hint: provider.authMode })) }) : undefined
          if (!provider) return fail("No stored credentials found")
          const googleAdc = Boolean(command.vertex || ["google-vertex", "google-vertex-anthropic"].includes(command.providerType ?? "") || ["google-vertex", "google-vertex-anthropic"].includes(providers.find((entry) => entry.id === provider)?.type ?? ""))
          if (googleAdc && command.method && !["adc", "google application default credentials"].includes(command.method.toLowerCase())) return fail("Vertex uses the ADC method", 64)
          let entra = command.azure?.auth === "entra"
          let awsChain = command.bedrock?.auth === "chain"
          if (command.operation === "login" && !command.apiKeyEnv && !entra && !googleAdc && (!command.providerType || command.method)) {
            const reply = await request({ type: "providers.auth.methods", provider })
            if (!reply.ok) return fail(reply.message, 1, reply.code)
            const methods = (reply.result.methods as Record<string, ProviderAuthMethod[]> | undefined)?.[provider] ?? [{ id: "api-key", type: "api", label: "API key", available: true }]
            const selected = command.method ?? (awsChain && methods.some((method) => method.id === "aws-chain") ? "aws-chain" : methods.length > 1 ? await ask({ title: "Add credential", label: "Login method", options: methods.map((method) => ({ value: method.id, label: method.label, ...(method.reason ? { hint: method.reason } : {}) })) }) : methods[0]?.id)
            const method = methods.find((entry) => entry.id.toLowerCase() === selected?.toLowerCase() || entry.label.toLowerCase() === selected?.toLowerCase())
            if (!method) return fail(`Unknown method; choose ${methods.map((entry) => entry.label).join(", ")}`, 64)
            if (!method.available) return fail(method.reason ?? "Method unavailable")
            if (method.id === "entra") entra = true
            if (["aws-chain", "api-key"].includes(method.id) && providers.find((entry) => entry.id === provider)?.type === "amazon-bedrock") awsChain = method.id === "aws-chain"
            if (method.type === "oauth") return auth.login(provider, method.id, command.json)
          }
          const apiKeyEnv = command.apiKeyEnv
          const apiKey = command.operation === "login" && !apiKeyEnv && !entra && !awsChain && !googleAdc ? await ask({ title: "Add credential", label: "API key", secret: true, validate: (text) => /^[\x21-\x7e]{1,4096}$/.test(text.trim()) ? undefined : "Enter a nonempty API key without spaces" }) : undefined
          const enable = ["google", "github-copilot", "azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai", "mistral", "cohere"].includes(command.providerType ?? "") || ["google", "github-copilot", "azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai", "mistral", "perplexity", "alibaba", "opencode", "llmgateway", "nvidia", "zenmux", "deepinfra", "cerebras", "cohere", "togetherai", "kilo", "cloudflare-ai-gateway"].includes(provider) || ["google", "github-copilot", "azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai", "mistral", "cohere"].includes(providers.find((entry) => entry.id === provider)?.type ?? "")
          const reply = await request(command.operation === "logout" ? { type: "providers.logout", provider } : { type: "providers.set", provider, ...(entra || awsChain || googleAdc ? { apiKey: "" } : apiKeyEnv ? { apiKeyEnv } : { apiKey: apiKey! }), ...(command.providerType ? { providerType: command.providerType } : {}), ...(command.baseUrl ? { baseUrl: command.baseUrl } : {}), ...(enable ? { enabled: true } : {}), ...(command.azure || entra ? { azure: { ...command.azure, auth: entra ? "entra" : "api-key" } } : {}), ...(command.deployments ? { models: command.deployments.map((id) => ({ id })) } : {}), ...(command.bedrock || awsChain ? { bedrock: { ...command.bedrock, auth: awsChain ? "chain" : "bearer" } } : {}), ...(command.bedrockModels ? { models: command.bedrockModels.map((id) => ({ id })) } : {}), ...(googleAdc ? { vertex: command.vertex ?? {} } : {}), ...(command.vertexModels ? { models: command.vertexModels.map((id) => ({ id })) } : {}), ...(command.cloudflareAiGateway ? { cloudflareAiGateway: command.cloudflareAiGateway } : {}), ...(command.cloudflareGatewayModels ? { models: command.cloudflareGatewayModels.map((id) => ({ id })) } : {}) })
          if (!reply.ok) return fail(reply.message, 1, reply.code)
          return result({ provider, ...(apiKeyEnv ? { apiKeyEnv } : {}), credentialRemoved: command.operation === "logout" }, `${command.operation === "logout" ? "Removed stored credential" : "Configured credential"}: ${provider}\n`)
        }
        if (command.operation === "smoke") {
          providers = providers.filter((provider) => provider.configured || command.provider)
          const api = await request({ type: "providers.list" })
          if (!api.ok) return fail(api.message, 1, api.code)
          const configured = api.result.providers as ProviderInfo[]
          const results: Array<Record<string, unknown>> = []
          for (const provider of providers) {
            const models = configured.find((entry) => entry.id === provider.id)?.models ?? []
            const model = command.model ?? models[0]?.id
            const supported = provider.authMode === "api-key" || provider.authMode === "github-copilot-oauth" || provider.authMode === "azure-entra" || provider.authMode === "aws-chain" || provider.authMode === "google-adc"
            const ready = supported && provider.enabled && provider.authReady === true && !provider.error && Boolean(model)
            const base = { provider: provider.id, model, ready, executed: command.execute && ready }
            if (!command.execute || !ready) { results.push({ ...base, status: ready ? "ready-not-executed" : "skipped", reason: ready ? "pass --execute to run" : !supported ? "subscription smoke needs its auth adapter" : provider.error ?? (!provider.enabled ? "provider disabled or unconfigured" : !model ? "no model configured" : "credentials unavailable") }); continue }
            const reply = await request({ type: "providers.test", provider: provider.id, model: model! })
            results.push({ ...base, ...(reply.ok ? reply.result : { ok: false, error: reply.message }), status: reply.ok && reply.result.ok === true ? "ok" : "failed" })
          }
          const data = { mode: command.execute ? "execute" : "dry-run", results, executedCount: results.filter((entry) => entry.executed).length, okCount: results.filter((entry) => entry.ok === true).length, secretsPrinted: false }
          result(data, pretty(data))
          return results.some((entry) => entry.executed && entry.ok !== true) ? 1 : 0
        }
        if (command.operation === "list") providers = providers.filter((provider) => provider.configured)
        const data = { ...report, providers }
        return result(data, command.operation === "list" ? lines(providers.map((provider) => `${provider.id}  ${provider.authMode}  ${provider.authReady === true ? "ready" : provider.authReady === false ? "missing credentials" : "unavailable"}${provider.credentialStored ? "  stored credential" : ""}${provider.presentEnv.length ? `\n  Environment: ${provider.presentEnv.join(", ")}` : ""}`)) || "No configured providers\n" : pretty(data))
      }
      if (command.kind === "catalog.mcp") {
        if (command.operation === "add") {
          const name = command.server ?? await ask({ title: "Add MCP server", label: "Server name", validate: (text) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(text) ? undefined : "Use letters, digits, . _ -" })
          const scope = command.scope ?? await ask({ title: "Add MCP server", label: "Location", options: [{ value: "project", label: "Current project" }, { value: "user", label: "Global" }] }) as "user" | "project"
          let config = command.config
          if (!config) {
            const type = await ask({ title: "Add MCP server", label: "Server type", options: [{ value: "local", label: "Local", hint: "Run a local command" }, { value: "remote", label: "Remote", hint: "Connect to a URL" }] })
            if (type === "local") {
              const executable = await ask({ title: "Add MCP server", label: "Executable", validate: (text) => text.trim() ? undefined : "Executable required" })
              const args = await ask({ title: "Add MCP server", label: "Arguments (JSON array)", initial: "[]", validate: (text) => { try { const args = JSON.parse(text); if (Array.isArray(args) && args.every((arg) => typeof arg === "string")) return undefined } catch {} return "Enter a JSON array of strings" } })
              config = { command: executable, args: JSON.parse(args) }
            } else {
              const url = await ask({ title: "Add MCP server", label: "Server URL", validate: (text) => { try { const url = new URL(text); if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return undefined } catch {} return "Enter an http(s) URL without credentials" } })
              const oauth = await ask({ title: "Add MCP server", label: "OAuth", options: [{ value: "yes", label: "Enabled" }, { value: "no", label: "Disabled" }] })
              config = { url, oauth: false }
              if (oauth === "yes") {
                const clientId = await ask({ title: "Add MCP server", label: "Client ID (optional)", optional: true })
                const secretEnv = clientId ? await ask({ title: "Add MCP server", label: "Client secret environment variable (optional)", optional: true, validate: (text) => !text || /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(text) ? undefined : "Enter an environment variable name" }) : ""
                config.oauth = { ...(clientId ? { clientId } : {}), ...(secretEnv ? { clientSecret: `\${${secretEnv}}` } : {}) }
              }
            }
          }
          const reply = await request({ type: "mcp.add", directory, name, scope, config, replace: command.replace, dryRun: command.dryRun })
          if (!reply.ok) return fail(reply.message, 1, reply.code)
          return result(reply.result, `${command.dryRun ? "Would add" : "Added"} ${name}: ${reply.result.path}\n`)
        }
        if (command.operation === "debug") {
          const reply = await request({ type: "mcp.debug", directory, server: command.server! })
          if (!reply.ok) return fail(reply.message, 1, reply.code)
          result(reply.result, pretty(reply.result))
          return reply.result.error ? 1 : 0
        }
        const listed = await request({ type: "mcp.status", directory })
        if (!listed.ok) return fail(listed.message, 1, listed.code)
        const report = listed.result as unknown as McpStatusReport
        if (["auth", "auth.list", "logout"].includes(command.operation)) {
          const servers = report.servers.filter((server) => server.transport === "remote" && server.auth !== undefined && (command.operation !== "logout" || server.authStored || ["authorized", "pending"].includes(server.auth)))
          if (command.operation === "auth.list") return result({ servers, issues: report.issues }, mcpRows({ servers, issues: report.issues }))
          const server = command.server ?? (servers.length ? await ask({ title: command.operation === "auth" ? "MCP OAuth Authentication" : "MCP OAuth Logout", label: "Server", options: servers.map((server) => ({ value: server.name, label: server.name, hint: `${server.auth} · ${server.command}` })) }) : undefined)
          if (!server) return fail("No OAuth-capable MCP servers available")
          const target = report.servers.find((entry) => entry.name === server)
          if (!target || target.transport !== "remote" || target.auth === undefined) return fail(`MCP server ${server} is not OAuth-capable`)
          if (command.operation === "logout") {
            const reply = await request({ type: "mcp.auth", directory, server, action: "forget" })
            if (!reply.ok) return fail(reply.message, 1, reply.code)
            return result({ server, removed: true }, `Removed OAuth credentials: ${server}\n`)
          }
          if (target.auth === "authorized" && !(target.authExpiresAt !== undefined && target.authExpiresAt <= ctx.now()) && !command.json) {
            if (await ask({ title: "MCP OAuth Authentication", label: "Re-authenticate", options: [{ value: "no", label: "Cancel" }, { value: "yes", label: "Re-authenticate" }] }) !== "yes") throw new Cancelled()
          }
          if (!ctx.listenGlobal) throw new Usage("OAuth authentication needs global event support")
          let settle!: (reply: Reply) => void
          const completed = new Promise<Reply>((resolve) => { settle = resolve })
          let started = false
          let interrupted = false
          let closed = false
          const reconcile = async () => {
            if (!started || closed) return
            const reply = await request({ type: "mcp.status", directory })
            if (!reply.ok) return settle(reply)
            const status = (reply.result.servers as McpStatusReport["servers"]).find((entry) => entry.name === server)
            if (status?.auth === "authorized" && status.state === "running") settle({ ok: true, result: { server: status } })
            else if (status?.auth !== "pending") settle({ ok: false, code: "failed", message: status?.lastError ?? "OAuth authorization cancelled or failed" })
          }
          ctx.listenGlobal((event) => { if (event.type === "mcp.changed" && event.directory === directory && event.server === server) void reconcile() })
          ctx.onInterrupt(() => { if (closed) return; interrupted = true; settle({ ok: false, code: "cancelled", message: "OAuth authorization cancelled" }) })
          const timer = (ctx.setTimer ?? ((ms, callback) => { const timer = setTimeout(callback, ms); return { cancel: () => clearTimeout(timer) } }))(300_000, () => { interrupted = true; settle({ ok: false, code: "timeout", message: "OAuth authorization timed out" }) })
          try {
            const reply = await request({ type: "mcp.auth", directory, server })
            if (!reply.ok) return fail(reply.message, 1, reply.code)
            if (typeof reply.result.url === "string") {
              // Authorization URL is a capability for this operation, not a token or credential inventory.
              if (command.json) ctx.err.write(`Authorize: ${reply.result.url}\n`)
              else ctx.out.write(`Authorize: ${reply.result.url}\n`)
            }
            started = true
            await reconcile()
            const done = await completed
            if (interrupted) await request({ type: "mcp.auth", directory, server, action: "cancel" })
            return done.ok ? result(done.result, `Authenticated: ${server}\n`) : fail(done.message, done.code === "cancelled" ? 2 : done.code === "timeout" ? 3 : 1, done.code)
          } finally { closed = true; timer.cancel(); ctx.listenGlobal(undefined) }
        }
        return result(listed.result, ["status", "preview"].includes(command.operation) ? pretty(listed.result) : mcpRows(report))
      }
      return fail("unknown catalog operation", 64)
    } catch (error) {
      return error instanceof Cancelled ? fail("Cancelled", 2, "cancelled") : fail(error instanceof Error ? error.message : String(error), error instanceof Usage ? 64 : 1)
    }
  }
}
