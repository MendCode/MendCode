/**
 * Keeps the client's resident memory near what it really holds. A frame builds a few hundred KB of short-lived rows,
 * spans and strings; the runtime collects them late, so the process asks the OS for fresh pages until a collection runs
 * (about 45 MB over the first hundred frames, 25 to 40 MB more after scrolling a long history: docs/performance.md).
 * A full collection every few frames costs about 2 ms on a client heap of 10 to 25 MB and keeps the process reusing the
 * pages it has.
 */
export const FRAMES_PER_COLLECTION = 8

export type MemoryGovernor = { frame(): void }

function runtimeCollect() {
  if (typeof Bun !== "undefined") Bun.gc(true)
}

/** A collection that costs more than this stretches the wait to the next one in proportion (the design point above is 2 ms). */
export const COLLECTION_BUDGET_MS = 4

/**
 * Counts drawn frames and collects every `every` of them. `every` of 0 turns it off (`MENDCODE_GC_FRAMES=0`); `collect`
 * is replaceable so tests can watch the schedule without running a collection.
 *
 * A full collection costs time in proportion to the heap, and the interval above assumes a 10 to 25 MB client. When one takes
 * `ms` milliseconds the next waits `every * ceil(ms / COLLECTION_BUDGET_MS)` frames, so a heap that grew (a long history, a
 * large transcript, a test process holding hundreds of files) pays a bounded share of the frames instead of a stall every
 * `every` of them: a 250 ms collection once stretched a 100-frame test to 8 s, and past the 15 s limit on a CI runner.
 */
export function createMemoryGovernor(options: { every?: number; collect?: () => void; now?: () => number } = {}): MemoryGovernor {
  const every = options.every ?? FRAMES_PER_COLLECTION
  const collect = options.collect ?? runtimeCollect
  const now = options.now ?? (() => performance.now())
  let frames = 0
  let wait = every
  return {
    frame() {
      if (every <= 0 || ++frames < wait) return
      frames = 0
      const started = now()
      collect()
      wait = every * Math.max(1, Math.ceil((now() - started) / COLLECTION_BUDGET_MS))
    },
  }
}

/** `MENDCODE_GC_FRAMES`: a whole number of frames between collections, 0 for never; anything else keeps the default. */
export function framesPerCollection(env: Record<string, string | undefined>) {
  const value = env.MENDCODE_GC_FRAMES
  if (value === undefined || !/^\d{1,4}$/.test(value)) return FRAMES_PER_COLLECTION
  return Number(value)
}
