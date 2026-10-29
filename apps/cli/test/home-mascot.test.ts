import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { TUI_DEFAULTS, TUI_ENUMS, featureOn, tuiProblems } from "@mendcode/protocol/wire"
import { encodeImagePng } from "../../../packages/tools/src/pet-png"
import { contentBox } from "../../../packages/tools/src/pet-resample"
import { parsePetCommand } from "../src/pet-command"
import { createFrameCache, spriteArt, spriteCells, spriteDurations, spriteFrames } from "../src/pets/art"
import { createPetController, REVIEW_MS, SLEEP_MS } from "../src/pets/controller"
import { PET_FRAME_DURATIONS } from "../src/pets/frames"
import { createHomePet, gradientSpans, HOME_PET_SIZES } from "../src/pets/home-pet"
import { listPets } from "../src/pets/manifest"
import { createPetSlot, petChoices, PET_BOX, PET_HALF_BLOCK_SIZES, PET_SIZES } from "../src/pets/pet-slot"
import { loadSprite } from "../src/pets/sprite"
import { createHomeMascot, isPetMascot } from "../src/ui/app/home-mascot"
import { createTerminalFocus } from "../src/ui/terminal-focus"
import { setTheme, type Line } from "../src/ui/theme"
import { customizePageKey, CUSTOMIZE_ROWS } from "../src/view/customize-page"
import { renderHome, type HomeMascot, type HomeMascotBox } from "../src/view/home"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile, readTuiProfile, tuiProfilePath, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { mendSpriteLines } from "../src/view/mend-sprite"
import { lineWidth } from "../src/view/wrap"
import { hasHalfBlocks, mascotScene, petStore, type PetStore } from "./mascot-scene"
import { onBackground, sampleSprite, sheetOf, smoothSample } from "./mascot-sample"
import { cleanTemps, conversation, mendRowIn, plain, tempDir } from "./session-ui-harness"

afterAll(() => {
  setTheme("mend")
  cleanTemps()
})

const text = (lines: readonly Line[]) => lines.map(plain)
const pixel = sampleSprite()
const blink = sheetOf([pixel, pixel, sampleSprite({ eyes: "closed" }), sampleSprite({ lift: 1 })])
const TITLE = "█▄ ▄█"

/** Timers the test fires by hand: `advance` runs what is due, in order. */
function clock() {
  let now = 0
  let timers: Array<{ id: number; at: number; run: () => void }> = []
  let next = 1
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => { timers.push({ id: next, at: now + ms, run }); return next++ },
    clearTimer: (id: unknown) => { timers = timers.filter((timer) => timer.id !== id) },
    get pending() { return timers.map((timer) => timer.at - now) },
    advance(ms: number) {
      const until = now + ms
      for (;;) {
        const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers = timers.filter((timer) => timer !== due)
        now = due.at
        due.run()
      }
      now = until
    },
  }
}

/** `image` with its drawn pixels shifted in color: another picture of the same shape. */
const tinted = (image: typeof pixel, by: number): typeof pixel => ({ ...image, rgba: image.rgba.map((value, at) => (at % 4 === 0 && image.rgba[at + 3]! > 0 ? (value + by) % 256 : value)) })

/** One store for the file: a still pixel pet, a smooth one, an animated sheet with a working row, and a folder with one picture for each state only an import brings. */
const shared = (() => {
  let made: Promise<{ store: PetStore; still: string; smooth: string; moving: string; full: string }> | undefined
  return () => made ??= (async () => {
    const store = petStore()
    const still = await store.importImage(pixel, { name: "Aiko" })
    const smooth = await store.importImage(smoothSample(), { name: "Smooth" })
    const moving = await store.importImage({ width: 256, height: 128, rgba: new Uint8Array([...blink.rgba, ...sheetOf([sampleSprite({ lift: 1 }), pixel, sampleSprite({ lift: 1 }), pixel]).rgba]) }, { name: "Blinker", frames: { columns: 4, rows: 2 }, ms: 200 })
    const folder = path.join(tempDir("mcev-q-states-"), "owl")
    mkdirSync(folder)
    for (const [name, image] of Object.entries({ idle: pixel, running: sampleSprite({ lift: 1 }), thinking: tinted(pixel, 40), compacting: tinted(pixel, 80), agents: tinted(pixel, 120), sleeping: sampleSprite({ eyes: "closed" }) })) writeFileSync(path.join(folder, `${name}.png`), encodeImagePng(image))
    const full = await store.importPath(folder, { name: "Owl" })
    return { store, still: still.ref, smooth: smooth.ref, moving: moving.ref, full: full.ref }
  })()
})()

describe("the start screen with a pet mascot", () => {
  const look = { logoKind: "both", homeMascot: "user:aiko" } as const
  const box = { cols: 30, rows: 15 }
  const cells = (cols: number, rows: number): Line[] => Array.from({ length: rows }, (): Line => [{ text: "▀".repeat(cols), fgHex: "#9c7ae8" }])
  const mascot = (shown: HomeMascotBox[] = [], asked: string[] = [], boxes = [box, { cols: 22, rows: 11 }]): HomeMascot => ({ pixel: { boxes, lines: (cols, rows) => { asked.push(`${cols}x${rows}`); return cells(cols, rows) } }, title: (row, width) => gradientSpans(row, width, "#22c55e", "#38bdf8"), shown: (at) => shown.push(at) })
  const home = (width: number, height: number, extra: Partial<Parameters<typeof renderHome>[0]> = {}) => {
    const shown: HomeMascotBox[] = []
    const asked: string[] = []
    const lines = renderHome({ width, height, screenHeight: height + 5, root: "~/code", look, mascot: mascot(shown, asked), ...extra })
    return { lines, shown, asked, rows: text(lines) }
  }
  const spriteRows = (lines: readonly Line[]) => lines.flatMap((line, row) => (line.some((span) => span.fgHex === "#9c7ae8") ? [row] : []))

  test("tall enough: the picture above the title, centered, the Agent View under them, and where it was drawn is reported", () => {
    const { lines, shown, asked, rows } = home(100, 26)
    expect(shown).toEqual([{ row: spriteRows(lines)[0]!, col: (100 - box.cols) / 2, ...box }])
    expect(asked).toEqual(["30x15"])
    expect(spriteRows(lines)).toHaveLength(box.rows)
    const title = rows.findIndex((row) => row.includes(TITLE))
    expect(title).toBe(shown[0]!.row + box.rows + 1)
    expect(rows[shown[0]!.row]!.search(/\S/)).toBe(shown[0]!.col)
    expect(rows.findIndex((row) => row.includes("No sessions yet"))).toBeGreaterThan(title + 2)
    expect(lines.length).toBeLessThanOrEqual(26)
  })

  test("a few rows shorter but wide: the picture at the left and the title beside it, at the column it reports", () => {
    const { lines, shown, rows } = home(124, 21)
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject(box)
    const title = rows.findIndex((row) => row.includes(TITLE))
    // The title is three rows high, centered against the picture's fifteen.
    expect(title).toBe(shown[0]!.row + Math.floor((box.rows - 3) / 2))
    expect(rows[title]!.indexOf(TITLE)).toBe(shown[0]!.col + box.cols + 4)
    expect(rows[shown[0]!.row]!.search(/\S/)).toBe(shown[0]!.col)
    expect(lines.length).toBeLessThanOrEqual(21)
  })

  test("too small for the wanted box: the next smaller one; too small for any: the ASCII Mend, then the plain name; never a row more than the home has", () => {
    // 19 rows at 88 columns: the 15-row box fits neither above the title nor (90 columns needed) beside it; the 11-row one does.
    const smaller = home(88, 19)
    expect(smaller.shown).toHaveLength(1)
    expect(smaller.shown[0]).toMatchObject({ cols: 22, rows: 11 })
    // Only the layout that was drawn asked for its rows.
    expect(smaller.asked).toEqual(["22x11"])
    const short = home(100, 15, { screenHeight: 30 })
    expect([short.shown, spriteRows(short.lines)]).toEqual([[], []])
    expect(short.rows.join("\n")).toContain("(o o)")
    // v1's compact density (at most 23 rows or 64 columns of terminal) never draws the picture.
    const compact = home(64, 40, { screenHeight: 45 })
    expect([compact.shown, spriteRows(compact.lines), compact.rows.some((row) => row.trim() === "MendCode")]).toEqual([[], [], true])
    expect(spriteRows(home(100, 18, { screenHeight: 23 }).lines)).toEqual([])
    const tiny = home(100, 12, { screenHeight: 17 })
    expect(tiny.shown).toEqual([])
    for (const height of [5, 8, 12, 16, 19, 22, 26, 40]) for (const width of [40, 64, 80, 92, 100, 140]) {
      const drawn = home(width, height)
      expect(drawn.lines.length).toBeLessThanOrEqual(height)
      for (const at of drawn.shown) expect(at.row + at.rows).toBeLessThanOrEqual(height)
      for (const line of drawn.lines) expect(lineWidth(line)).toBeLessThanOrEqual(width)
    }
  })

  test("the title beside or above the picture is tinted; alone it keeps the text color", () => {
    const tinted = home(100, 26).lines.find((line) => plain(line).includes(TITLE))!
    expect(tinted.some((span) => span.fgHex === "#22c55e")).toBe(true)
    const alone = renderHome({ width: 100, height: 26, root: "~/code", look: { logoKind: "wordmark", homeMascot: "user:aiko" }, mascot: mascot() }).find((line) => plain(line).includes(TITLE))!
    expect(alone.every((span) => span.fgHex === undefined)).toBe(true)
    const spans = gradientSpans("█".repeat(48), 48, "#22c55e", "#38bdf8")
    expect([spans.length, spans[0]!.fgHex, spans.at(-1)!.fgHex]).toEqual([8, "#22c55e", "#38bdf8"])
  })

  test("the Agent View still gets its rows under the picture, and gives way before the prompt would", () => {
    const sessions = Array.from({ length: 4 }, (_, index) => ({ id: `s${index}`, title: `session ${index}`, state: "working" as const, updatedAt: 0 }))
    const roomy = home(100, 40, { sessions, now: 1_000 })
    expect(roomy.shown).toHaveLength(1)
    expect(roomy.rows.join("\n")).toContain("session 3")
    const tight = home(100, 24, { sessions, now: 1_000 })
    expect(tight.lines.length).toBeLessThanOrEqual(24)
    expect(tight.rows.join("\n")).toContain("Agent View")
  })

  test("`logoKind: mascot` is the picture without the title; no picture from the terminal is the ASCII Mend it always was", () => {
    const only = home(80, 26, { look: { ...look, logoKind: "mascot" } })
    expect(only.shown).toHaveLength(1)
    expect(only.rows.some((row) => row.includes(TITLE))).toBe(false)
    const plainHome = (profile: object, given?: HomeMascot) => text(renderHome({ width: 100, height: 26, root: "~/code", look: profile, ...(given ? { mascot: given } : {}) }))
    expect(plainHome({ logoKind: "both", homeMascot: "user:aiko" }).join("\n")).toContain("(o o)")
    expect(plainHome({ logoKind: "both", homeMascot: "user:aiko" }, {})).toEqual(plainHome({ logoKind: "both", homeMascot: "mend" }))
    expect(plainHome({ logoKind: "wordmark" }, mascot())).toEqual(plainHome({ logoKind: "wordmark" }))
  })
})

describe("the pet system under the mascot", () => {
  test("an imported pet is listed by the loader with its layout, and its frames survive the cache with their timing", async () => {
    const { store, still, moving } = await shared()
    const { pets, skipped } = await listPets(store.pets().dirs)
    expect(skipped).toEqual([])
    expect(pets.map((pet) => pet.displayName).sort()).toEqual(["Aiko", "Blinker", "Owl", "Smooth"])
    const blinker = pets.find((pet) => pet.ref === moving)!
    expect(blinker.layout).toMatchObject({ art: "pixel", states: { idle: [[0, 200], [0, 200], [1, 200], [2, 200]] } })
    for (const pass of [1, 2]) {
      const sprite = await loadSprite({ pet: blinker, cacheDir: store.pets().cacheDir })
      expect([pass, [...sprite.rows.keys()], sprite.timing!.get("idle"), sprite.art]).toEqual([pass, ["idle", "running"], [200, 200, 200, 200], "pixel"])
      // Equal frames are one object: three pictures for eight frames.
      expect(new Set([...sprite.rows.values()].flat()).size).toBe(3)
      expect(sprite.rows.get("idle")![0]).toBe(sprite.rows.get("idle")![1]!)
      expect(spriteDurations(sprite, "idle")).toEqual([200, 200, 200, 200])
      // A state the pet does not have plays idle.
      expect(spriteDurations(sprite, "failed")).toEqual([200, 200, 200, 200])
    }
    // (The first use of the shared store builds the 512-pixel smooth sample; hence the longer limit below.)
    const aiko = await loadSprite({ pet: pets.find((pet) => pet.ref === still)!, cacheDir: store.pets().cacheDir })
    expect([spriteDurations(aiko, "idle"), spriteArt(aiko)]).toEqual([[], "pixel"])
    // The box follows the pet's own proportions inside the size's cells; a still pet stands three quarters of their height.
    const side = contentBox(pixel)!
    expect(spriteCells(aiko, 32, 16)).toEqual({ cols: Math.round(side.width * 24 / side.height), rows: 12 })
  }, 30_000)

  test("the start screen and the prompt's pet loading one pet at once, before its cache exists, both get its frames", async () => {
    // A sheet the size of a real imported one (six columns of 350-pixel cells): decoding and caching it takes long enough for the loads to overlap.
    const store = petStore()
    const [width, height] = [2100, 700]
    const rgba = new Uint8Array(width * height * 4)
    for (let at = 0; at < rgba.length; at += 4) { rgba[at] = (at * 7) % 251; rgba[at + 1] = (at * 13) % 241; rgba[at + 2] = (at * 3) % 239; rgba[at + 3] = 255 }
    const large = await store.importImage({ width, height, rgba }, { name: "Rook", frames: { columns: 6, rows: 2 } })
    const pet = (await listPets(store.pets().dirs)).pets.find((entry) => entry.ref === large.ref)!
    const cacheDir = tempDir("mcev-q-race-cache-")
    const loads = await Promise.allSettled([loadSprite({ pet, cacheDir }), loadSprite({ pet, cacheDir }), loadSprite({ pet, cacheDir })])
    expect(loads.map((load) => load.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"])
  }, 30_000)

  test("a pet whose layout is damaged is skipped with the reason, not drawn wrong", async () => {
    const store = petStore()
    const made = await store.importImage(pixel, { name: "Broken" })
    const file = path.join(store.dir, "pets", made.petId, "pet.json")
    const manifest = JSON.parse(await Bun.file(file).text())
    writeFileSync(file, JSON.stringify({ ...manifest, layout: { ...manifest.layout, states: {} } }))
    expect(await listPets(store.pets().dirs)).toEqual({ pets: [], skipped: [{ dir: path.dirname(file), reason: "imported pet without a usable layout" }] })
  })

  test("the controller: a row of one frame has no frame timer and no greeting to play; a pet's own timing replaces the Codex one", () => {
    const time = clock()
    let times: readonly number[] | undefined = []
    const controller = createPetController({ now: time.now, animate: () => true, onChange() {}, durations: () => times, setTimer: time.setTimer, clearTimer: time.clearTimer })
    controller.sync()
    controller.cheer("waving")
    expect([time.pending, controller.armed, controller.current()]).toEqual([[], false, { row: "idle", index: 0 }])
    times = [300, 50]
    controller.sync()
    expect(time.pending).toEqual([300])
    time.advance(300)
    expect([controller.current().index, time.pending]).toEqual([1, [50]])
    time.advance(50)
    expect(controller.current().index).toBe(0)
    times = undefined
    controller.sync()
    expect(time.pending).toEqual([PET_FRAME_DURATIONS.idle[0]])
    controller.stop()
    expect(time.pending).toEqual([])
  })

  test("the prompt's pet shows each state a pet brings on its signal; a pet without them shows running, or idle, as before", async () => {
    const { store, full, moving } = await shared()
    const steps = {
      idle: ["idle", {}], running: ["generating", { current: { kind: "agent_message" } }], thinking: ["generating", { current: { kind: "reasoning" } }],
      compacting: ["compacting", {}], task: ["tool", { current: { kind: "tool_call", tool: "task" } }], agents: ["idle", { agents: true }],
    } as const
    const frames = async (ref: string) => {
      const slot = createPetSlot({ ...store.pets(), now: () => 0, reducedMotion: () => true, onChange() {}, say() {} })
      await slot.choose(ref)
      const out: Record<string, string> = {}
      for (const [name, [state, signals]] of Object.entries(steps)) {
        slot.setForeground(state, signals)
        out[name] = JSON.stringify(slot.draw()!.lines)
      }
      slot.stop()
      return out
    }
    const owl = await frames(full)
    expect(new Set([owl.idle, owl.running, owl.thinking, owl.compacting, owl.agents]).size).toBe(5)
    expect(owl.task).toBe(owl.agents)
    const sprite = await loadSprite({ pet: (await listPets(store.pets().dirs)).pets.find((item) => item.ref === full)!, cacheDir: store.pets().cacheDir })
    expect([...sprite.rows.keys()]).toEqual(["idle", "running", "thinking", "compacting", "agents", "sleeping"])
    for (const row of ["thinking", "compacting", "agents", "sleeping"] as const) expect(spriteFrames(sprite, row)).toEqual({ frames: sprite.rows.get(row)!, row })
    // The sheet import has idle and running only: every new state is one of those two pictures, the very frames it had.
    const blinker = await frames(moving)
    expect([blinker.thinking, blinker.compacting, blinker.task, blinker.agents]).toEqual([blinker.running, blinker.running, blinker.running, blinker.running])
    const old = await loadSprite({ pet: (await listPets(store.pets().dirs)).pets.find((item) => item.ref === moving)!, cacheDir: store.pets().cacheDir })
    expect([...old.rows.keys()]).toEqual(["idle", "running"])
    expect(old.rows.get("running")![0]).not.toEqual(old.rows.get("idle")![0]!)
    for (const row of ["thinking", "compacting", "agents"] as const) expect(spriteFrames(old, row)).toEqual({ frames: old.rows.get("running")!, row: "running" })
    expect(spriteFrames(old, "sleeping")).toEqual({ frames: old.rows.get("idle")!, row: "idle" })
    expect(spriteDurations(old, "thinking")).toEqual(spriteDurations(old, "running")!)
    // A still has neither: agents falls back to running, then to idle.
    const still = { id: "still", rows: new Map([["idle", old.rows.get("idle")!.slice(0, 1)]]) } as never
    expect(spriteFrames(still, "agents").row).toBe("idle")
  })

  test("the prompt's pet draws an imported pet with the filter of its art, at the box's real pixels for a graphics terminal", async () => {
    const { store, smooth } = await shared()
    const slot = createPetSlot({ ...store.pets(), now: () => 0, reducedMotion: () => true, onChange() {}, say() {} })
    await slot.choose(smooth)
    const drawn = slot.draw({ cols: 16, rows: 8 }, { width: 10, height: 20 })!
    expect([drawn.lines.length, drawn.image!.image.width, drawn.image!.image.height]).toEqual([8, 160, 160])
    for (const line of drawn.lines) expect(lineWidth(line)).toBe(16)
    // Soft edges are kept for the image layer: some pixels are partly transparent.
    expect(drawn.image!.image.rgba.some((value, at) => at % 4 === 3 && value > 20 && value < 235)).toBe(true)
    slot.stop()
    const choices = await petChoices(store.pets())
    const choice = choices.find((item) => item.pet.ref === smooth)!
    // The preview is the pet's cells of the 32x16 box at their nominal pixels, 8 x 16 a cell.
    expect([choice.preview!.length, choice.image!.width, choice.cells, choice.states]).toEqual([12, choice.cells!.cols * 8, { cols: choice.cells!.cols, rows: 12 }, ["idle"]])
  })

  test("scaled frames for the image layer are bounded: the least recently used goes first", () => {
    const cache = createFrameCache(1_000)
    let made = 0
    const frame = () => { made++; return { width: 10, height: 10, rgba: new Uint8Array(400) } }
    cache.get("a", frame)
    cache.get("b", frame)
    cache.get("a", frame)
    expect([made, cache.bytes]).toEqual([2, 800])
    cache.get("c", frame)
    expect(cache.bytes).toBe(800)
    cache.get("a", frame)
    expect(made).toBe(3)
    cache.get("b", frame)
    expect(made).toBe(4)
  })
})

describe("the start-screen pet", () => {
  const pet = async (ref: string, flags: { moving: boolean }) => {
    const { store } = await shared()
    const time = clock()
    let changes = 0
    const made = createHomePet({ ...store.pets(), now: time.now, moving: () => flags.moving, onChange: () => { changes++ }, setTimer: time.setTimer, clearTimer: time.clearTimer })
    await made.choose(ref)
    return { made, time, changes: () => changes }
  }

  test("a still picture never holds a timer, moving or not: one frame cannot blink, and no bob is invented for it", async () => {
    const { still } = await shared()
    const flags = { moving: true }
    const { made, time } = await pet(still, flags)
    expect(made.ready).toBe(true)
    made.sync()
    made.setWorking(true)
    made.setWorking(false)
    // The moment after work ends (`review`) is a passing row with one timer to end it; the picture itself does not change.
    expect(time.pending).toHaveLength(1)
    const before = made.lines(30, 15)
    time.advance(10_000)
    expect([time.pending, made.armed]).toEqual([[], false])
    expect(made.lines(30, 15)).toBe(before)
  })

  test("a sheet animates with its own frame times; working plays the working row; standing still drops every timer at once", async () => {
    const { moving } = await shared()
    const flags = { moving: false }
    const { made, time } = await pet(moving, flags)
    made.sync()
    expect([time.pending, made.armed]).toEqual([[], false])
    const rest = made.lines(30, 15)
    flags.moving = true
    made.sync()
    expect(time.pending).toEqual([200])
    time.advance(400)
    const closed = made.lines(30, 15)
    expect(closed).not.toBe(rest)
    expect(JSON.stringify(closed)).not.toBe(JSON.stringify(rest))
    made.setWorking(true)
    expect(time.pending).toEqual([200])
    expect(JSON.stringify(made.lines(30, 15))).not.toBe(JSON.stringify(rest))
    made.setWorking(false)
    // Stopping mid-move, with the `review` moment pending: nothing waits, and the first idle frame shows.
    flags.moving = false
    made.sync()
    expect([time.pending, made.armed]).toEqual([[], false])
    expect(made.lines(30, 15)).toBe(rest)
    time.advance(60_000)
    expect(time.pending).toEqual([])
    made.stop()
  })

  test("a pet with the rows: agents while the Agent View lists work, sleeping after five idle minutes, and standing still drops that wait too", async () => {
    const { full } = await shared()
    const flags = { moving: true }
    const { made, time } = await pet(full, flags)
    const shown = () => JSON.stringify(made.lines(30, 15))
    made.sync()
    // Single pictures: nothing to animate, and the one timer is the wait for sleep.
    expect(time.pending).toEqual([SLEEP_MS])
    const rest = shown()
    made.setWorking(true)
    const agents = shown()
    expect([agents === rest, time.pending]).toEqual([false, []])
    made.setWorking(false)
    expect(time.pending).toEqual([REVIEW_MS])
    time.advance(REVIEW_MS)
    expect([shown() === rest, time.pending]).toEqual([true, [SLEEP_MS - REVIEW_MS]])
    time.advance(SLEEP_MS)
    const asleep = shown()
    expect([asleep === rest, asleep === agents, time.pending, made.armed]).toEqual([false, false, [], false])
    // Work wakes it.
    made.setWorking(true)
    expect(shown()).toBe(agents)
    made.setWorking(false)
    time.advance(REVIEW_MS)
    expect(time.pending).toHaveLength(1)
    flags.moving = false
    made.sync()
    expect([time.pending, made.armed, shown() === rest]).toEqual([[], false, true])
    time.advance(2 * SLEEP_MS)
    expect([time.pending, shown() === rest]).toEqual([[], true])
    made.stop()
  })

  test("the boxes: the wanted size first, then the smaller ones, each as wide as the pet's proportions need", async () => {
    const { smooth } = await shared()
    const { made } = await pet(smooth, { moving: false })
    const large = made.boxes("large")
    expect(large).toHaveLength(3)
    expect(large.map((box) => box.rows)).toEqual([17, 12, 9])
    for (const [index, name] of (["large", "medium", "small"] as const).entries()) expect(large[index]!.cols).toBeLessThanOrEqual(HOME_PET_SIZES[name].cols)
    expect(made.boxes("small")).toEqual([large[2]!])
    for (const box of large) {
      const lines = made.lines(box.cols, box.rows)
      expect(lines).toHaveLength(box.rows)
      for (const line of lines) expect(lineWidth(line)).toBe(box.cols)
    }
  })

  test("for the image layer: the box's exact pixels, soft alpha, the same picture reused, and a bound on very dense displays", async () => {
    const { smooth, still } = await shared()
    const { made } = await pet(smooth, { moving: false })
    const box = made.boxes("medium")[0]!
    const first = made.image(box.cols, box.rows, { width: 10, height: 20 })!
    expect([first.image.width, first.image.height]).toEqual([box.cols * 10, box.rows * 20])
    expect(first.image.rgba.some((value, at) => at % 4 === 3 && value > 20 && value < 235)).toBe(true)
    expect(made.image(box.cols, box.rows, { width: 10, height: 20 })!.image).toBe(first.image)
    expect(made.image(box.cols, box.rows, { width: 12, height: 24 })!.key).not.toBe(first.key)
    const dense = made.image(44, 22, { width: 40, height: 80 })!
    expect(Math.max(dense.image.width, dense.image.height)).toBeLessThanOrEqual(1024)
    expect(dense.image.width / dense.image.height).toBe(1)
    // Pixel art is never blended on the way up: only its own colors, with hard edges.
    const sprite = await pet(still, { moving: false })
    const up = sprite.made.image(30, 16, { width: 10, height: 20 })!.image
    expect(up.rgba.every((value, at) => at % 4 !== 3 || value === 0 || value === 255)).toBe(true)
  }, 30_000)

  test("a pet that is not installed is reported missing, not drawn", async () => {
    const { made } = await pet("user:nobody", { moving: true })
    expect([made.ready, made.missing, made.boxes("medium"), made.lines(10, 5), made.image(10, 5, { width: 8, height: 16 })]).toEqual([false, true, [], [], undefined])
  })
})

describe("the terminal's side of the mascot", () => {
  /** The controller over the least state it reads; `frame` plays one render that draws the home or not. */
  async function controller(profile: Partial<TuiProfile> = {}, settings: object = { tier: "full" }, options: { ascii?: boolean; protocol?: string; pets?: boolean } = {}) {
    const { store, moving } = await shared()
    const focus = createTerminalFocus()
    const state = { tuiProfile: { ...DEFAULT_TUI_PROFILE, logoKind: "both", homeMascot: moving, ...profile } as TuiProfile, mode: "full", accessible: false, reducedMotion: false, settingsNow: settings, imageCellPixels: undefined as { width: number; height: number } | undefined }
    const screen = { focus, imageProtocol: options.protocol }
    let frames = 0
    const made = createHomeMascot({ state, input: { screen, ...(options.pets === false ? {} : { pets: store.pets() }) }, requestFrame: () => { frames++ }, now: () => Date.now() } as never, { working: () => false, ascii: () => options.ascii === true })
    const frame = async (home = true) => {
      made.frame()
      const art = home ? made.art() : undefined
      const box = art?.pixel?.boxes[0]
      if (box) art!.shown?.({ row: 3, col: 10, ...box })
      await Bun.sleep(0)
      return art
    }
    const loaded = async () => {
      for (let turn = 0; turn < 6; turn++) { await frame(); await Bun.sleep(15) }
    }
    return { made, state, screen, focus, frame, loaded, frames: () => frames }
  }

  test("the pet system loads on the first frame that wants a pet; that frame keeps the pet's place blank, not the ASCII Mend", async () => {
    const c = await controller()
    const first = await c.frame()
    // The wanted box (medium) and the smaller ones, every cell blank: the picture arrives into this place instead of replacing another mascot.
    expect(first!.pixel!.boxes).toEqual([{ cols: 32, rows: 16 }, { cols: 24, rows: 12 }])
    expect(first!.pixel!.lines(32, 16).map((line) => line.map((span) => span.text).join(""))).toEqual(Array.from({ length: 16 }, () => " ".repeat(32)))
    expect(c.made.drawn).toBe(true)
    expect(c.made.animating).toBe(false)
    await c.loaded()
    expect(c.frames()).toBeGreaterThan(0)
    const art = await c.frame()
    expect(art!.pixel!.boxes[0]!.rows).toBe(12)
    expect(art!.pixel!.lines(art!.pixel!.boxes[0]!.cols, 16)).toHaveLength(16)
    expect(c.made.animating).toBe(true)
  })

  test("a frame that does not draw it stops the timer; drawing it again starts it", async () => {
    const c = await controller()
    await c.loaded()
    expect(c.made.animating).toBe(true)
    await c.frame(false)
    expect(c.made.animating).toBe(false)
    expect(c.made.placement(2)).toEqual([])
    await c.frame()
    expect(c.made.animating).toBe(true)
  })

  test("no timer when the terminal says it lost focus, under reduced motion, or with motion off", async () => {
    const c = await controller()
    await c.loaded()
    c.focus.set("unfocused")
    expect(c.made.animating).toBe(false)
    c.focus.set("focused")
    expect(c.made.animating).toBe(true)
    c.state.reducedMotion = true
    await c.frame()
    expect(c.made.animating).toBe(false)
    expect((await c.frame())!.pixel).toBeDefined()
    c.state.reducedMotion = false
    c.state.tuiProfile = { ...c.state.tuiProfile, mascotMotion: false }
    await c.frame()
    expect(c.made.animating).toBe(false)
  })

  test("it is the full tier's: below it, in the minimal view, for a screen reader, without a pet store or with `mend`, nothing is asked for and nothing loads", async () => {
    for (const c of [await controller({}, { tier: "balanced" }), await controller({}, { tier: "minimalist" }), await controller({ logoKind: "wordmark" }), await controller({}, { tier: "full" }, { pets: false })]) {
      expect(c.made.wanted()).toBe(false)
      expect(await c.frame()).toBeUndefined()
      await Bun.sleep(5)
      expect(c.frames()).toBe(0)
    }
    // `mend` is the built-in colored Mend: drawn in half blocks at once, with no pet system, no picture and no timer.
    const mend = await controller({ homeMascot: "mend" })
    expect(mend.made.wanted()).toBe(false)
    const drawn = (await mend.frame())!
    expect(drawn.pixel!.lines(26, 12)).toEqual(mendSpriteLines("idle", 2))
    await Bun.sleep(5)
    expect(mend.frames()).toBe(0)
    expect(mend.made.animating).toBe(false)
    const reader = await controller()
    reader.state.accessible = true
    expect(reader.made.wanted()).toBe(false)
    const minimal = await controller()
    minimal.state.mode = "minimal"
    expect(minimal.made.wanted()).toBe(false)
    expect((await controller({}, { tier: "balanced", features: { pets: true } })).made.wanted()).toBe(true)
    expect([isPetMascot("mend"), isPetMascot("mendy"), isPetMascot("user:a"), isPetMascot("codex:greenie"), isPetMascot("package:x")]).toEqual([false, false, true, true, true])
  })

  test("while it loads: ASCII glyphs keep the ASCII Mend from the first frame, and a pet that turns out not installed gives its place back to it", async () => {
    const ascii = await controller({}, { tier: "full" }, { ascii: true })
    expect(await ascii.frame()).toEqual({})
    const gone = await controller({ homeMascot: "user:not-installed" })
    expect((await gone.frame())!.pixel!.boxes[0]).toEqual({ cols: 32, rows: 16 })
    await gone.loaded()
    expect(await gone.frame()).toBeUndefined()
    expect(gone.made.missing).toBe(true)
  })

  test("16 colors and ASCII glyphs get no picture: the home keeps its ASCII mascot, and nothing animates", async () => {
    const ascii = await controller({}, { tier: "full" }, { ascii: true })
    await ascii.loaded()
    expect(await ascii.frame()).toEqual({})
    expect(ascii.made.animating).toBe(false)
    setTheme("terminal")
    const c = await controller()
    await c.loaded()
    expect(await c.frame()).toEqual({})
    setTheme("mend")
    expect((await c.frame())!.pixel).toBeDefined()
  })

  test("with an image protocol the home gets blank cells and the layer gets the picture; kitty animates, iTerm2 and sixel hold one frame", async () => {
    const kitty = await controller({}, { tier: "full" }, { protocol: "kitty" })
    kitty.state.imageCellPixels = { width: 9, height: 18 }
    await kitty.loaded()
    const art = (await kitty.frame())!
    const box = art.pixel!.boxes[0]!
    expect(art.pixel!.lines(box.cols, box.rows)).toEqual(Array.from({ length: box.rows }, () => [{ text: " ".repeat(box.cols) }]))
    const [placed] = kitty.made.placement(2)
    expect(placed).toMatchObject({ slot: "home-pet", row: 2 + 3, col: 10, cols: box.cols, rows: box.rows })
    expect([placed!.image.width, placed!.image.height]).toEqual([box.cols * 9, box.rows * 18])
    expect(kitty.made.animating).toBe(true)
    for (const protocol of ["iterm2", "sixel"]) {
      const held = await controller({}, { tier: "full" }, { protocol })
      await held.loaded()
      expect(held.made.placement(0)).toHaveLength(1)
      expect(held.made.animating).toBe(false)
    }
    const off = await controller({}, { tier: "full" }, { protocol: "off" })
    await off.loaded()
    const blocks = (await off.frame())!
    expect(hasHalfBlocks(blocks.pixel!.lines(blocks.pixel!.boxes[0]!.cols, 16) as Line[])).toBe(true)
    expect(off.made.placement(0)).toEqual([])
  })

  test("a pet shown earlier in the run, then Mend chosen: Mend's own picture at a pet's size, not the old pet's, no timer", async () => {
    const c = await controller({}, { tier: "full" }, { protocol: "kitty" })
    c.state.imageCellPixels = { width: 9, height: 18 }
    await c.loaded()
    expect(c.made.placement(2)).toHaveLength(1)
    c.state.tuiProfile = { ...c.state.tuiProfile, homeMascot: "mend" }
    await c.loaded()
    const art = (await c.frame())!
    const box = art.pixel!.boxes[0]!
    // The medium mascot box, 32x16: Mend at rest stands three quarters of it, as a pet does, over blank cells.
    expect(box).toEqual({ cols: 22, rows: 12 })
    expect(hasHalfBlocks(art.pixel!.lines(box.cols, box.rows) as Line[])).toBe(false)
    expect(c.made.drawn).toBe(true)
    const placed = c.made.placement(2)
    expect(placed.map((at) => [at.key.split("/")[0], at.cols, at.rows, at.image.width, at.image.height])).toEqual([["mend", 22, 12, 22 * 9, 12 * 18]])
    expect(c.made.animating).toBe(false)
  })
})

describe("a pet mascot in the app", () => {
  const prompt = (rows: string[]) => rows.findIndex((row) => row.includes("❭"))

  test("by default, in every tier, the start screen is the title alone and nothing animates or loads", async () => {
    for (const tier of ["minimalist", "balanced", "full"]) {
      const { h, frame } = await mascotScene({ store: petStore(), settings: { tier } })
      expect(hasHalfBlocks(frame())).toBe(false)
      expect(h.text().join("\n")).not.toContain("(o o)")
      expect(h.app.mascotAnimating).toBe(false)
    }
  })

  test("chosen in the full tier: the picture is on the start screen in half blocks, the prompt keeps its place, a sheet animates and a still does not", async () => {
    const { store, moving, still } = await shared()
    const without = await mascotScene({ store, profile: { logoKind: "wordmark" } })
    const scene = await mascotScene({ store, ref: moving })
    expect(hasHalfBlocks(scene.frame())).toBe(true)
    expect(scene.placement()).toBeUndefined()
    expect(scene.h.app.mascotAnimating).toBe(true)
    expect(prompt(scene.h.text())).toBe(prompt(without.h.text()))
    expect(scene.frame().length).toBe(without.frame().length)
    const quiet = await mascotScene({ store, ref: still })
    expect(hasHalfBlocks(quiet.frame())).toBe(true)
    expect(quiet.h.app.mascotAnimating).toBe(false)
  })

  test("at every size and height the prompt stays where it is without a mascot", async () => {
    const { store, smooth } = await shared()
    const seen = new Set<string>()
    for (const mascotSize of ["small", "medium", "large"] as const) for (const height of [24, 28, 32, 40]) {
      const without = await mascotScene({ store, profile: { logoKind: "wordmark" }, height })
      const scene = await mascotScene({ store, ref: smooth, profile: { mascotSize }, height })
      expect([mascotSize, height, prompt(scene.h.text())]).toEqual([mascotSize, height, prompt(without.h.text())])
      seen.add(`${mascotSize}/${height}/${hasHalfBlocks(scene.frame())}`)
    }
    // A large box needs a tall terminal; at 40 rows all three sizes show, at 24 only a smaller box beside the title.
    expect(["small/40/true", "medium/40/true", "large/40/true", "large/24/true"].every((key) => seen.has(key))).toBe(true)
  })

  test("a terminal with the kitty protocol gets the picture through the image layer at the box's real pixels, and blank cells under it", async () => {
    const { store, smooth, moving } = await shared()
    const scene = await mascotScene({ store, ref: smooth, graphics: { env: { TERM_PROGRAM: "ghostty" }, cell: { width: 10, height: 20 } } })
    const placed = scene.placement()!
    expect(placed.rows).toBe(12)
    // The tinted title is block glyphs too; the picture's own rows carry none.
    expect(hasHalfBlocks(scene.frame().slice(placed.row, placed.row + placed.rows))).toBe(false)
    expect([placed.image.width, placed.image.height]).toEqual([placed.cols * 10, placed.rows * 20])
    for (let row = placed.row; row < placed.row + placed.rows; row++) expect(plain(scene.frame()[row]!).slice(placed.col, placed.col + placed.cols).trim()).toBe("")
    expect(plain(scene.frame()[placed.row + placed.rows + 1]!)).toContain(TITLE)
    expect((await mascotScene({ store, ref: moving, graphics: { env: { TERM_PROGRAM: "ghostty" } } })).h.app.mascotAnimating).toBe(true)
    // 256 colors (no truecolor) and tmux fall back to half blocks, by the detection the prompt's pet uses.
    for (const env of [{ COLORTERM: "" }, { TMUX: "/tmp/tmux-1/default,1,0" }]) {
      const fallback = await mascotScene({ store, ref: smooth, graphics: { env: { TERM_PROGRAM: "ghostty", ...env } } })
      expect([fallback.placement(), hasHalfBlocks(fallback.frame())]).toEqual([undefined, true])
    }
    // iTerm2's protocol shows the picture and holds it still.
    const iterm = await mascotScene({ store, ref: moving, graphics: { env: { TERM_PROGRAM: "iTerm.app" } } })
    expect([iterm.placement() !== undefined, iterm.h.app.mascotAnimating]).toEqual([true, false])
  })

  test("another page, reduced motion, motion off: no timer; below the full tier, ASCII glyphs and 16 colors: the ASCII Mend", async () => {
    const { store, moving } = await shared()
    const scene = await mascotScene({ store, ref: moving })
    await scene.h.type("/help\r")
    await Bun.sleep(0)
    expect([hasHalfBlocks(scene.frame()), scene.h.app.mascotAnimating]).toEqual([false, false])
    for (const [settings, profile] of [[{ reducedMotion: true }, {}], [{}, { mascotMotion: false }]] as const) {
      const still = await mascotScene({ store, ref: moving, settings, profile })
      expect([hasHalfBlocks(still.frame()), still.h.app.mascotAnimating]).toEqual([true, false])
    }
    for (const input of [{ settings: { tier: "balanced" } }, { env: { MENDCODE_GLYPHS: "ascii" } }]) {
      const fallback = await mascotScene({ store, ref: moving, ...input })
      expect([hasHalfBlocks(fallback.frame()), fallback.h.app.mascotAnimating]).toEqual([false, false])
      expect(fallback.h.text().join("\n")).toContain("(o o)")
    }
    setTheme("terminal")
    const sixteen = await mascotScene({ store, ref: moving })
    setTheme("mend")
    expect(hasHalfBlocks(sixteen.frame())).toBe(false)
    expect(sixteen.h.text().join("\n")).toContain("(o o)")
  })

  test("/pet import adds a pet from a PNG without an image call; it is in /pet and in /mascot, and /mascot <name> puts it on the start screen", async () => {
    const store = petStore()
    const source = path.join(tempDir("mcev-q-art-"), "my girl.png")
    writeFileSync(source, encodeImagePng(onBackground(pixel, [255, 0, 255])))
    const { h } = await mascotScene({ store })
    await h.type(`/pet import "${source}" --name Aiko\r`)
    await Bun.sleep(40)
    h.app.render()
    expect(h.sentOf("pet.manage").at(-1)).toMatchObject({ input: { action: "import", path: source, name: "Aiko" } })
    expect(store.imageCalls).toBe(0)
    const page = h.text().join("\n")
    expect(page).toContain("Aiko")
    expect(page).toMatch(/ MendAscii {3,}/)
    expect(page).toContain("Pet Aiko imported · still · pixel art")
    expect(page).toContain("/mascot Aiko for the start screen")
    expect(hasHalfBlocks(h.frames.at(-1)!)).toBe(true)
    const [pet] = (await listPets(store.pets().dirs)).pets
    await h.type("\x1b")
    await h.type("/mascot\r")
    await Bun.sleep(40)
    h.app.render()
    const list = h.text().join("\n")
    expect(list).toContain("Mascot")
    expect(list).toMatch(/ MendAscii {3,}/)
    expect(list).toContain("Aiko")
    expect(list).toContain("o title only")
    await h.type("\x1b")
    await h.type("/mascot aiko\r")
    await Bun.sleep(20)
    expect(readTuiProfile(store.dir)).toMatchObject({ logoKind: "both", homeMascot: pet!.ref })
    for (let turn = 0; turn < 6; turn++) { h.app.render(); await Bun.sleep(15) }
    h.app.render()
    expect(hasHalfBlocks(h.frames.at(-1)!)).toBe(true)
    // The same name again is refused by the daemon, and said.
    await h.type(`/pet import "${source}" --name Aiko\r`)
    await Bun.sleep(30)
    h.app.render()
    expect(h.text().join("\n")).toContain('A pet named "Aiko" exists')
    // Deleting the pet that is the mascot gives the start screen its ASCII Mend back.
    await h.type(`/pet delete ${pet!.ref} --confirm\r`)
    await Bun.sleep(30)
    expect(readTuiProfile(store.dir).homeMascot).toBe("mend")
  })

  test("the picker opened by /mascot sets the start screen's mascot, and `o` the title alone", async () => {
    const { store, still } = await shared()
    const { h } = await mascotScene({ store })
    await h.type("/mascot\r")
    await Bun.sleep(60)
    h.app.render()
    const rows = h.text()
    const at = rows.findIndex((row) => row.includes("Aiko"))
    const top = rows.findIndex((row) => / MendAscii {3,}/.test(row))
    for (let step = 0; step < at - top; step++) await h.type("\x1b[B")
    await h.type("\r")
    expect(readTuiProfile(store.dir)).toMatchObject({ logoKind: "both", homeMascot: still, pet: "" })
    await h.type("/mascot\r")
    await Bun.sleep(60)
    await h.type("o")
    expect(readTuiProfile(store.dir)).toMatchObject({ logoKind: "wordmark", homeMascot: still })
  })

  test("/mascot: a pet by name, id or reference, mend, off, motion and size; an unknown name and a lower tier say what to do", async () => {
    const { store, still, moving } = await shared()
    const { h } = await mascotScene({ store })
    const profile = () => readTuiProfile(store.dir)
    await h.type("/mascot Blinker\r")
    await Bun.sleep(20)
    expect(profile()).toMatchObject({ logoKind: "both", homeMascot: moving, mascotMotion: true, mascotSize: "medium" })
    await h.type(`/mascot ${still}\r`)
    await Bun.sleep(20)
    expect(profile().homeMascot).toBe(still)
    await h.type(`/mascot ${moving.slice("user:".length)}\r`)
    await Bun.sleep(20)
    expect(profile().homeMascot).toBe(moving)
    await h.type("/mascot static\r")
    expect(profile().mascotMotion).toBe(false)
    await h.type("/mascot animated\r")
    expect(profile().mascotMotion).toBe(true)
    await h.type("/mascot large\r")
    expect(profile().mascotSize).toBe("large")
    await h.type("/mascot small\r")
    expect(profile().mascotSize).toBe("small")
    await h.type("/mascot mend\r")
    expect(profile()).toMatchObject({ logoKind: "both", homeMascot: "mend" })
    await h.type("/mascot off\r")
    expect(profile().logoKind).toBe("wordmark")
    await h.type("/mascot dragon\r")
    await Bun.sleep(20)
    h.app.render()
    expect(h.text().join("\n")).toContain("no pet named dragon")
    expect(profile().homeMascot).toBe("mend")
    const lower = petStore()
    const balanced = await mascotScene({ store: lower, settings: { tier: "balanced" } })
    await balanced.h.type("/mascot Blinker\r")
    expect(readTuiProfile(lower.dir).homeMascot).toBe("mend")
    expect(balanced.h.text().join("\n")).toContain("A pet mascot needs full tier")
    await balanced.h.type("/mascot\r")
    expect(balanced.h.text().join("\n")).toContain("usage: /mascot mend|off")
  })

  test("a profile that still says `mendy` loads, shows the ASCII Mend, and /mascot mendy says the sprite was retired", async () => {
    const store = petStore()
    writeTuiProfile(store.dir, { ...DEFAULT_TUI_PROFILE, logoKind: "both" })
    // The file as the removed sprite's profile had it.
    const file = tuiProfilePath(store.dir)
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), homeMascot: "mendy" }))
    expect(readFileSync(file, "utf8")).toContain('"mendy"')
    expect(readTuiProfile(store.dir)).toMatchObject({ logoKind: "both", homeMascot: "mend" })
    const { h, frame } = await mascotScene({ store, profile: "saved" })
    // `mendy` reads as `mend`: the built-in colored Mend, which never moves.
    expect([1, 2, 3].some((scale) => mendRowIn(frame(), "idle", scale) >= 0)).toBe(true)
    expect(h.app.mascotAnimating).toBe(false)
    await h.type("/mascot off\r")
    await h.type("/mascot mendy\r")
    expect(readTuiProfile(store.dir)).toMatchObject({ logoKind: "both", homeMascot: "mend" })
    expect(h.text().join("\n")).toContain("Mendy was retired")
  })
})

describe("the session pet's size", () => {
  const slotOf = async (store: PetStore, ref: string) => {
    const slot = createPetSlot({ ...store.pets(), now: () => 0, reducedMotion: () => true, onChange() {}, say() {} })
    await slot.choose(ref)
    return slot
  }
  /** The rows of the last frame that carry half blocks, and the widest run of them. */
  const petRows = (lines: readonly Line[]) => lines.filter((line) => line.some((span) => span.fgHex !== undefined && /[▀▄]/.test(span.text)))

  test("the key: small by default, a bad value reads as small, and the Pet size row sits under Pet and cycles", () => {
    expect(DEFAULT_TUI_PROFILE.petSize).toBe("small")
    expect(TUI_DEFAULTS).toMatchObject({ petSize: "small" })
    expect(TUI_ENUMS.petSize).toEqual(["small", "medium", "large"])
    expect(normalizeTuiProfile({ petSize: "huge" }).petSize).toBe("small")
    expect(normalizeTuiProfile({ petSize: "medium" }).petSize).toBe("medium")
    expect(tuiProblems({ petSize: "large" })).toEqual([])
    expect(tuiProblems({ petSize: "huge" })).toEqual(["petSize: expected small|medium|large"])
    const at = (row: string) => CUSTOMIZE_ROWS.indexOf(row as never)
    expect(at("petSize")).toBe(at("pet") + 1)
    expect(customizePageKey({ row: at("petSize") }, "\x1b[C", DEFAULT_TUI_PROFILE).action).toEqual({ type: "set", patch: { petSize: "medium" } })
    expect(customizePageKey({ row: at("petSize") }, "\x1b[D", DEFAULT_TUI_PROFILE).action).toEqual({ type: "set", patch: { petSize: "large" } })
  })

  test("the boxes: 10x5 (the default), 16x8 and 24x12 cells; half blocks 15x8, 24x13, 36x20", async () => {
    expect(PET_SIZES).toEqual({ small: { cols: 10, rows: 5 }, medium: { cols: 16, rows: 8 }, large: { cols: 24, rows: 12 } })
    expect(PET_HALF_BLOCK_SIZES).toEqual({ small: { cols: 15, rows: 8 }, medium: { cols: 24, rows: 13 }, large: { cols: 36, rows: 20 } })
    expect(PET_BOX).toEqual({ cols: 10, rows: 5 })
    // A still square pet stands three quarters of each box's height, as every pet does at rest.
    const { store, still } = await shared()
    const slot = await slotOf(store, still)
    expect((["small", "medium", "large"] as const).map((size) => slot.box(size, false))).toEqual([{ cols: 8, rows: 4 }, { cols: 12, rows: 6 }, { cols: 18, rows: 9 }])
    expect((["small", "medium", "large"] as const).map((size) => slot.box(size, true))).toEqual([{ cols: 12, rows: 6 }, { cols: 20, rows: 10 }, { cols: 30, rows: 15 }])
    for (const size of ["small", "medium", "large"] as const) for (const halfBlocks of [false, true]) {
      const box = slot.box(size, halfBlocks)
      const drawn = slot.draw(box)!
      expect([drawn.cols, drawn.rows, drawn.lines.length]).toEqual([box.cols, box.rows, box.rows])
      for (const line of drawn.lines) expect(lineWidth(line)).toBe(box.cols)
    }
    slot.stop()
  })

  test("a pet that is not square takes only the part of the box its proportions need", async () => {
    const store = petStore()
    const solid = (width: number, height: number) => ({ width, height, rgba: new Uint8Array(width * height * 4).fill(255) })
    const tall = await slotOf(store, (await store.importImage(solid(16, 48), { name: "Tall", key: false })).ref)
    const wide = await slotOf(store, (await store.importImage(solid(48, 16), { name: "Wide", key: false })).ref)
    expect([tall.box("small", false), tall.box("medium", false), tall.box("large", false)]).toEqual([{ cols: 3, rows: 4 }, { cols: 4, rows: 6 }, { cols: 6, rows: 9 }])
    expect([wide.box("small", false), wide.box("medium", false), wide.box("large", false)]).toEqual([{ cols: 10, rows: 2 }, { cols: 16, rows: 3 }, { cols: 24, rows: 4 }])
    // Every cell of the tight box is the picture: nothing blank is reserved around it.
    const drawn = tall.draw(tall.box("medium", false))!
    expect(drawn.lines.every((line) => lineWidth(line) === 4 && line.every((span) => span.text.trim() !== ""))).toBe(true)
    tall.stop()
    wide.stop()
  })

  test("in a session the pet is drawn at the profile's size, and /pet small|medium|large sets it without choosing a pet", async () => {
    const { store, still } = await shared()
    const heights: number[] = []
    for (const petSize of ["small", "medium", "large"] as const) {
      const { frame } = await mascotScene({ store, width: 140, height: 44, profile: { pet: still, petSize } })
      heights.push(petRows(frame()).length)
    }
    // Half blocks here (no image protocol): three quarters of the 24x13 and 36x20 boxes; in the 15x8 one this 64-pixel pet
    // would be noise, so Mend (7 rows) stands there instead.
    expect(heights).toEqual([7, 10, 15])
    const { h } = await mascotScene({ store, width: 140, height: 44, profile: { pet: still } })
    const profile = () => readTuiProfile(store.dir)
    await h.type("/pet small\r")
    expect(profile()).toMatchObject({ pet: still, petSize: "small" })
    await h.type("/pet Large\r")
    expect(profile()).toMatchObject({ pet: still, petSize: "large" })
    await h.type("/pet medium\r")
    expect(profile()).toMatchObject({ pet: still, petSize: "medium" })
  })

  test("a start screen that shows a pet mascot does not also draw the prompt's pet", async () => {
    const { store, still } = await shared()
    const alone = await mascotScene({ store, ref: still, width: 140, height: 44 })
    const both = await mascotScene({ store, ref: still, width: 140, height: 44, profile: { pet: still } })
    expect(petRows(alone.frame()).length).toBeGreaterThan(0)
    expect(petRows(both.frame()).length).toBe(petRows(alone.frame()).length)
    // Without a pet mascot the prompt's pet keeps its place there.
    const promptOnly = await mascotScene({ store, width: 140, height: 44, profile: { pet: still } })
    expect(petRows(promptOnly.frame()).length).toBeGreaterThan(0)
  })
})

describe("the session pet follows the session", () => {
  /** The pet's picture in the last frame: the colors of its half-block rows. */
  const picture = (lines: readonly Line[]) => JSON.stringify(lines.flatMap((line) => line.filter((span) => span.fgHex !== undefined && /[▀▄]/.test(span.text)).map((span) => [span.fgHex, span.bgHex])))

  test("reasoning, a compaction and sub-agents at work reach the pet from the session's own events and the activity push", async () => {
    const { store, full } = await shared()
    // Medium: at small, half blocks would shrink this 64-pixel pet to noise and Mend stands in its place.
    const { h, frame } = await mascotScene({ store, width: 140, height: 44, profile: { pet: full, petSize: "medium" } })
    const talk = conversation(h.sessionId, h.app.onEvent)
    const shown = () => { h.app.render(); return picture(frame()) }
    const idle = shown()
    expect(idle).not.toBe("[]")
    const [turnId, thought, answer] = ["turn_pet", "item_thought", "item_answer"]
    talk.emit({ type: "turn.started", turnId, queueId: "queue_pet" })
    talk.emit({ type: "foreground.state", state: "generating" })
    talk.emit({ type: "item.started", turnId, itemId: thought, kind: "reasoning" })
    const thinking = shown()
    talk.emit({ type: "item.completed", itemId: thought, status: "ok", text: "hm" })
    talk.emit({ type: "item.started", turnId, itemId: answer, kind: "agent_message" })
    const running = shown()
    talk.emit({ type: "foreground.state", state: "compacting" })
    const compacting = shown()
    talk.emit({ type: "item.completed", itemId: answer, status: "ok", text: "done" })
    talk.emit({ type: "turn.completed", turnId })
    talk.emit({ type: "foreground.state", state: "idle" })
    // This pet has no review row: the pass after the turn is its idle picture.
    expect(shown()).toBe(idle)
    expect(new Set([idle, thinking, compacting]).size).toBe(3)
    expect([running === thinking, running === compacting]).toEqual([false, false])
    // A sub-agent of this session works on after the turn: the activity push lists it, `task.changed` named its parent.
    const child = "session_child" as typeof h.sessionId
    const activity = (state: string) => h.app.onGlobal({ gseq: 1, at: 0, type: "session.activity", sessionId: child, directory: "/work", title: "sub", state, updatedAt: 1 } as never)
    activity("generating")
    // Another session at work is not this one's sub-agent.
    expect(shown()).toBe(idle)
    h.app.onGlobal({ type: "task.changed", gseq: 2, at: 0, sessionId: child, parentId: h.sessionId } as never)
    const agents = shown()
    expect(new Set([idle, thinking, compacting, agents]).size).toBe(4)
    activity("idle")
    expect(shown()).toBe(idle)
  })
})

describe("the mascot's settings and commands", () => {
  test("defaults: the ASCII mascot, motion on, medium, and the title alone; `mendy` and anything that is not a pet reference read as `mend`", () => {
    expect(DEFAULT_TUI_PROFILE).toMatchObject({ logoKind: "wordmark", homeMascot: "mend", mascotMotion: true, mascotSize: "medium" })
    expect(TUI_DEFAULTS).toMatchObject({ homeMascot: "mend", mascotMotion: true, mascotSize: "medium" })
    expect(TUI_ENUMS.mascotSize).toEqual(["small", "medium", "large"])
    expect(TUI_ENUMS.homeMascot).toBeUndefined()
    const mascotOf = (homeMascot: unknown) => normalizeTuiProfile({ homeMascot }).homeMascot
    expect(["mendy", "mend", "dragon", 7, "user:", "user:../x", "user:9f1c", "codex:greenie", "package:acme.pet"].map(mascotOf)).toEqual(["mend", "mend", "mend", "mend", "mend", "mend", "user:9f1c", "codex:greenie", "package:acme.pet"])
    expect(normalizeTuiProfile({ mascotSize: "huge", mascotMotion: "yes" })).toMatchObject({ mascotSize: "medium", mascotMotion: true })
    expect(tuiProblems({ homeMascot: "dragon" })).toEqual(["homeMascot: expected mend or a pet reference (user:<id>, codex:<id>, package:<id>; /pet lists them)"])
    expect(tuiProblems({ homeMascot: "mendy" })).toEqual([])
    expect(tuiProblems({ homeMascot: "user:9f1c", mascotMotion: false, mascotSize: "large" })).toEqual([])
    expect(tuiProblems({ mascotSize: "huge" })).toEqual(["mascotSize: expected small|medium|large"])
  })

  test("it follows the pet companion feature: the full tier, or the feature switched on", () => {
    expect(featureOn({ tier: "minimalist" }, "pets")).toBe(false)
    expect(featureOn({ tier: "balanced" }, "pets")).toBe(false)
    expect(featureOn({ tier: "full" }, "pets")).toBe(true)
    expect(featureOn({ tier: "balanced", features: { pets: true } }, "pets")).toBe(true)
  })

  test("/customize has its three rows under the logo kind: the mascot opens its list, motion toggles, size cycles", () => {
    const at = (row: string) => CUSTOMIZE_ROWS.indexOf(row as never)
    expect([at("homeMascot"), at("mascotMotion"), at("mascotSize")]).toEqual([at("logoKind") + 1, at("logoKind") + 2, at("logoKind") + 3])
    const key = (row: string, press: string) => customizePageKey({ row: at(row) }, press, DEFAULT_TUI_PROFILE)
    expect(key("homeMascot", "\r").action).toEqual({ type: "open", command: "mascot" })
    expect(key("mascotMotion", "\x1b[C").action).toEqual({ type: "set", patch: { mascotMotion: false } })
    expect(key("mascotSize", "\x1b[C").action).toEqual({ type: "set", patch: { mascotSize: "large" } })
  })

  test("/pet import parses its path (quoted when it has spaces) and options, and says what is wrong", () => {
    expect(parsePetCommand("import ~/art/aiko.png")).toEqual({ action: "import", path: "~/art/aiko.png" })
    expect(parsePetCommand('import "/Users/me/My Art/sheet.png" --name "Aiko Chan" --frames 4x2 --ms 90 --filter smooth --no-key')).toEqual({ action: "import", path: "/Users/me/My Art/sheet.png", name: "Aiko Chan", frames: { columns: 4, rows: 2 }, ms: 90, filter: "smooth", key: false })
    expect(() => parsePetCommand("import")).toThrow("Use import <file.png|file.gif|folder>")
    expect(() => parsePetCommand("import a.png b.png")).toThrow("One path at a time")
    expect(() => parsePetCommand("import a.png --frames 4")).toThrow("COLSxROWS")
    expect(() => parsePetCommand("import a.png --ms 5")).toThrow("20 to 10000")
    expect(() => parsePetCommand("import a.png --filter sharp")).toThrow("pixel or smooth")
    expect(() => parsePetCommand("import a.png --name")).toThrow("--name needs a value")
    expect(() => parsePetCommand("import a.png --resize 2")).toThrow("Unknown option --resize")
    // The commands that were there are read as before.
    expect(parsePetCommand("rename user:1 New name")).toEqual({ action: "rename", petId: "1", name: "New name" })
    expect(parsePetCommand("off")).toBeUndefined()
  })

  test("/pet new --frames asks for a small loop per state; a redrawn state keeps the pet's own frames", () => {
    expect(parsePetCommand("new blue owl --frames 3 --usd 0.04")).toEqual({ action: "plan", description: "blue owl", unitUsd: 0.04, optional: false, frames: 3 })
    expect(parsePetCommand("new blue owl --frames 1")).toEqual({ action: "plan", description: "blue owl", optional: false })
    expect(() => parsePetCommand("new blue owl --frames 5")).toThrow("1 to 4")
    expect(() => parsePetCommand("regen user:1 idle --frames 2")).toThrow("Use regen")
  })
})

test("the pet system, the resizer and the GIF decoder are not in the startup graph; a pet mascot loads them when the start screen first wants it", () => {
  const script = `const has = (name) => Object.keys(require.cache).some((k) => k.endsWith("/" + name + ".ts"));
const lazy = ["pets/home-pet", "pets/art", "pets/halfblock", "pets/sprite", "pets/manifest", "pets/controller", "src/pet-resample", "src/pet-import", "src/gif-decode", "src/pet-decode", "protocol/src/pet-data"];
await import("./src/ui/app");
await import("./src/view/home");
const atStart = lazy.filter(has);
await import("./src/pets/home-pet");
const keys = Object.keys(require.cache);
console.log(JSON.stringify({ atStart, after: ["pets/home-pet", "pets/art", "src/pet-resample", "pets/controller"].filter(has), never: ["src/pet-import", "src/gif-decode"].filter(has), zod: keys.filter((k) => k.includes("/zod/")).length, schemas: keys.filter((k) => /protocol\\/src\\/(commands|events|queries|frames)\\.ts$/.test(k)).length }))`
  const result = Bun.spawnSync(["bun", "-e", script], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
  expect(result.stderr.toString()).toBe("")
  expect(JSON.parse(result.stdout.toString().trim())).toEqual({ atStart: [], after: ["pets/home-pet", "pets/art", "src/pet-resample", "pets/controller"], never: [], zod: 0, schemas: 0 })
})
