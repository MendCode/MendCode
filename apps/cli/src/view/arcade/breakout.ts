import type { ColorName, Line, Span } from "../../ui/theme"
import { seeded, type ArcadeDefinition, type ArcadeKey } from "./types"

const BRICK_TONES: readonly ColorName[] = ["error", "warning", "success", "info", "accent"]
const PADDLE = 5

/** Cells the paddle moves per key press: two on small fields, three from sixteen cells wide. */
export const paddleStride = (cols: number) => (cols >= 16 ? 3 : 2)

/** The ball moves a cell a tick along its heading, which is measured from the vertical in radians. */
type Ball = { x: number; y: number; vx: number; vy: number; stale: number; nudges: number }

/** Steepest and shallowest heading off the vertical: the ball is never exactly vertical nor close to horizontal. */
const MIN_ANGLE = (12 * Math.PI) / 180
const MAX_ANGLE = (60 * Math.PI) / 180
/** Wall and paddle bounces without a brick before the ball's heading is turned a little. */
export const STALE_BOUNCES = 8
const NUDGE = (9 * Math.PI) / 180

const clampAngle = (angle: number, fallback: number) => {
  const side = angle === 0 ? fallback : Math.sign(angle)
  return side * Math.min(MAX_ANGLE, Math.max(MIN_ANGLE, Math.abs(angle)))
}

/** A ball at `x`,`y` heading `angle` off the vertical, up when `up` is true. */
export const launchBall = (input: { x: number; y: number; angle: number; up: boolean }): Ball => {
  const angle = clampAngle(input.angle, 1)
  return { x: input.x, y: input.y, vx: Math.sin(angle), vy: (input.up ? -1 : 1) * Math.cos(angle), stale: 0, nudges: 0 }
}

const heading = (ball: Ball) => Math.atan2(ball.vx, Math.abs(ball.vy))

/**
 * One move of the ball, a cell along its heading. Like real Breakout, the paddle sends it off at an angle that depends
 * on where it lands: the middle sends it nearly straight up, the ends at a slant. A brick straight above or below it is
 * met first, then one beside it, then the one on the diagonal, so the ball never slips between two bricks that touch at
 * a corner. The paddle catches a ball over any of its cells, its ends included. A ball that bounces `STALE_BOUNCES`
 * times without breaking a brick has its heading turned, so it cannot repeat one path forever. `broke` is the brick it
 * took, `lost` a ball that went past the paddle.
 */
export function moveBall(input: { ball: Ball; cols: number; paddle: number; paddleY: number; brick: (x: number, y: number) => boolean }): { ball: Ball; broke?: { x: number; y: number }; lost?: boolean } {
  const { cols, paddle, paddleY, brick } = input
  let { x, y, vx, vy, stale, nudges } = input.ball
  let nx = x + vx
  let ny = y + vy
  if (nx < 0) { nx = -nx; vx = -vx; stale++ }
  else if (nx > cols - 1) { nx = 2 * (cols - 1) - nx; vx = -vx; stale++ }
  if (ny < 0) { ny = -ny; vy = -vy; stale++ }
  const cx = Math.round(x)
  const cy = Math.round(y)
  const tx = Math.round(nx)
  const ty = Math.round(ny)
  const stay = { x, y, vx, vy, stale: 0, nudges }
  if (brick(cx, ty)) return { ball: { ...stay, vy: -vy }, broke: { x: cx, y: ty } }
  if (brick(tx, cy)) return { ball: { ...stay, vx: -vx }, broke: { x: tx, y: cy } }
  if (brick(tx, ty)) return { ball: { ...stay, vy: -vy }, broke: { x: tx, y: ty } }
  const over = (cell: number) => cell >= paddle && cell < paddle + PADDLE
  if (ty === paddleY && vy > 0 && (over(tx) || over(cx))) {
    const half = (PADDLE - 1) / 2
    const offset = Math.max(-1, Math.min(1, (nx - (paddle + half)) / (half + 0.5)))
    const angle = clampAngle(offset * MAX_ANGLE, vx < 0 ? -1 : 1)
    return { ball: { ...launchBall({ x: nx, y: paddleY - 1, angle, up: true }), stale: stale + 1, nudges } }
  }
  if (ty > paddleY) return { ball: { x, y, vx, vy, stale, nudges }, lost: true }
  let ball: Ball = { x: nx, y: ny, vx, vy, stale, nudges }
  if (stale >= STALE_BOUNCES) {
    const turned = clampAngle(heading(ball) + (nudges % 2 === 0 ? NUDGE : -NUDGE) * (1 + Math.floor(nudges / 2)), 1)
    ball = { ...ball, vx: Math.sin(turned), vy: Math.sign(vy) * Math.cos(turned), stale: 0, nudges: nudges + 1 }
  }
  return { ball }
}

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
    // A held key repeats about 30 times a second: three cells a press crosses the widest field in under a second.
    const stride = paddleStride(cols)
    let bricks: boolean[][] = []
    let paddle = 0
    let ball = launchBall({ x: 0, y: 0, angle: 1, up: true })
    let launched = false
    let paused = false
    let lives = 3
    let score = 0
    let level = 1
    let record = best

    const fill = () => { bricks = Array.from({ length: brickRows }, () => Array.from({ length: cols }, () => true)) }
    const serve = () => {
      paddle = Math.floor((cols - PADDLE) / 2)
      ball = launchBall({ x: paddle + Math.floor(PADDLE / 2), y: paddleY - 1, angle: (next() < 0.5 ? -1 : 1) * (25 * Math.PI) / 180, up: true })
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
      get moving() {
        return launched && !paused && !over() && !cleared()
      },
      tick() {
        if (!launched || paused || over() || cleared()) return
        const moved = moveBall({ ball, cols, paddle, paddleY, brick: (x, y) => bricks[y]?.[x] === true })
        ball = moved.ball
        if (moved.broke) {
          bricks[moved.broke.y]![moved.broke.x] = false
          score += 10
          record = Math.max(record, score)
        }
        if (moved.lost) {
          lives--
          if (lives > 0) serve()
        }
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
          paddle = Math.max(0, Math.min(cols - PADDLE, paddle + (key === "left" ? -stride : stride)))
          if (!launched) ball = { ...ball, x: paddle + Math.floor(PADDLE / 2) }
          if (paused) paused = false
        }
      },
      view({ focused }) {
        const lines: Line[] = []
        for (let y = 0; y < rows; y++) {
          const spans: Span[] = []
          for (let x = 0; x < cols; x++) {
            if (Math.round(ball.x) === x && Math.round(ball.y) === y && !over()) spans.push({ text: "● ", fg: "text", bold: true })
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
