import type { ReasoningState } from "./provider"

/** Signed gateway reasoning is opaque and only replays to its originating provider/model. */
export function zenmuxReasoning(state: ReasoningState | undefined, model: string): Record<string, unknown> {
  if (state?.provider !== "zenmux" || state.model !== model) return {}
  const block = state.blocks[0] as { reasoning?: unknown; reasoning_details?: unknown } | undefined
  if (!block || !Array.isArray(block.reasoning_details)) return {}
  return { ...(typeof block.reasoning === "string" ? { reasoning: block.reasoning } : {}), reasoning_details: block.reasoning_details }
}

/** SSE string fragments concatenate; index/type bind details whose signatures arrive later. */
export function zenmuxReasoningStream(model: string) {
  const details = new Map<string, Record<string, unknown>>()
  let text = ""
  return {
    add(thought: string | undefined | null, parts: unknown) {
      if (thought) text += thought
      if (!Array.isArray(parts)) return
      parts.forEach((part, index) => {
        if (!part || typeof part !== "object" || Array.isArray(part)) return
        const key = String(part.index ?? index)
        const previous = details.get(key) ?? {}
        const next = { ...previous, ...part }
        for (const field of ["text", "summary", "signature", "data"]) {
          if (typeof part[field] === "string") next[field] = String(previous[field] ?? "") + part[field]
        }
        details.set(key, next)
      })
    },
    state(): ReasoningState | undefined {
      return details.size ? { provider: "zenmux", model, blocks: [{ reasoning: text, reasoning_details: [...details.values()] }] } : undefined
    },
  }
}
