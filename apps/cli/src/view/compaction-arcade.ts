import { breakout } from "./arcade/breakout"
import { game2048 } from "./arcade/game2048"
import { snake } from "./arcade/snake"
import type { ArcadeDefinition, ArcadeInstance, ArcadeKey } from "./arcade/types"

/** The games the arcade panel picks from, one at random each compaction. */
export const ARCADE_GAMES: readonly ArcadeDefinition[] = [snake, breakout, game2048]

/** What the app does with a key while the arcade has focus. */
export type ArcadeInput = { type: "game"; key: ArcadeKey } | { type: "leave" } | { type: "next" }

/** A game in play: its instance, the field it was started on and the last render-loop frame it has seen. */
export type ArcadeSession = { definition: ArcadeDefinition; instance: ArcadeInstance; frame: number }

/** At most this many frames are replayed after a stall, so a stalled terminal never fast-forwards the game. */
const MAX_CATCH_UP = 3

const KEYS: Record<string, ArcadeInput> = {
  "\x1b[A": { type: "game", key: "up" }, "\x1bOA": { type: "game", key: "up" }, w: { type: "game", key: "up" }, k: { type: "game", key: "up" },
  "\x1b[B": { type: "game", key: "down" }, "\x1bOB": { type: "game", key: "down" }, s: { type: "game", key: "down" }, j: { type: "game", key: "down" },
  "\x1b[D": { type: "game", key: "left" }, "\x1bOD": { type: "game", key: "left" }, a: { type: "game", key: "left" }, h: { type: "game", key: "left" },
  "\x1b[C": { type: "game", key: "right" }, "\x1bOC": { type: "game", key: "right" }, d: { type: "game", key: "right" }, l: { type: "game", key: "right" },
  " ": { type: "game", key: "space" }, r: { type: "game", key: "restart" },
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

export function startArcade(input: { definition: ArcadeDefinition; cols: number; rows: number; random: () => number; best: number; frame: number }): ArcadeSession {
  const { definition, frame, ...field } = input
  return { definition, frame, instance: definition.start(field) }
}

/** Plays the frames the render loop has gone through since the last call, only for games that move by themselves. */
export function advanceArcade(session: ArcadeSession, frame: number) {
  const frames = Math.min(MAX_CATCH_UP, Math.max(0, frame - session.frame))
  session.frame = frame
  if (session.definition.ticks) for (let i = 0; i < frames; i++) session.instance.tick()
}
