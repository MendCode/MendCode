import type { ColorName, Line, Span } from "../../ui/theme"
import { seeded, type ArcadeDefinition, type ArcadeKey } from "./types"

type Point = { x: number; y: number }
type Raider = Point & { tone: ColorName; alive: boolean }

const TONES: readonly ColorName[] = ["error", "warning", "accent"]
const LIVES = 3

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
    let raiders: Raider[] = []
    let heading: 1 | -1 = 1
    let shot: Point | undefined
    let bombs: Point[] = []
    let x = 0
    let frames = 0
    let wave = 1
    let lives = LIVES
    let score = 0
    let started = false
    let record = best

    function form() {
      const lines = Math.min(3, Math.floor(rows / 3))
      raiders = []
      for (let line = 0; line < lines; line++) for (let column = 1; column < cols - 3; column += 2) raiders.push({ x: column, y: line + 1, tone: TONES[line]!, alive: true })
      heading = 1
      shot = undefined
      bombs = []
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

    const standing = () => raiders.filter((raider) => raider.alive)
    const over = () => lives <= 0 || standing().some((raider) => raider.y >= ship)
    /** Frames between two marching steps: fewer as the formation thins and with every wave. */
    const pace = () => Math.max(1, Math.ceil((6 * standing().length) / Math.max(1, raiders.length)) + 3 - wave)

    function march() {
      const alive = standing()
      if (alive.some((raider) => raider.x + heading < 0 || raider.x + heading >= cols)) {
        for (const raider of alive) raider.y++
        heading = heading === 1 ? -1 : 1
      } else for (const raider of alive) raider.x += heading
    }
    function fly() {
      if (!shot) return
      shot = { x: shot.x, y: shot.y - 1 }
      const hit = standing().find((raider) => raider.x === shot!.x && raider.y === shot!.y)
      if (hit) {
        hit.alive = false
        shot = undefined
        score += 10 * wave
        record = Math.max(record, score)
        if (!standing().length) {
          wave++
          form()
        }
      } else if (shot.y < 0) shot = undefined
    }

    return {
      get score() {
        return score
      },
      get best() {
        return record
      },
      tick() {
        if (!started || over()) return
        frames++
        fly()
        if (frames % pace() === 0) march()
        // The lowest raider of a random column drops a bomb now and then; bombs fall every other frame.
        if (next() < 0.06 + wave * 0.02) {
          const alive = standing()
          const pick = alive[Math.floor(next() * alive.length)]
          const lowest = pick && alive.filter((raider) => raider.x === pick.x).reduce((low, raider) => (raider.y > low.y ? raider : low), pick)
          if (lowest) bombs.push({ x: lowest.x, y: lowest.y + 1 })
        }
        if (frames % 2 === 0) bombs = bombs.map((bomb) => ({ x: bomb.x, y: bomb.y + 1 })).filter((bomb) => bomb.y < rows)
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
          if (!shot) shot = { x, y: ship - 1 }
        }
      },
      view({ focused }) {
        const alive = standing()
        const lines: Line[] = []
        for (let y = 0; y < rows; y++) {
          const spans: Span[] = []
          for (let cx = 0; cx < cols; cx++) {
            const raider = alive.find((each) => each.x === cx && each.y === y)
            if (raider) spans.push({ text: "◥◤", fg: raider.tone, dim: !focused })
            else if (y === ship && cx === x) spans.push({ text: "◢◣", fg: over() ? "error" : "primary", bold: true })
            else if (shot && shot.x === cx && shot.y === y) spans.push({ text: "▕▏", fg: "text" })
            else if (bombs.some((bomb) => bomb.x === cx && bomb.y === y)) spans.push({ text: "▝▘", fg: "error" })
            else spans.push({ text: (cx * 7 + y * 13) % 29 === 0 ? " ·" : "  ", fg: "border" })
          }
          lines.push(spans)
        }
        const ships = "◢".repeat(Math.max(0, lives))
        return {
          title: `Stars · ${score} · ${ships || "no ships"} · best ${record}`,
          status: over() ? "Overrun. r restarts" : !started ? "Space fires, arrows move" : `Wave ${wave}`,
          rows: lines,
          width: cols * 2,
          controls: "space fire",
        }
      },
    }
  },
}
