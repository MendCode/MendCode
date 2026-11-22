/** The least time between two frames while output streams: 30 a second reads as live text, and a whole-screen frame costs a few ms. */
export const FRAME_GAP_MS = 33
/** A frame asked for after a rest still goes out after this short wait, so a key press answers as fast as before. */
const FRAME_WAIT_MS = 16
/** The least time between two asks of the daemon for the same list when its changes arrive as a stream (sub-agents at work). */
export const REFRESH_GAP_MS = 300

/** The default frame scheduler: one frame per request burst, never closer than `FRAME_GAP_MS` to the one before. */
export function pacedFrames(clock: () => number = () => performance.now()): (fn: () => void) => void {
  let last = -Infinity
  return (fn) => {
    const wait = Math.max(FRAME_WAIT_MS, last + FRAME_GAP_MS - clock())
    void setTimeout(() => {
      last = clock()
      fn()
    }, wait)
  }
}

/**
 * `run` at most once per `gapMs`: the first call goes out at once, calls inside the gap fold into one that follows when it ends.
 * For a list asked again on every change of something that changes many times a second.
 */
export function paced(run: () => void, gapMs: number = REFRESH_GAP_MS, clock: () => number = () => performance.now()): () => void {
  let last = -Infinity
  let timer: ReturnType<typeof setTimeout> | undefined
  return () => {
    if (timer) return
    const wait = last + gapMs - clock()
    if (wait <= 0) {
      last = clock()
      run()
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      last = clock()
      run()
    }, wait)
    timer.unref?.()
  }
}
