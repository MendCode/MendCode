import type { PetImage } from "./pet-decode"

/**
 * Resizing a character picture for a small grid. Two kinds of art need opposite filters: pixel art keeps its look only when
 * every output pixel is one of its own colors (an average smears outlines into mud), smooth artwork only when every output
 * pixel is the average of what it covers (picking one source pixel leaves broken lines and noise). `artKind` tells them
 * apart by measurement, `resample` applies the matching filter. Pure: no I/O.
 */
export type ArtKind = "pixel" | "smooth"
export type PixelBox = { left: number; top: number; width: number; height: number }

/** Alpha from which a pixel belongs to the picture when its bounds are measured. */
const CONTENT_ALPHA = 24
/** A picture with at most this many colors (after undoing an integer enlargement) is pixel art. */
export const PIXEL_ART_COLORS = 64

function blank(width: number, height: number): PetImage {
  return { width, height, rgba: new Uint8Array(width * height * 4) }
}

/** The smallest box holding every pixel that is not (nearly) transparent, or nothing for an empty picture. */
export function contentBox(image: PetImage): PixelBox | undefined {
  let left = image.width, top = image.height, right = -1, bottom = -1
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (image.rgba[(y * image.width + x) * 4 + 3]! < CONTENT_ALPHA) continue
    if (x < left) left = x
    if (x > right) right = x
    if (y < top) top = y
    if (y > bottom) bottom = y
  }
  return right < left ? undefined : { left, top, width: right - left + 1, height: bottom - top + 1 }
}

export function unionBox(boxes: ReadonlyArray<PixelBox | undefined>): PixelBox | undefined {
  const real = boxes.filter((box): box is PixelBox => box !== undefined)
  if (real.length === 0) return undefined
  const left = Math.min(...real.map((box) => box.left)), top = Math.min(...real.map((box) => box.top))
  return { left, top, width: Math.max(...real.map((box) => box.left + box.width)) - left, height: Math.max(...real.map((box) => box.top + box.height)) - top }
}

export function cropImage(image: PetImage, box: PixelBox): PetImage {
  // A box that is the whole picture needs no copy (the resamplers only read their input).
  if (box.left === 0 && box.top === 0 && box.width === image.width && box.height === image.height) return image
  const out = blank(box.width, box.height)
  for (let y = 0; y < box.height; y++) {
    const from = ((box.top + y) * image.width + box.left) * 4
    out.rgba.set(image.rgba.subarray(from, from + box.width * 4), y * box.width * 4)
  }
  return out
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

/**
 * How many times a pixel-art picture was enlarged: the greatest common length of every run of equal pixels, along rows and
 * along columns. 1 for anything that is not a clean integer enlargement (and for one that would leave fewer than 8 pixels).
 */
export function pixelScale(image: PetImage): number {
  const { width, height, rgba } = image
  const px = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height)
  let common = 0
  for (let y = 0; y < height && common !== 1; y++) {
    let run = 1
    for (let x = 1; x <= width; x++) {
      if (x < width && px[y * width + x] === px[y * width + x - 1]) run++
      else {
        common = gcd(common, run)
        run = 1
      }
    }
  }
  for (let x = 0; x < width && common !== 1; x++) {
    let run = 1
    for (let y = 1; y <= height; y++) {
      if (y < height && px[y * width + x] === px[(y - 1) * width + x]) run++
      else {
        common = gcd(common, run)
        run = 1
      }
    }
  }
  return common > 1 && width % common === 0 && height % common === 0 && Math.min(width, height) / common >= 8 ? common : 1
}

/** Undoes an integer enlargement: one pixel of every `scale` x `scale` block. */
export function shrinkExact(image: PetImage, scale: number): PetImage {
  if (scale <= 1) return image
  const out = blank(image.width / scale, image.height / scale)
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const from = (y * scale * image.width + x * scale) * 4
    out.rgba.set(image.rgba.subarray(from, from + 4), (y * out.width + x) * 4)
  }
  return out
}

/** Pixel art is a clean integer enlargement, or a picture of few colors; everything else is smooth artwork. */
export function artKind(image: PetImage): ArtKind {
  const scale = pixelScale(image)
  if (scale > 1) return "pixel"
  const px = new Uint32Array(image.rgba.buffer, image.rgba.byteOffset, image.width * image.height)
  const colors = new Set<number>()
  for (let at = 0; at < px.length; at++) {
    if (image.rgba[at * 4 + 3]! < CONTENT_ALPHA) continue
    colors.add(px[at]!)
    if (colors.size > PIXEL_ART_COLORS) return "smooth"
  }
  return "pixel"
}

const distance = (rgba: Uint8Array, at: number, color: readonly number[]) => Math.max(Math.abs(rgba[at]! - color[0]!), Math.abs(rgba[at + 1]! - color[1]!), Math.abs(rgba[at + 2]! - color[2]!))

/**
 * A flat background made transparent. It applies only to a picture with no transparency of its own whose four corners
 * share one color; that color is removed where it is connected to the border (the same color inside the character
 * stays). For smooth artwork the anti-aliased rim keeps its coverage as alpha and loses the background's tint, so no
 * halo is left; pixel art is cut exactly. Returns the picture unchanged when there is nothing to key.
 */
export function keyBackground(image: PetImage, kind: ArtKind, tolerance = kind === "pixel" ? 0 : 20): { image: PetImage; color?: [number, number, number] } {
  const { width, height, rgba } = image
  const total = width * height
  let seeThrough = 0
  for (let at = 0; at < total; at++) if (rgba[at * 4 + 3]! < 250) seeThrough++
  if (seeThrough > total / 200) return { image }
  const corners = [0, width - 1, (height - 1) * width, total - 1].map((at) => at * 4)
  const color: [number, number, number] = [0, 1, 2].map((channel) => Math.round(corners.reduce((sum, at) => sum + rgba[at + channel]!, 0) / 4)) as [number, number, number]
  if (corners.some((at) => distance(rgba, at, color) > 12)) return { image }

  const out = new Uint8Array(rgba)
  const gone = new Uint8Array(total)
  const stack: number[] = []
  const visit = (at: number) => {
    if (gone[at] || distance(rgba, at * 4, color) > tolerance) return
    gone[at] = 1
    stack.push(at)
  }
  for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x) }
  for (let y = 0; y < height; y++) { visit(y * width); visit(y * width + width - 1) }
  while (stack.length > 0) {
    const at = stack.pop()!
    const x = at % width
    if (x > 0) visit(at - 1)
    if (x < width - 1) visit(at + 1)
    if (at >= width) visit(at - width)
    if (at < total - width) visit(at + width)
  }
  for (let at = 0; at < total; at++) if (gone[at]) out.fill(0, at * 4, at * 4 + 4)
  if (kind === "pixel") return { image: { width, height, rgba: out }, color }

  // The rim: next to the removed area the pixels are a mix of the background and the character's edge color, over as many
  // pixels as the edge is soft. Walking from a rim pixel towards whatever is farthest from the background color reaches the
  // edge's own color; the pixel becomes that color at the coverage the mix implies. The rim grows inward only through
  // pixels that were such a mix, so it ends where the picture's own colors begin.
  const MAX_RIM = 24, CLIMB = 32
  const seen = new Uint8Array(gone)
  const around = (at: number) => {
    const x = at % width
    const list: number[] = []
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const n = at + dy * width + dx
      if ((dx !== 0 || dy !== 0) && x + dx >= 0 && x + dx < width && n >= 0 && n < total) list.push(n)
    }
    return list
  }
  let front: number[] = []
  for (let at = 0; at < total; at++) if (!gone[at] && around(at).some((n) => gone[n])) { seen[at] = 1; front.push(at) }
  for (let step = 0; step < MAX_RIM && front.length > 0; step++) {
    const next: number[] = []
    for (const at of front) {
      let best = at, far = distance(rgba, at * 4, color)
      for (let climb = 0; climb < CLIMB; climb++) {
        let better = best
        for (const n of around(best)) {
          if (gone[n]) continue
          const d = distance(rgba, n * 4, color)
          if (d > far) { far = d; better = n }
        }
        if (better === best) break
        best = better
      }
      if (best === at) continue
      const edge = [rgba[best * 4]!, rgba[best * 4 + 1]!, rgba[best * 4 + 2]!]
      let dot = 0, length = 0
      for (let channel = 0; channel < 3; channel++) {
        const span = edge[channel]! - color[channel]!
        dot += (rgba[at * 4 + channel]! - color[channel]!) * span
        length += span * span
      }
      const cover = length === 0 ? 1 : Math.min(1, Math.max(0, dot / length))
      // Only a pixel that lies on the line between the two colors is a mix; another color (a highlight, a second outline) is left alone.
      let off = 0
      for (let channel = 0; channel < 3; channel++) off = Math.max(off, Math.abs(rgba[at * 4 + channel]! - (color[channel]! + (edge[channel]! - color[channel]!) * cover)))
      if (off > 24 || cover >= 0.97) continue
      out.set([edge[0]!, edge[1]!, edge[2]!, Math.round(cover * 255)], at * 4)
      for (const n of around(at)) if (!seen[n]) { seen[n] = 1; next.push(n) }
    }
    front = next
  }
  return { image: { width, height, rgba: out }, color }
}

/** Area average (premultiplied alpha) for a smaller size, bilinear for a larger one: the filter for smooth artwork. */
function resampleSmooth(image: PetImage, width: number, height: number): PetImage {
  const { width: sw, height: sh, rgba } = image
  // One axis at a time. `weights(n, m)` lists, for each of m outputs, the inputs it covers and how much of each.
  const weights = (from: number, to: number): Array<Array<[number, number]>> => Array.from({ length: to }, (_, i) => {
    if (to >= from) {
      const at = Math.min(from - 1, Math.max(0, (i + 0.5) * from / to - 0.5))
      const low = Math.floor(at), high = Math.min(from - 1, low + 1)
      return high === low ? [[low, 1]] : [[low, 1 - (at - low)], [high, at - low]]
    }
    const start = i * from / to, end = (i + 1) * from / to
    const list: Array<[number, number]> = []
    for (let s = Math.floor(start); s < Math.min(from, Math.ceil(end)); s++) list.push([s, (Math.min(end, s + 1) - Math.max(start, s)) / (end - start)])
    return list
  })
  const across = weights(sw, width), down = weights(sh, height)
  const mid = new Float32Array(width * sh * 4)
  for (let y = 0; y < sh; y++) for (let x = 0; x < width; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (const [s, w] of across[x]!) {
      const at = (y * sw + s) * 4, alpha = rgba[at + 3]! * w
      r += rgba[at]! * alpha; g += rgba[at + 1]! * alpha; b += rgba[at + 2]! * alpha; a += alpha
    }
    mid.set([r, g, b, a], (y * width + x) * 4)
  }
  const out = blank(width, height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (const [s, w] of down[y]!) {
      const at = (s * width + x) * 4
      r += mid[at]! * w; g += mid[at + 1]! * w; b += mid[at + 2]! * w; a += mid[at + 3]! * w
    }
    if (a < 0.5) continue
    out.rgba.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a)], (y * width + x) * 4)
  }
  return out
}

/** How much more a dark color counts than a light one when a block of pixel art votes for its one color. */
const OUTLINE_BIAS = 1.5

/**
 * Pixel art at another size. Larger: each pixel repeated. Smaller: every output pixel takes the color that covers most of
 * its block, never a mix; darker colors count for more, so a one-pixel outline or a pupil survives being halved instead
 * of being outvoted by the fill around it.
 */
function resamplePixel(image: PetImage, width: number, height: number): PetImage {
  const { width: sw, height: sh, rgba } = image
  const out = blank(width, height)
  if (width >= sw && height >= sh) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const from = (Math.min(sh - 1, Math.floor(y * sh / height)) * sw + Math.min(sw - 1, Math.floor(x * sw / width))) * 4
      out.rgba.set(rgba.subarray(from, from + 4), (y * width + x) * 4)
    }
    return out
  }
  const px = new Uint32Array(rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + sw * sh * 4))
  const votes = new Map<number, number>()
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const x0 = x * sw / width, x1 = (x + 1) * sw / width, y0 = y * sh / height, y1 = (y + 1) * sh / height
    votes.clear()
    for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy++) for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx++) {
      const at = sy * sw + sx
      const area = (Math.min(x1, sx + 1) - Math.max(x0, sx)) * (Math.min(y1, sy + 1) - Math.max(y0, sy))
      const solid = rgba[at * 4 + 3]! >= 128
      const light = solid ? (rgba[at * 4]! * 0.299 + rgba[at * 4 + 1]! * 0.587 + rgba[at * 4 + 2]! * 0.114) / 255 : 1
      const key = solid ? px[at]! : 0
      votes.set(key, (votes.get(key) ?? 0) + area * (solid ? 1 + OUTLINE_BIAS * (1 - light) : 1))
    }
    let winner = 0, most = -1
    for (const [key, weight] of votes) if (weight > most) { most = weight; winner = key }
    if (winner !== 0) new Uint32Array(out.rgba.buffer, (y * width + x) * 4, 1)[0] = winner
  }
  return out
}

/** `image` at exactly `width` x `height`, with the filter of its kind. */
export function resample(image: PetImage, width: number, height: number, kind: ArtKind): PetImage {
  if (![width, height].every((side) => Number.isInteger(side) && side > 0 && side <= 4096)) throw new RangeError("[PETS]: invalid resample size")
  if (image.width === width && image.height === height) return image
  return kind === "pixel" ? resamplePixel(image, width, height) : resampleSmooth(image, width, height)
}

/**
 * Edges put back after a strong reduction of smooth artwork: each pixel moves away from the average of its neighbours by
 * `amount`. An area average at 30 pixels turns an eye into a grey smudge; this restores its contrast without new colors
 * far from the source. Transparent neighbours are left out, so the silhouette does not darken.
 */
export function sharpenImage(image: PetImage, amount: number): PetImage {
  const { width, height, rgba } = image
  const out = new Uint8Array(rgba)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4
    if (rgba[at + 3]! < 128) continue
    const sum = [0, 0, 0]
    let count = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const n = (ny * width + nx) * 4
      if (rgba[n + 3]! < 128) continue
      sum[0]! += rgba[n]!; sum[1]! += rgba[n + 1]!; sum[2]! += rgba[n + 2]!
      count++
    }
    for (let channel = 0; channel < 3; channel++) out[at + channel] = Math.max(0, Math.min(255, Math.round(rgba[at + channel]! + amount * (rgba[at + channel]! - sum[channel]! / count))))
  }
  return { width, height, rgba: out }
}

const EXACT_PIXEL_STEP = 4

/**
 * The largest size with the picture's proportions inside `width` x `height`. Pixel art enlarges by whole steps while its
 * pixels stay small; from `EXACT_PIXEL_STEP` times on, a pixel one wider than its neighbour does not show and it takes the
 * exact size, so a pet is the size the rule gives it instead of up to a fifth under it.
 */
export function fitSize(source: { width: number; height: number }, width: number, height: number, kind: ArtKind): { width: number; height: number } {
  let ratio = Math.min(width / source.width, height / source.height)
  if (kind === "pixel" && ratio >= 1 && ratio < EXACT_PIXEL_STEP) ratio = Math.floor(ratio)
  return { width: Math.max(1, Math.min(width, Math.round(source.width * ratio))), height: Math.max(1, Math.min(height, Math.round(source.height * ratio))) }
}

/** The picture fitted into a transparent `width` x `height` canvas: centered across, standing on the bottom edge. */
export function fitImage(image: PetImage, width: number, height: number, kind: ArtKind): PetImage {
  const size = fitSize(image, width, height, kind)
  const scaled = resample(image, size.width, size.height, kind)
  if (size.width === width && size.height === height) return scaled
  const out = blank(width, height)
  const left = Math.floor((width - size.width) / 2), top = height - size.height
  for (let y = 0; y < size.height; y++) out.rgba.set(scaled.rgba.subarray(y * size.width * 4, (y + 1) * size.width * 4), ((top + y) * width + left) * 4)
  return out
}
