import { activeTheme } from "../ui/theme"
import type { ColorName, Line, Span } from "../ui/theme"
import { PROMPT_MARGIN } from "./prompt-chrome"
import { lineWidth as widthOf } from "./wrap"

/** Foreground for text drawn on a filled background role: v1's `selectedForeground`, the theme's own background. */
export function onColor(bg: ColorName): { bg: ColorName; fgHex: string } {
  return { bg, fgHex: activeTheme().background }
}

/**
 * One row of a docked box above the prompt: the prompt's margin, a `┃` rail, the content, all on the
 * panel fill out to the right margin. Spans that set their own `bg` (diff rows, chips, the selected
 * option) keep it.
 */
export function boxRow({ line, width, rail, fill = "panel" }: { line: Line; width: number; rail: ColorName; fill?: ColorName }): Line {
  const inner = width - PROMPT_MARGIN * 2 - 1
  const spans: Span[] = line.map((span) => (span.bg ? span : { ...span, bg: fill }))
  const used = widthOf(line)
  return [
    { text: " ".repeat(PROMPT_MARGIN) },
    { text: "┃", fg: rail, bg: fill },
    ...spans,
    ...(used < inner ? [{ text: " ".repeat(inner - used), bg: fill } as Span] : []),
  ]
}

export { widthOf as lineWidth }
