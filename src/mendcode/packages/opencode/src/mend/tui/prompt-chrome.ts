export type MendPromptChromePreset = "left-rail" | "box" | "top-bottom" | "minimal" | "ascii-box"
export type MendPromptChromeBorderStyle = "single" | "rounded" | "heavy" | "ascii"

export type MendPromptChromeGlyphs = {
  horizontal?: string
  vertical?: string
  topLeft?: string
  topRight?: string
  bottomLeft?: string
  bottomRight?: string
  leadText?: string
}

export type MendPromptChromeConfig = {
  preset: MendPromptChromePreset
  top?: boolean
  bottom?: boolean
  left?: boolean
  right?: boolean
  borderStyle?: MendPromptChromeBorderStyle
  glyphs?: MendPromptChromeGlyphs
}

export type MendPromptChromeResolved = {
  preset: MendPromptChromePreset
  borderStyle: MendPromptChromeBorderStyle
  mainSides: Array<"top" | "left" | "right" | "bottom">
  footerSides: Array<"top" | "left" | "right" | "bottom">
  chars: Required<MendPromptChromeGlyphs>
  footerGlyph: string
  borderGlyph: string
  leadText?: string
}

const SIDE_ORDER = ["top", "left", "right", "bottom"] as const

function presetDefaults(preset: MendPromptChromePreset) {
  switch (preset) {
    case "box":
      return {
        borderStyle: "rounded" as const,
        main: { top: true, left: true, right: true, bottom: true },
        footer: { top: false, left: false, right: false, bottom: false },
      }
    case "top-bottom":
      return {
        borderStyle: "single" as const,
        main: { top: true, left: false, right: false, bottom: true },
        footer: { top: false, left: false, right: false, bottom: false },
      }
    case "minimal":
      return {
        borderStyle: "single" as const,
        main: { top: false, left: false, right: false, bottom: false },
        footer: { top: false, left: false, right: false, bottom: false },
      }
    case "ascii-box":
      return {
        borderStyle: "ascii" as const,
        main: { top: true, left: true, right: true, bottom: true },
        footer: { top: false, left: false, right: false, bottom: false },
      }
    case "left-rail":
    default:
      return {
        borderStyle: "rounded" as const,
        main: { top: false, left: true, right: false, bottom: false },
        footer: { top: false, left: true, right: false, bottom: false },
      }
  }
}

function borderChars(style: MendPromptChromeBorderStyle): Required<MendPromptChromeGlyphs> {
  switch (style) {
    case "single":
      return {
        horizontal: "─",
        vertical: "│",
        topLeft: "┌",
        topRight: "┐",
        bottomLeft: "└",
        bottomRight: "┘",
        leadText: "❭",
      }
    case "heavy":
      return {
        horizontal: "━",
        vertical: "┃",
        topLeft: "┏",
        topRight: "┓",
        bottomLeft: "┗",
        bottomRight: "┛",
        leadText: "❭",
      }
    case "ascii":
      return {
        horizontal: "=",
        vertical: "|",
        topLeft: "+",
        topRight: "+",
        bottomLeft: "+",
        bottomRight: "+",
        leadText: "❭",
      }
    case "rounded":
    default:
      return {
        horizontal: "─",
        vertical: "│",
        topLeft: "╭",
        topRight: "╮",
        bottomLeft: "╰",
        bottomRight: "╯",
        leadText: "❭",
      }
  }
}

function orderedSides(input: Record<"top" | "left" | "right" | "bottom", boolean>) {
  return SIDE_ORDER.filter((side) => input[side])
}

export function defaultPromptChrome(): MendPromptChromeConfig {
  return { preset: "top-bottom", borderStyle: "rounded" }
}

export function normalizePromptChromePreset(value: unknown): MendPromptChromePreset {
  if (value === "left-rail") return "top-bottom"
  if (value === "box" || value === "top-bottom" || value === "minimal" || value === "ascii-box") return value
  return "top-bottom"
}

export function promptChromeUsesFullSessionWidth(preset: MendPromptChromePreset) {
  switch (preset) {
    case "left-rail":
    case "box":
    case "top-bottom":
    case "minimal":
    case "ascii-box":
      return true
  }
}

export function resolvePromptChrome(
  profile?: MendPromptChromeConfig | null,
  override?: Partial<MendPromptChromeConfig> | null,
): MendPromptChromeResolved {
  const base = defaultPromptChrome()
  const mergedPreset = normalizePromptChromePreset(override?.preset || profile?.preset || base.preset)
  const defaults = presetDefaults(mergedPreset)
  const style = override?.borderStyle || profile?.borderStyle || defaults.borderStyle
  const mergedGlyphs = {
    ...borderChars(style),
    ...(profile?.glyphs || {}),
    ...(override?.glyphs || {}),
  }
  const sideOverride = {
    top: override?.top ?? profile?.top,
    bottom: override?.bottom ?? profile?.bottom,
    left: override?.left ?? profile?.left,
    right: override?.right ?? profile?.right,
  }
  const main = {
    top: sideOverride.top ?? defaults.main.top,
    left: sideOverride.left ?? defaults.main.left,
    right: sideOverride.right ?? defaults.main.right,
    bottom: sideOverride.bottom ?? defaults.main.bottom,
  }
  const footer = {
    top: false,
    left: sideOverride.left ?? defaults.footer.left,
    right: sideOverride.right ?? defaults.footer.right,
    bottom: sideOverride.bottom ?? defaults.footer.bottom,
  }
  return {
    preset: mergedPreset,
    borderStyle: style,
    mainSides: orderedSides(main),
    footerSides: orderedSides(footer),
    chars: mergedGlyphs,
    borderGlyph: mergedGlyphs.vertical,
    footerGlyph: mergedPreset === "left-rail" ? "╹" : mergedGlyphs.horizontal,
    leadText:
      mergedPreset === "minimal" || mergedPreset === "top-bottom" || mergedPreset === "box" || mergedPreset === "ascii-box"
        ? (mergedGlyphs.leadText ?? "❭")
        : undefined,
  }
}
