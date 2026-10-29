import { COLOR_NAMES, DEFAULT_THEME, THEMES, type ColorName, type Theme } from "../themes"
import mend from "../themes/mend"
import type { TerminalMode } from "./terminal-mode"

export type { ColorName, Theme }

let active: Theme = THEMES.find((theme) => theme.name === DEFAULT_THEME) ?? mend
/** Themes from files (packages, the user's and the project's `themes/`); a file wins over a built-in of the same name. */
let fileThemes: Theme[] = []

function allThemes(): Theme[] {
  const replaced = new Set(fileThemes.map((theme) => theme.name))
  return [...THEMES.filter((theme) => !replaced.has(theme.name)), ...fileThemes]
}

export function themeNames(): string[] {
  return allThemes().map((theme) => theme.name)
}

/** Every theme in use: built-ins, v1 ports and theme files. */
export function themeList(): readonly Theme[] {
  return allThemes()
}

/** The picker entry that follows the terminal's light/dark mode instead of naming a palette. */
export const SYSTEM_THEME = "system"
/** The palettes `system` resolves to, by mode. */
const SYSTEM_PALETTES: Readonly<Record<TerminalMode, string>> = { dark: DEFAULT_THEME, light: "paper" }
let following = false
let detectedMode: TerminalMode | undefined
let lockedMode: TerminalMode | undefined

/** The mode `system` uses: the lock, else what the terminal reported, else dark. */
export function effectiveThemeMode(): TerminalMode {
  return lockedMode ?? detectedMode ?? "dark"
}

export function themeModeState(): { detected: TerminalMode | undefined; locked: TerminalMode | undefined; effective: TerminalMode } {
  return { detected: detectedMode, locked: lockedMode, effective: effectiveThemeMode() }
}

function followSystem() {
  const next = allThemes().find((theme) => theme.name === SYSTEM_PALETTES[effectiveThemeMode()])
  if (next) active = next
}

/** What is chosen: `system` while following the terminal, else the palette name. This is what is saved. */
export function themeSelection(): string {
  return following ? SYSTEM_THEME : active.name
}

/** The terminal's reported mode (undefined when it cannot be told); `system` repaints unless the mode is locked. */
export function setTerminalMode(mode: TerminalMode | undefined) {
  detectedMode = mode
  if (following) followSystem()
}

/** Pins the mode `system` uses so terminal changes are ignored; undefined follows the terminal again. */
export function setThemeLock(mode: TerminalMode | undefined) {
  lockedMode = mode
  if (following) followSystem()
}

/** Replaces the file themes; the active theme is re-read so an edited file applies at once. */
export function registerThemes(themes: readonly Theme[]) {
  fileThemes = [...themes]
  if (following) return followSystem()
  const current = allThemes().find((theme) => theme.name === active.name)
  if (current) active = current
}

export function activeTheme(): Theme {
  return active
}

/** Colours the user set one by one (the profile's `markdownColors`), over whatever theme is active; the theme's own roles are untouched. */
let overrides: Readonly<Partial<Record<ColorName, string>>> = {}

/** Replaces the per-role overrides: only known roles with a valid #rrggbb are kept, so a bad entry never reaches `sgr`. */
export function setColorOverrides(next: Readonly<Record<string, string>>) {
  const known = new Set<string>(COLOR_NAMES)
  const kept: Partial<Record<ColorName, string>> = {}
  for (const [role, hex] of Object.entries(next)) if (known.has(role) && /^#[0-9a-f]{6}$/i.test(hex)) kept[role as ColorName] = hex
  overrides = kept
}

export const colorOverrides = (): Readonly<Partial<Record<ColorName, string>>> => overrides

/** Switches the palette used by `sgr`; `system` follows the terminal's mode. Unknown names return false and keep the current theme. */
export function setTheme(name: string): boolean {
  const requested = name.trim()
  if (requested.toLowerCase() === SYSTEM_THEME) {
    following = true
    followSystem()
    return true
  }
  const next = allThemes().find((theme) => theme.name === requested) ?? allThemes().find((theme) => theme.name.toLowerCase() === requested.toLowerCase())
  if (!next) return false
  following = false
  active = next
  return true
}

const envTheme = process.env.MENDCODE_THEME
if (envTheme) setTheme(envTheme)

/** `fgHex`/`bgHex` (#rgb or #rrggbb) are for content colors such as swatches and pet pixels; they win over the theme roles `fg`/`bg`. */
export type Span = { text: string; fg?: ColorName; fgHex?: string; bg?: ColorName; bgHex?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; /** An OSC 8 hyperlink target (see ui/hyperlink.ts); the screen draws it when links are on. */ link?: string }
export type Line = Span[]

const GLYPH_SETS = {
  // Only glyphs verified to render in JetBrains Mono (↺ and ⚙ are missing there and draw as tofu).
  unicode: { user: "❯", tool: "◆", ok: "✓", fail: "✗", running: "•", queue: "…", ask: "?", rule: "─", barFull: "█", barEmpty: "░", reset: "resets ", reasoning: "·", done: "◈", dot: "●", collapsed: "◇", rail: "┃", goal: "◎", thumb: "┃", track: "│", below: "↓", sep: "·" },
  nerd: { user: "", tool: "󰒓", ok: "", fail: "", running: "󰑮", queue: "󰔟", ask: "", rule: "─", barFull: "█", barEmpty: "░", reset: "󰑓", reasoning: "󰟷", done: "◈", dot: "●", collapsed: "◇", rail: "┃", goal: "◎", thumb: "┃", track: "│", below: "↓", sep: "·" },
  // One cell each, like the sets above, so a layout measured in one set fits in the others.
  ascii: { user: ">", tool: "*", ok: "+", fail: "x", running: "*", queue: ".", ask: "?", rule: "-", barFull: "#", barEmpty: ".", reset: "resets ", reasoning: ".", done: "*", dot: "o", collapsed: "+", rail: "|", goal: "@", thumb: "#", track: "|", below: "v", sep: "|" },
} as const

export type Glyphs = { [K in keyof (typeof GLYPH_SETS)["unicode"]]: string }

/** The `glyphs` profile choices: `auto` resolves through `resolveGlyphMode`. */
export const GLYPH_CHOICES = ["auto", "ascii", "unicode", "nerd"] as const
export type GlyphChoice = (typeof GLYPH_CHOICES)[number]
export type GlyphMode = Exclude<GlyphChoice, "auto">
type Env = Record<string, string | undefined>

const isMode = (value: string | undefined): value is GlyphMode => value === "ascii" || value === "unicode" || value === "nerd"

/**
 * What the terminal itself tells for certain: ASCII on terminals that only know it (`TERM=dumb`, the VT and Linux consoles), the
 * Nerd Font set where the terminal bundles its symbols (Ghostty, WezTerm), Unicode everywhere else. A font is never guessed.
 */
export function detectGlyphMode(env: Env): GlyphMode {
  const term = (env.TERM ?? "").toLowerCase()
  if (term === "dumb" || term === "linux" || term === "ansi" || /^vt\d+/.test(term)) return "ascii"
  const program = (env.TERM_PROGRAM ?? "").toLowerCase()
  if (program === "ghostty" || term === "xterm-ghostty" || program === "wezterm") return "nerd"
  return "unicode"
}

/**
 * The one place the glyph set is decided, in order: `MENDCODE_GLYPHS` for this run, the profile's `glyphs` when it is not `auto`,
 * then what the terminal tells (`detectGlyphMode`).
 */
export function resolveGlyphMode({ choice, env }: { choice: GlyphChoice | undefined; env: Env }): GlyphMode {
  if (isMode(env.MENDCODE_GLYPHS)) return env.MENDCODE_GLYPHS
  if (choice && choice !== "auto") return choice
  return detectGlyphMode(env)
}

/** The mode the running app resolved (`setGlyphMode`); views that are not handed a glyph set read it. */
let currentMode: GlyphMode = "unicode"
export function setGlyphMode(mode: GlyphMode) {
  currentMode = mode
}

export function glyphMode(env: Env = process.env): GlyphMode {
  return isMode(env.MENDCODE_GLYPHS) ? env.MENDCODE_GLYPHS : currentMode
}

export const glyphSet = (mode: GlyphMode): Glyphs => GLYPH_SETS[mode]

/** The mode a glyph set belongs to (a caller's pinned set), Unicode for a set of its own. */
export const glyphModeOf = (set: Glyphs): GlyphMode => (["ascii", "nerd"] as const).find((mode) => GLYPH_SETS[mode].user === set.user) ?? "unicode"

/** The running app's set; with an `env` given, only what that environment names (`MENDCODE_GLYPHS`), else Unicode. */
export function glyphs(env?: Env): Glyphs {
  if (!env) return GLYPH_SETS[glyphMode()]
  return GLYPH_SETS[isMode(env.MENDCODE_GLYPHS) ? env.MENDCODE_GLYPHS : "unicode"]
}

/** Whether marks are drawn in ASCII (the resolved mode, or `MENDCODE_GLYPHS=ascii`). */
export const asciiGlyphs = (env: Env = process.env) => glyphMode(env) === "ascii"

export function colorDepth(env: Record<string, string | undefined> = process.env): "truecolor" | "256" {
  const value = (env.COLORTERM ?? "").toLowerCase()
  return value === "truecolor" || value === "24bit" ? "truecolor" : "256"
}

function to256(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  // xterm's cube levels are 0, 95, 135, 175, 215, 255: 255 is level 5 (rounding put it at 6, a different color).
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)))
  return 16 + 36 * level(r!) + 6 * level(g!) + level(b!)
}

/** A valid #rgb / #rrggbb as #rrggbb; anything else is ignored. */
function hexColor(value: string | undefined) {
  return value && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value.replace(/^#(.)(.)(.)$/, "#$1$1$2$2$3$3") : undefined
}

// Content swatches/pixels also obey terminal mode. RGB is quantized, never emitted.
const ANSI_RGB = ["000000", "800000", "008000", "808000", "000080", "800080", "008080", "c0c0c0", "808080", "ff0000", "00ff00", "ffff00", "0000ff", "ff00ff", "00ffff", "ffffff"]
function nearestAnsi(hex: string) {
  const channels = (value: string) => [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16))
  const rgb = channels(hex.slice(1))
  const distances = ANSI_RGB.map((value) => channels(value).reduce((sum, c, i) => sum + (c - rgb[i]!) ** 2, 0))
  return distances.indexOf(Math.min(...distances))
}

/** How far a dimmed colour moves toward the theme's background. */
const DIM_MIX = 0.4
/** `hex` moved `DIM_MIX` of the way to the theme's background: the dim of a coloured span, computed here. */
function dimmed(hex: string) {
  const channels = (value: string) => [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16))
  const [from, to] = [channels(hex), channels(active.colors.background)]
  return `#${from.map((value, i) => Math.round(value + (to[i]! - value) * DIM_MIX).toString(16).padStart(2, "0")).join("")}`
}

export function sgr(span: Span, depth: "truecolor" | "256") {
  const codes: string[] = []
  if (span.bold) codes.push("1")
  // A coloured span is dimmed in its colour, not with SGR 2: terminals disagree on SGR 2 over an RGB colour (one drew a black box behind
  // the text on a transparent background). SGR 2 stays for the ANSI palette and for text in the terminal's own colour.
  const ownDim = span.dim && !active.ansi && (hexColor(span.fgHex) !== undefined || span.fg !== undefined)
  if (span.dim && !ownDim) codes.push("2")
  if (span.italic) codes.push("3")
  if (span.underline) codes.push("4")
  if (span.strike) codes.push("9")
  const color = (layer: 38 | 48, hex: string, role?: ColorName, custom = false) => {
    if (active.ansi) {
      const index = !custom && role ? active.ansi[role] : nearestAnsi(hex)
      return index === "default" ? String(layer === 38 ? 39 : 49) : String((layer === 38 ? index < 8 ? 30 : 90 : index < 8 ? 40 : 100) + index % 8)
    }
    return depth === "truecolor" ? `${layer};2;${Number.parseInt(hex.slice(1, 3), 16)};${Number.parseInt(hex.slice(3, 5), 16)};${Number.parseInt(hex.slice(5, 7), 16)}` : `${layer};5;${to256(hex)}`
  }
  const custom = hexColor(span.fgHex)
  if (custom || span.fg) {
    const hex = custom ?? overrides[span.fg!] ?? active.colors[span.fg!]
    codes.push(color(38, ownDim ? dimmed(hex) : hex, span.fg, !!custom || (!!overrides[span.fg!] && !active.ansi)))
  }
  const customBg = hexColor(span.bgHex)
  if (customBg || span.bg) codes.push(color(48, customBg ?? active.colors[span.bg!], span.bg, !!customBg))
  return codes.length ? `\x1b[${codes.join(";")}m` : ""
}
