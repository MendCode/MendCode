import { expect, test } from "bun:test"
import { ARCADE_GAMES, startArcade } from "../src/view/compaction-arcade"
import { blocks, clearRows, rotateCells } from "../src/view/arcade/blocks"
import { breakout, paddleStride } from "../src/view/arcade/breakout"
import { crossing, shiftLane } from "../src/view/arcade/crossing"
import { cycles, reach } from "../src/view/arcade/cycles"
import { glide, hitsGate } from "../src/view/arcade/glide"
import { mines, neighbours } from "../src/view/arcade/mines"
import { pixelRows } from "../src/view/arcade/pixels"
import { landing, MATCH_POINTS, pong } from "../src/view/arcade/pong"
import { snake } from "../src/view/arcade/snake"
import { stars } from "../src/view/arcade/stars"
import type { ArcadeDefinition, ArcadeInstance, ArcadeKey } from "../src/view/arcade/types"
import type { ColorName, Line } from "../src/ui/theme"
import { textWidth } from "../src/view/wrap"

const play = (definition: ArcadeDefinition, cols = 20, rows = 12, seed = 0.42, best = 0) => startArcade({ definition, cols, rows, random: () => seed, best, frame: 0 }).instance
const view = (game: ArcadeInstance) => game.view({ focused: true })
const plain = (game: ArcadeInstance) => view(game).rows.map((row) => row.map((span) => span.text).join(""))
const press = (game: ArcadeInstance, ...keys: ArcadeKey[]) => keys.forEach((key) => game.key(key))
const ticks = (game: ArcadeInstance, count: number) => { for (let i = 0; i < count; i++) game.tick() }

/** Reads the colour of every half-block pixel back out of drawn rows (board pixels are undefined). */
function decode(rows: Line[]): (x: number, y: number) => ColorName | undefined {
  const grid: Array<Array<ColorName | undefined>> = []
  rows.forEach((row, line) => {
    const top: Array<ColorName | undefined> = []
    const bottom: Array<ColorName | undefined> = []
    for (const span of row) for (const char of span.text) {
      const back = span.bg === "element" ? undefined : span.bg
      top.push(char === "█" || char === "▀" ? span.fg : undefined)
      bottom.push(char === "█" || char === "▄" ? span.fg : char === "▀" ? back : undefined)
    }
    grid[line * 2] = top
    grid[line * 2 + 1] = bottom
  })
  return (x, y) => grid[y]?.[x]
}
const find = (rows: Line[], tone: ColorName, width: number, height: number) => {
  const at = decode(rows)
  const out: Array<{ x: number; y: number }> = []
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (at(x, y) === tone) out.push({ x, y })
  return out
}

test("every game draws rows exactly its width at its smallest field and at the largest, and keeps the best it was started with", () => {
  for (const definition of ARCADE_GAMES) {
    for (const [cols, rows] of [[definition.min.cols, definition.min.rows], [20, 12]] as const) {
      const game = play(definition, cols, rows, 0.42, 99)
      press(game, "space", "right", "up")
      ticks(game, 30)
      const drawn = view(game)
      expect(drawn.rows.length).toBeLessThanOrEqual(rows)
      expect(drawn.width).toBeLessThanOrEqual(cols * 2)
      for (const row of drawn.rows) expect(textWidth(row.map((span) => span.text).join(""))).toBe(drawn.width)
      expect(drawn.title).toContain("best 99")
      expect(game.best).toBeGreaterThanOrEqual(99)
      press(game, "restart")
      expect(game.score).toBe(0)
    }
  }
})

test("pixels are half blocks: two pixel rows per terminal row, one pixel per column, runs merged", () => {
  const lit = new Set(["0,0", "1,1", "2,0", "2,1"])
  const rows = pixelRows({ width: 4, height: 2, at: (x, y) => (lit.has(`${x},${y}`) ? "success" : undefined) })
  expect(rows).toHaveLength(1)
  expect(rows[0]!.map((span) => span.text).join("")).toBe("▀▄█ ")
  expect(decode(rows)(1, 1)).toBe("success")
  const run = pixelRows({ width: 6, height: 2, at: () => "primary" })
  expect(run[0]).toEqual([{ text: "██████", fg: "primary", bg: "element" }])
})

test("snake draws every cell as one square pixel: a field of 20 by 12 cells is 40 by 24 pixels in 12 rows", () => {
  const game = play(snake)
  expect(view(game).rows).toHaveLength(12)
  expect(view(game).width).toBe(40)
  const head = () => find(view(game).rows, "primary", 40, 24)
  expect(head()).toEqual([{ x: 3, y: 12 }])
  expect(find(view(game).rows, "success", 40, 24)).toEqual([{ x: 1, y: 12 }, { x: 2, y: 12 }])
  press(game, "up")
  game.tick()
  expect(head()).toEqual([{ x: 3, y: 11 }])
  ticks(game, 11)
  expect(head()).toEqual([{ x: 3, y: 0 }])
  game.tick()
  expect(view(game).status).toContain("Game over")
})

test("breakout's paddle moves several cells a press, so a held key crosses the field quickly", () => {
  expect(paddleStride(20)).toBe(3)
  expect(paddleStride(10)).toBe(2)
  const game = play(breakout)
  const paddle = () => plain(game).at(-1)!.indexOf("▀▀")
  const start = paddle()
  press(game, "right")
  expect(paddle() - start).toBe(6)
  for (let i = 0; i < 6; i++) press(game, "left")
  expect(paddle()).toBe(0)
})

test("blocks: pieces turn inside their box, full rows clear, a hard drop locks and scores, and the well stacks out", () => {
  expect(rotateCells([{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }])).toEqual([{ x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 2, y: 3 }])
  expect(clearRows([[1, 0], [1, 1], [0, 1], [2, 2]])).toEqual({ well: [[0, 0], [0, 0], [1, 0], [0, 1]], cleared: 2 })
  const game = play(blocks, 10, 10)
  press(game, "space")
  expect(game.score).toBe(1)
  const before = plain(game).join("\n")
  ticks(game, 6)
  expect(plain(game).join("\n")).not.toBe(before)
  for (let i = 0; i < 60 && !view(game).status.includes("Stacked out"); i++) press(game, "space")
  expect(view(game).status).toContain("Stacked out")
  const scored = game.score
  press(game, "space", "left", "up")
  expect(game.score).toBe(scored)
})

test("mines: the first tile opened is never a mine, flags count down, and opening every tile finds one", () => {
  expect(neighbours(0, 0, 3, 3)).toHaveLength(3)
  expect(neighbours(1, 1, 3, 3)).toHaveLength(8)
  const game = play(mines, 8, 6)
  const left = () => Number(/(\d+) mines left/.exec(view(game).status)![1])
  const total = left()
  press(game, "space")
  expect(game.score).toBeGreaterThan(1)
  expect(view(game).status).toContain("mines left")
  // Walk to a tile that is still closed and flag it.
  const underCursor = () => view(game).rows.flat().find((span) => span.bg === "primary")?.text
  for (let i = 0; i < 48 && underCursor() !== " ·"; i++) press(game, "right", ...(i % 8 === 7 ? (["down"] as const) : []))
  expect(underCursor()).toBe(" ·")
  press(game, "alt")
  expect(left()).toBe(total - 1)
  press(game, "alt")
  expect(left()).toBe(total)
  for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) press(game, "right", ...(x === 7 ? (["down"] as const) : []), "space")
  expect(view(game).status).toMatch(/Boom|Field cleared/)
  expect(game.best).toBeGreaterThan(1)
})

test("pong: the computer reads where the ball lands, points are scored, and the first to seven wins the match", () => {
  expect(landing({ x: 10, y: 2, vx: 1, vy: -1 }, 14, 12)).toBe(2)
  expect(landing({ x: 0, y: 0, vx: 1, vy: 1 }, 30, 12)).toBe(8)
  const game = play(pong)
  expect(view(game).status).toContain("serves")
  for (let i = 0; i < 20_000 && !/wins/.test(view(game).status); i++) {
    if (view(game).status.includes("serves")) press(game, "space")
    game.tick()
  }
  expect(view(game).status).toMatch(/You win the match|The computer wins/)
  const [mine, theirs] = /(\d+)–(\d+)/.exec(view(game).title)!.slice(1).map(Number)
  expect(Math.max(mine!, theirs!)).toBe(MATCH_POINTS)
  expect(game.score).toBe(mine!)
})

test("cycles: room ahead is counted, a rider that never turns crashes, and a won round scores", () => {
  expect(reach([0, 0, 0, 1, 0, 1, 0, 1, 0], 3, 3, 0, 0, 100)).toBe(4)
  expect(reach([1, 0, 0, 0], 2, 2, 0, 0, 100)).toBe(0)
  const game = play(cycles)
  press(game, "space")
  ticks(game, 200)
  expect(view(game).status).toMatch(/crashed|Round won/)
  const trail = find(view(game).rows, "primary", 40, 24)
  expect(trail.length).toBeGreaterThan(5)
  if (view(game).status.includes("Round won")) expect(game.score).toBe(1)
  else expect(game.score).toBe(0)
})

test("glide: gravity brings it down onto the floor, and flapping through the gaps scores", () => {
  expect(hitsGate(10, 4, { x: 10, gap: 5 }, 6)).toBe(true)
  expect(hitsGate(10, 5, { x: 10, gap: 5 }, 6)).toBe(false)
  expect(hitsGate(6, 0, { x: 10, gap: 5 }, 6)).toBe(false)
  const falling = play(glide)
  press(falling, "space")
  ticks(falling, 40)
  expect(view(falling).status).toContain("Crashed")
  expect(falling.score).toBe(0)
  // A pilot that flaps whenever the bird sinks below the middle of the next gap.
  const game = play(glide)
  press(game, "space")
  for (let i = 0; i < 400 && !view(game).status.includes("Crashed"); i++) {
    const rows = view(game).rows
    const bird = find(rows, "warning", 40, 24)
    const walls = find(rows, "success", 40, 24).filter((pixel) => pixel.x >= bird[0]!.x - 3)
    const column = Math.min(...walls.map((pixel) => pixel.x))
    const shut = new Set(walls.filter((pixel) => pixel.x === column).map((pixel) => pixel.y))
    const open = Array.from({ length: 24 }, (_, y) => y).filter((y) => !shut.has(y))
    const middle = open.length ? (open[0]! + open.at(-1)!) / 2 : 12
    if (Math.max(...bird.map((pixel) => pixel.y)) > middle + 1) press(game, "space")
    game.tick()
  }
  expect(game.score).toBeGreaterThan(0)
})

test("stars: shots bring raiders down for points, and a ship that never fires is overrun or bombed out", () => {
  const game = play(stars)
  for (let i = 0; i < 300; i++) {
    press(game, "space")
    game.tick()
  }
  expect(game.score).toBeGreaterThan(0)
  expect(game.score % 10).toBe(0)
  const idle = play(stars)
  press(idle, "left")
  ticks(idle, 3_000)
  expect(view(idle).status).toContain("Overrun")
  press(idle, "restart")
  expect(view(idle).title).toContain("◢◢◢")
})

test("crossing: lanes shift and wrap, the kerb is safe, traffic knocks you back, and reaching the top scores", () => {
  expect(shiftLane([true, false, false], 1)).toEqual([false, true, false])
  expect(shiftLane([true, false, false], -1)).toEqual([false, false, true])
  const waiting = play(crossing, 10, 7)
  press(waiting, "left")
  ticks(waiting, 200)
  expect(view(waiting).title).toContain("♥♥♥")
  // A walker that steps up only when the cells above are clear, starting over after each run.
  const game = play(crossing, 10, 7)
  for (let run = 0; run < 40 && game.score === 0; run++) {
    press(game, "restart")
    for (let i = 0; i < 400 && game.score === 0 && !view(game).status.includes("Knocked out"); i++) {
      const lines = plain(game)
      const y = lines.findIndex((line) => line.includes("▐▌"))
      const x = lines[y]!.indexOf("▐▌")
      const above = lines[y - 1]?.slice(Math.max(0, x - 2), x + 4) ?? ""
      if (!above.includes("█")) press(game, "up")
      game.tick()
    }
  }
  expect(game.score).toBeGreaterThan(0)
  expect(view(game).status).toContain("Level 2")
})
