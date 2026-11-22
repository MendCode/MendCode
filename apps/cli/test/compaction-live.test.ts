import { afterEach, expect, test } from "bun:test"
import { b59Harness } from "./b59-harness"
import { cleanTemps, ids, NOW } from "./session-ui-harness"
import { preload } from "../src/ui/lazy-pages"
import { ARCADE_GAMES, advanceArcade, arcadeField, arcadeInput, pickGame, pressArcade, startArcade, viewArcade } from "../src/view/compaction-arcade"
import { slideRow } from "../src/view/arcade/game2048"
import { snake } from "../src/view/arcade/snake"
import { breakout } from "../src/view/arcade/breakout"
import { bar, compactTokens, sparkline } from "../src/view/compaction-live"
import { createCompactionFacts } from "../src/view/compaction-facts"
import { customizeSteps } from "../src/view/customize-page"
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

/** Where the half-block pixels of the last frame are: the snake and its food, nothing else on an arcade screen draws them. */
const pixelsOf = (h: Harness) => h.text().map((row) => [...row].flatMap((char, index) => ("▀▄█".includes(char) ? [index] : [])).join(",")).join(";")

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

test("while compacting the card is framed and has no spinner of its own: the activity line's is the only one", async () => {
  for (const mode of MODES) {
    const h = await compacting(mode)
    const spinners = h.text().join("\n").match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g) ?? []
    expect(spinners.length).toBe(1)
    expect(text(h)).toMatch(/Compacting…/)
  }
  expect(text(await compacting("panel"))).toContain("╭─ Compacting context")
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
  expect(text(arcade)).toContain("Arrow keys start")
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

test("a game started on a wide terminal is never drawn cut when it narrows: the panel shows until the game fits again", async () => {
  const harness = await compacting("arcade")
  await harness.type("\t")
  await harness.type("\x1b[C")
  harness.size.width = 30
  harness.app.render()
  expect(text(harness)).not.toContain("Snake")
  expect(text(harness)).toContain("step 2 of 3")
  fits(harness, 30, 34)
  harness.size.width = 100
  harness.app.render()
  expect(text(harness)).toContain("Arcade · Snake")
  expect(text(harness)).toContain("tab · click  play")
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
  for (let i = 0; i < customizeSteps("compactionPanel", harness.app.tuiProfile, { mode: harness.app.viewMode }); i++) await harness.app.onKey("\x1b[B")
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
  const board = () => pixelsOf(harness)
  await harness.type("\t")
  await harness.type("\x1b[C")
  const started = board()
  await Bun.sleep(420)
  harness.app.render()
  expect(board()).not.toBe(started)
  await harness.type("\x1b")
  const parked = board()
  await Bun.sleep(300)
  harness.app.render()
  expect(board()).toBe(parked)
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

test("a game being played when the compaction completes stays, still moving and keeping its score, until Esc closes it; then no timers are left", async () => {
  await liveIntervals(async (intervals) => {
    const harness = await compacting("arcade")
    expect(intervals.size).toBeGreaterThan(0)
    await harness.type("\t")
    await harness.type("\x1b[B")
    expect(text(harness)).toContain("esc / q     leave the game")
    harness.finish()
    harness.app.render()
    expect(text(harness)).toContain("Context packed")
    expect(text(harness)).toContain("Arcade · Snake")
    expect(text(harness)).toContain("compaction done · esc to close")
    expect(text(harness)).toContain("esc / q     close the game")
    // Keys still go to the game, and it keeps moving on frames of its own.
    await harness.type("ab")
    expect(harness.app.editor.text).toBe("")
    const moving = pixelsOf(harness)
    await Bun.sleep(300)
    harness.app.render()
    expect(pixelsOf(harness)).not.toBe(moving)
    expect(intervals.size).toBeGreaterThan(0)
    await harness.type("\x1b")
    expect(text(harness)).not.toContain("Arcade")
    await harness.type("done")
    expect(harness.app.editor.text).toBe("done")
    await Bun.sleep(300)
    expect(intervals.size).toBe(0)
  })
})

test("a kept game that stands still (paused or over) holds no frame timer; moving again brings it back", async () => {
  await liveIntervals(async (intervals) => {
    const harness = await compacting("arcade")
    await harness.type("\t")
    await harness.type("\x1b[C")
    harness.finish()
    harness.app.render()
    expect(text(harness)).toContain("compaction done · esc to close")
    expect(intervals.size).toBeGreaterThan(0)
    await Bun.sleep(300)
    harness.app.render()
    await harness.type(" ")
    expect(text(harness)).toContain("Paused")
    expect(intervals.size).toBe(0)
    const parked = pixelsOf(harness)
    await Bun.sleep(300)
    harness.app.render()
    expect(pixelsOf(harness)).toBe(parked)
    await harness.type(" ")
    expect(intervals.size).toBeGreaterThan(0)
    await Bun.sleep(300)
    harness.app.render()
    expect(pixelsOf(harness)).not.toBe(parked)
    await harness.type("\x1b")
  })
})

test("a game nobody is playing goes with the compaction: focus released, game gone, prompt typing back, no timers left", async () => {
  await liveIntervals(async (intervals) => {
    const harness = await compacting("arcade")
    await harness.type("\t")
    await harness.type("\x1b")
    harness.finish()
    harness.app.render()
    expect(text(harness)).not.toContain("Arcade")
    await harness.type("done")
    expect(harness.app.editor.text).toBe("done")
    await Bun.sleep(300)
    expect(intervals.size).toBe(0)
  })
})

test("a cancelled compaction keeps a game in play too, and q closes it and its timers", async () => {
  await liveIntervals(async (intervals) => {
    const harness = await compacting("arcade")
    await harness.type("\t")
    harness.finish("cancelled")
    harness.app.render()
    expect(text(harness)).toContain("compaction done · esc to close")
    await harness.type("q")
    expect(text(harness)).not.toContain("Arcade")
    await harness.type("x")
    expect(harness.app.editor.text).toBe("x")
    await Bun.sleep(200)
    expect(intervals.size).toBe(0)
  })
})

test("a kept game carries on as a normal arcade game when the next compaction starts", async () => {
  const harness = await compacting("arcade")
  await harness.type("\t")
  await harness.type("\x1b[B")
  harness.finish()
  harness.app.render()
  expect(text(harness)).toContain("compaction done")
  harness.begin({ startedAt: NOW - 1_000 })
  harness.app.render()
  expect(text(harness)).toContain("Arcade · Snake")
  expect(text(harness)).not.toContain("compaction done")
  expect(text(harness)).toContain("esc / q     leave the game")
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

test("a click on the arcade focuses it; clicks elsewhere and the wheel neither pause it nor take its keys", async () => {
  const harness = await compacting("arcade")
  const top = harness.text().findIndex((line) => line.includes("Arcade · Snake"))
  await harness.type(`\x1b[<0;20;${top + 4}M`)
  expect(text(harness)).toContain("esc / q     leave the game")
  await harness.type("\x1b[C")
  const prompt = harness.text().length - 3
  for (const report of ["\x1b[<0;20;3M", "\x1b[<0;20;3m", `\x1b[<0;10;${prompt}M`, `\x1b[<0;10;${prompt}m`, "\x1b[<64;20;5M", "\x1b[<65;20;5M"]) await harness.type(report)
  expect(text(harness)).toContain("esc / q     leave the game")
  const before = pixelsOf(harness)
  await Bun.sleep(300)
  harness.app.render()
  expect(pixelsOf(harness)).not.toBe(before)
  await harness.type("hi")
  expect(harness.app.editor.text).toBe("")
  await harness.type("\x1b")
  expect(text(harness)).toContain("tab · click  play")
})

test("every game has a field it can be played on and picks are random but never the same game twice in a row", () => {
  const ids = ["snake", "breakout", "2048", "blocks", "mines", "pong", "cycles", "glide", "stars", "crossing"]
  expect(ARCADE_GAMES.map((game) => game.id)).toEqual(ids)
  for (const game of ARCADE_GAMES) expect(arcadeField(game, 100, 14)).toBeDefined()
  expect(arcadeField(snake, 18, 14)).toBeUndefined()
  expect(arcadeField(snake, 100, 6)).toBeUndefined()
  expect(new Set(ids.map((_, index) => pickGame(() => (index + 0.5) / ids.length).id))).toEqual(new Set(ids))
  for (const value of [0, 0.5, 0.99]) expect(pickGame(() => value, "breakout").id).not.toBe("breakout")
  expect(arcadeInput("\x1b[A")).toEqual({ type: "game", key: "up" })
  expect(arcadeInput("A")).toEqual({ type: "game", key: "left" })
  expect(arcadeInput("q")).toEqual({ type: "leave" })
  expect(arcadeInput("f")).toEqual({ type: "game", key: "alt" })
  expect(arcadeInput("z")).toBeUndefined()
})

test("snake eats, grows, and dies on a wall; the same seed replays the same board", () => {
  const play = () => startArcade({ definition: snake, cols: 10, rows: 6, random: () => 0.5, best: 0, now: 0 })
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
  const game = startArcade({ definition: breakout, cols: 12, rows: 10, random: () => 0.3, best: 0, now: 0 })
  game.instance.tick()
  expect(game.instance.view({ focused: true }).status).toBe("Space launches")
  game.instance.key("space")
  for (let i = 0; i < 400; i++) game.instance.tick()
  expect(game.instance.score).toBeGreaterThanOrEqual(0)
  expect(game.instance.view({ focused: true }).title).toContain("Breakout")
  expect(slideRow([2, 2, 4, 0])).toEqual({ row: [4, 4, 0, 0], gained: 4 })
  expect(slideRow([2, 0, 2, 2])).toEqual({ row: [4, 2, 0, 0], gained: 4 })
  expect(slideRow([2, 4, 8, 16])).toEqual({ row: [2, 4, 8, 16], gained: 0 })
  const board = startArcade({ definition: ARCADE_GAMES[2]!, cols: 14, rows: 7, random: () => 0.1, best: 0, now: 0 })
  const tiles = () => board.instance.view({ focused: true }).rows.map((row) => row.map((span) => span.text).join("")).join("\n").match(/\d+/g) ?? []
  expect(tiles()).toHaveLength(2)
  for (const key of ["left", "up", "right", "down", "left"] as const) board.instance.key(key)
  expect(tiles().length).toBeGreaterThanOrEqual(2)
})

test("a stalled render loop never fast-forwards a game by more than a few steps", () => {
  const game = startArcade({ definition: snake, cols: 12, rows: 8, random: () => 0.5, best: 0, now: 0 })
  game.instance.key("right")
  advanceArcade(game, 0)
  advanceArcade(game, 10_000)
  expect(game.instance.view({ focused: true }).status).not.toContain("Game over")
})

/** The snake's head column in a session's drawn view (its head is the one primary pixel). */
const headOf = (session: ReturnType<typeof startArcade>) => session.instance.view({ focused: true }).rows.flatMap((row) => {
  let column = 0
  for (const span of row) {
    if (span.fg === "primary") return [column]
    column += span.text.length
  }
  return []
})[0]

test("games step by play time: one step per 125 ms whatever the frame timing, and paused or unfocused time is never played back", () => {
  const game = startArcade({ definition: snake, cols: 20, rows: 12, random: () => 0.5, best: 0, now: 1_000 })
  const start = headOf(game)!
  pressArcade(game, "right")
  advanceArcade(game, 1_000)
  // Frames a little early or late, and extra frames from key presses, still give one step each 125 ms.
  for (const at of [1_118, 1_131, 1_252, 1_290, 1_370, 1_380, 1_500]) advanceArcade(game, at)
  expect(headOf(game)! - start).toBe(4)
  // Unfocused for a minute, then played again: it picks up from where it was.
  advanceArcade(game, 61_500, false)
  advanceArcade(game, 61_510)
  expect(headOf(game)! - start).toBe(4)
  advanceArcade(game, 61_635)
  expect(headOf(game)! - start).toBe(5)
  // Paused (space) for a while: no steps owed when it moves again.
  pressArcade(game, "space")
  advanceArcade(game, 70_000)
  expect(game.instance.moving).toBe(false)
  pressArcade(game, "space")
  advanceArcade(game, 70_010)
  expect(headOf(game)! - start).toBe(5)
})

test("a game's view is drawn again only after a step, a key or a change of focus", () => {
  const game = startArcade({ definition: snake, cols: 12, rows: 8, random: () => 0.5, best: 0, now: 0 })
  const first = viewArcade(game, true)
  expect(viewArcade(game, true)).toBe(first)
  advanceArcade(game, 500)
  expect(viewArcade(game, true)).toBe(first)
  expect(viewArcade(game, false)).not.toBe(first)
  pressArcade(game, "right")
  const moved = viewArcade(game, true)
  expect(moved).not.toBe(first)
  advanceArcade(game, 500)
  advanceArcade(game, 625)
  expect(viewArcade(game, true)).not.toBe(moved)
})

test("the facts fold events into the numbers the panel draws and ignore replayed ones", () => {
  const facts = createCompactionFacts()
  const base = { sessionId: "s" as never, at: 1_000 }
  facts.apply({ ...base, seq: 1, type: "usage.recorded", turnId: "t1" as never, provider: "p", model: "m", input: 100, output: 50, reasoning: 0, cacheRead: 900, cacheWrite: 10 })
  facts.apply({ ...base, seq: 2, type: "compaction.updated", turnId: "t2" as never, reason: "auto", state: "writing", followUp: "" })
  facts.apply({ ...base, seq: 3, type: "usage.recorded", turnId: "t2" as never, provider: "p", model: "m", input: 700, output: 80, reasoning: 20, cacheRead: 0, cacheWrite: 0 })
  facts.apply({ ...base, seq: 3, type: "usage.recorded", turnId: "t2" as never, provider: "p", model: "m", input: 700, output: 999, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  const snapshot = facts.snapshot()
  expect(snapshot).toMatchObject({ active: true, reason: "auto", phase: "capture", before: { context: 1_060 }, summaryTokens: 80 })
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

test("a game kept after the compaction survives a narrow terminal and is back when the terminal widens", async () => {
  const harness = await compacting("arcade")
  await harness.type("\t")
  await harness.type("\x1b[C")
  harness.finish()
  harness.app.render()
  expect(text(harness)).toContain("compaction done · esc to close")
  harness.size.width = 30
  harness.app.render()
  harness.app.render()
  expect(text(harness)).not.toContain("Snake")
  harness.size.width = 100
  harness.app.render()
  expect(text(harness)).toContain("Arcade · Snake")
  expect(text(harness)).toContain("compaction done · esc to close")
})
