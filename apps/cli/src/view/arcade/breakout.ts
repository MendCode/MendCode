import type { ColorName, Line, Span } from "../../ui/theme"
import { seeded, type ArcadeDefinition, type ArcadeKey } from "./types"

const BRICK_TONES: readonly ColorName[] = ["error", "warning", "success", "info", "accent"]
const PADDLE = 5

/** Breakout: left and right move the paddle, space launches the ball or pauses, `r` restarts. Three lives. */
export const breakout: ArcadeDefinition = {
  id: "breakout",
  label: "Breakout",
  ticks: true,
  min: { cols: 10, rows: 8 },
  start({ cols, rows, random, best }) {
    const next = seeded(Math.floor(random() * 0xffffffff))
    const brickRows = Math.min(BRICK_TONES.length, Math.max(2, Math.floor(rows / 3)))
    const paddleY = rows - 1
    let bricks: boolean[][] = []
    let paddle = 0
    let ball = { x: 0, y: 0, vx: 1, vy: -1 }
    let launched = false
    let paused = false
    let lives = 3
    let score = 0
    let level = 1
    let record = best

    const fill = () => { bricks = Array.from({ length: brickRows }, () => Array.from({ length: cols }, () => true)) }
    const serve = () => {
      paddle = Math.floor((cols - PADDLE) / 2)
      ball = { x: paddle + Math.floor(PADDLE / 2), y: paddleY - 1, vx: next() < 0.5 ? -1 : 1, vy: -1 }
      launched = false
    }
    function reset() {
      fill()
      serve()
      lives = 3
      score = 0
      level = 1
      paused = false
    }
    reset()

    const remaining = () => bricks.reduce((sum, row) => sum + row.filter(Boolean).length, 0)
    const over = () => lives <= 0
    const cleared = () => remaining() === 0

    return {
      get score() {
        return score
      },
      get best() {
        return record
      },
      tick() {
        if (!launched || paused || over() || cleared()) return
        let { x, y, vx, vy } = ball
        if (x + vx < 0 || x + vx >= cols) vx = -vx
        if (y + vy < 0) vy = -vy
        const nx = x + vx
        const ny = y + vy
        if (bricks[ny]?.[nx]) {
          bricks[ny]![nx] = false
          score += 10
          record = Math.max(record, score)
          vy = -vy
          ball = { x, y, vx, vy }
          return
        }
        if (ny === paddleY && nx >= paddle && nx < paddle + PADDLE) {
          const side = nx - paddle
          vx = side < 2 ? -1 : side >= PADDLE - 2 ? 1 : vx
          ball = { x: nx, y: paddleY - 1, vx, vy: -1 }
          return
        }
        if (ny > paddleY) {
          lives--
          if (lives > 0) serve()
          return
        }
        ball = { x: nx, y: ny, vx, vy }
      },
      key(key: ArcadeKey) {
        if (key === "restart") return reset()
        if (key === "space") {
          if (cleared()) {
            level++
            fill()
            serve()
          } else if (!launched) launched = true
          else paused = !paused
          return
        }
        if (key === "left" || key === "right") {
          paddle = Math.max(0, Math.min(cols - PADDLE, paddle + (key === "left" ? -1 : 1)))
          if (!launched) ball = { ...ball, x: paddle + Math.floor(PADDLE / 2) }
          if (paused) paused = false
        }
      },
      view({ focused }) {
        const lines: Line[] = []
        for (let y = 0; y < rows; y++) {
          const spans: Span[] = []
          for (let x = 0; x < cols; x++) {
            if (ball.x === x && ball.y === y && !over()) spans.push({ text: "● ", fg: "text", bold: true })
            else if (bricks[y]?.[x]) spans.push({ text: "██", fg: BRICK_TONES[y % BRICK_TONES.length]!, dim: !focused })
            else if (y === paddleY && x >= paddle && x < paddle + PADDLE) spans.push({ text: "▀▀", fg: "primary" })
            else spans.push({ text: "  " })
          }
          lines.push(spans)
        }
        const hearts = "♥".repeat(Math.max(0, lives))
        return {
          title: `Breakout · ${score} · ${hearts || "no lives"} · best ${record}`,
          status: over() ? "Game over. r restarts" : cleared() ? `Level ${level} clear. Space continues` : !launched ? "Space launches" : paused ? "Paused" : `Level ${level}`,
          rows: lines,
          width: cols * 2,
        }
      },
    }
  },
}
