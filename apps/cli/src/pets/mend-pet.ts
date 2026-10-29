import { BEATS, mendImage } from "../view/mend-sprite"
import { artPixels, createFrameCache, spriteCells } from "./art"
import type { CellPixels } from "./frames"
import { PET_SIZES, type PetSize } from "./pet-slot"
import type { PetSprite } from "./sprite"

/**
 * The built-in Mend (MendAscii) as a pet for the image layer: its own pixels, one frame a phase and beat (`mendBeat`), sized by the rule every
 * pet follows (`art.ts`) and scaled to the box's real pixels. A terminal without an image protocol keeps the half-block Mend
 * (`mend-sprite.ts`), whose pixels cannot be smaller than half a cell. Loaded the first time a frame wants the picture.
 */
const sprites = new Map<string, PetSprite>()
const scaled = createFrameCache(4 * 1024 * 1024)

export function mendSprite(phase: string, beat = 0): PetSprite {
  const id = `mend/${phase}/${beat % BEATS}`
  let sprite = sprites.get(id)
  if (!sprite) {
    sprite = { id, rows: new Map([["idle", [mendImage(phase, beat % BEATS)]]]), art: "pixel" }
    sprites.set(id, sprite)
  }
  return sprite
}

/** The cells Mend takes inside `cols` x `rows`, the same for every phase. */
export const mendCells = (cols: number, rows: number) => spriteCells(mendSprite("idle"), cols, rows)

/** The cells Mend takes beside the prompt at `size`: the box every pet of that size gets. */
export const mendChatCells = (size: PetSize) => mendCells(PET_SIZES[size].cols, PET_SIZES[size].rows)

/** Mend for `phase` at `beat` fitted to `cols` x `rows` cells at `cell` pixels each, with the key the image layer keeps it by. */
export function mendPicture(phase: string, cols: number, rows: number, cell: CellPixels, beat = 0): { key: string; image: ReturnType<typeof mendImage> } {
  const sprite = mendSprite(phase, beat)
  const [width, height] = [cols * cell.width, rows * cell.height]
  const key = `${sprite.id}/${cols}x${rows}/${width}x${height}`
  return { key, image: scaled.get(key, () => artPixels(sprite, sprite.rows.get("idle")![0]!, width, height)) }
}
