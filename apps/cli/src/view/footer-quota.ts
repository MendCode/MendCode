import type { GlobalEvent } from "@mendcode/protocol"
import { quotaReadings, shortSpan, type QuotaReading } from "@mendcode/protocol/wire"
import type { ColorName, Glyphs, Span } from "../ui/theme"
import { isCompact } from "../ui/breakpoints"

type Quota = Extract<GlobalEvent, { type: "quota.snapshot" }>

/** How the `quota` segment draws: what is spent (`used`) or what is left, in pressure colours or the theme's primary. */
export type QuotaStyle = { view: "used" | "left"; color: "pressure" | "accent" }

/** The windows a named provider is known to have, longest first; one it did not report is drawn as `n/a`, never as 0 or 100. */
const KNOWN_WINDOWS: Readonly<Record<string, readonly string[]>> = { codex: ["7d", "5h"], claude: ["7d", "5h"] }

const pressureColor = (percent: number, warnAt: number, errorAt: number): ColorName => (percent >= errorAt ? "error" : percent >= warnAt ? "warning" : "success")

/** One unit, as short as it reads: `2d`, `3h`, `40m`. A stale reading is dated with it (`62% left ~2d`). */
export function ageSpan(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000))
  if (minutes >= 1_440) return `${Math.floor(minutes / 1_440)}d`
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h`
  return `${minutes}m`
}

/** A window whose reset time has passed describes a window that no longer exists: its number means nothing. */
export const windowEnded = (reading: QuotaReading, now: number) => reading.resetsAt !== undefined && reading.resetsAt <= now

/**
 * One window. Fresh: `7d ███████░ 92% left resets 5d11h`. A stale reading inside a live window keeps its number, dimmed, with its
 * age (`7d ███████░ 62% left ~2d`). A window that has reset, or one never reported, is `7d n/a`.
 */
function windowSpans({ reading, label, style, glyphs, now, compact }: { reading: QuotaReading | undefined; label: string; style: QuotaStyle; glyphs: Glyphs; now: number; compact: boolean }): Span[] {
  if (!reading || windowEnded(reading, now)) return [{ text: `${label} n/a`, fg: "muted" }]
  const shown = style.view === "left" ? reading.leftPercent : reading.usedPercent
  const color: ColorName = reading.stale ? "muted" : style.color === "accent" ? "primary" : pressureColor(reading.usedPercent, 70, 90)
  const left: Span[] = style.view === "left" ? [{ text: " left", fg: "muted" }] : []
  const age: Span[] = reading.stale ? [{ text: ` ~${ageSpan(reading.ageMs)}`, fg: "muted" }] : []
  if (compact) return [{ text: `${reading.window} ${shown}%`, fg: color }, ...left, ...age]
  const filled = Math.round((shown / 100) * 8)
  const spans: Span[] = [{ text: `${reading.window} `, fg: "muted" }, { text: glyphs.barFull.repeat(filled), fg: color }, { text: glyphs.barEmpty.repeat(8 - filled), fg: "border" }, { text: ` ${shown}%`, fg: color }, ...left, ...age]
  if (!reading.stale && reading.resetsAt !== undefined) spans.push({ text: ` ${glyphs.reset}${shortSpan(reading.resetsAt - now)}`, fg: "muted" })
  return spans
}

/**
 * Every provider's windows (`quota`), or one provider's (`quota:codex`, with `only`): the label, then each window. The bare segment keeps
 * the lowercase label and a space between windows; a named provider has its label in capitals and the separator between windows,
 * always lists the windows it is known to have (`7d`, `5h`) and says `n/a` for one it has no reading for.
 */
export function quotaSegmentSpans({ quotas, now, style, glyphs, width, only, separator = " · " }: { quotas: readonly Quota[]; now: number; style: QuotaStyle; glyphs: Glyphs; width: number; only?: string; separator?: string }): Span[] {
  const compact = isCompact(width)
  if (only !== undefined) return namedProvider({ quota: quotas.find((entry) => entry.provider === only), provider: only, now, style, glyphs, compact, separator })
  const spans: Span[] = []
  quotas.forEach((quota, index) => {
    if (index) spans.push({ text: "  " })
    spans.push({ text: `${quota.provider} `, fg: "muted" })
    if (!quota.windows.length) {
      spans.push({ text: "quota unknown", fg: "muted" })
      return
    }
    quotaReadings([quota], now).forEach((reading, at) => {
      if (at) spans.push({ text: " " })
      spans.push(...windowSpans({ reading, label: reading.window, style, glyphs, now, compact }))
    })
  })
  return spans
}

function namedProvider({ quota, provider, now, style, glyphs, compact, separator }: { quota: Quota | undefined; provider: string; now: number; style: QuotaStyle; glyphs: Glyphs; compact: boolean; separator: string }): Span[] {
  const label: Span = { text: `${provider.toUpperCase()} `, fg: "text", bold: true }
  const readings = quota ? quotaReadings([quota], now) : []
  const known = KNOWN_WINDOWS[provider] ?? []
  const labels = [...known, ...readings.map((reading) => reading.window).filter((window) => !known.includes(window))]
  if (labels.length === 0) return [label, { text: "n/a", fg: "muted" }]
  const spans: Span[] = [label]
  labels.forEach((window, index) => {
    if (index) spans.push({ text: separator, fg: "muted" })
    spans.push(...windowSpans({ reading: readings.find((reading) => reading.window === window), label: window, style, glyphs, now, compact }))
  })
  return spans
}

/**
 * The quota windows as plain text for the status items (`statusLeft` / `statusRight`): `codex 7d 92% left · resets 5d11h`; a stale
 * reading carries its age (`codex 7d 98% left ~3h`), a window that has reset is `codex 5h n/a`; undefined when nothing arrived.
 */
export function quotaText({ quotas, now, view = "used" }: { quotas: readonly Quota[]; now: number; view?: "used" | "left" }): string | undefined {
  const parts = quotas.flatMap((quota) => quota.windows.length ? quotaReadings([quota], now).map((reading) => {
    if (windowEnded(reading, now)) return `${reading.provider} ${reading.window} n/a`
    const figure = view === "left" ? `${reading.leftPercent}% left` : `${reading.usedPercent}% used`
    const note = reading.stale ? ` ~${ageSpan(reading.ageMs)}` : reading.resetsAt !== undefined ? ` · resets ${shortSpan(reading.resetsAt - now)}` : ""
    return `${reading.provider} ${reading.window} ${figure}${note}`
  }) : [`${quota.provider} quota unknown`])
  return parts.length ? parts.join("  ") : undefined
}
