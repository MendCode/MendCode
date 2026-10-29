import { SYSTEM_THEME, type Glyphs, type Line, type Theme } from "../ui/theme"
import type { TerminalMode } from "../ui/terminal-mode"
import { clip, panelGrid } from "./deck"
import { fuzzyScore } from "./fuzzy"
import { pickerFrame } from "./picker-frame"

export type ThemePickerState = { query: string; selected: number }
export type ThemeModeInfo = { detected: TerminalMode | undefined; locked: TerminalMode | undefined; effective: TerminalMode }
export type ThemeEntry = { name: string; hint: string }

export const createThemePickerState = (selected = 0): ThemePickerState => ({ query: "", selected })

/** `system` first (it follows the terminal), then every theme by name, filtered fuzzily when a query is typed. */
export function themeEntries(input: { themes: readonly Theme[]; query: string; mode: ThemeModeInfo }): ThemeEntry[] {
  const { themes, query, mode } = input
  const sorted = [...themes].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  const entries: ThemeEntry[] = [
    { name: SYSTEM_THEME, hint: `follows the terminal · ${mode.effective}` },
    ...sorted.map((theme): ThemeEntry => ({ name: theme.name, hint: theme.dark ? "dark" : "light" })),
  ]
  if (!query.trim()) return entries
  return entries.flatMap((entry, index) => {
    const score = fuzzyScore(query, entry.name) ?? fuzzyScore(query, `${entry.name} ${entry.hint}`)
    return score === undefined ? [] : [{ entry, score, index }]
  }).sort((a, b) => b.score - a.score || a.index - b.index).map((match) => match.entry)
}

/** Position of `name` in the unfiltered list, so the picker opens on the current choice. */
export function themeIndex(themes: readonly Theme[], name: string): number {
  return Math.max(0, themeEntries({ themes, query: "", mode: { detected: undefined, locked: undefined, effective: "dark" } }).findIndex((entry) => entry.name === name))
}

export function modeSummary(mode: ThemeModeInfo): string {
  if (mode.locked) return `mode ${mode.locked} · locked`
  return mode.detected ? `mode ${mode.detected} · from the terminal` : "mode dark · terminal not detected"
}

export function renderThemePicker(input: { state: ThemePickerState; entries: ThemeEntry[]; current: string; mode: ThemeModeInfo; width: number; height: number; glyphs: Glyphs }): Line[] {
  const { state, entries, current, mode, width, height, glyphs } = input
  const compact = width < 70
  const inner = Math.max(1, width - 2)
  const room = Math.max(1, height - 8)
  const first = Math.max(0, Math.min(state.selected - room + 1, entries.length - room))
  const filter: Line = [{ text: "filter ", fg: "muted" }, { text: state.query, fg: "text" }, { text: "▌", fg: "primary" }]
  const list = entries.length ? entries.slice(first, first + room).map((entry, index): Line => {
    const selected = first + index === state.selected
    return clip([
      { text: selected ? `${glyphs.user} ` : "  ", fg: "primary" },
      { text: entry.name, fg: selected ? "primary" : "text", bold: selected },
      ...(entry.name === current ? [{ text: " (current)", fg: "success" as const }] : []),
      ...(compact ? [] : [{ text: `  ${entry.hint}`, fg: "muted" as const }]),
    ], inner)
  }) : [[{ text: "no matching theme", fg: "muted" as const }]]
  const lock = mode.locked ? "ctrl+l unlock" : "ctrl+l lock"
  const hints = compact ? `↑↓ · enter · ${lock} · esc` : `↑↓ preview · enter apply · ${lock} · esc restore`
  return pickerFrame("Themes", hints, width, height, panelGrid({ width, compact, maxColumns: 1, padding: true, heights: [height - 2], rows: [[{ title: "Themes", body: [filter, [], ...list] }]] }), modeSummary(mode))
}
