import { adaptiveBounds, isTimeZone, type LoopTrigger } from "@mendcode/protocol"

/** What a run that found nothing does to an adaptive interval (x2) and what one that acted does (/2). */
const BACKOFF_FACTOR = 2
const DAY_MS = 86_400_000

type AdaptiveTrigger = Extract<LoopTrigger, { kind: "adaptive" }>

/** The interval an adaptive loop's next wakeup uses, kept inside the trigger's bounds. */
export function adaptiveInterval(trigger: AdaptiveTrigger, current: number | undefined): number {
  const { minMs, maxMs } = adaptiveBounds(trigger)
  return Math.min(maxMs, Math.max(minMs, current ?? trigger.everyMs))
}

/**
 * The adaptive interval after a run: nothing found backs off (x2, up to `maxMs`), something done speeds up (/2, down to
 * `minMs`), anything else (no activity reported, a failed run) keeps the pace.
 */
export function paceAfter(trigger: AdaptiveTrigger, current: number | undefined, activity: "idle" | "acted" | undefined): number {
  const now = adaptiveInterval(trigger, current)
  if (activity === "idle") return adaptiveInterval(trigger, Math.round(now * BACKOFF_FACTOR))
  if (activity === "acted") return adaptiveInterval(trigger, Math.round(now / BACKOFF_FACTOR))
  return now
}

/**
 * Next wakeup after `from`. Manual and external loops never wake by themselves. Daily times are wall-clock in the
 * trigger's time zone (local when it has none); a missed daily window is not caught up (the next one is today's time if
 * still ahead, else tomorrow's). Adaptive loops use `adaptiveMs` (their current pace), else their starting interval.
 */
export function nextWake(trigger: LoopTrigger, from: number, pace?: { adaptiveMs?: number | undefined }): number | undefined {
  if (trigger.kind === "manual" || trigger.kind === "external") return undefined
  if (trigger.kind === "interval") return from + trigger.everyMs
  if (trigger.kind === "adaptive") return from + adaptiveInterval(trigger, pace?.adaptiveMs)
  const [hours, minutes] = trigger.at.split(":").map(Number) as [number, number]
  if (trigger.timezone) return nextDailyInZone({ hours, minutes, timeZone: trigger.timezone, from })
  const candidate = new Date(from)
  candidate.setHours(hours, minutes, 0, 0)
  if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1)
  return candidate.getTime()
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>()
function zoneFormat(timeZone: string) {
  let format = zoneFormats.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    zoneFormats.set(timeZone, format)
  }
  return format
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number }

/** The wall-clock reading of an instant in a zone. */
function wallIn(timeZone: string, instant: number): Wall & { second: number } {
  const parts: Record<string, number> = {}
  for (const part of zoneFormat(timeZone).formatToParts(new Date(instant))) if (part.type !== "literal") parts[part.type] = Number(part.value)
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! }
}

/** Offset of a zone from UTC at an instant, in ms (east positive). */
function offsetAt(timeZone: string, instant: number): number {
  const wall = wallIn(timeZone, instant)
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(instant / 1000) * 1000
}

/**
 * The instant a wall-clock time happens in a zone. A time that happens twice (clocks going back) is the earlier one;
 * a time that does not exist (clocks going forward) happens at the offset before the gap, so it lands past it (02:30 → 03:30).
 */
function instantOf(timeZone: string, wall: Wall): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  const before = offsetAt(timeZone, naive - DAY_MS)
  const after = offsetAt(timeZone, naive + DAY_MS)
  const valid = [...new Set([before, after])].map((offset) => naive - offset).filter((instant) => offsetAt(timeZone, instant) === naive - instant)
  return valid.length > 0 ? Math.min(...valid) : naive - before
}

function nextDailyInZone(input: { hours: number; minutes: number; timeZone: string; from: number }): number {
  const { hours, minutes, timeZone, from } = input
  const today = wallIn(timeZone, from)
  for (let ahead = 0; ahead <= 2; ahead++) {
    // Calendar arithmetic on the date alone (UTC is only a calendar here), so a day is never 23 or 25 hours long.
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + ahead))
    const instant = instantOf(timeZone, { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: hours, minute: minutes })
    if (instant > from) return instant
  }
  return from + DAY_MS
}

function unitMs(unit: string) {
  return unit === "h" ? 3_600_000 : unit === "d" ? DAY_MS : 60_000
}

/**
 * "every 30m", "every 2h", "daily 09:00", "daily 09:00 Europe/Madrid", "adaptive 30m", "adaptive 30m 5m..4h", "external",
 * "manual" → trigger; undefined when it does not parse.
 */
export function parseTrigger(text: string): LoopTrigger | undefined {
  const value = text.trim()
  const lower = value.toLowerCase()
  if (lower === "manual") return { kind: "manual" }
  if (lower === "external") return { kind: "external" }
  const every = /^every\s+(\d+)\s*(m|min|h|d)$/.exec(lower)
  if (every) {
    const everyMs = Number(every[1]) * unitMs(every[2]!)
    return everyMs >= 60_000 ? { kind: "interval", everyMs } : undefined
  }
  const daily = /^daily\s+([01]\d|2[0-3]):([0-5]\d)(?:\s+(\S+))?$/i.exec(value)
  if (daily) {
    const timezone = daily[3]
    if (timezone && !isTimeZone(timezone)) return undefined
    return { kind: "daily", at: `${daily[1]}:${daily[2]}`, ...(timezone ? { timezone } : {}) }
  }
  const adaptive = /^adaptive\s+(\d+)\s*(m|min|h|d)(?:\s+(\d+)\s*(m|min|h|d)\s*\.\.\s*(\d+)\s*(m|min|h|d))?$/.exec(lower)
  if (adaptive) {
    const everyMs = Number(adaptive[1]) * unitMs(adaptive[2]!)
    const bounds = adaptive[3] ? { minMs: Number(adaptive[3]) * unitMs(adaptive[4]!), maxMs: Number(adaptive[5]) * unitMs(adaptive[6]!) } : {}
    const { minMs, maxMs } = adaptiveBounds({ everyMs, ...bounds })
    return everyMs >= 60_000 && minMs >= 60_000 && minMs <= everyMs && everyMs <= maxMs && maxMs <= 30 * DAY_MS ? { kind: "adaptive", everyMs, ...bounds } : undefined
  }
  return undefined
}

function describeSpan(ms: number) {
  const minutes = ms / 60_000
  return minutes % 1_440 === 0 ? `${minutes / 1_440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`
}

export function describeTrigger(trigger: LoopTrigger) {
  if (trigger.kind === "manual" || trigger.kind === "external") return trigger.kind
  if (trigger.kind === "daily") return `daily ${trigger.at}${trigger.timezone ? ` ${trigger.timezone}` : ""}`
  if (trigger.kind === "adaptive") {
    const { minMs, maxMs } = adaptiveBounds(trigger)
    return `adaptive ${describeSpan(trigger.everyMs)} (${describeSpan(minMs)}..${describeSpan(maxMs)})`
  }
  return `every ${describeSpan(trigger.everyMs)}`
}
