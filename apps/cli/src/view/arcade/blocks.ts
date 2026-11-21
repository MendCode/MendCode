import type { ColorName, Line, Span } from "../../ui/theme"
import { seeded, type ArcadeDefinition, type ArcadeKey } from "./types"

type Cell = { x: number; y: number }
type Piece = { shape: number; cells: Cell[]; x: number; y: number }

const WELL = 10
/** The seven four-cell shapes, each as cells in a 4 by 4 box. */
const SHAPES: readonly Cell[][] = [
  [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }],
  [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
  [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
  [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
  [{ x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
  [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
]
const TONES: readonly ColorName[] = ["info", "warning", "accent", "primary", "secondary", "success", "error"]
/** Points for one, two, three and four lines cleared at once. */
const LINE_POINTS = [0, 100, 300, 500, 800]

/** The cells turned a quarter clockwise inside their box. */
export function rotateCells(cells: readonly Cell[]): Cell[] {
  const size = Math.max(...cells.flatMap((cell) => [cell.x, cell.y])) + 1
  return cells.map((cell) => ({ x: size - 1 - cell.y, y: cell.x }))
}

/** Rows of `well` that are full, removed, with empty rows added on top; returns the well and how many rows went. */
export function clearRows(well: ReadonlyArray<ReadonlyArray<number>>): { well: number[][]; cleared: number } {
  const kept = well.filter((row) => row.some((cell) => cell === 0)).map((row) => [...row])
  const cleared = well.length - kept.length
  const width = well[0]?.length ?? 0
  return { well: [...Array.from({ length: cleared }, () => Array.from({ length: width }, () => 0)), ...kept], cleared }
}

/**
 * Blocks: falling four-cell pieces fill a well ten cells wide. Left and right move, up turns, down drops one row,
 * space drops the piece to the floor, `r` restarts. Full rows clear; the pace rises every five rows.
 */
export const blocks: ArcadeDefinition = {
  id: "blocks",
  label: "Blocks",
  ticks: true,
  min: { cols: WELL, rows: 10 },
  start({ cols, rows, random, best }) {
    const next = seeded(Math.floor(random() * 0xffffffff))
    let well: number[][] = []
    let piece: Piece = { shape: 0, cells: [], x: 0, y: 0 }
    let upcoming = 0
    let score = 0
    let lines = 0
    let frames = 0
    let over = false
    let record = best

    const level = () => 1 + Math.floor(lines / 5)
    const fall = () => Math.max(1, 7 - level())
    const hits = (cells: readonly Cell[], x: number, y: number) =>
      cells.some((cell) => {
        const cx = x + cell.x
        const cy = y + cell.y
        return cx < 0 || cx >= WELL || cy >= rows || (cy >= 0 && well[cy]![cx] !== 0)
      })
    function spawn() {
      const shape = upcoming
      upcoming = Math.floor(next() * SHAPES.length)
      piece = { shape, cells: SHAPES[shape]!.map((cell) => ({ ...cell })), x: Math.floor((WELL - 4) / 2), y: -1 }
      if (hits(piece.cells, piece.x, piece.y + 1)) over = true
      else piece.y++
    }
    function reset() {
      well = Array.from({ length: rows }, () => Array.from({ length: WELL }, () => 0))
      score = 0
      lines = 0
      frames = 0
      over = false
      upcoming = Math.floor(next() * SHAPES.length)
      spawn()
    }
    function lock() {
      for (const cell of piece.cells) {
        const y = piece.y + cell.y
        if (y < 0) {
          over = true
          return
        }
        well[y]![piece.x + cell.x] = piece.shape + 1
      }
      const result = clearRows(well)
      well = result.well
      lines += result.cleared
      score += LINE_POINTS[result.cleared]! * level() + 1
      record = Math.max(record, score)
      spawn()
    }
    /** One row down; locks the piece where it lands. */
    function drop() {
      if (hits(piece.cells, piece.x, piece.y + 1)) lock()
      else piece.y++
    }
    reset()

    const ghostY = () => {
      let y = piece.y
      while (!hits(piece.cells, piece.x, y + 1)) y++
      return y
    }

    return {
      get score() {
        return score
      },
      get best() {
        return record
      },
      get moving() {
        return !over
      },
      tick() {
        if (over) return
        frames++
        if (frames % fall() === 0) drop()
      },
      key(key: ArcadeKey) {
        if (key === "restart") return reset()
        if (over) return
        if (key === "left" || key === "right") {
          const x = piece.x + (key === "left" ? -1 : 1)
          if (!hits(piece.cells, x, piece.y)) piece.x = x
        } else if (key === "up" && piece.shape !== 1) {
          const turned = rotateCells(piece.cells)
          // A turn against a wall or a stack nudges the piece sideways when that makes room.
          const shift = [0, -1, 1, -2, 2].find((dx) => !hits(turned, piece.x + dx, piece.y))
          if (shift !== undefined) piece = { ...piece, cells: turned, x: piece.x + shift }
        } else if (key === "down") {
          drop()
          frames = 0
        } else if (key === "space") {
          piece.y = ghostY()
          lock()
          frames = 0
        }
      },
      view({ focused }) {
        const shadow = over ? undefined : ghostY()
        const active = new Set(over ? [] : piece.cells.map((cell) => (piece.y + cell.y) * WELL + piece.x + cell.x))
        const ghost = new Set(shadow === undefined ? [] : piece.cells.map((cell) => (shadow + cell.y) * WELL + piece.x + cell.x))
        const preview = SHAPES[upcoming]!
        const side = cols - WELL
        const out: Line[] = []
        for (let y = 0; y < rows; y++) {
          const spans: Span[] = []
          for (let x = 0; x < WELL; x++) {
            const index = y * WELL + x
            const settled = well[y]![x]!
            if (active.has(index)) spans.push({ text: "██", fg: TONES[piece.shape]!, bg: "element" })
            else if (settled) spans.push({ text: "██", fg: over ? "muted" : TONES[settled - 1]!, bg: "element", dim: !focused })
            else if (ghost.has(index)) spans.push({ text: "░░", fg: "border", bg: "element" })
            else spans.push({ text: "  ", bg: "element" })
          }
          // Beside the well, when there is room: the next piece.
          if (side >= 5) {
            spans.push({ text: "  " })
            if (y === 0) spans.push({ text: "next".padEnd(8), fg: "muted" })
            else if (y >= 1 && y <= 2) for (let x = 0; x < 4; x++) spans.push(preview.some((cell) => cell.x === x && cell.y === y - 1) ? { text: "██", fg: TONES[upcoming]! } : { text: "  " })
            else if (y === 4) spans.push({ text: `rows ${lines}`.padEnd(8), fg: "muted" })
            else if (y === 5) spans.push({ text: `pace ${level()}`.padEnd(8), fg: "muted" })
            else spans.push({ text: " ".repeat(8) })
            spans.push({ text: " ".repeat(Math.max(0, side * 2 - 10)) })
          } else if (side > 0) spans.push({ text: " ".repeat(side * 2) })
          out.push(spans)
        }
        return {
          title: `Blocks · ${score} · best ${record}`,
          status: over ? "Stacked out. r restarts" : `Pace ${level()} · ${lines} rows`,
          rows: out,
          width: cols * 2,
          controls: "↑ turn · space drop",
        }
      },
    }
  },
}
