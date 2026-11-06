import type { Line } from "../ui/theme"
import { clip, panelGrid } from "./deck"
import { closedSearch, pageSearchKey, pageSearchRow, searchHint, searchMatches, type PageSearch } from "./page-search"
import { pickerFrame } from "./picker-frame"
import { wrap } from "./wrap"

/**
 * `/whatsnew` (docs/whats-new.md): "For you", the picks of one model call, each with its action, over the changes they came
 * from; `/whatsnew all` is the changes alone, with no call. One list with the page standard's `/` box. Enter on a pick previews
 * its action and a second Enter applies it; Esc keeps things as they are. Nothing applies without that second Enter.
 */

/** `patch` is the validated settings change behind `diff`; `done` says what the action did once applied. */
export type WhatsNewPick = { text: string; patch?: Record<string, unknown> | undefined; diff?: string[] | undefined; command?: string | undefined; dropped?: string | undefined; done?: string | undefined }
export type WhatsNewChange = { section: string; text: string; fresh: boolean }
export type WhatsNewCost = { model: string; estimate: number; usage?: { input: number; output: number; costMicros?: number | undefined } | undefined }
export type WhatsNewState = {
  all: boolean
  /** The model call: `loading` while it runs (the changes are already listed), `error` when it failed. `ready` also for `all`. */
  status: "loading" | "ready" | "error"
  error: string
  summary: string
  picks: WhatsNewPick[]
  changes: WhatsNewChange[]
  cost?: WhatsNewCost | undefined
  /** How many changes were left out of the call to keep it small. */
  unsent: number
  selected: number
  search: PageSearch
  /** The pick whose action is shown for confirmation (index into the picks). */
  confirm?: number | undefined
  /** The change shown in full. */
  open?: number | undefined
}

export type WhatsNewAction = { type: "none" } | { type: "close" } | { type: "apply"; pick: number } | { type: "command"; pick: number }

type Row = { kind: "pick"; index: number; pick: WhatsNewPick } | { kind: "change"; index: number; change: WhatsNewChange }

export function createWhatsNewState(input: { all: boolean; summary: string; changes: WhatsNewChange[]; unsent?: number }): WhatsNewState {
  return { all: input.all, status: input.all ? "ready" : "loading", error: "", summary: input.summary, picks: [], changes: input.changes, unsent: input.unsent ?? 0, selected: 0, search: closedSearch() }
}

/** The rows the search leaves, picks first. */
export function whatsNewRows(state: WhatsNewState): Row[] {
  const query = state.search.query
  return [
    ...state.picks.flatMap((pick, index): Row[] => searchMatches(query, [pick.text, pick.command ?? "", ...(pick.diff ?? [])]) ? [{ kind: "pick", index, pick }] : []),
    ...state.changes.flatMap((change, index): Row[] => searchMatches(query, [change.text, change.section]) ? [{ kind: "change", index, change }] : []),
  ]
}

const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const actionable = (pick: WhatsNewPick) => !pick.done && Boolean(pick.diff?.length || pick.command)

export function whatsNewKey(state: WhatsNewState, key: string): { state: WhatsNewState; action: WhatsNewAction } {
  const none = (next: WhatsNewState) => ({ state: next, action: { type: "none" } as WhatsNewAction })
  if (state.confirm !== undefined) {
    const pick = state.picks[state.confirm]
    if (key === "\r" && pick) return { state: { ...state, confirm: undefined }, action: { type: pick.diff?.length ? "apply" : "command", pick: state.confirm } }
    if (key === "\x1b" || key === "q" || key === "n") return none({ ...state, confirm: undefined })
    return none(state)
  }
  const searched = state.search.open || key === "/" ? pageSearchKey(state.search, key) : undefined
  if (searched) return none({ ...state, search: searched.search, selected: searched.event === "changed" ? 0 : state.selected })
  const rows = whatsNewRows(state)
  const last = Math.max(0, rows.length - 1)
  const at = Math.min(state.selected, last)
  const row = rows[at]
  if (!state.search.open && (key === "\x1b" || key === "q")) {
    if (state.search.query) return none({ ...state, search: closedSearch(), selected: 0 })
    return { state, action: { type: "close" } }
  }
  // While the box is open, letters (j, k) are text: the search took them above.
  if (UP.has(key)) return none({ ...state, selected: Math.max(0, at - 1), open: undefined })
  if (DOWN.has(key)) return none({ ...state, selected: Math.min(last, at + 1), open: undefined })
  if (key === "g" || key === "\x1b[H") return none({ ...state, selected: 0, open: undefined })
  if (key === "G" || key === "\x1b[F") return none({ ...state, selected: last, open: undefined })
  if ((key === "\r" || key === " ") && row) {
    if (row.kind === "pick") return none(actionable(row.pick) ? { ...state, confirm: row.index } : state)
    return none({ ...state, open: state.open === row.index ? undefined : row.index })
  }
  return none(state)
}

const tokens = (count: number) => count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)

/** The cost line: the estimate while the call runs, then what the provider counted. */
export function whatsNewCostText(cost: WhatsNewCost | undefined, status: WhatsNewState["status"]): string {
  if (!cost) return status === "loading" ? "reading your setup…" : ""
  if (!cost.usage) return status === "loading" ? `asking ${cost.model} · about ${tokens(cost.estimate)} tokens` : `${cost.model} · about ${tokens(cost.estimate)} tokens`
  const price = cost.usage.costMicros !== undefined ? ` · $${(cost.usage.costMicros / 1_000_000).toFixed(cost.usage.costMicros < 10_000 ? 4 : 2)}` : ""
  return `${cost.model} · ${tokens(cost.usage.input)} in · ${tokens(cost.usage.output)} out${price}`
}

function actionLine(pick: WhatsNewPick): string {
  if (pick.done) return pick.done
  if (pick.diff?.length) return `settings · ${pick.diff[0]}${pick.diff.length > 1 ? ` · ${pick.diff.length - 1} more` : ""}`
  if (pick.command) return `try ${pick.command}`
  return pick.dropped ? `no action · ${pick.dropped}` : ""
}

function listRows(state: WhatsNewState, width: number): { rows: Line[]; focus: number } {
  const rows: Line[] = []
  const shown = whatsNewRows(state)
  const selected = Math.min(state.selected, Math.max(0, shown.length - 1))
  let focus = 0
  let heading = ""
  if (!state.all) {
    rows.push([{ text: "For you", fg: "heading", bold: true }, { text: `  ${whatsNewCostText(state.cost, state.status)}`, fg: "muted" }])
    if (state.status === "loading") rows.push([{ text: "  the changes are below while the model reads them", fg: "muted" }])
    else if (state.status === "error") rows.push(...wrap(state.error || "the model call failed", Math.max(1, width - 2)).map((text): Line => [{ text: `  ${text}`, fg: "warning" }]))
    else if (!state.picks.length) rows.push([{ text: "  nothing in these changes fits what you usually do", fg: "muted" }])
    rows.push([])
  }
  shown.forEach((row, index) => {
    const on = index === selected
    const mark: Line[number] = { text: on ? "› " : "  ", fg: "primary" }
    if (row.kind === "change" && row.change.section !== heading) {
      heading = row.change.section
      if (rows.length && rows.at(-1)!.length) rows.push([])
      rows.push([{ text: heading, fg: "heading", bold: true }])
    }
    if (on) focus = rows.length
    if (row.kind === "pick") {
      wrap(row.pick.text, Math.max(1, width - 4)).forEach((part, line) => rows.push([line === 0 ? mark : { text: "  " }, { text: `${line === 0 ? `${row.index + 1} ` : "  "}${part}`, fg: on ? "primary" : "text", bold: on && line === 0 }]))
      const action = actionLine(row.pick)
      if (state.confirm === row.index) {
        rows.push([{ text: `    ${row.pick.diff?.length ? "Change MendCode settings?" : `Put ${row.pick.command} in the prompt?`}`, fg: "warning", bold: true }])
        for (const change of row.pick.diff ?? []) rows.push(clip([{ text: `    ${change}`, fg: "text" }], width))
        rows.push([{ text: `    enter ${row.pick.diff?.length ? "apply" : "insert"} · esc keep`, fg: "muted" }])
      } else if (action) rows.push(clip([{ text: `    ${action}`, fg: row.pick.dropped ? "muted" : on ? "success" : "muted" }], width))
      return
    }
    const fresh = row.change.fresh ? [{ text: " new", fg: "success" as const }] : []
    if (state.open === row.index) wrap(row.change.text, Math.max(1, width - 4)).forEach((part, line) => rows.push([line === 0 ? mark : { text: "  " }, { text: part, fg: on ? "primary" : "text" }, ...(line === 0 ? fresh : [])]))
    else rows.push(clip([mark, { text: row.change.text, fg: on ? "primary" : "text" }, ...fresh], width))
  })
  if (!shown.length) rows.push([{ text: state.search.query ? "no matching changes" : "no changes to show", fg: "muted" }])
  if (state.unsent && !state.all) rows.push([], [{ text: `${state.unsent} more changes were not sent to the model · /whatsnew all lists every one`, fg: "muted" }])
  return { rows, focus }
}

export function renderWhatsNewPage(input: { state: WhatsNewState; width: number; height: number }): Line[] {
  const { state, width } = input
  const height = Math.max(0, input.height)
  const room = Math.max(0, height - 2)
  const hints = state.confirm !== undefined ? "enter apply · esc keep" : searchHint(state.search, width < 70 ? "/ search · enter open · esc back" : "↑↓ row · enter preview or open · / search · g/G ends · esc back")
  const search = pageSearchRow(state.search, whatsNewRows(state).length, Math.max(1, width - 4))
  const body = (inner: number): Line[] => {
    const list = listRows(state, inner)
    const top = search ? [search, []] : []
    const view = Math.max(1, room - 4 - top.length)
    const start = Math.max(0, Math.min(list.focus - Math.floor(view / 3), list.rows.length - view))
    return [...top, ...list.rows.slice(start)]
  }
  const title = state.all ? "What's new · all" : "What's new"
  return pickerFrame(title, hints, width, height, panelGrid({ width, heights: [room], padding: true, maxColumns: 1, rows: [[{ title: state.all ? "Changelog" : "For you and the changes", active: true, body }]] }), state.summary)
}
