import { DEFAULT_CELL_PIXELS, type CellPixels } from "../pets/frames"
import { fitImage, keptSize } from "../ui/image-fit"
import type { ColorName, Line, Span } from "../ui/theme"
import { cells, textWidth, truncateEnd } from "./wrap"

/**
 * The canvas an image tool draws while it runs (v1's image generation wait): a bordered ASCII field that loops one of the
 * built-in presets or the user's own frames, with the model and size under it. It takes the box the finished picture will take
 * in the transcript (the requested size's shape, `generatedImageBox`), so the picture lands where the canvas was. Pure: the config,
 * the time and the room in, rows out. The frame follows the call's elapsed time, so it moves with the app's busy pulse and needs
 * no timer of its own; a `static` config (also what reduced motion and screen-reader mode resolve to) always draws the first frame.
 */

export const IMAGE_WAIT_MODES = ["animated", "static"] as const
export type ImageWaitMode = (typeof IMAGE_WAIT_MODES)[number]
export const IMAGE_WAIT_PRESETS = ["drops", "cycle", "constellation", "orbit", "pulse", "scanner"] as const
export type ImageWaitPreset = (typeof IMAGE_WAIT_PRESETS)[number]
export const IMAGE_WAIT_COLORS = ["mixed", "accent", "muted"] as const
export type ImageWaitColor = (typeof IMAGE_WAIT_COLORS)[number]
export const IMAGE_WAIT_FITS = ["contain", "crop"] as const
export const IMAGE_WAIT_ALIGNS = ["left", "center", "right"] as const

export type ImageWaitCanvas = { minWidth: number; maxWidth: number; minHeight: number; maxHeight: number; heightRatio: number; paddingX: number; paddingY: number }
/** A user preset: its frames (one frame is a still picture), how a frame larger than the field is fitted, and where a smaller one sits. */
export type ImageWaitArt = { name: string; frames: string[][]; fit: (typeof IMAGE_WAIT_FITS)[number]; align: (typeof IMAGE_WAIT_ALIGNS)[number] }
/** What the terminal gives a generated picture: the rows it may take (from the screen's height) and the pixels of one cell. */
export type ImageRoom = { rows: number; cell: CellPixels }
export type ImageWaitConfig = { mode: ImageWaitMode; preset: string; intervalMs: number; color: ImageWaitColor; meta: boolean; canvas: ImageWaitCanvas; room: ImageRoom; art?: ImageWaitArt }

/** The bounds of what a profile may hold: a user preset's frames are kept in memory for as long as the profile is. */
export const IMAGE_WAIT_LIMITS = { presets: 16, frames: 64, lines: 48, columns: 160, name: 32, intervalMin: 80, intervalMax: 5000 } as const

/**
 * The box of a generated picture, waiting or finished: at most `maxWidth` × `maxHeight` cells. 24 rows is v1's tallest canvas, and
 * 72 columns a 3:2 landscape at that height, so square is 48 × 24 and portrait 32 × 24. The waiting canvas is never smaller than
 * `minWidth` × `minHeight` where the room allows; `heightRatio` is the picture's height over its width when the size is `auto` or
 * not known (1: square, the size the image tools default to).
 */
export const DEFAULT_IMAGE_WAIT_CANVAS: Readonly<ImageWaitCanvas> = { minWidth: 16, maxWidth: 72, minHeight: 8, maxHeight: 24, heightRatio: 1, paddingX: 2, paddingY: 1 }
/** The defaults from before the canvas took the picture's shape: a profile that still holds exactly these gets the ones above. */
const FIXED_CANVAS: Readonly<ImageWaitCanvas> = { minWidth: 28, maxWidth: 52, minHeight: 12, maxHeight: 16, heightRatio: 1 / 2.2, paddingX: 2, paddingY: 1 }
export const DEFAULT_IMAGE_WAIT_INTERVAL = 280

/** Rows of the screen a generated picture leaves to the rest: the card's header, the composer, the footer and a line of context. */
const SCREEN_RESERVE = 8
/** The rows a generated picture may take on a screen `screenRows` tall. */
export const imageRoomRows = (screenRows: number) => Math.max(6, Math.floor(screenRows) - SCREEN_RESERVE)
/** The room when the screen is not known (previews, tests): only the canvas's own bounds apply. */
export const DEFAULT_IMAGE_ROOM: Readonly<ImageRoom> = { rows: 120, cell: DEFAULT_CELL_PIXELS }
/** The long side of a size given as an aspect (`3:2`). */
const ASPECT_SIDE = 1024

/** A requested size as pixels: `WxH` (also `W×H`), or an aspect `W:H` at 1024 on its long side; `auto` and anything else is undefined. */
export function requestedPixels(size: string | undefined): { width: number; height: number } | undefined {
  const match = size?.trim().match(/^(\d{1,5})\s*([x×*:])\s*(\d{1,5})$/i)
  if (!match) return undefined
  const [width, height] = [Number(match[1]), Number(match[3])]
  if (width < 1 || height < 1) return undefined
  if (match[2] === ":") {
    const scale = ASPECT_SIDE / Math.max(width, height)
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
  }
  return width > 16_384 || height > 16_384 ? undefined : { width, height }
}

/** The pixels assumed for `auto` or an unknown size: 1024 wide, `heightRatio` of that high. */
const autoPixels = (canvas: ImageWaitCanvas) => ({ width: ASPECT_SIDE, height: Math.max(1, Math.round(ASPECT_SIDE * canvas.heightRatio)) })

/** The most cells a generated picture may take with `maxCols` columns free: the canvas's maxima and the room's rows. */
export function generatedImageCaps({ maxCols, room, canvas }: { maxCols: number; room: ImageRoom; canvas: ImageWaitCanvas }): { maxCols: number; maxRows: number } {
  return { maxCols: Math.max(1, Math.min(Math.floor(maxCols), canvas.maxWidth)), maxRows: Math.max(1, Math.min(Math.floor(room.rows), canvas.maxHeight)) }
}

/**
 * The cells a generated picture of `pixels` takes: kept as the transcript keeps a decoded image (`keptSize`), fitted with its shape
 * inside `generatedImageCaps` (`fitImage`, the inline images' own fit). The finished picture is placed with the same caps.
 */
export function generatedImageBox({ pixels, maxCols, room, canvas }: { pixels: { width: number; height: number }; maxCols: number; room: ImageRoom; canvas: ImageWaitCanvas }): { cols: number; rows: number } {
  const caps = generatedImageCaps({ maxCols, room, canvas })
  const box = fitImage({ source: keptSize(pixels), maxCols: caps.maxCols, maxRows: caps.maxRows, cell: room.cell })
  return { cols: box.cols, rows: box.rows }
}

/** Frames of one built-in preset; `cycle` plays each of the others for this many frames in turn. */
const PRESET_FRAMES = 16
const CYCLED: readonly Exclude<ImageWaitPreset, "cycle">[] = ["drops", "constellation", "orbit", "pulse", "scanner"]

const STARS = [
  [0.03, 0.08, 1, 1, 0], [0.24, 0.02, 2, 1, 2], [0.48, 0.16, 1, 2, 4], [0.76, 0.08, 2, 1, 1], [0.94, 0.25, 1, 2, 3], [0.12, 0.48, 2, 1, 4],
  [0.35, 0.7, 1, 2, 1], [0.68, 0.58, 2, 1, 0], [0.88, 0.78, 1, 2, 2], [0.06, 0.96, 1, 1, 3], [0.53, 0.86, 2, 1, 1], [0.82, 0.96, 1, 2, 4],
] as const
const DROPS = [
  [0.04, 0.86, 1, 0], [0.11, 0.18, 2, 3], [0.19, 0.63, 1, 5], [0.27, 0.04, 2, 1], [0.34, 0.44, 1, 4], [0.41, 0.76, 2, 2], [0.49, 0.27, 1, 6],
  [0.56, 0.92, 2, 0], [0.64, 0.12, 1, 4], [0.71, 0.57, 2, 5], [0.78, 0.32, 1, 2], [0.86, 0.72, 2, 1], [0.93, 0.08, 1, 3],
] as const
/** The path the focal mark wanders along, so it never sits pinned to the centre. */
const DRIFT_X = [0, 1, 2, 3, 2, 1, 0, -1, -2, -3, -2, -1, 0, 1, 2, 1] as const
const DRIFT_Y = [-2, -2, -1, 0, 1, 2, 2, 1, 0, -1, -2, -2, -1, 0, 1, 0] as const
const ORBIT = [[0, -3], [2, -2], [3, 0], [2, 2], [0, 3], [-2, 2], [-3, 0], [-2, -2]] as const

const wrapIndex = (value: number, size: number) => ((value % size) + size) % size
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

type Grid = string[][]
const blank = (width: number, height: number): Grid => Array.from({ length: height }, () => Array<string>(width).fill(" "))
function put(grid: Grid, x: number, y: number, glyph: string) {
  if (y >= 0 && y < grid.length && x >= 0 && x < grid[0]!.length) grid[y]![x] = glyph
}

function drops(frame: number, width: number, height: number): Grid {
  const grid = blank(width, height)
  for (const [x, y, speed, phase] of DROPS) {
    const column = Math.floor(x * width)
    const row = wrapIndex(Math.floor(y * height) + frame * speed, height)
    put(grid, column, row, (frame + phase) % 7 === 0 ? "*" : ".")
    if ((frame + phase) % 3 !== 0) put(grid, column, row - 1, ".")
  }
  return grid
}

function starfield(frame: number, width: number, height: number): Grid {
  const grid = blank(width, height)
  for (const [x, y, dx, dy, phase] of STARS) put(grid, wrapIndex(Math.floor(x * width) + frame * dx, width), wrapIndex(Math.floor(y * height) + frame * dy, height), (frame + phase) % 5 === 0 ? "*" : ".")
  return grid
}

function presetFrame(preset: Exclude<ImageWaitPreset, "cycle">, frame: number, width: number, height: number): Grid {
  if (preset === "drops") return drops(frame, width, height)
  const grid = starfield(frame, width, height)
  const step = frame % DRIFT_X.length
  const x = clamp(Math.floor(width / 2) + DRIFT_X[step]! * Math.max(1, Math.round(width / 24)), 1, width - 2)
  const y = clamp(Math.floor(height / 2) + DRIFT_Y[step]! * Math.max(1, Math.round(height / 12)), 1, height - 2)
  if (preset === "constellation") {
    put(grid, x, y, frame % 2 === 0 ? "*" : "o")
    put(grid, x - 2, y - 1, ".")
    put(grid, x + 2, y + 1, ".")
    put(grid, x + DRIFT_X[step]!, y + DRIFT_Y[step]!, "+")
  } else if (preset === "orbit") {
    put(grid, x, y, frame % 3 === 0 ? "@" : "O")
    const [ox, oy] = ORBIT[frame % ORBIT.length]!
    put(grid, x + ox, y + oy, "o")
  } else if (preset === "pulse") {
    const beat = frame % 6
    put(grid, x, y, beat % 2 === 0 ? "+" : "*")
    const radius = 1 + beat
    for (const [px, py] of [[x - radius, y], [x + radius, y], [x, y - Math.floor(radius / 2)], [x, y + Math.floor(radius / 2)]] as const) put(grid, px, py, beat % 2 === 0 ? "." : "o")
  } else {
    const scan = wrapIndex(frame * Math.max(1, Math.floor(width / 12)), width)
    for (let row = 0; row < height; row += 2) put(grid, scan, row, row === y ? "#" : "|")
    put(grid, x - 1, y, "<")
    put(grid, x + 1, y, ">")
  }
  return grid
}

/** A user frame placed in the field: centred vertically, aligned across, the middle kept when it is larger (`crop` also crops rows from the middle). */
function placeArt(lines: readonly string[], width: number, height: number, art: ImageWaitArt): Grid {
  const grid = blank(width, height)
  const skip = art.fit === "crop" && lines.length > height ? Math.floor((lines.length - height) / 2) : 0
  const shown = lines.slice(skip, skip + height)
  const top = Math.floor((height - shown.length) / 2)
  shown.forEach((source, index) => {
    const chars = [...source]
    const cut = chars.length > width ? chars.slice(Math.floor((chars.length - width) / 2), Math.floor((chars.length - width) / 2) + width) : chars
    const left = art.align === "left" ? 0 : art.align === "right" ? width - cut.length : Math.floor((width - cut.length) / 2)
    cut.forEach((glyph, column) => put(grid, left + column, top + index, glyph))
  })
  return grid
}

/** How many distinct frames the config loops through: 1 when static. */
export function imageWaitFrameCount(config: ImageWaitConfig): number {
  if (config.mode === "static") return 1
  if (config.art) return config.art.frames.length
  return config.preset === "cycle" ? PRESET_FRAMES * CYCLED.length : PRESET_FRAMES
}

/** The field's rows at `frame` (taken modulo the frame count), each exactly `width` cells. */
export function imageWaitFrame(config: ImageWaitConfig, frame: number, width: number, height: number): string[] {
  const at = wrapIndex(Math.floor(frame), imageWaitFrameCount(config))
  if (config.art) return placeArt(config.art.frames[at]!, width, height, config.art).map((row) => row.join(""))
  const preset = config.preset === "cycle" ? CYCLED[Math.floor(at / PRESET_FRAMES) % CYCLED.length]! : (IMAGE_WAIT_PRESETS as readonly string[]).includes(config.preset) ? (config.preset as Exclude<ImageWaitPreset, "cycle">) : "drops"
  return presetFrame(preset, at % PRESET_FRAMES, width, height).map((row) => row.join(""))
}

/** The frame showing `elapsedMs` into the call: static configs stay on the first. */
export const imageWaitFrameAt = (config: ImageWaitConfig, elapsedMs: number) => (config.mode === "static" ? 0 : Math.floor(Math.max(0, elapsedMs) / config.intervalMs))

/**
 * The canvas's outer cells with `maxCols` columns free: the box the finished picture of the requested `size` takes, grown to
 * `minWidth` × `minHeight` only as far as the columns and the room's rows allow (a very long or tall shape stays legible).
 */
export function imageWaitSize({ size, maxCols, room, canvas }: { size?: string | undefined; maxCols: number; room: ImageRoom; canvas: ImageWaitCanvas }): { width: number; height: number } {
  const box = generatedImageBox({ pixels: requestedPixels(size) ?? autoPixels(canvas), maxCols, room, canvas })
  return { width: Math.min(Math.max(1, Math.floor(maxCols)), Math.max(box.cols, canvas.minWidth)), height: Math.min(Math.max(1, Math.floor(room.rows)), Math.max(box.rows, canvas.minHeight)) }
}

/**
 * What the canvas says under the field: the model and the requested size, from the `model …` and `size …` lines an image tool
 * prints first, or a `size` the call reported in its meta.
 */
export function imageWaitDetails(text: string, meta?: Readonly<Record<string, unknown>>): { model?: string; size?: string } {
  const lines = text.split("\n").slice(0, 8)
  const model = lines.find((line) => line.startsWith("model "))?.slice(6).trim()
  const size = lines.find((line) => line.startsWith("size "))?.slice(5).trim() ?? (typeof meta?.size === "string" ? meta.size.trim() : undefined)
  return { ...(model ? { model } : {}), ...(size ? { size } : {}) }
}

const FOCAL = new Set(["*", "+", "@", "#", "o", "O", "<", ">", "|"])

/** One field row as spans: in `mixed`, the moving marks take the accent and the trail stays muted. */
function fieldSpans(row: string, color: ImageWaitColor): Span[] {
  if (color !== "mixed") return [{ text: row, fg: color === "accent" ? "primary" : "muted" }]
  const spans: Span[] = []
  for (const glyph of row) {
    const fg: ColorName = FOCAL.has(glyph) ? "primary" : "muted"
    const last = spans.at(-1)
    if (last && (last.fg === fg || glyph === " ")) last.text += glyph
    else spans.push({ text: glyph, fg })
  }
  return spans
}

/** Rows the field keeps before the padding, then the model row, then the size row give way. */
const MIN_FIELD_ROWS = 3

/**
 * The canvas rows under a running image card's header, each led by `prefix` (where the finished picture's column starts). `maxCols`
 * is the columns free after it; `details` the model and size when known (the hosted tool reports neither while it runs, so its
 * canvas is `auto`'s shape until a size arrives). Exactly `imageWaitSize` rows, each `prefix` plus its width; none without room for a box.
 */
export function imageWaitRows({ config, prefix, maxCols, elapsedMs, details, ascii }: { config: ImageWaitConfig; prefix: Span[]; maxCols: number; elapsedMs: number; details: { model?: string; size?: string }; ascii: boolean }): Line[] {
  const { width, height } = imageWaitSize({ size: details.size, maxCols, room: config.room, canvas: config.canvas })
  if (width < 4 || height < 3) return []
  const inner = width - 2
  const padX = Math.min(config.canvas.paddingX, Math.max(0, Math.floor((inner - 8) / 2)))
  const fieldWidth = Math.max(1, inner - padX * 2)
  let padY = config.canvas.paddingY
  let metaRows = config.meta ? 2 : 0
  while (height - 2 - padY * 2 - metaRows < MIN_FIELD_ROWS && (padY > 0 || metaRows > 0)) {
    if (padY > 0) padY--
    else metaRows--
  }
  const fieldHeight = height - 2 - padY * 2 - metaRows
  const box = ascii ? { h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+" } : { h: "─", v: "│", tl: "┌", tr: "┐", bl: "└", br: "┘" }
  const edge = (spans: Span[]): Line => [...prefix, { text: box.v, fg: "border" }, ...spans, { text: box.v, fg: "border" }]
  const centred = (text: string): Line => {
    const shown = truncateEnd(text, fieldWidth)
    const left = Math.floor((inner - textWidth(shown)) / 2)
    return edge([{ text: " ".repeat(left) }, { text: shown, fg: "muted" }, { text: " ".repeat(inner - left - textWidth(shown)) }])
  }
  const empty = edge([{ text: " ".repeat(inner) }])
  const field = imageWaitFrame(config, imageWaitFrameAt(config, elapsedMs), fieldWidth, fieldHeight)
  const meta = [centred(details.model ?? "default image model"), centred(`size ${details.size ?? "auto"}`)]
  return [
    [...prefix, { text: `${box.tl}${box.h.repeat(inner)}${box.tr}`, fg: "border" }],
    ...Array.from({ length: padY }, () => empty),
    ...field.map((row) => edge([{ text: " ".repeat(padX) }, ...fieldSpans(row, config.color), { text: " ".repeat(inner - padX - fieldWidth) }])),
    ...meta.slice(meta.length - metaRows),
    ...Array.from({ length: padY }, () => empty),
    [...prefix, { text: `${box.bl}${box.h.repeat(inner)}${box.br}`, fg: "border" }],
  ]
}

const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((item) => item === value)
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const whole = (value: unknown, min: number, max: number, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? clamp(Math.round(value), min, max) : fallback)

const isFixedCanvas = (source: Record<string, unknown>) =>
  Object.keys(source).length === Object.keys(FIXED_CANVAS).length && (Object.keys(FIXED_CANVAS) as Array<keyof ImageWaitCanvas>).every((key) => typeof source[key] === "number" && Math.abs((source[key] as number) - FIXED_CANVAS[key]) < 1e-9)

/**
 * `imageWaitCanvas` as stored: each bound kept when it is a number, clamped so the ranges stay ordered. A profile saved with the
 * old fixed-box defaults (and nothing changed) gets today's defaults.
 */
export function normalizeImageWaitCanvas(raw: unknown): ImageWaitCanvas {
  const source = isRecord(raw) && !isFixedCanvas(raw) ? raw : {}
  const base = DEFAULT_IMAGE_WAIT_CANVAS
  const minWidth = whole(source.minWidth, 12, 240, base.minWidth)
  const minHeight = whole(source.minHeight, 6, 120, base.minHeight)
  return {
    minWidth,
    maxWidth: whole(source.maxWidth, minWidth, 240, Math.max(minWidth, base.maxWidth)),
    minHeight,
    maxHeight: whole(source.maxHeight, minHeight, 120, Math.max(minHeight, base.maxHeight)),
    heightRatio: typeof source.heightRatio === "number" && Number.isFinite(source.heightRatio) ? clamp(source.heightRatio, 0.25, 4) : base.heightRatio,
    paddingX: whole(source.paddingX, 0, 12, base.paddingX),
    paddingY: whole(source.paddingY, 0, 8, base.paddingY),
  }
}

/** One line of user art: escapes and controls dropped, tabs as a space, only single-cell glyphs, bounded. */
function artLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\t/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "")
  let out = ""
  let count = 0
  for (const cell of cells(plain)) {
    if (count >= IMAGE_WAIT_LIMITS.columns) break
    out += cell.width === 1 ? cell.text : "?"
    count++
  }
  return out.trimEnd()
}

/** A frame given as one string (lines split on `\n`) or a list of lines. */
function artFrame(value: unknown): string[] | undefined {
  const lines = typeof value === "string" ? value.split("\n") : Array.isArray(value) && value.every((line) => typeof line === "string") ? (value as string[]).flatMap((line) => line.split("\n")) : undefined
  if (!lines) return undefined
  const frame = lines.slice(0, IMAGE_WAIT_LIMITS.lines).map(artLine)
  return frame.some((line) => line.trim()) ? frame : undefined
}

/**
 * `imageWaitArt` as stored: user presets `{ name, frames: [frame, …] | static: frame, fit?, align? }`, a frame being a string or a
 * list of lines. A preset without a usable name or frame is dropped; a name that is a built-in preset or already taken is dropped too.
 */
export function normalizeImageWaitArt(raw: unknown): ImageWaitArt[] {
  if (!Array.isArray(raw)) return []
  const out: ImageWaitArt[] = []
  for (const entry of raw.slice(0, IMAGE_WAIT_LIMITS.presets * 2)) {
    if (!isRecord(entry) || out.length >= IMAGE_WAIT_LIMITS.presets) continue
    const name = typeof entry.name === "string" ? entry.name.trim().slice(0, IMAGE_WAIT_LIMITS.name) : ""
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name) || (IMAGE_WAIT_PRESETS as readonly string[]).includes(name) || out.some((art) => art.name === name)) continue
    const frames = Array.isArray(entry.frames) ? entry.frames.slice(0, IMAGE_WAIT_LIMITS.frames).map(artFrame).filter((frame): frame is string[] => frame !== undefined) : []
    const still = frames.length ? undefined : artFrame(entry.static)
    if (!frames.length && !still) continue
    out.push({ name, frames: frames.length ? frames : [still!], fit: oneOf(IMAGE_WAIT_FITS, entry.fit) ?? "contain", align: oneOf(IMAGE_WAIT_ALIGNS, entry.align) ?? "center" })
  }
  return out
}

/** The preset names a profile can pick: the built-ins, then the user's. */
export const imageWaitPresetNames = (art: readonly ImageWaitArt[]): string[] => [...IMAGE_WAIT_PRESETS, ...art.map((entry) => entry.name)]

export type ImageWaitProfile = { imageWait: ImageWaitMode; imageWaitPreset: string; imageWaitSpeed: number; imageWaitColor: ImageWaitColor; imageWaitMeta: boolean; imageWaitCanvas: ImageWaitCanvas; imageWaitArt: ImageWaitArt[] }

/**
 * The canvas's config from the profile; `motion: false` (reduced motion, screen-reader mode) holds it on its first frame. `room`
 * is what the terminal gives a picture (the app's screen and cell size); without it only the canvas's bounds apply.
 */
export function imageWaitConfig(profile: Partial<ImageWaitProfile>, motion = true, room: ImageRoom = DEFAULT_IMAGE_ROOM): ImageWaitConfig {
  const art = profile.imageWaitArt?.find((entry) => entry.name === profile.imageWaitPreset)
  return {
    mode: motion ? (profile.imageWait ?? "animated") : "static",
    preset: art ? art.name : profile.imageWaitPreset && (IMAGE_WAIT_PRESETS as readonly string[]).includes(profile.imageWaitPreset) ? profile.imageWaitPreset : "drops",
    intervalMs: whole(profile.imageWaitSpeed, IMAGE_WAIT_LIMITS.intervalMin, IMAGE_WAIT_LIMITS.intervalMax, DEFAULT_IMAGE_WAIT_INTERVAL),
    color: profile.imageWaitColor ?? "mixed",
    meta: profile.imageWaitMeta ?? true,
    canvas: profile.imageWaitCanvas ?? { ...DEFAULT_IMAGE_WAIT_CANVAS },
    room,
    ...(art ? { art } : {}),
  }
}

/** The tools that generate images: the native engine's hosted one and the `image_gen` tool. */
export const IMAGE_TOOLS: ReadonlySet<string> = new Set(["image_generation", "image_gen"])
