/** A long computation written as a generator: it yields between small steps (one row of pixels) and returns its result. */
export type Steps<T> = Generator<void, T, void>

/** Runs the steps back to back, for callers that are not on the event loop (tests, scripts). */
export function drain<T>(job: Steps<T>): T {
  for (;;) {
    const step = job.next()
    if (step.done) return step.value
  }
}

/**
 * Runs the steps in slices of `sliceMs`, giving the event loop a turn between slices so keys, frames and the daemon's events are
 * served while a big picture is decoded or scaled. A picture that decodes in 300 ms in one go freezes the terminal that long.
 */
export async function drainCooperatively<T>(job: Steps<T>, sliceMs = 6): Promise<T> {
  let sliceStart = performance.now()
  for (;;) {
    const step = job.next()
    if (step.done) return step.value
    if (performance.now() - sliceStart >= sliceMs) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      sliceStart = performance.now()
    }
  }
}
