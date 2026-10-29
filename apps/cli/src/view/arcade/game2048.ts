import type { ColorName, Line, Span } from "../../ui/theme"
import { seeded, type ArcadeDefinition, type ArcadeKey } from "./types"

const SIZE = 4
const TILE = 6
const TONES: ReadonlyArray<ColorName> = ["info", "info", "success", "success", "warning", "warning", "accent", "accent", "primary", "primary"]

/** Slides one row toward index 0, merging equal neighbours once; returns the new row and the points gained. */
export function slideRow(row: readonly number[]): { row: number[]; gained: number } {
  const tiles = row.filter((value) => value > 0)
  const merged: number[] = []
  let gained = 0
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === tiles[i + 1]) {
      merged.push(tiles[i]! * 2)
      gained += tiles[i]! * 2
      i++
    } else merged.push(tiles[i]!)
  }
  while (merged.length < row.length) merged.push(0)
  return { row: merged, gained }
}

const tileSpan = (value: number): Span => {
  const text = value === 0 ? "  ·   " : String(value).padStart(Math.ceil((TILE + String(value).length) / 2)).padEnd(TILE)
  if (value === 0) return { text, fg: "muted", bg: "element" }
  if (value <= 4) return { text, fg: "text", bg: "element", bold: true }
  return { text, fg: "background", bg: TONES[Math.min(TONES.length - 1, Math.log2(value) - 3)]!, bold: true }
}

/** 2048: arrows slide the tiles, `r` restarts. Moves only on keys, so it never needs the render loop. */
export const game2048: ArcadeDefinition = {
  id: "2048",
  label: "2048",
  ticks: false,
  min: { cols: 14, rows: SIZE * 2 - 1 },
  start({ random, best }) {
    const next = seeded(Math.floor(random() * 0xffffffff))
    let grid: number[][] = []
    let score = 0
    let record = best

    const cells = () => grid.flatMap((row, y) => row.map((value, x) => ({ x, y, value })))
    function spawn() {
      const open = cells().filter((cell) => cell.value === 0)
      const cell = open[Math.floor(next() * open.length)]
      if (cell) grid[cell.y]![cell.x] = next() < 0.9 ? 2 : 4
    }
    function reset() {
      grid = Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => 0))
      score = 0
      spawn()
      spawn()
    }
    reset()

    const lines = (key: "left" | "right" | "up" | "down") => {
      const vertical = key === "up" || key === "down"
      const reverse = key === "right" || key === "down"
      return Array.from({ length: SIZE }, (_, i) => {
        const line = Array.from({ length: SIZE }, (_, j) => (vertical ? grid[j]![i]! : grid[i]![j]!))
        const slid = slideRow(reverse ? line.toReversed() : line)
        return { row: reverse ? slid.row.toReversed() : slid.row, gained: slid.gained, before: line }
      })
    }
    const place = (key: "left" | "right" | "up" | "down", moved: ReturnType<typeof lines>) => {
      const vertical = key === "up" || key === "down"
      moved.forEach(({ row }, i) => row.forEach((value, j) => { vertical ? (grid[j]![i] = value) : (grid[i]![j] = value) }))
    }
    const canMove = () => (["left", "right", "up", "down"] as const).some((key) => lines(key).some((line) => line.row.some((value, i) => value !== line.before[i])))
    const biggest = () => Math.max(...cells().map((cell) => cell.value))

    return {
      get score() {
        return score
      },
      get best() {
        return record
      },
      tick() {},
      key(key: ArcadeKey) {
        if (key === "restart") return reset()
        if (key === "space") return
        const moved = lines(key)
        if (!moved.some((line) => line.row.some((value, i) => value !== line.before[i]))) return
        place(key, moved)
        score += moved.reduce((sum, line) => sum + line.gained, 0)
        record = Math.max(record, score)
        spawn()
      },
      view({ focused }) {
        const airy = SIZE * 2 - 1
        const rows: Line[] = []
        grid.forEach((row, y) => {
          const spans: Span[] = []
          row.forEach((value, x) => {
            if (x > 0) spans.push({ text: " " })
            const tile = tileSpan(value)
            spans.push(focused || value === 0 ? tile : { ...tile, dim: true })
          })
          rows.push(spans)
          if (y < SIZE - 1) rows.push([{ text: " ".repeat(SIZE * TILE + SIZE - 1) }])
        })
        const dead = !canMove()
        return {
          title: `2048 · ${score} · best ${record}`,
          status: dead ? "No moves left. r restarts" : biggest() >= 2048 ? "2048! Keep going" : "Merge equal tiles",
          rows: rows.slice(0, airy),
          width: SIZE * TILE + SIZE - 1,
        }
      },
    }
  },
}
