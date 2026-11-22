import { pixelRows, type Pixel } from "./pixels"
import { seeded, type ArcadeDefinition, type ArcadeKey } from "./types"

type Direction = "up" | "down" | "left" | "right"
type Rider = { x: number; y: number; direction: Direction; alive: boolean }

const STEP: Record<Direction, { x: number; y: number }> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }
const OPPOSITE: Record<Direction, Direction> = { up: "down", down: "up", left: "right", right: "left" }
const TURNS: Record<Direction, Direction[]> = { up: ["left", "right"], down: ["right", "left"], left: ["down", "up"], right: ["up", "down"] }
/** Trail owners in the grid. */
const EMPTY = 0
const YOURS = 1
const THEIRS = 2
/** Tiles the computer counts ahead before choosing a way; enough to see a closing pocket, small enough for one frame. */
const LOOKAHEAD = 160

const STEPS = Object.values(STEP)
/** The search's buffers, kept between calls: a mark per tile (the search that last saw it) and the queue. */
let marks = new Uint32Array(0)
let queue = new Int32Array(0)
let search = 0

/** Free tiles reachable from (x, y), counted up to `limit`. */
export function reach(grid: readonly number[], width: number, height: number, x: number, y: number, limit: number): number {
  if (x < 0 || y < 0 || x >= width || y >= height || grid[y * width + x] !== EMPTY) return 0
  const tiles = width * height
  if (marks.length < tiles) {
    marks = new Uint32Array(tiles)
    queue = new Int32Array(tiles)
    search = 0
  }
  if (++search === 0xffffffff) {
    marks.fill(0)
    search = 1
  }
  let head = 0
  let size = 1
  queue[0] = y * width + x
  marks[y * width + x] = search
  while (head < size && size < limit) {
    const at = queue[head++]!
    const ax = at % width
    const ay = (at - ax) / width
    for (const step of STEPS) {
      const nx = ax + step.x
      const ny = ay + step.y
      const index = ny * width + nx
      if (nx >= 0 && ny >= 0 && nx < width && ny < height && grid[index] === EMPTY && marks[index] !== search) {
        marks[index] = search
        queue[size++] = index
      }
    }
  }
  return size
}

/**
 * Light cycles against the computer: both riders leave a wall behind them; arrows turn yours, space starts the
 * round, `r` restarts. Crashing into a wall or a trail ends the run; the score is the rounds won in a row.
 */
export const cycles: ArcadeDefinition = {
  id: "cycles",
  label: "Cycles",
  ticks: true,
  min: { cols: 10, rows: 6 },
  start({ cols, rows, random, best }) {
    const width = cols * 2
    const height = rows * 2
    const next = seeded(Math.floor(random() * 0xffffffff))
    let grid: number[] = []
    let you: Rider = { x: 0, y: 0, direction: "right", alive: true }
    let cpu: Rider = { x: 0, y: 0, direction: "left", alive: true }
    let queued: Direction[] = []
    let waiting = true
    let lost = false
    let score = 0
    let record = best

    const free = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && grid[y * width + x] === EMPTY
    function round() {
      grid = Array.from({ length: width * height }, () => EMPTY)
      const y = Math.floor(height / 2)
      you = { x: 2, y, direction: "right", alive: true }
      cpu = { x: width - 3, y: y - 1, direction: "left", alive: true }
      grid[you.y * width + you.x] = YOURS
      grid[cpu.y * width + cpu.x] = THEIRS
      queued = []
      waiting = true
    }
    function reset() {
      score = 0
      lost = false
      round()
    }
    reset()

    /** The way with the most room ahead; it keeps going straight while that is as good, and wanders now and then. */
    function steer() {
      const options = [cpu.direction, ...TURNS[cpu.direction]]
      const room = options.map((direction) => reach(grid, width, height, cpu.x + STEP[direction].x, cpu.y + STEP[direction].y, LOOKAHEAD))
      const most = Math.max(...room)
      if (most === 0) return
      const wander = next() < 0.06
      const pick = options.findIndex((_, index) => room[index] === most && (index > 0 || !wander || room.filter((value) => value === most).length === 1))
      cpu.direction = options[pick] ?? cpu.direction
    }
    function move(rider: Rider) {
      const step = STEP[rider.direction]
      rider.x += step.x
      rider.y += step.y
      if (!free(rider.x, rider.y)) rider.alive = false
    }

    const over = () => !you.alive || !cpu.alive
    return {
      get score() {
        return score
      },
      get best() {
        return record
      },
      get moving() {
        return !waiting && !over()
      },
      tick() {
        if (waiting || over()) return
        const turn = queued.shift()
        if (turn) you.direction = turn
        steer()
        move(you)
        move(cpu)
        if (you.x === cpu.x && you.y === cpu.y) you.alive = cpu.alive = false
        if (you.alive) grid[you.y * width + you.x] = YOURS
        if (cpu.alive) grid[cpu.y * width + cpu.x] = THEIRS
        if (!over() || (!you.alive && !cpu.alive)) return
        if (you.alive) {
          score++
          record = Math.max(record, score)
        } else lost = true
      },
      key(key: ArcadeKey) {
        if (key === "restart") return reset()
        if (key === "space") {
          if (lost) reset()
          else if (over()) round()
          else if (waiting) waiting = false
          return
        }
        if (key === "up" || key === "down" || key === "left" || key === "right") {
          if (over()) return
          const last = queued.at(-1) ?? you.direction
          if (key !== last && key !== OPPOSITE[last] && queued.length < 2) queued.push(key)
          waiting = false
        }
      },
      view({ focused }) {
        const at = (x: number, y: number): Pixel => {
          if (x === you.x && y === you.y) return you.alive ? "text" : "error"
          if (x === cpu.x && y === cpu.y) return cpu.alive ? "text" : "error"
          const owner = grid[y * width + x]
          return owner === YOURS ? "primary" : owner === THEIRS ? "warning" : undefined
        }
        const status = lost
          ? "You crashed. space restarts"
          : over()
            ? you.alive ? "Round won. space rides again" : "Both crashed. space rides again"
            : waiting ? "Arrow keys or space ride" : "Outlast the gold rider"
        return {
          title: `Cycles · ${score} · best ${record}`,
          status,
          rows: pixelRows({ width, height, at, dim: !focused }),
          width,
          controls: "space ride",
        }
      },
    }
  },
}
