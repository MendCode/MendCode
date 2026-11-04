import { edenGC } from "bun:jsc"
import type { Clock, TimerHandle } from "@mendcode/kernel"

/** How long the daemon stays idle before it collects: long enough that a follow-up message does not pay for it. */
export const IDLE_GC_MS = 30_000

/**
 * How long after start the first collection waits. Start-up leaves its garbage too (module evaluation, the first commands of
 * the clients, settings and catalogs read once): a fresh prompt held 41 MB of heap of which 24 survived a collection, and
 * nothing else collects it until a turn ends.
 */
export const STARTUP_GC_MS = 10_000

/**
 * A full collection, then the allocator hands the pages it freed back to the system. Without the second step the freed pages
 * stay in the process's physical footprint until memory runs short: a fresh prompt kept 72 MB where 65 MB was in use, and
 * after a first turn 77 MB where 68 MB was. It costs well under a millisecond here; the scavenging runs on its own thread.
 */
export function collectAndRelease() {
  Bun.gc(true)
  Bun.shrink()
}

/** Work built ahead of the first turn, a few pieces at a time; `between` is awaited after each few. */
export type Warm = (between: () => Promise<void>) => Promise<void>

/**
 * A full collection once the daemon has been idle a while. JavaScriptCore collects lazily, so after a few turns the garbage
 * of their requests and streams stays resident (a daemon measured at 305 MB went to 164 MB, with 60 MB of live heap, after
 * one). Each new idle moment restarts the wait; work starting meanwhile skips the collection.
 *
 * `started` arms the same collection for the garbage of start-up, sooner, and an idle moment before it does not push it back.
 * Its `warm` runs first: between its steps the daemon yields (a turn can start) and collects the young garbage, so building
 * it never takes more memory than one step does.
 */
export function createIdleGc(input: { clock: Clock; busy(): boolean; gc?(): void; youngGc?(): void; delayMs?: number; startupDelayMs?: number }) {
  const gc = input.gc ?? collectAndRelease
  const youngGc = input.youngGc ?? (() => void edenGC())
  let timer: TimerHandle | undefined
  let warm: Warm | undefined
  /** The start-up collection is armed and has not run yet. */
  let startup = false
  const yieldTurn = () => new Promise<void>((resolve) => { input.clock.setTimer(0, resolve).unref?.() })
  const between = async () => {
    await yieldTurn()
    if (!input.busy()) youngGc()
  }
  const collect = () => {
    const pending = warm
    warm = undefined
    if (!pending) return gc()
    // Warming is an optimization: whatever it could not build, the first turn builds as before.
    void pending(between).catch(() => {}).finally(() => { if (!input.busy()) gc() })
  }
  const arm = (delayMs: number) => {
    timer?.cancel()
    timer = input.clock.setTimer(delayMs, () => {
      timer = undefined
      startup = false
      if (!input.busy()) collect()
    })
    timer.unref?.()
  }
  return {
    idle() {
      if (startup && timer) return
      arm(input.delayMs ?? IDLE_GC_MS)
    },
    started(prepare?: Warm) {
      warm = prepare
      startup = true
      arm(input.startupDelayMs ?? STARTUP_GC_MS)
    },
    stop() {
      timer?.cancel()
      timer = undefined
      warm = undefined
    },
  }
}
