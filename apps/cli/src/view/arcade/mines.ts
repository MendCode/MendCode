import type { ColorName, Span } from "../../ui/theme"
import { seeded, type ArcadeDefinition, type ArcadeKey } from "./types"

type Tile = { mine: boolean; open: boolean; flag: boolean; near: number }

const MAX_COLS = 16
const MAX_ROWS = 10
/** A mine for about every seven tiles. */
const DENSITY = 0.15
const NUMBER_TONES: readonly ColorName[] = ["info", "success", "warning", "error", "accent", "accent", "accent", "accent"]

/** The tiles around (x, y) inside a `cols` by `rows` field. */
export function neighbours(x: number, y: number, cols: number, rows: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = []
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx
    const ny = y + dy
    if ((dx || dy) && nx >= 0 && ny >= 0 && nx < cols && ny < rows) out.push({ x: nx, y: ny })
  }
  return out
}

/**
 * Mines: arrows move the cursor, space opens a tile, `f` flags one, `r` restarts. The first tile opened is never a
 * mine; an empty tile opens its neighbours. Opening every safe tile wins. Moves only on keys.
 */
export const mines: ArcadeDefinition = {
  id: "mines",
  label: "Mines",
  ticks: false,
  min: { cols: 8, rows: 6 },
  start({ cols: fieldCols, rows: fieldRows, random, best }) {
    const cols = Math.min(MAX_COLS, fieldCols)
    const rows = Math.min(MAX_ROWS, fieldRows)
    const count = Math.max(4, Math.round(cols * rows * DENSITY))
    const next = seeded(Math.floor(random() * 0xffffffff))
    let tiles: Tile[][] = []
    let cursor = { x: 0, y: 0 }
    let laid = false
    let state: "playing" | "lost" | "won" = "playing"
    let score = 0
    let record = best

    const tile = (x: number, y: number) => tiles[y]![x]!
    function reset() {
      tiles = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ mine: false, open: false, flag: false, near: 0 })))
      cursor = { x: Math.floor(cols / 2), y: Math.floor(rows / 2) }
      laid = false
      state = "playing"
      score = 0
    }
    /** Lays the mines once the first tile is chosen, never on it or around it. */
    function lay(safe: { x: number; y: number }) {
      const spared = new Set([safe, ...neighbours(safe.x, safe.y, cols, rows)].map((point) => point.y * cols + point.x))
      const spots: number[] = []
      for (let i = 0; i < cols * rows; i++) if (!spared.has(i)) spots.push(i)
      for (let placed = 0; placed < count && spots.length; placed++) {
        const [spot] = spots.splice(Math.floor(next() * spots.length), 1)
        tile(spot! % cols, Math.floor(spot! / cols)).mine = true
      }
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) tile(x, y).near = neighbours(x, y, cols, rows).filter((point) => tile(point.x, point.y).mine).length
      laid = true
    }
    function open(x: number, y: number) {
      const stack = [{ x, y }]
      while (stack.length) {
        const point = stack.pop()!
        const here = tile(point.x, point.y)
        if (here.open || here.flag) continue
        here.open = true
        if (here.mine) {
          state = "lost"
          return
        }
        score++
        if (here.near === 0) stack.push(...neighbours(point.x, point.y, cols, rows))
      }
      record = Math.max(record, score)
      if (score === cols * rows - count) state = "won"
    }
    reset()

    const flags = () => tiles.flat().filter((each) => each.flag).length
    function tileSpan(x: number, y: number): Span {
      const here = tile(x, y)
      const shown = here.open || (state !== "playing" && here.mine)
      if (!shown) return here.flag ? { text: " ▲", fg: "error", bg: "element", bold: true } : { text: " ·", fg: "border", bg: "element" }
      if (here.mine) return { text: " ●", fg: state === "won" ? "success" : "error", bold: true }
      if (here.near === 0) return { text: "  " }
      return { text: ` ${here.near}`, fg: NUMBER_TONES[here.near - 1]!, bold: true }
    }

    return {
      get score() {
        return score
      },
      get best() {
        return record
      },
      moving: false,
      tick() {},
      key(key: ArcadeKey) {
        if (key === "restart") return reset()
        if (key === "up" || key === "down") cursor.y = (cursor.y + (key === "up" ? rows - 1 : 1)) % rows
        else if (key === "left" || key === "right") cursor.x = (cursor.x + (key === "left" ? cols - 1 : 1)) % cols
        else if (state !== "playing") return
        else if (key === "alt") {
          const here = tile(cursor.x, cursor.y)
          if (!here.open) here.flag = !here.flag
        } else if (key === "space") {
          if (!laid) lay(cursor)
          open(cursor.x, cursor.y)
        }
      },
      view({ focused }) {
        const rowsOut = tiles.map((row, y) =>
          row.map((_, x): Span => {
            const span = tileSpan(x, y)
            if (focused && cursor.x === x && cursor.y === y) return { ...span, text: span.text === "  " ? " ◇" : span.text, fg: "background", bg: "primary" }
            return focused ? span : { ...span, dim: true }
          }),
        )
        const left = count - flags()
        return {
          title: `Mines · ${score} · best ${record}`,
          status: state === "won" ? "Field cleared. r restarts" : state === "lost" ? "Boom. r restarts" : `${left} mines left`,
          rows: rowsOut,
          width: cols * 2,
          controls: "space open · f flag",
        }
      },
    }
  },
}
