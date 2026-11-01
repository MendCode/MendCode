import { DEFAULT_LOGO_FONT, DEFAULT_LOGO_TEXT, type LogoFont } from "./logo-fonts"
import { textWidth } from "./wrap"

/**
 * MendCode's logo in terminal cells: the infinity mark of the website (`public/branding/mendcode-symbol-white.svg`), two
 * chamfered loops whose rising stroke breaks where the falling one crosses it. Half blocks give square pixels on a 1:2 cell,
 * so 24 x 12 pixels keep the symbol's 2:1 shape in 24 columns and 6 rows. ASCII glyphs draw the same outline in plain
 * characters, the break kept as the missing `/` at the middle.
 */
export const LOGO_MARK: readonly string[] = [
  "  ▄██████▄    ▄██████▄  ",
  "▄██▀    ▀██▄ ██▀    ▀██▄",
  "██        ██▄         ██",
  "██         ▀██        ██",
  "▀██▄    ▄██ ▀██▄    ▄██▀",
  "  ▀██████▀    ▀██████▀  ",
]

export const LOGO_MARK_ASCII: readonly string[] = [
  "  .------.    .------.  ",
  " /        \\  /        \\ ",
  "|          \\           |",
  "|           \\          |",
  " \\        /  \\        / ",
  "  '------'    '------'  ",
]

/** The mark for the glyph set in use: half blocks, or plain ASCII where only ASCII is drawn. */
export const logoMark = (ascii: boolean): readonly string[] => (ascii ? LOGO_MARK_ASCII : LOGO_MARK)

/** A wordmark left as shipped (the default letters in the default font) is the logo: the mark with the name under it. */
export const isShippedWordmark = (look: { logoText?: string | undefined; logoFont?: LogoFont | undefined } | undefined) =>
  (look?.logoText ?? DEFAULT_LOGO_TEXT) === DEFAULT_LOGO_TEXT && (look?.logoFont ?? DEFAULT_LOGO_FONT) === DEFAULT_LOGO_FONT

/** The mark and, one row under it, `name` centered on it: the identity the home draws for the shipped wordmark. */
export function logoLockup(name: string, ascii: boolean): string[] {
  const mark = logoMark(ascii)
  const pad = " ".repeat(Math.max(0, Math.floor((textWidth(mark[0]!) - textWidth(name)) / 2)))
  return [...mark, "", `${pad}${name}`]
}
