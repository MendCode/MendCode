import { featureOn } from "@mendcode/protocol/wire"
import { gradientSpans, reservedHomePetBoxes } from "../../pets/home-pet-layout"
import type { HomeMascot, HomeMascotBox } from "../../view/home"
import { MEND_SPRITE_SIZE, mendSpriteLines } from "../../view/mend-sprite"
import type { ImagePlacement } from "../image-layer"
import { activeTheme } from "../theme"
import type { AppContext } from "./context"

/** `homeMascot` values that are a pet of the pet system (`pets/manifest.ts`); `mend` is the ASCII mascot. */
export const isPetMascot = (value: string) => /^(user|codex|package):/.test(value)

/** How many times its own pixels the built-in Mend is drawn at each `mascotSize`. */
const MEND_SCALES = { small: 1, medium: 2, large: 3 } as const

/** Blank rows of a box: under a picture the image layer places, and the pet's place while it loads. */
const blankCells = (cols: number, rows: number) => Array.from({ length: rows }, () => [{ text: " ".repeat(cols) }])

/**
 * A pet as the start screen's mascot (docs/customize.md): which frame the home gets, whether anything moves, and the
 * picture for the image layer. The pet system (`pets/home-pet.ts`: manifest, sprite cache, controller, resizing) is imported
 * the first time a pet mascot is wanted, so a profile without one costs this closure and nothing else: no import, no
 * decode, no timer. It belongs to the pet companion feature (full tier).
 *
 * Where the terminal has an image protocol (the detection the prompt's pet uses) the picture goes through the image layer
 * at the box's real pixels and the home reserves blank cells; otherwise it is half blocks. 16 colors and ASCII glyphs get
 * neither: the home keeps the ASCII Mend.
 *
 * Motion needs all of: drawn in the current frame, `mascotMotion` on, motion not reduced, the terminal not known to be
 * unfocused, and a protocol that can replace a picture in place (kitty; iTerm2 and sixel hold one frame, as for the prompt's
 * pet). The pet's controller then holds one timer; otherwise none.
 */
export function createHomeMascot(ctx: AppContext, options: { working(): boolean; ascii(): boolean }) {
  const { state, input, requestFrame, now } = ctx
  let pet: import("../../pets/home-pet").HomePet | undefined
  let module: typeof import("../../pets/home-pet") | undefined
  let loading = false
  let mendPet: typeof import("../../pets/mend-pet") | undefined
  let mendPetLoading = false
  /** Whether the last finished frame drew it, and where the frame being built has. */
  let visible = false
  let drawing: HomeMascotBox | undefined
  const focus = (input.screen as { focus?: { state: string; subscribe(listener: () => void): () => void } }).focus

  const wanted = () => isPetMascot(state.tuiProfile.homeMascot) && input.pets !== undefined && (state.tuiProfile.logoKind === "both" || state.tuiProfile.logoKind === "mascot") && state.mode !== "minimal" && !state.accessible && featureOn(state.settingsNow, "pets")
  const protocol = () => input.screen.imageProtocol
  const graphics = () => (protocol() === undefined ? input.pets?.images === true : protocol() !== "off")
  const moving = () => visible && state.tuiProfile.mascotMotion && !state.reducedMotion && focus?.state !== "unfocused" && protocol() !== "iterm2" && protocol() !== "sixel"

  focus?.subscribe(() => {
    pet?.sync()
    if (visible) requestFrame()
  })

  /**
   * The built-in Mend: a picture the size of any pet mascot where the terminal draws pictures, else colored half blocks, whole
   * pixels times the size (small 1, medium 2, large 3); the larger ones give way to the smaller when the home is short. It needs
   * no pet and no timer; text-only terminals keep v1's ASCII mascot.
   */
  function builtInMend(input: { textOnly: boolean; title: HomeMascot["title"] }): HomeMascot | undefined {
    const { logoKind } = state.tuiProfile
    if (input.textOnly || (logoKind !== "both" && logoKind !== "mascot") || state.mode === "minimal" || state.accessible) return undefined
    if (graphics()) {
      // Where the terminal draws pictures Mend is one, at the size every pet mascot of `mascotSize` gets (`pets/mend-pet.ts`).
      if (!mendPet) {
        if (!mendPetLoading) {
          mendPetLoading = true
          void import("../../pets/mend-pet").then((loaded) => {
            mendPet = loaded
            requestFrame()
          }).finally(() => { mendPetLoading = false })
        }
        return { pixel: { boxes: reservedHomePetBoxes(state.tuiProfile.mascotSize), lines: blankCells }, ...(input.title ? { title: input.title } : {}), shown: (at) => { drawing = at } }
      }
      const loaded = mendPet
      const boxes = reservedHomePetBoxes(state.tuiProfile.mascotSize).map((box) => loaded.mendCells(box.cols, box.rows))
      return { pixel: { boxes, lines: blankCells }, ...(input.title ? { title: input.title } : {}), shown: (at) => { drawing = at } }
    }
    const wantedScale = MEND_SCALES[state.tuiProfile.mascotSize]
    const boxes = Array.from({ length: wantedScale }, (_, at) => wantedScale - at).map((scale) => ({ cols: MEND_SPRITE_SIZE.cols * scale, rows: MEND_SPRITE_SIZE.rows * scale }))
    return {
      pixel: { boxes, lines: (cols) => mendSpriteLines(options.working() ? "running" : "idle", cols / MEND_SPRITE_SIZE.cols) },
      ...(input.title ? { title: input.title } : {}),
      // Where it stands: the prompt's pet stays away, one pet on the start screen is enough.
      shown: (at) => { drawing = at },
    }
  }

  return {
    wanted,
    /** Called at the start of every frame. While it is on screen, the end of the frame checks that it was drawn again; a frame without it stops the timer. */
    frame() {
      drawing = undefined
      if (!visible) return
      queueMicrotask(() => {
        if (drawing) return
        visible = false
        pet?.sync()
      })
    },
    /**
     * What the home needs to draw the pet; nothing when none is chosen (or allowed) or it is not installed. While its module
     * or sheet is still loading the home gets the pet's place, blank: the picture then arrives into it, instead of the ASCII
     * mascot showing first and giving way to it (a start screen that drew a mascot, took it away and drew another).
     */
    art(): HomeMascot | undefined {
      const theme = activeTheme()
      // A 16-color palette or ASCII glyphs cannot carry a picture: the home draws its ASCII mascot instead.
      const textOnly = options.ascii() || theme.ansi !== undefined
      const title = (row: string, width: number) => gradientSpans(row, width, theme.colors.primary, theme.colors.info)
      if (state.tuiProfile.homeMascot === "mend") {
        // A pet chosen before in this run stops: its picture and timer are not the built-in Mend's.
        if (visible) {
          visible = false
          pet?.sync()
        }
        return builtInMend({ textOnly, title })
      }
      if (!wanted()) return undefined
      const reserved = (): HomeMascot | undefined => (textOnly ? {} : {
        pixel: { boxes: reservedHomePetBoxes(state.tuiProfile.mascotSize), lines: blankCells },
        title,
        // Where the place was kept: the prompt's pet stays away as it does from the picture. Nothing moves yet, so no timer starts.
        shown: (at) => { drawing = at },
      })
      if (!module) {
        if (!loading) {
          loading = true
          void import("../../pets/home-pet").then((loaded) => {
            module = loaded
            requestFrame()
          }).finally(() => { loading = false })
        }
        return reserved()
      }
      const dirs = input.pets!
      pet ??= module.createHomePet({ dirs: dirs.dirs, cacheDir: dirs.cacheDir, now, moving, onChange: requestFrame })
      void pet.choose(state.tuiProfile.homeMascot)
      if (pet.missing) return undefined
      if (!pet.ready) return reserved()
      const shown = pet
      if (textOnly) return {}
      shown.setWorking(options.working())
      const picture = graphics()
      return {
        pixel: {
          boxes: shown.boxes(state.tuiProfile.mascotSize),
          lines: (cols, rows) => (picture ? blankCells(cols, rows) : shown.lines(cols, rows)),
        },
        title,
        shown: (at) => {
          drawing = at
          visible = true
          // Every frame with it in view: motion settings may have changed since the last one. A waiting timer is left alone.
          shown.sync()
        },
      }
    },
    /** The picture for the image layer, where the last `art()` was drawn (rows relative to the home's first row); nothing for half blocks. */
    placement(top: number): ImagePlacement[] {
      if (!drawing || !graphics()) return []
      const cell = state.imageCellPixels ?? { width: 8, height: 16 }
      // The built-in Mend's own picture; a pet loaded earlier in this run must not lay its picture over it.
      if (state.tuiProfile.homeMascot === "mend") {
        if (!mendPet) return []
        const mend = mendPet.mendPicture(options.working() ? "running" : "idle", drawing.cols, drawing.rows, cell)
        return [{ slot: "home-pet", key: mend.key, image: mend.image, row: top + drawing.row, col: drawing.col, cols: drawing.cols, rows: drawing.rows }]
      }
      if (!pet || !wanted()) return []
      const image = pet.image(drawing.cols, drawing.rows, cell)
      return image ? [{ slot: "home-pet", key: image.key, image: image.image, row: top + drawing.row, col: drawing.col, cols: drawing.cols, rows: drawing.rows }] : []
    },
    /** The chosen pet is not installed (or its sheet cannot be read): the home keeps the ASCII Mend. */
    get missing() { return pet?.missing === true },
    /** Whether the frame being built has drawn it: the prompt's pet then stays away, one pet on the start screen is enough. */
    get drawn() { return drawing !== undefined },
    get animating() { return pet?.armed === true },
  }
}
