import { PET_CORE_STATES, type GeneratedPetState } from "../../protocol/src/pet-data"
import { decodePng, MAX_SHEET_BYTES, type PetImage } from "./pet-decode"
import { encodeImagePng, validateImage } from "./pet-png"

export const PET_CELL = { width: 32, height: 32 }
export const PET_ATLAS_ROWS = ["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"] as const
export const PET_ATLAS_COUNTS = [6, 8, 8, 4, 5, 8, 6, 6, 6] as const

export function validatePetFrame(image: PetImage) {
  validateImage(image)
  if (image.width !== PET_CELL.width || image.height !== PET_CELL.height) throw new Error("Pet frame must be 32x32")
  let opaque = 0
  for (let offset = 3; offset < image.rgba.length; offset += 4) {
    const alpha = image.rgba[offset]!
    if (alpha !== 0 && alpha !== 255) throw new Error("Pet alpha must be binary")
    if (alpha === 255) opaque++
  }
  if (!opaque) throw new Error("Pet frame is empty")
  if (opaque === image.width * image.height) throw new Error("Pet frame needs transparency")
}

/** What a provider image draws: its box, and the divisor that fits that box into a frame. */
function drawn(bytes: Uint8Array) {
  if (bytes.length > MAX_SHEET_BYTES) throw new Error("Pet image exceeds 32 MB")
  const image = decodePng(bytes)
  let left = image.width, top = image.height, right = -1, bottom = -1, transparent = false
  for (let row = 0; row < image.height; row++) for (let col = 0; col < image.width; col++) {
    if (image.rgba[(row * image.width + col) * 4 + 3]! < 128) { transparent = true; continue }
    left = Math.min(left, col)
    right = Math.max(right, col)
    top = Math.min(top, row)
    bottom = Math.max(bottom, row)
  }
  if (right < left) throw new Error("Pet image is empty")
  if (!transparent) throw new Error("Provider image needs a transparent background")
  const cropWidth = right - left + 1, cropHeight = bottom - top + 1
  return { image, left, top, cropWidth, cropHeight, divisor: Math.max(1, Math.ceil(cropWidth / 30), Math.ceil(cropHeight / 30)) }
}

/** The divisor the reference picture needs: every state drawn with it keeps the reference's size from state to state. */
export const petScale = (reference: Uint8Array) => drawn(reference).divisor

/**
 * A provider image as one 32x32 frame, standing on the bottom edge and centered. `scale` is the reference's divisor
 * (`petScale`): the frame uses it unless its pose would not fit, so a state never shrinks or grows the character by itself.
 */
export function petFrame(bytes: Uint8Array, scale = 1): PetImage {
  const { image, left, top, cropWidth, cropHeight, divisor: fits } = drawn(bytes)
  const divisor = Math.max(scale, fits)
  const width = Math.ceil(cropWidth / divisor), height = Math.ceil(cropHeight / divisor)
  const rgba = new Uint8Array(32 * 32 * 4)
  const xOffset = Math.floor((32 - width) / 2), yOffset = 31 - height
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const source = ((top + row * divisor) * image.width + left + col * divisor) * 4
    if (image.rgba[source + 3]! < 128) continue
    const target = ((yOffset + row) * 32 + xOffset + col) * 4
    // Assigning a fraction to a Uint8Array truncates; round the 3-3-2 levels back to 0..255 explicitly.
    rgba[target] = Math.round(Math.round(image.rgba[source]! * 7 / 255) * 255 / 7)
    rgba[target + 1] = Math.round(Math.round(image.rgba[source + 1]! * 7 / 255) * 255 / 7)
    rgba[target + 2] = Math.round(Math.round(image.rgba[source + 2]! * 3 / 255) * 255 / 3)
    rgba[target + 3] = 255
  }
  const result = { ...PET_CELL, rgba }
  validatePetFrame(result)
  return result
}

/** Which of `frames` frames column `col` of a row shows: there and back (0 1 2 1 0 1 ...), so the loop never jumps across. */
export const pingPong = (col: number, frames: number) => {
  if (frames <= 1) return 0
  const at = col % (2 * frames - 2)
  return at < frames ? at : 2 * frames - 2 - at
}

/** The atlas of a generated pet: each row's columns play its state's frames there and back; a missing optional state shows idle. */
export function petAtlas(frames: Partial<Record<GeneratedPetState, PetImage | readonly PetImage[]>>): Uint8Array {
  const framesOf = (state: GeneratedPetState) => { const given = frames[state]; return given === undefined ? undefined : Array.isArray(given) ? given as readonly PetImage[] : [given as PetImage] }
  for (const state of PET_CORE_STATES) if (!framesOf(state)?.length) throw new Error(`Missing pet core state ${state}`)
  const width = 8 * 32, height = 9 * 32, rgba = new Uint8Array(width * height * 4)
  for (const [row, state] of PET_ATLAS_ROWS.entries()) {
    const own = framesOf(state as GeneratedPetState)
    const shown = own?.length ? own : framesOf("idle")!
    for (const frame of shown) validatePetFrame(frame)
    for (let col = 0; col < PET_ATLAS_COUNTS[row]!; col++) {
      const frame = shown[pingPong(col, shown.length)]!
      for (let line = 0; line < 32; line++) rgba.set(frame.rgba.subarray(line * 32 * 4, (line + 1) * 32 * 4), ((row * 32 + line) * width + col * 32) * 4)
    }
  }
  return encodeImagePng({ width, height, rgba })
}
