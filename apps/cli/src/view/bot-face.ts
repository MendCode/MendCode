import type { BotState } from "@mendcode/protocol"
import type { BotColor, BotShape } from "../../../../packages/packages/src/agents"
import type { PetImage } from "../pets/decode"
import { detectImageTier, type ImageMode } from "../pets/detect"
import { DEFAULT_CELL_PIXELS, type CellPixels } from "../pets/frames"
import type { ImagePlacement } from "../ui/image-layer"
import { activeTheme, type ColorName, type Line, type Span, type Theme } from "../ui/theme"
import { faceFrameCount, FACE_STATES, type FaceState } from "./bot-face-anim"
import { rasterFace, type EyeStyle, type MouthStyle } from "./bot-face-image"
import { faceLook } from "./bot-look"

export { faceFrameCount, FACE_STATES, type FaceState }

/**
 * Experimental bots: the face of a bot. A face is made from the bot's name (the same name always gives the same shape, color role,
 * eyes and mouth) and shows its state. Order of fallbacks: a real image (the bot's own `avatar`, else a generated picture) when the
 * terminal draws images, else a Unicode text face, else an ASCII one. Only theme color roles are used, so it reads on light and dark.
 */
export type FaceSize = "card" | "icon"
export type FaceInput = FaceState | "idle"
export type FaceCapability = {
  /** Plain ASCII glyphs only (the `glyphs: ascii` setting); it wins over images. */
  ascii?: boolean
  /** The terminal draws images (see `faceCapability`). */
  images?: boolean
  /** The bot's own picture, already loaded and validated by `loadBotAvatar`. */
  avatar?: PetImage
  cellPixels?: CellPixels
  /** The palette the generated picture takes its colors from; the active theme when absent. */
  theme?: Pick<Theme, "colors">
}
export type BotFace = {
  lines: Line[]
  cols: number
  rows: number
  /** Rows the picture covers: a label row, when there is one, stays text under it. */
  pictureRows: number
  mode: "image" | "unicode" | "ascii"
  /** The picture for the image layer; the text lines stay under it (blank for an avatar). */
  image?: { key: string; image: PetImage }
  shape: BotShape
  color: BotColor
}

export const CARD_COLS = 9
const FACE_ROWS = 4
export const ICON_COLS = 2

/** A bot's state as the face shows it: working bots listen, idle ones rest. */
export function faceStateOf(state: BotState): FaceState {
  return state === "working" ? "listening" : state === "idle" ? "sleeping" : state
}

export { faceLook }

const normal = (state: FaceInput): FaceState => (state === "idle" ? "sleeping" : state)

/** The role a face is drawn in: the bot's color, except that a problem is red and a wait is amber. */
const roleOf = (state: FaceState, color: BotColor): ColorName => (state === "problem" ? "error" : state === "waiting" ? "warning" : color)

const OUTLINE = {
  unicode: {
    circle: ["╭───────╮", "│       │", "│       │", "╰───────╯"],
    square: ["┌───────┐", "│       │", "│       │", "└───────┘"],
    hexagon: ["╱───────╲", "│       │", "│       │", "╲───────╱"],
    diamond: ["  ╱───╲  ", "╱       ╲", "╲       ╱", "  ╲───╱  "],
    triangle: ["    ▲    ", " ╱     ╲ ", "╱       ╲", "└───────┘"],
  },
  ascii: {
    circle: [".-------.", "|       |", "|       |", "'-------'"],
    square: ["+-------+", "|       |", "|       |", "+-------+"],
    hexagon: ["/-------\\", "|       |", "|       |", "\\-------/"],
    diamond: ["  /---\\  ", "/       \\", "\\       /", "  \\---/  "],
    triangle: ["    ^    ", " /     \\ ", "/       \\", "+-------+"],
  },
} as const satisfies Record<"unicode" | "ascii", Record<BotShape, readonly string[]>>

const GLYPHS = {
  unicode: {
    open: { round: "●", diamond: "◆", square: "■" },
    wide: { round: "◉", diamond: "◈", square: "█" },
    closed: "-", dead: "×",
    mouth: { smile: "‿", flat: "─", small: "·" },
    talk: ["o", "O"], think: ["·", "•"], sleep: ["z", "Z"], wait: "?", problem: "~",
  },
  ascii: {
    open: { round: "o", diamond: "*", square: "#" },
    wide: { round: "O", diamond: "@", square: "@" },
    closed: "-", dead: "x",
    mouth: { smile: "u", flat: "-", small: "." },
    talk: ["o", "O"], think: [".", "o"], sleep: ["z", "Z"], wait: "?", problem: "~",
  },
} as const

type Kind = "frame" | "eye" | "mouth" | "mark" | "alert"
type Cell = { char: string; kind: Kind }

/** The two eyes, the mouth and the moving mark (thought dot, sleep z) of a state, in glyphs. */
function expression({ state, eyes, mouth, frame, set }: { state: FaceState; eyes: EyeStyle; mouth: MouthStyle; frame: number; set: (typeof GLYPHS)["unicode"] | (typeof GLYPHS)["ascii"] }) {
  const eye = state === "sleeping" ? set.closed : state === "problem" ? set.dead : state === "listening" ? set.wide[eyes] : set.open[eyes]
  const f = frame % faceFrameCount(state)
  const mouthGlyph = state === "talking" ? set.talk[f]! : state === "waiting" ? set.wait : state === "problem" ? set.problem : set.mouth[mouth]
  const mark = state === "sleeping" ? set.sleep[f]! : state === "thinking" ? set.think[f]! : ""
  return { eye, mouth: mouthGlyph, mark }
}

function cardCells({ shape, ascii, state, eyes, mouth, frame }: { shape: BotShape; ascii: boolean; state: FaceState; eyes: EyeStyle; mouth: MouthStyle; frame: number }): Cell[][] {
  const set = GLYPHS[ascii ? "ascii" : "unicode"]
  const rows = OUTLINE[ascii ? "ascii" : "unicode"][shape].map((row) => [...row].map((char): Cell => ({ char, kind: "frame" })))
  const look = expression({ state, eyes, mouth, frame, set })
  rows[1]![3] = { char: look.eye, kind: "eye" }
  rows[1]![5] = { char: look.eye, kind: "eye" }
  rows[2]![4] = { char: look.mouth, kind: state === "waiting" || state === "problem" ? "alert" : "mouth" }
  if (look.mark) rows[shape === "triangle" ? 0 : 1]![shape === "triangle" ? 6 : 7] = { char: look.mark, kind: "mark" }
  return rows
}

function iconText({ ascii, state, eyes, frame }: { ascii: boolean; state: FaceState; eyes: EyeStyle; frame: number }): string {
  const set = GLYPHS[ascii ? "ascii" : "unicode"]
  const f = frame % faceFrameCount(state)
  switch (state) {
    case "sleeping": return f === 0 ? "--" : `-${set.sleep[0]}`
    case "listening": return set.wide[eyes] + set.wide[eyes]
    case "thinking": return set.open[eyes] + set.think[f]!
    case "talking": return set.open[eyes] + (f === 0 ? ")" : "o")
    case "waiting": return "??"
    case "problem": return set.dead + set.dead
  }
}

function spansOf({ cells, role }: { cells: readonly Cell[]; role: ColorName }): Span[] {
  const spans: Span[] = []
  let last: Kind | undefined
  for (const { char, kind } of cells) {
    const tail = spans[spans.length - 1]
    if (tail && kind === last) tail.text += char
    else spans.push(kind === "eye" ? { text: char, fg: "text", bold: true } : kind === "mouth" ? { text: char, fg: "text" } : kind === "mark" ? { text: char, fg: "muted" } : kind === "alert" ? { text: char, fg: role, bold: true } : { text: char, fg: role })
    last = kind
  }
  return spans
}

function labelLine({ label, state }: { label: string; state: FaceState }): Line {
  const text = label.length > CARD_COLS ? `${label.slice(0, CARD_COLS - 1)}.` : label
  const left = Math.floor((CARD_COLS - text.length) / 2)
  const pad = (count: number) => " ".repeat(count)
  const alert = state === "problem" || state === "waiting"
  return [{ text: pad(left), }, { text, fg: state === "problem" ? "error" : state === "waiting" ? "warning" : "muted", ...(alert ? { bold: true } : {}) }, { text: pad(CARD_COLS - left - text.length) }]
}

const SAMPLE_STEP = 97
const avatarKeys = new WeakMap<PetImage, string>()
/** Names an avatar's content for the image layer's cache: its size and a strided sample of its bytes. */
function avatarKey(image: PetImage): string {
  let key = avatarKeys.get(image)
  if (key === undefined) {
    let h = 0x811c9dc5
    for (let i = 0; i < image.rgba.length; i += SAMPLE_STEP) h = Math.imul(h ^ image.rgba[i]!, 0x01000193)
    avatarKeys.set(image, key = `${image.width}x${image.height}/${(h >>> 0).toString(36)}`)
  }
  return key
}

/** Generated pictures kept for the image layer: a face has few states, so a small bound is enough. */
const PICTURES = new Map<string, PetImage>()
const MAX_PICTURES = 48

/**
 * A bot's face. `card` is 4 rows of 9 cells (5 with a `label`, the state's word, which the caller gives); `icon` is one row of 2 cells.
 * `frame` picks the picture of a moving state (`faceFrameCount`; the animator in `bot-face-anim.ts` supplies it).
 */
export function botFace({ name, shape, color, state: asked, size, capability, frame = 0, label }: { name: string; shape?: BotShape | undefined; color?: BotColor | undefined; state: FaceInput; size: FaceSize; capability: FaceCapability; frame?: number; label?: string }): BotFace {
  const state = normal(asked)
  const look = faceLook({ name, shape, color })
  const role = roleOf(state, look.color)
  const ascii = capability.ascii === true
  const cols = size === "card" ? CARD_COLS : ICON_COLS
  const rows = size === "card" ? FACE_ROWS : 1
  const text: Line[] = size === "card"
    ? cardCells({ shape: look.shape, ascii, state, eyes: look.eyes, mouth: look.mouth, frame }).map((cells) => spansOf({ cells, role }))
    : [[{ text: iconText({ ascii, state, eyes: look.eyes, frame }), fg: role, bold: true }]]
  if (size === "card" && label) text.push(labelLine({ label, state }))
  const result: BotFace = { lines: text, cols, rows: text.length, pictureRows: rows, mode: ascii ? "ascii" : "unicode", shape: look.shape, color: look.color }
  if (ascii || !capability.images) return result
  const cell = capability.cellPixels ?? DEFAULT_CELL_PIXELS
  const [width, height] = [cols * cell.width, rows * cell.height]
  if (capability.avatar) {
    return { ...result, mode: "image", lines: text.map((line, at) => at >= rows ? line : [{ text: " ".repeat(line.reduce((sum, span) => sum + span.text.length, 0)) }]), image: { key: `bot-avatar/${avatarKey(capability.avatar)}/${size}`, image: capability.avatar } }
  }
  const body = (capability.theme ?? activeTheme()).colors[role]
  const f = frame % faceFrameCount(state)
  const key = `bot/${look.shape}/${body}/${look.eyes}/${look.mouth}/${state}/${f}/${width}x${height}`
  let image = PICTURES.get(key)
  if (!image) {
    image = rasterFace({ shape: look.shape, body, eyes: look.eyes, mouth: look.mouth, state, frame: f, width, height })
    if (PICTURES.size >= MAX_PICTURES) PICTURES.delete(PICTURES.keys().next().value!)
    PICTURES.set(key, image)
  }
  return { ...result, mode: "image", image: { key, image } }
}

/**
 * What the terminal can show, from the detection pets already use: images for kitty, iTerm2 and sixel; text for anything else. A face is
 * a picture only where the terminal is known by name (or the user chose a protocol): the device-attributes answer is not read, because a
 * terminal that lists sixel there may still not draw it, and the face area would stay blank.
 */
export function faceCapability({ env, depth, mode = "auto", ascii, avatar, cellPixels, theme }: { env: Record<string, string | undefined>; depth: "truecolor" | "256"; mode?: ImageMode; /** Accepted for callers that pass the host's answers; unused (see above). */ answers?: { da1?: string }; ascii?: boolean; avatar?: PetImage; cellPixels?: CellPixels; theme?: Pick<Theme, "colors"> }): FaceCapability {
  const tier = detectImageTier(env, depth, mode)
  return { ascii: ascii === true, images: tier === "kitty" || tier === "iterm2" || tier === "sixel", ...(avatar ? { avatar } : {}), ...(cellPixels ? { cellPixels } : {}), ...(theme ? { theme } : {}) }
}

/** The face's picture as a placement for the image layer at `row`, `col` (cells), or nothing when the face is text. */
export function facePlacement({ face, slot, row, col }: { face: BotFace; slot: string; row: number; col: number }): ImagePlacement | undefined {
  return face.image ? { slot, key: face.image.key, image: face.image.image, row, col, cols: face.cols, rows: face.pictureRows } : undefined
}

/** For the sidebar: the 2 by 1 cell picture of a bot, or nothing when images are off (the caller keeps its own glyph). */
export function botIconImage({ name, shape, color, state, capability, slot, row, col, frame }: { name: string; shape?: BotShape | undefined; color?: BotColor | undefined; state: FaceInput; capability: FaceCapability; slot: string; row: number; col: number; frame?: number }): ImagePlacement | undefined {
  if (capability.ascii || !capability.images) return undefined
  return facePlacement({ face: botFace({ name, shape, color, state, size: "icon", capability, ...(frame === undefined ? {} : { frame }) }), slot, row, col })
}
