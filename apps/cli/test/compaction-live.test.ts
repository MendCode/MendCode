import { afterEach, expect, test } from "bun:test"
import { b59Harness } from "./b59-harness"
import { cleanTemps, ids, NOW } from "./session-ui-harness"
import { preload } from "../src/ui/lazy-pages"
import { ARCADE_GAMES, advanceArcade, arcadeField, arcadeInput, pickGame, startArcade } from "../src/view/compaction-arcade"
import { slideRow } from "../src/view/arcade/game2048"
import { snake } from "../src/view/arcade/snake"
import { breakout } from "../src/view/arcade/breakout"
import { bar, compactTokens, sparkline } from "../src/view/compaction-live"
import { createCompactionFacts } from "../src/view/compaction-facts"
import { CUSTOMIZE_ROWS } from "../src/view/customize-page"
import { readTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)

type Mode = TuiProfile["compactionPanel"]
type Harness = ReturnType<typeof b59Harness>
const text = (h: Harness) => h.text().join("\n")
const MODES: Mode[] = ["panel", "stats", "arcade", "scratchpad", "quiet"]
/** A bar: whole blocks, one eighth-block step, then the track. */
const BAR = "[█▏▎▍▌▋▊▉]+░*"

/** A session that made two model calls, then a compaction whose memory call started 14 s ago. */
async function compacting(mode: Mode, size: [number, number] = [100, 34], options: { reducedMotion?: boolean; usage?: boolean } = {}) {
  await preload("compactionArcade")
  const h = b59Harness(size[0], size[1])
  if (options.reducedMotion) h.app.applySettings({ onboarded: true, reducedMotion: true })
  h.profile({ compactionPanel: mode })
  if (options.usage !== false) {
    const earlier = ids("turn")
    for (const [input, cacheRead, output] of [[900, 40_000, 300], [1_200, 61_000, 500]] as const) h.chat.emit({ type: "usage.recorded", turnId: earlier, provider: "test", model: "local-test", input, output, reasoning: 0, cacheRead, cacheWrite: 4_100 })
  }
  h.begin({ startedAt: NOW - 14_000, meta: { compactionMethod: "incremental", tailTurns: 2, tailTokens: 248 } })
  h.app.render()
  return h
}

const fits = (h: Harness, width: number, height: number) => {
  const frame = h.frames.at(-1)!
  expect(frame).toHaveLength(height)
  expect(frame.every((row) => textWidth(row.map((span) => span.text).join("")) <= width)).toBe(true)
}

/** Interval timers created and not yet cleared while `run` works: what a leaking panel would leave behind. */
async function liveIntervals(run: (live: Set<unknown>) => Promise<void>) {
  const live = new Set<unknown>()
  const { setInterval: set, clearInterval: clear } = globalThis
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => { const id = set(...args); live.add(id); return id }) as typeof setInterval
  globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => { live.delete(id); return clear(id) }) as typeof clearInterval
  try { await run(live) } finally { globalThis.setInterval = set; globalThis.clearInterval = clear }
}

test("the default panel is framed, names the phase, shows stage progress and tokens before to after, and the elapsed time", async () => {
  const h = await compacting("panel")
  const screen = text(h)
  expect(screen).toContain("╭─ Compacting context")
  expect(screen).toContain("Writing memory")
  expect(screen).toContain("step 2 of 3")
  expect(screen).toContain("14s")
  expect(screen).toMatch(/Context\s+66\.8k\s+→\s+tail ~248 \+ memory/)
  expect(screen).toContain("● Capture")
  expect(screen).toContain("tail ~248 kept")
  fits(h, 100, 34)
})

test("stats mode charts only what the events reported: context against the limit, cache split, trend, saved and progress", async () => {
  const h = await compacting("stats")
  const screen = text(h)
  expect(screen).toContain("Compaction stats")
  expect(screen).toMatch(new RegExp(`Context\\s+${BAR}\\s+66\\.8k / 160k threshold · 42%`))
  expect(screen).toMatch(/Cache\s+█+.*read 61k 92% · write 4\.1k 6%/)
  expect(screen).toMatch(/Trend\s+▁█\s+last 2 calls · peak 66\.8k/)
  expect(screen).toMatch(/Saved\s+pending · tail ~248 kept/)
  expect(screen).toMatch(new RegExp(`Progress\\s+${BAR}\\s+step 2 of 3`))
  fits(h, 100, 34)
})

test("stats mode invents nothing when no model call was recorded", async () => {
  const h = await compacting("stats", [100, 34], { usage: false })
  expect(text(h)).toContain("no model call recorded yet")
  expect(text(h)).toContain("no cache figures recorded")
  expect(text(h)).toContain("needs two model calls")
  expect(text(h)).not.toMatch(/\d+(\.\d+)?k \/ /)
})

test("arcade mode draws a game board with its controls, the scratchpad mode a note box, quiet a single line", async () => {
  const arcade = await compacting("arcade")
  expect(text(arcade)).toContain("╭─ Arcade · Snake · 0 · best 0")
  expect(text(arcade)).toContain("tab · click  play")
  expect(text(arcade)).toContain("◆")
  fits(arcade, 100, 34)
  const scratch = await compacting("scratchpad")
  expect(text(scratch)).toContain("╭─ Scratchpad")
  expect(text(scratch)).toContain("tab edit")
  fits(scratch, 100, 34)
  const quiet = await compacting("quiet")
  expect(text(quiet)).toMatch(/Compacting context · writing memory · 66\.8k tokens · 14s/)
  expect(text(quiet)).not.toContain("╭")
  expect(quiet.text().filter((row) => row.includes("Compacting context ·"))).toHaveLength(1)
  fits(quiet, 100, 34)
})

test("under 70 columns every mode drops its frame and keeps a compact layout inside the width", async () => {
  for (const mode of MODES) {
    const narrow = await compacting(mode, [60, 30])
    expect(text(narrow)).not.toContain("╭")
    expect(text(narrow)).toMatch(/Compact|Scratchpad|Snake/)
    fits(narrow, 60, 30)
  }
  expect(text(await compacting("panel", [60, 30]))).toContain("step 2 of 3")
  expect(text(await compacting("stats", [60, 30]))).toMatch(new RegExp(`Context\\s+${BAR}\\s+66\\.8k/160k 42%`))
  expect(text(await compacting("arcade", [60, 30]))).toContain("tab plays")
})

test("a terminal too short for the chosen mode falls back to the quiet line", async () => {
  const short = await compacting("arcade", [100, 17])
  expect(text(short)).not.toContain("Arcade")
  expect(text(short)).toContain("Compacting context ·")
  fits(short, 100, 17)
})

test("the panel is a /customize choice that persists", async () => {
  const harness = b59Harness(180, 50)
  harness.begin()
  await harness.type("/customize\r")
  for (let i = 0; i < CUSTOMIZE_ROWS.indexOf("compactionPanel"); i++) await harness.app.onKey("\x1b[B")
  expect(text(harness)).toContain("Compaction panel")
  expect(readTuiProfile(harness.dataDir).compactionPanel).toBe("panel")
  await harness.app.onKey("\x1b[C")
  expect(readTuiProfile(harness.dataDir).compactionPanel).toBe("stats")
  await harness.app.onKey("\x1b[C")
  expect(readTuiProfile(harness.dataDir).compactionPanel).toBe("arcade")
})

test("the arcade owns the keys only while it has focus, and the prompt never sees them", async () => {
  const harness = await compacting("arcade", [100, 34], { reducedMotion: true })
  await harness.type("hi")
  expect(harness.app.editor.text).toBe("hi")
  harness.app.editor.clear()
  await harness.type("\t")
  expect(text(harness)).toContain("esc / q     leave the game")
  const before = text(harness)
  await harness.type("\x1b[C")
  await harness.type("\x1b[C")
  await harness.type("abc \x1b[A")
  expect(harness.app.editor.text).toBe("")
  expect(text(harness)).not.toBe(before)
  expect(harness.sentOf("session.prompt")).toEqual([])
  await harness.type("\x1b")
  expect(text(harness)).toContain("tab · click  play")
  await harness.type("go")
  expect(harness.app.editor.text).toBe("go")
})

test("snake advances on the render loop's frames while focused and stands still when it is not", async () => {
  const harness = await compacting("arcade")
  const head = () => harness.text().find((row) => row.includes("██"))!.indexOf("██")
  await harness.type("\t")
  await harness.type("\x1b[C")
  const started = head()
  await Bun.sleep(420)
  harness.app.render()
  expect(head()).toBeGreaterThan(started)
  await harness.type("\x1b")
  const parked = head()
  await Bun.sleep(300)
  harness.app.render()
  expect(head()).toBe(parked)
})

test("n starts another game: breakout takes arrows and space, and its ball moves while focused", async () => {
  const harness = await compacting("arcade")
  await harness.type("\t")
  await harness.type("n")
  expect(text(harness)).toContain("Breakout")
  expect(text(harness)).toContain("Space launches")
  await harness.type(" ")
  expect(text(harness)).toContain("Level 1")
  await harness.type("\x1b[D")
  await harness.type("n")
  expect(text(harness)).toContain("Snake")
})

test("the arcade stops cleanly when the compaction completes: focus released, game gone, prompt typing back, no timers left", async () => {
  await liveIntervals(async (intervals) => {
    const harness = await compacting("arcade")
    expect(intervals.size).toBeGreaterThan(0)
    await harness.type("\t")
    await harness.type("\x1b[B")
    expect(text(harness)).toContain("esc / q     leave the game")
    harness.finish()
    harness.app.render()
    expect(text(harness)).not.toContain("Arcade")
    expect(text(harness)).toContain("Context packed")
    await harness.type("done")
    expect(harness.app.editor.text).toBe("done")
    await Bun.sleep(300)
    expect(intervals.size).toBe(0)
  })
})

test("a cancelled compaction also releases the arcade and its timers", async () => {
  await liveIntervals(async (intervals) => {
    const harness = await compacting("arcade")
    await harness.type("\t")
    harness.finish("cancelled")
    harness.app.render()
    expect(text(harness)).not.toContain("Arcade")
    await harness.type("x")
    expect(harness.app.editor.text).toBe("x")
    await Bun.sleep(200)
    expect(intervals.size).toBe(0)
  })
})

test("the scratchpad mode edits the project note in the panel, keeps the prompt clear, and saves through the daemon", async () => {
  const harness = await compacting("scratchpad", [100, 34])
  await harness.type("\t")
  expect(text(harness)).toContain("esc prompt")
  await harness.type("remember the plan")
  expect(harness.app.editor.text).toBe("")
  expect(text(harness)).toContain("remember the plan")
  const cursor = harness.cursors.at(-1)!
  const row = harness.text().findIndex((line) => line.includes("remember the plan"))
  expect(cursor.row).toBe(row)
  expect(harness.text()[cursor.row]!.slice(0, cursor.col)).toMatch(/remember the plan$/)
  await Bun.sleep(700)
  expect(harness.sentOf("scratchpad.set").at(-1)).toMatchObject({ text: "remember the plan" })
  await harness.type("\x1b")
  expect(text(harness)).toContain("tab edit")
  harness.finish()
  harness.app.render()
  expect(text(harness)).not.toContain("Scratchpad")
})

test("a click on the arcade focuses it and a click elsewhere lets it go", async () => {
  const harness = await compacting("arcade")
  const top = harness.text().findIndex((line) => line.includes("Arcade · Snake"))
  await harness.type(`\x1b[<0;20;${top + 4}M`)
  expect(text(harness)).toContain("esc / q     leave the game")
  await harness.type("\x1b[<0;20;3M")
  expect(text(harness)).toContain("tab · click  play")
})

test("every game has a field it can be played on and picks are random but never the same game twice in a row", () => {
  expect(ARCADE_GAMES.map((game) => game.id)).toEqual(["snake", "breakout", "2048"])
  for (const game of ARCADE_GAMES) expect(arcadeField(game, 100, 14)).toBeDefined()
  expect(arcadeField(snake, 18, 14)).toBeUndefined()
  expect(arcadeField(snake, 100, 6)).toBeUndefined()
  expect(new Set([0, 0.34, 0.67, 0.99].map((value) => pickGame(() => value).id))).toEqual(new Set(["snake", "breakout", "2048"]))
  for (const value of [0, 0.5, 0.99]) expect(pickGame(() => value, "breakout").id).not.toBe("breakout")
  expect(arcadeInput("\x1b[A")).toEqual({ type: "game", key: "up" })
  expect(arcadeInput("A")).toEqual({ type: "game", key: "left" })
  expect(arcadeInput("q")).toEqual({ type: "leave" })
  expect(arcadeInput("z")).toBeUndefined()
})

test("snake eats, grows, and dies on a wall; the same seed replays the same board", () => {
  const play = () => startArcade({ definition: snake, cols: 10, rows: 6, random: () => 0.5, best: 0, frame: 0 })
  const game = play()
  const first = game.instance.view({ focused: true }).rows.map((row) => row.map((span) => span.text).join("")).join("\n")
  expect(play().instance.view({ focused: true }).rows.map((row) => row.map((span) => span.text).join("")).join("\n")).toBe(first)
  game.instance.key("right")
  for (let i = 0; i < 20; i++) game.instance.tick()
  expect(game.instance.view({ focused: true }).status).toContain("Game over")
  game.instance.key("restart")
  expect(game.instance.view({ focused: true }).status).toContain("Arrow keys start")
  expect(game.instance.score).toBe(0)
})

test("breakout launches, bounces and ends after three lost balls; 2048 slides and merges", () => {
  const game = startArcade({ definition: breakout, cols: 12, rows: 10, random: () => 0.3, best: 0, frame: 0 })
  game.instance.tick()
  expect(game.instance.view({ focused: true }).status).toBe("Space launches")
  game.instance.key("space")
  for (let i = 0; i < 400; i++) game.instance.tick()
  expect(game.instance.score).toBeGreaterThanOrEqual(0)
  expect(game.instance.view({ focused: true }).title).toContain("Breakout")
  expect(slideRow([2, 2, 4, 0])).toEqual({ row: [4, 4, 0, 0], gained: 4 })
  expect(slideRow([2, 0, 2, 2])).toEqual({ row: [4, 2, 0, 0], gained: 4 })
  expect(slideRow([2, 4, 8, 16])).toEqual({ row: [2, 4, 8, 16], gained: 0 })
  const board = startArcade({ definition: ARCADE_GAMES[2]!, cols: 14, rows: 7, random: () => 0.1, best: 0, frame: 0 })
  const tiles = () => board.instance.view({ focused: true }).rows.map((row) => row.map((span) => span.text).join("")).join("\n").match(/\d+/g) ?? []
  expect(tiles()).toHaveLength(2)
  for (const key of ["left", "up", "right", "down", "left"] as const) board.instance.key(key)
  expect(tiles().length).toBeGreaterThanOrEqual(2)
})

test("a stalled render loop never fast-forwards a game by more than a few frames", () => {
  const game = startArcade({ definition: snake, cols: 12, rows: 8, random: () => 0.5, best: 0, frame: 0 })
  game.instance.key("right")
  advanceArcade(game, 10_000)
  expect(game.instance.view({ focused: true }).status).not.toContain("Game over")
})

test("the facts fold events into the numbers the panel draws and ignore replayed ones", () => {
  const facts = createCompactionFacts()
  const base = { sessionId: "s" as never, at: 1_000 }
  facts.apply({ ...base, seq: 1, type: "usage.recorded", turnId: "t1" as never, provider: "p", model: "m", input: 100, output: 50, reasoning: 0, cacheRead: 900, cacheWrite: 10 })
  facts.apply({ ...base, seq: 2, type: "compaction.updated", turnId: "t2" as never, reason: "auto", state: "writing", followUp: "" })
  facts.apply({ ...base, seq: 3, type: "usage.recorded", turnId: "t2" as never, provider: "p", model: "m", input: 700, output: 80, reasoning: 20, cacheRead: 0, cacheWrite: 0 })
  facts.apply({ ...base, seq: 3, type: "usage.recorded", turnId: "t2" as never, provider: "p", model: "m", input: 700, output: 999, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  const snapshot = facts.snapshot()
  expect(snapshot).toMatchObject({ active: true, reason: "auto", phase: "capture", before: { context: 1_060 }, summaryTokens: 100 })
  expect(snapshot.history).toEqual([1_060])
  facts.apply({ ...base, seq: 4, type: "compaction.updated", turnId: "t2" as never, reason: "auto", state: "packed", followUp: "" })
  expect(facts.snapshot()).toMatchObject({ active: false, phase: "packed" })
})

test("formatting helpers: compact tokens, bars with eighth blocks and sparklines", () => {
  expect([0, 999, 1_000, 12_345, 1_250_000].map(compactTokens)).toEqual(["0", "999", "1k", "12.3k", "1.25M"])
  expect(bar(0.5, 10, "primary").map((span) => span.text).join("")).toBe("█████░░░░░")
  expect(bar(0.55, 10, "primary").map((span) => span.text).join("")).toBe("█████▌░░░░")
  expect(sparkline([1, 5, 9], 8)).toBe("▁▅█")
})
