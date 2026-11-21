import { BOT_COLORS, BOT_SHAPES, type BotColor, type BotShape } from "../../../../packages/packages/src/agents"

/**
 * Experimental bots: what a bot's name decides about how it looks. The one source of the shape and color a bot gets when its file sets
 * none, shared by the sidebar's glyph and by the face. Tiny and free of other imports so the glyph path never loads the face modules.
 */
import type { EyeStyle, MouthStyle } from "./bot-face-image"

function hash(name: string): number {
  let h = 0x811c9dc5
  for (const char of name.toLowerCase()) h = Math.imul(h ^ char.charCodeAt(0), 0x01000193)
  return h >>> 0
}
const pick = (h: number, salt: number, count: number) => (Math.imul(h ^ Math.imul(salt, 0x9e3779b1), 0x85ebca6b) >>> 11) % count

const EYES: readonly EyeStyle[] = ["round", "diamond", "square"]
const MOUTHS: readonly MouthStyle[] = ["smile", "flat", "small"]

/** What the name decides; a shape or color the bot sets wins. */
export function faceLook({ name, shape, color }: { name: string; shape?: BotShape | undefined; color?: BotColor | undefined }): { shape: BotShape; color: BotColor; eyes: EyeStyle; mouth: MouthStyle } {
  const h = hash(name)
  return {
    shape: shape ?? BOT_SHAPES[pick(h, 1, BOT_SHAPES.length)]!,
    color: color ?? BOT_COLORS[pick(h, 2, BOT_COLORS.length)]!,
    eyes: EYES[pick(h, 3, EYES.length)]!,
    mouth: MOUTHS[pick(h, 4, MOUTHS.length)]!,
  }
}
