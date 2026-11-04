import { mix } from "../themes"
import { activeTheme, type ColorName, type Line, type Span } from "../ui/theme"
import { clip, lineWidth } from "./deck"
import type { PromptFrame } from "./prompt-chrome"
import { truncateEnd } from "./wrap"

/**
 * What tells the reader they are inside a sub-agent and not in the conversation, in every tier: one context line, the prompt
 * wearing the sub-agent's colour, and the open row of the Agents strip filled. Pure; the chat decides when they apply.
 */

/**
 * The line that names where the reader is: `◆ name · state · of <parent>` on the left, the keys back on the right. Exactly `width`
 * cells after `inset`. The name and the keys stay; the parent, then the state, give way first on a narrow terminal.
 */
export function agentContextLine(input: { name: string; color: ColorName; state?: Span; parent: string; hints: readonly string[]; width: number; inset: number; sep: string }): Line {
  const room = Math.max(1, input.width - input.inset * 2)
  const pad: Span = { text: " ".repeat(input.inset) }
  const fact = (span: Span): Span[] => [{ text: ` ${input.sep} `, fg: "muted" }, span]
  const parent: Span = { text: `of ${input.parent}`, fg: "muted" }
  const lead: Span = { text: "◆ ", fg: input.color }
  const full = (line: Line): Line => {
    const fitted = clip(line, room)
    return [pad, ...fitted, { text: " ".repeat(Math.max(0, room - lineWidth(fitted))) }]
  }
  const name = (cells: number): Span => ({ text: truncateEnd(input.name, Math.max(1, cells)), fg: input.color, bold: true })
  // The richest form that fits: the fullest left side first, each with the longest keys that leave it room. The keys are the last to go.
  const hints = input.hints.map((text): Span => ({ text, fg: "muted" }))
  const lefts: Span[][] = [
    ...(input.state ? [[lead, name(room), ...fact(input.state), ...fact(parent)], [lead, name(room), ...fact(input.state)]] : [[lead, name(room), ...fact(parent)]]),
    [lead, name(room)],
  ]
  for (const left of lefts) for (const hint of hints) {
    if (lineWidth(left) + 2 + lineWidth([hint]) <= room) return full([...left, { text: " ".repeat(room - lineWidth(left) - lineWidth([hint])) }, hint])
  }
  // Too narrow for any keys beside the name: the name gives way, then the shortest keys stand alone after it.
  const shortest = hints.at(-1)
  const keysRoom = shortest ? lineWidth([shortest]) + 2 : 0
  return full([lead, name(room - 2 - keysRoom), ...(shortest ? [{ text: "  " }, shortest] : [])])
}

/** `line` with the prompt's own border colour and lead glyph in the sub-agent's colour. */
function tint(line: Line, color: ColorName, lead: string): Line {
  return line.map((span) => (span.fg === "primary" ? { ...span, fg: color } : span.fg === "muted" && span.text === `${lead} ` ? { ...span, fg: color, bold: true } : span))
}

/** The prompt's rules (or box) and lead in the colour of the sub-agent being read, so the input never looks like the conversation's. */
export function tintFrame(frame: PromptFrame, color: ColorName, lead: string): PromptFrame {
  return { ...frame, top: frame.top.map((line) => tint(line, color, lead)), bottom: frame.bottom.map((line) => tint(line, color, lead)), row: (line) => tint(frame.row(line), color, lead) }
}

/**
 * The empty prompt's hint: whom a message goes to. A child session takes it itself; an engine's thread is read-only, so what is
 * typed there goes to the session, and it says so rather than naming the sub-agent.
 */
export function cuePlaceholder(input: { kind: "thread" | "child"; name: string; sep: string; width: number }): string {
  const room = Math.max(8, input.width)
  return input.kind === "child" ? truncateEnd(`message ${input.name}`, room) : truncateEnd(`read-only thread ${input.sep} messages go to the session`, room)
}

let fill: { theme: string; background: string; text: string; hex: string } | undefined

/**
 * The open row's fill: a tenth of the way from the theme's background to its text, so it reads on every theme, light or dark (the
 * themes' own `element` role is near-invisible in a few). Kept per theme, so a frame computes it once.
 */
export function openRowFill(): string {
  const theme = activeTheme()
  const text = theme.colors.text
  if (fill?.theme !== theme.name || fill.background !== theme.background || fill.text !== text) fill = { theme: theme.name, background: theme.background, text, hex: mix(theme.background, text, 0.1) }
  return fill.hex
}

/** The Agents strip's row of the sub-agent being read: filled across its width; a theme drawn with the terminal's own palette has no fill to give, so it underlines the name. */
export function markOpenRow(line: Line): Line {
  if (activeTheme().ansi) return line.map((span) => (span.bold && !span.underline ? { ...span, underline: true } : span))
  const hex = openRowFill()
  return line.map((span) => (span.bg || span.bgHex ? span : { ...span, bgHex: hex }))
}
