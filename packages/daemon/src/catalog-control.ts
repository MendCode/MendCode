import { MODEL_ROLES, type ModelChoice, type ModelPreset, type ModelsConfigReport, type ModelRoles } from "@mendcode/protocol"
import { invalidChoice, resolveModel, type ModelCatalog } from "./models"

const SUBSCRIPTION_PRESETS = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.2", "gpt-5.2-codex"]
const API_PRESETS = ["gpt-5.2", "gpt-5.2-codex", "gpt-5.6", "gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5-mini", "gpt-5-nano"]

/** Resolve a v1 provider/model reference against the actual v2 catalog, preserving the billing route. */
export function catalogChoice(input: { provider: string; model: string; authMode?: string | undefined }, catalog: ModelCatalog): ModelChoice {
  if (input.authMode === "api-key" && ["chatgpt", "claude", "pi"].includes(input.provider)) throw new Error("API key auth requires an API provider")
  const subscription = input.provider === "chatgpt" || input.authMode === "chatgpt-subscription-oauth"
  if (input.authMode === "chatgpt-subscription-oauth" && !["openai", "chatgpt"].includes(input.provider)) throw new Error("ChatGPT subscription auth applies to openai or chatgpt only")
  const matches = catalog.list().filter((entry) => {
    if (subscription) return !entry.provider && !entry.engine && entry.id === input.model
    if (input.provider === "claude" || input.provider === "pi") return entry.engine === input.provider && entry.id === input.model
    return entry.provider === input.provider && entry.id === `${input.provider}:${input.model}`
  })
  // v1's openai namespace serves both API and subscription models. Never silently choose between billing routes.
  if (!subscription && !input.authMode && input.provider === "openai") {
    const native = catalog.list().find((entry) => !entry.provider && !entry.engine && entry.id === input.model)
    if (native && matches.length) throw new Error("ambiguous openai model; give --auth-mode api-key or chatgpt-subscription-oauth")
    if (native) matches.push(native)
  }
  if (!matches.length) throw new Error(`unavailable model ${input.provider}/${input.model}${input.authMode ? ` (${input.authMode})` : ""}`)
  const choice = { model: matches[0]!.id }
  const problem = invalidChoice(choice, catalog)
  if (problem) throw new Error(problem)
  return choice
}

export function catalogPresets(catalog: ModelCatalog): ModelPreset[] {
  return [
    ...SUBSCRIPTION_PRESETS.map((model) => ({ name: `openai-codex-subscription-${model}`, provider: "openai", model, authMode: "chatgpt-subscription-oauth" as const })),
    ...API_PRESETS.map((model) => ({ name: `openai-api-${model}`, provider: "openai", model, authMode: "api-key" as const })),
  ].map((preset) => {
    let available = true
    try { catalogChoice(preset, catalog) } catch { available = false }
    return { ...preset, available }
  })
}

export function catalogConfig(engine: string, catalog: ModelCatalog, roles: ModelRoles): ModelsConfigReport {
  const effective = Object.fromEntries(MODEL_ROLES.map((role) => [role, resolveModel({ role, roles, catalog })]))
  const failures = Object.entries(roles).flatMap(([role, choice]) => {
    const problem = choice ? invalidChoice(choice, catalog, role as typeof MODEL_ROLES[number]) : undefined
    return problem ? [`${role}: ${problem}`] : []
  })
  return { engine, selectable: catalog.selectable, defaults: catalog.defaults, roles, effective, failures, warnings: catalog.selectable ? [] : ["engine chooses its own model"], presets: catalogPresets(catalog) }
}
