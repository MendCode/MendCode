import { describe, expect, test } from "bun:test"
import { onBackground, sampleSprite, sheetOf, smoothSample } from "../../../apps/cli/test/mascot-sample"
import { PET_GENERATED_STATES, PET_LAYOUT_LIMITS, PET_STATE_NAMES, PET_STATES, readPetLayout } from "../../protocol/src/pet-data"
import { decodeGif, isGif, MAX_GIF_FRAMES } from "../src/gif-decode"
import { MAX_SHEET_SIDE, type PetImage } from "../src/pet-decode"
import { buildImportedPet, FRAME_SIDES, frameSide, IMPORT_BUDGET, IMPORT_FRAME_MS, splitSheet } from "../src/pet-import"
import { artKind, contentBox, cropImage, fitImage, keyBackground, pixelScale, resample, sharpenImage, shrinkExact } from "../src/pet-resample"
import { encodeGif } from "./gif-fixture"

const pixel = sampleSprite()
const smooth = smoothSample()
const colors = (image: PetImage, minAlpha = 128) => {
  const seen = new Set<string>()
  for (let at = 0; at < image.width * image.height; at++) if (image.rgba[at * 4 + 3]! >= minAlpha) seen.add(image.rgba.subarray(at * 4, at * 4 + 3).join(","))
  return seen
}
const enlarge = (image: PetImage, times: number): PetImage => resample(image, image.width * times, image.height * times, "pixel")
const solid = (width: number, height: number, color: number[]): PetImage => {
  const rgba = new Uint8Array(width * height * 4)
  for (let at = 0; at < width * height; at++) rgba.set(color, at * 4)
  return { width, height, rgba }
}

describe("telling pixel art from smooth artwork", () => {
  test("the placeholder sprite is pixel art, its anti-aliased enlargement is smooth, with or without a background", () => {
    expect(artKind(pixel)).toBe("pixel")
    expect(colors(pixel).size).toBeLessThan(40)
    expect(artKind(smooth)).toBe("smooth")
    expect(artKind(onBackground(pixel, [255, 0, 255]))).toBe("pixel")
    expect(artKind(onBackground(smooth, [120, 200, 240]))).toBe("smooth")
  })

  test("a clean integer enlargement is measured and undone exactly", () => {
    for (const times of [2, 3, 8]) {
      const big = enlarge(pixel, times)
      expect(pixelScale(big)).toBe(times)
      expect(artKind(big)).toBe("pixel")
      expect(Buffer.compare(shrinkExact(big, times).rgba, pixel.rgba)).toBe(0)
    }
    expect(pixelScale(pixel)).toBe(1)
    expect(pixelScale(smooth)).toBe(1)
  })
})

describe("resizing by kind", () => {
  test("pixel art made smaller keeps only its own colors, its outline and its eyes", () => {
    const box = contentBox(pixel)!
    const small = fitImage(cropImage(pixel, box), 32, 32, "pixel")
    const own = colors(pixel)
    expect([...colors(small)].filter((color) => !own.has(color))).toEqual([])
    // The outline color and the iris survive the halving; an average would have produced neither.
    expect(colors(small).has("43,27,61")).toBe(true)
    expect(colors(small).has("58,196,178")).toBe(true)
    // Binary alpha: nothing half transparent.
    for (let at = 3; at < small.rgba.length; at += 4) expect(small.rgba[at] === 0 || small.rgba[at] === 255).toBe(true)
  })

  test("pixel art made larger repeats pixels by whole steps and never blends", () => {
    const big = fitImage(pixel, 200, 200, "pixel")
    expect(big.width).toBe(200)
    expect([...colors(big)].filter((color) => !colors(pixel).has(color))).toEqual([])
    // 64 fits three times into 200: every pixel is three wide, the picture is centered and stands on the bottom edge.
    const [from, to] = [contentBox(pixel)!, contentBox(big)!]
    expect([to.width, to.height, to.top + to.height, to.left]).toEqual([from.width * 3, from.height * 3, 200, 4 + from.left * 3])
  })

  test("smooth artwork made smaller is an average: a half-covered pixel is half transparent, and its color is not tinted by what was transparent", () => {
    const half: PetImage = { width: 4, height: 2, rgba: new Uint8Array(32) }
    for (const at of [0, 1, 4, 5]) half.rgba.set([200, 40, 40, 255], at * 4)
    const one = resample(half, 2, 1, "smooth")
    expect([...one.rgba.subarray(0, 4)]).toEqual([200, 40, 40, 255])
    expect(one.rgba[7]).toBe(0)
    const mixed = resample(half, 1, 1, "smooth")
    expect([...mixed.rgba]).toEqual([200, 40, 40, 128])
  })

  test("smooth artwork at half-block size keeps a dark eye after sharpening where the plain average left a smudge", () => {
    const cut = cropImage(smooth, contentBox(smooth)!)
    const plain = fitImage(cut, 32, 32, "smooth")
    const sharp = sharpenImage(plain, 1)
    const darkest = (image: PetImage) => {
      let low = 255
      // The face: the middle band of the picture.
      for (let y = 10; y < 18; y++) for (let x = 8; x < 24; x++) {
        const at = (y * image.width + x) * 4
        if (image.rgba[at + 3]! >= 128) low = Math.min(low, (image.rgba[at]! + image.rgba[at + 1]! + image.rgba[at + 2]!) / 3)
      }
      return low
    }
    expect(darkest(sharp)).toBeLessThan(darkest(plain) - 15)
    expect(sharp.rgba.filter((_, at) => at % 4 === 3)).toEqual(plain.rgba.filter((_, at) => at % 4 === 3))
  })

  test("smooth artwork made larger is interpolated, bounded, and refuses a size it should never be asked for", () => {
    const big = resample(solid(2, 2, [10, 20, 30, 255]), 5, 5, "smooth")
    expect([...big.rgba.subarray(0, 4)]).toEqual([10, 20, 30, 255])
    expect(() => resample(pixel, 5000, 10, "smooth")).toThrow("invalid resample size")
  })
})

describe("keying a flat background", () => {
  test("pixel art on a flat color: the color goes exactly, the sprite's pixels are untouched, the same color inside it stays", () => {
    const keyed = keyBackground(onBackground(pixel, [255, 0, 255]), "pixel")
    expect(keyed.color).toEqual([255, 0, 255])
    expect(Buffer.compare(keyed.image.rgba, pixel.rgba)).toBe(0)
    // A hole of the background's color enclosed by the character is not connected to the border: it stays.
    const ring = solid(12, 12, [255, 255, 255, 255])
    for (let y = 3; y < 9; y++) for (let x = 3; x < 9; x++) ring.rgba.set([20, 20, 20, 255], (y * 12 + x) * 4)
    for (let y = 5; y < 7; y++) for (let x = 5; x < 7; x++) ring.rgba.set([255, 255, 255, 255], (y * 12 + x) * 4)
    const cut = keyBackground(ring, "pixel").image
    expect(cut.rgba[3]).toBe(0)
    expect([...cut.rgba.subarray((5 * 12 + 5) * 4, (5 * 12 + 5) * 4 + 4)]).toEqual([255, 255, 255, 255])
  })

  test("smooth art on a flat color: no pixel of the result carries the background's tint (no halo)", () => {
    const background = [120, 200, 240] as const
    const keyed = keyBackground(onBackground(smooth, background), "smooth")
    expect(keyed.color).toEqual([...background])
    let tinted = 0, kept = 0
    for (let at = 0; at < keyed.image.width * keyed.image.height; at++) {
      const [r, g, b, a] = keyed.image.rgba.subarray(at * 4, at * 4 + 4)
      if (a! < 24) continue
      kept++
      // The background is far more blue-green than anything in the character's outline: a leftover mix shows as such.
      if (smooth.rgba[at * 4 + 3]! < 200 && g! > 150 && b! > 190 && r! < 170) tinted++
    }
    expect(tinted).toBe(0)
    // What is kept is the character: about as many pixels as it had before the background was put behind it.
    let original = 0
    for (let at = 3; at < smooth.rgba.length; at += 4) if (smooth.rgba[at]! >= 24) original++
    expect(Math.abs(kept - original) / original).toBeLessThan(0.06)
  })

  test("a picture with its own transparency, or with corners that differ, is left as it is", () => {
    expect(keyBackground(pixel, "pixel")).toEqual({ image: pixel })
    const two = solid(8, 8, [10, 10, 10, 255])
    two.rgba.set([250, 250, 250, 255], 0)
    expect(keyBackground(two, "smooth").color).toBeUndefined()
  })
})

describe("building an imported pet", () => {
  test("one still: one cell at the picture's own size, cropped to what it draws, and an idle state of one frame", () => {
    const pet = buildImportedPet({ states: { idle: [{ image: pixel, ms: IMPORT_FRAME_MS }] } })
    const box = contentBox(pixel)!
    expect(pet.layout).toEqual({ art: "pixel", cell: { width: box.width, height: box.height }, columns: 1, states: { idle: [[0, IMPORT_FRAME_MS]] } })
    expect(Buffer.compare(pet.sheet.rgba, cropImage(pixel, box).rgba)).toBe(0)
    expect(pet.keyed).toBe(false)
    expect(readPetLayout(JSON.parse(JSON.stringify(pet.layout)))).toEqual(pet.layout)
  })

  test("an enlarged pixel sprite is stored at its real size; a smooth picture larger than the budget is averaged down to it", () => {
    const stored = buildImportedPet({ states: { idle: [{ image: enlarge(pixel, 8), ms: 100 }] } })
    expect(stored.layout.cell).toEqual({ width: contentBox(pixel)!.width, height: contentBox(pixel)!.height })
    const huge = resample(smooth, 2000, 2000, "smooth")
    const reduced = buildImportedPet({ states: { idle: [{ image: huge, ms: 100 }] } })
    expect(reduced.layout.art).toBe("smooth")
    expect(Math.max(reduced.layout.cell.width, reduced.layout.cell.height)).toBe(FRAME_SIDES[0])
    expect(reduced.decodedBytes).toBeLessThanOrEqual(IMPORT_BUDGET.decodedBytes)
    // A picture smaller than the budget is never enlarged.
    expect(buildImportedPet({ states: { idle: [{ image: smooth, ms: 100 }] } }).layout.cell.width).toBe(contentBox(smooth)!.width)
  }, 30_000)

  test("a sprite sheet: rows are states in order, columns frames, equal frames stored once, one box per state", () => {
    const open = sampleSprite(), closed = sampleSprite({ eyes: "closed" }), up = sampleSprite({ lift: 1 })
    const sheet = sheetOf([open, open, closed, up])
    const states = splitSheet(sheet, 4, 1, 200)
    expect(Object.keys(states)).toEqual(["idle"])
    const pet = buildImportedPet({ states })
    expect(pet.layout.states.idle).toEqual([[0, 200], [0, 200], [1, 200], [2, 200]])
    expect(pet.frames).toBe(4)
    expect(pet.sheet.width).toBe(pet.layout.columns * pet.layout.cell.width)
    // The lifted frame is a pixel taller than the others: the cell holds the tallest, every frame stands on its bottom edge.
    expect(pet.layout.cell.height).toBe(contentBox(open)!.height + 1)
    const two = buildImportedPet({ states: splitSheet({ width: 128, height: 128, rgba: new Uint8Array([...sheetOf([open, closed]).rgba, ...sheetOf([up, up]).rgba]) }, 2, 2) })
    expect(Object.keys(two.layout.states)).toEqual(["idle", "running"])
    expect(two.layout.states.running!.map(([cell]) => cell)).toEqual([2, 2])
    expect(() => splitSheet(sheet, 3, 1)).toThrow("does not divide")
    expect(() => splitSheet(sheet, 4, 9)).toThrow("at most 7 rows")
  })

  test("states drawn on one canvas share one box: the character keeps its place and size from state to state", () => {
    // The same 4x4 block at the same spot of a 32x32 canvas; `running` also draws a prop far to the right and below.
    const canvas = (prop: boolean): PetImage => {
      const image = { width: 32, height: 32, rgba: new Uint8Array(32 * 32 * 4) }
      const dot = (x: number, y: number) => image.rgba.set([10, 200, 120, 255], (y * 32 + x) * 4)
      for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) dot(x, y)
      // One odd pixel, so the picture does not read as art enlarged by whole steps.
      dot(12, 8)
      if (prop) for (let y = 20; y < 24; y++) for (let x = 24; x < 28; x++) dot(x, y)
      return image
    }
    const pet = buildImportedPet({ states: { idle: [{ image: canvas(false), ms: 100 }], running: [{ image: canvas(true), ms: 100 }] }, key: false, filter: "pixel" })
    expect(pet.layout.cell).toEqual({ width: 20, height: 16 })
    const at = (cell: number, x: number, y: number) => pet.sheet.rgba[((y) * pet.sheet.width + cell * pet.layout.cell.width + x) * 4 + 3]
    const [idle, running] = [pet.layout.states.idle![0]![0], pet.layout.states.running![0]![0]]
    // The block is at the cell's top-left corner in both states; alone, idle's box would have been the block itself.
    expect([at(idle, 0, 0), at(idle, 3, 3), at(idle, 4, 4), at(running, 0, 0), at(running, 3, 3), at(running, 19, 15)]).toEqual([255, 255, 0, 255, 255, 255])
    // Canvases of different sizes are not registered with each other: each state keeps its own box.
    const small = cropImage(canvas(false), { left: 0, top: 0, width: 16, height: 16 })
    const apart = buildImportedPet({ states: { idle: [{ image: small, ms: 100 }], running: [{ image: canvas(true), ms: 100 }] }, key: false, filter: "pixel" })
    const corner = apart.sheet.rgba[(apart.layout.states.idle![0]![0] * apart.layout.cell.width) * 4 + 3]
    // Its own 5x4 box, centered across and standing on the bottom edge of the cell: the cell's top-left corner is empty.
    expect([apart.layout.cell, corner]).toEqual([{ width: 20, height: 16 }, 0])
  })

  test("the frame side follows the frame count so the decoded frames stay under 16 MB; past 200 frames it refuses", () => {
    expect(IMPORT_BUDGET.decodedBytes).toBe(16 * 1024 * 1024)
    expect([1, 8, 9, 15, 16, 30, 33, 34, 60, 61, 135, 136, 200].map(frameSide)).toEqual([704, 704, 528, 528, 352, 352, 352, 264, 264, 176, 176, 128, 128])
    for (const frames of [1, 8, 15, 30, 33, 60, 135, 200]) expect(frames * frameSide(frames) ** 2 * 4).toBeLessThanOrEqual(IMPORT_BUDGET.decodedBytes)
    // One frame more at each step would not fit at the larger side.
    for (const frames of [9, 16, 34, 61, 136]) expect(frames * FRAME_SIDES[FRAME_SIDES.indexOf(frameSide(frames) as never) - 1]! ** 2 * 4).toBeGreaterThan(IMPORT_BUDGET.decodedBytes)
    expect(() => frameSide(201)).toThrow("at most 200")
    const big = resample(smooth, 800, 800, "smooth")
    const many = buildImportedPet({ states: { idle: Array.from({ length: 20 }, (_, index) => ({ image: index % 2 ? big : resample(sharpenImage(smooth, 0.2), 800, 800, "smooth"), ms: 80 })) } })
    expect(Math.max(many.layout.cell.width, many.layout.cell.height)).toBe(352)
    expect(many.layout.states.idle).toHaveLength(20)
    // Twenty frames, two different pictures: two cells.
    expect(many.decodedBytes).toBe(2 * many.layout.cell.width * many.layout.cell.height * 4)
  })

  test("a pet of all eleven states with 30 frames keeps 352 pixels, and its sheet and layout stay inside every bound", () => {
    // Thirty different 345x352 pictures: three for idle, running and waiting, then three or two for each other state.
    const counts: Record<(typeof PET_STATES)[number], number> = { idle: 3, running: 3, waiting: 3, review: 3, failed: 3, waving: 3, jumping: 3, thinking: 3, compacting: 2, agents: 2, sleeping: 2 }
    let made = 0
    const states = Object.fromEntries(PET_STATES.map((state) => [state, Array.from({ length: counts[state] }, () => ({ image: solid(345, 352, [made++ * 8, 90, 200, 255]), ms: 100 }))]))
    const pet = buildImportedPet({ states, key: false })
    expect(pet).toMatchObject({ frames: 30, side: 352, decodedBytes: 30 * 345 * 352 * 4 })
    expect(pet.decodedBytes).toBeLessThanOrEqual(IMPORT_BUDGET.decodedBytes)
    expect(pet.layout).toMatchObject({ cell: { width: 345, height: 352 }, columns: 6 })
    expect(pet.sheet).toMatchObject({ width: 6 * 345, height: 5 * 352 })
    expect(Math.max(pet.sheet.width, pet.sheet.height)).toBeLessThanOrEqual(MAX_SHEET_SIDE)
    expect(Object.keys(pet.layout.states)).toEqual([...PET_STATES])
    expect(new Set(Object.values(pet.layout.states).flat().map(([cell]) => cell)).size).toBe(30)
    expect(30).toBeLessThanOrEqual(PET_LAYOUT_LIMITS.cells)
    // What the daemon writes is what the terminal's loader reads back.
    expect(readPetLayout(JSON.parse(JSON.stringify(pet.layout)))).toEqual(pet.layout)
  })

  test("the states only an import brings are never a sheet row, and the largest sheet of every frame count fits", () => {
    expect([...PET_GENERATED_STATES]).toEqual(["idle", "running", "waiting", "review", "failed", "waving", "jumping"])
    expect([...PET_STATES]).toEqual([...PET_GENERATED_STATES, "thinking", "compacting", "agents", "sleeping"])
    const rows = splitSheet(solid(8, 28, [1, 2, 3, 255]), 2, 7)
    expect(Object.keys(rows)).toEqual([...PET_GENERATED_STATES])
    expect(() => splitSheet(solid(8, 32, [1, 2, 3, 255]), 2, 8)).toThrow("at most 7 rows (idle, running, waiting, review, failed, waving, jumping)")
    // Cells are at most the frame side, laid out near a square: no count within the budget reaches the sheet's limit.
    for (let frames = 1; frames <= IMPORT_BUDGET.frames; frames++) expect(Math.ceil(Math.sqrt(frames)) * frameSide(frames)).toBeLessThanOrEqual(2112)
    expect(2112).toBeLessThan(MAX_SHEET_SIDE)
  })

  test("folder and file names: the four new states and their aliases, and no older name moved except thinking", () => {
    expect(Object.fromEntries(["thinking", "think", "reasoning", "compacting", "compact", "packing", "agents", "agent", "subagents", "delegating", "sleeping", "sleep", "asleep"].map((name) => [name, PET_STATE_NAMES[name]]))).toEqual({
      thinking: "thinking", think: "thinking", reasoning: "thinking", compacting: "compacting", compact: "compacting", packing: "compacting",
      agents: "agents", agent: "agents", subagents: "agents", delegating: "agents", sleeping: "sleeping", sleep: "sleeping", asleep: "sleeping",
    })
    expect(Object.fromEntries(["idle", "rest", "default", "running", "working", "typing", "busy", "waiting", "approval", "asking", "failed", "error", "sad", "review", "done", "happy", "success", "waving", "wave", "hello", "jumping", "jump", "celebrate"].map((name) => [name, PET_STATE_NAMES[name]]))).toEqual({
      idle: "idle", rest: "idle", default: "idle", running: "running", working: "running", typing: "running", busy: "running", waiting: "waiting", approval: "waiting", asking: "waiting",
      failed: "failed", error: "failed", sad: "failed", review: "review", done: "review", happy: "review", success: "review", waving: "waving", wave: "waving", hello: "waving", jumping: "jumping", jump: "jumping", celebrate: "jumping",
    })
    for (const state of PET_STATES) expect(PET_STATE_NAMES[state]).toBe(state)
  })

  test("a state without idle gets a still idle; frames of unequal size, an empty picture and nothing at all are refused", () => {
    const pet = buildImportedPet({ states: { running: [{ image: pixel, ms: 90 }, { image: sampleSprite({ eyes: "closed" }), ms: 90 }] } })
    expect(pet.layout.states.idle).toEqual([[0, IMPORT_FRAME_MS]])
    expect(pet.layout.states.running).toEqual([[0, 90], [1, 90]])
    expect(() => buildImportedPet({ states: { idle: [{ image: pixel, ms: 90 }, { image: smooth, ms: 90 }] } })).toThrow("differ in size")
    expect(() => buildImportedPet({ states: { idle: [{ image: { width: 8, height: 8, rgba: new Uint8Array(256) }, ms: 90 }] } })).toThrow("empty")
    expect(() => buildImportedPet({ states: {} })).toThrow("nothing to import")
  })

  test("a flat background is keyed unless asked not to; the filter can be forced; frame times are clamped", () => {
    const flat = onBackground(pixel, [255, 0, 255])
    expect(buildImportedPet({ states: { idle: [{ image: flat, ms: 1 }] } })).toMatchObject({ keyed: true, layout: { cell: { width: contentBox(pixel)!.width }, states: { idle: [[0, 20]] } } })
    expect(buildImportedPet({ states: { idle: [{ image: flat, ms: 99_999 }] }, key: false })).toMatchObject({ keyed: false, layout: { cell: { width: 64, height: 64 }, states: { idle: [[0, 10_000]] } } })
    expect(buildImportedPet({ states: { idle: [{ image: pixel, ms: 100 }] }, filter: "smooth" }).layout.art).toBe("smooth")
  })

  test("a layout that is not one is not read", () => {
    const good = { art: "pixel", cell: { width: 8, height: 8 }, columns: 1, states: { idle: [[0, 100]] } }
    expect(readPetLayout(good)).toEqual(good as never)
    // A pet stored before the import-only states reads as it did; one with them keeps them; a name that is no state is dropped.
    const old = { ...good, states: { idle: [[0, 100]], running: [[0, 90]], jumping: [[0, 80]] } }
    expect(readPetLayout(old)).toEqual(old as never)
    const full = { ...good, states: { idle: [[0, 100]], thinking: [[0, 90]], compacting: [[0, 90]], agents: [[0, 90]], sleeping: [[0, 900]] } }
    expect(readPetLayout(full)).toEqual(full as never)
    expect(readPetLayout({ ...good, states: { idle: [[0, 100]], dancing: [[0, 90]] } })).toEqual(good as never)
    expect(readPetLayout({ ...good, states: { idle: [[0, 100]], sleeping: [] } })).toBeUndefined()
    for (const bad of [undefined, {}, { ...good, art: "vector" }, { ...good, cell: { width: 0, height: 8 } }, { ...good, cell: { width: 5000, height: 8 } }, { ...good, states: {} }, { ...good, states: { idle: [] } }, { ...good, states: { idle: [[0, 1]] } }, { ...good, states: { idle: [[-1, 100]] } }, { ...good, states: { idle: [[0.5, 100]] } }, { ...good, states: { idle: "x" } }]) expect(readPetLayout(bad)).toBeUndefined()
  })
})

describe("the GIF decoder", () => {
  const palette = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]]
  const pixelAt = (image: PetImage, x: number, y: number) => [...image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)]

  test("frames, their delays (0 and 1 hundredths read as a tenth of a second) and the palette", () => {
    const gif = encodeGif({ width: 3, height: 2, palette, frames: [{ indexes: new Uint8Array([1, 2, 3, 3, 2, 1]), delayCs: 7 }, { indexes: new Uint8Array([2, 2, 2, 2, 2, 2]), delayCs: 0 }, { indexes: new Uint8Array([3, 3, 3, 3, 3, 3]), delayCs: 150 }] })
    expect(isGif(gif)).toBe(true)
    const frames = decodeGif(gif)
    expect(frames.map((frame) => frame.ms)).toEqual([70, 100, 1500])
    expect([pixelAt(frames[0]!.image, 0, 0), pixelAt(frames[0]!.image, 2, 1), pixelAt(frames[1]!.image, 1, 1)]).toEqual([[255, 0, 0, 255], [255, 0, 0, 255], [0, 255, 0, 255]])
  })

  test("long runs and noise decode exactly through code sizes up to 12 bits and a table reset", () => {
    const [width, height] = [96, 96]
    const indexes = new Uint8Array(width * height)
    let seed = 7
    for (let at = 0; at < indexes.length; at++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      // Half runs, half noise: both the string table and its reset are used.
      indexes[at] = at % 512 < 256 ? (at >> 6) & 3 : (seed >> 16) & 3
    }
    const [frame] = decodeGif(encodeGif({ width, height, palette, frames: [{ indexes, delayCs: 5 }] }))
    for (let at = 0; at < indexes.length; at++) expect(frame!.image.rgba[at * 4 + (indexes[at] === 1 ? 0 : indexes[at] === 2 ? 1 : 2)]).toBe(indexes[at] === 0 ? 0 : 255)
  })

  test("transparency, a partial frame and the three disposal methods compose as a viewer shows them", () => {
    const full = (index: number) => new Uint8Array(16).fill(index)
    const gif = encodeGif({ width: 4, height: 4, palette, frames: [
      { indexes: full(1), delayCs: 10, disposal: 1 },
      // A 2x2 patch at (1,1) with one transparent pixel, then restored to the background (transparent).
      { indexes: new Uint8Array([2, 0, 2, 2]), delayCs: 10, left: 1, top: 1, width: 2, height: 2, transparent: 0, disposal: 2 },
      // A patch that is taken back: the next frame sees what was there before it.
      { indexes: new Uint8Array([3, 3, 3, 3]), delayCs: 10, left: 0, top: 0, width: 2, height: 2, disposal: 3 },
      { indexes: new Uint8Array([2]), delayCs: 10, left: 3, top: 3, width: 1, height: 1 },
    ] })
    const frames = decodeGif(gif).map((frame) => frame.image)
    expect(pixelAt(frames[1]!, 1, 1)).toEqual([0, 255, 0, 255])
    expect(pixelAt(frames[1]!, 2, 1)).toEqual([255, 0, 0, 255])
    expect(pixelAt(frames[2]!, 1, 1)).toEqual([0, 0, 255, 255])
    expect(pixelAt(frames[2]!, 2, 2)).toEqual([0, 0, 0, 0])
    expect(pixelAt(frames[3]!, 0, 0)).toEqual([255, 0, 0, 255])
    expect(pixelAt(frames[3]!, 1, 1)).toEqual([0, 0, 0, 0])
    expect(pixelAt(frames[3]!, 3, 3)).toEqual([0, 255, 0, 255])
  })

  test("an interlaced frame and a local palette", () => {
    const indexes = new Uint8Array(4 * 10)
    for (let y = 0; y < 10; y++) indexes.fill(y % 2, y * 4, y * 4 + 4)
    const [frame] = decodeGif(encodeGif({ width: 4, height: 10, palette, frames: [{ indexes, delayCs: 4, interlaced: true, palette: [[9, 9, 9], [200, 100, 50]] }] }))
    for (let y = 0; y < 10; y++) expect(pixelAt(frame!.image, 2, y)).toEqual(y % 2 ? [200, 100, 50, 255] : [9, 9, 9, 255])
  })

  test("what is not a GIF, is cut short, too large or too long is refused before it is decoded", () => {
    expect(() => decodeGif(new Uint8Array([1, 2, 3]))).toThrow("bad signature")
    const gif = encodeGif({ width: 3, height: 2, palette, frames: [{ indexes: new Uint8Array(6).fill(1), delayCs: 7 }] })
    expect(() => decodeGif(gif.subarray(0, gif.length - 6))).toThrow(/truncated|no frames/)
    const wide = new Uint8Array(gif)
    wide[6] = 0xff
    wide[7] = 0xff
    expect(() => decodeGif(wide)).toThrow("exceeds 4096px")
    const outside = encodeGif({ width: 3, height: 2, palette, frames: [{ indexes: new Uint8Array(6).fill(1), delayCs: 7, left: 2 }] })
    expect(() => decodeGif(outside)).toThrow("outside the canvas")
    const long = encodeGif({ width: 1, height: 1, palette, frames: Array.from({ length: MAX_GIF_FRAMES + 1 }, () => ({ indexes: new Uint8Array([1]), delayCs: 2 })) })
    expect(() => decodeGif(long)).toThrow(`more than ${MAX_GIF_FRAMES} frames`)
  })
})
