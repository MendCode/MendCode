import { createHash } from "node:crypto"
import { PET_GENERATED_STATES, PET_LAYOUT_LIMITS, PET_STATES, type PetArtKind, type PetLayout, type PetState } from "../../protocol/src/pet-data"
import { MAX_SHEET_SIDE, type PetImage } from "./pet-decode"
import { artKind, contentBox, cropImage, fitSize, keyBackground, pixelScale, resample, shrinkExact, unionBox, type PixelBox } from "./pet-resample"

export type ImportFrame = { image: PetImage; ms: number }
export type ImportSource = Partial<Record<PetState, ImportFrame[]>>

/** How long a frame stays when its source gives no timing (a PNG sequence, a sprite sheet). */
export const IMPORT_FRAME_MS = 120
/**
 * The budget of one imported pet. Its frames are held decoded while it shows, so their RGBA together stay under
 * `decodedBytes`; the frame side is the largest of `FRAME_SIDES` that keeps them there. 704 is the largest start-screen box
 * (22 rows) at 16 pixels a row, doubled for dense displays; a long animation steps down to what its frame count affords.
 * 16 MB keeps 352 pixels up to 33 frames, so a pet with all eleven states still has about three frames a state at that size;
 * the sheet of any count within it is at most 2112 pixels a side (`MAX_SHEET_SIDE` is 4096).
 */
export const IMPORT_BUDGET = { decodedBytes: 16 * 1024 * 1024, frames: 200, storedBytes: 25 * 1024 * 1024 } as const
export const FRAME_SIDES = [704, 528, 352, 264, 176, 128, 96] as const

/** The largest frame side whose `frames` copies fit the decoded budget. */
export function frameSide(frames: number): number {
  if (frames > IMPORT_BUDGET.frames) throw new RangeError(`[PETS]: ${frames} frames; an imported pet holds at most ${IMPORT_BUDGET.frames}`)
  return FRAME_SIDES.find((side) => frames * side * side * 4 <= IMPORT_BUDGET.decodedBytes) ?? FRAME_SIDES[FRAME_SIDES.length - 1]!
}

/** A sprite sheet cut into `columns` x `rows` equal cells: each row is one state in the order of `PET_GENERATED_STATES`, each column a frame. */
export function splitSheet(image: PetImage, columns: number, rows: number, ms = IMPORT_FRAME_MS): ImportSource {
  if (![columns, rows].every((n) => Number.isInteger(n) && n >= 1 && n <= 64)) throw new RangeError("[PETS]: --frames needs COLSxROWS, each 1 to 64")
  if (rows > PET_GENERATED_STATES.length) throw new RangeError(`[PETS]: a sheet has at most ${PET_GENERATED_STATES.length} rows (${PET_GENERATED_STATES.join(", ")})`)
  if (image.width % columns !== 0 || image.height % rows !== 0) throw new RangeError(`[PETS]: ${image.width}x${image.height} does not divide into ${columns}x${rows} equal frames`)
  const width = image.width / columns, height = image.height / rows
  const out: ImportSource = {}
  for (let row = 0; row < rows; row++) out[PET_GENERATED_STATES[row]!] = Array.from({ length: columns }, (_, column) => ({ image: cropImage(image, { left: column * width, top: row * height, width, height }), ms }))
  return out
}

export type ImportedPet = { sheet: PetImage; layout: PetLayout; keyed: boolean; frames: number; side: number; decodedBytes: number }

/**
 * Source frames to a pet sheet: the background keyed out, each state cropped to what it draws (one box per state, so its
 * frames stay registered; one box for all the states when they share a canvas size, so the states stay registered too),
 * scaled to the budget's frame side with the filter of the art's kind, equal frames stored once.
 * A picture is never enlarged: a small one is kept at its own size.
 */
export function buildImportedPet(input: { states: ImportSource; key?: boolean; filter?: PetArtKind }): ImportedPet {
  const given = PET_STATES.flatMap((state) => (input.states[state]?.length ? [[state, input.states[state]!] as const] : []))
  const first = given[0]?.[1][0]
  if (!first) throw new TypeError("[PETS]: nothing to import")
  const total = given.reduce((sum, [, frames]) => sum + frames.length, 0)
  const side = frameSide(total)
  const kind = input.filter ?? artKind(first.image)
  let keyed = false

  const prepared = given.map(([state, frames]) => {
    const { width, height } = frames[0]!.image
    if (frames.some((frame) => frame.image.width !== width || frame.image.height !== height)) throw new RangeError(`[PETS]: the frames of ${state} differ in size`)
    const enlarged = kind === "pixel" ? frames.reduce((scale, frame) => Math.min(scale, pixelScale(frame.image)), Number.POSITIVE_INFINITY) : 1
    const images = frames.map((frame) => {
      const cut = input.key === false ? { image: frame.image } : keyBackground(frame.image, kind)
      if (cut.color) keyed = true
      return shrinkExact(cut.image, width % enlarged === 0 && height % enlarged === 0 ? enlarged : 1)
    })
    const box = unionBox(images.map(contentBox))
    return { state, frames, images, box }
  }).filter((entry): entry is typeof entry & { box: PixelBox } => entry.box !== undefined)
  if (prepared.length === 0) throw new TypeError("[PETS]: the picture is empty (fully transparent)")
  // States drawn on one canvas are registered with each other: one box for all, so the character keeps its size and place from state to state.
  const canvas = prepared[0]!.images[0]!
  if (prepared.length > 1 && prepared.every((entry) => entry.images[0]!.width === canvas.width && entry.images[0]!.height === canvas.height)) {
    const shared = unionBox(prepared.map((entry) => entry.box))!
    for (const entry of prepared) entry.box = shared
  }

  const sized = prepared.map((entry) => ({ ...entry, size: Math.max(entry.box.width, entry.box.height) <= side ? { width: entry.box.width, height: entry.box.height } : fitSize(entry.box, side, side, kind) }))
  const cell = { width: Math.max(...sized.map((entry) => entry.size.width)), height: Math.max(...sized.map((entry) => entry.size.height)) }
  const cells: Uint8Array[] = []
  const seen = new Map<string, number>()
  const states: PetLayout["states"] = {}
  for (const { state, frames, images, box, size } of sized) {
    states[state] = images.map((image, index) => {
      const scaled = resample(cropImage(image, box), size.width, size.height, kind)
      // Centered across, standing on the bottom edge of the cell.
      const rgba = new Uint8Array(cell.width * cell.height * 4)
      const left = Math.floor((cell.width - size.width) / 2), top = cell.height - size.height
      for (let y = 0; y < size.height; y++) rgba.set(scaled.rgba.subarray(y * size.width * 4, (y + 1) * size.width * 4), ((top + y) * cell.width + left) * 4)
      const hash = createHash("sha1").update(rgba).digest("hex")
      let at = seen.get(hash)
      if (at === undefined) {
        at = cells.length
        seen.set(hash, at)
        cells.push(rgba)
      }
      const ms = Math.round(Math.min(PET_LAYOUT_LIMITS.frameMs.max, Math.max(PET_LAYOUT_LIMITS.frameMs.min, frames[index]!.ms)))
      return [at, ms] as [number, number]
    })
  }
  // A pet always has an idle state: without one, the first frame of the first state it has stands still.
  if (!states.idle) states.idle = [[states[sized[0]!.state]![0]![0], IMPORT_FRAME_MS]]

  const across = Math.floor(MAX_SHEET_SIDE / cell.width)
  const columns = Math.max(1, Math.min(cells.length, across, Math.ceil(Math.sqrt(cells.length))))
  const rows = Math.ceil(cells.length / columns)
  if (cells.length > PET_LAYOUT_LIMITS.cells || rows * cell.height > MAX_SHEET_SIDE) throw new RangeError("[PETS]: too many frames for one sheet")
  const sheet: PetImage = { width: columns * cell.width, height: rows * cell.height, rgba: new Uint8Array(columns * cell.width * rows * cell.height * 4) }
  cells.forEach((rgba, index) => {
    const left = (index % columns) * cell.width, top = Math.floor(index / columns) * cell.height
    for (let y = 0; y < cell.height; y++) sheet.rgba.set(rgba.subarray(y * cell.width * 4, (y + 1) * cell.width * 4), ((top + y) * sheet.width + left) * 4)
  })
  return { sheet, layout: { art: kind, cell, columns, states }, keyed, frames: total, side, decodedBytes: cells.length * cell.width * cell.height * 4 }
}
