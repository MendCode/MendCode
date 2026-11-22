import type { ColorName, Line, Span } from "../../ui/theme"
import { seeded, type ArcadeDefinition, type ArcadeKey } from "./types"

type Lane = { cars: boolean[]; heading: 1 | -1; every: number; tone: ColorName }

const LIVES = 3
const TONES: readonly ColorName[] = ["warning", "info", "accent", "error", "secondary"]

/** The lane after one move: every car shifts one cell toward `heading`, wrapping round the road. */
export function shiftLane(cars: readonly boolean[], heading: 1 | -1): boolean[] {
  return heading === 1 ? [cars.at(-1)!, ...cars.slice(0, -1)] : [...cars.slice(1), cars[0]!]
}

/**
 * Crossing: walk from the bottom kerb to the top one through lanes of traffic. Arrows move one cell, `r` restarts.
 * Each crossing scores and makes the traffic quicker; three knocks end the run.
 */
export const crossing: ArcadeDefinition = {
  id: "crossing",
  label: "Crossing",
  ticks: true,
  min: { cols: 10, rows: 7 },
  start({ cols, rows, random, best }) {
    const next = seeded(Math.floor(random() * 0xffffffff))
    const verge = rows >= 9 ? Math.floor(rows / 2) : -1
    let lanes: Array<Lane | undefined> = []
    let you = { x: 0, y: 0 }
    let frames = 0
    let lives = LIVES
    let level = 1
    let score = 0
    let started = false
    let record = best

    function road() {
      lanes = Array.from({ length: rows }, (_, y) => {
        if (y === 0 || y === rows - 1 || y === verge) return undefined
        const cars = Array.from({ length: cols }, () => false)
        // Cars of one to three cells with at least three free cells between them.
        for (let x = Math.floor(next() * 3); x < cols - 1; ) {
          const length = 1 + Math.floor(next() * 3)
          for (let i = 0; i < length && x + i < cols; i++) cars[x + i] = true
          x += length + 3 + Math.floor(next() * 4)
        }
        return { cars, heading: y % 2 ? 1 : -1, every: Math.max(1, 2 + Math.floor(next() * 3) - Math.floor((level - 1) / 2)), tone: TONES[y % TONES.length]! }
      })
    }
    const home = () => { you = { x: Math.floor(cols / 2), y: rows - 1 } }
    function reset() {
      frames = 0
      lives = LIVES
      level = 1
      score = 0
      started = false
      road()
      home()
    }
    reset()

    const over = () => lives <= 0
    const struck = () => lanes[you.y]?.cars[you.x] === true
    function knock() {
      lives--
      if (!over()) home()
    }

    return {
      get score() {
        return score
      },
      get best() {
        return record
      },
      get moving() {
        return started && !over()
      },
      tick() {
        if (!started || over()) return
        frames++
        for (const lane of lanes) if (lane && frames % lane.every === 0) lane.cars = shiftLane(lane.cars, lane.heading)
        if (struck()) knock()
      },
      key(key: ArcadeKey) {
        if (key === "restart") return reset()
        if (over()) return
        if (key !== "up" && key !== "down" && key !== "left" && key !== "right") return
        started = true
        if (key === "up") you.y = Math.max(0, you.y - 1)
        else if (key === "down") you.y = Math.min(rows - 1, you.y + 1)
        else you.x = Math.max(0, Math.min(cols - 1, you.x + (key === "left" ? -1 : 1)))
        if (struck()) return knock()
        if (you.y === 0) {
          score += level
          record = Math.max(record, score)
          level++
          road()
          home()
        }
      },
      view({ focused }) {
        const lines: Line[] = lanes.map((lane, y) => {
          const spans: Span[] = []
          for (let x = 0; x < cols; x++) {
            if (you.x === x && you.y === y) spans.push({ text: "▐▌", fg: over() ? "error" : "primary", ...(lane ? { bg: "element" as const } : {}), bold: true })
            else if (lane?.cars[x]) spans.push({ text: "██", fg: lane.tone, bg: "element", dim: !focused })
            else if (lane) spans.push({ text: x % 3 === 1 && y % 2 === 0 ? "╌╌" : "  ", fg: "border", bg: "element" })
            else spans.push({ text: y === 0 ? "▁▁" : "  ", fg: "success" })
          }
          return spans
        })
        const hearts = "♥".repeat(Math.max(0, lives))
        return {
          title: `Crossing · ${score} · ${hearts || "no lives"} · best ${record}`,
          status: over() ? "Knocked out. r restarts" : started ? `Level ${level}` : "↑ crosses to the top",
          rows: lines,
          width: cols * 2,
          controls: "↑ cross · ←→ dodge",
        }
      },
    }
  },
}
