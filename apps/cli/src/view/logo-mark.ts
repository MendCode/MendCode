import { DEFAULT_LOGO_FONT, DEFAULT_LOGO_TEXT, type LogoFont } from "./logo-fonts"
import { textWidth } from "./wrap"

/**
 * MendCode's logo in terminal cells: the infinity mark of the website (`public/branding/mendcode-symbol-white.svg`), two
 * chamfered loops whose rising stroke breaks where the falling one crosses it. Half blocks give square pixels on a 1:2 cell:
 * 38 x 16 pixels, sampled from the symbol's path, keep it wider than tall (the symbol is about 2:1) in 38 columns and 8 rows,
 * with a little extra width for terminals whose line spacing makes a cell taller than 1:2. ASCII glyphs draw the same
 * outline in plain characters, the break kept as the missing `.'` steps at the middle.
 */
export const LOGO_MARK: readonly string[] = [
  "   ▄██████████▄        ▄██████████▄   ",
  " ▄███▀▀▀▀▀▀▀▀███▄    ▄███▀▀▀▀▀▀▀▀███▄ ",
  "███▀          ▀███▄ ▀██▀          ▀███",
  "███             ▀███▄              ███",
  "███              ▀███▄             ███",
  "███▄          ▄██▄ ▀███▄          ▄███",
  " ▀███▄▄▄▄▄▄▄▄███▀    ▀███▄▄▄▄▄▄▄▄███▀ ",
  "   ▀██████████▀        ▀██████████▀   ",
]

export const LOGO_MARK_ASCII: readonly string[] = [
  "   .--------.            .--------.   ",
  " .'          '.        .'          '. ",
  "|              '.    .'              |",
  "|                '.                  |",
  "|                  '.                |",
  "|              .'    '.              |",
  " '.          .'        '.          .' ",
  "   '--------'            '--------'   ",
]

/**
 * "MendCode" in the website's wordmark letters (`mendcode-wordmark-white.svg`, the display face of the site): square
 * strokes two columns wide, chamfered corners, lowercase at four fifths of the capitals. Five rows, 58 columns.
 */
export const LOGO_TITLE: readonly string[] = [
  "██▄   ▄██                   ██ ▄█████            ██",
  "███▄ ▄███ ▄████▄ █████▄ ▄█████ ██     ▄████▄ ▄█████ ▄████▄",
  "██ ▀█▀ ██ ██  ██ ██  ██ ██  ██ ██     ██  ██ ██  ██ ██  ██",
  "██     ██ ██▀▀▀▀ ██  ██ ██  ██ ██     ██  ██ ██  ██ ██▀▀▀▀",
  "██     ██ ▀█████ ██  ██ ▀█████ ▀█████ ▀████▀ ▀█████ ▀█████",
]

/** The product name the big title spells; a renamed product keeps its name as plain text. */
const TITLE_NAME = "MendCode"

/** The mark for the glyph set in use: half blocks, or plain ASCII where only ASCII is drawn. */
export const logoMark = (ascii: boolean): readonly string[] => (ascii ? LOGO_MARK_ASCII : LOGO_MARK)

/** A wordmark left as shipped (the default letters in the default font) is the logo: the mark with the name under it. */
export const isShippedWordmark = (look: { logoText?: string | undefined; logoFont?: LogoFont | undefined } | undefined) =>
  (look?.logoText ?? DEFAULT_LOGO_TEXT) === DEFAULT_LOGO_TEXT && (look?.logoFont ?? DEFAULT_LOGO_FONT) === DEFAULT_LOGO_FONT

/** `rows` as one block centered in `width` columns: every row moves by the same pad, so letters stay aligned. */
const centeredOn = (rows: readonly string[], width: number) => {
  const pad = " ".repeat(Math.max(0, Math.floor((width - Math.max(...rows.map(textWidth))) / 2)))
  return rows.map((row) => pad + row)
}

/** The mark and, one row under it, `name` centered on it: the identity the home draws where the big title does not fit. */
export function logoLockup(name: string, ascii: boolean): string[] {
  const mark = logoMark(ascii)
  return [...mark, "", ...centeredOn([name], textWidth(mark[0]!))]
}

/**
 * The identities the home tries, largest first: the mark over the big title (half blocks, the shipped name only), then the
 * mark over the plain name. The home takes the first one its rows and columns hold.
 */
export function logoLockups(name: string, ascii: boolean): string[][] {
  const small = logoLockup(name, ascii)
  if (ascii || name !== TITLE_NAME) return [small]
  const width = Math.max(textWidth(LOGO_MARK[0]!), textWidth(LOGO_TITLE[1]!))
  return [[...centeredOn(LOGO_MARK, width), "", ...centeredOn(LOGO_TITLE, width)], small]
}
