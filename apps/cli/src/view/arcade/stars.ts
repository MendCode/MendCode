import type { ColorName, Line, Span } from "../../ui/theme"
import { seeded, type ArcadeDefinition, type ArcadeKey } from "./types"

type Point = { x: number; y: number }
type Raider = Point & { tone: ColorName; alive: boolean }

const TONES: readonly ColorName[] = ["error", "warning", "accent"]
const LIVES = 3
/** Rows a shot climbs each frame; every row it crosses is checked, so it never skips over a raider. */
const SHOT_SPEED = 2

/**
 * Stars: a formation of raiders marches side to side and closer each time it meets an edge. Left and right move
 * your ship, space fires (one shot at a time), `r` restarts. Three ships; a wave cleared brings a faster one.
 */
export const stars: ArcadeDefinition = {
  id: "stars",
  label: "Stars",
  ticks: true,
  min: { cols: 12, rows: 8 },
  start({ cols, rows, random, best }) {
    const next = seeded(Math.floor(random() * 0xffffffff))
    const ship = rows - 1
    /** Which raider stands on each cell (index + 1), 0 for none: one lookup for hits and drawing. */
    const board = new Int16Array(cols * rows)
    let raiders: Raider[] = []
    let standing = 0
    let heading: 1 | -1 = 1
    let shot: Point | undefined
    let bombs: Point[] = []
    let x = 0
    let frames = 0
    let marchIn = 0
    let wave = 1
    let lives = LIVES
    let score = 0
    let started = false
    let record = best

    function place() {
      board.fill(0)
      raiders.forEach((raider, index) => {
        if (raider.alive && raider.y >= 0 && raider.y < rows) board[raider.y * cols + raider.x] = index + 1
      })
    }
    const raiderAt = (cx: number, cy: number) => (cx < 0 || cy < 0 || cx >= cols || cy >= rows ? undefined : raiders[board[cy * cols + cx]! - 1])
    /** Frames between two marching steps: fewer as the formation thins and with every wave. */
    const pace = () => Math.max(1, Math.ceil((6 * standing) / Math.max(1, raiders.length)) + 3 - wave)

    function form() {
      const lines = Math.min(3, Math.floor(rows / 3))
      raiders = []
      for (let line = 0; line < lines; line++) for (let column = 1; column < cols - 3; column += 2) raiders.push({ x: column, y: line + 1, tone: TONES[line]!, alive: true })
      standing = raiders.length
      heading = 1
      shot = undefined
      bombs = []
      marchIn = pace()
      place()
    }
    function reset() {
      x = Math.floor(cols / 2)
      frames = 0
      wave = 1
      lives = LIVES
      score = 0
      started = false
      form()
    }
    reset()

    const overrun = () => raiders.some((raider) => raider.alive && raider.y >= ship)
    const over = () => lives <= 0 || overrun()

    /** The shot meets whatever raider stands on its cell: both go, and a cleared formation brings the next wave. */
    function strike(): boolean {
      if (!shot) return false
      const hit = raiderAt(shot.x, shot.y)
      if (!hit) return false
      hit.alive = false
      board[hit.y * cols + hit.x] = 0
      standing--
      shot = undefined
      score += 10 * wave
      record = Math.max(record, score)
      if (!standing) {
        wave++
        form()
      }
      return true
    }
    function fly() {
      for (let step = 0; shot && step < SHOT_SPEED; step++) {
        shot.y--
        if (shot.y < 0) shot = undefined
        else if (strike()) return
      }
    }
    function march() {
      let edge = false
      for (const raider of raiders) if (raider.alive && (raider.x + heading < 0 || raider.x + heading >= cols)) edge = true
      for (const raider of raiders) {
        if (!raider.alive) continue
        if (edge) raider.y++
        else raider.x += heading
      }
      if (edge) heading = heading === 1 ? -1 : 1
      place()
      // A raider that steps onto the shot's cell is hit there, as if the shot had flown into it.
      strike()
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
        fly()
        if (--marchIn <= 0) {
          march()
          marchIn = pace()
        }
        // The lowest raider of a random column drops a bomb now and then; bombs fall every other frame.
        if (standing && next() < 0.06 + wave * 0.02) {
          const pick = Math.floor(next() * standing)
          let seen = 0
          const chosen = raiders.find((raider) => raider.alive && seen++ === pick)
          let lowest = chosen
          if (chosen) for (const raider of raiders) if (raider.alive && raider.x === chosen.x && raider.y > lowest!.y) lowest = raider
          if (lowest) bombs.push({ x: lowest.x, y: lowest.y + 1 })
        }
        if (frames % 2 === 0) {
          for (const bomb of bombs) bomb.y++
          bombs = bombs.filter((bomb) => bomb.y < rows)
        }
        if (bombs.some((bomb) => bomb.x === x && bomb.y === ship)) {
          lives--
          bombs = []
        }
      },
      key(key: ArcadeKey) {
        if (key === "restart") return reset()
        if (over()) return
        if (key === "left" || key === "right") {
          x = Math.max(0, Math.min(cols - 1, x + (key === "left" ? -1 : 1)))
          started = true
        } else if (key === "space") {
          started = true
          if (!shot) {
            shot = { x, y: ship - 1 }
            strike()
          }
        }
      },
      view({ focused }) {
        const lost = over()
        const lines: Line[] = []
        for (let y = 0; y < rows; y++) {
          const spans: Span[] = []
          for (let cx = 0; cx < cols; cx++) {
            const raider = raiderAt(cx, y)
            if (raider) spans.push({ text: "◥◤", fg: raider.tone, dim: !focused })
            else if (y === ship && cx === x) spans.push({ text: "◢◣", fg: lost ? "error" : "primary", bold: true })
            else if (shot && shot.x === cx && shot.y === y) spans.push({ text: "▕▏", fg: "text" })
            else if (bombs.some((bomb) => bomb.x === cx && bomb.y === y)) spans.push({ text: "▝▘", fg: "error" })
            else spans.push({ text: (cx * 7 + y * 13) % 29 === 0 ? " ·" : "  ", fg: "border" })
          }
          lines.push(spans)
        }
        const ships = "◢".repeat(Math.max(0, lives))
        return {
          title: `Stars · ${score} · ${ships || "no ships"} · best ${record}`,
          status: lost ? "Overrun. r restarts" : !started ? "Space fires, arrows move" : `Wave ${wave}`,
          rows: lines,
          width: cols * 2,
          controls: "space fire",
        }
      },
    }
  },
}
