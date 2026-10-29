import { describe, expect, test } from "bun:test"
import { decodePng, type PetImage } from "../src/pets/decode"
import { detectImageProtocol, detectImageTier, IMAGE_MODES } from "../src/pets/detect"
import { encodeImagePng, iterm2Inline, sixelEncode } from "../src/ui/image-protocol"
import { createInlineLayer, MAX_CACHED_IMAGES, type ImagePlacement } from "../src/ui/image-layer"
import { createScreen } from "../src/ui/screen"

const tiny: PetImage = { width: 2, height: 2, rgba: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 0]) }
const white: PetImage = { width: 4, height: 4, rgba: new Uint8Array(64).fill(255) }
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwwZGP6DAAMASMkI+HUch0MAAAAASUVORK5CYII="
const none: ReadonlySet<number> = new Set()

describe("inline image encoders", () => {
  test("2x2 iTerm2 is an exact OSC 1337 inline PNG, cells and preserved aspect", () => {
    expect(iterm2Inline({ image: tiny, cols: 2, rows: 1 })).toBe(`\x1b]1337;File=size=77;inline=1;width=2;height=1;preserveAspectRatio=1:${PNG}\x07`)
    expect(Buffer.from(encodeImagePng(tiny)).toString("base64")).toBe(PNG)
    expect(decodePng(Buffer.from(PNG, "base64"))).toEqual(tiny)
  })

  test("4x4 PNG round-trips all RGBA bytes, including partial alpha; aspect may be disabled", () => {
    const image = { ...white, rgba: Uint8Array.from({ length: 64 }, (_, i) => i * 4) }
    expect(decodePng(encodeImagePng(image))).toEqual(image)
    const out = iterm2Inline({ image: white, cols: 4, rows: 2, preserveAspectRatio: false })
    expect(out).toBe("\x1b]1337;File=size=72;inline=1;width=4;height=2;preserveAspectRatio=0:iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAD0lEQVR4nGP4jwYYSBcAAHg8P8FY7imoAAAAAElFTkSuQmCC\x07")
  })

  test("2x2 sixel draws the RGB pixels in the right columns/bits and skips transparent white", () => {
    expect(sixelEncode(tiny)).toBe('\x1bP0;1;0q"1;1;2;2#3;2;0;0;100#28;2;0;100;0#224;2;100;0;0#3A$#28?@$#224@\x1b\\')
  })

  test("4x4 sixel uses repeat compression and four vertical bits, without filling its last band", () => {
    expect(sixelEncode(white)).toBe('\x1bP0;1;0q"1;1;4;4#255;2;100;100;100#255!4N\x1b\\')
    expect(sixelEncode({ width: 1, height: 7, rgba: new Uint8Array(28).fill(255) })).toBe('\x1bP0;1;0q"1;1;1;7#255;2;100;100;100#255~-#255@\x1b\\')
  })

  test("sixel transparency uses a binary alpha threshold and no unused palette definitions", () => {
    const rgba = new Uint8Array([255, 0, 0, 127, 255, 0, 0, 128])
    expect(sixelEncode({ width: 2, height: 1, rgba })).toBe('\x1bP0;1;0q"1;1;2;1#224;2;100;0;0#224?@\x1b\\')
    expect(sixelEncode({ ...tiny, rgba: new Uint8Array(16) })).toBe('\x1bP0;1;0q"1;1;2;2\x1b\\')
  })

  test("encoders refuse mismatched buffers, invalid dimensions and cell sizes", () => {
    for (const image of [{ ...tiny, width: 0 }, { ...tiny, height: 1.5 }, { ...tiny, width: 4097 }, { ...tiny, rgba: new Uint8Array(3) }]) {
      expect(() => sixelEncode(image)).toThrow(RangeError)
      expect(() => iterm2Inline({ image, cols: 2, rows: 1 })).toThrow(RangeError)
    }
    expect(() => iterm2Inline({ image: tiny, cols: 0, rows: 1 })).toThrow(RangeError)
    expect(() => iterm2Inline({ image: tiny, cols: 2, rows: NaN })).toThrow(RangeError)
  })
})

describe("image protocol detection", () => {
  test("environment matrix, including case and non-exact TERM matches", () => {
    const matrix: Array<[Record<string, string>, string]> = [
      [{}, "off"], [{ TERM_PROGRAM: "iTerm.app" }, "iterm2"], [{ TERM_PROGRAM: "WezTerm" }, "iterm2"],
      [{ TERM_PROGRAM: "ghostty" }, "kitty"], [{ TERM_PROGRAM: "KITTY" }, "kitty"],
      [{ KITTY_WINDOW_ID: "12" }, "kitty"], [{ TERM: "custom-kitty-256color" }, "kitty"],
      [{ TERM: "xterm-ghostty" }, "kitty"], [{ TERM_PROGRAM: "Apple_Terminal" }, "off"],
      [{ TERM: "xterm-sixel" }, "off"], [{ TERM: "vt340" }, "off"],
      [{ TERM_PROGRAM: "iTerm.app", TMUX: "socket" }, "off"], [{ TERM_PROGRAM: "kitty", STY: "screen" }, "off"],
      [{ TERM_PROGRAM: "ghostty", SSH_TTY: "/dev/pts/0" }, "off"],
      [{ TERM_PROGRAM: "ghostty", TMUX: "" }, "kitty"], [{ MENDCODE_PET_IMAGES: "1" }, "kitty"],
      [{ TERM_PROGRAM: "WezTerm", MENDCODE_PET_IMAGES: "0" }, "off"],
    ]
    for (const [env, expected] of matrix) expect(detectImageProtocol(env)).toBe(expected as never)
  })

  test("sixel requires DA1 attribute 4, not a terminal name or another answer", () => {
    expect(detectImageProtocol({}, "auto", { da1: "\x1b[?62;1;4;6c" })).toBe("sixel")
    for (const da1 of ["\x1b[?62;1;6c", "\x1b[?64;1;6c", "\x1b[?4c", "\x1b[>62;4c", "4", "\x1b[?62;14c"]) expect(detectImageProtocol({}, "auto", { da1 })).toBe("off")
    expect(detectImageProtocol({ TERM_PROGRAM: "kitty" }, "auto", { da1: "\x1b[?62;4c" })).toBe("kitty")
    expect(detectImageTier({ TERM_PROGRAM: "iTerm.app" }, "256")).toBe("iterm2")
    expect(detectImageTier({}, "256", "auto", { da1: "\x1b[?62;4c" })).toBe("sixel")
  })

  test("an explicit setting wins over detection, legacy flags, depth and SSH; multiplexers stay disabled", () => {
    for (const mode of IMAGE_MODES.filter((mode) => mode !== "auto")) {
      const env = { TERM_PROGRAM: "ghostty", MENDCODE_PET_IMAGES: "0", SSH_TTY: "ssh" }
      expect(detectImageProtocol(env, mode)).toBe(mode)
      expect(detectImageTier(env, "256", mode)).toBe(mode === "off" ? "halfblock" : mode)
      expect(detectImageProtocol({ ...env, TMUX: "socket" }, mode)).toBe("off")
      expect(detectImageProtocol({ ...env, STY: "screen" }, mode)).toBe("off")
      expect(detectImageProtocol({ ...env, TERM_PROGRAM: "TUIOS", TUIOS_ENV: "1" }, mode)).toBe("off")
      expect(detectImageProtocol({ ...env, TUIOS_ENV: "1" }, mode)).toBe("off")
    }
    // The user's own override still turns pictures on inside a multiplexer.
    expect(detectImageProtocol({ TERM_PROGRAM: "TUIOS", TUIOS_ENV: "1", MENDCODE_PET_IMAGES: "1" })).toBe("kitty")
    expect(detectImageProtocol({ TUIOS_ENV: "1", MENDCODE_PET_IMAGES: "1" }, "sixel")).toBe("sixel")
  })
})

function placement(patch: Partial<ImagePlacement> = {}): ImagePlacement {
  return { slot: "pet", key: "tiny", image: tiny, row: 1, col: 2, cols: 4, rows: 2, ...patch }
}

for (const protocol of ["iterm2", "sixel"] as const) describe(`${protocol} layer and row restoration`, () => {
  const marker = protocol === "iterm2" ? "\x1b]1337;File=" : "\x1bP0;1;0q"

  test("unchanged placements are silent; intersecting text changes redraw, unrelated changes do not", () => {
    const layer = createInlineLayer(protocol)
    layer.setSize?.(20, 8)
    const p = placement()
    expect(layer.uploads([p])).toBe("")
    expect(layer.places([p], none)).toStartWith(`\x1b[2;3H${marker}`)
    expect(layer.places([p], none)).toBe("")
    expect(layer.places([p], new Set([0, 4]))).toBe("")
    expect(layer.places([p], new Set([2]))).toContain(marker)
    expect([...layer.repaintRows!([p])]).toEqual([])
    expect([...layer.repaintRows!([])]).toEqual([1, 2])
  })

  test("removing or moving an image overwrites its old rows and restores unchanged text before placement", () => {
    const writes: string[] = []
    const layer = createInlineLayer(protocol)
    const screen = createScreen({ columns: 20, rows: 8, write: (d) => void writes.push(d) }, { MENDCODE_MOUSE: "0" }, { images: layer })
    const rows = Array.from({ length: 8 }, (_, i) => [{ text: `row ${i}` }])
    screen.draw(rows, { row: 0, col: 1 }, [placement()])
    writes.length = 0
    screen.draw(rows, { row: 0, col: 1 }, [placement({ row: 4 })])
    const move = writes.join("")
    for (const y of [1, 2]) expect(move).toContain(`\x1b[${y + 1};1H\x1b[0m${" ".repeat(20)}\x1b[${y + 1};1Hrow ${y}\x1b[K`)
    expect(move.indexOf(marker)).toBeGreaterThan(move.indexOf("row 2"))
    expect(move).toContain(`\x1b[5;3H${marker}`)
    expect(move).toEndWith("\x1b[1;2H\x1b[?25h\x1b[?2026l")
    writes.length = 0
    screen.draw(rows, undefined, [])
    expect(writes.join("")).not.toContain(marker)
    for (const y of [4, 5]) expect(writes.join("")).toContain(`\x1b[${y + 1};1H\x1b[0m${" ".repeat(20)}\x1b[${y + 1};1Hrow ${y}\x1b[K`)
    writes.length = 0
    screen.draw(rows, undefined, [])
    expect(writes.join("")).toBe("\x1b[?2026h\x1b[?25l\x1b[?2026l")
  })

  test("resize, new content and disappearing off the grid dirty old rows; unchanged slots survive that repaint", () => {
    const layer = createInlineLayer(protocol)
    layer.setSize?.(20, 8)
    const a = placement()
    const b = placement({ slot: "badge", row: 2, col: 10 })
    layer.uploads([a, b])
    layer.places([a, b], none)
    for (const patch of [{ rows: 1 }, { key: "other" }, { col: 19 }, { row: 7 }, { row: -1 }]) expect([...layer.repaintRows!([placement(patch), b])]).toEqual([1, 2])
    layer.uploads([b])
    expect(layer.places([b], layer.repaintRows!([b]))).toContain(`\x1b[3;11H${marker}`)
  })

  test("encoding is cached by size, retained across screen clears, and evicted beyond the cap", () => {
    const layer = createInlineLayer(protocol)
    const p = placement()
    layer.uploads([p])
    const first = layer.places([p], none)
    // A cache hit must not even read the source pixels again.
    const unreadable = { ...p, image: { ...tiny, rgba: new Uint8Array(0) } }
    expect(layer.uploads([unreadable])).toBe("")
    expect(layer.places([unreadable], none)).toBe("")
    layer.invalidate()
    layer.uploads([unreadable])
    expect(layer.places([unreadable], none)).toBe(first)
    expect(() => layer.uploads([{ ...unreadable, cols: 3 }])).toThrow()
    for (let i = 1; i <= MAX_CACHED_IMAGES; i++) layer.uploads([placement({ key: `k${i}` })])
    expect(() => layer.uploads([unreadable])).toThrow()
  })

  test("clearAll and a live switch to off overwrite all occupied cells", () => {
    const layer = createInlineLayer(protocol)
    layer.uploads([placement()])
    layer.places([placement()], none)
    expect(layer.clearAll()).toBe("\x1b[2;3H\x1b[0m    \x1b[3;3H\x1b[0m    ")
    expect(layer.clearAll()).toBe("")
    const writes: string[] = []
    const screen = createScreen({ columns: 20, rows: 8, write: (d) => void writes.push(d) }, {}, { images: layer })
    screen.draw([], undefined, [placement()])
    writes.length = 0
    screen.setImages()
    expect(screen.imageProtocol).toBe("off")
    expect(writes.join("")).toBe("\x1b[2;3H\x1b[0m    \x1b[3;3H\x1b[0m    ")
  })
})

test("sixel scales to the placement's cell geometry, including odd pixel heights", () => {
  const layer = createInlineLayer("sixel", { cellPixels: { width: 3, height: 7 } })
  layer.uploads([placement()])
  expect(layer.places([placement()], none)).toContain('q"1;1;12;14')
  expect(() => createInlineLayer("sixel", { cellPixels: { width: 0, height: 16 } })).toThrow(RangeError)
})
