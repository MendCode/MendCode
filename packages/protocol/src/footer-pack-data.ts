/**
 * Footer packs (docs/customize.md "Footer packs"): a whole footer look as one data file, `footer-packs/<name>.json` in the user's data
 * folder, a project's `.mendcode/` or a profile, chosen with the profile key `footerPack`. A pack names segments, their order and sides,
 * the separator, glyphs, how the context reads and the theme roles each part is drawn in; no pack runs code. Data only, so a file can be
 * checked without loading the client; the colour roles are checked by the client, which owns them.
 */

/** What a pack may place: each draws nothing when it has nothing to say (an empty diff, no shell running, a quota far from its limit). */
export const FOOTER_PACK_SEGMENTS = ["area", "directory", "branch", "git", "diff", "model", "effort", "context", "quota", "cost", "jobs", "agents", "goal", "mode", "permission", "connection", "hints"] as const
export type FooterPackSegment = (typeof FOOTER_PACK_SEGMENTS)[number]

export const FOOTER_PACK_STYLES = ["line", "powerline"] as const
/** How the context figure reads: `ctx 24%`, a filling circle `◔ 24%`, the honest denominator `48K/200K` or a bar `▕██▌░░░▏ 41%`. */
export const FOOTER_PACK_CONTEXT = ["percent", "pie", "fraction", "bar"] as const
export const FOOTER_PACK_QUOTA = ["percent", "bar"] as const
/** A segment with a background: a coloured chip (` PLAN `) or, without colour as the only signal, brackets (`[PLAN]`). */
export const FOOTER_PACK_CHIPS = ["fill", "brackets"] as const
/** Which glyphs a pack draws: `auto` follows the terminal's glyph set (Nerd Font, Unicode or ASCII), `text` draws words only. */
export const FOOTER_PACK_SYMBOLS = ["auto", "text"] as const
export type FooterPackSymbols = (typeof FOOTER_PACK_SYMBOLS)[number]
/** The glyph sets a pack can give its own symbols for; a set it leaves out falls back to the next one down (nerd → unicode → ascii → text). */
export const FOOTER_PACK_GLYPH_SETS = ["nerd", "unicode", "ascii"] as const
export type FooterPackGlyphSet = (typeof FOOTER_PACK_GLYPH_SETS)[number]

/** The look of a pack: what its text form sets, and what a glyph set may replace. */
export type FooterPackLook = {
  style?: (typeof FOOTER_PACK_STYLES)[number]
  /** Between the segments of a side (` · ` by default). */
  separator?: string
  context?: (typeof FOOTER_PACK_CONTEXT)[number]
  quota?: (typeof FOOTER_PACK_QUOTA)[number]
  chips?: (typeof FOOTER_PACK_CHIPS)[number]
  /** A glyph before a segment (` main`); a segment without one has none. */
  icons?: Partial<Record<FooterPackSegment, string>>
  /** A word before a segment's figure (`ctx`, `git`); an empty word drops the built-in one. */
  labels?: Partial<Record<FooterPackSegment, string>>
  /** Powerline: the glyph after a left chip and before a right chip (U+E0B0 / U+E0B2), and the outer caps of each side. */
  arrows?: { left?: string; right?: string }
  caps?: { start?: string; end?: string }
}

export type FooterPackRow = { left?: FooterPackSegment[]; right?: FooterPackSegment[] }

export type FooterPackFile = FooterPackLook & {
  label?: string
  /** One sentence for `/footer pack` and the docs. */
  help?: string
  rows: FooterPackRow[]
  /** Theme roles: a segment's text, and the fill of a chip (the segments named here are chips). */
  colors?: Partial<Record<FooterPackSegment, string>>
  backgrounds?: Partial<Record<FooterPackSegment, string>>
  /** The quota shows only while a window has less than this share left (20 by default; 101 always shows it). */
  quotaBelow?: number
  /** The context turns the warning colour from this share of its limit, and the error colour from the second (70 and 90). */
  contextWarn?: [number, number]
  /** States in words as well as colours (`ctx 92% high`, `quota low`): colour is never the only signal. */
  words?: boolean
  /** What a glyph set changes; the file's own fields are the text form, with no symbol at all. */
  symbols?: Partial<Record<FooterPackGlyphSet, FooterPackLook>>
}

/** The pack the footer draws while the user never chose a footer of their own. */
export const FOOTER_PACK_DEFAULT = "clean"
/** The packs MendCode ships (apps/cli/src/view/footer-packs/), in the order lists show them; files add their own names. */
export const FOOTER_PACK_BUILTINS = ["clean", "powerline", "minimal", "badges", "bars", "plain"] as const
/** `footerPack: off` is no pack: the built-in footer of before (the grouped row, and in the full view the `line` rows). */
export const FOOTER_PACK_OFF = "off"
export const FOOTER_PACK_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/
export const FOOTER_PACK_ROWS_MAX = 6
const SEGMENTS_MAX = 12
const TEXT_MAX = 12

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const isText = (value: unknown, max = TEXT_MAX) => typeof value === "string" && value.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(value)
const isSegment = (value: unknown): value is FooterPackSegment => typeof value === "string" && (FOOTER_PACK_SEGMENTS as readonly string[]).includes(value)
const ROLE = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/

function lookProblem(look: Record<string, unknown>, where: string): string | undefined {
  const oneOf = (key: string, values: readonly string[]) => look[key] === undefined || values.includes(look[key] as string) ? undefined : `${where}${key}: one of ${values.join(", ")}`
  const problem = oneOf("style", FOOTER_PACK_STYLES) ?? oneOf("context", FOOTER_PACK_CONTEXT) ?? oneOf("quota", FOOTER_PACK_QUOTA) ?? oneOf("chips", FOOTER_PACK_CHIPS)
  if (problem) return problem
  if (look.separator !== undefined && !isText(look.separator, 8)) return `${where}separator: text, at most 8 characters`
  for (const key of ["icons", "labels"] as const) {
    const map = look[key]
    if (map === undefined) continue
    if (!isRecord(map)) return `${where}${key}: an object of segment: text`
    for (const [name, text] of Object.entries(map)) {
      if (!isSegment(name)) return `${where}${key}: unknown segment "${name}"`
      if (!isText(text)) return `${where}${key}.${name}: text, at most ${TEXT_MAX} characters`
    }
  }
  for (const [key, names] of [["arrows", ["left", "right"]], ["caps", ["start", "end"]]] as const) {
    const map = look[key]
    if (map === undefined) continue
    if (!isRecord(map) || Object.entries(map).some(([name, text]) => !(names as readonly string[]).includes(name) || !isText(text, 2))) return `${where}${key}: { ${names.join(", ")} } of one or two characters`
  }
  return undefined
}

/** One-line problems of a pack file; empty when it can be drawn. Unknown top-level keys are problems too, so a typo is said. */
export function footerPackProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["expected an object with rows"]
  const known = new Set(["label", "help", "rows", "colors", "backgrounds", "quotaBelow", "contextWarn", "words", "symbols", "style", "separator", "context", "quota", "chips", "icons", "labels", "arrows", "caps"])
  const stray = Object.keys(value).find((key) => !known.has(key))
  if (stray) return [`unknown key "${stray}"`]
  if (value.label !== undefined && !isText(value.label, 40)) return ["label: text, at most 40 characters"]
  if (value.help !== undefined && !isText(value.help, 160)) return ["help: text, at most 160 characters"]
  const rows = value.rows
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > FOOTER_PACK_ROWS_MAX) return [`rows: a list of 1..${FOOTER_PACK_ROWS_MAX} rows`]
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row) || Object.keys(row).some((key) => key !== "left" && key !== "right")) return [`rows[${index}]: { left, right } lists of segments`]
    for (const side of ["left", "right"] as const) {
      const list = row[side]
      if (list === undefined) continue
      if (!Array.isArray(list) || list.length > SEGMENTS_MAX) return [`rows[${index}].${side}: a list of at most ${SEGMENTS_MAX} segments`]
      const bad = list.find((entry) => !isSegment(entry))
      if (bad !== undefined) return [`rows[${index}].${side}: unknown segment "${String(bad)}" (${FOOTER_PACK_SEGMENTS.join(", ")})`]
    }
  }
  for (const key of ["colors", "backgrounds"] as const) {
    const map = value[key]
    if (map === undefined) continue
    if (!isRecord(map)) return [`${key}: an object of segment: theme role`]
    for (const [name, role] of Object.entries(map)) {
      if (!isSegment(name)) return [`${key}: unknown segment "${name}"`]
      if (typeof role !== "string" || !ROLE.test(role)) return [`${key}.${name}: a theme role name (primary, muted, warning…)`]
    }
  }
  if (value.quotaBelow !== undefined && (typeof value.quotaBelow !== "number" || value.quotaBelow < 0 || value.quotaBelow > 101)) return ["quotaBelow: a share 0..101"]
  const warn = value.contextWarn
  if (warn !== undefined && (!Array.isArray(warn) || warn.length !== 2 || warn.some((at) => typeof at !== "number" || at < 1 || at > 100) || (warn[0] as number) > (warn[1] as number))) return ["contextWarn: [warning, error], two shares 1..100 in order"]
  if (value.words !== undefined && typeof value.words !== "boolean") return ["words: true or false"]
  const own = lookProblem(value, "")
  if (own) return [own]
  if (value.symbols !== undefined) {
    if (!isRecord(value.symbols)) return ["symbols: an object of nerd, unicode, ascii"]
    for (const [set, look] of Object.entries(value.symbols)) {
      if (!(FOOTER_PACK_GLYPH_SETS as readonly string[]).includes(set)) return [`symbols: unknown glyph set "${set}" (${FOOTER_PACK_GLYPH_SETS.join(", ")})`]
      if (!isRecord(look)) return [`symbols.${set}: an object`]
      const problem = lookProblem(look, `symbols.${set}.`)
      if (problem) return [problem]
    }
  }
  return []
}
