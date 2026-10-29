import type { PetArtKind } from "../../../../packages/protocol/src/pet-data"
import { artKind, contentBox, cropImage, fitImage, fitSize, pixelScale, sharpenImage, shrinkExact, unionBox, type PixelBox } from "../../../../packages/tools/src/pet-resample"
import type { Line } from "../ui/theme"
import type { PetImage } from "./decode"
import { rowOrFallback, type PetRow } from "./frames"
import { toHalfBlocks } from "./halfblock"
import type { PetSprite } from "./sprite"

/**
 * A pet's frames at another size, by the kind of its art (`pet-resample.ts`): the start screen and an imported pet beside
 * the prompt draw through here. The prompt's Codex pets keep their own exact integer fit (`frames.ts`).
 */
const kinds = new WeakMap<PetSprite, PetArtKind>()
const boxes = new WeakMap<PetSprite, PixelBox>()

/** How much a reduced smooth picture is sharpened for half blocks: an averaged 30-pixel face needs its edges back. */
const HALF_BLOCK_SHARPEN = 1

export function spriteArt(sprite: PetSprite): PetArtKind {
  let kind = sprite.art ?? kinds.get(sprite)
  if (!kind) {
    const first = sprite.rows.get("idle")?.[0]
    kind = first ? artKind(first) : "smooth"
    kinds.set(sprite, kind)
  }
  return kind
}

/** The one box every frame is cut to, so the character does not jump between frames: what any of them draws. */
export function spriteBox(sprite: PetSprite): PixelBox {
  let box = sprite.box ?? boxes.get(sprite)
  if (!box) {
    const distinct = new Set([...sprite.rows.values()].flat())
    const first = sprite.rows.get("idle")?.[0]
    box = unionBox([...distinct].map(contentBox)) ?? { left: 0, top: 0, width: first?.width ?? 1, height: first?.height ?? 1 }
    boxes.set(sprite, box)
  }
  return box
}

/** Whether the pet has frames of its own for a row. */
export function spriteHas(sprite: PetSprite, row: PetRow): boolean {
  return (sprite.rows.get(row)?.length ?? 0) > 0
}

/**
 * The frames a row plays, and how long each stays: nothing when they are all one picture. A state only an import brings
 * falls back to its stand-in first (`PET_ROW_FALLBACK`: thinking, compacting and agents to running, sleeping to idle); a row
 * the pet still lacks is idle.
 */
export function spriteFrames(sprite: PetSprite, row: PetRow): { frames: readonly PetImage[]; row: PetRow } {
  const shown = rowOrFallback(row, (of) => spriteHas(sprite, of))
  const frames = sprite.rows.get(shown)
  return frames?.length ? { frames, row: shown } : { frames: sprite.rows.get("idle") ?? [], row: "idle" }
}

export function spriteDurations(sprite: PetSprite, row: PetRow): readonly number[] | undefined {
  const { frames, row: shown } = spriteFrames(sprite, row)
  if (frames.every((frame) => frame === frames[0])) return []
  return sprite.timing?.get(shown)
}

/** The cells a pet takes inside `cols` x `rows`: as tall as allowed, as wide as its own proportions need (a cell is two pixels tall). */
export function spriteCells(sprite: PetSprite, cols: number, rows: number): { cols: number; rows: number } {
  const box = spriteBox(sprite)
  const size = fitSize(box, cols, restingHeight(sprite, box, rows * 2), "smooth")
  return { cols: Math.max(1, size.width), rows: Math.max(1, Math.ceil(size.height / 2)) }
}

/**
 * Every pet stands this share of its box's height at rest, whatever its sheet's margins: the built-in Mend, a Codex atlas pet
 * and one made with `/pet import` are the same height beside the prompt, on the start screen and in `/pet`. The rest of the
 * box is the room its other frames reach past the resting figure (a jump, a raised arm); a pet whose frames reach further
 * than that fits them all and stands lower.
 */
const RESTING_SHARE = 0.75
const restingBoxes = new WeakMap<PetSprite, PixelBox | undefined>()
const evenRows = (halfRows: number) => Math.max(2, Math.round(halfRows / 2) * 2)

/** The half rows (whole rows) a pet takes in `height` so that its idle frames stand `RESTING_SHARE` of it. */
function restingHeight(sprite: PetSprite, box: PixelBox, height: number): number {
  if (!restingBoxes.has(sprite)) restingBoxes.set(sprite, unionBox((sprite.rows.get("idle") ?? []).map(contentBox)))
  const resting = restingBoxes.get(sprite)
  if (!resting) return height
  return Math.min(height, evenRows((evenRows(height * RESTING_SHARE) * box.height) / resting.height))
}

/** One frame as `rows` lines of `cols` half blocks, resized with the filter of its kind; `bottom` stands what it draws on the last row. */
export function artLines(sprite: PetSprite, frame: PetImage, cols: number, rows: number, align?: "bottom"): Line[] {
  const kind = spriteArt(sprite)
  const cut = cropImage(frame, spriteBox(sprite))
  const fitted = fitImage(cut, cols, rows * 2, kind)
  const reduced = kind === "smooth" && Math.max(cut.width / cols, cut.height / (rows * 2)) >= 2
  return toHalfBlocks(reduced ? sharpenImage(fitted, HALF_BLOCK_SHARPEN) : fitted, cols, rows, align)
}

/**
 * Scaled frames kept for the image layer, least recently used first out, at most `maxBytes` of RGBA. The terminal keeps an
 * uploaded image by id, so a frame is needed again only after a resize or a cleared screen; this bounds what waits for that.
 */
export function createFrameCache(maxBytes: number) {
  const kept = new Map<string, PetImage>()
  let bytes = 0
  return {
    get(key: string, make: () => PetImage): PetImage {
      let image = kept.get(key)
      if (image) kept.delete(key)
      else {
        image = make()
        bytes += image.rgba.byteLength
      }
      kept.set(key, image)
      for (const [old, oldImage] of kept) {
        if (bytes <= maxBytes || old === key) break
        kept.delete(old)
        bytes -= oldImage.rgba.byteLength
      }
      return image
    },
    clear() {
      kept.clear()
      bytes = 0
    },
    get bytes() { return bytes },
  }
}

/** One frame as the exact `width` x `height` pixels of a graphics box (soft alpha kept): what the image layer sends as it is. */
export function artPixels(sprite: PetSprite, frame: PetImage, width: number, height: number): PetImage {
  const kind = spriteArt(sprite)
  const cut = cropImage(frame, spriteBox(sprite))
  return fitImage(kind === "pixel" ? nativePixels(sprite, cut) : cut, width, height, kind)
}

/** How far half blocks may shrink a pet's own pixels and still draw it: a 64-pixel character reads at 26 half rows, at 16 it is noise. */
const HALF_BLOCK_MAX_SHRINK = 3

/** Whether half blocks in `cols` x `rows` draw the pet legibly: its own pixels (a sheet's enlargement undone) need not shrink much. */
export function halfBlockLegible(sprite: PetSprite, cols: number, rows: number): boolean {
  const cut = cropImage(sprite.rows.get("idle")?.[0] ?? { width: 1, height: 1, rgba: new Uint8Array(4) }, spriteBox(sprite))
  const native = spriteArt(sprite) === "pixel" ? nativePixels(sprite, cut) : cut
  return Math.max(native.width / cols, native.height / (rows * 2)) <= HALF_BLOCK_MAX_SHRINK
}

const nativeScales = new WeakMap<PetSprite, number>()

/**
 * A pixel pet's frame at one pixel a pixel. A Codex sheet draws its pixels several screen pixels wide (6 for MendSprite), and
 * whole enlargement steps counted from those would leave it at the sheet's own size in a box up to twice that.
 */
function nativePixels(sprite: PetSprite, cut: PetImage): PetImage {
  let scale = nativeScales.get(sprite)
  if (scale === undefined) {
    scale = pixelScale(cut)
    nativeScales.set(sprite, scale)
  }
  return scale > 1 && cut.width % scale === 0 && cut.height % scale === 0 ? shrinkExact(cut, scale) : cut
}
