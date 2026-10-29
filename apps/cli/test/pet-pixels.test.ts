import { describe, expect, test } from "bun:test"
import { pixelFit, sizePet, HALF_BLOCK_PIXELS } from "../src/pets/frames"
import { toHalfBlocks } from "../src/pets/halfblock"
import { terminalPixels, hostCellPixels } from "../src/ui/terminal-pixels"
import { createKittyLayer } from "../src/ui/image-layer"
import { inflateSync } from "node:zlib"

const source = { width: 3, height: 2, rgba: Uint8Array.from([
  13, 29, 71, 255, 61, 2, 193, 255, 7, 8, 9, 0,
  10, 22, 30, 255, 9, 65, 100, 255, 24, 31, 78, 255,
]) }
const pixel = (rgba: Uint8Array, at: number) => [...rgba.subarray(at * 4, at * 4 + 4)]

describe("pet raster sizing", () => {
  test("the largest integer enlargement preserves aspect and copies every RGBA pixel exactly", () => {
    for (const [cols, rows, cell] of [[7, 3, HALF_BLOCK_PIXELS], [16, 8, { width: 10, height: 19 }], [82, 37, { width: 9, height: 15 }]] as const) {
      const width = cols * cell.width
      const height = rows * cell.height
      const fit = pixelFit(source, width, height)!
      expect(Number.isInteger(fit.scale)).toBe(true)
      expect(fit.divisor).toBe(1)
      expect(fit.width / fit.height).toBe(source.width / source.height)
      expect(source.width * (fit.scale + 1) > width || source.height * (fit.scale + 1) > height).toBe(true)
      const out = sizePet(source, cols, rows, cell)
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const inside = x >= fit.x && x < fit.x + fit.width && y >= fit.y && y < fit.y + fit.height
        const expected = inside ? pixel(source.rgba, Math.floor((y - fit.y) / fit.scale) * source.width + Math.floor((x - fit.x) / fit.scale)) : [0, 0, 0, 0]
        expect(pixel(out.rgba, y * width + x)).toEqual(expected)
      }
    }
  })

  test("1× is never reduced, insufficient boxes use a common integer divisor or report no fit", () => {
    expect(pixelFit({ width: 192, height: 208 }, 192, 220)).toMatchObject({ scale: 1, divisor: 1, width: 192, height: 208 })
    expect(pixelFit({ width: 192, height: 208 }, 128, 128)).toMatchObject({ scale: 1, divisor: 2, width: 96, height: 104 })
    expect(pixelFit({ width: 192, height: 208 }, 24, 26)).toMatchObject({ scale: 1, divisor: 8, width: 24, height: 26 })
    expect(pixelFit(source, 2, 1)).toBeUndefined()
  })

  test("half blocks copy unusual colors, leave transparency unstyled and repeat pixels at integer scale", () => {
    const out = toHalfBlocks(source, 6, 2)
    expect(out[0]).toEqual([{ text: "▀▀", fgHex: "#0d1d47", bgHex: "#0d1d47" }, { text: "▀▀", fgHex: "#3d02c1", bgHex: "#3d02c1" }, { text: "  " }])
    expect(out[1]![0]).toMatchObject({ fgHex: "#0a161e", bgHex: "#0a161e" })
  })
})

describe("terminal geometry before first placement", () => {
  test("a split 16t reply wins over window estimates; late replies cannot resize the pet", async () => {
    const writes: string[] = []
    const geometry = terminalPixels({ size: () => ({ width: 100, height: 30 }), tty: true, write: (d) => writes.push(d) })
    const ready = geometry.resolve()
    let resolved = false
    void ready.then(() => { resolved = true })
    expect(geometry.consume("\x1b[4;600;1000t\x1b[8;30;100t")).toBe("")
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(geometry.consume("\x1b[6;19;")).toBe("")
    expect(geometry.consume("10t/hi")).toBe("/hi")
    const cellPixels = await ready
    expect(cellPixels).toEqual({ width: 10, height: 19 })
    const layer = createKittyLayer({ random: () => 0, cellPixels })
    const p = { slot: "pet", key: "greenie", image: source, row: 2, col: 3, cols: 16, rows: 8 }
    const upload = layer.uploads([p])
    expect(upload).toContain("a=t,f=32,s=160,v=152")
    expect(upload).not.toContain("a=p")
    const parts = [...upload.matchAll(/;([^\x1b]+)\x1b\\/g)].map((m) => m[1]).join("")
    expect(new Uint8Array(inflateSync(Buffer.from(parts, "base64")))).toEqual(sizePet(source, 16, 8, cellPixels).rgba)
    const first = layer.places([p], new Set())
    layer.invalidate()
    geometry.consume("\x1b[6;40;20t")
    expect(geometry.value).toEqual(cellPixels)
    layer.uploads([p])
    const settled = layer.places([p], new Set()).replace(/i=2/, "i=1")
    expect(first).toBe(settled)
    expect(writes).toEqual(["\x1b[16t\x1b[14t\x1b[18t"])
  })

  test("window and text-area replies derive cells, timeout/no-reply uses 8×16, host skips queries", async () => {
    const geometry = terminalPixels({ size: () => ({ width: 80, height: 24 }), tty: true, timeoutMs: 1, write() {} })
    const ready = geometry.resolve()
    geometry.consume("\x1b[4;570;1000t\x1b[8;30;100t")
    expect(await ready).toEqual({ width: 10, height: 19 })
    const silent = terminalPixels({ size: () => ({ width: 80, height: 24 }), tty: true, timeoutMs: 1, write() {} })
    expect(await silent.resolve()).toEqual({ width: 8, height: 16 })
    expect(hostCellPixels({ MENDCODE_CELL_PIXELS: "9x17" })).toEqual({ width: 9, height: 17 })
    expect(hostCellPixels({ MENDCODE_CELL_PIXELS: "0x20" })).toBeUndefined()
    const writes: string[] = []
    const host = terminalPixels({ size: () => ({ width: 80, height: 24 }), tty: true, host: { width: 11, height: 22 }, write: (d) => writes.push(d) })
    expect(await host.resolve()).toEqual({ width: 11, height: 22 })
    expect(writes).toEqual([])
  })
})
