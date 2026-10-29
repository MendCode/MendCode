import { BACKGROUND_ROLES, COLOR_NAMES, MARKDOWN_LINE_ROLES, defineTheme, type ColorName, type Theme } from "./define"

/** Roles drawn as lines or fills, not read as text on the terminal background: exempt from the 4.5:1 rule there. */
export const BORDER_ROLES: ReadonlySet<ColorName> = new Set([...(["border", "borderActive", ...BACKGROUND_ROLES] as const), ...COLOR_NAMES.filter((role) => MARKDOWN_LINE_ROLES.has(role))])
export const MIN_CONTRAST = 4.5

function channels(hex: string) {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
}

export function luminance(hex: string) {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

export function contrast(a: string, b: string) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high! + 0.05) / (low! + 0.05)
}

/** Mixes `hex` toward white (dark backgrounds) or black (light ones) just enough to reach `min` against `background`. */
export function readableOn(hex: string, background: string, min = MIN_CONTRAST) {
  if (contrast(hex, background) >= min) return hex
  const target = luminance(background) < 0.5 ? 255 : 0
  const from = channels(hex)
  for (let step = 1; step <= 20; step++) {
    const mixed = `#${from.map((v) => Math.round(v + ((target - v) * step) / 20).toString(16).padStart(2, "0")).join("")}`
    if (contrast(mixed, background) >= min) return mixed
  }
  return target === 255 ? "#ffffff" : "#000000"
}

/**
 * A ported theme with every readable role raised to 4.5:1 against its background, keeping each hue as
 * close as possible (MendCode v1 shipped some themes with dim muted and error colors).
 */
export function withReadableContrast(theme: Theme): Theme {
  const colors = { ...theme.colors }
  colors.border = readableOn(colors.border, theme.background, 3)
  colors.borderActive = readableOn(colors.borderActive, theme.background, Math.max(3.5, contrast(colors.border, theme.background) + 0.1))
  for (const role of COLOR_NAMES) if (MARKDOWN_LINE_ROLES.has(role)) colors[role] = readableOn(colors[role], theme.background, 3)
  for (const role of COLOR_NAMES) if (!BORDER_ROLES.has(role)) colors[role] = readableOn(colors[role], theme.background)
  // Text is also drawn on panel and diff fills; raise it against each of those too.
  for (const role of ["text", "body"] as const) for (const fill of BACKGROUND_ROLES) colors[role] = readableOn(colors[role], colors[fill])
  return defineTheme({ ...theme, colors })
}
