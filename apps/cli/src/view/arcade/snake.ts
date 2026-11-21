import { pixelRows, type Pixel } from "./pixels"
import { seeded, type ArcadeDefinition, type ArcadeKey } from "./types"

type Point = { x: number; y: number }
type Direction = "up" | "down" | "left" | "right"

const STEP: Record<Direction, Point> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }
const OPPOSITE: Record<Direction, Direction> = { up: "down", down: "up", left: "right", right: "left" }
/** What a pixel shows, as an index into the tones below. */
const BODY = 1
const HEAD = 2
const FOOD = 3
const LIVE_TONES: readonly Pixel[] = [undefined, "success", "primary", "warning"]
const DEAD_TONES: readonly Pixel[] = [undefined, "error", "error", "warning"]

/**
 * Snake: arrows steer, space pauses, `r` restarts. Walls and the snake's own body end the run. Every snake and food
 * cell is one square half-block pixel: two per field cell across and two down.
 */
export const snake: ArcadeDefinition = {
  id: "snake",
  label: "Snake",
  ticks: true,
  min: { cols: 10, rows: 6 },
  start({ cols, rows, random, best }) {
    const width = cols * 2
    const height = rows * 2
    const next = seeded(Math.floor(random() * 0xffffffff))
    /** The drawing buffer, one entry per pixel, reused by every view. */
    const paint = new Uint8Array(width * height)
    let body: Point[] = []
    let direction: Direction = "right"
    let queued: Direction[] = []
    let food: Point = { x: 0, y: 0 }
    let alive = true
    let paused = false
    /** Whether the snake has moved since the start: a pause after that says so. */
    let moved = false
    let score = 0
    let record = best

    /** Food on a random free pixel: the body is marked in the drawing buffer, then the free pixels are counted. */
    function place() {
      paint.fill(0)
      for (const part of body) paint[part.y * width + part.x] = BODY
      const open = paint.length - body.length
      let pick = Math.floor(next() * open)
      for (let index = 0; index < paint.length; index++) {
        if (paint[index] !== 0) continue
        if (pick-- === 0) {
          food = { x: index % width, y: Math.floor(index / width) }
          return
        }
      }
      food = { x: 0, y: 0 }
    }
    function reset() {
      const y = Math.floor(height / 2)
      body = [{ x: 3, y }, { x: 2, y }, { x: 1, y }]
      direction = "right"
      queued = []
      alive = true
      paused = true
      moved = false
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
      get moving() {
        return alive && !paused
      },
      tick() {
        if (!alive || paused) return
        moved = true
        const turn = queued.shift()
        if (turn) direction = turn
        const head = body[0]!
        const step = STEP[direction]
        const target = { x: head.x + step.x, y: head.y + step.y }
        const eats = target.x === food.x && target.y === food.y
        // The tail's last cell moves away this step unless the snake grows, so the head may take it.
        const kept = eats ? body.length : body.length - 1
        let bites = false
        for (let i = 0; i < kept && !bites; i++) bites = body[i]!.x === target.x && body[i]!.y === target.y
        if (target.x < 0 || target.y < 0 || target.x >= width || target.y >= height || bites) {
          alive = false
          return
        }
        if (!eats) body.pop()
        body.unshift(target)
        if (eats) {
          score++
          record = Math.max(record, score)
          if (body.length >= width * height) alive = false
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
        paint.fill(0)
        for (const part of body) paint[part.y * width + part.x] = BODY
        paint[head.y * width + head.x] = HEAD
        paint[food.y * width + food.x] = FOOD
        const tones: readonly Pixel[] = alive ? LIVE_TONES : DEAD_TONES
        return {
          title: `Snake · ${score} · best ${record}`,
          status: !alive ? (body.length >= width * height ? "Board full. r restarts" : "Game over. r restarts") : paused ? (moved ? "Paused" : "Arrow keys start") : "Eat the gold, miss the walls",
          rows: pixelRows({ width, height, at: (x, y) => tones[paint[y * width + x]!], dim: !focused }),
          width,
        }
      },
    }
  },
}
