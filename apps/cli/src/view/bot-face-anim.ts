/** Experimental bots: what a face shows and how it moves. Small and import-free; `bot-face.ts` draws it. */
export const FACE_STATES = ["sleeping", "listening", "thinking", "talking", "waiting", "problem"] as const
export type FaceState = (typeof FACE_STATES)[number]

/** Pictures a state cycles through; the others hold one. */
const FRAMES: Readonly<Partial<Record<FaceState, number>>> = { sleeping: 2, thinking: 2, talking: 2 }
/** How long each picture stays: 250 ms or more, so at most 4 pictures a second. */
export const FACE_FRAME_MS: Readonly<Partial<Record<FaceState, number>>> = { sleeping: 1200, thinking: 600, talking: 400 }

export const faceFrameCount = (state: FaceState) => FRAMES[state] ?? 1

/**
 * The frame clock of one visible face. It follows the bot's state: a state that moves (sleeping, thinking, talking) steps
 * through its pictures while the face is on screen and motion is allowed; every other case, and a hidden face, holds the first
 * picture with no timer at all. One timer at most, unref'd so it never keeps the process alive.
 */
export function createFaceAnimator(input: {
  onChange(): void
  reducedMotion?(): boolean
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}) {
  const setTimer = input.setTimer ?? ((run, ms) => { const made = setTimeout(run, ms); made.unref?.(); return made })
  const clearTimer = input.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let state: FaceState = "sleeping"
  let visible = false
  let stopped = false
  let index = 0
  let timer: unknown

  const animate = () => visible && !stopped && !input.reducedMotion?.() && faceFrameCount(state) > 1

  function arm() {
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    if (animate()) timer = setTimer(tick, FACE_FRAME_MS[state] ?? 400)
  }

  function tick() {
    timer = undefined
    index = (index + 1) % faceFrameCount(state)
    arm()
    input.onChange()
  }

  return {
    /** Follows the bot's state: a new state starts at its first picture and repaints once. */
    setState(next: FaceState) {
      if (next === state) return
      state = next
      index = 0
      arm()
      input.onChange()
    },
    /** Called whenever the face enters or leaves the screen: the timer exists only while it is shown. */
    setVisible(next: boolean) {
      if (next === visible) return
      visible = next
      if (!next) index = 0
      arm()
    },
    frame: () => (animate() ? index : 0),
    get armed() {
      return timer !== undefined
    },
    stop() {
      stopped = true
      if (timer !== undefined) clearTimer(timer)
      timer = undefined
    },
  }
}
