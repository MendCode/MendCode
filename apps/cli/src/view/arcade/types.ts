import type { Line } from "../../ui/theme"

/** The keys a game understands; the app maps arrows, WASD, vi keys, space, `f` and `r` onto them. */
export type ArcadeKey = "up" | "down" | "left" | "right" | "space" | "alt" | "restart"

export type ArcadeView = {
  title: string
  status: string
  /** The playing field, one `Line` per row, every line `width` cells wide. */
  rows: Line[]
  width: number
  /** The game's own keys beyond moving, for the help beside the field; "space start · pause" when absent. */
  controls?: string
}

/** A running game. State is private to the instance; the app only ticks, feeds keys and draws. */
export type ArcadeInstance = {
  /** One step of the game (125 ms of play); a no-op for games that only move on keys. */
  tick(): void
  /**
   * Whether a step would change anything now: false before the first move, while paused and once the game is over.
   * The app keeps no frame clock for a game that is standing still.
   */
  readonly moving: boolean
  key(key: ArcadeKey): void
  /** Lets a lockout that waits on frames run down one step; the app calls it on a press that does not step the game (reduced motion draws no frames). */
  settle?(): void
  view(options: { focused: boolean }): ArcadeView
  readonly score: number
  /** The best score of this instance, the one it was started with included. */
  readonly best: number
}

export type ArcadeStart = {
  /** Playing field in cells; each cell is two terminal columns wide (two half-block pixels wide and two tall). */
  cols: number
  rows: number
  random: () => number
  best: number
}

export type ArcadeDefinition = {
  id: string
  label: string
  /** Whether the game advances on frames by itself; otherwise only keys move it. */
  ticks: boolean
  /** Smallest field the game can be played on. */
  min: { cols: number; rows: number }
  start(input: ArcadeStart): ArcadeInstance
}

/** mulberry32: a small deterministic generator so a game replays the same from one seed. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
