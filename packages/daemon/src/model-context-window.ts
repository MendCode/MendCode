import { clampWindow, modelRef, type ModelContextEntry, type ModelInfo, type SessionId, type Settings } from "@mendcode/protocol"
import { contextWindowKey } from "./session-context-window"

export type ContextWindowAck = {
  contextWindow?: number
  /** The window asked for when it was lowered to `maxContextWindow`. */
  requested?: number
  maxContextWindow?: number
  /** The model list's window for the model, to tell a window beyond it. */
  modelWindow?: number
  clamped?: true
  /** The `modelContext` key written with `always`. */
  model?: string
  saved?: "set" | "removed"
}

/**
 * `session.context-window`: the session's own window, lowered to the model's known maximum. With `always` the window goes to the
 * model's `modelContext` instead (through the settings store, so it is validated like `settings.set`) and the session's own
 * window is cleared, so this session and every later one on the model follow the setting; `tokens: null` removes it.
 */
export function sessionContextWindow(input: {
  meta: { set(key: string, value: string): void }
  settings: { get(): Settings; set(patch: Record<string, unknown>): Settings }
  sessionId: SessionId
  tokens: number | null
  always: boolean
  /** The catalog entry of the session's main model; undefined when the catalog does not list it. */
  model: ModelInfo | undefined
  /** The session's main model id, to name it when the catalog does not list it. */
  modelId: string | undefined
}): { ok: true; result: ContextWindowAck; settings?: Settings } | { ok: false; message: string } {
  const max = input.model?.maxContextWindow
  const window = input.tokens === null ? undefined : clampWindow(input.tokens, max)
  const fit: ContextWindowAck = window ? { contextWindow: window.tokens, ...(max ? { maxContextWindow: max } : {}), ...(input.model?.contextWindow ? { modelWindow: input.model.contextWindow } : {}), ...(window.clamped ? { clamped: true as const, requested: input.tokens! } : {}) } : {}
  if (!input.always) {
    input.meta.set(contextWindowKey(input.sessionId), window ? String(window.tokens) : "")
    return { ok: true, result: fit }
  }
  if (!input.model) return { ok: false, message: `--always needs a model from the model list; ${input.modelId ? `${input.modelId} is not listed` : "this session has no model"}` }
  const ref = modelRef(input.model)
  const entries = { ...input.settings.get().modelContext }
  const { window: _previous, ...rest } = entries[ref] ?? {}
  const entry: ModelContextEntry = window ? { ...rest, window: window.tokens } : rest
  if (entry.window !== undefined || entry.compactAt !== undefined) entries[ref] = entry
  else delete entries[ref]
  let settings: Settings
  try {
    settings = input.settings.set({ modelContext: Object.keys(entries).length ? entries : null })
  } catch (error) {
    return { ok: false, message: `invalid settings: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}` }
  }
  input.meta.set(contextWindowKey(input.sessionId), "")
  return { ok: true, result: { ...fit, model: ref, saved: window ? "set" : "removed" }, settings }
}
