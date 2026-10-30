import type { ModelChoice, ModelInfo, ModelRole, ModelRoles, ModelsReport, Settings } from "@mendcode/protocol"
import { findModel } from "@mendcode/protocol/wire"

/** What the engine can run and its fallback choice. `selectable` is false for engines that pick their own model. */
export type ModelCatalog = {
  selectable: boolean
  list(readOnly?: boolean): ModelInfo[]
  defaults: ModelChoice
  allows?(model: string): boolean
  /** Settles what `list()` depends on that is learned asynchronously (is Claude Code installed); awaited before a models report is built. */
  refresh?(): Promise<void>
  /** Asks the providers that can list their models for a fresh list now; awaited once before a model the list lacks is refused. */
  discover?(): Promise<void>
}

/** The catalog's entry for a model id; a full id of a Claude Code family (`claude-haiku-5-5`) is its alias's entry pinned to that id (`findModel`). */
export function catalogModel(catalog: ModelCatalog, id: string): ModelInfo | undefined {
  return findModel(catalog.list(), id)
}

/**
 * The catalog id a model wrote for a sub-agent: exact, or the one id whose model part (after `provider/`) is the given
 * name, case aside (`gpt-6.1-terra` → `chatgpt/gpt-6.1-terra`). Two providers with that model stay ambiguous: undefined.
 */
export function catalogId(catalog: ModelCatalog, id: string): string | undefined {
  if (catalogModel(catalog, id)) return id
  const wanted = id.toLowerCase()
  const matches = catalog.list().filter((model) => model.id.toLowerCase() === wanted || model.id.slice(model.id.indexOf("/") + 1).toLowerCase() === wanted)
  return matches.length === 1 ? matches[0]!.id : undefined
}

/** Up to `limit` catalog ids that share a word with `id` (`terra`, `6.1`): what an unknown model was likely meant to be. */
export function nearModels(catalog: ModelCatalog, id: string, limit = 8): string[] {
  const words = id.toLowerCase().split(/[^a-z0-9.]+/).filter((word) => word.length > 1 && !["gpt", "claude", "model"].includes(word))
  return catalog.list().map((model) => model.id).filter((candidate) => words.some((word) => candidate.toLowerCase().includes(word))).slice(0, limit)
}

/** The engine that runs a model's sessions: "claude" for a Claude Code model, "pi" for a pi model, otherwise the daemon's own. */
export function modelEngine(choice: ModelChoice | undefined, catalog: ModelCatalog): "claude" | "pi" | "codex" | "opencode" | "cursor" | undefined {
  return choice ? catalogModel(catalog, choice.model)?.engine : undefined
}

/**
 * Roles that try other roles' settings before falling back to main: `aside` (`/btw`) uses `small`, the shared
 * default for cheap auxiliary calls, when the user set one.
 */
export const ROLE_FALLBACKS: Partial<Record<ModelRole, readonly ModelRole[]>> = { aside: ["small"], memoryExtractor: ["small"], memoryAssistant: ["memoryExtractor", "small"], title: ["small"], summary: ["small"] }

/**
 * The model for one call. `main` is the session's own choice, else the `main` setting, else the default.
 * Any other role uses its own setting when there is one (then its `ROLE_FALLBACKS`), otherwise whatever `main`
 * resolves to, so a session switched to a bigger model also plans, compacts and delegates with it.
 * Other roles skip models of another engine (Claude Code runs whole sessions, not single calls).
 * An effort the model does not support falls back to the model's default (or none).
 */
export function resolveModel(input: { role: ModelRole; session?: ModelChoice | undefined; roles: ModelRoles; catalog: ModelCatalog; cheapSubagent?: boolean }): ModelChoice {
  const { role, session, roles, catalog } = input
  const cheap = role === "subagent" && input.cheapSubagent && !roles.subagent ? cheapSubagentModel(session ?? roles.main ?? catalog.defaults, catalog) : undefined
  const candidates = [role !== "main" ? roles[role] : undefined, ...(ROLE_FALLBACKS[role] ?? []).map((fallback) => roles[fallback]), cheap, session, roles.main]
  return usableEffort(candidates.find((choice) => choice && catalog.allows?.(choice.model) !== false && (role === "main" || !modelEngine(choice, catalog) && !choice.model.startsWith("acp:"))) ?? catalog.defaults, catalog)
}

/** Sub-agent tiers, best first: a mid model of the family (Sonnet, Luna, mini, Flash), else a small one. */
const SUBAGENT_TIERS = [/sonnet/i, /luna/i, /(^|[-_.:])mini([-_.:]|$)/i, /flash(?!-lite)/i, /haiku/i, /(^|[-_.:])(lite|nano)([-_.:]|$)/i]
/** Families above those tiers: only a session on one of them is moved down; a session already on a mid or small model keeps it. */
const LARGE_MODEL = /opus|fable|(^|[-_.:])sol([-_.:]|$)|(^|[-_.:])pro([-_.:]|$)|ultra|max|(^|[-_.:])gpt-\d+(\.\d+)?$/i

/**
 * `cheap_subagents`: with no `subagent` role set, a sub-agent of a session on a large model runs on the same provider's
 * mid tier (the ChatGPT subscription's Luna, a key provider's Sonnet, mini or Flash) instead of the session's model.
 * Undefined keeps the session's model: no cheaper model of that provider, an external engine, or a session already small.
 */
export function cheapSubagentModel(main: ModelChoice, catalog: ModelCatalog): ModelChoice | undefined {
  const info = catalogModel(catalog, main.model)
  if (!info || info.engine || main.model.startsWith("acp:") || !LARGE_MODEL.test(info.id)) return undefined
  const peers = catalog.list().filter((model) => !model.engine && !model.id.startsWith("acp:") && model.provider === info.provider && model.id !== info.id && catalog.allows?.(model.id) !== false)
  for (const tier of SUBAGENT_TIERS) {
    const found = peers.find((model) => tier.test(model.provider ? model.id.slice(model.provider.length + 1) : model.id))
    if (found) return { model: found.id }
  }
  return undefined
}

/** A choice whose effort the model does not support falls back to the model's default (or none); a model the catalog does not know is kept as asked. */
export function usableEffort(chosen: ModelChoice, catalog: ModelCatalog): ModelChoice {
  const info = catalogModel(catalog, chosen.model)
  if (!info) return chosen
  // An external engine's model has no provider variants: a variant naming one of its efforts is that effort.
  if (info.engine && chosen.variant) {
    const { variant: named, ...rest } = chosen
    const effort = info.efforts.includes(named as never) ? (named as ModelChoice["effort"]) : chosen.effort
    return usableEffort({ ...rest, ...(effort ? { effort } : {}) }, catalog)
  }
  const variant = chosen.variant ? info.variants?.[chosen.variant] : undefined
  const askedEffort = variant?.effort ?? chosen.effort
  const effort = askedEffort && (info.efforts.length === 0 || info.efforts.includes(askedEffort)) ? askedEffort : info.defaultEffort
  const { effort: _effort, ...rest } = chosen
  // The choice's own parameters (fast mode's service_tier) stay under the variant's.
  return { ...rest, ...(effort ? { effort } : {}), ...(variant?.parameters ? { parameters: { ...chosen.parameters, ...variant.parameters } } : {}) }
}

/** `resolve` adds what each engine alias last resolved to (`ModelInfo.resolved`, a display hint). */
export function modelsReport(input: { engine: string; catalog: ModelCatalog; roles: ModelRoles; session?: ModelChoice | undefined; sessionKnown: boolean; resolve?: ((models: ModelInfo[]) => ModelInfo[]) | undefined }): ModelsReport {
  const { engine, catalog, roles, session } = input
  const effective = input.sessionKnown && catalog.selectable ? resolveModel({ role: "main", session, roles, catalog }) : undefined
  const listed = input.resolve ? input.resolve(catalog.list()) : catalog.list()
  // A pinned Claude Code model in use (`claude-haiku-5-5`) is listed beside its alias, so a client finds what the session runs on.
  const pinned = new Map<string, ModelInfo>()
  for (const choice of [session, effective, ...Object.values(roles)]) {
    if (!choice || listed.some((model) => model.id === choice.model)) continue
    const info = findModel(catalog.list(), choice.model)
    if (info) pinned.set(info.id, info)
  }
  return {
    engine,
    selectable: catalog.selectable,
    models: pinned.size ? [...listed, ...(input.resolve ? input.resolve([...pinned.values()]) : pinned.values())] : listed,
    defaults: catalog.defaults,
    roles,
    ...(session ? { session } : {}),
    ...(effective ? { effective } : {}),
  }
}

/** Why `choice` cannot take image attachments, or undefined when it can (or the catalog does not say it cannot). */
export function imageRefusal(choice: ModelChoice, catalog: ModelCatalog): string | undefined {
  const info = catalogModel(catalog, choice.model)
  if (!info) return undefined
  if (info.images === false || (info.modalities && !info.modalities.input.includes("image"))) return `${info.name} does not accept images; pick a vision model or remove the image`
  return undefined
}

/** Why a choice cannot be used, or undefined when it can. */
export function invalidChoice(choice: ModelChoice, catalog: ModelCatalog, role: ModelRole = "main"): string | undefined {
  if (!catalog.selectable) return "this engine chooses its own model"
  const info = catalogModel(catalog, choice.model)
  if (!info) return `unknown model ${choice.model}`
  if (choice.model.startsWith("acp:") && role !== "main") return `${choice.model} runs whole sessions through ACP; use it for main`
  if (info.engine) {
    // Claude Code has no provider variants; a variant naming one of its efforts means that effort.
    if (choice.parameters) return `${choice.model} does not support provider variants`
    if (choice.variant && !info.efforts.includes(choice.variant as never)) return info.efforts.length ? `unknown variant ${choice.variant} for ${choice.model}; use ${info.efforts.join(", ")}` : `${choice.model} does not support provider variants`
  } else if (choice.variant && (!info.variants?.[choice.variant] || info.variants[choice.variant]?.disabled)) return `unknown variant ${choice.variant} for ${choice.model}`
  // A sub-agent on an engine model goes through task's `engine`; the refusal says how, so a model does not fall back to another provider's copy.
  if (info.engine && role !== "main" && role !== "subagent") return `${choice.model} runs whole sessions through Claude Code; use it for main`
  if (info.engine && role === "subagent") return `${choice.model} runs through ${info.engine === "claude" ? "Claude Code on the user's Claude login" : `the ${info.engine} engine`}; to delegate to it pass engine: "${info.engine}" with this exact model (full tier), not another provider's copy of it`
  if (choice.effort && info.efforts.length > 0 && !info.efforts.includes(choice.effort)) return `${choice.model} supports ${info.efforts.join(", ")}; effort ${choice.effort} is not one of them`
  return undefined
}

/** Exact model denies also bind calls; an empty allowlist deliberately permits no providers. */
export function modelAllowed(model: string, settings: Settings, provider?: string): boolean {
  const id = provider ?? (model.includes(":") ? model.split(":")[0]! : "chatgpt")
  if (settings.enabled_providers && !settings.enabled_providers.includes(id)) return false
  return !(settings.disabled_models ?? []).some((disabled) => disabled === model || disabled === `${id}/${model.includes(":") ? model.slice(model.indexOf(":") + 1) : model}`)
}

/**
 * The catalog without the models the settings exclude. The settings are read once per listing, never once per model: reading
 * them parses the stored settings and the ACP agents file, and a catalog of a few hundred models (an ACP agent's learned list)
 * made every listing hundreds of reads, which held the daemon (and every client waiting on it) for a quarter of a second.
 */
export function filteredCatalog(catalog: ModelCatalog, settings: () => Settings): ModelCatalog {
  const list = () => {
    const current = settings()
    return catalog.list().filter((model) => modelAllowed(model.id, current, model.provider))
  }
  return { selectable: catalog.selectable, list, ...(catalog.refresh ? { refresh: catalog.refresh } : {}), ...(catalog.discover ? { discover: catalog.discover } : {}), allows: (model) => catalog.allows?.(model) !== false && modelAllowed(model, settings(), catalog.list().find((entry) => entry.id === model)?.provider), get defaults() {
    const listed = list()
    if (listed.some((model) => model.id === catalog.defaults.model)) return catalog.defaults
    return { model: listed[0]?.id ?? catalog.defaults.model }
  } }
}
