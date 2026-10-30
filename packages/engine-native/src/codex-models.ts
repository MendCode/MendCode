import { REASONING_EFFORTS, type ModelInfo, type ReasoningEffort } from "@mendcode/protocol"

/** An entry of the subscription backend's model list (`GET …/models`), the shape MendCode keeps in its own `chatgpt-models.json`. */
type CachedModel = {
  slug?: unknown
  display_name?: unknown
  visibility?: unknown
  default_reasoning_level?: unknown
  supported_reasoning_levels?: unknown
  context_window?: unknown
  max_context_window?: unknown
}

/**
 * Largest windows the subscription serves, from OpenAI's own Codex catalog (codex-rs/models-manager/models.json,
 * `max_context_window`), for when the cache does not state one. Codex lets its config raise `context_window` up to it.
 * Only models whose maximum is published there; the rest stay unknown.
 */
export const KNOWN_MAX_CONTEXT_WINDOWS: Readonly<Record<string, number>> = { "gpt-6-astra": 872_000 }

const isEffort = (value: unknown): value is ReasoningEffort => typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value)

/** The listed (not hidden) models of a models_cache.json payload, in the backend's order. Malformed entries are skipped. */
export function parseCodexModels(payload: unknown): ModelInfo[] {
  const models = (payload as { models?: unknown } | null)?.models
  if (!Array.isArray(models)) return []
  const out: ModelInfo[] = []
  for (const raw of models as CachedModel[]) {
    if (typeof raw?.slug !== "string" || !raw.slug || raw.visibility === "hide") continue
    const levels = Array.isArray(raw.supported_reasoning_levels) ? raw.supported_reasoning_levels : []
    const efforts = levels.map((level) => (level as { effort?: unknown })?.effort).filter(isEffort)
    const max = typeof raw.max_context_window === "number" && raw.max_context_window > 0 ? Math.floor(raw.max_context_window) : Object.hasOwn(KNOWN_MAX_CONTEXT_WINDOWS, raw.slug) ? KNOWN_MAX_CONTEXT_WINDOWS[raw.slug] : undefined
    out.push({
      id: raw.slug,
      name: typeof raw.display_name === "string" && raw.display_name ? raw.display_name : raw.slug,
      efforts,
      ...(isEffort(raw.default_reasoning_level) ? { defaultEffort: raw.default_reasoning_level } : {}),
      ...(typeof raw.context_window === "number" && raw.context_window > 0 ? { contextWindow: Math.floor(raw.context_window) } : {}),
      ...(max ? { maxContextWindow: max } : {}),
    })
  }
  return out
}
