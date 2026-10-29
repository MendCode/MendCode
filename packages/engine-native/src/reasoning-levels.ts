import { REASONING_EFFORTS, type ProviderModel, type ReasoningEffort } from "@mendcode/protocol"
import type { ReasoningStyle } from "./openai-compatible"

const isEffort = (value: unknown): value is ReasoningEffort => typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value)

/** Levels a reasoning model offers when its catalog entry names none: DeepSeek's own API takes low/high/max (as OpenCode offers it), the rest low/medium/high. */
export function protocolEfforts(style: ReasoningStyle | undefined): readonly ReasoningEffort[] {
  return style === "deepseek" ? ["low", "high", "max"] : ["low", "medium", "high"]
}

/**
 * The levels a model's catalog entry (models.dev `reasoning_options`) makes selectable, in the catalog's order, or
 * undefined when the entry says nothing, so the caller keeps its own list. An empty `reasoning_options` means the model
 * reasons with no control (`[]`). `effort` gives its values (`default` is the host's own choice, not a level; levels
 * this version does not know are left out) or, without values, the protocol's. `toggle` gives `none` only where the wire
 * can switch thinking off (DeepSeek's `thinking: disabled`), as OpenCode does; `budget_tokens` alone gives no level here.
 */
export function catalogEfforts(model: Pick<ProviderModel, "reasoning_options">, style?: ReasoningStyle): ReasoningEffort[] | undefined {
  const options = model.reasoning_options
  if (!options) return undefined
  const effort = options.find((option) => option.type === "effort")
  const toggled = style === "deepseek" && options.some((option) => option.type === "toggle") ? ["none" as const] : []
  const levels = effort ? (effort.values ? effort.values.filter(isEffort) : [...protocolEfforts(style)]) : []
  return [...new Set<ReasoningEffort>([...toggled, ...levels])]
}

/** The levels a provider's model offers: the catalog's when it names them, else the protocol's for a model marked as reasoning. */
export function modelEfforts(model: Pick<ProviderModel, "reasoning_options" | "effort" | "reasoning">, style?: ReasoningStyle): ReasoningEffort[] {
  const catalog = model.effort === false ? undefined : catalogEfforts(model, style)
  if (catalog) return catalog
  return model.effort || model.reasoning ? [...protocolEfforts(style)] : []
}
