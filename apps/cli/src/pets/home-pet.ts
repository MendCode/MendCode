import type { Line } from "../ui/theme"
import { artLines, artPixels, createFrameCache, spriteCells, spriteDurations, spriteFrames, spriteHas } from "./art"
import { createPetController } from "./controller"
import type { PetImage } from "./decode"
import type { CellPixels } from "./frames"
import { gradientSpans, HOME_PET_ORDER as ORDER, HOME_PET_SIZES, type HomePetSize } from "./home-pet-layout"
import { listPets } from "./manifest"
import type { PetDirs } from "./pet-slot"
import { loadSprite, type PetSprite } from "./sprite"

/** The start-screen box of each `mascotSize`, in cells; a pet takes the part of it its own proportions need. */
export { gradientSpans, HOME_PET_SIZES, type HomePetSize }

/** Scaled frames kept for the image layer: a large box on a dense display is about 3 MB a frame. */
const SCALED_BYTES = 16 * 1024 * 1024
/** The longest side, in pixels, a frame is scaled to for the terminal; a larger box is filled by the terminal's own scaling of it. */
const MAX_GRAPHIC_SIDE = 1024

/**
 * A pet as the start screen's mascot: the pet system's own sprite, cache and controller (one timer at most), drawn at
 * start-screen size. It moves only while `moving()` holds; otherwise the first idle frame shows and no timer waits, not
 * even the one that would end a passing row. Imported the first time a pet mascot is wanted (`ui/app/home-mascot.ts`).
 */
export function createHomePet(input: { dirs: PetDirs; cacheDir: string; now(): number; moving(): boolean; onChange(): void; setTimer?: (run: () => void, ms: number) => unknown; clearTimer?: (timer: unknown) => void }) {
  let sprite: PetSprite | undefined
  let chosen: string | undefined
  let missing = false
  let wasMoving = false
  const drawn = new Map<string, Line[]>()
  const scaled = createFrameCache(SCALED_BYTES)
  const controller = createPetController({
    now: input.now, animate: () => sprite !== undefined && input.moving(), onChange: input.onChange, durations: (row) => (sprite ? spriteDurations(sprite, row) : undefined), has: (row) => sprite !== undefined && spriteHas(sprite, row),
    // The mascot must never keep the process alive.
    setTimer: input.setTimer ?? ((run, ms) => { const timer = setTimeout(run, ms); timer.unref?.(); return timer }),
    ...(input.clearTimer ? { clearTimer: input.clearTimer } : {}),
  })

  function frame(): { image: PetImage; key: string } | undefined {
    if (!sprite) return undefined
    const { row, index } = controller.current()
    const { frames, row: shown } = spriteFrames(sprite, row)
    const image = frames[Math.min(index, frames.length - 1)]
    return image ? { image, key: `${sprite.id}/${shown}/${Math.min(index, frames.length - 1)}` } : undefined
  }

  return {
    /** Loads the pet (`user:<id>`, `codex:<id>`, `package:<id>`); the same reference again does nothing. */
    async choose(ref: string) {
      if (ref === chosen) return
      chosen = ref
      sprite = undefined
      missing = false
      controller.cancelCheer()
      drawn.clear()
      scaled.clear()
      const pet = (await listPets(input.dirs)).pets.find((candidate) => candidate.ref === ref)
      const loaded = pet ? await loadSprite({ pet, cacheDir: input.cacheDir }).catch(() => undefined) : undefined
      if (chosen !== ref) return
      if (loaded) sprite = loaded
      else missing = true
      input.onChange()
    },
    get ready() { return sprite !== undefined },
    /** The chosen pet is not installed or its sheet cannot be read: the home keeps its ASCII mascot. */
    get missing() { return missing },
    /**
     * The session's side of the animation: `agents` (`running` for a pet without it) while the Agent View lists work, `review`
     * for a moment when it ends, and `sleeping` after five minutes with none (the controller's own wait, for a pet that has it).
     */
    setWorking(working: boolean) {
      if (sprite && input.moving()) controller.setForeground("idle", { agents: working })
    },
    /** Called when whether it may move could have changed. Standing still drops every timer, the passing row's included. */
    sync() {
      const moving = sprite !== undefined && input.moving()
      if (moving === wasMoving) return
      wasMoving = moving
      if (moving) controller.sync()
      else {
        controller.setForeground("idle")
        controller.cancelCheer()
      }
    },
    /** The boxes to try for `size`, the chosen one first, then the smaller ones; each as tight as the pet's proportions allow. */
    boxes(size: HomePetSize): Array<{ cols: number; rows: number }> {
      const pet = sprite
      if (!pet) return []
      return ORDER.slice(ORDER.indexOf(size)).map((name) => spriteCells(pet, HOME_PET_SIZES[name].cols, HOME_PET_SIZES[name].rows))
    },
    /** The current frame as half-block rows of exactly `cols` cells. */
    lines(cols: number, rows: number): Line[] {
      const now = frame()
      if (!now || !sprite) return []
      const key = `${now.key}/${cols}x${rows}`
      let lines = drawn.get(key)
      if (!lines) drawn.set(key, lines = artLines(sprite, now.image, cols, rows))
      return lines
    },
    /** The current frame as the pixels of a `cols` x `rows` box for the image layer: soft alpha, the box's real size (up to a bound). */
    image(cols: number, rows: number, cell: CellPixels): { key: string; image: PetImage } | undefined {
      const now = frame()
      const pet = sprite
      if (!now || !pet) return undefined
      // The layer sends an image as it is only at the box's exact pixel size; past the bound the size is halved and it enlarges by whole steps.
      let [width, height] = [cols * cell.width, rows * cell.height]
      while (Math.max(width, height) > MAX_GRAPHIC_SIDE && width % 2 === 0 && height % 2 === 0) [width, height] = [width / 2, height / 2]
      const key = `${now.key}/${width}x${height}`
      return { key, image: scaled.get(key, () => artPixels(pet, now.image, width, height)) }
    },
    get armed() { return controller.armed },
    stop() {
      controller.stop()
    },
  }
}
export type HomePet = ReturnType<typeof createHomePet>
