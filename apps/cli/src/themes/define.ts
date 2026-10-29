import { MARKDOWN_BORDER_ROLES, MARKDOWN_COLOR_ROLES, THEME_NAME } from "@mendcode/protocol/wire"

export const COLOR_NAMES = [
  "primary",
  "text",
  "body",
  "muted",
  "border",
  "heading",
  "code",
  "link",
  "success",
  "warning",
  "error",
  "accent",
  "secondary",
  "info",
  "borderActive",
  // Background fills (v1's backgroundPanel/backgroundElement and diff row tints); drawn behind text, never as text.
  "panel",
  "element",
  "diffAddedBg",
  "diffRemovedBg",
  // The theme's own background, for text drawn on a colored chip (v1's attachment badges).
  "background",
  "promptBg",
  // Code-block syntax roles (v1's syntax* colors); derived from the theme's palette when a theme omits them.
  "synComment",
  "synKeyword",
  "synString",
  "synNumber",
  "synFunction",
  "synType",
  // Markdown renderer roles (docs/design/markdown-parity.md); derived from the roles above when a theme omits them.
  ...MARKDOWN_COLOR_ROLES,
] as const

/** The markdown roles drawn as lines: 3:1 against the background, not 4.5:1. */
export const MARKDOWN_LINE_ROLES: ReadonlySet<string> = new Set(MARKDOWN_BORDER_ROLES)

/** Roles used only as backgrounds: their contrast is checked against the text drawn on them, not the terminal background. */
export const BACKGROUND_ROLES = ["panel", "element", "diffAddedBg", "diffRemovedBg", "background", "promptBg"] as const

/** `a` moved `amount` (0–1) of the way toward `b`, per channel. */
export function mix(a: string, b: string, amount: number) {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  return `#${[0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * amount).toString(16).padStart(2, "0")).join("")}`
}

export type ColorName = (typeof COLOR_NAMES)[number]
export type Palette = Readonly<Record<ColorName, string>>

/** The roles every theme must set; the rest (v1's accent, secondary, info, active border, fills) are derived when absent. */
export const REQUIRED_COLORS = ["primary", "text", "body", "muted", "border", "heading", "code", "link", "success", "warning", "error"] as const
type RequiredColor = (typeof REQUIRED_COLORS)[number]

export type Theme = {
  name: string
  label: string
  dark: boolean
  /** Reference background for contrast checks; the terminal draws its own. */
  background: string
  colors: Palette
  /** Terminal-owned palette indices; default preserves the host's foreground/background. */
  ansi?: Readonly<Record<ColorName, number | "default">>
}

/** The markdown roles a theme leaves out, taken from the roles it has (an explicit accent or info follows into the callouts). */
function markdownRoles(colors: ThemeInput["colors"]): Record<(typeof MARKDOWN_COLOR_ROLES)[number], string> {
  const accent = colors.accent ?? colors.heading
  const info = colors.info ?? colors.link
  return {
    mdHeading1: colors.heading,
    mdHeading2: colors.heading,
    mdHeading3: colors.text,
    mdHeading4: colors.body,
    mdInlineCode: colors.code,
    mdStrike: colors.muted,
    mdLink: colors.link,
    mdFootnote: colors.link,
    mdQuote: colors.muted,
    mdQuoteBar: colors.border,
    mdNote: info,
    mdTip: colors.success,
    mdImportant: accent,
    mdWarning: colors.warning,
    mdCaution: colors.error,
    mdTableHeader: colors.heading,
    mdTableBorder: colors.border,
    mdListMarker: colors.muted,
    mdTaskDone: colors.success,
    mdTaskOpen: colors.muted,
    mdRule: colors.border,
    mdCodeLabel: colors.muted,
    mdCodeBorder: colors.border,
    mdCopy: colors.muted,
    mdDiagramLine: colors.heading,
    mdDiagramAccent: accent,
    synFlag: mix(colors.heading, colors.link, 0.5),
    synPrompt: colors.muted,
    commentMark: accent,
    commentRule: info,
    commentQuote: mix(colors.body, colors.muted, 0.35),
  }
}

export type ThemeInput = Omit<Theme, "colors"> & { colors: Record<RequiredColor, string> & Partial<Record<ColorName, string>> }

const HEX = /^#[0-9a-f]{6}$/i

/** Validates a theme at definition time so a bad file fails on import, not at render. */
export function defineTheme(input: ThemeInput): Theme {
  // Derived roles mix these, so they are checked first (a theme file may omit any of them).
  for (const color of REQUIRED_COLORS) if (!HEX.test(input.colors[color] ?? "")) throw new TypeError(`[THEME]: ${input.name}.${color} must be #rrggbb`)
  if (!HEX.test(input.background)) throw new TypeError(`[THEME]: ${input.name} has an invalid background`)
  const colors: Record<ColorName, string> = {
    accent: input.colors.heading,
    secondary: input.colors.link,
    info: input.colors.link,
    borderActive: input.colors.primary,
    panel: mix(input.background, input.colors.text, 0.06),
    element: mix(input.background, input.colors.text, 0.12),
    diffAddedBg: mix(input.background, input.colors.success, 0.16),
    diffRemovedBg: mix(input.background, input.colors.error, 0.16),
    background: input.background,
    promptBg: mix(input.background, input.colors.text, 0.035),
    synComment: input.colors.muted,
    synKeyword: input.colors.heading,
    synString: input.colors.success,
    synNumber: input.colors.warning,
    synFunction: input.colors.link,
    synType: mix(input.colors.warning, input.colors.text, 0.35),
    ...markdownRoles(input.colors),
    ...input.colors,
  }
  const theme: Theme = { ...input, colors }
  if (!THEME_NAME.test(theme.name)) throw new TypeError(`[THEME]: invalid theme name "${theme.name}"`)
  if (!HEX.test(theme.background)) throw new TypeError(`[THEME]: ${theme.name} has an invalid background`)
  for (const color of COLOR_NAMES) {
    if (!HEX.test(theme.colors[color] ?? "")) throw new TypeError(`[THEME]: ${theme.name}.${color} must be #rrggbb`)
  }
  return Object.freeze({ ...theme, colors: Object.freeze({ ...theme.colors }) })
}
