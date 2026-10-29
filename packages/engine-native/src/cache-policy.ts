import { createHash } from "node:crypto"
import path from "node:path"
import type { CacheConfig, CacheMutation, CacheSelection, Settings } from "@mendcode/protocol"

export function cacheProject(value: string) { return path.resolve(value) }
const projectEntry = <T>(entries: Record<string, T> | undefined, directory: string) => Object.entries(entries ?? {}).find(([key]) => cacheProject(key) === cacheProject(directory))?.[1]

export function cacheConfigFor(settings: Pick<Settings, "cache" | "cacheProjects">, directory: string): CacheConfig | undefined {
  const global = settings.cache, local = projectEntry(settings.cacheProjects, directory)
  if (!local) return global
  const providers = { ...global?.providers }
  for (const [id, config] of Object.entries(local.providers ?? {})) providers[id] = { ...providers[id], ...config }
  return { ...global, ...local, projects: { ...global?.projects, ...local.projects }, sessions: { ...global?.sessions, ...local.sessions }, providers }
}

export function selectCache(input: { config?: CacheConfig | undefined; directory: string; session?: string | undefined; provider?: string | undefined; model?: string | undefined }): CacheSelection {
  const { config, session } = input
  const project = projectEntry(config?.projects, input.directory)
  const provider = input.provider ? config?.providers?.[input.provider] : undefined
  const candidates = input.model ? [input.model, input.model.split(":").slice(1).join(":"), input.model.split("/").at(-1)!].filter(Boolean) : []
  const selection = (mode: CacheSelection["mode"], source: CacheSelection["source"], reason: string, scope: CacheSelection["scope"] = "session"): CacheSelection => ({ mode, scope, source, reason })
  if (config?.mode === "off") return selection("off", "default", "cache.mode is off", config.scope)
  if (project?.mode === "off") return selection("off", "project", "the active project is excluded", project.scope ?? "project")
  if (config?.sessions?.mode === "none") return selection("off", "session", "session caching is disabled")
  if (session && config?.sessions?.exclude?.includes(session)) return selection("off", "session", "the session is excluded")
  if (session && config?.sessions?.mode === "selected" && !config.sessions.include?.includes(session)) return selection("off", "session", "the session is not selected")
  if (provider?.mode === "off") return selection("off", "provider", "the provider is disabled", provider.scope)
  if (provider && input.model) {
    if (provider.models && !provider.models.some((model) => candidates.includes(model))) return selection("off", "model", "the model is not in the provider allowlist", provider.scope)
    if (provider.exclude_models?.some((model) => candidates.includes(model))) return selection("off", "model", "the model is excluded", provider.scope)
  }
  if (config?.mode === "smart") return selection("smart", "default", "cache.mode is smart", config.scope)
  if (project?.mode === "smart") return selection("smart", "project", "the active project enables smart caching", project.scope ?? "project")
  if (provider && (provider.mode === "smart" || provider.models || provider.exclude_models)) return selection("smart", provider.models ? "model" : "provider", "the provider is selected", provider.scope)
  if (session && config?.sessions?.include?.includes(session)) return selection("smart", "session", "the session is explicitly selected")
  return selection("legacy", "default", "cache policy is not configured")
}

export function updateCache(current: CacheConfig | undefined, input: CacheMutation): CacheConfig {
  if (input.model && !input.provider) throw new Error("A model requires --provider")
  if (input.projectPath && (!input.global || input.provider || input.model || input.session)) throw new Error("--project-path requires --global and cannot combine with another target")
  if (input.session && (input.provider || input.model)) throw new Error("A session cannot combine with provider or model")
  const next = structuredClone(current ?? {}), enabled = input.action === "enable", mode = enabled ? "smart" : "off"
  const add = (values: string[] | undefined, value: string) => [...new Set([...(values ?? []), value])]
  const remove = (values: string[] | undefined, value: string) => (values ?? []).filter((item) => item !== value)
  if (input.projectPath) {
    const key = cacheProject(input.projectPath), previous = projectEntry(next.projects, key)
    const projects = Object.fromEntries(Object.entries(next.projects ?? {}).filter(([candidate]) => cacheProject(candidate) !== key))
    next.projects = { ...projects, [key]: { ...previous, mode, ...(enabled ? { scope: input.scope ?? previous?.scope ?? "project" } : {}) } }
  } else if (input.session) {
    const previous = next.sessions ?? {}
    next.sessions = { ...previous, ...(enabled ? { mode: "selected" as const } : {}), include: enabled ? add(previous.include, input.session) : remove(previous.include, input.session), exclude: enabled ? remove(previous.exclude, input.session) : add(previous.exclude, input.session) }
  } else if (input.provider) {
    const previous = next.providers?.[input.provider] ?? {}
    const policy = { ...previous }
    if (!input.model) { policy.mode = mode; if (enabled) policy.scope = input.scope ?? previous.scope ?? "session" }
    else if (enabled) { policy.mode = "smart"; if (input.scope) policy.scope = input.scope; policy.models = add(previous.models, input.model); policy.exclude_models = remove(previous.exclude_models, input.model) }
    else { policy.exclude_models = add(previous.exclude_models, input.model); policy.models = remove(previous.models, input.model) }
    next.providers = { ...next.providers, [input.provider]: policy }
  } else { next.mode = mode; if (enabled) next.scope = input.scope ?? next.scope ?? "session" }
  return next
}

export type CacheBinding = { provider: string; model: string; endpoint: string; auth: "api" | "oauth" | "unknown"; transport: "responses" | "chat" | "other"; account?: string }
export const cacheHash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}
export function passiveCache(binding: CacheBinding | undefined): "managed" | "session" | "none" {
  if (!binding?.account) return "none"
  let url: URL
  try { url = new URL(binding.endpoint) } catch { return "none" }
  if (url.protocol !== "https:" || url.username || url.password) return "none"
  if ((binding.provider === "openai" || binding.provider === "chatgpt") && binding.transport === "responses") {
    if (binding.auth === "api" && url.origin === "https://api.openai.com" && url.pathname.replace(/\/+$/, "") === "/v1") return "managed"
    if (binding.auth === "oauth" && url.origin === "https://chatgpt.com" && url.pathname.replace(/\/+$/, "") === "/backend-api/codex") return "session"
  }
  if (binding.provider === "openrouter" && binding.auth === "api" && binding.transport === "chat" && url.origin === "https://openrouter.ai" && url.pathname.replace(/\/+$/, "") === "/api/v1") return "managed"
  return "none"
}
