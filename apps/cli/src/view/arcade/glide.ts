import { pixelRows, type Pixel } from "./pixels"
import { seeded, type ArcadeDefinition, type ArcadeKey } from "./types"

type Gate = { x: number; gap: number; passed: boolean }

const BIRD = 2
const GATE_WIDTH = 3
const GATE_EVERY = 14
const GRAVITY = 0.45
const FLAP = -1.7
const FALL_LIMIT = 2
/** Steps after a crash during which a flap does not fly again, so a held flap key cannot skip the crash. */
export const CRASH_GRACE = 5

/** Whether a bird whose top-left pixel is (x, y) overlaps `gate`, whose opening starts at `gap` and is `size` tall. */
export function hitsGate(x: number, y: number, gate: { x: number; gap: number }, size: number): boolean {
  const across = x + BIRD > gate.x && x < gate.x + GATE_WIDTH
  return across && (y < gate.gap || y + BIRD > gate.gap + size)
}

/**
 * Glide: space or up flaps, gravity does the rest; fly through the gaps in the walls. `r` restarts. One point a
 * wall; the ceiling, the floor and the walls end the flight.
 */
export const glide: ArcadeDefinition = {
  id: "glide",
  label: "Glide",
  ticks: true,
  min: { cols: 12, rows: 7 },
  start({ cols, rows, random, best }) {
    const width = cols * 2
    const height = rows * 2
    const size = Math.max(6, Math.floor(height / 3))
    const birdX = Math.floor(width / 4)
    const next = seeded(Math.floor(random() * 0xffffffff))
    let y = 0
    let speed = 0
    let gates: Gate[] = []
    let flying = false
    let crashed = false
    let grace = 0
    let score = 0
    let record = best

    const gap = () => 1 + Math.floor(next() * Math.max(1, height - size - 2))
    function reset() {
      y = Math.floor(height / 2) - 1
      speed = 0
      gates = [{ x: width + 2, gap: gap(), passed: false }]
      flying = false
      crashed = false
      grace = 0
      score = 0
    }
    reset()

    const top = () => Math.round(y)
    return {
      get score() {
        return score
      },
      get best() {
        return record
      },
      get moving() {
        return crashed ? grace > 0 : flying
      },
      tick() {
        if (crashed && grace > 0) grace--
        if (!flying || crashed) return
        speed = Math.min(FALL_LIMIT, speed + GRAVITY)
        y += speed
        for (const gate of gates) gate.x--
        if (gates[0] && gates[0].x + GATE_WIDTH <= 0) gates.shift()
        const last = gates.at(-1)
        if (!last || last.x <= width - GATE_EVERY) gates.push({ x: width, gap: gap(), passed: false })
        for (const gate of gates) {
          if (!gate.passed && gate.x + GATE_WIDTH <= birdX) {
            gate.passed = true
            score++
            record = Math.max(record, score)
          }
        }
        if (top() < 0 || top() + BIRD > height || gates.some((gate) => hitsGate(birdX, top(), gate, size))) {
          crashed = true
          grace = CRASH_GRACE
        }
      },
      key(key: ArcadeKey) {
        if (key === "restart") return reset()
        if (key !== "space" && key !== "up") return
        if (crashed) return grace > 0 ? undefined : reset()
        flying = true
        speed = FLAP
      },
      view({ focused }) {
        const at = (x: number, py: number): Pixel => {
          if (x >= birdX && x < birdX + BIRD && py >= top() && py < top() + BIRD) return crashed ? "error" : "warning"
          const gate = gates.find((each) => x >= each.x && x < each.x + GATE_WIDTH)
          if (gate && (py < gate.gap || py >= gate.gap + size)) return "success"
          return undefined
        }
        return {
          title: `Glide · ${score} · best ${record}`,
          status: crashed ? "Crashed. space flies again" : flying ? "Through the gaps" : "Space or ↑ flaps",
          rows: pixelRows({ width, height, at, dim: !focused }),
          width,
          controls: "space / ↑ flap",
        }
      },
    }
  },
}
