import type { Line, Span } from "../../ui/theme"
import { seeded, type ArcadeDefinition, type ArcadeKey } from "./types"

type Point = { x: number; y: number }
type Direction = "up" | "down" | "left" | "right"

const STEP: Record<Direction, Point> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }
const OPPOSITE: Record<Direction, Direction> = { up: "down", down: "up", left: "right", right: "left" }

/** Snake: arrows steer, space pauses, `r` restarts. Walls and the snake's own body end the run. */
export const snake: ArcadeDefinition = {
  id: "snake",
  label: "Snake",
  ticks: true,
  min: { cols: 10, rows: 6 },
  start({ cols, rows, random, best }) {
    const next = seeded(Math.floor(random() * 0xffffffff))
    let body: Point[] = []
    let direction: Direction = "right"
    let queued: Direction[] = []
    let food: Point = { x: 0, y: 0 }
    let alive = true
    let paused = false
    let score = 0
    let record = best

    const free = (point: Point) => !body.some((part) => part.x === point.x && part.y === point.y)
    function place() {
      const open: Point[] = []
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (free({ x, y })) open.push({ x, y })
      food = open[Math.floor(next() * open.length)] ?? { x: 0, y: 0 }
    }
    function reset() {
      const y = Math.floor(rows / 2)
      body = [{ x: 3, y }, { x: 2, y }, { x: 1, y }]
      direction = "right"
      queued = []
      alive = true
      paused = true
      score = 0
      place()
    }
    reset()

    return {
      get score() {
        return score
      },
      get best() {
        return record
      },
      tick() {
        if (!alive || paused) return
        const turn = queued.shift()
        if (turn) direction = turn
        const head = body[0]!
        const step = STEP[direction]
        const target = { x: head.x + step.x, y: head.y + step.y }
        const eats = target.x === food.x && target.y === food.y
        const tail = eats ? body : body.slice(0, -1)
        if (target.x < 0 || target.y < 0 || target.x >= cols || target.y >= rows || tail.some((part) => part.x === target.x && part.y === target.y)) {
          alive = false
          return
        }
        body = [target, ...tail]
        if (eats) {
          score++
          record = Math.max(record, score)
          if (body.length >= cols * rows) alive = false
          else place()
        }
      },
      key(key: ArcadeKey) {
        if (key === "restart") return reset()
        if (key === "space") {
          if (alive) paused = !paused
          return
        }
        if (key === "up" || key === "down" || key === "left" || key === "right") {
          const last = queued.at(-1) ?? direction
          if (key !== last && key !== OPPOSITE[last] && queued.length < 2) queued.push(key)
          if (paused && alive) paused = false
        }
      },
      view({ focused }) {
        const head = body[0]!
        const lines: Line[] = []
        for (let y = 0; y < rows; y++) {
          const spans: Span[] = []
          for (let x = 0; x < cols; x++) {
            if (head.x === x && head.y === y) spans.push({ text: "██", fg: alive ? "primary" : "error" })
            else if (!free({ x, y })) spans.push({ text: "▓▓", fg: alive ? "success" : "error", dim: !focused })
            else if (food.x === x && food.y === y) spans.push({ text: "◆ ", fg: "warning", bold: true })
            else spans.push({ text: "· ", fg: "muted", dim: true })
          }
          lines.push(spans)
        }
        return {
          title: `Snake · ${score} · best ${record}`,
          status: !alive ? (body.length >= cols * rows ? "Board full. r restarts" : "Game over. r restarts") : paused ? (score === 0 ? "Arrow keys start" : "Paused") : "Eat ◆, avoid walls and yourself",
          rows: lines,
          width: cols * 2,
        }
      },
    }
  },
}
