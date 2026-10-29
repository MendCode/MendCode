import { FOOTER_SEGMENTS } from "./constants"

/**
 * The built-in footer as rows (`footerRows` in the /customize profile): an ordered list of rows, each a list of segment names. Data only,
 * so the profile can be checked without loading the client. The segments are the `/footer` ones (FOOTER_SEGMENTS) plus two that take a
 * name: `quota:<provider>` (one provider's windows) and `text:<name>` (a line of the profile's `footerText`).
 */

/** A typo in the list must not eat the screen; extension slots (`footer.left`, `footer.right`, `footer.replace`) share the ceiling. */
export const FOOTER_ROWS_MAX = 12
export const FOOTER_ROW_SEGMENTS_MAX = 16
/** The footer never takes more than a quarter of the terminal's height; rows drop from the bottom of the list. */
export const FOOTER_HEIGHT_FRACTION = 4
export const FOOTER_ICON_MODES = ["none", "glyph", "nerd"] as const
export type FooterIconMode = (typeof FOOTER_ICON_MODES)[number]
export const FOOTER_TEXT_MAX_ENTRIES = 16
export const FOOTER_TEXT_MAX_CHARS = 120
export const FOOTER_TEXT_MAX_CHOICES = 8

const NAME = /^[a-z0-9_-]{1,32}$/

/** `quota:codex` → `{ id: "quota", arg: "codex" }`; a bare name has no `arg`. */
export function parseRowSegment(entry: string): { id: string; arg?: string } {
  const at = entry.indexOf(":")
  return at < 0 ? { id: entry } : { id: entry.slice(0, at), arg: entry.slice(at + 1) }
}

/** Why `entry` is not a footer segment, or undefined when it is one. */
export function footerSegmentProblem(entry: string): string | undefined {
  const { id, arg } = parseRowSegment(entry)
  if (arg === undefined) return (FOOTER_SEGMENTS as readonly string[]).includes(id) ? undefined : `unknown footer segment "${entry}"`
  if (id !== "quota" && id !== "text") return `only quota and text take a name ("${entry}")`
  return NAME.test(arg) ? undefined : `${id}:<name> takes lowercase letters, digits, - and _ ("${entry}")`
}

/** One-line problems of a `footerRows` value. */
export function footerRowsProblems(value: unknown): string[] {
  if (!Array.isArray(value)) return ["footerRows: expected a list of rows"]
  if (value.length > FOOTER_ROWS_MAX) return [`footerRows: at most ${FOOTER_ROWS_MAX} rows`]
  for (const [index, row] of value.entries()) {
    if (!Array.isArray(row) || row.some((entry) => typeof entry !== "string")) return [`footerRows: row ${index + 1} must be a list of segment names`]
    if (row.length > FOOTER_ROW_SEGMENTS_MAX) return [`footerRows: row ${index + 1} has more than ${FOOTER_ROW_SEGMENTS_MAX} segments`]
    for (const entry of row as string[]) {
      const problem = footerSegmentProblem(entry)
      if (problem) return [`footerRows: row ${index + 1}: ${problem}`]
    }
  }
  return []
}

/** One-line problems of a `footerText` value: names mapped to a line, or to a list of lines one of which is shown per day. */
export function footerTextProblems(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["footerText: expected an object of name: text"]
  const entries = Object.entries(value)
  if (entries.length > FOOTER_TEXT_MAX_ENTRIES) return [`footerText: at most ${FOOTER_TEXT_MAX_ENTRIES} names`]
  for (const [name, text] of entries) {
    if (!NAME.test(name)) return [`footerText: "${name}" is not a name (lowercase letters, digits, - and _)`]
    const choices = Array.isArray(text) ? text : [text]
    if (choices.length === 0 || choices.length > FOOTER_TEXT_MAX_CHOICES) return [`footerText.${name}: one line or a list of 1..${FOOTER_TEXT_MAX_CHOICES}`]
    if (choices.some((line) => typeof line !== "string" || line.length > FOOTER_TEXT_MAX_CHARS || /[\x00-\x1f\x7f-\x9f]/.test(line))) return [`footerText.${name}: text only, at most ${FOOTER_TEXT_MAX_CHARS} characters a line`]
  }
  return []
}

export type FooterPreset = {
  /** One sentence for `/footer preset` and the docs. */
  help: string
  rows: readonly (readonly string[])[]
  /** Profile keys the preset sets with its rows (`classic` clears the rows and leaves the rest). */
  profile?: { quotaView?: "used" | "left"; quotaColor?: "pressure" | "accent" }
}

/** Presets, in the order `/footer preset` lists them. `classic` is the single row of the default footer. */
export const FOOTER_PRESETS: Readonly<Record<string, FooterPreset>> = {
  classic: { help: "the single row of the default footer", rows: [] },
  rows: {
    help: "five rows: directory and tagline, model and session figures, then one row per quota provider and the code graph",
    rows: [["directory", "text:tagline"], ["model", "effort", "context", "cache", "tokens"], ["quota:codex"], ["quota:claude"], ["codegraph"]],
    profile: { quotaView: "left", quotaColor: "accent" },
  },
  compact: { help: "two rows: directory, model and context; then every quota window", rows: [["directory", "model", "effort", "context"], ["quota"]] },
  telemetry: { help: "two rows: state, model and context; then tokens, cache, spend and speed", rows: [["state", "model", "effort", "context"], ["tokens", "cache", "spend", "ttft", "tps"]] },
}
export const FOOTER_PRESET_NAMES = Object.keys(FOOTER_PRESETS)

/** The text a `text:<name>` segment shows today: the line itself, or the day's pick of a list (the same line all day, no timers). */
export function footerTextLine(value: string | readonly string[] | undefined, now: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") return value || undefined
  if (value.length === 0) return undefined
  const day = Math.floor((now - new Date(now).getTimezoneOffset() * 60_000) / 86_400_000)
  return value[((day % value.length) + value.length) % value.length]
}
