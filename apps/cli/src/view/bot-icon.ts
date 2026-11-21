import type { BotState } from "@mendcode/protocol"
import { BOT_COLORS, BOT_SHAPES } from "@mendcode/protocol/wire"
import type { ImagePlacement } from "../ui/image-layer"
import type { ColorName } from "../ui/theme"
import type { botIconImage, FaceCapability, faceStateOf } from "./bot-face"
import { faceLook } from "./bot-look"

/**
 * Experimental bots (docs/agents.md): the one place a bot's icon is drawn. It is a glyph per shape in the bot's theme color role
 * (ASCII when the terminal lacks unicode); when the terminal draws images (`faces`) the glyph's two cells stay blank and `image`
 * gives the picture for the image layer. ASCII mode wins over images.
 */
export type BotShape = (typeof BOT_SHAPES)[number]
export type BotColor = (typeof BOT_COLORS)[number]
export type BotIcon = {
  /** The icon and exactly one space after it: the glyph and a space (ASCII: the two glyph cells, to which the caller adds the space), or under a picture its two blank cells and the space. */
  text: string
  fg: ColorName
  shape: BotShape
  color: BotColor
  /** The 2 by 1 picture at a screen cell; present only when `faces` allowed images. */
  image?: (at: { row: number; col: number }) => ImagePlacement | undefined
}
/** What drawing a picture needs, handed in by the caller that already loaded `bot-face` (this module never imports it). */
export type IconFaces = { capability: FaceCapability; slot: string; make: typeof botIconImage; stateOf: typeof faceStateOf; frame?: number }

const UNICODE: Record<BotShape, string> = { circle: "●", square: "■", diamond: "◆", triangle: "▲", hexagon: "⬢" }
const ASCII: Record<BotShape, string> = { circle: "()", square: "[]", diamond: "<>", triangle: "/\\", hexagon: "{}" }

export function botIcon({ name, shape, color, ascii, state, faces }: { name: string; shape?: BotShape | undefined; color?: BotColor | undefined; ascii?: boolean | undefined; state?: BotState | undefined; faces?: IconFaces | undefined }): BotIcon {
  // The same derivation as the face (`bot-look.ts`), so a glyph and a face of one bot agree.
  const { shape: kind, color: role } = faceLook({ name, shape, color })
  const glyph: BotIcon = { text: ascii ? ASCII[kind] : `${UNICODE[kind]} `, fg: role, shape: kind, color: role }
  if (ascii || !faces || faces.capability.ascii || !faces.capability.images) return glyph
  const { capability, slot, make, stateOf, frame } = faces
  return { ...glyph, text: "   ", image: ({ row, col }) => make({ name, shape, color, state: stateOf(state ?? "idle"), capability, slot, row, col, ...(frame === undefined ? {} : { frame }) }) }
}
