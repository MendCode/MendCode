/**
 * The per-model context setting (`modelContext`, docs/compaction.md C7). Zod-free: thin clients import it through
 * "@mendcode/protocol/wire". Only the fields read are required, so `ModelInfo` and lighter rows both fit.
 */
type Row = { id: string; provider?: string | undefined; engine?: string | undefined }

/** Tokens a context window (or compaction point) may be set to, by `/context-window` or `modelContext`. */
export const MODEL_CONTEXT_RANGE = { min: 1_000, max: 10_000_000 } as const
/** At most this many models carry a `modelContext` entry. */
export const MODEL_CONTEXT_LIMIT = 200

export type ModelContextEntry = { window?: number | undefined; compactAt?: number | undefined }
export type ModelContextSettings = { modelContext?: Record<string, ModelContextEntry> | undefined }

/** The reference `mendcode models` prints and `modelContext` is keyed by: `chatgpt/gpt-6-astra`, `openai/gpt-6-astra`, `claude/claude-opus`. */
export function modelRef(model: Row): string {
  const provider = model.provider ?? model.engine ?? "chatgpt"
  return `${provider}/${model.provider ? model.id.slice(model.provider.length + 1) : model.id}`
}

/** The `modelContext` entry of a catalog model, or undefined when it has none. */
export function modelContextOf(settings: ModelContextSettings, model: Row | undefined): ModelContextEntry | undefined {
  return model ? settings.modelContext?.[modelRef(model)] : undefined
}

/** A window no larger than the model's known maximum (`maxContextWindow`); without one the window is kept as asked. */
export function clampWindow(tokens: number, max: number | undefined): { tokens: number; clamped: boolean } {
  return max !== undefined && tokens > max ? { tokens: max, clamped: true } : { tokens, clamped: false }
}
