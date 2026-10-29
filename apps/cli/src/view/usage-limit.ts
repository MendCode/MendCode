import type { ColorName, Glyphs, Line, Span } from "../ui/theme"
import { titledRule } from "./chat-blocks"
import { fit, panelGrid, spread } from "./deck"
import { wrapSpans } from "./markdown"
import { onColor } from "./panel-box"
import { truncateEnd } from "./session-list"

/**
 * A turn paused by the provider's usage limit (docs/usage-limit.md) in the terminal: the transcript notice, the bar
 * above the prompt with Resume at reset and Snooze until reset, and the `/limit` command. Pure: the last `usage.limit`
 * event and a clock in, styled rows out.
 */

const INDENT = "  "

export type LimitState = "paused" | "scheduled" | "snoozed" | "ready" | "resumed" | "cleared"
export type LimitAction = "schedule" | "cancel" | "snooze" | "resume" | "dismiss"
/** The last `usage.limit` event of a session while its pause is open. */
export type UsageLimitView = { state: "paused" | "scheduled" | "snoozed" | "ready"; provider?: string; message: string; resetsAt?: number; turnId?: string; at: number }
export type LimitCard = { state: "paused" | "scheduled" | "resumed"; provider?: string; resetsAt?: number; message: string; at: number }

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" })
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" })

/** `2:10 AM` for today, `Oct 9, 2:10 AM` for another day. */
export function resetClock(resetsAt: number, now: number): string {
  const date = new Date(resetsAt)
  const time = TIME.format(date).replace(/[  ]/g, " ")
  return date.toDateString() === new Date(now).toDateString() ? time : `${DAY.format(date)}, ${time}`
}

/** `3h 12m`, `45m`, `now`: how far a reset is. */
export function resetIn(resetsAt: number, now: number): string {
  const minutes = Math.max(0, Math.ceil((resetsAt - now) / 60_000))
  if (minutes === 0) return "now"
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`.replace(/ 00m$/, "")
  return `${Math.floor(minutes / 1_440)}d ${Math.floor((minutes % 1_440) / 60)}h`.replace(/ 0h$/, "")
}

/** `usage limit reached · resets 2:10 AM`: the notice's headline. */
export function limitHeadline(input: { resetsAt?: number; now: number; provider?: string }): string {
  const reset = input.resetsAt !== undefined && input.resetsAt > input.now ? ` · resets ${resetClock(input.resetsAt, input.now)}` : ""
  return `${input.provider ? `${input.provider} ` : ""}usage limit reached${reset}`
}

/** The synthetic card a pause or its resume leaves in the transcript. */
export function limitCardRows(card: LimitCard, width: number): Line[] {
  const now = card.at
  if (card.state === "resumed") return [titledRule("Usage limit reset · resuming", width, "success")]
  const rows: Line[] = [titledRule("Usage limit reached", width, "warning")]
  const reset = card.resetsAt !== undefined && card.resetsAt > now ? `resets ${resetClock(card.resetsAt, now)} (in ${resetIn(card.resetsAt, now)})` : "reset time unknown"
  const head = `${card.provider ? `${card.provider} · ` : ""}${reset} · turn paused`
  rows.push(...wrapSpans([{ text: head, fg: "text" }], width, [{ text: INDENT }]))
  if (card.state === "scheduled") rows.push(...wrapSpans([{ text: "auto-resume armed · continues by itself when the window resets", fg: "success" }], width, [{ text: INDENT }]))
  const detail = card.message.replace(/\s+/g, " ").trim()
  if (detail) rows.push(...wrapSpans([{ text: detail.length > 160 ? `${detail.slice(0, 159)}…` : detail, fg: "muted", dim: true }], width, [{ text: INDENT }]))
  return rows
}

/** The minimal view's transcript record: nothing for a pause (the live line above the prompt carries it), one muted line when it resumed. */
export function limitCardLine(card: LimitCard, width: number): Line[] {
  if (card.state !== "resumed") return []
  return wrapSpans([{ text: "limit reset · resumed", fg: "muted", dim: true }], width, [{ text: INDENT }])
}

/**
 * The minimal view's one muted line above the prompt: `limit reached · resumes 2:10 AM · esc cancel` while armed. Other
 * states say which command moves on; a snoozed pause shows nothing.
 */
export function limitLine(view: UsageLimitView | undefined, now: number): string | undefined {
  if (!view || view.state === "snoozed") return undefined
  if (view.state === "ready") return "limit reset · /limit now · /limit dismiss"
  if (view.resetsAt === undefined) return "limit reached · reset unknown · /limit now"
  if (view.state === "scheduled") return `limit reached · resumes ${resetClock(view.resetsAt, now)} · esc cancel`
  return `limit reached · resets ${resetClock(view.resetsAt, now)} · /limit resume`
}

/** Whether the bar is drawn: a snoozed pause stays hidden (the daemon turns it into `ready` when the window resets). */
export const limitBarVisible = (view: UsageLimitView | undefined): view is UsageLimitView => view !== undefined && view.state !== "snoozed"

/** What each chip does, in the order they are drawn, for a pause in `state`. */
export function limitChips(view: Pick<UsageLimitView, "state" | "resetsAt">): Array<{ action: LimitAction; label: string }> {
  if (view.state === "ready") return [{ action: "resume", label: " RESUME " }, { action: "dismiss", label: " DISMISS " }]
  if (view.state === "scheduled") return [{ action: "resume", label: " RESUME NOW " }, { action: "cancel", label: " CANCEL " }, { action: "snooze", label: " SNOOZE " }]
  if (view.resetsAt === undefined) return [{ action: "resume", label: " RESUME NOW " }, { action: "dismiss", label: " DISMISS " }]
  return [{ action: "schedule", label: " RESUME AT RESET " }, { action: "snooze", label: " SNOOZE UNTIL RESET " }]
}

/** What ctrl+s does with the bar: the first chip's action. */
export const limitPrimary = (view: Pick<UsageLimitView, "state" | "resetsAt">): LimitAction => limitChips(view)[0]!.action

export type LimitBar = { rows: Line[]; chips: Array<{ action: LimitAction; row: number; from: number; to: number }> }

/** The bar above the prompt: what happened, when it resets, and the chips. Chip coordinates are local to these rows. */
export function renderLimitBar(input: { width: number; view: UsageLimitView; now: number; glyphs: Pick<Glyphs, "dot"> }): LimitBar {
  const { width, view, now } = input
  const padded = width >= 70
  const room = Math.max(1, width - 4)
  const tone: ColorName = view.state === "scheduled" || view.state === "ready" ? "success" : "warning"
  const reset = view.resetsAt !== undefined ? ` · resets ${resetClock(view.resetsAt, now)}${view.resetsAt > now ? ` (in ${resetIn(view.resetsAt, now)})` : ""}` : ""
  const text =
    view.state === "ready" ? "limit reset · ready to continue"
    : view.state === "scheduled" && view.resetsAt !== undefined ? `resume at reset (armed) · ${resetClock(view.resetsAt, now)} (in ${resetIn(view.resetsAt, now)})`
    : `${view.provider ? `${view.provider} ` : ""}usage limit reached${reset}`
  const first: Line = [{ text: `${input.glyphs.dot} `, fg: tone }, { text: truncateEnd(text, Math.max(1, room - 2)), fg: "body" }]
  const chips = limitChips(view)
  // The chips share a row while they fit and wrap below it when the terminal is narrow.
  const chipRows: Line[] = [[]]
  const placed: LimitBar["chips"] = []
  const bodyRow = 2 + (padded ? 1 : 0)
  let col = 2
  chips.forEach((chip, index) => {
    let row = chipRows.length - 1
    if (col > 2 && col - 2 + 1 + chip.label.length > room) {
      chipRows.push([])
      row++
      col = 2
    }
    if (col > 2) {
      chipRows[row]!.push({ text: " " })
      col += 1
    }
    const style: Span = { text: chip.label, bold: true, ...onColor(index === 0 ? "primary" : "accent") }
    placed.push({ action: chip.action, row: bodyRow + 1 + row, from: col, to: col + chip.label.length })
    chipRows[row]!.push(style)
    col += chip.label.length
  })
  const hint = padded ? (view.state === "scheduled" ? "ctrl+s resume now · /limit" : `ctrl+s ${chips[0]!.label.trim().toLowerCase()} · /limit`) : "/limit"
  const header = fit(spread([{ text: "Usage limit", fg: "primary" }], [{ text: hint, fg: "muted" }], width), width)
  const rows = [header, ...panelGrid({ rows: [[{ title: view.state === "ready" ? "paused · reset" : view.state === "scheduled" ? "paused · resume armed" : "paused", body: [first, ...chipRows] }]], width, compact: false, maxColumns: 1, padding: padded })]
  return { rows, chips: placed }
}

export type LimitCommand = { kind: "status" } | { kind: "act"; action: LimitAction }
export type LimitParse = { ok: true; command: LimitCommand } | { ok: false; error: string }

export const LIMIT_USAGE = "/limit [resume | cancel | now | snooze | dismiss]"

/** `/limit`: status; `resume`: Resume at reset; `cancel`: disarm the auto-resume; `now`: continue at once; `snooze`: hide until reset; `dismiss`: forget the pause. */
export function parseLimitCommand(args: string): LimitParse {
  const word = args.trim().toLowerCase()
  if (!word || word === "status") return { ok: true, command: { kind: "status" } }
  if (word === "resume" || word === "at-reset" || word === "schedule") return { ok: true, command: { kind: "act", action: "schedule" } }
  if (word === "cancel" || word === "off") return { ok: true, command: { kind: "act", action: "cancel" } }
  if (word === "now" || word === "continue") return { ok: true, command: { kind: "act", action: "resume" } }
  if (word === "snooze") return { ok: true, command: { kind: "act", action: "snooze" } }
  if (word === "dismiss" || word === "clear") return { ok: true, command: { kind: "act", action: "dismiss" } }
  return { ok: false, error: `usage: ${LIMIT_USAGE}` }
}

/** The one-line answer of `/limit` with no argument. */
export function limitStatus(view: UsageLimitView | undefined, now: number): string {
  if (!view) return "no turn is paused by a usage limit"
  const reset = view.resetsAt !== undefined ? ` · resets ${resetClock(view.resetsAt, now)}` : ""
  const state = view.state === "scheduled" ? "auto-resume armed" : view.state === "ready" ? "limit reset, waiting for you" : view.state
  return `${view.provider ? `${view.provider} ` : ""}usage limit${reset} · ${state} · ${LIMIT_USAGE}`
}

/** What a done action says in the status line. */
export function limitDone(action: LimitAction, state: string | undefined, resetsAt: number | undefined, now: number): string {
  if (action === "schedule") return resetsAt !== undefined ? `will resume at ${resetClock(resetsAt, now)}` : "resume at reset armed"
  if (action === "cancel") return "auto-resume cancelled · /limit resume arms it again"
  if (action === "snooze") return "snoozed until the limit resets"
  if (action === "dismiss") return "pause dismissed"
  return state === "resumed" ? "resuming" : "resume requested"
}
