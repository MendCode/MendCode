import { clampWindow, modelContextOf, MODEL_CONTEXT_RANGE, type ModelContextSettings, type ModelInfo, type SessionId } from "@mendcode/protocol"

/** Where a session's context-window override (`session.context-window`) lives: the store's small-facts table. */
export const contextWindowKey = (sessionId: SessionId) => `session.contextWindow:${sessionId}`

/** The override in tokens, or undefined when the session follows its model (a missing, empty or broken value). */
export function readContextWindow(meta: { get(key: string): string | undefined }, sessionId: SessionId): number | undefined {
  const tokens = Number(meta.get(contextWindowKey(sessionId)))
  return Number.isInteger(tokens) && tokens >= MODEL_CONTEXT_RANGE.min && tokens <= MODEL_CONTEXT_RANGE.max ? tokens : undefined
}

export type WindowOverride = { tokens: number; source: "session" | "model-setting" }

/**
 * The window the user chose for a session on `model`: the session's own `/context-window`, else the model's `modelContext`
 * window; never above the model's known maximum. Undefined when the session follows the catalog.
 */
export function windowOverride(input: { meta: { get(key: string): string | undefined }; sessionId: SessionId; model: Pick<ModelInfo, "id" | "provider" | "engine" | "maxContextWindow"> | undefined; settings: ModelContextSettings }): WindowOverride | undefined {
  const session = readContextWindow(input.meta, input.sessionId)
  const tokens = session ?? modelContextOf(input.settings, input.model)?.window
  if (!tokens) return undefined
  return { tokens: clampWindow(tokens, input.model?.maxContextWindow).tokens, source: session ? "session" : "model-setting" }
}
