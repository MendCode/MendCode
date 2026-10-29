import type { ForegroundState } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { artLines, artPixels, createFrameCache, halfBlockLegible, spriteCells, spriteDurations, spriteFrames, spriteHas } from "./art"
import { createPetController, type PetSignals } from "./controller"
import type { PetImage } from "./decode"
import { DEFAULT_CELL_PIXELS, type CellPixels, type PetRow } from "./frames"
import { listPets, type PetInfo, type PetSource } from "./manifest"
import { loadSprite, type PetSprite } from "./sprite"

/** The session box of each `petSize`, in cells, for the image layer; an imported pet takes the part of it its own proportions need. */
export const PET_SIZES = { small: { cols: 10, rows: 5 }, medium: { cols: 16, rows: 8 }, large: { cols: 24, rows: 12 } } as const
/** The same sizes in half blocks, which reserve more cells using the same raster rule. */
export const PET_HALF_BLOCK_SIZES = { small: { cols: 15, rows: 8 }, medium: { cols: 24, rows: 13 }, large: { cols: 36, rows: 20 } } as const
export type PetSize = keyof typeof PET_SIZES
/** Graphics box next to the prompt at the default size. */
export const PET_BOX: { cols: number; rows: number } = PET_SIZES.small
/**
 * Scaled frames of an imported pet kept for the image layer (RGBA bytes). Enough for the 30 frames a pet of every state has
 * at the medium box on a dense display (7.5 MB) and nearly the large one (16.9 MB): a frame that fell out is resized again
 * every loop, 20 to 50 ms each. It holds only what the pet's frames need: 1.9 MB for those 30 at 8 by 16 pixels a cell.
 */
const SCALED_BYTES = 16 * 1024 * 1024

export type PetDirs = Array<{ dir: string; source: PetSource }>

/** A Codex atlas pet beside the prompt and in `/pet` is enlarged by whole pixels, so it stays crisp; an imported pet keeps the kind it was imported as. */
const asPixelArt = (sprite: PetSprite): PetSprite => (sprite.art ? sprite : { ...sprite, art: "pixel" })
export type PetDraw = { lines: Line[]; cols: number; rows: number; image?: { key: string; image: PetImage } }

/**
 * The pet shown next to the prompt: which one, its frames and its animation. The app imports this module only when a
 * pet is configured, so an unset pet costs no import, no timer and no decode.
 */
export function createPetSlot(input: { dirs: PetDirs; cacheDir: string; now(): number; reducedMotion(): boolean; onChange(): void; say(message: string): void }) {
  let sprite: PetSprite | undefined
  let chosen: string | undefined
  let visible = false
  const art = new Map<string, Line[]>()
  const scaled = createFrameCache(SCALED_BYTES)
  const controller = createPetController({ now: input.now, animate: () => visible && !input.reducedMotion() && sprite !== undefined, onChange: input.onChange, durations: (row) => (sprite ? spriteDurations(sprite, row) : undefined), has: (row) => sprite !== undefined && spriteHas(sprite, row) })

  function frameOf(row: PetRow, index: number): PetImage | undefined {
    const frames = sprite ? spriteFrames(sprite, row).frames : undefined
    return frames?.[Math.min(index, frames.length - 1)]
  }

  return {
    /** Loads the pet named by the setting (`codex:<id>` / `user:<id>`); "off" or unset hides it. */
    async choose(ref: string | undefined) {
      if (ref === chosen) return
      chosen = ref
      sprite = undefined
      controller.cancelCheer()
      art.clear()
      scaled.clear()
      if (!ref || ref === "off") return input.onChange()
      const { pets } = await listPets(input.dirs)
      const pet = pets.find((candidate) => candidate.ref === ref)
      if (!pet) return input.say("pet not found")
      const loaded = await loadSprite({ pet, cacheDir: input.cacheDir }).catch(() => undefined)
      if (chosen !== ref) return
      if (!loaded) return input.say(`pet ${pet.displayName} could not be loaded`)
      sprite = asPixelArt(loaded)
      controller.cheer("waving")
      input.onChange()
    },
    /** What the session is doing: its foreground state, plus the item in flight and its sub-agents (`ui/app/pet-follow.ts`). */
    setForeground(foreground: ForegroundState, signals?: PetSignals) {
      controller.setForeground(foreground, signals)
    },
    cheer(row: "waving" | "jumping") {
      if (sprite) controller.cheer(row)
    },
    /** Called on every frame; starts or stops the animation timer when visibility changes. */
    setVisible(next: boolean) {
      if (next === visible) return
      visible = next
      controller.sync()
    },
    syncMotion() {
      controller.sync()
    },
    /** The box of `size` for the image layer or for half blocks, as tight as the pet's proportions allow. */
    /** Whether the pet reads as itself in half blocks at `size` (a detailed picture there is noise; the chat shows Mend instead). */
    halfBlockLegible(size: PetSize): boolean {
      const whole = PET_HALF_BLOCK_SIZES[size]
      return sprite === undefined || halfBlockLegible(sprite, whole.cols, whole.rows)
    },
    box(size: PetSize, halfBlocks: boolean): { cols: number; rows: number } {
      const whole = (halfBlocks ? PET_HALF_BLOCK_SIZES : PET_SIZES)[size]
      return sprite ? spriteCells(sprite, whole.cols, whole.rows) : whole
    },
    /**
     * The current frame as half-block lines (and as an image for a graphics-capable terminal), or nothing when hidden.
     * Every pet is cut to what its frames draw and resized by the kind of its art, to the box's real pixels when `cellPixels`
     * is known: a Codex atlas cell is mostly transparent margin (Greenie draws 102 x 116 of its 192 x 208), which drawn whole
     * left the character half the box.
     */
    draw(box = PET_BOX, cellPixels: CellPixels = DEFAULT_CELL_PIXELS): PetDraw | undefined {
      if (!sprite) return undefined
      const { row, index } = controller.current()
      const image = frameOf(row, index)
      if (!image) return undefined
      const pet = sprite
      const key = `${pet.id}/${row}/${index}/${box.cols}x${box.rows}`
      let lines = art.get(key)
      if (!lines) {
        lines = artLines(pet, image, box.cols, box.rows, "bottom")
        art.set(key, lines)
      }
      const [width, height] = [box.cols * cellPixels.width, box.rows * cellPixels.height]
      const pixelKey = `${key}/${width}x${height}`
      return { lines, cols: box.cols, rows: box.rows, image: { key: pixelKey, image: scaled.get(pixelKey, () => artPixels(pet, image, width, height)) } }
    },
    stop() {
      controller.stop()
    },
  }
}
export type PetSlot = ReturnType<typeof createPetSlot>

/** Every installed pet (for `/pet`), with its idle frame cut to what it draws and resized by the kind of its art, as pixels and as half blocks. */
/** The box `/pet` shows a pet in, cells: each pet takes what the rule every pet follows (`art.ts`) gives it inside. */
export const PET_PREVIEW_BOX = { cols: 32, rows: 16 } as const

/** A pet's `/pet` preview: its idle frame in its cells of `PET_PREVIEW_BOX`, as a picture and as half blocks. */
export function petPreview(sprite: PetSprite, idle: PetImage): { cells: { cols: number; rows: number }; image: PetImage; preview: Line[] } {
  const cells = spriteCells(sprite, PET_PREVIEW_BOX.cols, PET_PREVIEW_BOX.rows)
  return { cells, image: artPixels(sprite, idle, cells.cols * DEFAULT_CELL_PIXELS.width, cells.rows * DEFAULT_CELL_PIXELS.height), preview: artLines(sprite, idle, cells.cols, cells.rows) }
}

export async function petChoices(input: { dirs: PetDirs; cacheDir: string }): Promise<Array<{ pet: PetInfo; image?: PetImage; preview?: Line[]; cells?: { cols: number; rows: number }; states: string[] }>> {
  const { pets } = await listPets(input.dirs)
  return Promise.all(
    pets.map(async (pet) => {
      const loaded = await loadSprite({ pet, cacheDir: input.cacheDir }).then(asPixelArt, () => undefined)
      const idle = loaded?.rows.get("idle")?.[0]
      const states = loaded ? [...loaded.rows.keys()] : []
      if (loaded && idle) return { pet, states, ...petPreview(loaded, idle) }
      return { pet, states }
    }),
  )
}
