import type { ColorName, Line } from "../ui/theme"
import { fit, lineWidth, spread } from "./deck"
import { truncateEnd } from "./session-list"

/** An open card: title and live value share a rule; a single-cell rail carries state. */
export function panelCard({ title, value = "", body, width, color = "primary", ascii = false }: { title: string; value?: string; body: Line[]; width: number; color?: ColorName; ascii?: boolean }): Line[] {
  const rule = ascii ? "-" : "─"
  const label: Line = [{ text: `${rule} ${truncateEnd(title, Math.max(1, width - value.length - 5))} `, fg: color, bold: true }]
  const live: Line = value ? [{ text: ` ${value}`, fg: color }] : []
  const gap = Math.max(0, width - lineWidth(label) - lineWidth(live))
  const heading = fit([...label, { text: rule.repeat(gap), fg: "border" }, ...live], width)
  return [heading, ...body.map((row) => [{ text: ascii ? "| " : "▏ ", fg: color }, ...fit(row, width - 2)]), fit([], width)]
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const

/**
 * A meter exactly `cells` cells wide: filled to `ratio` in eighths of a cell (so 4 and 5 of 38 differ), on a track of the
 * Block Elements family (`░`, the border role), so fill and track differ by glyph and not only by colour and the meter still reads
 * with no colour at all. A non-zero ratio always shows at least an eighth. ASCII mode fills whole cells (`#`) over `-`.
 */
export function meter({ ratio, cells, color, ascii = false }: { ratio: number; cells: number; color: ColorName; ascii?: boolean }): Line {
  const size = Math.max(0, Math.floor(cells))
  const clamped = Math.max(0, Math.min(1, ratio))
  if (ascii) {
    const filled = clamped > 0 ? Math.max(1, Math.round(clamped * size)) : 0
    return [{ text: "#".repeat(filled), fg: color }, { text: "-".repeat(size - filled), fg: "border" }]
  }
  const eighths = clamped > 0 ? Math.max(1, Math.round(clamped * size * 8)) : 0
  const whole = Math.min(size, Math.floor(eighths / 8))
  const part = whole < size ? EIGHTHS[eighths % 8]! : ""
  return [
    ...(whole ? [{ text: "█".repeat(whole), fg: color }] : []),
    ...(part ? [{ text: part, fg: color }] : []),
    ...(size - whole - (part ? 1 : 0) > 0 ? [{ text: "░".repeat(size - whole - (part ? 1 : 0)), fg: "border" as const }] : []),
  ]
}

/** Two aligned facts; each half truncates independently. */
export function facts(left: string, right: string, width: number): Line {
  const half = Math.max(1, Math.floor((width - 2) / 2))
  return fit([...fit([{ text: left, fg: "text" }], half), { text: "  " }, ...fit([{ text: right, fg: "text" }], width - half - 2)], width)
}

export function labelValue(label: string, value: string, width: number): Line {
  return fit(spread([{ text: truncateEnd(label, Math.max(1, width - value.length - 1)), fg: "text" }], [{ text: value, fg: "muted" }], width), width)
}

export function sparkline(values: readonly number[], width: number, ascii = false): string {
  const size = Math.max(0, Math.floor(width))
  if (!size) return ""
  const samples = values.filter((value) => Number.isFinite(value)).slice(-size)
  if (!samples.length) return "unavailable"
  const max = Math.max(1, ...samples)
  const levels = ascii ? "._-~=+*#" : "▁▂▃▄▅▆▇█"
  return Array.from({ length: size }, (_, index) => {
    const at = size === 1 ? samples.length - 1 : index * (samples.length - 1) / (size - 1)
    const lo = Math.floor(at), fraction = at - lo
    const value = samples[lo]! * (1 - fraction) + samples[Math.min(samples.length - 1, lo + 1)]! * fraction
    return levels[Math.min(7, Math.max(0, Math.round(value / max * 7)))]
  }).join("")
}

/** Samples stretch across the card; the zero baseline and observed range make sparse histories readable. */
export function sparkRows(label: string, values: readonly number[], width: number, format: (value: number) => string, ascii = false, color: ColorName = "primary"): Line[] {
  const samples = values.filter(Number.isFinite)
  if (!samples.length) return [fit([{ text: `${label} unavailable`, fg: "muted" }], width)]
  return [
    labelValue(label, `min ${format(Math.min(...samples))} · max ${format(Math.max(...samples))}`, width),
    fit([{ text: sparkline(samples, width, ascii), fg: color }], width),
    fit([{ text: ascii ? "-".repeat(Math.max(0, width)) : width < 2 ? "─" : `└${"─".repeat(width - 2)}┘`, fg: "border", dim: true }], width),
  ]
}
