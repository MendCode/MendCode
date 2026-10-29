import { afterEach, describe, expect, test } from "bun:test"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { createHash } from "node:crypto"
import { DEFAULT_IMAGE_ROOM, DEFAULT_IMAGE_WAIT_CANVAS, IMAGE_WAIT_PRESETS, imageRoomRows, imageWaitConfig, imageWaitDetails, imageWaitFrame, imageWaitFrameAt, imageWaitFrameCount, imageWaitRows, imageWaitSize, normalizeImageWaitArt, normalizeImageWaitCanvas, requestedPixels, type ImageRoom, type ImageWaitCanvas, type ImageWaitConfig } from "../src/view/image-wait"
import { createScreen } from "../src/ui/screen"
import { encodeImagePng } from "../src/ui/image-protocol"
import { renderToolCard } from "../src/view/tool-card"
import { createTranscript, type PresentationMode } from "../src/view/transcript"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { customizePageKey, CUSTOMIZE_ROWS, renderCustomizePage } from "../src/view/customize-page"
import { glyphs, type Line } from "../src/ui/theme"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps, conversation, ids as harnessIds, NOW, plain, tempDir } from "./session-ui-harness"
import { TUI_DEFAULTS, tuiProblems } from "@mendcode/protocol/wire"

afterEach(cleanTemps)

const text = (rows: Line[]) => rows.map((row) => row.map((span) => span.text).join(""))
const config = (patch: Partial<TuiProfile> = {}, motion = true): ImageWaitConfig => imageWaitConfig({ ...DEFAULT_TUI_PROFILE, ...patch }, motion)

describe("the wait canvas's frames", () => {
  test("every built-in preset fills the field exactly and moves from one frame to the next", () => {
    for (const preset of IMAGE_WAIT_PRESETS) {
      const cfg = config({ imageWaitPreset: preset })
      const frames = [0, 1, 2, 3].map((frame) => imageWaitFrame(cfg, frame, 40, 10))
      for (const frame of frames) {
        expect(frame).toHaveLength(10)
        expect(frame.every((row) => row.length === 40)).toBe(true)
        expect(frame.join("").trim().length).toBeGreaterThan(0)
      }
      expect(new Set(frames.map((frame) => frame.join("\n"))).size).toBeGreaterThan(1)
    }
  })

  test("the orbit's focal mark wanders instead of sitting in the centre", () => {
    const cfg = config({ imageWaitPreset: "orbit" })
    const where = [0, 4, 8].map((frame) => {
      const rows = imageWaitFrame(cfg, frame, 40, 16)
      const y = rows.findIndex((row) => /[@O]/.test(row))
      return `${rows[y]!.search(/[@O]/)}:${y}`
    })
    expect(new Set(where).size).toBe(3)
  })

  test("drops is the default, 16 frames a preset, cycle plays the five others in turn", () => {
    expect(DEFAULT_TUI_PROFILE.imageWaitPreset).toBe("drops")
    expect(imageWaitFrameCount(config())).toBe(16)
    expect(imageWaitFrameCount(config({ imageWaitPreset: "cycle" }))).toBe(80)
    const cycle = config({ imageWaitPreset: "cycle" })
    // Frame 16 of cycle is the constellation's first frame; frame 0 is the drops' first.
    expect(imageWaitFrame(cycle, 0, 30, 8)).toEqual(imageWaitFrame(config(), 0, 30, 8))
    expect(imageWaitFrame(cycle, 16, 30, 8)).toEqual(imageWaitFrame(config({ imageWaitPreset: "constellation" }), 0, 30, 8))
  })

  test("the frame follows the elapsed time at the configured speed; static and reduced motion stay on the first", () => {
    expect(imageWaitFrameAt(config(), 0)).toBe(0)
    expect(imageWaitFrameAt(config(), 279)).toBe(0)
    expect(imageWaitFrameAt(config(), 560)).toBe(2)
    expect(imageWaitFrameAt(config({ imageWaitSpeed: 1000 }), 2500)).toBe(2)
    expect(imageWaitFrameAt(config({ imageWait: "static" }), 9000)).toBe(0)
    expect(imageWaitFrameAt(config({}, false), 9000)).toBe(0)
    expect(config({}, false).mode).toBe("static")
  })
})

describe("the canvas's size", () => {
  const canvas = DEFAULT_IMAGE_WAIT_CANVAS
  const size = (requested: string | undefined, maxCols = 140, room: ImageRoom = DEFAULT_IMAGE_ROOM, bounds: ImageWaitCanvas = canvas) => imageWaitSize({ size: requested, maxCols, room, canvas: bounds })

  test("a requested size reads as pixels: WxH, an aspect at 1024 on its long side; auto and anything else is unknown", () => {
    expect(requestedPixels("1024x1536")).toEqual({ width: 1024, height: 1536 })
    expect(requestedPixels(" 1536×1024 ")).toEqual({ width: 1536, height: 1024 })
    expect(requestedPixels("16:9")).toEqual({ width: 1024, height: 576 })
    for (const unknown of ["auto", "", undefined, "0x512", "99999x10", "big"]) expect(requestedPixels(unknown)).toBeUndefined()
  })

  test("the box takes the picture's shape at v1's height: square 48×24, portrait 32×24, landscape 72×24; auto is square", () => {
    expect(size("1024x1024")).toEqual({ width: 48, height: 24 })
    expect(size("1024x1536")).toEqual({ width: 32, height: 24 })
    expect(size("1536x1024")).toEqual({ width: 72, height: 24 })
    expect(size("auto")).toEqual({ width: 48, height: 24 })
    expect(size(undefined)).toEqual({ width: 48, height: 24 })
    // Any other size keeps its shape inside the bounds: 1792x1024 fills the 72 columns and is 21 rows tall.
    expect(size("1792x1024")).toEqual({ width: 72, height: 21 })
    // `heightRatio` is auto's shape.
    expect(size("auto", 140, DEFAULT_IMAGE_ROOM, { ...canvas, heightRatio: 1.5 })).toEqual({ width: 32, height: 24 })
  })

  test("pixels become cells at the terminal's cell size, so a cell's real shape gives the same picture", () => {
    expect(size("1024x1024", 140, { rows: 120, cell: { width: 10, height: 20 } })).toEqual({ width: 48, height: 24 })
    expect(size("1024x1024", 140, { rows: 120, cell: { width: 9, height: 21 } })).toEqual({ width: 56, height: 24 })
  })

  test("a narrow card or a short screen shrinks the box, keeping its shape; it never overflows either", () => {
    expect(size("1536x1024", 40)).toEqual({ width: 40, height: 14 })
    expect(size("1024x1024", 140, { ...DEFAULT_IMAGE_ROOM, rows: imageRoomRows(24) })).toEqual({ width: 32, height: 16 })
    expect(imageRoomRows(30)).toBe(22)
    expect(imageRoomRows(3)).toBe(6)
    for (const requested of ["1024x1024", "1024x1536", "1536x1024", "auto", "4096x256", "256x4096"]) {
      for (const maxCols of [4, 12, 30, 80, 200]) {
        for (const rows of [3, 6, 14, 40]) {
          const box = size(requested, maxCols, { ...DEFAULT_IMAGE_ROOM, rows })
          expect(box.width).toBeLessThanOrEqual(maxCols)
          expect(box.height).toBeLessThanOrEqual(rows)
          const drawn = imageWaitRows({ config: imageWaitConfig(DEFAULT_TUI_PROFILE, true, { ...DEFAULT_IMAGE_ROOM, rows }), prefix: [{ text: "  " }], maxCols, elapsedMs: 0, details: { model: "openai/gpt-image-2", size: requested }, ascii: false })
          expect(drawn.length).toBeLessThanOrEqual(rows)
          expect(text(drawn).every((line) => textWidth(line) <= 2 + maxCols)).toBe(true)
        }
      }
    }
  })

  test("a very long or tall shape keeps the canvas legible: it grows to minWidth × minHeight where the room allows", () => {
    expect(size("4096x512")).toEqual({ width: 72, height: 8 })
    expect(size("4096x512", 140, { ...DEFAULT_IMAGE_ROOM, rows: 6 })).toEqual({ width: 72, height: 6 })
    expect(size("256x4096")).toEqual({ width: 16, height: 24 })
  })

  test("stored bounds are clamped so the ranges stay ordered; the old fixed-box defaults become today's", () => {
    expect(normalizeImageWaitCanvas({ minWidth: 80, maxWidth: 40, minHeight: 2, maxHeight: 999, heightRatio: 9, paddingX: -1 })).toEqual({ minWidth: 80, maxWidth: 80, minHeight: 6, maxHeight: 120, heightRatio: 4, paddingX: 0, paddingY: 1 })
    expect(normalizeImageWaitCanvas("nope")).toEqual({ ...DEFAULT_IMAGE_WAIT_CANVAS })
    expect(normalizeImageWaitCanvas({ minWidth: 28, maxWidth: 52, minHeight: 12, maxHeight: 16, heightRatio: 1 / 2.2, paddingX: 2, paddingY: 1 })).toEqual({ ...DEFAULT_IMAGE_WAIT_CANVAS })
    // Changed by hand: kept.
    expect(normalizeImageWaitCanvas({ minWidth: 28, maxWidth: 52, minHeight: 12, maxHeight: 18, heightRatio: 1 / 2.2, paddingX: 2, paddingY: 1 }).maxHeight).toBe(18)
    expect(DEFAULT_TUI_PROFILE.imageWaitCanvas).toEqual(TUI_DEFAULTS.imageWaitCanvas)
  })

  test("the rows: a bordered box after the prefix, the field, the model and size, exactly the box's cells", () => {
    for (const maxCols of [20, 34, 60, 120]) {
      const rows = imageWaitRows({ config: config(), prefix: [{ text: "  " }], maxCols, elapsedMs: 0, details: { model: "openai/gpt-image-2", size: "1536x1024" }, ascii: false })
      const lines = text(rows)
      const box = size("1536x1024", maxCols)
      expect(rows).toHaveLength(box.height)
      expect(lines.every((line) => textWidth(line) === 2 + box.width)).toBe(true)
      expect(lines[0]).toStartWith("  ┌")
      expect(lines.at(-1)).toStartWith("  └")
      expect(lines.join("\n")).toContain("size 1536x1024")
    }
    const ascii = text(imageWaitRows({ config: config({ imageWaitMeta: false }), prefix: [], maxCols: 40, elapsedMs: 0, details: {}, ascii: true }))
    expect(ascii[0]).toMatch(/^\+-+\+$/)
    expect(ascii.join("")).not.toContain("size")
  })

  test("a short box gives up its padding, then the model row, then the size row, before the field", () => {
    const rowsAt = (rows: number) => text(imageWaitRows({ config: imageWaitConfig(DEFAULT_TUI_PROFILE, false, { ...DEFAULT_IMAGE_ROOM, rows }), prefix: [], maxCols: 80, elapsedMs: 0, details: { model: "openai/gpt-image-2", size: "1536x1024" }, ascii: false }))
    const full = rowsAt(9)
    expect(full).toHaveLength(9)
    expect(full[1]).toMatch(/^│ +│$/)
    expect(full.join("\n")).toContain("openai/gpt-image-2")
    const six = rowsAt(6)
    expect(six).toHaveLength(6)
    expect(six.join("\n")).not.toContain("openai/gpt-image-2")
    // 18 columns at 6 rows: the size row is cut to the field.
    expect(six.join("\n")).toContain("size 1536x1…")
    const five = rowsAt(5)
    expect(five).toHaveLength(5)
    expect(five.join("\n")).not.toContain("size")
    expect(rowsAt(2)).toEqual([])
  })

  test("the model and size come from the lines an image tool prints first", () => {
    expect(imageWaitDetails("model openai/gpt-image-2\nsize 1024x1536\n")).toEqual({ model: "openai/gpt-image-2", size: "1024x1536" })
    expect(imageWaitDetails("")).toEqual({})
  })
})

describe("user presets", () => {
  test("frames, a still picture, fit and alignment; bad entries are dropped", () => {
    const art = normalizeImageWaitArt([
      { name: "ab", frames: [["A"], "B"] },
      { name: "still", static: "XY\nZ" },
      { name: "drops", frames: [["no"]] },
      { name: "ab", frames: [["dup"]] },
      { name: "", frames: [["x"]] },
      { name: "empty", frames: [[""], ["   "]] },
      { name: "esc", frames: ["\x1b[31mred\x1b[0m\tx", "宽"] },
      "junk",
    ])
    expect(art.map((entry) => entry.name)).toEqual(["ab", "still", "esc"])
    expect(art[2]!.frames).toEqual([["red x"], ["?"]])
    const ab = config({ imageWaitArt: art, imageWaitPreset: "ab" })
    expect(imageWaitFrameCount(ab)).toBe(2)
    expect(imageWaitFrame(ab, 0, 9, 5)[2]).toBe("    A    ")
    expect(imageWaitFrame(ab, 1, 9, 5)[2]).toBe("    B    ")
    expect(imageWaitFrame(config({ imageWaitArt: art, imageWaitPreset: "still" }), 7, 4, 3)).toEqual([" XY ", " Z  ", "    "])
    const left = normalizeImageWaitArt([{ name: "l", static: ["1", "2", "3", "4", "5"], fit: "crop", align: "left" }])
    expect(imageWaitFrame(config({ imageWaitArt: left, imageWaitPreset: "l" }), 0, 3, 3)).toEqual(["2  ", "3  ", "4  "])
  })

  test("the profile keeps a preset only when it names a built-in or one of the user's", () => {
    const profile = normalizeTuiProfile({ imageWaitArt: [{ name: "fox", static: "^.^" }], imageWaitPreset: "fox", imageWaitSpeed: 10, imageWait: "loop", imageWaitColor: "accent" })
    expect(profile.imageWaitPreset).toBe("fox")
    expect(profile.imageWaitSpeed).toBe(80)
    expect(profile.imageWait).toBe("animated")
    expect(profile.imageWaitColor).toBe("accent")
    expect(normalizeTuiProfile({ imageWaitPreset: "fox" }).imageWaitPreset).toBe("drops")
    expect(Object.keys(DEFAULT_TUI_PROFILE).filter((key) => key.startsWith("imageWait")).sort()).toEqual(Object.keys(TUI_DEFAULTS).filter((key) => key.startsWith("imageWait")).sort())
    expect(tuiProblems({ imageWaitSpeed: 50 })).toEqual(["imageWaitSpeed: expected integer 80..5000 (milliseconds per frame)"])
    expect(tuiProblems({ imageWait: "static", imageWaitArt: [{ name: "fox", frames: [["^.^"]] }], imageWaitCanvas: { minWidth: 30 } })).toEqual([])
  })
})

describe("/customize", () => {
  const at = (row: string) => ({ row: CUSTOMIZE_ROWS.indexOf(row as (typeof CUSTOMIZE_ROWS)[number]) })
  test("the preset row cycles the built-ins, then the user's own", () => {
    const profile = { ...DEFAULT_TUI_PROFILE, imageWaitArt: normalizeImageWaitArt([{ name: "fox", static: "^.^" }]), imageWaitPreset: "scanner" }
    expect(customizePageKey(at("imageWaitPreset"), "l", profile).action).toEqual({ type: "set", patch: { imageWaitPreset: "fox" } })
    expect(customizePageKey(at("imageWaitPreset"), "l", { ...profile, imageWaitPreset: "fox" }).action).toEqual({ type: "set", patch: { imageWaitPreset: "drops" } })
    expect(customizePageKey(at("imageWait"), "l", DEFAULT_TUI_PROFILE).action).toEqual({ type: "set", patch: { imageWait: "static" } })
    expect(customizePageKey(at("imageWaitMeta"), " ", DEFAULT_TUI_PROFILE).action).toEqual({ type: "set", patch: { imageWaitMeta: false } })
  })

  test("the speed is typed and checked", () => {
    const typing = { ...at("imageWaitSpeed"), typing: "40" }
    expect(customizePageKey(typing, "\r", DEFAULT_TUI_PROFILE).state.error).toBe("Use an integer 80..5000")
    expect(customizePageKey({ ...typing, typing: "400" }, "\r", DEFAULT_TUI_PROFILE).action).toEqual({ type: "set", patch: { imageWaitSpeed: 400 } })
  })

  test("the preview pane draws the canvas with the profile's look", () => {
    const page = renderCustomizePage({ state: at("imageWaitPreset"), profile: { ...DEFAULT_TUI_PROFILE, imageWaitPreset: "orbit" }, preview: { root: "/work", tip: "", now: NOW }, width: 140, height: 44 }).map(plain).join("\n")
    expect(page).toContain("Image wait preview")
    expect(page).toContain("Generating image")
    expect(page).toContain("openai/gpt-image-2")
    expect(page).toMatch(/[@O]/)
  })
})

/** A transcript with one running image call; `time` moves the clock the card's elapsed time is read from. */
function running(options: { tool: string; mode?: PresentationMode; motion?: boolean; text?: string }) {
  const id = createIdFactory()
  const sessionId = id("session")
  const turnId = id("turn")
  const itemId = id("item")
  let clock = 1_000
  let seq = 0
  const transcript = createTranscript({ glyphs: glyphs({}), mode: options.mode ?? "balanced", now: () => clock, ...(options.motion === false ? { motion: () => false } : {}) })
  const ev = (event: Record<string, unknown>) => transcript.apply({ sessionId, seq: ++seq, at: clock, ...event } as SessionEvent)
  ev({ type: "turn.started", turnId, queueId: id("queue") })
  ev({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: options.tool } })
  if (options.text) ev({ type: "item.delta", itemId, text: options.text })
  return {
    rows: (width = 90) => transcript.viewport(width, 40).map((line) => line.text),
    time: (ms: number) => void (clock += ms),
    say: (text: string) => ev({ type: "item.delta", itemId, text }),
    finish: () => ev({ type: "item.completed", itemId, status: "ok", text: "saved generated/a-fox-1.png (PNG, 1 KB)\nmodel gpt-image-2" }),
  }
}

describe("the transcript", () => {
  test("a running image_gen and the hosted image_generation draw the canvas in every view, and it moves with time", () => {
    for (const tool of ["image_gen: a fox in snow", "image_generation"]) {
      for (const mode of ["minimal", "balanced", "full"] as const) {
        const call = running({ tool, mode, text: tool.startsWith("image_gen") ? "model openai/gpt-image-2\nsize 1024x1024\n" : "" })
        const first = call.rows()
        expect(first.join("\n")).toContain("Generating image")
        expect(first.join("\n")).toContain("┌")
        expect(first.join("\n")).toContain(tool.startsWith("image_gen") ? "openai/gpt-image-2" : "default image model")
        call.time(280)
        expect(call.rows()).not.toEqual(first)
      }
    }
  })

  test("a call that starts without a size draws auto's square and takes the size's shape once it is reported", () => {
    const call = running({ tool: "image_generation" })
    const box = () => {
      const rows = call.rows(120)
      const top = rows.find((row) => row.includes("┌"))!
      return { cols: top.lastIndexOf("┐") - top.indexOf("┌") + 1, rows: rows.filter((row) => /[│┌└]/.test(row.trim()[0] ?? "")).length }
    }
    expect(box()).toEqual({ cols: 48, rows: 24 })
    expect(call.rows(120).join("\n")).toContain("size auto")
    call.say("size 1024x1536\n")
    expect(box()).toEqual({ cols: 32, rows: 24 })
    expect(call.rows(120).join("\n")).toContain("size 1024x1536")
  })

  test("reduced motion holds the first frame", () => {
    const call = running({ tool: "image_gen: a fox", motion: false })
    const first = call.rows()
    for (const ms of [280, 560, 5_000]) {
      call.time(ms)
      expect(call.rows().filter((line) => line.includes("│ │"))).toEqual(first.filter((line) => line.includes("│ │")))
    }
  })

  test("once the call ends the canvas is gone and the card no longer changes with time", () => {
    const call = running({ tool: "image_gen: a fox" })
    call.finish()
    const done = call.rows()
    expect(done.join("\n")).not.toContain("Generating image")
    expect(done.join("\n")).not.toContain("┌")
    call.time(5_000)
    expect(call.rows()).toEqual(done)
  })

  test("a call that waits for its approval keeps the plain header", () => {
    const rows = text(renderToolCard({ title: "image_gen: a fox", text: "", status: "running", width: 80, expanded: false, frame: 0, tailLines: 4, awaiting: true }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain("Image")
    expect(rows[0]).not.toContain("Generating")
  })
})

/** A solid picture of `width` × `height` pixels as PNG bytes. */
function png(width: number, height: number) {
  const rgba = new Uint8Array(width * height * 4)
  for (let at = 0; at < rgba.length; at += 4) rgba.set([40, 120, 200, 255], at)
  return encodeImagePng({ width, height, rgba })
}

/** The cells of the wait canvas while an `image_gen` of `requested` runs, then those of the picture it made, on a kitty terminal. */
async function canvasThenPicture(options: { requested: string; pixels: [number, number]; width: number; height: number; profile?: Partial<TuiProfile> }) {
  const env = { COLORTERM: "truecolor", MENDCODE_MOUSE: "0", KITTY_WINDOW_ID: "1", TERM: "xterm-kitty" }
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, images: "kitty", sidebar: "hidden", ...options.profile })
  const bytes = png(...options.pixels)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const screen = createScreen({ columns: options.width, rows: options.height, write: () => {} }, env)
  const h = appHarness({
    dataDir, screen, env, width: options.width, height: options.height, imageAnswers: { cellPixels: { width: 8, height: 16 } },
    reply: (command) => (command.type === "attachment.read" ? ({ ok: true, result: { sha256, mime: "image/png", bytes: bytes.length, offset: 0, data: Buffer.from(bytes).toString("base64"), done: true } } as never) : undefined),
  })
  h.app.applySettings({ onboarded: true })
  await h.app.imagesReady
  const chat = conversation(h.sessionId, h.app.onEvent), turnId = harnessIds("turn"), itemId = harnessIds("item")
  chat.emit({ type: "turn.started", turnId, queueId: harnessIds("queue") })
  chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "image_gen: a fox" } })
  chat.emit({ type: "item.delta", itemId, text: `model openai/gpt-image-2\nsize ${options.requested}\n` })
  h.app.render()
  const frame = h.text()
  const top = frame.findIndex((row) => row.includes("┌"))
  const bottom = frame.findIndex((row, at) => at > top && row.includes("└"))
  const canvas = { col: [...frame[top]!].indexOf("┌"), cols: [...frame[top]!].indexOf("┐") - [...frame[top]!].indexOf("┌") + 1, rows: bottom - top + 1 }
  chat.emit({ type: "item.completed", itemId, status: "ok", text: "saved generated/a-fox-1.png (PNG, 1 KB)", attachments: [{ sha256, bytes: bytes.length, mime: "image/png", name: "a-fox-1.png" }] })
  chat.emit({ type: "turn.completed", turnId })
  for (let tick = 0; tick < 20; tick++) {
    await Bun.sleep(5)
    h.app.render()
  }
  const placed = h.placements.at(-1)!.find((placement) => placement.slot.startsWith("transcript:"))!
  return { canvas, picture: { col: placed.col, cols: placed.cols, rows: placed.rows }, frame }
}

describe("the finished picture", () => {
  test("takes the cells its wait canvas held, for each shape and screen", async () => {
    for (const [width, height] of [[80, 30], [120, 40]] as const) {
      for (const [requested, pixels] of [["1024x1024", [1024, 1024]], ["1024x1536", [1024, 1536]], ["1536x1024", [1536, 1024]]] as const) {
        const { canvas, picture, frame } = await canvasThenPicture({ requested, pixels: [...pixels], width, height })
        expect(canvas).toEqual(picture)
        // The canvas and its header fit above the composer.
        expect(canvas.rows + 1).toBeLessThanOrEqual(imageRoomRows(height) + 1)
        expect(frame.every((row) => textWidth(row) <= width)).toBe(true)
      }
    }
  })

  test("a narrow transcript beside the sessions sidebar shrinks both the same way", async () => {
    const { canvas, picture } = await canvasThenPicture({ requested: "1536x1024", pixels: [1536, 1024], width: 100, height: 30, profile: { sidebar: "auto" } })
    expect(canvas).toEqual(picture)
    expect(canvas.cols).toBeLessThan(72)
  })

  test("imageWaitCanvas bounds both: a 16-row cap draws the canvas and the picture at 16 rows", async () => {
    const { canvas, picture } = await canvasThenPicture({ requested: "1024x1024", pixels: [1024, 1024], width: 120, height: 40, profile: { imageWaitCanvas: { ...DEFAULT_IMAGE_WAIT_CANVAS, maxHeight: 16 } } })
    expect(canvas).toEqual({ col: picture.col, cols: 32, rows: 16 })
    expect(picture).toEqual({ col: canvas.col, cols: 32, rows: 16 })
  })
})

describe("the app", () => {
  test("no timer of its own: the busy pulse is the only one, and none is left when the turn ends", () => {
    const live = new Set<unknown>()
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    globalThis.setInterval = ((handler: () => void, ms?: number) => {
      const handle = realSet(handler, ms)
      live.add(handle)
      return handle
    }) as typeof setInterval
    globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
      live.delete(handle)
      realClear(handle)
    }) as typeof clearInterval
    try {
      let clock = NOW
      const h = appHarness({ width: 100, height: 34, mode: "balanced", dataDir: tempDir(), directory: "/work/project", now: () => clock })
      h.app.applySettings({ onboarded: true })
      const before = live.size
      const chat = conversation(h.sessionId, h.app.onEvent), turnId = harnessIds("turn"), itemId = harnessIds("item")
      chat.emit({ type: "turn.started", turnId, queueId: harnessIds("queue") })
      chat.emit({ type: "foreground.state", sessionId: h.sessionId, state: "tool" })
      chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "image_gen: a fox" } })
      for (let tick = 0; tick < 20; tick++) {
        clock += 125
        h.app.render()
      }
      expect(h.text().join("\n")).toContain("Generating image")
      expect(live.size - before).toBeLessThanOrEqual(1)
      chat.emit({ type: "item.completed", itemId, status: "ok", text: "saved generated/a-fox-1.png (PNG, 1 KB)" })
      chat.emit({ type: "turn.completed", turnId })
      chat.emit({ type: "foreground.state", sessionId: h.sessionId, state: "idle" })
      h.app.render()
      expect(h.text().join("\n")).not.toContain("Generating image")
      expect(live.size).toBeLessThanOrEqual(before)
      for (const handle of live) realClear(handle as Parameters<typeof clearInterval>[0])
    } finally {
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
    }
  })
})
