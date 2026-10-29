import { describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { decodePng, decodeSheet, MAX_SHEET_SIDE, webpSize, type PetImage } from "../src/pets/decode"
import { atlasGrid, frame, PET_FRAME_COUNTS, PET_FRAME_DURATIONS, PET_ROWS, rowFrames, scale } from "../src/pets/frames"
import { toHalfBlocks } from "../src/pets/halfblock"
import { listPets } from "../src/pets/manifest"
import { sgr, type Line } from "../src/ui/theme"

const FIXTURES = join(import.meta.dir, "fixtures", "pets")
const TINY = join(FIXTURES, "tiny")
const CELL_W = 6
const CELL_H = 4

/** Tiny atlas: 8x9 cells of 6x4. Each used cell holds one 2x2 opaque block; unused pixels are transparent but carry magenta RGB. */
function tinyAtlas(): PetImage {
  const width = CELL_W * 8
  const height = CELL_H * 9
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) rgba.set([255, 0, 255, 0], i * 4)
  PET_ROWS.forEach((name, row) => {
    for (let index = 0; index < PET_FRAME_COUNTS[name]; index++) {
      const x0 = index * CELL_W + 1 + (index % 3)
      const y0 = row * CELL_H + (index % 2)
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) rgba.set([10 + 20 * row, 10 + 30 * index, 200, 255], ((y0 + dy) * width + x0 + dx) * 4)
    }
  })
  return { width, height, rgba }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Uint8Array) {
  const out = new Uint8Array(12 + body.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, body.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(body, 8)
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)))
  return out
}

/** Encodes `pixels` (already in the layout of `color`) rotating the PNG filter types 0-4 row by row. */
function encodePng({ width, height, color, pixels, depth = 8, interlace = 0, palette, trns }: { width: number; height: number; color: number; pixels: Uint8Array; depth?: number; interlace?: number; palette?: Uint8Array; trns?: Uint8Array }) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color]!
  const stride = width * channels
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const filter = y % 5
    raw[y * (stride + 1)] = filter
    for (let i = 0; i < stride; i++) {
      const x = pixels[y * stride + i]!
      const left = i >= channels ? pixels[y * stride + i - channels]! : 0
      const up = y > 0 ? pixels[(y - 1) * stride + i]! : 0
      const upLeft = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels]! : 0
      const estimate = left + up - upLeft
      const dl = Math.abs(estimate - left)
      const du = Math.abs(estimate - up)
      const dul = Math.abs(estimate - upLeft)
      const predictor = [0, left, up, (left + up) >> 1, dl <= du && dl <= dul ? left : du <= dul ? up : upLeft][filter]!
      raw[y * (stride + 1) + 1 + i] = (x - predictor) & 255
    }
  }
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([depth, color, 0, 0, interlace], 8)
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header)]
  if (palette) parts.push(chunk("PLTE", palette))
  if (trns) parts.push(chunk("tRNS", trns))
  parts.push(chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array()))
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), "mendcode-pets-"))
}

const pixel = (image: PetImage, x: number, y: number) => Array.from(image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4))
const cells = (line: Line) => line.reduce((sum, span) => sum + span.text.length, 0)
const flat = (line: Line) => line.flatMap((span) => Array.from(span.text).map(() => span as { text: string; fgHex?: string; bgHex?: string }))

test.skipIf(!process.env.PETS_WRITE_FIXTURE)("regenerates the tiny fixture sheet (PETS_WRITE_FIXTURE=1)", () => {
  const atlas = tinyAtlas()
  writeFileSync(join(TINY, "spritesheet.png"), encodePng({ width: atlas.width, height: atlas.height, color: 6, pixels: atlas.rgba }))
})

describe("pet manifest", () => {
  test("lists the tiny fixture with ref, names and sheet path", async () => {
    const { pets, skipped } = await listPets([{ dir: FIXTURES, source: "user" }])
    expect(skipped).toEqual([])
    expect(pets).toEqual([{ ref: "user:tiny", id: "tiny", displayName: "Tiny", description: "A 6x4-pixel test pet.", sheetPath: join(TINY, "spritesheet.png"), version: 1 }])
  })

  test("invalid json, wrong shape, missing sheet, escaping path and bad version are skipped with a reason", async () => {
    const root = await tempDir()
    try {
      await cp(TINY, join(root, "good"), { recursive: true })
      const write = async (name: string, content: string, sheet = true) => {
        await mkdir(join(root, name))
        await writeFile(join(root, name, "pet.json"), content)
        if (sheet) await cp(join(TINY, "spritesheet.png"), join(root, name, "spritesheet.png"))
      }
      await write("badjson", "{ nope")
      await write("array", "[]")
      await write("noid", JSON.stringify({ spritesheetPath: "spritesheet.png" }))
      await write("nosheet", JSON.stringify({ id: "nosheet", spritesheetPath: "spritesheet.png" }), false)
      await write("escape", JSON.stringify({ id: "escape", spritesheetPath: "../good/spritesheet.png" }))
      await write("absolute", JSON.stringify({ id: "absolute", spritesheetPath: join(TINY, "spritesheet.png") }))
      await write("badext", JSON.stringify({ id: "badext", spritesheetPath: "pet.json" }))
      await write("badversion", JSON.stringify({ id: "badversion", spritesheetPath: "spritesheet.png", spriteVersionNumber: 7 }))
      await write("v2", JSON.stringify({ id: "v2", displayName: "Second", spritesheetPath: "spritesheet.png", spriteVersionNumber: 2 }))
      await mkdir(join(root, "empty"))
      const { pets, skipped } = await listPets([{ dir: root, source: "codex" }])
      expect(pets.map((pet) => pet.ref)).toEqual(["codex:tiny", "codex:v2"])
      expect(pets.find((pet) => pet.id === "v2")).toMatchObject({ displayName: "Second", description: "", version: 2 })
      const reasons = new Map(skipped.map((entry) => [entry.dir.slice(root.length + 1), entry.reason]))
      expect([...reasons.keys()].sort()).toEqual(["absolute", "array", "badext", "badjson", "badversion", "empty", "escape", "noid", "nosheet"])
      expect(reasons.get("badjson")).toStartWith("invalid pet.json")
      expect(reasons.get("nosheet")).toBe("missing spritesheet spritesheet.png")
      expect(reasons.get("escape")).toBe("spritesheetPath must stay inside the pet folder")
      expect(reasons.get("empty")).toBe("missing pet.json")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a missing root folder lists nothing and never throws; the same id in two sources keeps both refs", async () => {
    const missing = await listPets([{ dir: join(tmpdir(), "mendcode-pets-does-not-exist"), source: "codex" }])
    expect(missing).toEqual({ pets: [], skipped: [] })
    const both = await listPets([{ dir: FIXTURES, source: "codex" }, { dir: FIXTURES, source: "user" }])
    expect(both.pets.map((pet) => pet.ref)).toEqual(["codex:tiny", "user:tiny"])
  })
})

describe("sheet decoding", () => {
  test("the tiny fixture decodes to exactly the pixels it was generated from", async () => {
    const decoded = await decodeSheet(join(TINY, "spritesheet.png"))
    const expected = tinyAtlas()
    expect([decoded.width, decoded.height]).toEqual([48, 36])
    expect(decoded.rgba.length).toBe(expected.rgba.length)
    expect(Buffer.from(decoded.rgba).equals(Buffer.from(expected.rgba))).toBe(true)
    expect(pixel(decoded, 1, 0)).toEqual([10, 10, 200, 255])
    expect(pixel(decoded, 0, 0)).toEqual([255, 0, 255, 0])
  })

  test("every PNG filter type round-trips for RGBA and RGB", () => {
    const width = 9
    const height = 10
    const rgba = Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * 37 + (i >> 3) * 11) & 255)
    expect(Buffer.from(decodePng(encodePng({ width, height, color: 6, pixels: rgba })).rgba).equals(Buffer.from(rgba))).toBe(true)
    const rgb = Uint8Array.from({ length: width * height * 3 }, (_, i) => (i * 53 + 7) & 255)
    const decoded = decodePng(encodePng({ width, height, color: 2, pixels: rgb }))
    expect(pixel(decoded, 4, 3)).toEqual([...rgb.subarray((3 * width + 4) * 3, (3 * width + 4) * 3 + 3), 255])
  })

  test("gray, gray-alpha and palette PNGs expand to RGBA, palette honors tRNS", () => {
    const gray = decodePng(encodePng({ width: 2, height: 2, color: 0, pixels: Uint8Array.from([0, 100, 200, 255]) }))
    expect(pixel(gray, 1, 1)).toEqual([255, 255, 255, 255])
    expect(pixel(gray, 1, 0)).toEqual([100, 100, 100, 255])
    const grayAlpha = decodePng(encodePng({ width: 2, height: 1, color: 4, pixels: Uint8Array.from([50, 128, 60, 0]) }))
    expect(pixel(grayAlpha, 0, 0)).toEqual([50, 50, 50, 128])
    expect(pixel(grayAlpha, 1, 0)).toEqual([60, 60, 60, 0])
    const palette = decodePng(encodePng({ width: 3, height: 1, color: 3, pixels: Uint8Array.from([0, 1, 2]), palette: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255]), trns: Uint8Array.from([255, 64]) }))
    expect(pixel(palette, 0, 0)).toEqual([255, 0, 0, 255])
    expect(pixel(palette, 1, 0)).toEqual([0, 255, 0, 64])
    expect(pixel(palette, 2, 0)).toEqual([0, 0, 255, 255])
  })

  test("unsupported or hostile PNGs are rejected with a clear error", async () => {
    const pixels = new Uint8Array(4 * 4 * 4)
    expect(() => decodePng(encodePng({ width: 4, height: 4, color: 6, pixels, depth: 16 }))).toThrow("bit depth 16")
    expect(() => decodePng(encodePng({ width: 4, height: 4, color: 6, pixels, interlace: 1 }))).toThrow("interlaced")
    expect(() => decodePng(encodePng({ width: 4, height: 4, color: 6, pixels }).subarray(0, 40))).toThrow()
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow("bad PNG signature")
    const huge = encodePng({ width: MAX_SHEET_SIDE + 1, height: 1, color: 0, pixels: new Uint8Array(MAX_SHEET_SIDE + 1) })
    expect(() => decodePng(huge)).toThrow("exceeds")
    const root = await tempDir()
    try {
      await writeFile(join(root, "sheet.png"), "not an image")
      await expect(decodeSheet(join(root, "sheet.png"))).rejects.toThrow("unsupported spritesheet format")
      await expect(decodeSheet(join(root, "missing.png"))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("WebP is decoded on demand through the dynamic decoder and size-checked from the header", async () => {
    const encoder = (await import("@jsquash/webp/encode.js")) as unknown as { init: (module: WebAssembly.Module) => Promise<void>; default: (image: { data: Uint8ClampedArray; width: number; height: number }, options: { lossless: number }) => Promise<ArrayBuffer> }
    const { fileURLToPath } = await import("node:url")
    await encoder.init(await WebAssembly.compile(readFileSync(fileURLToPath(import.meta.resolve("@jsquash/webp/codec/enc/webp_enc.wasm")))))
    const source = tinyAtlas()
    const bytes = new Uint8Array(await encoder.default({ data: new Uint8ClampedArray(source.rgba), width: source.width, height: source.height }, { lossless: 1 }))
    expect(webpSize(bytes)).toEqual({ width: 48, height: 36 })
    const root = await tempDir()
    try {
      await writeFile(join(root, "sheet.webp"), bytes)
      const decoded = await decodeSheet(join(root, "sheet.webp"))
      expect([decoded.width, decoded.height]).toEqual([48, 36])
      expect(pixel(decoded, 1, 0)).toEqual([10, 10, 200, 255])
      expect(pixel(decoded, 5, 3)[3]).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("frames", () => {
  test("row table matches the Codex atlas: 9 rows, frame counts and one duration per frame", () => {
    expect([...PET_ROWS]).toEqual(["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"])
    expect(PET_ROWS.map((row) => PET_FRAME_COUNTS[row])).toEqual([6, 8, 8, 4, 5, 8, 6, 6, 6])
    for (const row of PET_ROWS) expect(PET_FRAME_DURATIONS[row]).toHaveLength(PET_FRAME_COUNTS[row])
    expect(PET_FRAME_DURATIONS.idle).toEqual([280, 110, 110, 140, 140, 320])
  })

  test("atlas grid derives the cell size (8x9 v1, 8x11 v2) and rejects sizes that do not divide", () => {
    expect(atlasGrid({ width: 1536, height: 1872 })).toEqual({ columns: 8, rows: 9, cellWidth: 192, cellHeight: 208 })
    expect(atlasGrid({ width: 1536, height: 2288 })).toEqual({ columns: 8, rows: 11, cellWidth: 192, cellHeight: 208 })
    expect(atlasGrid({ width: 48, height: 36 })).toEqual({ columns: 8, rows: 9, cellWidth: 6, cellHeight: 4 })
    expect(() => atlasGrid({ width: 1537, height: 1872 })).toThrow("invalid atlas")
    expect(() => atlasGrid({ width: 1536, height: 1873 })).toThrow("invalid atlas")
    expect(() => atlasGrid({ width: 0, height: 0 })).toThrow("invalid atlas")
    expect(() => frame({ width: 10, height: 10, rgba: new Uint8Array(400) }, "idle", 0)).toThrow("invalid atlas")
  })

  test("native atlas cells retain transparent margins and every state has one size", () => {
    const sheet = tinyAtlas()
    const idle = rowFrames(sheet, "idle")
    expect(idle).toHaveLength(6)
    for (const each of idle) expect([each.width, each.height]).toEqual([6, 4])
    expect(pixel(idle[0]!, 1, 0)).toEqual([10, 10, 200, 255])
    expect(pixel(idle[0]!, 0, 0)).toEqual([255, 0, 255, 0])
    expect(pixel(idle[1]!, 2, 1)).toEqual([10, 40, 200, 255])
    expect(pixel(idle[1]!, 0, 0)[3]).toBe(0)
    const jumping = frame(sheet, "jumping", 4)
    expect(jumping.width).toBe(6)
    expect(pixel(jumping, 2, 1)).toEqual([90, 130, 200, 255])
    expect(() => frame(sheet, "waving", 4)).toThrow(RangeError)
    expect(() => frame(sheet, "idle", -1)).toThrow(RangeError)
  })
})

describe("scale", () => {
  test("a half-transparent block keeps its color and alpha instead of darkening to black", () => {
    const rgba = new Uint8Array(4 * 4 * 4)
    for (let i = 0; i < 16; i++) rgba.set([255, 255, 255, 128], i * 4)
    const out = scale({ width: 4, height: 4, rgba }, 2, 1)
    expect([out.width, out.height]).toEqual([2, 2])
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) expect(pixel(out, x, y)).toEqual([255, 255, 255, 128])
  })

  test("transparent pixels do not bleed their hidden color into neighbors", () => {
    const rgba = new Uint8Array(2 * 2 * 4)
    for (const [x, y] of [[0, 0], [0, 1]] as const) rgba.set([255, 0, 0, 0], (y * 2 + x) * 4)
    for (const [x, y] of [[1, 0], [1, 1]] as const) rgba.set([0, 0, 255, 255], (y * 2 + x) * 4)
    const out = scale({ width: 2, height: 2, rgba }, 1, 1)
    expect(pixel(out, 0, 0)).toEqual([255, 0, 0, 0])
    expect(pixel(out, 0, 1)).toEqual([0, 0, 0, 0])
  })

  test("fully transparent stays transparent, aspect is kept and the result is centered", () => {
    const empty = scale({ width: 3, height: 3, rgba: new Uint8Array(36) }, 2, 2)
    expect(Array.from(empty.rgba).every((value) => value === 0)).toBe(true)
    const rgba = new Uint8Array(4 * 2 * 4)
    for (let i = 0; i < 8; i++) rgba.set([9, 8, 7, 255], i * 4)
    const wide = scale({ width: 4, height: 2, rgba }, 4, 3)
    expect([wide.width, wide.height]).toEqual([4, 6])
    const opaqueRows = [0, 1, 2, 3, 4, 5].filter((y) => pixel(wide, 0, y)[3] === 255)
    expect(opaqueRows).toEqual([2, 3])
  })
})

describe("half blocks", () => {
  const red = [255, 0, 0, 255]
  const blue = [0, 0, 255, 255]
  const none = [0, 0, 0, 0]

  test("glyph and colors per cell: both, top only, bottom only, neither", () => {
    // 4 cells x 1 row = 4x2 pixels; top row then bottom row.
    const rgba = Uint8Array.from([...red, ...red, ...none, ...none, ...blue, ...none, ...blue, ...none])
    const [line] = toHalfBlocks({ width: 4, height: 2, rgba }, 4, 1)
    expect(line).toEqual([{ text: "▀", fgHex: "#ff0000", bgHex: "#0000ff" }, { text: "▀", fgHex: "#ff0000" }, { text: "▄", fgHex: "#0000ff" }, { text: " " }])
  })

  test("alpha threshold is 50 percent", () => {
    const rgba = Uint8Array.from([255, 0, 0, 128, 255, 0, 0, 127, 0, 0, 255, 255, 0, 0, 255, 255])
    const [line] = toHalfBlocks({ width: 2, height: 2, rgba }, 2, 1)
    expect(flat(line!).map((span) => [span.text, span.fgHex, span.bgHex])).toEqual([["▀", "#ff0000", "#0000ff"], ["▄", "#0000ff", undefined]])
  })

  test("returns exactly rows lines of exactly cols cells and never mutates the image", () => {
    const sheet = tinyAtlas()
    const before = Buffer.from(sheet.rgba)
    const image = frame(sheet, "idle", 0)
    for (const [cols, rows] of [[8, 3], [10, 4], [1, 1], [16, 6]] as const) {
      const lines = toHalfBlocks(image, cols, rows)
      expect(lines).toHaveLength(rows)
      for (const line of lines) expect(cells(line)).toBe(cols)
    }
    expect(Buffer.from(sheet.rgba).equals(before)).toBe(true)
  })

  test("spans render through sgr: fgHex at both color depths, no color for empty cells", () => {
    const [line] = toHalfBlocks({ width: 2, height: 2, rgba: Uint8Array.from([...red, ...none, ...blue, ...none]) }, 2, 1)
    const [full, empty] = line!
    expect(sgr(full!, "truecolor")).toContain("38;2;255;0;0")
    expect(sgr(full!, "256")).toMatch(/38;5;\d+/)
    expect(empty).toEqual({ text: " " })
  })
})

test("a native 192×208 atlas cell has a crisp, nonempty 24×13 half-block fallback", () => {
  const width = 192
  const height = 208
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 40; y < 160; y++) for (let x = 40; x < 144; x++) rgba.set([13, 201, 57, 255], (y * width + x) * 4)
  const lines = toHalfBlocks({ width, height, rgba }, 24, 13)
  expect(lines).toHaveLength(13)
  for (const line of lines) expect(cells(line)).toBe(24)
  expect(lines.flat().some((span) => span.fgHex === "#0dc939")).toBe(true)
})
