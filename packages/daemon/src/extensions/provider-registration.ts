import type { PluginProvider } from "@mendcode/extension-api/plugin"
import { PROVIDER_PRESETS } from "@mendcode/engine-native"

/** The provider an extension adds with a `baseUrl`, in the shape of a `providers.json` entry (docs/providers.md). */
export type ExtensionProviderEntry = {
  type: NonNullable<PluginProvider["type"]>
  baseUrl: string
  enabled: true
  apiKeyEnv?: string
  headers?: Record<string, string>
  models: Array<{ id: string; name?: string; context?: number; images?: boolean; effort?: boolean; maxOutputTokens?: number }>
}

const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,31}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/
const TYPES = new Set(["openai", "anthropic", "openai-compatible", "google", "xai", "mistral", "cohere"])
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Why `registerProvider` refuses `value`, or undefined. A provider with `baseUrl` is a whole provider: a wire type, a model list, the
 * key only by environment name (a key in the module's source would sit in a plain file), and an id no built-in provider or preset uses.
 */
export function providerProblem(value: PluginProvider): string | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return "registerProvider: needs { id }"
  if (value.baseUrl === undefined) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value.id) || value.models !== undefined && typeof value.models !== "function") return "registerProvider: invalid provider hook (without baseUrl, models is a function)"
    return undefined
  }
  if (!PROVIDER_ID.test(value.id)) return "registerProvider: id is lowercase letters, digits, _ and - (max 32), starting with a letter"
  if (value.id === "chatgpt" || PROVIDER_PRESETS[value.id]) return `registerProvider: ${value.id} is a built-in provider; configure it with /connect or providers.json, or pick another id`
  if (typeof value.baseUrl !== "string" || !/^https?:\/\/[^\s]+$/i.test(value.baseUrl) || value.baseUrl.length > 2048) return "registerProvider: baseUrl must be an http(s) URL"
  if (value.type !== undefined && !TYPES.has(value.type)) return `registerProvider: type is one of ${[...TYPES].join(", ")}`
  if ("apiKey" in value) return "registerProvider: put the key in an environment variable (or /env) and name it in apiKeyEnv; a key is never read from the module"
  if (value.apiKeyEnv !== undefined && (typeof value.apiKeyEnv !== "string" || !ENV_NAME.test(value.apiKeyEnv))) return "registerProvider: apiKeyEnv is an environment variable name"
  if (value.headers !== undefined && (!isRecord(value.headers) || Object.entries(value.headers).some(([name, header]) => !HEADER_NAME.test(name) || typeof header !== "string" || header.length > 2048))) return "registerProvider: headers maps header names to strings"
  if (!Array.isArray(value.models) || value.models.length === 0 || value.models.length > 1000) return "registerProvider: models lists the provider's models, e.g. [{ id: \"model-1\" }]"
  for (const model of value.models) {
    if (!isRecord(model) || typeof model.id !== "string" || !model.id || model.id.length > 66) return "registerProvider: each model needs an id (max 66 characters)"
    if (model.name !== undefined && (typeof model.name !== "string" || !model.name || model.name.length > 100)) return `registerProvider: model ${model.id}: name is a short string`
    for (const field of ["context", "maxOutputTokens"] as const) if (model[field] !== undefined && !(Number.isSafeInteger(model[field]) && (model[field] as number) > 0)) return `registerProvider: model ${model.id}: ${field} is a positive integer`
    for (const field of ["images", "effort"] as const) if (model[field] !== undefined && typeof model[field] !== "boolean") return `registerProvider: model ${model.id}: ${field} is true or false`
  }
  return undefined
}

/** The `providers.json`-shaped entry of a provider registered with `baseUrl` (already checked by `providerProblem`). */
export function providerEntry(value: PluginProvider): ExtensionProviderEntry | undefined {
  if (value.baseUrl === undefined || !Array.isArray(value.models)) return undefined
  return {
    type: value.type ?? "openai-compatible",
    baseUrl: value.baseUrl.replace(/\/+$/, ""),
    enabled: true,
    ...(value.apiKeyEnv ? { apiKeyEnv: value.apiKeyEnv } : {}),
    ...(value.headers ? { headers: { ...value.headers } } : {}),
    models: value.models.map((model) => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      ...(model.context ? { context: model.context } : {}),
      ...(model.images !== undefined ? { images: model.images } : {}),
      ...(model.effort !== undefined ? { effort: model.effort } : {}),
      ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
    })),
  }
}
