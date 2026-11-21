/** Events of one direction closer together than this belong to the same swipe. */
export const SWIPE_GAP_MS = 150
/** Events it takes to count as a swipe: a single stray notch of a sideways wheel never toggles the list. */
export const SWIPE_EVENTS = 3
/** After a swipe fired, sideways events keep being ignored until this long passed without one (the tail of a trackpad's inertia). */
export const SWIPE_COOLDOWN_MS = 400

export type SwipeDirection = "left" | "right"

/** SGR wheel buttons 66 and 67 are a sideways wheel: left and right (the modifier bits are not part of it). */
export function swipeButton(button: number): SwipeDirection | undefined {
  const plain = button & ~(4 | 8 | 16)
  return plain === 66 ? "left" : plain === 67 ? "right" : undefined
}

/**
 * Tells swipes from single sideways events. `feed` takes each sideways event with its time and returns the direction once, when the
 * third event of a swipe arrives; the rest of that swipe, and whatever follows within the cooldown, returns undefined. It keeps three
 * numbers and no timer: the cooldown is a comparison of timestamps.
 */
export function createSwipe() {
  let direction: SwipeDirection | undefined
  let count = 0
  let last = Number.NEGATIVE_INFINITY
  let fired = false
  return {
    feed(at: number, next: SwipeDirection): SwipeDirection | undefined {
      const since = at - last
      last = at
      if (fired) {
        if (since < SWIPE_COOLDOWN_MS) return undefined
        fired = false
        count = 0
      }
      if (next !== direction || since > SWIPE_GAP_MS) count = 0
      direction = next
      count++
      if (count < SWIPE_EVENTS) return undefined
      fired = true
      return next
    },
  }
}
