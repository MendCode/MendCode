import { mix, type Theme } from "../themes"
import { activeTheme, type Line, type Span } from "../ui/theme"

/**
 * The built-in Mend (MendAscii) as filled half blocks (two pixels a cell), the way Claude Code draws its crab: the little robot
 * MendGirl holds, a round head with an antenna, happy eyes, pink cheeks, ear discs and a body with a cross, in the active
 * theme's primary color (`mendPalette`: black and white under the default Ink, mint and teal under Mend), in
 * 13 x 14 pixels, 7 rows of 13 cells. Its eyes follow the session's phase (`mascotPhase`) and move while it works; a 16-color palette or ASCII glyphs
 * keep the v1 text mascot (`mascot.ts`).
 */
const BODY = [
  ".........MM..",
  ".........D...",
  "...OOOOOOO...",
  "..OHMMMMMMO..",
  ".OHMMMMMMMMO.",
  "DOM.......MOD",
  "DOM.......MOD",
  ".OMPMMMMMPMO.",
  "..OSMMMMMSO..",
  "...OOOOOOO...",
  "..DOBBCBBOD..",
  "..AOBCCCBOA..",
  "...OBBCBBO...",
  "...OOOOOOO...",
] as const

/** A body and where its eyes go: two rows from `row`, seven columns from `col`. */
type Sprite = { body: readonly string[]; row: number; col: number }
const FULL: Sprite = { body: BODY, row: 5, col: 3 }

/** The two eye rows of the face, seven columns: `E` an eye, `.` the face. */
type Eyes = readonly [string, string]
const EYES = {
  open: [".E...E.", ".E...E."],
  up: [".E...E.", "......."],
  upLeft: ["E...E..", "......."],
  upRight: ["..E...E", "......."],
  right: ["..E...E", "..E...E"],
  left: ["E...E..", "E...E.."],
  blink: [".......", ".E...E."],
  blinkRight: [".......", "..E...E"],
  blinkLeft: [".......", "E...E.."],
  closed: [".......", "EEE.EEE"],
  happy: [".E...E.", "E.E.E.E"],
  wide: ["EE..EE.", "EE..EE."],
} as const satisfies Record<string, Eyes>
type EyeShape = keyof typeof EYES

/** Where the eyes look, in columns from the middle: the cheeks under them move the same way, so the face turns as one. */
const GAZE: Partial<Record<EyeShape, number>> = { upLeft: -1, upRight: 1, right: 1, left: -1, blinkRight: 1, blinkLeft: -1 }

/**
 * At rest the robot smiles with its eyes, as it does in MendGirl's arms. At work it moves, one step a beat (`mendBeat`): it
 * glances around while it thinks, scans a page while it reads, works on to the right with a blink now and then, and its
 * antenna blinks while it works or waits on the person. Every cycle divides `BEATS`, and every step keeps the same size.
 */
/** A glance holds a second: the chat's smaller Mend has no room to move its cheeks, so they leave while it looks aside. */
const THINKING: readonly EyeShape[] = ["up", "up", "upLeft", "upLeft", "up", "up", "upRight", "upRight"]
const PHASE_EYES: Record<string, readonly EyeShape[]> = {
  idle: ["happy"], done: ["happy"], hover: ["wide"], error: ["closed"], blocked: ["closed"],
  sending: ["open", "open", "open", "blink"], retrying: ["wide", "wide", "open", "open"],
  thinking: THINKING, planning: THINKING, memory: THINKING, compacting: THINKING,
  editing: ["right", "right", "right", "right", "right", "right", "right", "blinkRight"], patching: ["right", "right", "right", "right", "right", "right", "right", "blinkRight"],
  running: ["right", "right", "right", "right", "right", "right", "right", "blinkRight"], testing: ["right", "right", "right", "right", "right", "right", "right", "blinkRight"],
  installing: ["right", "right", "right", "right", "right", "right", "right", "blinkRight"], subagents: ["right", "right", "right", "right", "right", "right", "right", "blinkRight"],
  reading: ["left", "left", "open", "open", "left", "left", "open", "blinkLeft"], searching: ["left", "left", "open", "open", "left", "left", "open", "blinkLeft"],
  browsing: ["left", "left", "open", "open", "left", "left", "open", "blinkLeft"],
}
/** The longest cycle: a beat past it shows what that beat modulo `BEATS` shows, so a phase has at most `BEATS` frames. */
export const BEATS = 8
/** The phases whose antenna blinks: the session is at work, or waits on the person. */
const SIGNALLING = new Set(Object.keys(PHASE_EYES).filter((phase) => !["idle", "done", "hover", "error"].includes(phase)))

/** The beat a frame shows for `spinFrame` (`ticks.ts`, every 125 ms): one step every half second, none with reduced motion. */
export const mendBeat = (spinFrame: number, motion: boolean) => (motion ? Math.floor(spinFrame / 4) % BEATS : 0)

type Rgb = readonly [number, number, number]
type Key = "O" | "M" | "H" | "S" | "D" | "A" | "B" | "C" | "P" | "E" | "V"
const COLORS: Record<Key, Rgb> = {
  O: [29, 63, 57], M: [212, 249, 217], H: [254, 253, 240], S: [160, 214, 186], D: [32, 98, 84], A: [190, 240, 212],
  B: [56, 143, 114], C: [213, 249, 219], P: [240, 168, 172], E: [11, 52, 47], V: [212, 249, 217],
}
/** An error turns the body red; the head and the eyes stay. */
const ERROR_COLORS: Partial<Record<Key, Rgb>> = { B: [239, 68, 68], D: [153, 27, 27], C: [254, 202, 202] }

/**
 * Every theme but Mend draws the robot from its own primary color: each part keeps a fixed lightness (0-255) and takes the
 * primary's hue, its saturation held to `TONE_SATURATION` so a vivid theme stays soft. A grey primary (Ink's white, Mono's)
 * gives the website's black and white exactly: a white head, a mid-grey outline, a graphite body with a light cross and dark
 * eyes. The pink cheeks stay as the one warm touch; on an error the body takes the theme's own error red.
 */
const TONE_LIGHTNESS: Record<Exclude<Key, "P">, number> = { H: 250, M: 229, V: 229, C: 229, A: 212, S: 184, O: 115, D: 82, B: 64, E: 23 }
const TONE_SATURATION = 0.75
const CHEEKS: Rgb = COLORS.P

const channel = (hexColor: string, at: number) => Number.parseInt(hexColor.slice(at, at + 2), 16)
const rgb = (hexColor: string): Rgb => [channel(hexColor, 1), channel(hexColor, 3), channel(hexColor, 5)]
const themeErrorColors = (theme: Theme): Partial<Record<Key, Rgb>> => ({ B: rgb(theme.colors.error), D: rgb(mix(theme.colors.error, "#000000", 0.45)), C: rgb(mix(theme.colors.error, "#ffffff", 0.65)) })

/** A color's hue (0-1) and saturation (0-1), as HSL measures them. */
function hueSaturation([r, g, b]: Rgb): { hue: number; saturation: number } {
  const [red, green, blue] = [r / 255, g / 255, b / 255]
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const chroma = max - min
  if (!chroma) return { hue: 0, saturation: 0 }
  const lightness = (max + min) / 2
  const saturation = chroma / (1 - Math.abs(2 * lightness - 1))
  const sector = max === red ? ((green - blue) / chroma + 6) % 6 : max === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4
  return { hue: sector / 6, saturation }
}

/** The HSL color `hue`, `saturation` at `lightness` (0-255) as RGB. */
function tone(hue: number, saturation: number, lightness: number): Rgb {
  const level = lightness / 255
  const chroma = (1 - Math.abs(2 * level - 1)) * saturation
  const spread = (offset: number) => {
    const at = (offset + hue * 12) % 12
    return Math.round((level - (chroma / 2) * Math.max(-1, Math.min(at - 3, 9 - at, 1))) * 255)
  }
  return [spread(0), spread(8), spread(4)]
}

/** The robot in `theme`'s primary color. */
function themeColors(theme: Theme): Record<Key, Rgb> {
  const { hue, saturation } = hueSaturation(rgb(theme.colors.primary))
  const tones = Object.fromEntries(Object.entries(TONE_LIGHTNESS).map(([key, lightness]) => [key, tone(hue, Math.min(saturation, TONE_SATURATION), lightness)]))
  return { ...tones, P: CHEEKS } as Record<Key, Rgb>
}

/** The theme that keeps the robot as it was first drawn, mint and teal: the green Mend theme. */
const ORIGINAL_THEME = "mend"

type MendPalette = { key: string; colors: Record<Key, Rgb>; error: Record<Key, Rgb> }
const ORIGINAL_PALETTE: MendPalette = { key: "mend", colors: COLORS, error: { ...COLORS, ...ERROR_COLORS } }
let themed: { theme: Theme; palette: MendPalette } | undefined

/** Mend's colors under the active theme, with the key every frame cache adds so a theme switch draws it again. */
export function mendPalette(theme = activeTheme()): MendPalette {
  if (theme.name === ORIGINAL_THEME) return ORIGINAL_PALETTE
  if (themed?.theme !== theme) {
    const colors = themeColors(theme)
    themed = { theme, palette: { key: `${theme.name}${theme.colors.primary}${theme.colors.error}`, colors, error: { ...colors, ...themeErrorColors(theme) } } }
  }
  return themed.palette
}

export const MEND_SPRITE_SIZE = { cols: BODY[0].length, rows: BODY.length / 2 } as const

const hex = (rgb: Rgb) => `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`

/** Each pixel's color for `phase` at `beat` (undefined where the background shows), row by row. */
function pixels(sprite: Sprite, phase: string, beat: number, colors: MendPalette): Array<Array<string | undefined>> {
  const cycle = PHASE_EYES[phase] ?? ["open"]
  const shape = cycle[beat % cycle.length]!
  const eyes = EYES[shape]
  const gaze = GAZE[shape] ?? 0
  const signal = SIGNALLING.has(phase) && beat % 2 === 1
  const palette = phase === "error" ? colors.error : colors.colors
  return sprite.body.map((row, y) => {
    const eyeRow = y === sprite.row || y === sprite.row + 1 ? eyes[y - sprite.row] : undefined
    const cheeks = row.includes("P") ? movedCheeks(row, gaze) : row
    return [...cheeks].map((cell, x) => {
      const key = (eyeRow && x >= sprite.col && x < sprite.col + 7 ? (eyeRow[x - sprite.col] === "E" ? "E" : "V") : y === 0 && cell === "M" && signal ? "P" : cell) as keyof typeof COLORS | "."
      return key === "." ? undefined : hex(palette[key])
    })
  })
}

/** The cheek row with both cheeks moved `gaze` columns; where the face has no room for both, it shows none rather than one. */
function movedCheeks(row: string, gaze: number): string {
  if (!gaze) return row
  const cheeks = [...row].flatMap((cell, x) => (cell === "P" ? [x] : []))
  const face = row.replaceAll("P", "M")
  if (!cheeks.every((x) => face[x + gaze] === "M")) return face
  return [...face].map((cell, x) => (cheeks.includes(x - gaze) ? "P" : cell)).join("")
}

/** Mend for `phase` as one pixel per pixel of RGBA: the frame the image layer draws, sized by the rule every pet follows (`pets/mend-pet.ts`). */
export function mendImage(phase = "idle", beat = 0, palette = mendPalette()): { width: number; height: number; rgba: Uint8Array } {
  const grid = pixels(FULL, phase, beat, palette)
  const width = BODY[0].length
  const rgba = new Uint8Array(width * BODY.length * 4)
  grid.forEach((row, y) => row.forEach((color, x) => {
    if (color) rgba.set([...[1, 3, 5].map((at) => Number.parseInt(color.slice(at, at + 2), 16)), 255], (y * width + x) * 4)
  }))
  return { width, height: BODY.length, rgba }
}

const drawn = new Map<string, Line[]>()

/** Mend for `phase` as half-block lines, `scale` whole pixels per pixel (the start screen and /pet). */
export function mendSpriteLines(phase = "idle", scale = 1, beat = 0): Line[] {
  return halfBlocks(FULL, phase, scale, beat)
}

/**
 * Mend beside the prompt, for `phase` at `beat`: the start screen's robot at one pixel a pixel, 7 rows of 13 cells. A smaller
 * one lost its antenna's stalk and its cross; half blocks cannot draw a pixel smaller than this.
 */
export function mendChatLines(phase = "idle", beat = 0): Line[] {
  return halfBlocks(FULL, phase, 1, beat)
}

function halfBlocks(sprite: Sprite, phase: string, scale: number, beat: number): Line[] {
  const palette = mendPalette()
  const key = `${palette.key}/${phase}/${scale}/${beat % BEATS}`
  const kept = drawn.get(key)
  if (kept) return kept
  const grid = pixels(sprite, phase, beat, palette).flatMap((row) => Array.from({ length: scale }, () => row.flatMap((color) => Array.from({ length: scale }, () => color))))
  const lines: Line[] = []
  for (let y = 0; y < grid.length; y += 2) {
    const line: Span[] = []
    grid[y]!.forEach((top, x) => {
      const bottom = grid[y + 1]![x]
      const cell: Span = top && bottom ? { text: "▀", fgHex: top, bgHex: bottom } : top ? { text: "▀", fgHex: top } : bottom ? { text: "▄", fgHex: bottom } : { text: " " }
      const last = line.at(-1)
      if (last && last.fgHex === cell.fgHex && last.bgHex === cell.bgHex && (last.text.at(-1) === cell.text || !cell.fgHex)) last.text += cell.text
      else line.push(cell)
    })
    lines.push(line)
  }
  drawn.set(key, lines)
  return lines
}
