import type { Line } from "../../ui/theme"

/** The keys a game understands; the app maps arrows, WASD, vi keys and space onto them. */
export type ArcadeKey = "up" | "down" | "left" | "right" | "space" | "restart"

export type ArcadeView = {
  title: string
  status: string
  /** The playing field, one `Line` per row, every line `width` cells wide. */
  rows: Line[]
  width: number
}

/** A running game. State is private to the instance; the app only ticks, feeds keys and draws. */
export type ArcadeInstance = {
  /** One frame (about 125 ms) of the render loop; a no-op for games that only move on keys. */
  tick(): void
  key(key: ArcadeKey): void
  view(options: { focused: boolean }): ArcadeView
  readonly score: number
  /** The best score of this instance, the one it was started with included. */
  readonly best: number
}

export type ArcadeStart = {
  /** Playing field in cells; each cell is two terminal columns wide. */
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
