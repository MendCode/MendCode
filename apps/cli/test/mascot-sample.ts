/**
 * A placeholder character built by arithmetic (ellipses, a dress, an outline pass), not artwork: it exists so the import
 * and the start screen can be tested and pictured without shipping or generating a real drawing. `sampleSprite` is clean
 * pixel art at 64 x 64; `smoothSample` is the same enlarged eight times with soft anti-aliased edges, standing in for a
 * smooth illustration; `onBackground` puts either on a flat color.
 */
import type { PetImage } from "../src/pets/decode"

type Rgb = readonly [number, number, number]
type Part = { base: Rgb; inside(x: number, y: number): boolean; center: readonly [number, number]; reach: readonly [number, number]; flat?: boolean }

const ellipse = (cx: number, cy: number, rx: number, ry: number) => (x: number, y: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
const tone = (color: Rgb, factor: number): Rgb => [0, 1, 2].map((i) => Math.max(0, Math.min(255, Math.round(color[i]! * factor)))) as unknown as Rgb

const OUTLINE: Rgb = [43, 27, 61]
const HAIR: Rgb = [156, 122, 232], SKIN: Rgb = [255, 222, 196], DRESS: Rgb = [52, 84, 150], WHITE: Rgb = [250, 250, 255], IRIS: Rgb = [58, 196, 178]

export const SAMPLE_SIZE = 64

export function sampleSprite(pose: { eyes?: "open" | "closed"; lift?: 0 | 1 } = {}): PetImage {
  const size = SAMPLE_SIZE
  const lift = pose.lift ?? 0
  const part = (base: Rgb, cx: number, cy: number, rx: number, ry: number, extra?: (x: number, y: number) => boolean, flat = false): Part => {
    const within = ellipse(cx, cy, rx, ry)
    return { base, center: [cx, cy], reach: [rx, ry], inside: extra ? (x, y) => within(x, y) && extra(x, y) : within, ...(flat ? { flat } : {}) }
  }
  const head = 27 - lift
  const parts: Part[] = [
    // twin tails, then the hair behind the head
    part(HAIR, 9, 36 - lift, 6.5, 15), part(HAIR, 55, 36 - lift, 6.5, 15), part(HAIR, 32, head - 3, 21, 19),
    // legs, shoes, dress, collar, arms
    { base: SKIN, center: [32, 59], reach: [7, 4], inside: (x, y) => y >= 55 && y < 61 && ((x >= 26 && x < 30) || (x >= 34 && x < 38)) },
    { base: OUTLINE, center: [32, 62], reach: [7, 2], flat: true, inside: (x, y) => y >= 61 && y < 63 && ((x >= 25 && x < 30) || (x >= 34 && x < 39)) },
    { base: DRESS, center: [32, 50], reach: [12, 8], inside: (x, y) => y >= 42 - lift && y < 57 && Math.abs(x - 32) <= 6 + (y - 42) * 0.45 },
    { base: WHITE, center: [32, 44], reach: [5, 2], flat: true, inside: (x, y) => y >= 42 - lift && y < 45 - lift && Math.abs(x - 32) <= 4 - (y - (42 - lift)) },
    part(SKIN, 21, 49 - lift, 2.6, 5), part(SKIN, 43, 49 - lift, 2.6, 5),
    // face, then the fringe: a scalloped edge over the forehead
    part(SKIN, 32, head + 1, 15, 14),
    part(HAIR, 32, head - 5, 17.5, 13, (x, y) => y < head - 4 + 3.2 * Math.abs(Math.sin((x - 32) * 0.42))),
    // a hair clip
    { base: [255, 205, 80], center: [45, head - 9], reach: [3, 2], flat: true, inside: (x, y) => Math.abs(x - 45) + Math.abs(y - (head - 9)) <= 2.2 },
    // cheeks
    part([255, 158, 170], 20, head + 8, 2.6, 1.4, undefined, true), part([255, 158, 170], 44, head + 8, 2.6, 1.4, undefined, true),
  ]
  const owner = new Int16Array(size * size).fill(-1)
  const rgba = new Uint8Array(size * size * 4)
  const put = (x: number, y: number, color: Rgb) => { if (x >= 0 && y >= 0 && x < size && y < size) rgba.set([color[0], color[1], color[2], 255], (y * size + x) * 4) }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    for (let index = 0; index < parts.length; index++) {
      const p = parts[index]!
      if (!p.inside(x + 0.5, y + 0.5)) continue
      owner[y * size + x] = index
      // Light from the upper left: a shade on the lower right of each part, a highlight near its upper left edge.
      const nx = (x + 0.5 - p.center[0]) / p.reach[0], ny = (y + 0.5 - p.center[1]) / p.reach[1]
      put(x, y, p.flat ? p.base : nx * 0.7 + ny > 0.55 ? tone(p.base, 0.78) : nx + ny < -0.95 ? tone(p.base, 1.12) : p.base)
    }
  }
  // Where one part meets another, the lower one gets a darker line; the silhouette gets the outline color.
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= size || y >= size ? -1 : owner[y * size + x]!)
  const edges: Array<[number, number, Rgb]> = []
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const mine = at(x, y)
    const around = [at(x + 1, y), at(x - 1, y), at(x, y + 1), at(x, y - 1)]
    if (mine < 0) { if (around.some((other) => other >= 0)) edges.push([x, y, OUTLINE]) }
    else if (!parts[mine]!.flat && around.some((other) => other > mine && !parts[other]!.flat)) edges.push([x, y, tone(parts[mine]!.base, 0.55)])
  }
  for (const [x, y, color] of edges) put(x, y, color)
  // Eyes: a dark almond, a teal iris, two white lights; closed, one curved line.
  for (const cx of [25, 39]) {
    const cy = head + 3
    if (pose.eyes === "closed") {
      for (let dx = -3; dx <= 3; dx++) put(cx + dx, cy + 1 + (Math.abs(dx) === 3 ? -1 : 0), OUTLINE)
      continue
    }
    for (let dy = -4; dy <= 4; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (!ellipse(0, 0, 3.4, 4.6)(dx, dy)) continue
      put(cx + dx, cy + dy, dy <= -3 || Math.abs(dx) === 3 ? OUTLINE : dy >= 1 ? IRIS : tone(IRIS, 0.55))
    }
    put(cx - 1, cy - 2, WHITE); put(cx - 2, cy - 2, WHITE); put(cx - 1, cy - 1, WHITE); put(cx + 1, cy + 2, WHITE)
  }
  for (let dx = -1; dx <= 1; dx++) put(32 + dx, head + 10 + (dx === 0 ? 1 : 0), [190, 70, 90])
  return { width: size, height: size, rgba }
}

/** `image` enlarged `times` and blurred a little (premultiplied), so every edge is anti-aliased like a smooth illustration. */
export function smoothSample(image: PetImage = sampleSprite(), times = 8, radius = 3): PetImage {
  const width = image.width * times, height = image.height * times
  let field = new Float64Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = (Math.floor(y / times) * image.width + Math.floor(x / times)) * 4, alpha = image.rgba[from + 3]! / 255, to = (y * width + x) * 4
    field[to] = image.rgba[from]! * alpha
    field[to + 1] = image.rgba[from + 1]! * alpha
    field[to + 2] = image.rgba[from + 2]! * alpha
    field[to + 3] = alpha
  }
  // Two box passes each way come close to a Gaussian. Each line keeps a running sum; the edge value repeats past the ends.
  const span = radius * 2 + 1
  for (let pass = 0; pass < 2; pass++) for (let axis = 0; axis < 2; axis++) {
    const next = new Float64Array(field.length)
    const [lines, length, step, across] = axis === 0 ? [height, width, 4, width * 4] : [width, height, width * 4, 4]
    for (let line = 0; line < lines; line++) for (let channel = 0; channel < 4; channel++) {
      const base = line * across + channel
      const at = (index: number) => field[base + Math.min(length - 1, Math.max(0, index)) * step]!
      let sum = 0
      for (let offset = -radius; offset <= radius; offset++) sum += at(offset)
      for (let index = 0; index < length; index++) {
        next[base + index * step] = sum / span
        sum += at(index + radius + 1) - at(index - radius)
      }
    }
    field = next
  }
  const rgba = new Uint8Array(width * height * 4)
  for (let at = 0; at < width * height; at++) {
    const alpha = field[at * 4 + 3]!
    if (alpha < 1 / 255) continue
    rgba.set([Math.round(field[at * 4]! / alpha), Math.round(field[at * 4 + 1]! / alpha), Math.round(field[at * 4 + 2]! / alpha), Math.round(alpha * 255)], at * 4)
  }
  return { width, height, rgba }
}

/** `image` composited on a flat opaque background (a picture exported without transparency). */
export function onBackground(image: PetImage, color: Rgb): PetImage {
  const rgba = new Uint8Array(image.rgba.length)
  for (let at = 0; at < image.width * image.height; at++) {
    const alpha = image.rgba[at * 4 + 3]! / 255
    rgba.set([0, 1, 2].map((i) => Math.round(image.rgba[at * 4 + i]! * alpha + color[i]! * (1 - alpha))).concat(255), at * 4)
  }
  return { width: image.width, height: image.height, rgba }
}

/** Images side by side in one row (a sprite sheet of `images.length` columns). */
export function sheetOf(images: readonly PetImage[]): PetImage {
  const { width, height } = images[0]!
  const rgba = new Uint8Array(width * images.length * height * 4)
  images.forEach((image, index) => { for (let y = 0; y < height; y++) rgba.set(image.rgba.subarray(y * width * 4, (y + 1) * width * 4), (y * width * images.length + index * width) * 4) })
  return { width: width * images.length, height, rgba }
}
