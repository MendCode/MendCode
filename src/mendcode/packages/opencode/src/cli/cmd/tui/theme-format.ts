import { isRecord } from "@/util/record"

export const THEME_COLOR_KEYS = [
  "primary", "secondary", "accent", "error", "warning", "success", "info",
  "text", "textMuted", "background", "backgroundPanel", "backgroundElement", "border", "borderActive", "borderSubtle",
  "diffAdded", "diffRemoved", "diffContext", "diffHunkHeader", "diffHighlightAdded", "diffHighlightRemoved",
  "diffAddedBg", "diffRemovedBg", "diffContextBg", "diffLineNumber", "diffAddedLineNumberBg", "diffRemovedLineNumberBg",
  "markdownText", "markdownHeading", "markdownLink", "markdownLinkText", "markdownCode", "markdownBlockQuote",
  "markdownEmph", "markdownStrong", "markdownHorizontalRule", "markdownListItem", "markdownListEnumeration",
  "markdownImage", "markdownImageText", "markdownCodeBlock", "syntaxComment", "syntaxKeyword", "syntaxFunction",
  "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
] as const

type Color = string | number | { dark: string | number; light: string | number }
export type MendThemeDocument = { $schema?: string; defs?: Record<string, Color>; theme: Record<string, Color> }

const hex = /^#[0-9a-f]{3,8}$/i

function color(value: unknown): value is Color {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= 255
  if (typeof value === "string") return value === "transparent" || value === "none" || hex.test(value) || value.length > 0
  if (!isRecord(value)) return false
  return color(value.dark) && color(value.light)
}

function resolve(value: Color, defs: Record<string, Color>, theme: Record<string, Color>, seen = new Set<string>()): Color | undefined {
  if (typeof value !== "string") return value
  if (value === "transparent" || value === "none" || hex.test(value) || /^\d+$/.test(value)) return value
  if (seen.has(value)) return undefined
  const next = defs[value] ?? theme[value]
  if (next === undefined) return undefined
  const chain = new Set(seen)
  chain.add(value)
  return resolve(next, defs, theme, chain)
}

function luminance(value: string) {
  const raw = value.slice(1)
  const rgb = raw.length === 3 ? raw.split("").map((x) => Number.parseInt(x + x, 16)) : [0, 2, 4].map((i) => Number.parseInt(raw.slice(i, i + 2), 16))
  return rgb.map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)).reduce((a, x, i) => a + x * [0.2126, 0.7152, 0.0722][i]!, 0)
}

export function validateThemeDocument(value: unknown) {
  const errors: string[] = []
  if (!isRecord(value) || !isRecord(value.theme)) return ["theme must be an object with a theme object"]
  const theme = value.theme
  const defs = isRecord(value.defs) ? value.defs : {}
  for (const key of THEME_COLOR_KEYS) if (!(key in theme)) errors.push(`theme.${key} is required`)
  for (const [key, item] of Object.entries(theme)) if (!color(item)) errors.push(`theme.${key} is not a hex, ANSI, reference, or variant color`)
  if (value.defs !== undefined && (!isRecord(value.defs) || Object.entries(value.defs).some(([, item]) => !color(item)))) errors.push("defs must contain only valid colors")
  for (const [key, item] of Object.entries(theme)) {
    if (!color(item)) continue
    const variants = typeof item === "object" && !Array.isArray(item) ? [item.dark, item.light] : [item]
    for (const variant of variants) {
      if (typeof variant !== "string" || variant === "transparent" || variant === "none" || hex.test(variant) || /^\d+$/.test(variant)) continue
      if (!resolve(variant, defs as Record<string, Color>, theme as Record<string, Color>)) errors.push(`theme.${key} references unknown color ${variant}`)
    }
  }
  const background = theme.background
  const foreground = theme.text
  const resolvedBackground = color(background) ? resolve(background, defs as Record<string, Color>, theme as Record<string, Color>) : undefined
  const resolvedForeground = color(foreground) ? resolve(foreground, defs as Record<string, Color>, theme as Record<string, Color>) : undefined
  if (typeof resolvedBackground === "string" && typeof resolvedForeground === "string" && hex.test(resolvedBackground) && hex.test(resolvedForeground)) {
    const ratio = (Math.max(luminance(resolvedBackground), luminance(resolvedForeground)) + 0.05) / (Math.min(luminance(resolvedBackground), luminance(resolvedForeground)) + 0.05)
    if (ratio < 3) errors.push(`theme.text and theme.background contrast is ${ratio.toFixed(2)}:1; minimum is 3:1`)
  }
  return errors
}
