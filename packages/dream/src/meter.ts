import { estimateTokens } from "@mendcode/protocol/wire"
/** What a model call gives back: the text, optionally with the provider's token counts. */
export type Completion = string | { text: string; usage?: { input: number; output: number } | undefined }

/** Tokens of a text when the provider reports none: about four characters each. */
export { estimateTokens } from "@mendcode/protocol/wire"

/** Room kept for the answer when deciding whether a call still fits the budget. */
const ANSWER_RESERVE_TOKENS = 1_000

export type MeterSnapshot = {
  model: { calls: number; inputTokens: number; outputTokens: number; estimated: boolean }
  budget: { limit: number; used: number; stopped: boolean; reason?: string }
}

/**
 * Counts the tokens of every model call of one run against a per-run limit. A call that would not fit is not made
 * (`refused` says why, and the run reports itself as stopped by the budget); a call already made is always kept.
 */
export function createMeter(input: { limit: number; complete(prompt: string, signal: AbortSignal): Promise<Completion>; signal: AbortSignal }) {
  const state = { calls: 0, inputTokens: 0, outputTokens: 0, estimated: false, reason: undefined as string | undefined }
  const used = () => state.inputTokens + state.outputTokens
  return {
    used,
    /** Runs one call unless its prompt, plus room for an answer, no longer fits the budget. */
    async call(prompt: string, step: string): Promise<{ text: string } | { refused: string }> {
      const needed = estimateTokens(prompt.length) + ANSWER_RESERVE_TOKENS
      if (used() + needed > input.limit) {
        const reason = `${step} skipped: it needs about ${needed} tokens and ${Math.max(0, input.limit - used())} of the ${input.limit} token budget are left`
        state.reason ??= reason
        return { refused: reason }
      }
      const completion = await input.complete(prompt, input.signal)
      const text = typeof completion === "string" ? completion : completion.text
      const usage = typeof completion === "string" ? undefined : completion.usage
      state.calls++
      if (usage) {
        state.inputTokens += usage.input
        state.outputTokens += usage.output
      } else {
        state.estimated = true
        state.inputTokens += estimateTokens(prompt.length)
        state.outputTokens += estimateTokens(text.length)
      }
      return { text }
    },
    snapshot(): MeterSnapshot {
      return {
        model: { calls: state.calls, inputTokens: state.inputTokens, outputTokens: state.outputTokens, estimated: state.estimated },
        budget: { limit: input.limit, used: used(), stopped: state.reason !== undefined, ...(state.reason ? { reason: state.reason.slice(0, 200) } : {}) },
      }
    },
  }
}
export type Meter = ReturnType<typeof createMeter>
