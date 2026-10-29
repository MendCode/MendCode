import { MemoryConfigPatch, ProjectRuntimeConfig, RestConfig, RestProjectConfig, RestUpgradeResult, Settings, redactSecrets, type ModelRoles, type ProcessMemory, type RestConfig as Config, type RestLogInput, type RestUpgradeInput } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { defaultPermissionFor, rolesFor, shellFor } from "./profiles"
import type { ConfigExtras, ServerConfigExtras } from "./server-config-extras"
import { memorySettings } from "./memory-config"
import { catalogModel, invalidChoice, type ModelCatalog } from "./models"
import type { LogLevel } from "./logging"

const WARN_BYTES = 2 * 1024 ** 3
const CRITICAL_BYTES = 4 * 1024 ** 3
const SECRET_LOG_KEY = /secret|token|password|passwd|api.?key|private.?key|access.?key|authorization|cookie|credential|^(?:key|code|access|refresh|verifier)$/i
function logValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(logValue)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_LOG_KEY.test(key) ? "[redacted:secret]" : logValue(item)]))
  return typeof value === "string" ? logText(value) : value
}
function logText(text: string) {
  // Logs do not need the placeholder/code exemptions used when displaying source text.
  return redactSecrets(text).text
    .replace(/(\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"']+/gi, "$1[redacted:secret]")
    .replace(/(\b[\w.-]*(?:secret|token|password|passwd|api[_-]?key|authorization|cookie|credential)[\w.-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\]}]+)/gi, "$1[redacted:secret]")
    .replace(/[\x00-\x1f\x7f]/g, " ")
}
export function processMemory(memory = process.memoryUsage(), uptime = process.uptime(), pid = process.pid): ProcessMemory {
  return { pid, role: "server", ...memory, uptimeSeconds: uptime, memoryGuardrail: { status: memory.rss >= CRITICAL_BYTES ? "critical" : memory.rss >= WARN_BYTES ? "warning" : "ok", warnBytes: WARN_BYTES, criticalBytes: CRITICAL_BYTES } }
}

/** Config patches merge objects, replace arrays, and never merge prototype keys. */
function merge(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("invalid config key")
    const previous = current[key]
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge(previous && typeof previous === "object" && !Array.isArray(previous) ? previous as Record<string, unknown> : {}, value as Record<string, unknown>) : value
  }
  return result
}

export function createServerControl(input: {
  store: Store
  catalog: ModelCatalog
  changed(settings: Settings, patch: Record<string, unknown>): void
  logLevel(): LogLevel
  log(level: "debug" | "info" | "warn" | "error", message: string): void
  upgraded(version: string): void
  /** File-backed donor fields (`mcp`, `plugin`, `server`, project `instructions`/`skills`); without it they are refused. */
  extras?: ServerConfigExtras
  upgrade?(input: RestUpgradeInput, signal: AbortSignal): Promise<RestUpgradeResult>
}) {
  let upgrading = false
  function modelId(choice: { model: string }) {
    const found = catalogModel(input.catalog, choice.model)
    if (!found) return undefined
    const provider = found.provider ?? "openai"
    const name = choice.model.startsWith(`${provider}:`) ? choice.model.slice(provider.length + 1) : choice.model
    return `${provider}/${name}`
  }
  function get(directory?: string): Config {
    const stored = input.store.settings.get()
    const { projectConfig: _projects, ...scoped } = directory ? memorySettings(stored, directory) : stored
    // Project scope reports only the project's own sources, so reading and writing back never copies global values into it.
    const { instructions: _instructions, skills: _skills, shell: _shell, ...projectScoped } = scoped
    const settings = directory ? { ...projectScoped, ...(shellFor(stored, directory) ? { shell: shellFor(stored, directory)! } : {}) } : scoped
    const models = directory ? rolesFor(stored, directory) : stored.models
    const defaultPermission = directory ? defaultPermissionFor(stored, directory) : stored.defaultPermission
    const defaultAgent = directory ? stored.projectConfig?.[directory]?.defaultAgent ?? stored.defaultAgent : stored.defaultAgent
    return {
      ...settings, ...(models ? { models } : {}), ...(defaultPermission ? { defaultPermission } : {}), ...(defaultAgent ? { defaultAgent, default_agent: defaultAgent } : {}),
      ...Object.fromEntries(([["main", "model"], ["small", "small_model"], ["subagent", "subagent_model"]] as const).flatMap(([role, alias]) => {
        const value = models?.[role] && modelId(models[role]!)
        return value ? [[alias, value]] : []
      })),
      ...(models?.subagent?.variant ? { subagent_variant: models.subagent.variant } : {}),
      ...(stored.planExitAgent ? { plan_exit_agent: stored.planExitAgent } : {}),
      ...input.extras?.get(directory),
    }
  }
  async function update(patch: Config, directory?: string, pendingMcp = false) {
    const parsed = (directory ? RestProjectConfig : RestConfig).parse(patch)
    const { $schema: _schema, model, small_model, subagent_model, subagent_variant, default_agent, mcp, plugin, server, ...native } = parsed as Config
    const { plan_exit_agent, ...settingsPatch } = native
    // Project instructions/skills live in the project's own file, not in daemon settings.
    const { instructions, skills, ...scopedPatch } = settingsPatch
    const remaining = directory ? scopedPatch : settingsPatch
    const extras: ConfigExtras = { ...(mcp ? { mcp } : {}), ...(plugin ? { plugin } : {}), ...(server ? { server } : {}), ...(directory && instructions ? { instructions } : {}), ...(directory && skills ? { skills } : {}) }
    if (Object.keys(extras).length) {
      if (!input.extras) throw new Error("configuration files unavailable")
      input.extras.validate(extras, directory)
    }
    const current = input.store.settings.get()
    const models: ModelRoles = { ...(directory ? current.projectConfig?.[directory]?.models : current.models), ...remaining.models }
    const aliases = { main: model, small: small_model, subagent: subagent_model }
    for (const [role, value] of Object.entries(aliases)) if (value) {
      if (remaining.models?.[role as keyof ModelRoles]) throw new Error("conflicting model aliases")
      const slash = value.indexOf("/")
      const provider = value.slice(0, slash), name = value.slice(slash + 1)
      const found = input.catalog.list().find((entry) => (entry.provider ?? "openai") === provider && [name, `${provider}:${name}`].includes(entry.id))
      if (!found) throw new Error("unknown provider/model pair")
      models[role as keyof ModelRoles] = { model: found.id }
    }
    if (subagent_variant) {
      const inherited = directory ? rolesFor(current, directory).subagent : undefined
      if (!models.subagent && inherited) models.subagent = inherited
      if (!models.subagent) throw new Error("subagent_variant requires subagent_model")
      models.subagent = { ...models.subagent, variant: subagent_variant }
    }
    const changesModels = remaining.models !== undefined || model !== undefined || small_model !== undefined || subagent_model !== undefined || subagent_variant !== undefined
    if (changesModels) for (const [role, choice] of Object.entries(models)) {
      const problem = invalidChoice(choice, input.catalog, role as keyof ModelRoles)
      if (problem) throw new Error(problem)
    }
    if (default_agent && remaining.defaultAgent && default_agent !== remaining.defaultAgent || plan_exit_agent && remaining.planExitAgent && plan_exit_agent !== remaining.planExitAgent) throw new Error("conflicting agent aliases")
    const resolved = { ...remaining, ...(changesModels ? { models } : {}), ...(default_agent ? { defaultAgent: default_agent } : {}), ...(plan_exit_agent ? { planExitAgent: plan_exit_agent } : {}) }
    let saved: Record<string, unknown>
    if (directory) {
      const runtime = Object.fromEntries(Object.entries(resolved).filter(([key]) => key in ProjectRuntimeConfig.shape))
      const memory = Object.fromEntries(Object.entries(resolved).filter(([key]) => key in MemoryConfigPatch.shape))
      saved = {
        ...(Object.keys(runtime).length ? { projectConfig: { ...current.projectConfig, [directory]: merge(current.projectConfig?.[directory] ?? {}, runtime) } } : {}),
        ...(Object.keys(memory).length ? { memoryProjects: { ...current.memoryProjects, [directory]: merge(current.memoryProjects?.[directory] ?? {}, memory) } } : {}),
      }
    } else saved = resolved
    const next = Settings.parse(merge(current, saved))
    if (changesModels) for (const [role, choice] of Object.entries(directory ? rolesFor(next, directory) : next.models ?? {})) {
      const problem = invalidChoice(choice, input.catalog, role as keyof ModelRoles)
      if (problem) throw new Error(problem)
    }
    if (Object.keys(extras).length) await input.extras!.apply(extras, directory, pendingMcp)
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      const settings = input.store.settings.set(next)
      input.changed(settings, saved)
    }
    return get(directory)
  }
  return {
    get, update,
    log(entry: RestLogInput) {
      const levels = ["debug", "info", "warn", "error"]
      if (levels.indexOf(entry.level) < levels.indexOf(input.logLevel().toLowerCase())) return
      const text = `[${entry.service}] ${entry.message}${entry.extra ? ` ${JSON.stringify(logValue(entry.extra))}` : ""}`
      input.log(entry.level, logText(text))
    },
    async upgrade(request: RestUpgradeInput, signal: AbortSignal): Promise<RestUpgradeResult> {
      if (!input.upgrade) return { success: false, error: "Runtime upgrade is disabled; use the local upgrade command" }
      if (signal.aborted) return { success: false, error: "Upgrade cancelled" }
      if (upgrading) return { success: false, error: "Upgrade already running" }
      upgrading = true
      try {
        const result = RestUpgradeResult.parse(await input.upgrade(request, signal))
        if (result.success) input.upgraded(result.version)
        return result
      } catch { return { success: false, error: "Update failed" } }
      finally { upgrading = false }
    },
  }
}
