import { expect, test } from "bun:test"
import { deflateSync } from "node:zlib"
import { decodePng } from "../../../packages/tools/src/pet-decode"
import { resizeRgba } from "../src/ui/image-fit"
import { scalePixels } from "../src/pets/frames"

/** A picture whose pixels differ everywhere, so a wrong neighbor in any filter shows. */
function noisy(width: number, height: number, alpha: (x: number, y: number) => number = () => 255) {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set([(x * 37 + y * 11) & 255, (x * 5 + y * 91) & 255, (x * y + 7) & 255, alpha(x, y)], (y * width + x) * 4)
  return { width, height, rgba }
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** An RGBA PNG whose row `y` uses filter `y % 5`, written by the PNG spec's forward filters. */
function pngWithEveryFilter(image: { width: number; height: number; rgba: Uint8Array }) {
  const stride = image.width * 4
  const raw = new Uint8Array((stride + 1) * image.height)
  for (let y = 0; y < image.height; y++) {
    const filter = y % 5
    raw[y * (stride + 1)] = filter
    for (let i = 0; i < stride; i++) {
      const x = image.rgba[y * stride + i]!
      const left = i >= 4 ? image.rgba[y * stride + i - 4]! : 0
      const up = y > 0 ? image.rgba[(y - 1) * stride + i]! : 0
      const upLeft = y > 0 && i >= 4 ? image.rgba[(y - 1) * stride + i - 4]! : 0
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter]!
      raw[y * (stride + 1) + 1 + i] = (x - predicted) & 255
    }
  }
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length)
    new DataView(out.buffer).setUint32(0, body.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(body, 8)
    return out
  }
  const header = new Uint8Array(13)
  new DataView(header.buffer).setUint32(0, image.width)
  new DataView(header.buffer).setUint32(4, image.height)
  header.set([8, 6, 0, 0, 0], 8)
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]
  return Uint8Array.from(parts.flatMap((part) => [...part]))
}

test("a PNG whose rows use all five filters decodes to the exact pixels", () => {
  const image = noisy(23, 15, (x, y) => (x + y) & 255)
  const decoded = decodePng(pngWithEveryFilter(image))
  expect(decoded.width).toBe(23)
  expect(decoded.height).toBe(15)
  expect(Buffer.from(decoded.rgba).equals(Buffer.from(image.rgba))).toBe(true)
})

/** The plain average of every source pixel under each output pixel. */
function boxAverage(source: ReturnType<typeof noisy>, width: number, height: number) {
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const left = Math.floor((x * source.width) / width)
    const right = Math.max(left + 1, Math.ceil(((x + 1) * source.width) / width))
    const top = Math.floor((y * source.height) / height)
    const bottom = Math.max(top + 1, Math.ceil(((y + 1) * source.height) / height))
    const sum = [0, 0, 0]
    let count = 0
    for (let sy = top; sy < bottom; sy++) for (let sx = left; sx < right; sx++, count++) for (let c = 0; c < 3; c++) sum[c]! += source.rgba[(sy * source.width + sx) * 4 + c]!
    out.set([...sum.map((value) => Math.round(value / count)), 255], (y * width + x) * 4)
  }
  return out
}

test("a picture with no see-through pixel is scaled to the plain average of the pixels under each output pixel", () => {
  const source = noisy(97, 61)
  const scaled = resizeRgba(source, 41, 23)
  expect(Buffer.from(scaled.rgba).equals(Buffer.from(boxAverage(source, 41, 23)))).toBe(true)
})

test("a transparent edge still never bleeds its color into the picture", () => {
  const source = noisy(8, 8, (x) => (x < 4 ? 255 : 0))
  const scaled = resizeRgba(source, 4, 4)
  // Each output pixel covers two columns: the right half is fully see-through, the left half keeps its own colors at full alpha.
  for (let y = 0; y < 4; y++) {
    expect(scaled.rgba[(y * 4 + 3) * 4 + 3]).toBe(0)
    expect(scaled.rgba[(y * 4) * 4 + 3]).toBe(255)
  }
})

test("a picture that fits its box at one-to-one is centered by copying whole rows, the same pixels as before", () => {
  const source = noisy(6, 4)
  const placed = scalePixels(source, 10, 8)
  expect(placed.width).toBe(10)
  for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) {
    const from = (y * 6 + x) * 4
    const to = ((y + 2) * 10 + x + 2) * 4
    expect([...placed.rgba.subarray(to, to + 4)]).toEqual([...source.rgba.subarray(from, from + 4)])
  }
  expect([...placed.rgba.subarray(0, 4)]).toEqual([0, 0, 0, 0])
})
