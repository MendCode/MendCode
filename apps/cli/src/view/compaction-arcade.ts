import { blocks } from "./arcade/blocks"
import { breakout } from "./arcade/breakout"
import { crossing } from "./arcade/crossing"
import { cycles } from "./arcade/cycles"
import { game2048 } from "./arcade/game2048"
import { glide } from "./arcade/glide"
import { mines } from "./arcade/mines"
import { pong } from "./arcade/pong"
import { snake } from "./arcade/snake"
import { stars } from "./arcade/stars"
import type { ArcadeDefinition, ArcadeInstance, ArcadeKey, ArcadeView } from "./arcade/types"

/** The games the arcade panel picks from, one at random each compaction. This module and the games load only with the arcade. */
export const ARCADE_GAMES: readonly ArcadeDefinition[] = [snake, breakout, game2048, blocks, mines, pong, cycles, glide, stars, crossing]

/** What the app does with a key while the arcade has focus. */
export type ArcadeInput = { type: "game"; key: ArcadeKey } | { type: "leave" } | { type: "next" }

/**
 * A game in play: its instance, the play time it has been stepped up to (`clock`, ms) and whether it was running at
 * the last advance, and its last drawn view, kept until a step or a key changes the game.
 */
export type ArcadeSession = {
  definition: ArcadeDefinition
  instance: ArcadeInstance
  clock: number
  running: boolean
  drawn: { view: ArcadeView; focused: boolean } | undefined
}

/** Play time of one game step: the same pace on any frame rate, a late frame plays the steps it owes. */
export const ARCADE_STEP_MS = 125
/** At most this many steps are replayed after a stall, so a stalled terminal never fast-forwards the game. */
const MAX_CATCH_UP = 3

const KEYS: Record<string, ArcadeInput> = {
  "\x1b[A": { type: "game", key: "up" }, "\x1bOA": { type: "game", key: "up" }, w: { type: "game", key: "up" }, k: { type: "game", key: "up" },
  "\x1b[B": { type: "game", key: "down" }, "\x1bOB": { type: "game", key: "down" }, s: { type: "game", key: "down" }, j: { type: "game", key: "down" },
  "\x1b[D": { type: "game", key: "left" }, "\x1bOD": { type: "game", key: "left" }, a: { type: "game", key: "left" }, h: { type: "game", key: "left" },
  "\x1b[C": { type: "game", key: "right" }, "\x1bOC": { type: "game", key: "right" }, d: { type: "game", key: "right" }, l: { type: "game", key: "right" },
  " ": { type: "game", key: "space" }, r: { type: "game", key: "restart" }, f: { type: "game", key: "alt" },
  n: { type: "next" },
  "\x1b": { type: "leave" }, q: { type: "leave" }, "\x03": { type: "leave" }, "\t": { type: "leave" },
}

/** The arcade meaning of a raw key; undefined for keys the games ignore. */
export function arcadeInput(raw: string): ArcadeInput | undefined {
  return KEYS[raw.length === 1 ? raw.toLowerCase() : raw]
}

/** A game other than `avoid`, chosen with `random` (0 up to but not including 1). */
export function pickGame(random: () => number, avoid?: string): ArcadeDefinition {
  const pool = ARCADE_GAMES.filter((game) => game.id !== avoid)
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!
}

/** Cells wide the info column beside the field takes (see `compaction-live`), with the box padding. */
const INFO_COLUMNS = 38
const MAX_FIELD_COLS = 20
const MAX_FIELD_ROWS = 12

/** The field a game gets in `width` columns and `maxRows` rows (borders included); undefined when it cannot be played there. */
export function arcadeField(definition: ArcadeDefinition, width: number, maxRows: number): { cols: number; rows: number } | undefined {
  const beside = width >= 70 ? Math.floor((width - INFO_COLUMNS) / 2) : 0
  const cols = Math.min(MAX_FIELD_COLS, beside >= definition.min.cols ? beside : Math.floor(width / 2))
  const rows = Math.min(MAX_FIELD_ROWS, maxRows - 2)
  return cols >= definition.min.cols && rows >= definition.min.rows ? { cols, rows } : undefined
}

export function startArcade(input: { definition: ArcadeDefinition; cols: number; rows: number; random: () => number; best: number; now: number }): ArcadeSession {
  const { definition, now, ...field } = input
  return { definition, clock: now, running: false, drawn: undefined, instance: definition.start(field) }
}

/**
 * Plays the steps owed for the time since the last call (a fixed step of play time), only while the game is played
 * (`playing`) and moves by itself. A frame that comes a little early or late still plays one step, so the timer's
 * jitter never doubles or drops one; time spent paused, unfocused or standing still is never played back.
 */
export function advanceArcade(session: ArcadeSession, now: number, playing = true) {
  const moving = playing && session.definition.ticks && session.instance.moving
  if (!moving || !session.running) {
    session.running = moving
    session.clock = now
    return
  }
  const owed = Math.floor((now - session.clock + ARCADE_STEP_MS / 2) / ARCADE_STEP_MS)
  if (owed <= 0) return
  const steps = Math.min(MAX_CATCH_UP, owed)
  session.clock = steps < owed ? now : session.clock + steps * ARCADE_STEP_MS
  for (let i = 0; i < steps; i++) session.instance.tick()
  session.drawn = undefined
}

/** A key for the game: the next frame draws it afresh. */
export function pressArcade(session: ArcadeSession, key: ArcadeKey) {
  session.instance.key(key)
  session.drawn = undefined
}

/** One step played by hand (reduced motion: each move key is a step). */
export function stepArcade(session: ArcadeSession) {
  session.instance.tick()
  session.drawn = undefined
}

/** The game's view, drawn again only after a step or a key changed it or its focus changed. */
export function viewArcade(session: ArcadeSession, focused: boolean): ArcadeView {
  if (session.drawn?.focused === focused) return session.drawn.view
  const view = session.instance.view({ focused })
  session.drawn = { view, focused }
  return view
}
