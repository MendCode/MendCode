/** Characters per token for text that has no reported count yet: the usual rule of thumb for English and code. */
export const CHARS_PER_TOKEN = 4

/**
 * The running output count of one turn for the activity line, never stored. `exact` is what the engine reported for the work no usage
 * record holds yet (`usage.live`); on top of it comes an estimate of what streamed since: the main agent's words and reasoning at
 * `CHARS_PER_TOKEN`, or the engine's own estimate of reasoning that streams no words (`usage.thinking`), whichever is larger for the
 * reasoning. A new exact figure covers everything before it, so the estimate starts again; a usage record clears it all.
 * Each note returns the figure to show when it changed, else undefined: the work per streamed delta is a few additions.
 */
export function createLiveOutput() {
  let exact = 0
  let textChars = 0
  let reasoningChars = 0
  let thinking = 0
  let shown = 0
  let shownEstimated = false

  function figure() {
    const reasoning = Math.max(Math.ceil(reasoningChars / CHARS_PER_TOKEN), thinking)
    const estimate = Math.ceil(textChars / CHARS_PER_TOKEN) + reasoning
    const output = exact + estimate
    const estimated = estimate > 0
    if (output === shown && estimated === shownEstimated) return undefined
    shown = output
    shownEstimated = estimated
    return { output, estimated }
  }

  return {
    /** The engine's own count for the turn's unrecorded work (`usage.live`): it includes everything streamed before it. */
    exact(output: number) {
      exact = Math.max(0, output)
      textChars = 0
      reasoningChars = 0
      thinking = 0
      return figure()
    },
    /** Words the main agent streamed: an answer (`text`) or its reasoning. */
    streamed(kind: "text" | "reasoning", chars: number) {
      if (chars <= 0) return undefined
      if (kind === "text") textChars += chars
      else reasoningChars += chars
      return figure()
    },
    /** The engine's estimate of the reasoning tokens of the call in flight that stream no words (`usage.thinking`). */
    thinking(tokens: number) {
      thinking = Math.max(0, tokens)
      return figure()
    },
    /** A usage record took the figures: nothing is left to show (0 is pushed once when something was shown). */
    recorded() {
      exact = 0
      textChars = 0
      reasoningChars = 0
      thinking = 0
      return figure()
    },
  }
}
