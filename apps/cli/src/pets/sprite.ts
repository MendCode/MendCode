import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises"
import path from "node:path"
import { PET_IMPORT_STATES, type PetArtKind, type PetLayout } from "../../../../packages/protocol/src/pet-data"
import { contentBox, unionBox, type PixelBox } from "../../../../packages/tools/src/pet-resample"
import type { PetImage } from "./decode"
import { rowFrames, type AtlasRow, type PetRow } from "./frames"
import type { PetInfo } from "./manifest"

/** The atlas rows MendCode shows (running-left/right are for pets that walk across the screen). An imported pet may add the states of `PET_IMPORT_STATES`. */
export const SPRITE_ROWS: readonly AtlasRow[] = ["idle", "running", "waiting", "failed", "review", "waving", "jumping"]

/**
 * Native frames per row; what the prompt draws from once the sheet itself is gone. Equal frames are one object (a still
 * pet is one picture however many atlas cells repeat it), so a row whose frames are all the same object does not move.
 * `timing` and `art` exist for an imported pet: how long each of its frames stays, and which filter resizes it.
 */
export type PetSprite = { id: string; rows: ReadonlyMap<PetRow, readonly PetImage[]>; timing?: ReadonlyMap<PetRow, readonly number[]>; art?: PetArtKind; /** The box every frame's content fits, measured when the cache was written. */ box?: PixelBox }
type Baked = { rows: Map<PetRow, PetImage[]>; timing?: Map<PetRow, number[]>; box?: PixelBox }

const FORMAT = 4

/** Frames kept inflated at once; the rest stay compressed until drawn again (a 30-frame 352-pixel pet is 14 MB inflated, 3.7 compressed). */
const INFLATED_FRAMES = 4
const inflated: Array<{ frame: object; drop(): void }> = []

/**
 * A frame whose pixels stay compressed until something reads them. The last `INFLATED_FRAMES` read keep theirs; an older
 * one inflates again on its next read (about a millisecond for a 352-pixel frame). The pet slot keeps its scaled frames
 * separately, so a playing animation reads native pixels only when the box or the cell size changes.
 */
function packedImage(width: number, height: number, packed: Uint8Array<ArrayBuffer>): PetImage {
  let rgba: Uint8Array | undefined
  const frame = { width, height } as PetImage
  Object.defineProperty(frame, "rgba", {
    enumerable: true,
    get() {
      if (rgba) return rgba
      const pixels = Bun.inflateSync(packed)
      if (pixels.byteLength !== width * height * 4) throw new Error("[PETS]: sprite cache frame has the wrong size")
      rgba = pixels
      inflated.push({ frame, drop: () => void (rgba = undefined) })
      while (inflated.length > INFLATED_FRAMES) inflated.shift()!.drop()
      return rgba
    },
  })
  return frame
}

const sameImage = (a: PetImage, b: PetImage) => a === b || (a.width === b.width && a.height === b.height && Buffer.compare(a.rgba, b.rgba) === 0)

/** Frames of the shown rows, cut from a decoded sheet: the Codex atlas, or the cells an imported pet's layout names. */
export function bakeSprite(sheet: PetImage, layout?: PetLayout): Map<PetRow, PetImage[]> {
  return bake(sheet, layout).rows
}

function bake(sheet: PetImage, layout?: PetLayout): Baked {
  if (!layout) return { rows: new Map(SPRITE_ROWS.map((row) => [row, rowFrames(sheet, row)])) }
  const { cell, columns } = layout
  const cells = new Map<number, PetImage>()
  const cut = (index: number) => {
    let image = cells.get(index)
    if (image) return image
    const left = (index % columns) * cell.width, top = Math.floor(index / columns) * cell.height
    if (left + cell.width > sheet.width || top + cell.height > sheet.height) throw new RangeError(`[PETS]: cell ${index} is outside the sheet`)
    image = { width: cell.width, height: cell.height, rgba: new Uint8Array(cell.width * cell.height * 4) }
    for (let y = 0; y < cell.height; y++) image.rgba.set(sheet.rgba.subarray(((top + y) * sheet.width + left) * 4, ((top + y) * sheet.width + left + cell.width) * 4), y * cell.width * 4)
    cells.set(index, image)
    return image
  }
  const rows = new Map<PetRow, PetImage[]>()
  const timing = new Map<PetRow, number[]>()
  for (const row of [...SPRITE_ROWS, ...PET_IMPORT_STATES]) {
    const frames = layout.states[row as keyof PetLayout["states"]]
    if (!frames) continue
    rows.set(row, frames.map(([index]) => cut(index)))
    timing.set(row, frames.map(([, ms]) => ms))
  }
  return { rows, timing }
}

/** `[u32 header length][header JSON][each distinct frame's RGBA, deflated on its own]`. Rows name their frames by position in that list. */
export function encodeSprite(rows: ReadonlyMap<PetRow, readonly PetImage[]>, timing?: ReadonlyMap<PetRow, readonly number[]>): Uint8Array<ArrayBuffer> {
  const images: PetImage[] = []
  const position = (frame: PetImage) => {
    const found = images.findIndex((image) => sameImage(image, frame))
    return found >= 0 ? found : images.push(frame) - 1
  }
  const listed = [...rows].map(([row, frames]) => ({ row, frames: frames.map(position), ...(timing?.get(row) ? { ms: timing.get(row) } : {}) }))
  const packed = images.map((image) => Bun.deflateSync(image.rgba as Uint8Array<ArrayBuffer>))
  // Measured once here, so drawing never has to inflate every frame to find the box they share.
  const box = unionBox(images.map(contentBox))
  const header = new TextEncoder().encode(JSON.stringify({ v: FORMAT, rows: listed, images: images.map((image, index) => [image.width, image.height, packed[index]!.byteLength]), ...(box ? { box } : {}) }))
  const out = new Uint8Array(4 + header.byteLength + packed.reduce((sum, bytes) => sum + bytes.byteLength, 0))
  new DataView(out.buffer).setUint32(0, header.byteLength, true)
  out.set(header, 4)
  let at = 4 + header.byteLength
  for (const bytes of packed) {
    out.set(bytes, at)
    at += bytes.byteLength
  }
  return out
}

function read(bytes: Uint8Array<ArrayBuffer>): Baked {
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as { v: number; rows: Array<{ row: PetRow; frames: number[]; ms?: number[] }>; images: Array<[number, number, number]>; box?: PixelBox }
  if (header.v !== FORMAT) throw new Error("[PETS]: sprite cache format changed")
  let at = 4 + length
  const images = header.images.map(([width, height, size]): PetImage => {
    if (at + size > bytes.byteLength) throw new Error("[PETS]: sprite cache is truncated")
    const packed = bytes.subarray(at, at + size)
    at += size
    return packedImage(width, height, packed)
  })
  const rows = new Map<PetRow, PetImage[]>()
  const timing = new Map<PetRow, number[]>()
  for (const { row, frames, ms } of header.rows) {
    rows.set(row, frames.map((index) => {
      const image = images[index]
      if (!image) throw new Error("[PETS]: sprite cache names a missing frame")
      return image
    }))
    if (ms) timing.set(row, ms)
  }
  return { rows, ...(timing.size > 0 ? { timing } : {}), ...(header.box ? { box: header.box } : {}) }
}

export function decodeSprite(bytes: Uint8Array<ArrayBuffer>): Map<PetRow, PetImage[]> {
  return read(bytes).rows
}

/** Cache file of a pet: changes when its sheet (path, size, mtime) or its layout does. */
export async function spritePath(input: { pet: PetInfo; cacheDir: string }, format = FORMAT) {
  const info = await stat(input.pet.sheetPath)
  const key = Bun.hash(`${input.pet.sheetPath}:${info.size}:${info.mtimeMs}:${format}${input.pet.layout ? `:${JSON.stringify(input.pet.layout)}` : ""}`).toString(36)
  return path.join(input.cacheDir, `${input.pet.id}-${key}.sprite`)
}

/**
 * The pet's frames, from the cache when present. Otherwise the sheet is decoded once and its frames cached: a WebP
 * decoder keeps ~70 MB after use, so only the first run with a new or changed sheet pays it; later runs read the
 * small cache and never load the decoder.
 */
export async function loadSprite(input: { pet: PetInfo; cacheDir: string }): Promise<PetSprite> {
  const file = await spritePath(input)
  if (!(await Bun.file(file).exists())) {
    // A cache in the previous format already holds the frames: rewriting it skips the sheet decoder.
    const legacy = await readLegacy(await spritePath(input, LEGACY_FORMAT))
    await writeSprite({ sheetPath: input.pet.sheetPath, out: file, layout: input.pet.layout, ...(legacy ? { baked: legacy } : {}) })
    await dropStale({ cacheDir: input.cacheDir, id: input.pet.id, keep: file })
  }
  const { rows, timing, box } = read(new Uint8Array(await Bun.file(file).arrayBuffer()))
  return { id: input.pet.id, rows, ...(timing ? { timing } : {}), ...(input.pet.layout ? { art: input.pet.layout.art } : {}), ...(box ? { box } : {}) }
}

const LEGACY_FORMAT = 3

/** The frames of a format-3 cache (`[u32 header length][header JSON][raw RGBA of every frame]`, gzipped as a whole); undefined when it is missing or unreadable. */
async function readLegacy(file: string): Promise<Baked | undefined> {
  try {
    const raw = Bun.gunzipSync(new Uint8Array(await Bun.file(file).arrayBuffer()))
    const length = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true)
    const header = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + length))) as { v: number; rows: Array<{ row: PetRow; frames: number[]; ms?: number[] }>; images: Array<[number, number]> }
    if (header.v !== LEGACY_FORMAT) return undefined
    let at = 4 + length
    const images = header.images.map(([width, height]): PetImage => {
      const size = width * height * 4
      if (at + size > raw.byteLength) throw new Error("[PETS]: sprite cache is truncated")
      const rgba = raw.subarray(at, at + size)
      at += size
      return { width, height, rgba }
    })
    const rows = new Map(header.rows.map(({ row, frames }) => [row, frames.map((index) => images[index]!)] as const))
    const timing = new Map(header.rows.flatMap(({ row, ms }) => (ms ? [[row, ms] as const] : [])))
    return { rows, ...(timing.size > 0 ? { timing } : {}) }
  } catch { return undefined }
}

/** Removes a pet's caches for an older sheet, layout or format: only the current one is ever read again. */
async function dropStale(input: { cacheDir: string; id: string; keep: string }) {
  const names = await readdir(input.cacheDir).catch(() => [] as string[])
  for (const name of names) if (name.startsWith(`${input.id}-`) && name.endsWith(".sprite") && path.join(input.cacheDir, name) !== input.keep) await unlink(path.join(input.cacheDir, name)).catch(() => undefined)
}

let writes = 0

/** Writes the cache atomically: from frames already baked, or by decoding the sheet. */
async function writeSprite(input: { sheetPath: string; out: string; layout: PetLayout | undefined; baked?: Baked }) {
  await mkdir(path.dirname(input.out), { recursive: true })
  // One temporary file per write: the start screen and the prompt's pet load the same pet at once, and with one name per process
  // the second rename found the file already moved, and that pet showed as not installed.
  const tmp = `${input.out}.${process.pid}.${++writes}.tmp`
  const baked = input.baked ?? bake(await (await import("./decode")).decodeSheet(input.sheetPath), input.layout)
  await Bun.write(tmp, encodeSprite(baked.rows, baked.timing))
  await rename(tmp, input.out)
}
