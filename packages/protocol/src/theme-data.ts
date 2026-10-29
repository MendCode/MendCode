export const THEME_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/i
export const MAX_THEME_BYTES = 16 * 1024
export const THEME_REQUIRED_ROLES = ["primary", "text", "body", "muted", "border", "heading", "code", "link", "success", "warning", "error"] as const

/**
 * The colour roles of the Markdown renderer, each optional in a theme file (derived from the base roles when absent).
 * Borders and rules are 3:1 roles; everything else is text. The terminal profile's `markdownColors` overrides them one by one.
 */
export const MARKDOWN_COLOR_ROLES = [
  "mdHeading1", "mdHeading2", "mdHeading3", "mdHeading4",
  "mdInlineCode", "mdStrike", "mdLink", "mdFootnote",
  "mdQuote", "mdQuoteBar", "mdNote", "mdTip", "mdImportant", "mdWarning", "mdCaution",
  "mdTableHeader", "mdTableBorder", "mdListMarker", "mdTaskDone", "mdTaskOpen", "mdRule",
  "mdCodeLabel", "mdCodeBorder", "mdCopy", "mdDiagramLine", "mdDiagramAccent",
  "synFlag", "synPrompt",
  // Comments on an answer's passages (the gutter mark and chip numbers, the compose rule, the quotes): theme files and `markdownColors` set them like any role.
  "commentMark", "commentRule", "commentQuote",
] as const
/** The markdown roles drawn as lines (3:1 against the background) rather than read as text (4.5:1). */
export const MARKDOWN_BORDER_ROLES = ["mdQuoteBar", "mdTableBorder", "mdRule", "mdCodeBorder"] as const

/** Roles the profile's `markdownColors` may override: the Markdown roles and the code-block syntax roles. */
export const OVERRIDABLE_COLOR_ROLES: readonly string[] = [...MARKDOWN_COLOR_ROLES, "synComment", "synKeyword", "synString", "synNumber", "synFunction", "synType"]

/** `markdownColors` as an object of role to #rrggbb (the valid entries only); `error` names the first bad one. */
export function parseMarkdownColors(text: string): { colors: Record<string, string>; error?: string } {
  const colors: Record<string, string> = {}
  if (!text.trim()) return { colors }
  let json: unknown
  try { json = JSON.parse(text) } catch { return { colors, error: "expected a JSON object of role to #rrggbb" } }
  if (!json || typeof json !== "object" || Array.isArray(json)) return { colors, error: "expected a JSON object of role to #rrggbb" }
  let error: string | undefined
  for (const [role, color] of Object.entries(json)) {
    if (!OVERRIDABLE_COLOR_ROLES.includes(role)) error ??= `unknown role: ${role}`
    else if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) error ??= `${role} must be #rrggbb`
    else colors[role] = color.toLowerCase()
  }
  return error ? { colors, error } : { colors }
}

export const V1_THEME_ROLES = [
  "primary", "secondary", "accent", "error", "warning", "success", "info", "text", "textMuted", "background", "backgroundPanel", "backgroundElement", "border", "borderActive", "borderSubtle",
  "diffAdded", "diffRemoved", "diffContext", "diffHunkHeader", "diffHighlightAdded", "diffHighlightRemoved", "diffAddedBg", "diffRemovedBg", "diffContextBg", "diffLineNumber", "diffAddedLineNumberBg", "diffRemovedLineNumberBg",
  "markdownText", "markdownHeading", "markdownLink", "markdownLinkText", "markdownCode", "markdownBlockQuote", "markdownEmph", "markdownStrong", "markdownHorizontalRule", "markdownListItem", "markdownListEnumeration", "markdownImage", "markdownImageText", "markdownCodeBlock",
  "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
] as const

const ROLE_MAP: Record<string, string> = {
  primary: "primary", secondary: "secondary", accent: "accent", error: "error", warning: "warning", success: "success", info: "info", text: "text", body: "markdownText", muted: "textMuted", border: "border", borderActive: "borderActive",
  heading: "markdownHeading", code: "markdownCode", link: "markdownLink", panel: "backgroundPanel", element: "backgroundElement", diffAddedBg: "diffAddedBg", diffRemovedBg: "diffRemovedBg", background: "background",
  synComment: "syntaxComment", synKeyword: "syntaxKeyword", synString: "syntaxString", synNumber: "syntaxNumber", synFunction: "syntaxFunction", synType: "syntaxType",
}
const HEX = /^#[0-9a-f]{6}$/i
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const rgb = (channels: number[]) => `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
const ANSI = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"]

function ansiColor(index: number) {
  if (index < 16) return ANSI[index]!
  if (index >= 232) return rgb([0, 0, 0].map(() => 8 + (index - 232) * 10))
  const cube = index - 16
  return rgb([Math.floor(cube / 36), Math.floor(cube / 6) % 6, cube % 6].map((channel) => channel ? 55 + channel * 40 : 0))
}

function luminance(hex: string) {
  return [0.2126, 0.7152, 0.0722].reduce((total, weight, index) => {
    const channel = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255
    return total + weight * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  }, 0)
}

export type ThemeDocument = { label?: string; dark?: boolean; background: string; colors: Record<string, string> }

export function themeDocument(value: unknown): { document?: ThemeDocument; errors: string[] } {
  const errors: string[] = []
  if (!record(value)) return { errors: ["theme must be a JSON object"] }
  if (!record(value.theme)) {
    if (!record(value.colors) || typeof value.background !== "string") return { errors: ['expected { "background": "#rrggbb", "colors": { … } }'] }
    if (!HEX.test(value.background)) errors.push("background must be #rrggbb")
    for (const role of THEME_REQUIRED_ROLES) if (!HEX.test(String(value.colors[role] ?? ""))) errors.push(`${role} must be #rrggbb`)
    for (const [role, color] of Object.entries(value.colors)) if (role in ROLE_MAP || role === "promptBg" || (MARKDOWN_COLOR_ROLES as readonly string[]).includes(role)) {
      if (typeof color !== "string" || !HEX.test(color)) errors.push(`${role} must be #rrggbb`)
    }
    if (errors.length) return { errors: [...new Set(errors)] }
    return { document: { background: value.background, colors: value.colors as Record<string, string>, ...(typeof value.label === "string" ? { label: value.label } : {}), ...(typeof value.dark === "boolean" ? { dark: value.dark } : {}) }, errors }
  }
  const palette = value.theme
  if (value.defs !== undefined && !record(value.defs)) return { errors: ["defs must be an object"] }
  const defs = record(value.defs) ? value.defs : {}
  const dark = value.dark !== false
  function resolveColor(color: unknown, variant: "dark" | "light", seen: Set<string> = new Set()): string | undefined {
    if (record(color)) return resolveColor(color[variant], variant, seen)
    if (typeof color === "number" || typeof color === "string" && /^\d+$/.test(color)) {
      const index = Number(color)
      return Number.isInteger(index) && index >= 0 && index <= 255 ? ansiColor(index) : undefined
    }
    if (typeof color !== "string" || !color) return undefined
    if (color === "none" || color === "transparent") return color
    if (/^#[0-9a-f]{3,8}$/i.test(color)) {
      const hex = color.slice(1)
      if (hex.length === 3 || hex.length === 4) return `#${hex.slice(0, 3).split("").map((digit) => digit + digit).join("")}`
      if (hex.length === 6 || hex.length === 8) return `#${hex.slice(0, 6)}`
      return undefined
    }
    if (seen.has(color) || seen.size > 100) return undefined
    const next = Object.hasOwn(defs, color) ? defs[color] : Object.hasOwn(palette, color) ? palette[color] : undefined
    return resolveColor(next, variant, new Set([...seen, color]))
  }
  for (const role of V1_THEME_ROLES) if (!Object.hasOwn(palette, role)) errors.push(`theme.${role} is required`)
  for (const [group, entries] of [["defs", defs], ["theme", palette]] as const) for (const [role, color] of Object.entries(entries)) {
    for (const variant of ["dark", "light"] as const) if (!resolveColor(color, variant)) errors.push(`${group}.${role} has an invalid ${variant} color or reference`)
  }
  if (errors.length) return { errors }
  const colors = Object.fromEntries(Object.entries(ROLE_MAP).map(([role, source]) => {
    const color = resolveColor(palette[source], dark ? "dark" : "light")!
    const background = ["background", "panel", "element", "diffAddedBg", "diffRemovedBg"].includes(role)
    return [role, HEX.test(color) ? color : background ? dark ? "#0b1210" : "#ffffff" : dark ? "#f3f4f6" : "#111827"]
  }))
  const foreground = luminance(colors.text!)
  const background = luminance(colors.background!)
  const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
  if (HEX.test(resolveColor(palette.text, dark ? "dark" : "light")!) && HEX.test(resolveColor(palette.background, dark ? "dark" : "light")!) && contrast < 3) return { errors: [`theme.text and theme.background contrast is ${contrast.toFixed(2)}:1; minimum is 3:1`] }
  return { document: { background: colors.background!, colors, dark, ...(typeof value.label === "string" ? { label: value.label } : {}) }, errors }
}
