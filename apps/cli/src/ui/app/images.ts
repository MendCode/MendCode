import { detectImageTier, insideMultiplexer, type ImageProtocol } from "../../pets/detect"
import { hostCellPixels } from "../terminal-pixels"
import { colorDepth } from "../theme"
import type { AppContext } from "./context"

/** Terminal-local image protocol: encoders load only when graphics are enabled. */
export function createImages(ctx: AppContext) {
  const { input, state, env, say, fail, requestFrame } = ctx
  let chosen: ImageProtocol | undefined
  let ready = Promise.resolve()
  let epoch = 0
  let notedMultiplexer = false

  function syncImages(): Promise<void> {
    if (!input.screen.setImages) return ready
    const tier = detectImageTier(env, colorDepth(env), state.tuiProfile.images, input.imageAnswers)
    const protocol = tier === "halfblock" ? "off" : tier
    if (protocol === chosen) return ready
    chosen = protocol
    const current = ++epoch
    // Only a protocol the profile asked for is worth a note: on `auto` the half-block fallback is the expected result.
    if (insideMultiplexer(env) && env.MENDCODE_PET_IMAGES !== "1" && state.tuiProfile.images !== "off" && state.tuiProfile.images !== "auto" && !notedMultiplexer) {
      notedMultiplexer = true
      say(`images disabled in ${env.TMUX ? "tmux" : env.STY ? "screen" : "tuios"} (MENDCODE_PET_IMAGES=1 turns them on)`, "warning")
    }
    if (protocol === "off") {
      input.screen.setImages()
      state.imageCellPixels = undefined
      state.imageCards?.invalidate()
      state.pet?.syncMotion()
      return ready = Promise.resolve()
    }
    ready = import("../image-layer").then(async ({ createImageLayer }) => {
      if (current !== epoch) return
      const host = hostCellPixels(env, input.imageAnswers?.cellPixels)
      const cellPixels = await input.screen.resolveCellPixels?.(host) ?? host
      if (current !== epoch) return
      input.screen.setImages(createImageLayer(protocol, cellPixels ? { cellPixels } : {}))
      state.imageCellPixels = cellPixels
      state.imageCards?.invalidate()
      state.pet?.syncMotion()
      requestFrame()
    }).catch((error: unknown) => {
      if (current !== epoch) return
      chosen = undefined
      input.screen.setImages()
      fail(error instanceof Error ? error.message : String(error))
      requestFrame()
    })
    return ready
  }

  return { syncImages, get ready() { return ready } }
}
