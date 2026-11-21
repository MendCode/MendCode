import { pixelRows, type Pixel } from "./pixels"
import { seeded, type ArcadeDefinition, type ArcadeKey } from "./types"

/** Points that win a match. */
export const MATCH_POINTS = 7
const PADDLE = 5
/** Pixels the player's paddle moves per key press. */
const STRIDE = 2

/** The ball's row and vertical speed after one move of `vy` rows, mirrored off the top and bottom walls. */
function bounce(y: number, vy: number, height: number): [number, number] {
  const ny = y + vy
  if (ny < 0) return [-ny, -vy]
  if (ny >= height) return [2 * (height - 1) - ny, -vy]
  return [ny, vy]
}

/**
 * The ball's vertical speed off a paddle hit `offset` pixels below the paddle's top: steep off the end pixels, shallow
 * next to them, shallow and the same way in the middle.
 */
export function returnAngle(offset: number, vy: number): number {
  return offset <= 0 ? -2 : offset === 1 ? -1 : offset === 2 ? Math.sign(vy) : offset === 3 ? 1 : 2
}

/** Where a ball at (x, y) moving (vx, vy) meets column `goal` on a field `height` pixels tall, walls bouncing it. */
export function landing(ball: { x: number; y: number; vx: number; vy: number }, goal: number, height: number): number {
  let { x, y, vy } = ball
  for (let guard = 0; x !== goal && guard < 1_000; guard++) {
    ;[y, vy] = bounce(y, vy, height)
    x += ball.vx
  }
  return y
}

/**
 * Pong against the computer: up and down move your paddle on the left, space serves, `r` restarts. First to seven
 * wins the match; the score is your points. The computer reads the ball well but not perfectly.
 */
export const pong: ArcadeDefinition = {
  id: "pong",
  label: "Pong",
  ticks: true,
  min: { cols: 12, rows: 6 },
  start({ cols, rows, random, best }) {
    const width = cols * 2
    const height = rows * 2
    const next = seeded(Math.floor(random() * 0xffffffff))
    const middle = Math.floor((height - PADDLE) / 2)
    let you = middle
    let cpu = middle
    let ball = { x: 0, y: 0, vx: 1, vy: 1 }
    let serving = true
    let aim = 0
    let points = { you: 0, cpu: 0 }
    let record = best

    const clamp = (y: number) => Math.max(0, Math.min(height - PADDLE, y))
    function serve(toward: 1 | -1) {
      ball = { x: Math.floor(width / 2), y: Math.floor(height / 2), vx: toward, vy: next() < 0.5 ? -1 : 1 }
      serving = true
      misjudge()
    }
    /**
     * The computer misjudges each ball coming its way by up to three pixels, drawn afresh for every return and every
     * serve: one bad guess kept for every serve made it miss them all in a row.
     */
    function misjudge() {
      aim = Math.floor(next() * 7) - 3
    }
    function reset() {
      points = { you: 0, cpu: 0 }
      you = middle
      cpu = middle
      serve(-1)
    }
    reset()
    const over = () => points.you >= MATCH_POINTS || points.cpu >= MATCH_POINTS

    /** A paddle's answer: the ball goes back, steeper off the paddle's ends. */
    const returns = (top: number, y: number) => y >= top && y < top + PADDLE
    function step() {
      const { x, vx } = ball
      // The ball's height is kept in fractions of a pixel and drawn on the nearest one.
      const [ny, vy] = bounce(ball.y, ball.vy, height)
      const row = Math.round(ny)
      const nx = x + vx
      if (nx === 0 && vx < 0 && returns(you, row)) {
        ball = { x: 1, y: ny, vx: 1, vy: returnAngle(row - you, vy) }
        misjudge()
        return
      }
      if (nx === width - 1 && vx > 0 && returns(cpu, row)) {
        // Its returns vary in pace a little, so on no field size does a rally retrace one path for ever.
        ball = { x: width - 2, y: ny, vx: -1, vy: returnAngle(row - cpu, vy) * (0.75 + next() * 0.5) }
        return
      }
      if (nx < 0 || nx >= width) {
        if (nx < 0) points.cpu++
        else points.you++
        record = Math.max(record, points.you)
        serve(nx < 0 ? -1 : 1)
        return
      }
      ball = { x: nx, y: ny, vx, vy }
    }

    return {
      get score() {
        return points.you
      },
      get best() {
        return record
      },
      get moving() {
        return !serving && !over()
      },
      tick() {
        if (serving || over()) return
        // The ball covers two pixels a frame, the computer's paddle one.
        step()
        if (!serving) step()
        const target = ball.vx > 0 ? landing(ball, width - 1, height) + aim : Math.floor(height / 2)
        const centre = cpu + Math.floor(PADDLE / 2)
        if (target < centre) cpu = clamp(cpu - 1)
        else if (target > centre) cpu = clamp(cpu + 1)
      },
      key(key: ArcadeKey) {
        if (key === "restart") return reset()
        if (key === "space") {
          if (over()) reset()
          else serving = false
          return
        }
        if (key === "up" || key === "down") {
          you = clamp(you + (key === "up" ? -STRIDE : STRIDE))
          if (serving && !over()) serving = false
        }
      },
      view({ focused }) {
        const at = (x: number, y: number): Pixel => {
          if (!over() && x === ball.x && y === Math.round(ball.y)) return "text"
          if (x === 0 && returns(you, y)) return "primary"
          if (x === width - 1 && returns(cpu, y)) return "error"
          if (x === Math.floor(width / 2) && y % 4 < 2) return "border"
          return undefined
        }
        const won = points.you >= MATCH_POINTS
        return {
          title: `Pong · ${points.you}–${points.cpu} · best ${record}`,
          status: over() ? (won ? "You win the match. r restarts" : "The computer wins. r restarts") : serving ? "Space or a move serves" : `First to ${MATCH_POINTS}`,
          rows: pixelRows({ width, height, at, dim: !focused }),
          width,
          controls: "space serve",
        }
      },
    }
  },
}
