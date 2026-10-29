import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { encodeImagePng } from "../../../packages/tools/src/pet-png"
import { contentBox } from "../../../packages/tools/src/pet-resample"
import { createPetController, REVIEW_MS, restingRow, SLEEP_MS } from "../src/pets/controller"
import { PET_FRAME_DURATIONS, PET_ROW_FALLBACK, rowOrFallback, type PetRow } from "../src/pets/frames"
import { createPetSlot } from "../src/pets/pet-slot"
import { decodeSprite, encodeSprite, loadSprite, spritePath } from "../src/pets/sprite"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { appHarness, conversation } from "./session-ui-harness"

const FIXTURES = path.join(import.meta.dir, "fixtures", "pets")
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-pets-"))
  dirs.push(dir)
  return dir
}

/** A Codex-format pet in `dir`/`id`: an atlas of 32-pixel cells (8 columns, 9 rows) painted pixel by pixel. */
function writeAtlas(dir: string, id: string, paint: (x: number, y: number) => readonly number[] | undefined) {
  const [width, height] = [32 * 8, 32 * 9]
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = paint(x, y)
    if (color) rgba.set(color, (y * width + x) * 4)
  }
  mkdirSync(path.join(dir, id))
  writeFileSync(path.join(dir, id, "spritesheet.png"), encodeImagePng({ width, height, rgba }))
  writeFileSync(path.join(dir, id, "pet.json"), JSON.stringify({ id, spritesheetPath: "spritesheet.png" }))
}

/** A controller on a hand-moved clock whose single timer fires when the test says so. */
function controlled(options: { animate?: () => boolean; has?: (row: PetRow) => boolean; still?: boolean } = {}) {
  let now = 0
  let pending: { run: () => void; at: number } | undefined
  let changes = 0
  const controller = createPetController({
    now: () => now,
    animate: options.animate ?? (() => true),
    onChange: () => void changes++,
    ...(options.has ? { has: options.has } : {}),
    // A pet of single pictures: no frame timer, so the only waits are the end of a review and the moment it falls asleep.
    ...(options.still ? { durations: () => [] } : {}),
    setTimer: (run, ms) => (pending = { run, at: now + ms }),
    clearTimer: () => (pending = undefined),
  })
  const advance = () => {
    const next = pending
    if (!next) return false
    pending = undefined
    now = next.at
    next.run()
    return true
  }
  return { controller, advance, timer: () => pending, at: () => now, changes: () => changes }
}

describe("pet states", () => {
  test("each session state has its row", () => {
    expect(["idle", "queued", "generating", "tool", "compacting", "cancelling", "waiting_approval", "error"].map((s) => restingRow(s as never))).toEqual(["idle", "running", "running", "running", "compacting", "running", "waiting", "failed"])
    // A pet without a compacting row (the Codex atlas has none) shows what it always did.
    expect(["idle", "queued", "generating", "tool", "compacting", "cancelling", "waiting_approval", "error"].map((s) => {
      const { controller } = controlled()
      controller.setForeground(s as never)
      return controller.current().row
    })).toEqual(["idle", "running", "running", "running", "running", "running", "waiting", "failed"])
  })

  test("frames advance by the row's durations and wrap", () => {
    const { controller, advance, at } = controlled()
    controller.sync()
    expect(controller.current()).toEqual({ row: "idle", index: 0 })
    advance()
    expect(at()).toBe(PET_FRAME_DURATIONS.idle[0])
    expect(controller.current()).toEqual({ row: "idle", index: 1 })
    for (let i = 0; i < 5; i++) advance()
    expect(controller.current().index).toBe(0)
  })

  test("a finished turn shows review for four seconds, then idle", () => {
    const { controller, advance, at } = controlled({ animate: () => false })
    controller.setForeground("generating")
    expect(controller.current().row).toBe("running")
    controller.setForeground("idle")
    expect(controller.current().row).toBe("review")
    advance()
    expect(at()).toBe(REVIEW_MS)
    expect(controller.current().row).toBe("idle")
  })

  test("a greeting plays one pass and returns to what the session is doing", () => {
    const { controller, advance } = controlled()
    controller.setForeground("tool")
    controller.cheer("waving")
    expect(controller.current().row).toBe("waving")
    while (controller.current().row === "waving") advance()
    expect(controller.current().row).toBe("running")
  })

  test("without animation the first frame shows and no timer runs while resting", () => {
    let animate = true
    const { controller, timer } = controlled({ animate: () => animate })
    controller.sync()
    expect(timer()).toBeDefined()
    animate = false
    controller.sync()
    expect(timer()).toBeUndefined()
    expect(controller.current().index).toBe(0)
  })

  test("switching off a greeting cancels its pending timer", () => {
    const { controller, timer } = controlled({ animate: () => false })
    controller.cheer("waving")
    expect(timer()).toBeDefined()
    controller.cancelCheer()
    expect(timer()).toBeUndefined()
    expect(controller.current()).toEqual({ row: "idle", index: 0 })
  })

  test("stop leaves no timer behind", () => {
    const { controller, timer } = controlled()
    controller.cheer("jumping")
    controller.stop()
    expect(timer()).toBeUndefined()
  })
})

describe("pet states only an import brings", () => {
  const all = () => true
  const reasoning = { current: { kind: "reasoning" } }
  const answer = { current: { kind: "agent_message" } }
  const task = { current: { kind: "tool_call", tool: "task" } }
  const shell = { current: { kind: "tool_call", tool: "bash" } }
  const packing = { current: { kind: "compaction" } }

  test("thinking while only reasoning streams, compacting, agents while sub-agents work for it, sleeping after five idle minutes", () => {
    const { controller, advance, at } = controlled({ has: all, still: true })
    const row = () => controller.current().row
    controller.setForeground("generating", reasoning)
    expect(row()).toBe("thinking")
    controller.setForeground("generating", answer)
    expect(row()).toBe("running")
    controller.setForeground("tool", shell)
    expect(row()).toBe("running")
    // The main agent only waits for the sub-agents its `task` call started.
    controller.setForeground("tool", task)
    expect(row()).toBe("agents")
    // A compaction: manual, automatic or the daemon's own while idle all put the session in `compacting`; an engine that packs inside a turn runs a compaction item.
    controller.setForeground("compacting")
    expect(row()).toBe("compacting")
    controller.setForeground("generating", packing)
    expect(row()).toBe("compacting")
    // The turn is over and sub-agents of the session work on: agents, and `review` once they are done.
    controller.setForeground("idle", { agents: true })
    expect(row()).toBe("agents")
    controller.setForeground("idle", { agents: false })
    expect(row()).toBe("review")
    const ended = at()
    advance()
    expect([row(), at()]).toEqual(["idle", ended + REVIEW_MS])
    advance()
    expect([row(), at()]).toEqual(["sleeping", ended + SLEEP_MS])
    expect(SLEEP_MS).toBe(5 * 60_000)
  })

  test("a pet that lacks them falls back: thinking, compacting and agents to running, sleeping to idle, with no timer for it", () => {
    expect(PET_ROW_FALLBACK).toEqual({ thinking: "running", compacting: "running", agents: "running", sleeping: "idle" })
    const lacking = (row: PetRow) => rowOrFallback(row, (of) => of === "idle" || of === "running")
    expect((["thinking", "compacting", "agents", "sleeping", "running", "waiting"] as const).map(lacking)).toEqual(["running", "running", "running", "idle", "running", "waiting"])
    const { controller, timer, advance } = controlled({ still: true })
    const row = () => controller.current().row
    for (const [state, signals] of [["generating", reasoning], ["tool", task], ["compacting", {}], ["generating", packing]] as const) {
      controller.setForeground(state, signals)
      expect(row()).toBe("running")
    }
    controller.setForeground("idle", { agents: true })
    expect(row()).toBe("running")
    controller.setForeground("idle")
    expect(row()).toBe("review")
    advance()
    // Idle for good: a pet without a sleeping row waits for nothing.
    expect([row(), timer()]).toEqual(["idle", undefined])
  })

  test("a Codex pet plays frame for frame what it played before: the new signals never restart or change a row", () => {
    /** Every step of a session, with and without what the pet now hears: the rows, frames and timer of both runs must be one. */
    const script: Array<[state: string, signals: object, ticks: number]> = [
      ["idle", {}, 3], ["generating", reasoning, 2], ["generating", answer, 2], ["tool", task, 3], ["tool", shell, 1], ["compacting", {}, 2], ["generating", packing, 2],
      ["waiting_approval", task, 2], ["generating", reasoning, 1], ["idle", {}, 40], ["error", packing, 2], ["idle", {}, 3_000],
    ]
    const run = (heard: boolean) => {
      const { controller, advance, at, timer, changes } = controlled()
      const trace: unknown[] = []
      const note = () => trace.push([controller.current(), at(), timer()?.at, changes()])
      for (const [state, signals, ticks] of script) {
        controller.setForeground(state as never, heard ? signals : undefined)
        note()
        for (let tick = 0; tick < ticks; tick++) { advance(); note() }
      }
      return trace
    }
    const heard = run(true)
    expect(JSON.stringify(heard)).toBe(JSON.stringify(run(false)))
    expect([...new Set(heard.map((entry) => (entry as [{ row: string }])[0].row))].sort()).toEqual(["failed", "idle", "review", "running", "waiting"])
    // The frames keep running through thinking, a `task` call and a compaction: one continuous `running`, never back at frame 0.
    const { controller, advance } = controlled()
    controller.setForeground("generating", reasoning)
    advance()
    advance()
    for (const [state, signals] of [["generating", answer], ["tool", task], ["compacting", {}], ["tool", shell]] as const) {
      controller.setForeground(state, signals)
      expect(controller.current()).toEqual({ row: "running", index: 2 })
    }
  })

  test("when several hold: failed, waiting, compacting, what the main agent does, agents, review, sleeping, idle", () => {
    const { controller, advance, at } = controlled({ has: all, still: true })
    const shows = (state: string, signals?: object) => {
      controller.setForeground(state as never, signals)
      return controller.current().row
    }
    // Failed and waiting over a compaction still in flight.
    expect(shows("error", { ...packing, agents: true })).toBe("failed")
    expect(shows("waiting_approval", { ...packing, agents: true })).toBe("waiting")
    // Compacting over thinking and running.
    expect(shows("compacting", reasoning)).toBe("compacting")
    expect(shows("compacting", shell)).toBe("compacting")
    // What the main agent itself does over its sub-agents.
    expect(shows("generating", { ...reasoning, agents: true })).toBe("thinking")
    expect(shows("generating", { ...answer, agents: true })).toBe("running")
    expect(shows("tool", { ...shell, agents: true })).toBe("running")
    // Agents over the review pass: no review while they work, and they cut a review short.
    expect(shows("idle", { agents: true })).toBe("agents")
    expect(shows("generating", answer)).toBe("running")
    expect(shows("idle")).toBe("review")
    expect(shows("idle", { agents: true })).toBe("agents")
    // Review before sleeping: the pass plays out, and sleep comes five minutes after the turn ended.
    expect(shows("idle")).toBe("review")
    const ended = at()
    advance()
    expect([controller.current().row, at() - ended]).toEqual(["idle", REVIEW_MS])
    advance()
    expect([controller.current().row, at() - ended]).toEqual(["sleeping", SLEEP_MS])
    // A cheer stays one pass on top of whatever rests.
    const cheering = controlled({ has: all })
    cheering.controller.setForeground("generating", reasoning)
    cheering.controller.cheer("jumping")
    expect(cheering.controller.current().row).toBe("jumping")
    while (cheering.controller.current().row === "jumping") cheering.advance()
    expect(cheering.controller.current().row).toBe("thinking")
  })

  test("sleeping: one timer for the wait, anything the session does wakes it, and no timer without motion", () => {
    let animate = true
    const { controller, advance, timer, at } = controlled({ has: all, still: true, animate: () => animate })
    controller.sync()
    expect(timer()?.at).toBe(SLEEP_MS)
    advance()
    expect([controller.current(), timer()]).toEqual([{ row: "sleeping", index: 0 }, undefined])
    // The same state again is not activity; a turn starting is.
    controller.setForeground("idle")
    expect(controller.current().row).toBe("sleeping")
    controller.setForeground("generating")
    expect([controller.current().row, timer()]).toEqual(["running", undefined])
    controller.setForeground("idle")
    const ended = at()
    advance()
    expect(timer()?.at).toBe(ended + SLEEP_MS)
    // Motion off mid-wait (reduced motion, the pet hidden, pets off): the timer goes; back on, it waits for what is left.
    animate = false
    controller.sync()
    expect(timer()).toBeUndefined()
    animate = true
    controller.sync()
    expect(timer()?.at).toBe(ended + SLEEP_MS)
    advance()
    expect(controller.current().row).toBe("sleeping")
    // A greeting wakes it, and the wait starts over.
    controller.cancelCheer()
    expect([controller.current().row, timer()?.at]).toEqual(["idle", at() + SLEEP_MS])
    controller.stop()
    expect(timer()).toBeUndefined()

    // Never asked to move, it never waits: not at rest, not after a turn's review.
    const held = controlled({ has: all, still: true, animate: () => false })
    held.controller.sync()
    expect(held.timer()).toBeUndefined()
    held.controller.setForeground("generating")
    held.controller.setForeground("idle")
    held.advance()
    expect([held.controller.current().row, held.timer()]).toEqual(["idle", undefined])
  })

  test("an idle row that moves keeps its one frame timer and still falls asleep on time", () => {
    const { controller, advance, timer, at } = controlled({ has: all })
    controller.sync()
    let timers = 0
    while (controller.current().row === "idle") {
      expect(timer()).toBeDefined()
      advance()
      timers++
    }
    expect([controller.current(), at()]).toEqual([{ row: "sleeping", index: 0 }, SLEEP_MS])
    expect(timers).toBeGreaterThan(100)
  })
})

describe("pet frames cache", () => {
  const tiny = { ref: "user:tiny" as const, id: "tiny", displayName: "Tiny", description: "", sheetPath: path.join(FIXTURES, "tiny", "spritesheet.png"), version: 1 as const }

  test("frames survive the cache format unchanged", async () => {
    const cacheDir = tempDir()
    const sprite = await loadSprite({ pet: tiny, cacheDir })
    const again = decodeSprite(new Uint8Array(await Bun.file(await spritePath({ pet: tiny, cacheDir })).arrayBuffer()))
    expect([...again.keys()]).toEqual([...sprite.rows.keys()])
    expect(again.get("idle")![0]).toEqual(sprite.rows.get("idle")![0]!)
    expect(decodeSprite(encodeSprite(sprite.rows)).get("review")).toEqual([...sprite.rows.get("review")!])
  })

  test("a cache of the previous format is rewritten from its own frames, without the sheet, and only the new file stays", async () => {
    const cacheDir = tempDir()
    const legacy = await spritePath({ pet: tiny, cacheDir }, 3)
    const red = { width: 2, height: 2, rgba: new Uint8Array(16).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0)) }
    const header = new TextEncoder().encode(JSON.stringify({ v: 3, rows: [{ row: "idle", frames: [0] }], images: [[2, 2]] }))
    const raw = new Uint8Array(4 + header.byteLength + 16)
    new DataView(raw.buffer).setUint32(0, header.byteLength, true)
    raw.set(header, 4)
    raw.set(red.rgba, 4 + header.byteLength)
    mkdirSync(cacheDir, { recursive: true })
    await Bun.write(legacy, Bun.gzipSync(raw))
    const sprite = await loadSprite({ pet: tiny, cacheDir })
    expect(sprite.rows.get("idle")![0]).toEqual(red)
    expect(sprite.box).toEqual({ left: 0, top: 0, width: 2, height: 2 })
    expect(readdirSync(cacheDir)).toEqual([path.basename(await spritePath({ pet: tiny, cacheDir }))])
  })

  test("frames stay compressed until read, and only the last few read stay inflated", async () => {
    const sprite = await loadSprite({ pet: tiny, cacheDir: tempDir() })
    const frames = [...new Set([...sprite.rows.values()].flat())]
    expect(frames.length).toBeGreaterThan(4)
    const first = frames[0]!.rgba
    expect(frames[0]!.rgba).toBe(first)
    for (const frame of frames.slice(1)) void frame.rgba
    expect(frames[0]!.rgba).not.toBe(first)
    expect(frames[0]!.rgba).toEqual(first)
  })

  test("a second load reads the cache instead of the sheet", async () => {
    const cacheDir = tempDir()
    await loadSprite({ pet: tiny, cacheDir })
    const file = await spritePath({ pet: tiny, cacheDir })
    const written = Bun.file(file).lastModified
    await loadSprite({ pet: tiny, cacheDir })
    expect(Bun.file(file).lastModified).toBe(written)
  })

  test("an unknown pet is reported and nothing is drawn", async () => {
    const said: string[] = []
    const slot = createPetSlot({ dirs: [{ dir: FIXTURES, source: "user" }], cacheDir: tempDir(), now: () => 0, reducedMotion: () => true, onChange: () => {}, say: (m) => void said.push(m) })
    await slot.choose("user:missing")
    expect(said).toEqual(["pet not found"])
    expect(slot.draw()).toBeUndefined()
    await slot.choose("user:tiny")
    expect(slot.draw()?.lines).toHaveLength(5)
    // A Codex-format pet takes the part of each size's box its drawn pixels need, like an imported one: this 6x4 pet is wider than tall.
    expect([slot.box("small", false), slot.box("medium", false), slot.box("large", false)]).toEqual([{ cols: 10, rows: 4 }, { cols: 16, rows: 6 }, { cols: 24, rows: 9 }])
    expect([slot.box("small", true), slot.box("medium", true), slot.box("large", true)]).toEqual([{ cols: 15, rows: 6 }, { cols: 24, rows: 9 }, { cols: 36, rows: 14 }])
    expect(slot.draw(slot.box("medium", false))?.lines).toHaveLength(6)
    slot.stop()
  })

  test("a Codex atlas cell's transparent margin is cut: the character stands three quarters of the box instead of half of it", async () => {
    // Like Greenie (102 x 116 drawn in a 192 x 208 cell): a 12 x 16 character standing in a 32 x 32 cell.
    const dir = tempDir()
    writeAtlas(dir, "margin", (x, y) => (x % 32 < 10 || x % 32 >= 22 || y % 32 < 16 ? undefined : [40, 200, 90, 255]))
    const slot = createPetSlot({ dirs: [{ dir, source: "codex" }], cacheDir: tempDir(), now: () => 0, reducedMotion: () => true, onChange: () => {}, say: () => {} })
    await slot.choose("codex:margin")
    const box = slot.box("medium", false)
    expect(box).toEqual({ cols: 9, rows: 6 })
    const drawn = slot.draw(box, { width: 8, height: 16 })!.image!.image
    expect(contentBox(drawn)).toEqual({ left: 0, top: 0, width: 72, height: 96 })
    slot.stop()
  })
})

describe("pet in the prompt", () => {
  function app(options: { pets?: boolean } = {}) {
    const frames: Line[][] = []
    // Wide enough that the home screen's sessions sidebar leaves the wordmark clear of the pet's corner.
    const screen = { size: { width: 160, height: 30 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
    const instance = createApp({
      sessionId: createIdFactory()("session"),
      screen,
      send: async () => ({ ok: true }),
      exit() {},
      schedule: (fn: () => void) => fn(),
      glyphs: glyphs({}),
      now: () => 1_800_000_000_000,
      random: () => 0,
      reducedMotion: true,
      ...(options.pets ? { pets: { dirs: [{ dir: FIXTURES, source: "user" as const }], cacheDir: tempDir(), images: false } } : {}),
    } as never)
    const text = () => frames.at(-1)!.map((row) => row.map((s) => s.text).join(""))
    return { app: instance, text, frames }
  }

  test("with no pet chosen the screen is the same as without pets at all", () => {
    const plain = app()
    const withPets = app({ pets: true })
    plain.app.applySettings({} as never)
    withPets.app.applySettings({} as never)
    plain.app.render()
    withPets.app.render()
    expect(withPets.text()).toEqual(plain.text())
  })

  test("a chosen pet sits in the bottom-right corner above the prompt", async () => {
    const { app: instance, frames } = app({ pets: true })
    instance.applySettings({ pet: "user:tiny" } as never)
    await instance.petReady
    instance.render()
    const rows = frames.at(-1)!
    const withPet = rows.map((row, index) => ({ index, pet: row.some((span) => span.fgHex !== undefined && /[▀▄]/.test(span.text)) })).filter((row) => row.pet)
    expect(withPet.length).toBeGreaterThan(0)
    expect(withPet.length).toBeLessThanOrEqual(13)
    // In the thirteen rows right above the prompt's top rule (a transparent edge row may stay blank), never on the prompt itself.
    const rule = rows.findIndex((row, index) => index > withPet.at(-1)!.index && row.some((span) => span.text.includes("─")))
    expect(withPet.every((row) => row.index >= rule - 13 && row.index < rule)).toBe(true)
    expect(rows.slice(rule).some((row) => row.some((span) => span.fgHex !== undefined && /[▀▄]/.test(span.text)))).toBe(false)
  })

  test("the mouse arriving over a pixel pet makes it wave, as v1's ASCII Mend turned to its hover face", async () => {
    // Green while idle; the waving row (the fourth of the atlas) moves, each frame a darker orange: a row of one picture is never played.
    const dir = tempDir()
    writeAtlas(dir, "waver", (x, y) => (x % 32 < 10 || x % 32 >= 22 || y % 32 < 16 ? undefined : Math.floor(y / 32) === 3 ? [240 - 20 * Math.floor(x / 32), 120, 20, 255] : [40, 200, 90, 255]))
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, pet: "user:waver", images: "off" })
    let clock = 1_800_000_000_000
    const h = appHarness({ dataDir, width: 100, height: 30, now: () => clock, pets: { dirs: [{ dir, source: "user" }], cacheDir: path.join(dataDir, "cache"), images: false } })
    h.app.applySettings({ onboarded: true, pet: "user:waver", reducedMotion: true })
    conversation(h.sessionId, h.app.onEvent).exchange("Hello", "Ready")
    await h.app.petReady
    h.app.render()
    const [instance, frames] = [h.app, h.frames]
    const pixels = (rows: Line[]) => JSON.stringify(rows.map((row) => row.filter((span) => span.fgHex !== undefined && /[▀▄]/.test(span.text))))
    // A pet greets with one pass of waving as it loads (0.7 s), then the turn's review (4 s): the hover is measured once it rests.
    clock += 10_000
    for (let wait = 0; wait < 40 && !pixels(frames.at(-1)!).includes("#28c85a"); wait++) await Bun.sleep(50)
    const idle = pixels(frames.at(-1)!)
    expect(idle).toContain("#28c85a")
    const row = frames.at(-1)!.findLastIndex((line) => line.some((span) => span.fgHex !== undefined && /[▀▄]/.test(span.text)))
    const line = frames.at(-1)![row]!
    const col = line.slice(0, line.findIndex((span) => span.fgHex !== undefined && /[▀▄]/.test(span.text))).reduce((sum, span) => sum + span.text.length, 0)
    await instance.onKey("\x1b[<35;1;1M")
    expect(pixels(frames.at(-1)!)).toBe(idle)
    await instance.onKey(`\x1b[<35;${col + 1};${row + 1}M`)
    expect(pixels(frames.at(-1)!)).not.toBe(idle)
  })
})

describe("pet picker", () => {
  test("arrows select, enter chooses, o turns it off, and the page fills the screen", async () => {
    const { createPetPickerState, petPickerKey, renderPetPicker } = await import("../src/view/pet-picker")
    const choices = [{ ref: "codex:a", name: "A", description: "first" }, { ref: "user:b", name: "B", description: "second" }]
    let state = createPetPickerState(choices, "user:b")
    expect(state.selected).toBe(1)
    state = petPickerKey(state, "\x1b[A", choices).state
    expect(petPickerKey(state, "\r", choices).action).toEqual({ type: "choose", ref: "codex:a" })
    expect(petPickerKey(state, "o", choices).action).toEqual({ type: "choose", ref: "off" })
    for (const [width, height] of [[60, 20], [120, 40]] as const) expect(renderPetPicker({ choices, current: "user:b", state, width, height })).toHaveLength(height)
  })
})
