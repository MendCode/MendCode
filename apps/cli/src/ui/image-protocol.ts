import { encodeImagePng, validateImage } from "../../../../packages/tools/src/pet-png"
export { encodeImagePng, validateImage } from "../../../../packages/tools/src/pet-png"
import type { PetImage } from "../pets/decode"

function positive(name: string, value: number, max = 4096) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new RangeError(`[IMAGES]: invalid ${name}: ${value}`)
}

/** OSC 1337 inline PNG; bare width and height values are terminal cells. */
export function iterm2Inline({ image, cols, rows, preserveAspectRatio = true }: { image: PetImage; cols: number; rows: number; preserveAspectRatio?: boolean }): string {
  positive("cols", cols)
  positive("rows", rows)
  const png = encodeImagePng(image)
  return `\x1b]1337;File=size=${png.length};inline=1;width=${cols};height=${rows};preserveAspectRatio=${preserveAspectRatio ? 1 : 0}:${Buffer.from(png).toString("base64")}\x07`
}

/** DCS sixel, square pixels, transparent background. Fixed RGB332 palette; alpha below 128 is transparent. */
export function sixelEncode(image: PetImage): string {
  validateImage(image)
  const pixels = new Int16Array(image.width * image.height).fill(-1)
  const palette = new Set<number>()
  for (let i = 0; i < pixels.length; i++) {
    const at = i * 4
    if (image.rgba[at + 3]! < 128) continue
    const color = (Math.round(image.rgba[at]! * 7 / 255) << 5) | (Math.round(image.rgba[at + 1]! * 7 / 255) << 2) | Math.round(image.rgba[at + 2]! * 3 / 255)
    pixels[i] = color
    palette.add(color)
  }
  let out = `\x1bP0;1;0q"1;1;${image.width};${image.height}`
  for (const color of [...palette].sort((a, b) => a - b)) out += `#${color};2;${Math.round((color >> 5) * 100 / 7)};${Math.round(((color >> 2) & 7) * 100 / 7)};${Math.round((color & 3) * 100 / 3)}`
  for (let y = 0; y < image.height; y += 6) {
    const bands = new Map<number, Uint8Array>()
    for (let dy = 0; dy < 6 && y + dy < image.height; dy++) {
      for (let x = 0; x < image.width; x++) {
        const color = pixels[(y + dy) * image.width + x]!
        if (color < 0) continue
        let band = bands.get(color)
        if (!band) bands.set(color, band = new Uint8Array(image.width))
        band[x] = band[x]! | (1 << dy)
      }
    }
    let first = true
    for (const [color, band] of [...bands].sort(([a], [b]) => a - b)) {
      out += `${first ? "" : "$"}#${color}`
      first = false
      let end = band.length
      while (end > 0 && band[end - 1] === 0) end--
      for (let x = 0; x < end;) {
        let next = x + 1
        while (next < end && band[next] === band[x]) next++
        const char = String.fromCharCode(63 + band[x]!)
        out += next - x >= 4 ? `!${next - x}${char}` : char.repeat(next - x)
        x = next
      }
    }
    if (y + 6 < image.height) out += "-"
  }
  return `${out}\x1b\\`
}
