/**
 * Picking an answer back up after the connection dropped mid-stream. The backend keeps nothing to resume from, so the
 * partial answer goes back as history with a prompt asking the model to carry on from its last character, and whatever
 * the model repeats of the partial is trimmed before it reaches the user.
 */

/** Characters of the continuation held back before deciding how much of it repeats the partial. */
export const CONTINUATION_HOLD = 200

/** Longest suffix of `partial` (at least `minOverlap` characters, at most `maxWindow`) that `continuation` starts with. */
export function overlapLength(partial: string, continuation: string, { minOverlap = 6, maxWindow = 2_000 } = {}) {
  const tail = partial.slice(-maxWindow)
  for (let length = Math.min(tail.length, continuation.length); length >= minOverlap; length--) if (continuation.startsWith(tail.slice(-length))) return length
  return 0
}

/**
 * The part of `continuation` that is new. A model that restarted from the top of the partial keeps only what extends
 * past it; one that re-emitted the partial's last words loses that overlap.
 */
export function stitch(partial: string, continuation: string) {
  const restart = Math.min(partial.length, CONTINUATION_HOLD)
  // A restart the stream cut short, before it got past the partial, adds nothing yet.
  if (continuation.length >= 20 && partial.startsWith(continuation)) return ""
  if (restart >= 20 && continuation.startsWith(partial.slice(0, restart))) return continuation.startsWith(partial) ? continuation.slice(partial.length) : continuation
  return continuation.slice(overlapLength(partial, continuation))
}

/**
 * Streams a continuation of `partial`: deltas are held until `CONTINUATION_HOLD` characters (or the end) show how much
 * repeats the partial, then only the new text passes. `push` and `flush` return the text to show, possibly empty.
 */
export function continuationStream(partial: string) {
  let held = ""
  let decided = false
  return {
    push(delta: string) {
      if (decided) return delta
      held += delta
      const needed = Math.min(CONTINUATION_HOLD, partial.length)
      // Held text found nowhere in the partial cannot be the start of a repeat, so there is nothing more to wait for.
      if (held.length < needed && partial.slice(-2_000).includes(held)) return ""
      decided = true
      return stitch(partial, held)
    },
    flush() {
      if (decided) return ""
      decided = true
      return stitch(partial, held)
    },
  }
}
