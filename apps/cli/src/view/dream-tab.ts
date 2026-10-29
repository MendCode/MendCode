import type { DreamRun } from "@mendcode/protocol"
import type { ColorName, Line } from "../ui/theme"
import { clip, spread } from "./deck"
import { reportRows, tokenCount } from "./dream-report"
import { relativeTime, truncateEnd } from "./session-list"
import { wrap } from "./wrap"

/**
 * The Dream tab body of /memory: when Dream runs next, its token budget and its recent runs, newest first. The
 * selected run shows its notes and its safety report (what it read, proposed and refused and why, redactions, usage,
 * budget, whether it was a recovered window). `r` starts a run, `enter` on a run that proposed memories goes to the
 * Pending tab, `v` opens the full report and `b` sets the budget (`dreamMaxTokens`). Pure.
 */
export type DreamTabState = {
  selected: number
  /** The full report of the selected run fills the tab (and scrolls) instead of the list. */
  full?: boolean
  scroll?: number
  /** Characters typed into the budget field; undefined when not editing. */
  typing?: string
}

export type DreamTabAction = { type: "none" } | { type: "close" } | { type: "run" } | { type: "review" } | { type: "budget"; tokens: number | null }

export const DREAM_TAB_HINTS = "r run now · b budget · v full report · enter review proposals · tab/1-7 tabs · esc back"
const FULL_HINTS = "↑↓ scroll · v list · enter review proposals · esc list"
const TYPING_HINTS = "type a number (60000, 60k, 1.5m) · enter save · empty resets · esc cancel"

/** What Dream spends per run when `dreamMaxTokens` is unset (docs/dream.md). */
export const DEFAULT_DREAM_TOKENS = 60_000
export const DREAM_TOKEN_RANGE = { min: 1_000, max: 2_000_000 } as const

const NONE: DreamTabAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "j"])
const PAGE_UP = "\x1b[5~"
const PAGE_DOWN = "\x1b[6~"
const STATUS_TONE: Record<DreamRun["status"], ColorName> = { running: "primary", done: "success", skipped: "muted", failed: "error" }
const NOTE_LINES = 6
const MIN_LIST_ROWS = 3

export function createDreamTabState(): DreamTabState {
  return { selected: 0 }
}

/** `60000`, `60k` or `1.5m` as a token count inside the allowed range; undefined otherwise. */
export function parseTokenBudget(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(text.trim().replace(/[\s_,]/g, ""))
  if (!match) return undefined
  const scale = match[2]!.toLowerCase() === "k" ? 1_000 : match[2]!.toLowerCase() === "m" ? 1_000_000 : 1
  const tokens = Math.round(Number(match[1]) * scale)
  return tokens >= DREAM_TOKEN_RANGE.min && tokens <= DREAM_TOKEN_RANGE.max ? tokens : undefined
}

/** The rows under the list for the selected run: its notes or error, then its safety report. */
function detailRows(run: DreamRun, detail: "summary" | "full", width: number): Line[] {
  const rows: Line[] = []
  const noteText = run.error ?? run.notes ?? ""
  if (noteText) {
    rows.push([{ text: run.error ? "error" : "notes", fg: run.error ? "error" : "muted" }])
    for (const line of wrap(noteText.replace(/\s+/g, " ").trim(), Math.max(1, width - 2)).slice(0, NOTE_LINES)) rows.push([{ text: truncateEnd(line, width), fg: run.error ? "error" : "muted", dim: !run.error }])
    rows.push([])
  }
  rows.push([{ text: "safety report", fg: "muted" }], ...reportRows({ run, detail, width }))
  return rows
}

/** How many rows the full report of `run` takes (it does not depend on the width). */
export const fullReportLength = (run: DreamRun) => detailRows(run, "full", 80).length + 2

export function dreamTabKey(state: DreamTabState, key: string, runs: DreamRun[] | undefined, options: { room?: number } = {}): { state: DreamTabState; action: DreamTabAction } {
  const list = runs ?? []
  const selected = Math.max(0, Math.min(state.selected, list.length - 1))
  const active = list[selected]
  const review = (key === "\r" || key === "\n") && (active?.proposed ?? 0) > 0

  if (state.typing !== undefined) {
    if (key === "\x1b") {
      const { typing: _typing, ...rest } = state
      return { state: rest, action: NONE }
    }
    if (key === "\x7f" || key === "\b") return { state: { ...state, typing: state.typing.slice(0, -1) }, action: NONE }
    if (key === "\r" || key === "\n") {
      const empty = state.typing.trim() === ""
      const tokens = empty ? null : parseTokenBudget(state.typing)
      if (tokens === undefined) return { state, action: NONE }
      const { typing: _typing, ...rest } = state
      return { state: rest, action: { type: "budget", tokens } }
    }
    return /^[0-9a-zA-Z.,_ ]+$/.test(key) ? { state: { ...state, typing: (state.typing + key).slice(0, 12) }, action: NONE } : { state, action: NONE }
  }

  if (state.full) {
    const last = Math.max(0, fullReportLength(active ?? ({ runId: 0 } as DreamRun)) - (options.room ?? 10))
    const scroll = (to: number) => {
      const next = Math.max(0, Math.min(to, last))
      return next === (state.scroll ?? 0) ? { state, action: NONE } : { state: { ...state, scroll: next }, action: NONE }
    }
    if (key === "\x1b" || key === "v") {
      const { full: _full, scroll: _scroll, ...rest } = state
      return { state: rest, action: NONE }
    }
    if (UP.has(key)) return scroll((state.scroll ?? 0) - 1)
    if (DOWN.has(key)) return scroll((state.scroll ?? 0) + 1)
    if (key === PAGE_UP) return scroll((state.scroll ?? 0) - (options.room ?? 10))
    if (key === PAGE_DOWN) return scroll((state.scroll ?? 0) + (options.room ?? 10))
    return review ? { state, action: { type: "review" } } : { state, action: NONE }
  }

  if (key === "\x1b") return { state, action: { type: "close" } }
  if (key === "r") return { state, action: runs?.some((run) => run.status === "running") ? NONE : { type: "run" } }
  if (key === "b") return { state: { ...state, typing: "" }, action: NONE }
  if (key === "v" && active) return { state: { ...state, full: true, scroll: 0 }, action: NONE }
  const go = (index: number) => {
    const next = Math.max(0, Math.min(index, list.length - 1))
    return next === state.selected ? { state, action: NONE } : { state: { selected: next }, action: NONE }
  }
  if (UP.has(key)) return go(selected - 1)
  if (DOWN.has(key)) return go(selected + 1)
  if (review) return { state, action: { type: "review" } }
  return { state, action: NONE }
}

function runLabel(run: DreamRun): string {
  if (run.status === "running") return "running…"
  if (run.status === "done") return run.proposed ? `${run.proposed} proposal${run.proposed === 1 ? "" : "s"}` : "nothing new"
  return run.status
}

/** The first row: the daily time and the token budget on the left, the proposals waiting on the right; while the budget is typed, the field. */
function scheduleLine(input: { dreamAt: string | undefined; tokens: number | undefined; typing: string | undefined; pending: number; width: number }): Line {
  if (input.typing !== undefined) {
    const valid = input.typing.trim() === "" || parseTokenBudget(input.typing) !== undefined
    const left: Line = [{ text: "budget ", fg: "muted" }, { text: `${input.typing}_`, fg: valid ? "warning" : "error", bold: true }]
    return spread(left, [{ text: valid ? "tokens per run · 1k to 2M" : "1k to 2M tokens", fg: valid ? "muted" : "error" }], input.width)
  }
  const left: Line = input.dreamAt ? [{ text: "daily at ", fg: "muted" }, { text: input.dreamAt, fg: "text", bold: true }] : [{ text: "no schedule · /setup sets a daily time", fg: "muted" }]
  left.push({ text: " · budget ", fg: "muted" }, { text: `${tokenCount(input.tokens ?? DEFAULT_DREAM_TOKENS)}`, fg: "text", bold: true }, { text: input.tokens === undefined ? " tokens (default)" : " tokens", fg: "muted" })
  const right: Line = input.pending ? [{ text: `${input.pending} pending to review`, fg: "warning" }] : []
  return spread(left, right, input.width)
}

export function dreamTabHints(state: DreamTabState): string {
  return state.typing !== undefined ? TYPING_HINTS : state.full ? FULL_HINTS : DREAM_TAB_HINTS
}

export function renderDreamTab(input: { runs: DreamRun[] | undefined; state: DreamTabState; dreamAt?: string | undefined; dreamMaxTokens?: number | undefined; pending: number; width: number; height: number; now: number }): Line[] {
  const { runs, state, width, now } = input
  const height = Math.max(0, input.height)
  if (height === 0) return []
  const rows: Line[] = [scheduleLine({ dreamAt: input.dreamAt, tokens: input.dreamMaxTokens, typing: state.typing, pending: input.pending, width }), []]
  if (!runs) rows.push([{ text: "loading runs…", fg: "muted" }])
  else if (runs.length === 0) rows.push([{ text: "no runs yet · r runs Dream now", fg: "muted" }])
  else {
    const selected = Math.max(0, Math.min(state.selected, runs.length - 1))
    const active = runs[selected]!
    const took = active.endedAt ? ` · ${Math.max(1, Math.round((active.endedAt - active.startedAt) / 1000))}s` : ""
    if (state.full) {
      const full: Line[] = [[{ text: `run ${active.runId} · ${runLabel(active)}`, fg: "text", bold: true }, { text: ` · ${relativeTime(now, active.startedAt)}${took}`, fg: "muted" }], [], ...detailRows(active, "full", width)]
      const room = Math.max(0, height - rows.length)
      const start = Math.max(0, Math.min(state.scroll ?? 0, Math.max(0, full.length - room)))
      return [...rows, ...full.slice(start, start + room)].slice(0, height).map((row) => clip(row, width))
    }
    const detail = detailRows(active, "summary", width)
    const used = rows.length
    // The list keeps at least three rows while the report can be cut, and never more than the tab has.
    const listRoom = Math.min(runs.length, Math.max(1, height - used), Math.max(MIN_LIST_ROWS, height - used - detail.length - 1))
    const start = Math.max(0, Math.min(selected - listRoom + 1, runs.length - listRoom))
    runs.slice(start, start + listRoom).forEach((run, offset) => {
      const chosen = start + offset === selected
      const left: Line = [
        { text: chosen ? "› " : "  ", fg: "primary", bold: true },
        { text: "● ", fg: STATUS_TONE[run.status] },
        { text: runLabel(run), fg: chosen ? "text" : "muted", bold: chosen },
        ...(run.trigger === "recovered" ? [{ text: " · recovered", fg: "warning" as const }] : []),
      ]
      const span = run.endedAt ? ` · ${Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000))}s` : ""
      rows.push(spread(left, [{ text: `${relativeTime(now, run.startedAt)}${span}`, fg: "muted" }], width))
    })
    const detailRoom = Math.max(0, height - rows.length - 1)
    rows.push([])
    if (detail.length > detailRoom && detailRoom > 0) rows.push(...detail.slice(0, detailRoom - 1), [{ text: "… v shows the full report", fg: "muted", dim: true }])
    else rows.push(...detail)
  }
  return rows.slice(0, height).map((row) => clip(row, width))
}
