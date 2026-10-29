import type { ForegroundState } from "@mendcode/protocol"
import { PET_FRAME_DURATIONS, rowOrFallback, type PetRow } from "./frames"

/** How long the pet shows `review` after a turn ends. */
export const REVIEW_MS = 4_000
/** How long a session rests (nothing running, nothing waiting on the user) before the pet sleeps. */
export const SLEEP_MS = 5 * 60_000

/** What the foreground state does not say: the item in flight (`view/turn-state.ts`) and whether sub-agents of the session are at work. */
export type PetSignals = { current?: { kind: string; tool?: string } | undefined; agents?: boolean | undefined }

/** The tool call that hands the step to sub-agents. */
const AGENT_TOOL = /^(task|subagents?)$/

/**
 * The pet's resting row for what the session is doing. When several things hold: failed, waiting on an approval,
 * compacting, what the main agent itself does (thinking while only reasoning streams, running otherwise), agents while
 * it only waits for sub-agents or they work on after its turn, idle.
 */
export function restingRow(foreground: ForegroundState, signals: PetSignals = {}): PetRow {
  const { current } = signals
  if (foreground === "waiting_approval") return "waiting"
  if (foreground === "error") return "failed"
  if (foreground === "compacting" || current?.kind === "compaction") return "compacting"
  if (foreground === "idle") return signals.agents ? "agents" : "idle"
  if (current?.kind === "reasoning") return "thinking"
  if (foreground === "tool" && current?.kind === "tool_call" && AGENT_TOOL.test(current.tool ?? "")) return "agents"
  return "running"
}

/**
 * Which pet frame shows, following the session: idle, running while it works, waiting on an approval, failed on an
 * error, `review` for 4 s after a turn, and one pass of `waving` (a new session) or `jumping` (an approved loop). A pet
 * that has them (`has`; the Codex atlas has none) also shows thinking, compacting, agents, and sleeping once the session
 * has rested for `SLEEP_MS`; otherwise the stand-in of `PET_ROW_FALLBACK` shows, with no change of row in between.
 * One timer at most: it animates only while `animate()` holds (visible, focused, motion allowed); otherwise the first
 * frame of the row shows and a timer runs only to end a `review` or a one-pass row. The wait for sleep is that same
 * timer, armed only while `animate()` holds and the pet has a sleeping row; anything the session does wakes it.
 *
 * `durations` gives a pet's own timing for a row (an imported pet; the Codex timings otherwise). A row of one frame, or of
 * none, does not move: it gets no frame timer, and a greeting that would play nothing is skipped.
 */
export function createPetController(input: {
  now(): number
  animate(): boolean
  onChange(): void
  durations?: (row: PetRow) => readonly number[] | undefined
  has?: (row: PetRow) => boolean
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}) {
  // The wait for sleep is minutes long: it must not keep the process alive.
  const setTimer = input.setTimer ?? ((run, ms) => { const made = setTimeout(run, ms); made.unref?.(); return made })
  const clearTimer = input.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const has = input.has ?? ((of: PetRow) => of in PET_FRAME_DURATIONS)
  /** What the session asks for; the row that shows is this one or its stand-in. */
  let wanted: PetRow = "idle"
  /** A row shown for a while on top of the resting one. */
  let passing: { row: PetRow; until: number } | undefined
  /** When the pet last changed what it shows, and whether it has slept since. */
  let since = input.now()
  let asleep = false
  let index = 0
  let timer: unknown
  let stopped = false

  const resting = () => rowOrFallback(wanted, has)
  const row = () => passing?.row ?? (asleep ? "sleeping" : resting())
  const times = (of: PetRow) => input.durations?.(of) ?? (PET_FRAME_DURATIONS as Partial<Record<PetRow, readonly number[]>>)[of] ?? []
  const moves = (of: PetRow) => times(of).length > 1
  const sleeps = () => !asleep && !passing && resting() === "idle" && input.animate() && has("sleeping")

  function show(next: PetRow, until?: number) {
    passing = until === undefined ? undefined : { row: next, until }
    wake()
    arm()
    input.onChange()
  }

  function wake() {
    asleep = false
    since = input.now()
    index = 0
  }

  function tick() {
    timer = undefined
    if (passing && input.now() >= passing.until) {
      passing = undefined
      index = 0
    } else if (sleeps() && input.now() >= since + SLEEP_MS) {
      asleep = true
      index = 0
    } else if (input.animate()) index = (index + 1) % Math.max(1, times(row()).length)
    arm()
    input.onChange()
  }

  function arm() {
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    if (stopped) return
    const untilEnd = passing ? Math.max(0, passing.until - input.now()) : Number.POSITIVE_INFINITY
    const nextFrame = input.animate() && moves(row()) ? (times(row())[index] ?? 150) : Number.POSITIVE_INFINITY
    const untilSleep = sleeps() ? Math.max(0, since + SLEEP_MS - input.now()) : Number.POSITIVE_INFINITY
    const wait = Math.min(untilEnd, nextFrame, untilSleep)
    if (Number.isFinite(wait)) timer = setTimer(tick, wait)
  }

  return {
    /** Follows the session's foreground state and what else it is doing; a busy session going idle shows `review` first. */
    setForeground(foreground: ForegroundState, signals?: PetSignals) {
      const before = resting()
      wanted = restingRow(foreground, signals)
      const next = resting()
      const finished = before !== "idle" && before !== "failed" && next === "idle"
      if (next === before && !finished) return
      if (finished) show("review", input.now() + REVIEW_MS)
      else if (!passing || passing.row === "review") show(next)
    },
    /** One pass of a greeting (`waving`) or a celebration (`jumping`). */
    cheer(next: "waving" | "jumping") {
      if (moves(next)) show(next, input.now() + times(next).reduce((sum, ms) => sum + ms, 0))
    },
    current(): { row: PetRow; index: number } {
      return { row: row(), index: input.animate() ? Math.min(index, Math.max(0, times(row()).length - 1)) : 0 }
    },
    /** Whether a timer is waiting (a frame, the end of a passing row, or the moment it falls asleep). */
    get armed() {
      return timer !== undefined
    },
    /** Re-evaluates the timer after visibility, focus or motion changed. */
    sync() {
      if (!input.animate()) index = 0
      arm()
    },
    cancelCheer() {
      passing = undefined
      wake()
      arm()
    },
    stop() {
      stopped = true
      if (timer !== undefined) clearTimer(timer)
      timer = undefined
    },
  }
}
