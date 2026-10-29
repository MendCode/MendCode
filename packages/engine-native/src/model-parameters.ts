import type { ModelRequest } from "./provider"

/** Merge generation options after adapter defaults; conversation and transport remain adapter-owned. */
export function modelParameters(body: Record<string, unknown>, request: ModelRequest): Record<string, unknown> {
  const out = { ...body }
  const reserved = new Set(["model", "messages", "input", "instructions", "system", "tools", "tool_choice", "stream", "store", "headers", "url", "apiKey", "authorization", "prompt_cache_key"])
  for (const [key, value] of Object.entries(request.parameters ?? {})) {
    if (reserved.has(key)) continue
    const previous = out[key]
    out[key] = value && typeof value === "object" && !Array.isArray(value) && previous && typeof previous === "object" && !Array.isArray(previous) ? { ...previous, ...value } : value
  }
  // A caller's bounded auxiliary request wins over a variant's generous generation cap.
  if (request.maxOutputTokens) for (const key of ["max_tokens", "max_output_tokens", "max_completion_tokens"]) {
    const cap = Math.max(16, request.maxOutputTokens)
    if (key in out) out[key] = Math.min(typeof out[key] === "number" && out[key] > 0 ? out[key] : cap, cap)
  }
  return out
}
