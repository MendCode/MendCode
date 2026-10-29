import type { UsageDay } from "@mendcode/protocol"
import { activeTheme, type ColorName, type Line, type Span } from "../ui/theme"

/**
 * The token-activity grid of /usage: a GitHub-style calendar (Monday-first weeks, `■` cells, a 5-step
 * ramp from the theme's border color to its primary color) in `daily` mode, or weekly / running-total
 * bars in `weekly` / `cumulative` mode, topped with month labels and followed by a Less → More legend.
 */

export type HeatMode = "daily" | "weekly" | "cumulative"
export type Bounds = { from: string; to: string }

const DAY_MS = 86_400_000
const LABEL_WIDTH = 4
const CELL_WIDTH = 2
const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
/** Share of the way from border to primary for levels 0 (no usage) … 4 (top quartile). */
const RAMP = [0, 0.3, 0.55, 0.8, 1]
const BAR_ROWS = 7

export function toMs(day: string) {
  const [year, month, date] = day.split("-").map(Number)
  return Date.UTC(year!, month! - 1, date!)
}

export function toDay(ms: number) {
  return new Date(ms).toISOString().slice(0, 10)
}

export function addDays(day: string, count: number) {
  return toDay(toMs(day) + count * DAY_MS)
}

/** Monday = 0 .. Sunday = 6. */
function weekdayIndex(day: string) {
  return (new Date(toMs(day)).getUTCDay() + 6) % 7
}

export function clampDay(day: string, bounds: Bounds) {
  return day < bounds.from ? bounds.from : day > bounds.to ? bounds.to : day
}

export const dayTokens = (day: UsageDay) => day.input + day.output + day.reasoning + day.cacheRead + day.cacheWrite

export function emptyDay(day: string): UsageDay {
  return { day, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costMicros: 0, costUnknownCalls: 0, calls: 0, sessions: 0 }
}

/** Merges sparse, unsorted, possibly repeated days into one entry per day inside the bounds. */
export function indexDays(days: UsageDay[], bounds: Bounds) {
  const byDay = new Map<string, UsageDay>()
  for (const day of days) {
    if (day.day < bounds.from || day.day > bounds.to) continue
    const previous = byDay.get(day.day)
    byDay.set(
      day.day,
      previous
        ? {
            day: day.day,
            input: previous.input + day.input,
            output: previous.output + day.output,
            reasoning: previous.reasoning + day.reasoning,
            cacheRead: previous.cacheRead + day.cacheRead,
            cacheWrite: previous.cacheWrite + day.cacheWrite,
            costMicros: previous.costMicros + day.costMicros,
            costUnknownCalls: previous.costUnknownCalls + day.costUnknownCalls,
            calls: previous.calls + day.calls,
            sessions: previous.sessions + day.sessions,
          }
        : day,
    )
  }
  return byDay
}

/** The 25th, 50th and 75th percentile of the non-zero values (GitHub-style quartiles). */
export function quartiles(values: number[]): [number, number, number] {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b)
  const at = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0
  return [at(0.25), at(0.5), at(0.75)]
}

/** 0 = no usage, then 1..4 by quartile, so one outlier day does not flatten every other day to level 1. */
export function intensityLevel(value: number, [q1, q2, q3]: [number, number, number]): number {
  if (value <= 0) return 0
  if (value >= q3) return 4
  if (value >= q2) return 3
  if (value >= q1) return 2
  return 1
}

function mix(from: string, to: string, t: number) {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  return `#${[0, 1, 2].map((i) => Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * t).toString(16).padStart(2, "0")).join("")}`
}

/** A ramp cell for `level`, in the active theme's colors (content color, so `fgHex`). */
export function levelSpan(level: number, text = "■ "): Span {
  const colors = activeTheme().colors
  return { text, fgHex: mix(colors.border, colors.primary, RAMP[level] ?? 0) }
}

/** `Less ■ ■ ■ ■ ■ More`, indented under the grid. */
export function legendRow(): Line {
  return [{ text: " ".repeat(LABEL_WIDTH) }, { text: "Less ", fg: "muted" }, ...RAMP.map((_, level) => levelSpan(level)), { text: "More", fg: "muted" }]
}

/** How many Monday-start weeks fit in `width`, and which Monday the leftmost visible column starts on. */
function heatmapWindow(bounds: Bounds, width: number, selectedDay = bounds.to) {
  const firstMonday = addDays(bounds.from, -weekdayIndex(bounds.from))
  const lastMonday = addDays(bounds.to, -weekdayIndex(bounds.to))
  const totalWeeks = Math.round((toMs(lastMonday) - toMs(firstMonday)) / (7 * DAY_MS)) + 1
  const weeks = Math.max(1, Math.min(totalWeeks, Math.floor((width - LABEL_WIDTH) / CELL_WIDTH)))
  const latestStart = addDays(lastMonday, -(weeks - 1) * 7)
  const selected = clampDay(selectedDay, bounds)
  const selectedMonday = addDays(selected, -weekdayIndex(selected))
  return { weeks, start: selectedMonday < latestStart ? selectedMonday < firstMonday ? firstMonday : selectedMonday : latestStart }
}

/** Month ticks over the visible weeks, above the week that holds each month's first day. */
function monthLabelRow(input: { start: string; weeks: number; bounds: Bounds }): Line {
  const { start, weeks, bounds } = input
  const starts: { column: number; text: string }[] = []
  for (let week = 0; week < weeks; week++)
    for (let weekday = 0; weekday < 7; weekday++) {
      const day = addDays(start, week * 7 + weekday)
      if (day.endsWith("-01") && day >= bounds.from && day <= bounds.to) starts.push({ column: week, text: MONTHS[Number(day.slice(5, 7)) - 1]! })
    }
  const firstMonth = MONTHS[Number((start < bounds.from ? bounds.from : start).slice(5, 7)) - 1]!
  const candidates = starts.length && starts[0]!.column < 2 ? starts : [{ column: 0, text: firstMonth }, ...starts]
  const monthCells: string[] = new Array(weeks * CELL_WIDTH).fill(" ")
  let nextFree = 0
  for (const { column, text } of candidates) {
    const at = column * CELL_WIDTH
    if (at < nextFree || at + text.length > monthCells.length) continue
    for (let i = 0; i < text.length; i++) monthCells[at + i] = text[i]!
    nextFree = at + text.length + 1
  }
  return [{ text: " ".repeat(LABEL_WIDTH) }, { text: monthCells.join("").trimEnd(), fg: "muted" }]
}

function weekTotals(days: Map<string, UsageDay>, start: string, weeks: number, bounds: Bounds): number[] {
  const out: number[] = []
  for (let week = 0; week < weeks; week++) {
    let sum = 0
    for (let weekday = 0; weekday < 7; weekday++) {
      const day = addDays(start, week * 7 + weekday)
      if (day >= bounds.from && day <= bounds.to) sum += dayTokens(days.get(day) ?? emptyDay(day))
    }
    out.push(sum)
  }
  return out
}

/** The grid, as wide as fits in `width`; the selected day is `▣` in the warning color. */
export function activityGrid(input: { days: Map<string, UsageDay>; mode: HeatMode; selectedDay: string; bounds: Bounds; width: number }): Line[] {
  const { days, mode, selectedDay, bounds, width } = input
  const { weeks, start } = heatmapWindow(bounds, width, selectedDay)
  const rows: Line[] = [monthLabelRow({ start, weeks, bounds })]
  const inBounds = (day: string) => day >= bounds.from && day <= bounds.to

  if (mode === "daily") {
    const visible: number[] = []
    for (let i = 0; i < weeks * 7; i++) {
      const day = addDays(start, i)
      if (inBounds(day)) visible.push(dayTokens(days.get(day) ?? emptyDay(day)))
    }
    const bands = quartiles(visible)
    for (let weekday = 0; weekday < 7; weekday++) {
      const row: Line = [{ text: WEEKDAY_LABELS[weekday]!.padEnd(LABEL_WIDTH), fg: "muted" }]
      for (let week = 0; week < weeks; week++) {
        const day = addDays(start, week * 7 + weekday)
        if (!inBounds(day)) row.push({ text: "  " })
        else if (day === selectedDay) row.push({ text: "▣ ", fg: "warning", bold: true })
        else row.push(levelSpan(intensityLevel(dayTokens(days.get(day) ?? emptyDay(day)), bands)))
      }
      rows.push(row)
    }
    return rows
  }

  const weekly = weekTotals(days, start, weeks, bounds)
  const values = mode === "cumulative" ? weekly.reduce<number[]>((acc, v, i) => [...acc, (acc[i - 1] ?? 0) + v], []) : weekly
  const peak = Math.max(1, ...values)
  const barColor: ColorName = mode === "cumulative" ? "primary" : "success"
  const selectedWeek = Math.floor((toMs(clampDay(selectedDay, bounds)) - toMs(start)) / (7 * DAY_MS))
  for (let row = 0; row < BAR_ROWS; row++) {
    const line: Line = [{ text: " ".repeat(LABEL_WIDTH) }]
    for (let week = 0; week < weeks; week++) {
      const weekStart = addDays(start, week * 7)
      if (addDays(weekStart, 6) < bounds.from || weekStart > bounds.to) {
        line.push({ text: "  " })
        continue
      }
      const level = values[week]! > 0 ? Math.round((values[week]! / peak) * (BAR_ROWS - 1)) : -1
      const emptySelection = week === selectedWeek && level < 0 && row === BAR_ROWS - 1
      line.push({ text: emptySelection ? "▣ " : BAR_ROWS - 1 - row <= level ? "█ " : "  ", fg: week === selectedWeek ? "warning" : barColor, ...(emptySelection ? { bold: true } : {}) })
    }
    rows.push(line)
  }
  return rows
}
