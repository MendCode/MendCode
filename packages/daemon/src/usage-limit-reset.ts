import type { GlobalEvent } from "@mendcode/protocol"
import { quotaFresh } from "@mendcode/protocol/wire"

type QuotaSnapshot = Extract<GlobalEvent, { type: "quota.snapshot" }>

const DAY_MS = 86_400_000
/** A reset further away than this is not a usage window (the longest provider window is 7 days). */
const MAX_WAIT_MS = 31 * DAY_MS
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

/** The instant a wall-clock time `y-m-d hh:mm` is, in `zone` (the daemon's own zone when absent); undefined for an unknown zone. */
function wallClock(parts: { year: number; month: number; day: number; hour: number; minute: number }, zone: string | undefined): number | undefined {
  const { year, month, day, hour, minute } = parts
  if (!zone) return new Date(year, month, day, hour, minute).getTime()
  try {
    const format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    const offset = (at: number) => {
      const found = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]))
      return Date.UTC(Number(found.year), Number(found.month) - 1, Number(found.day), Number(found.hour), Number(found.minute), Number(found.second)) - Math.floor(at / 1000) * 1000
    }
    const guess = Date.UTC(year, month, day, hour, minute)
    return guess - offset(guess - offset(guess))
  } catch {
    return undefined
  }
}

/** The calendar day it is now in `zone`. */
function today(now: number, zone: string | undefined): { year: number; month: number; day: number } | undefined {
  if (!zone) {
    const date = new Date(now)
    return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() }
  }
  try {
    const found = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now).map((part) => [part.type, part.value]))
    return { year: Number(found.year), month: Number(found.month) - 1, day: Number(found.day) }
  } catch {
    return undefined
  }
}

/** `resets 2am`, `resets at 2:10 PM (America/Panama)`, `resets Oct 9, 9am`: the next time that wall clock shows. */
function clockReset(message: string, now: number): number | undefined {
  const match = /\bresets?\s+(?:at\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i.exec(message)
  if (!match) return undefined
  const [, monthName, dayText, hourText, minuteText, meridiem, zone] = match
  const hour12 = Number(hourText)
  const minute = minuteText ? Number(minuteText) : 0
  if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined
  const hour = (hour12 % 12) + (meridiem!.toLowerCase() === "p" ? 12 : 0)
  const base = today(now, zone)
  if (!base) return undefined
  if (monthName) {
    const month = MONTHS.indexOf(monthName.toLowerCase())
    if (month < 0) return undefined
    for (const year of [base.year, base.year + 1]) {
      const at = wallClock({ year, month, day: Number(dayText), hour, minute }, zone)
      if (at !== undefined && at > now) return at
    }
    return undefined
  }
  for (const offset of [0, 1]) {
    const at = wallClock({ ...base, day: base.day + offset, hour, minute }, zone)
    if (at !== undefined && at > now) return at
  }
  return undefined
}

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: DAY_MS }

/** `in 3h 20m`, `after 30 minutes`, `1 hour 5 minutes`: a wait the provider names. */
function durationReset(message: string, now: number): number | undefined {
  const lead = /\b(?:try again|retry|resets?|available again|wait)\b[^.\n]{0,24}?\b(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(message)
  if (!lead) return undefined
  let total = 0
  for (const part of lead[1]!.matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) total += Number(part[1]) * UNIT_MS[part[2]![0]!.toLowerCase()]!
  return total > 0 ? now + Math.round(total) : undefined
}

/** `"resets_at": 1759500000`, `resets_in_seconds`, `resetsAt`, a trailing `|1759500000` (Claude's older wording). */
function numericReset(message: string, now: number): number | undefined {
  const at = /\bresets?_?at"?\s*[:=]\s*"?(\d{9,13})\b/i.exec(message) ?? /\bresetsAt"?\s*[:=]\s*"?(\d{9,13})\b/.exec(message) ?? /limit reached\s*\|\s*(\d{9,13})\b/i.exec(message)
  if (at) {
    const value = Number(at[1])
    return value < 1e12 ? value * 1_000 : value
  }
  const seconds = /\bresets?_?in_?seconds"?\s*[:=]\s*"?(\d+(?:\.\d+)?)/i.exec(message)
  return seconds ? now + Math.round(Number(seconds[1]) * 1_000) : undefined
}

/**
 * When the usage window a failure message talks about resets (ms since epoch), or undefined when it does not say or
 * the time is not a plausible future one. Reads what Codex, Claude and the HTTP quota bodies say; the time zone of a
 * clock time is the one in parentheses, else the daemon's own.
 */
export function parseResetTime(message: string, now: number): number | undefined {
  const found = numericReset(message, now) ?? clockReset(message, now) ?? durationReset(message, now)
  return found !== undefined && found > now && found - now <= MAX_WAIT_MS ? found : undefined
}

/**
 * The reset of the window a provider reports as spent, from the quota snapshots the daemon already tracks: the
 * window at 100% (every spent window must reset, so the latest one counts), among the providers whose snapshot says
 * `rejected` or has such a window. `preferred` (the provider the failing turn used) wins when it has one.
 */
export function exhaustedReset(snapshots: readonly QuotaSnapshot[], now: number, preferred?: string): number | undefined {
  const candidates = snapshots.flatMap((snapshot) => {
    if (!quotaFresh(snapshot.fetchedAt, now)) return []
    const spent = snapshot.windows.filter((window) => window.usedPercent >= 99.5 && window.resetsAt !== undefined && window.resetsAt > now)
    if (!spent.length) return []
    return [{ provider: snapshot.provider.toLowerCase(), fetchedAt: snapshot.fetchedAt, resetsAt: Math.max(...spent.map((window) => window.resetsAt!)) }]
  })
  const wanted = preferred?.toLowerCase()
  const pool = wanted ? candidates.filter((candidate) => wanted.includes(candidate.provider) || candidate.provider.includes(wanted)) : []
  const chosen = (wanted ? pool : candidates).toSorted((a, b) => b.fetchedAt - a.fetchedAt)[0]
  return chosen && chosen.resetsAt - now <= MAX_WAIT_MS ? chosen.resetsAt : undefined
}
