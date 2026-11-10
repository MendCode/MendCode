import { describe, expect, test } from "bun:test"
import { inflateSync } from "node:zlib"
import type { PetImage } from "../src/pets/decode"
import { detectImageTier } from "../src/pets/detect"
import { kittyDelete, kittyPlace, kittyTransmit, KITTY_CHUNK } from "../src/pets/kitty"
import { createKittyLayer, MAX_CACHED_IMAGES, type ImageLayer, type ImagePlacement } from "../src/ui/image-layer"
import { createScreen } from "../src/ui/screen"

const ST = "\x1b\\"

/** Deterministic noise: it does not compress, so a small image still spans several chunks. */
function noise(width: number, height: number): PetImage {
  const rgba = new Uint8Array(width * height * 4)
  let seed = 12345
  for (let i = 0; i < rgba.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    rgba[i] = seed >> 16
  }
  return { width, height, rgba }
}

function solid(width: number, height: number): PetImage {
  return { width, height, rgba: new Uint8Array(width * height * 4).fill(200) }
}

/** Splits a run of APC graphics commands into control keys and payload. */
function commands(data: string) {
  return [...data.matchAll(/\x1b_G([^;\x1b]*)(?:;([^\x1b]*))?\x1b\\/g)].map((m) => ({ control: m[1]!, payload: m[2] ?? "" }))
}

describe("kitty builders", () => {
  test("a small image is one chunk carrying every control key and a deflated payload", () => {
    const image = solid(2, 2)
    const out = kittyTransmit({ imageId: 7, image })
    const [only, ...rest] = commands(out)
    expect(rest).toHaveLength(0)
    expect(only!.control).toBe("a=t,f=32,s=2,v=2,i=7,o=z,q=2,m=0")
    expect(new Uint8Array(inflateSync(Buffer.from(only!.payload, "base64")))).toEqual(image.rgba)
    expect(out.startsWith("\x1b_G")).toBe(true)
    expect(out.endsWith(ST)).toBe(true)
  })

  test("a payload over 4096 bytes splits with m=1 until the last chunk (m=0) and round-trips to the RGBA", () => {
    const image = noise(64, 64)
    const parts = commands(kittyTransmit({ imageId: 3, image }))
    expect(parts.length).toBeGreaterThan(2)
    expect(parts[0]!.control).toBe(`a=t,f=32,s=64,v=64,i=3,o=z,q=2,m=1`)
    for (const part of parts.slice(1, -1)) expect(part.control).toBe("m=1")
    expect(parts.at(-1)!.control).toBe("m=0")
    for (const part of parts.slice(0, -1)) expect(part.payload).toHaveLength(KITTY_CHUNK)
    expect(parts.at(-1)!.payload.length).toBeLessThanOrEqual(KITTY_CHUNK)
    const joined = parts.map((part) => part.payload).join("")
    expect(new Uint8Array(inflateSync(Buffer.from(joined, "base64")))).toEqual(image.rgba)
  })

  test("transmit refuses an rgba buffer that does not match its size and ids that are not positive integers", () => {
    expect(() => kittyTransmit({ imageId: 1, image: { width: 2, height: 2, rgba: new Uint8Array(3) } })).toThrow(RangeError)
    expect(() => kittyTransmit({ imageId: 0, image: solid(1, 1) })).toThrow(RangeError)
    expect(() => kittyTransmit({ imageId: 1.5, image: solid(1, 1) })).toThrow(RangeError)
  })

  test("place is quiet, leaves the cursor in place and names both ids", () => {
    expect(kittyPlace({ imageId: 9, placementId: 2, cols: 16, rows: 4 })).toBe(`\x1b_Ga=p,i=9,p=2,c=16,r=4,C=1,q=2${ST}`)
    expect(() => kittyPlace({ imageId: 9, placementId: 2, cols: 0, rows: 4 })).toThrow(RangeError)
  })

  test("delete scopes: placement only, image and data, everything of ours", () => {
    expect(kittyDelete({ imageId: 9, placementId: 2 })).toBe(`\x1b_Ga=d,d=i,i=9,p=2,q=2${ST}`)
    expect(kittyDelete({ imageId: 9 })).toBe(`\x1b_Ga=d,d=I,i=9,q=2${ST}`)
    expect(kittyDelete()).toBe(`\x1b_Ga=d,d=A,q=2${ST}`)
    expect(() => kittyDelete({ placementId: 2 })).toThrow(TypeError)
  })
})

function placement(patch: Partial<ImagePlacement> = {}): ImagePlacement {
  return { slot: "pet", key: "greenie/idle/0/16x4", image: solid(4, 4), row: 2, col: 3, cols: 16, rows: 4, ...patch }
}

function layer() {
  const l = createKittyLayer({ random: () => 0 })
  l.setSize?.(80, 24)
  return l
}

const none: ReadonlySet<number> = new Set()

/** One frame the way the screen drives it: uploads first, then places. */
function frame(l: ImageLayer, placements: ImagePlacement[], changed: ReadonlySet<number> = none) {
  return { uploads: l.uploads(placements), places: l.places(placements, changed) }
}

describe("image layer", () => {
  test("the same key twice uploads once and places once", () => {
    const l = layer()
    const first = frame(l, [placement()])
    expect(commands(first.uploads)[0]!.control).toBe("a=t,f=32,s=128,v=64,i=1,o=z,q=2,m=0")
    expect(first.places).toBe(`\x1b[3;4H\x1b_Ga=p,i=1,p=1,c=16,r=4,C=1,q=2${ST}`)
    expect(frame(l, [placement()])).toEqual({ uploads: "", places: "" })
  })

  test("ids start from the random base, so another program's ids are unlikely to collide", () => {
    const l = createKittyLayer({ random: () => 0.5 })
    l.setSize?.(80, 24)
    const id = Number(/i=(\d+)/.exec(l.uploads([placement()]))![1])
    expect(id).toBeGreaterThan(1_000_000_000)
  })

  test("a new key uploads and places the new image, deletes the old placement and keeps the old image cached", () => {
    const l = layer()
    frame(l, [placement()])
    const next = frame(l, [placement({ key: "greenie/idle/1/16x4" })])
    expect(commands(next.uploads).map((c) => c.control)).toEqual(["a=t,f=32,s=128,v=64,i=2,o=z,q=2,m=0"])
    expect(next.places).toBe(`\x1b_Ga=d,d=i,i=1,p=1,q=2${ST}\x1b[3;4H\x1b_Ga=p,i=2,p=1,c=16,r=4,C=1,q=2${ST}`)
    // Back to the first key: still cached, so no upload, only a re-place.
    const back = frame(l, [placement()])
    expect(back.uploads).toBe("")
    expect(back.places).toBe(`\x1b_Ga=d,d=i,i=2,p=1,q=2${ST}\x1b[3;4H\x1b_Ga=p,i=1,p=1,c=16,r=4,C=1,q=2${ST}`)
  })

  test("moving reuses the raster; resizing uploads a new integer-scaled raster", () => {
    const l = layer()
    frame(l, [placement()])
    expect(frame(l, [placement({ row: 5 })])).toEqual({ uploads: "", places: `\x1b[6;4H\x1b_Ga=p,i=1,p=1,c=16,r=4,C=1,q=2${ST}` })
    const resized = frame(l, [placement({ row: 5, cols: 8, rows: 2 })])
    expect(resized.uploads).toContain("s=64,v=32")
    expect(resized.places).toBe(`\x1b_Ga=d,d=i,i=1,p=1,q=2${ST}\x1b[6;4H\x1b_Ga=p,i=2,p=1,c=8,r=2,C=1,q=2${ST}`)
  })

  test("part of a taller picture: the whole raster is uploaded once and each cut names its pixel rows", () => {
    const l = layer()
    // Rows 1 and 2 of a picture four rows tall.
    const cut = frame(l, [placement({ rows: 2, part: { of: 4, skip: 1 } })])
    expect(commands(cut.uploads)[0]!.control).toBe("a=t,f=32,s=128,v=64,i=1,o=z,q=2,m=0")
    expect(cut.places).toBe(`\x1b[3;4H\x1b_Ga=p,i=1,p=1,y=16,h=32,c=16,r=2,C=1,q=2${ST}`)
    // One more row scrolls into view: the same raster, another band.
    expect(frame(l, [placement({ rows: 3, part: { of: 4, skip: 1 } })])).toEqual({ uploads: "", places: `\x1b[3;4H\x1b_Ga=p,i=1,p=1,y=16,h=48,c=16,r=3,C=1,q=2${ST}` })
    // Whole again: still the same raster, no band.
    expect(frame(l, [placement()])).toEqual({ uploads: "", places: `\x1b[3;4H\x1b_Ga=p,i=1,p=1,c=16,r=4,C=1,q=2${ST}` })
  })

  test("a slot that disappears has its placement deleted and the data kept for later", () => {
    const l = layer()
    frame(l, [placement()])
    expect(frame(l, [])).toEqual({ uploads: "", places: `\x1b_Ga=d,d=i,i=1,p=1,q=2${ST}` })
    expect(frame(l, [])).toEqual({ uploads: "", places: "" })
    expect(frame(l, [placement()]).uploads).toBe("")
  })

  test("invalidate (after ESC[2J) re-uploads and re-places on the next frame", () => {
    const l = layer()
    frame(l, [placement()])
    l.invalidate()
    const again = frame(l, [placement()])
    expect(commands(again.uploads)).toHaveLength(1)
    expect(again.places).toContain("a=p,")
  })

  test("text changes do not re-place unless the rows trigger sees a change under the image", () => {
    const l = layer()
    frame(l, [placement()])
    expect(frame(l, [placement()], new Set([0, 1, 6, 7])).places).toBe("")
    expect(frame(l, [placement()], new Set([4])).places).toContain("a=p,i=1,p=1")
  })

  test("a placement on the last row or the last column is skipped, and never uploaded", () => {
    const l = layer()
    // 80x24 grid: rows 0..22 and cols 0..78 are usable.
    expect(frame(l, [placement({ row: 20, rows: 4 })])).toEqual({ uploads: "", places: "" })
    expect(frame(l, [placement({ col: 65, cols: 16 })])).toEqual({ uploads: "", places: "" })
    expect(frame(l, [placement({ row: 19, rows: 4, col: 64, cols: 15 })]).places).toContain("a=p,")
  })

  test("a placement that moves onto the last row is deleted rather than left behind", () => {
    const l = layer()
    frame(l, [placement()])
    expect(frame(l, [placement({ row: 21 })]).places).toBe(`\x1b_Ga=d,d=i,i=1,p=1,q=2${ST}`)
  })

  test("the cache frees the oldest unused image past its cap and forgets its placement", () => {
    const l = layer()
    frame(l, [placement({ key: "k0" })])
    for (let i = 1; i < MAX_CACHED_IMAGES; i++) l.uploads([placement({ key: `k${i}`, slot: `s${i}` })])
    const next = l.uploads([placement({ key: "overflow", slot: "overflow" })])
    expect(commands(next).map((c) => c.control)[0]).toBe("a=d,d=I,i=1,q=2")
    // k0 was freed: showing it again uploads again.
    expect(l.uploads([placement({ key: "k0" })])).toContain("a=t,")
  })

  test("clearAll frees every image of ours and leaves nothing cached", () => {
    const l = layer()
    frame(l, [placement(), placement({ slot: "badge", key: "b", row: 8 })])
    expect(commands(l.clearAll()).map((c) => c.control)).toEqual(["a=d,d=I,i=1,q=2", "a=d,d=I,i=2,q=2"])
    expect(l.clearAll()).toBe("")
    expect(frame(l, [placement()]).uploads).toContain("a=t,")
  })
})

/** A layer that records what the screen asks of it and returns marker strings. */
function fakeLayer() {
  const calls: string[] = []
  const l: ImageLayer = {
    uploads: () => (calls.push("uploads"), "<UP>"),
    places: (_p, rows) => (calls.push(`places:${[...rows].join(",")}`), "<PLACE>"),
    invalidate: () => void calls.push("invalidate"),
    clearAll: () => (calls.push("clearAll"), "<CLEAR>"),
    setSize: (w, h) => void calls.push(`size:${w}x${h}`),
  }
  return { l, calls }
}

function capture(options?: { images?: ImageLayer }, env: Record<string, string | undefined> = {}) {
  const writes: string[] = []
  const out = { write: (d: string) => void writes.push(d), columns: 20, rows: 6 }
  const s = options ? createScreen(out, { COLORTERM: "truecolor", MENDCODE_MOUSE: "0", ...env }, options) : createScreen(out, { COLORTERM: "truecolor", MENDCODE_MOUSE: "0", ...env })
  return { s, writes }
}

describe("screen with an image layer", () => {
  const rows = [[{ text: "hello" }], [{ text: "world" }]]

  test("without a layer, or with a layer and no placements, the bytes are identical", () => {
    const plain = capture()
    const empty = capture({})
    const quiet = capture({ images: { uploads: () => "", places: () => "", invalidate() {}, clearAll: () => "" } })
    for (const c of [plain, empty, quiet]) {
      c.s.enter()
      c.s.draw(rows, { row: 1, col: 2 })
      c.s.draw([[{ text: "hello!" }], []], undefined)
      c.s.resize(20, 6)
      c.s.draw(rows)
      c.s.leave()
    }
    expect(empty.writes).toEqual(plain.writes)
    expect(quiet.writes).toEqual(plain.writes)
  })

  test("a real layer with no placements also writes exactly what a screen without one writes", () => {
    const plain = capture()
    const withLayer = capture({ images: createKittyLayer({ random: () => 0 }) })
    for (const c of [plain, withLayer]) {
      c.s.enter()
      c.s.draw(rows, { row: 0, col: 0 })
      c.s.leave()
    }
    expect(withLayer.writes).toEqual(plain.writes)
  })

  test("uploads are written before the synchronized frame, placements inside it before the final cursor move", () => {
    const { l } = fakeLayer()
    const { s, writes } = capture({ images: l })
    s.draw(rows, { row: 1, col: 2 }, [placement()])
    expect(writes).toHaveLength(2)
    expect(writes[0]).toBe("<UP>")
    expect(writes[1]!.startsWith("\x1b[?2026h")).toBe(true)
    expect(writes[1]!.endsWith("\x1b[?2026l")).toBe(true)
    const frameText = writes[1]!
    expect(frameText.indexOf("<PLACE>")).toBeGreaterThan(frameText.indexOf("hello"))
    expect(frameText.indexOf("<PLACE>")).toBeLessThan(frameText.indexOf("\x1b[2;3H\x1b[?25h"))
    expect(frameText.endsWith("<PLACE>\x1b[2;3H\x1b[?25h\x1b[?2026l")).toBe(true)
  })

  test("the exact frame: text diff, then placement, then the cursor, all inside the sync block", () => {
    const { s, writes } = capture({ images: createKittyLayer({ random: () => 0 }) })
    const image = solid(2, 2)
    s.draw([[{ text: "ab" }]], { row: 0, col: 2 }, [{ slot: "pet", key: "k", image, row: 1, col: 4, cols: 8, rows: 2 }])
    expect(commands(writes[0]!).map((c) => c.control)).toEqual(["a=t,f=32,s=64,v=32,i=1,o=z,q=2,m=0"])
    const blank = Array.from({ length: 5 }, (_, i) => `\x1b[${i + 2};1H\x1b[K`).join("")
    expect(writes[1]).toBe(
      `\x1b[?2026h\x1b[1;1Hab\x1b[K${blank}\x1b[2;5H\x1b_Ga=p,i=1,p=1,c=8,r=2,C=1,q=2${ST}\x1b[1;3H\x1b[?25h\x1b[?2026l`,
    )
    // Unchanged image and text: the frame carries only the cursor.
    s.draw([[{ text: "ab" }]], { row: 0, col: 2 }, [{ slot: "pet", key: "k", image, row: 1, col: 4, cols: 8, rows: 2 }])
    expect(writes).toHaveLength(3)
    expect(writes[2]).toBe("\x1b[?2026h\x1b[1;3H\x1b[?25h\x1b[?2026l")
  })

  test("the layer learns the grid size, at creation and on resize", () => {
    const { l, calls } = fakeLayer()
    const { s } = capture({ images: l })
    s.resize(30, 10)
    expect(calls).toEqual(["size:20x6", "size:30x10", "invalidate"])
  })

  test("enter and resize invalidate the layer, because both write ESC[2J", () => {
    const { l, calls } = fakeLayer()
    const { s, writes } = capture({ images: l })
    s.enter()
    s.resize(20, 6)
    expect(calls.filter((c) => c === "invalidate")).toHaveLength(2)
    expect(writes.every((w) => w.includes("\x1b[2J"))).toBe(true)
  })

  test("leave clears our images before the alternate screen is left", () => {
    const { l } = fakeLayer()
    const { s, writes } = capture({ images: l })
    s.leave()
    expect(writes[0]).toContain("<CLEAR>")
    expect(writes[0]!.indexOf("<CLEAR>")).toBeLessThan(writes[0]!.indexOf("\x1b[?1049l"))
    expect(writes[0]!.endsWith("<CLEAR>\x1b[?1049l")).toBe(true)
  })

  test("changed rows reach the layer only with MENDCODE_IMAGES_REPLACE=rows", () => {
    const off = fakeLayer()
    capture({ images: off.l }).s.draw(rows, undefined, [placement()])
    expect(off.calls).toContain("places:")
    const on = fakeLayer()
    const c = capture({ images: on.l }, { MENDCODE_IMAGES_REPLACE: "rows" })
    c.s.draw(rows, undefined, [placement()])
    expect(on.calls).toContain("places:0,1,2,3,4,5")
    c.s.draw(rows, undefined, [placement()])
    expect(on.calls.at(-1)).toBe("places:")
  })
})

describe("detectImageTier", () => {
  const tier = (env: Record<string, string | undefined>, depth: "truecolor" | "256" = "truecolor") => detectImageTier(env, depth)

  test("Kitty-protocol terminals are recognised by their variables", () => {
    expect(tier({ TERM: "xterm-kitty" })).toBe("kitty")
    expect(tier({ KITTY_WINDOW_ID: "3" })).toBe("kitty")
    expect(tier({ TERM_PROGRAM: "ghostty" })).toBe("kitty")
    expect(tier({ TERM: "xterm-ghostty" })).toBe("kitty")
    expect(tier({ TERM_PROGRAM: "WezTerm" })).toBe("iterm2")
  })

  test("other terminals get half-blocks", () => {
    expect(tier({})).toBe("halfblock")
    expect(tier({ TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" })).toBe("halfblock")
    expect(tier({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm2")
  })

  test("tmux, screen and SSH fall back to half-blocks even in a Kitty terminal", () => {
    for (const extra of [{ TMUX: "/tmp/tmux-1/default,1,0" }, { STY: "1.pts" }, { SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22" }, { SSH_TTY: "/dev/pts/0" }]) {
      expect(tier({ TERM_PROGRAM: "ghostty", ...extra })).toBe("halfblock")
    }
    expect(tier({ TERM_PROGRAM: "ghostty", TMUX: "" })).toBe("kitty")
  })

  test("MENDCODE_PET_IMAGES=0 vetoes auto, =1 forces Kitty past tmux and SSH", () => {
    expect(tier({ TERM_PROGRAM: "ghostty", MENDCODE_PET_IMAGES: "0" })).toBe("halfblock")
    expect(tier({ TERM_PROGRAM: "ghostty", MENDCODE_PET_IMAGES: "0", TMUX: "x" })).toBe("halfblock")
    expect(tier({ TMUX: "x", MENDCODE_PET_IMAGES: "1" })).toBe("kitty")
    expect(tier({ SSH_TTY: "/dev/pts/0", MENDCODE_PET_IMAGES: "1" })).toBe("kitty")
    expect(tier({ MENDCODE_PET_IMAGES: "1" })).toBe("kitty")
  })

  test("256-color depth is half-blocks, never off", () => {
    expect(tier({ TERM_PROGRAM: "ghostty" }, "256")).toBe("halfblock")
    expect(tier({}, "256")).toBe("halfblock")
  })
})

test("after leave nothing more is drawn: a frame asked for while the process finishes closing does not reach the shell's screen", () => {
  let out = ""
  const s = createScreen({ columns: 40, rows: 6, isTTY: true, write: (data: string) => { out += data; return true } } as never, {})
  s.enter()
  s.draw([[{ text: "chat" }]])
  s.leave()
  out = ""
  s.draw([[{ text: "late frame" }]], undefined, [{ slot: "pet", key: "k", image: solid(4, 4), row: 1, col: 4, cols: 8, rows: 2 }])
  expect(out).toBe("")
  s.enter()
  out = ""
  s.draw([[{ text: "back" }]])
  expect(out).toContain("back")
})
