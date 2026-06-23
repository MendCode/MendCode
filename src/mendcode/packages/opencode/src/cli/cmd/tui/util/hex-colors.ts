export type HexColorSwatch = {
  hex: string
  display: string
}

const HEX_COLOR_PATTERN = /(^|[^A-Za-z0-9_])#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})(?![A-Za-z0-9_])/g

export function normalizeHexColor(value: string) {
  const trimmed = value.trim()
  if (!/^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(trimmed)) return
  const raw = trimmed.slice(1).toLowerCase()
  if (raw.length === 3) return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`
  return `#${raw}`
}

export function extractHexColors(input: string, limit = 8): HexColorSwatch[] {
  const seen = new Set<string>()
  const colors: HexColorSwatch[] = []

  for (const match of input.matchAll(HEX_COLOR_PATTERN)) {
    const display = match[0].slice(match[1]?.length ?? 0)
    const hex = normalizeHexColor(display)
    if (!hex || seen.has(hex)) continue

    seen.add(hex)
    colors.push({ hex, display })
    if (colors.length >= limit) break
  }

  return colors
}
