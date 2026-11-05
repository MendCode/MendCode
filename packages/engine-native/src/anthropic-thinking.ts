import type { ReasoningEffort } from "@mendcode/protocol"

/**
 * What a Claude model accepts for `thinking` (https://platform.claude.com/docs/en/build-with-claude/thinking, the per-model table).
 * The catalog's `reasoning_options` cannot say it: Opus 4.5 lists `effort` and still wants `budget_tokens`, Opus 5.5 lists `effort`
 * and answers `budget_tokens` with a 400. So the shape comes from the model id's family and version, here and nowhere else.
 *
 * - `budget`: `{type:"enabled", budget_tokens}` (Haiku 4.5, Opus/Sonnet 4.6 and older, ids this table does not know): unchanged.
 * - `adaptive`: `{type:"adaptive"}` plus `output_config.effort`; `budget_tokens` is a 400. `off` is how thinking is switched off:
 *   `omit` (Opus 4.7/4.8 think only when asked), `disabled` (Opus 5, Sonnet 5, Haiku 5.5, at effort `high` or below),
 *   `between_tools` (Sonnet 5.5: `disabled` is a 400) or `never` (Fable, Mythos, Opus 5.5: thinking cannot be turned off, only lowered).
 */
export type AnthropicThinkingStyle = { style: "budget" } | { style: "adaptive"; off: "omit" | "disabled" | "between_tools" | "never" }

const MODEL_ID = /claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/

/** The least a thinking budget can be; a bounded request below this thinks not at all. */
export const MIN_THINKING_TOKENS = 1_024

export function anthropicThinkingStyle(model: string): AnthropicThinkingStyle {
  const match = MODEL_ID.exec(model.toLowerCase())
  if (!match) return { style: "budget" }
  const family = match[1]
  const version = Number(match[2]) + Number(match[3] ?? 0) / 10
  if (family === "fable" || family === "mythos") return { style: "adaptive", off: "never" }
  if (family === "opus") return version >= 5.5 ? { style: "adaptive", off: "never" } : version >= 5 ? { style: "adaptive", off: "disabled" } : version >= 4.7 ? { style: "adaptive", off: "omit" } : { style: "budget" }
  if (family === "sonnet") return version >= 5.5 ? { style: "adaptive", off: "between_tools" } : version >= 5 ? { style: "adaptive", off: "disabled" } : { style: "budget" }
  return version >= 5.5 ? { style: "adaptive", off: "disabled" } : { style: "budget" }
}

/** MendCode's `/effort` levels the API takes as they are. `none` and `minimal` mean thinking off. */
const API_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh", "max"])
/** Room for the thinking and the answer together when nothing sets the output cap: adaptive thinking counts against `max_tokens`. */
const DEEP_MAX_TOKENS = 64_000
const DEEP_EFFORTS = new Set<ReasoningEffort>(["high", "xhigh", "max"])

export type AdaptiveFields = { thinking?: Record<string, unknown>; output_config?: { effort: string } }

/**
 * The `thinking` and `output_config` fields for an adaptive model, or undefined for a model that takes a budget. Thinking is
 * `display: "summarized"` so the reasoning keeps streaming as text (the new models default to an empty `omitted`). Where
 * thinking cannot be switched off, off means the lowest effort.
 */
export function adaptiveThinking(input: { model: string; effort: ReasoningEffort | undefined; maxOutputTokens?: number | undefined }): AdaptiveFields | undefined {
  const style = anthropicThinkingStyle(input.model)
  if (style.style !== "adaptive") return undefined
  const wanted = input.effort !== undefined && API_EFFORTS.has(input.effort) && !(input.maxOutputTokens !== undefined && input.maxOutputTokens < MIN_THINKING_TOKENS)
  if (wanted) return { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: input.effort! } }
  if (style.off === "never") return { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "low" } }
  if (style.off === "disabled") return { thinking: { type: "disabled" } }
  if (style.off === "between_tools") return { thinking: { type: "between_tools" } }
  return {}
}

/** Output cap for an adaptive request nothing else bounds. */
export const adaptiveMaxTokens = (effort: ReasoningEffort | undefined, fields: AdaptiveFields | undefined, floor: number) =>
  fields?.thinking?.type === "adaptive" && effort !== undefined && DEEP_EFFORTS.has(effort) ? Math.max(floor, DEEP_MAX_TOKENS) : floor

/** The 400 the API gives a signed thinking block it cannot accept (the conversation before it changed, https://platform.claude.com/docs/en/build-with-claude/thinking). */
export const isThinkingSignatureRefusal = (message: string) => /Invalid `signature` in `thinking` block|block_binding|prefix_mismatch_behavior/.test(message)

type Block = Record<string, unknown>

/** The request without any `thinking` or `redacted_thinking` block in its messages (the same object when it has none): the documented way past that 400. */
export function withoutThinkingBlocks(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body
  let changed = false
  const messages = (body.messages as Array<{ content?: unknown }>).flatMap((message) => {
    if (!Array.isArray(message.content)) return [message]
    const content = (message.content as Block[]).filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking")
    if (content.length === message.content.length) return [message]
    changed = true
    // A turn that was only thinking has nothing left to send.
    return content.length ? [{ ...message, content }] : []
  })
  return changed ? { ...body, messages } : body
}
