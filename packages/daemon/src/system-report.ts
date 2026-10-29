import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { createSchemaCatalog, Frame, MODEL_ROLES, type SchemaCatalog, type Settings, type SystemReport } from "@mendcode/protocol"
import type { ProviderService } from "./providers"
import type { ModelCatalog } from "./models"
import { modelsReport, resolveModel } from "./models"
import { rolesFor } from "./profiles"
import { configLayers } from "./config-layers"

let schemaCatalog: SchemaCatalog | undefined
/** Built on the first `generate` and kept: pages of one dump must come from the same document. */
function protocolSchema(): SchemaCatalog {
  return schemaCatalog ??= createSchemaCatalog(z.toJSONSchema(Frame, { io: "input", reused: "ref" }))
}

type Input = { entry?: string | undefined; page?: number | undefined; index?: number | undefined; dir: string; directory: string; socketPath: string; transport?: "unix" | "tcp" | undefined; buildId?: string | undefined; engine: string; settings: Settings; catalog: ModelCatalog; providers?: ProviderService | undefined; environment?: NodeJS.ProcessEnv; which?: (name: string) => string | null; login?: { ok: boolean; message?: string } | undefined; invalidSettings?: readonly string[] }

/** Public reports contain paths and readiness only, never environment values or provider credentials. */
export function systemReport(operation: string, input: Input): SystemReport {
  const environment = input.environment ?? process.env
  const which = input.which ?? Bun.which
  const checks: SystemReport["checks"] = []
  const facts: SystemReport["facts"] = {}
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })
  const tools = ["bun", "git", "rg", "codex", "claude"].map((name) => ({ name, path: which(name), required: name === "codex" && input.engine === "codex" || name === "claude" && input.engine === "claude" }))
  const paths = {
    data: input.dir, database: path.join(input.dir, "mendd.db"), socket: input.socketPath,
    lock: path.join(input.dir, "mendd.lock"), settings: `${path.join(input.dir, "mendd.db")}#settings`,
    providers: path.join(input.dir, "providers.json"), mcp: path.join(input.dir, "mcp.json"),
    acp: path.join(input.dir, "acp-agents.json"), instructions: path.join(input.dir, "AGENTS.md"),
    extensions: path.join(input.dir, "extensions"), tui: path.join(input.dir, "tui", "profile.json"),
    project: path.join(input.directory, ".mendcode"),
  }
  if (operation === "generate") {
    const contract: Record<string, unknown> = { transport: "newline-json", protocol: 1 }
    const catalog = protocolSchema()
    if (input.entry !== undefined) {
      const schema = catalog.entry(input.entry)
      if (schema) Object.assign(contract, { entry: input.entry, schema })
      else check("schema entry", false, `unknown entry ${input.entry}`)
    } else if (input.page !== undefined) {
      const page = catalog.page(input.page)
      if (page) contract.page = page
      else check("schema page", false, `page ${input.page} out of range (${catalog.index()!.pages} pages)`)
    } else {
      const index = catalog.index(input.index ?? 0)
      if (index) contract.index = index
      else check("schema index", false, `index page ${input.index} out of range`)
    }
    facts.contract = contract
  } else if (operation === "config-paths") {
    facts.paths = paths
  } else if (operation === "config-layers") {
    const report = configLayers({ dir: input.dir, directory: input.directory, settings: input.settings, environment, ...(input.invalidSettings ? { invalidSettings: input.invalidSettings } : {}) })
    facts.layers = report.layers
    facts.warnings = report.warnings
    facts.problems = report.problems
    facts.printsSecrets = false
  } else if (operation === "adapter-status") {
    facts.adapter = { architecture: "daemon + protocol + client", engine: input.engine, transport: input.transport ?? "unix", socket: input.transport === "tcp" ? path.join(input.dir, "mendd.endpoint") : input.socketPath, pid: process.pid, buildId: input.buildId ?? null, donorRuntime: false }
  } else if (operation === "ai-env" || operation === "ai-status") {
    facts.models = modelsReport({ engine: input.engine, catalog: input.catalog, roles: rolesFor(input.settings, input.directory), sessionKnown: false })
    const providers = input.providers?.list() ?? []
    facts.providers = providers.map(({ id, enabled, hasKey, models, error }) => ({ id, enabled, hasKey, models, ...(error ? { error } : {}) }))
    const names = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "DEEPSEEK_API_KEY", "MENDCODE_V2_ENGINE"]
    facts.environment = names.map((name) => ({ name, present: Boolean(environment[name]) }))
    const roles = rolesFor(input.settings, input.directory)
    facts.roles = Object.fromEntries(MODEL_ROLES.map((role) => {
      const choice = resolveModel({ role, roles, catalog: input.catalog })
      const entry = input.catalog.list().find((entry) => entry.id === choice.model)
      const providerId = entry?.provider ?? (choice.model.includes(":") ? choice.model.split(":")[0] : undefined)
      const provider = providers.find((provider) => provider.id === providerId)
      const authReady = providerId ? provider ? provider.enabled && !provider.error : null : input.login?.ok ?? null
      const blockers = providerId && !provider ? ["provider unavailable"] : provider && (!provider.enabled || provider.error) ? [provider.error ?? "provider disabled"] : input.login?.ok === false && !providerId ? [input.login.message ?? "login unavailable"] : authReady === null ? ["auth readiness unavailable"] : []
      return [role, { model: choice.model, provider: providerId ?? input.engine, ...(choice.effort ? { effort: choice.effort } : {}), authReady, blockers }]
    }))
    const main = (facts.roles as Record<string, { authReady: boolean | null; blockers: string[] }>).main!
    facts.ready = main.authReady
    facts.blockers = main.blockers
    facts.callsProviders = false
    facts.printsSecrets = false
  } else {
    facts.runtime = { engine: input.engine, pid: process.pid, uptime: Math.floor(process.uptime()), platform: process.platform, arch: process.arch, bun: Bun.version, buildId: input.buildId ?? null, logLevel: input.settings.logLevel ?? "INFO" }
    if (operation !== "toolchain") {
      check("data directory", existsSync(input.dir), input.dir)
      check("database", existsSync(paths.database), paths.database)
      check("socket", existsSync(paths.socket), paths.socket)
      let owner = ""
      try { owner = readFileSync(paths.lock, "utf8").trim() } catch {}
      check("writer lock", Number(owner) === process.pid, owner ? `pid ${owner}` : "missing")
      check("protocol", true, "newline JSON · v1")
      facts.paths = paths
    }
    facts.tools = tools
    for (const tool of tools) if (tool.required) check(tool.name, tool.path !== null, tool.path ?? "not found on PATH")
  }
  const failures = checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`)
  return { operation, ok: failures.length === 0, checks, failures, facts }
}
