import { backoffMs, RetryableProviderError, type ModelEvent } from "@mendcode/engine-native"

/** Retries of one tool-less completion (Dream, `/btw`, memory extraction) after a passing provider failure: about 30 s in all. */
export const COMPLETION_RETRIES = 6

function abortableSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => (clearTimeout(timer), signal.removeEventListener("abort", done), resolve())
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

/**
 * The events of one completion, sent again when the provider fails in a way that passes by itself (overloaded, rate limited,
 * a dropped stream). A turn has the engine's own retries; a single completion called the provider once and failed on the
 * first overload. Once text has streamed the failure is final, so a caller that shows text never sees it twice.
 */
export async function* retryingCompletion(input: {
  attempt: () => AsyncIterable<ModelEvent>
  signal: AbortSignal
  retries?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}): AsyncGenerator<ModelEvent> {
  const { attempt, signal, retries = COMPLETION_RETRIES, sleep = abortableSleep } = input
  for (let tries = 0; ; tries++) {
    let streamed = false
    try {
      for await (const event of attempt()) {
        if (event.type === "text") streamed = true
        yield event
      }
      return
    } catch (error) {
      if (!(error instanceof RetryableProviderError) || streamed || signal.aborted || tries >= retries) throw error
      await sleep(Math.max(error.retryAfterMs ?? 0, backoffMs(tries)), signal)
      if (signal.aborted) throw error
    }
  }
}
