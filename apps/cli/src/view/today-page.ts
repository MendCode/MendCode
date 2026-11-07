import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { isWide } from "../ui/breakpoints"
import { clip, fit, panelGrid, spread } from "./deck"
import { tabsRow, type PageTab } from "./page"
import { pickerFrame } from "./picker-frame"
import { relativeTime, truncateEnd } from "./session-list"
import { lineWidth, textWidth, wrap } from "./wrap"

/**
 * /today (design preview): where to get back in control. It relates and prioritizes what /reviews, /memory and the
 * sessions already manage and never duplicates them: every row says why it is there and where it is managed, and
 * opening the page runs nothing. Pure renderer over `TodayData`; the daemon is not involved.
 */

export type TodayTab = "attention" | "pickup" | "memory"
export type TodayState = { tab: TodayTab; selected: number; /** `?` shows every key in the header. */ help: boolean; scroll?: number }

/** Where an item is managed: the command or page that owns it and the id inside it. */
export type TodayLink = { command: string; ref?: string; /** Enter jumps to this session when set; otherwise it opens `command`. */ sessionId?: string }
/** One step of an item's history, newest first. */
export type TodayEvent = { at: number; text: string }

export type AttentionKind = "approval" | "decision" | "review" | "contradiction"
export type AttentionItem = {
  id: string
  kind: AttentionKind
  title: string
  project: string
  /** When it started waiting for you. */
  since: number
  /** One line for the row. */
  why: string
  /** The long form for the detail. */
  explain: string
  next: string
  history: TodayEvent[]
  evidence: string[]
  link: TodayLink
}

export type PickupState = "interrupted" | "failed" | "blocked" | "awaiting-review" | "finished"
export type PickupItem = {
  sessionId: string
  title: string
  project: string
  state: PickupState
  leftAt: number
  why: string
  leftOff: string
  next: string
  history: TodayEvent[]
  evidence: string[]
  link: TodayLink
}

export type ProposalKind = "new" | "merge" | "fix" | "drop"
export type MemoryProposal = {
  id: string
  kind: ProposalKind
  title: string
  at: number
  why: string
  /** Dream run that proposed it; absent for a memory the agent proposed itself. */
  run?: string
  before: string[]
  after?: string
  next: string
  evidence: string[]
  link: TodayLink
}

/** Counts the summary paragraph is built from; all of it is local data. */
export type TodaySummaryInputs = { lastVisit: number; sessionsRan: number; sessionsFinished: number; projects: number; dreamRuns: number; lastDreamAt?: number }
/** What the last Dream run did on its own, shown above the proposals. Absent when Dream has not run. */
export type TodayDream = { run: string; at: number; summary: string }
export type TodayData = {
  summary: TodaySummaryInputs
  dream?: TodayDream
  attention: AttentionItem[]
  pickup: PickupItem[]
  memory: MemoryProposal[]
  /** What this client could not read and why (remote or read-only clients); shown under the summary. */
  notes?: string[]
}

export const TODAY_TABS: readonly TodayTab[] = ["attention", "pickup", "memory"]
const HINTS = "↑↓ select · [ ] scroll · ? keys · esc back"
const KEYS_HINTS = "↑↓ select · [ ] scroll · ? hide keys · esc back"
const LABEL_WIDTH = 9
const MIN_TWO_LINE_ROWS = 6
const PADDED_HEIGHT = 30

const KIND_TONE: Record<AttentionKind, ColorName> = { approval: "warning", decision: "info", review: "info", contradiction: "error" }
const STATE_TONE: Record<PickupState, ColorName> = { interrupted: "warning", failed: "error", blocked: "error", "awaiting-review": "info", finished: "success" }
const PROPOSAL_TONE: Record<ProposalKind, ColorName> = { new: "success", merge: "warning", fix: "info", drop: "error" }

export function createTodayState(): TodayState {
  return { tab: "attention", selected: 0, help: false }
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))
const ago = (now: number, then: number) => (relativeTime(now, then) === "now" ? "just now" : `${relativeTime(now, then)} ago`)

/** The paragraph on top, from counts only (no model call). It says what is waiting and that nothing has run. */
export function todaySummary(data: TodayData, now: number): string {
  const { summary, attention, pickup, memory } = data
  const since = `Since you left ${ago(now, summary.lastVisit)}`
  const ran = summary.sessionsRan === 0 ? "no session ran" : `${plural(summary.sessionsRan, "session")} ran in ${plural(summary.projects, "project")} and ${summary.sessionsFinished} finished`
  const waiting = attention.length + pickup.length + memory.length
  if (waiting === 0) return `${since}: ${ran}. Nothing needs you, nothing is left to pick up and Dream has no proposals.`
  const parts = [
    attention.length ? `${plural(attention.length, "thing")} ${attention.length === 1 ? "needs" : "need"} you` : "",
    pickup.length ? `${plural(pickup.length, "session")} can be picked up` : "",
    memory.length ? `Dream proposes ${plural(memory.length, "change")}` : "",
  ].filter(Boolean)
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]!
  return `${since}: ${ran}. ${list}.`
}

const tabLabel = (tab: TodayTab) => ({ attention: "Attention", pickup: "Pick up", memory: "Memory" })[tab]
const tabShort = (tab: TodayTab) => ({ attention: "Att", pickup: "Pick", memory: "Mem" })[tab]

function pageTabs(counts: Record<TodayTab, number>): PageTab[] {
  return TODAY_TABS.map((tab, index) => ({ key: String(index + 1), label: counts[tab] ? `${tabLabel(tab)} ${counts[tab]}` : tabLabel(tab), short: tabShort(tab) }))
}

/** What every tab shows when it has nothing: names what is empty and why that is fine. */
const EMPTY: Record<TodayTab, { list: string[]; detail: string }> = {
  attention: { list: ["nothing needs you", "no approvals, decisions or reviews are waiting and no memories contradict each other"], detail: "select an item to see why it is here, its history and the next step" },
  pickup: { list: ["nothing to pick up", "no session was left unfinished since you last looked"], detail: "select a session to see where it was left and what was next" },
  memory: { list: ["no proposals", "Dream has nothing to merge, fix or drop"], detail: "select a proposal to compare the memory before and after" },
}

type Row = { dot: ColorName; title: string; tag: string; tagTone: ColorName; why: string; at: number; ageTone: ColorName }

function rowsOf(data: TodayData, tab: TodayTab): Row[] {
  if (tab === "attention") return data.attention.map((item) => ({ dot: KIND_TONE[item.kind], title: item.title, tag: item.kind, tagTone: KIND_TONE[item.kind], why: `${item.project} · ${item.why}`, at: item.since, ageTone: "warning" }))
  if (tab === "pickup") return data.pickup.map((item) => ({ dot: STATE_TONE[item.state], title: item.title, tag: item.state, tagTone: STATE_TONE[item.state], why: `${item.project} · ${item.why}`, at: item.leftAt, ageTone: "muted" }))
  return data.memory.map((item) => ({ dot: PROPOSAL_TONE[item.kind], title: item.title, tag: item.kind, tagTone: PROPOSAL_TONE[item.kind], why: item.why, at: item.at, ageTone: "muted" }))
}

function listRows(input: { rows: Row[]; selected: number; width: number; capacity: number; now: number; glyphs: Glyphs; tab: TodayTab }): Line[] {
  const { rows, selected, width, capacity, now, glyphs, tab } = input
  if (!rows.length) return [[{ text: EMPTY[tab].list[0]!, fg: "text", bold: true }], ...wrap(EMPTY[tab].list[1]!, width).map((text): Line => [{ text, fg: "muted" }])]
  const twoLine = capacity >= MIN_TWO_LINE_ROWS
  const perRow = twoLine ? 2 : 1
  const spaced = twoLine && rows.length * 3 - 1 <= capacity
  const stride = perRow + (spaced ? 1 : 0)
  const visible = Math.max(1, Math.floor((capacity + (spaced ? 1 : 0)) / stride))
  const offset = Math.max(0, Math.min(selected - visible + 1, rows.length - visible))
  const out: Line[] = []
  rows.slice(offset, offset + visible).forEach((row, i) => {
    const active = offset + i === selected
    const age = relativeTime(now, row.at)
    const marker: Span = active ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " }
    const dot: Span = { text: `${glyphs.dot} `, fg: row.dot }
    const right: Line = twoLine ? [{ text: age, fg: row.ageTone }] : [{ text: row.tag, fg: row.tagTone }, { text: ` ${age}`.padStart(4), fg: row.ageTone }]
    const title = truncateEnd(row.title, Math.max(1, width - 4 - lineText(right) - 1))
    out.push(spread([marker, dot, { text: title, fg: active ? "primary" : "text", bold: active }], right, width))
    if (twoLine) out.push([{ text: "    " }, { text: row.tag, fg: row.tagTone }, { text: " · ", fg: "muted" }, { text: truncateEnd(row.why, Math.max(1, width - 7 - textWidth(row.tag))), fg: "muted" }])
    if (spaced && i < visible - 1 && offset + i < rows.length - 1) out.push([])
  })
  return out
}

const lineText = (line: Line) => line.reduce((sum, span) => sum + textWidth(span.text), 0)

/** `label  text` with the text wrapped under itself; `fg` colors the text. */
function field(label: string, text: string, width: number, fg: ColorName = "body"): Line[] {
  return wrap(text.replace(/\s+/g, " ").trim(), Math.max(1, width - LABEL_WIDTH)).map((part, i): Line => [{ text: (i === 0 ? label : "").padEnd(LABEL_WIDTH), fg: "muted" }, { text: part, fg }])
}

const heading = (text: string): Line => [{ text, fg: "muted" }]
/** A headed block, left out when it has no rows (real data does not always carry history or evidence). */
const section = (title: string, rows: Line[]): Line[] => (rows.length ? [[], heading(title), ...rows] : [])

function eventRows(events: TodayEvent[], width: number, now: number): Line[] {
  const time = Math.max(...events.map((event) => textWidth(ago(now, event.at))), 0)
  return events.slice(0, 5).flatMap((event) => wrap(event.text, Math.max(1, width - 2 - time - 2)).map((part, i): Line => [{ text: "  " }, { text: (i === 0 ? ago(now, event.at) : "").padEnd(time), fg: "muted" }, { text: `  ${part}`, fg: "body" }]))
}

function evidenceRows(evidence: string[], width: number): Line[] {
  return evidence.flatMap((text) => wrap(text, Math.max(1, width - 4)).map((part, i): Line => [{ text: i === 0 ? "  · " : "    ", fg: "muted" }, { text: part, fg: "body" }]))
}

function linkRow(link: TodayLink, width: number): Line {
  return clip([{ text: "managed".padEnd(LABEL_WIDTH), fg: "muted" }, { text: link.command, fg: "link" }, ...(link.ref ? [{ text: ` · ${link.ref}`, fg: "muted" as const }] : [])], width)
}

function detailRows(input: { data: TodayData; tab: TodayTab; selected: number; width: number; now: number; dense: boolean }): Line[] {
  const { data, tab, selected, width, now, dense } = input
  const gap: Line[] = dense ? [] : [[]]
  const title = (text: string): Line => [{ text: truncateEnd(text, width), fg: "text", bold: true }]
  const meta = (spans: Span[]): Line => clip(spans, width)
  const dot: Span = { text: " · ", fg: "muted" }
  if (tab === "attention") {
    const item = data.attention[selected]
    if (!item) return [[{ text: EMPTY.attention.detail, fg: "muted" }]]
    return [
      title(item.title),
      meta([{ text: item.kind, fg: KIND_TONE[item.kind], bold: true }, dot, { text: item.project, fg: "muted" }, dot, { text: `waiting ${relativeTime(now, item.since)}`, fg: "warning" }]),
      ...gap,
      ...field("why", item.explain, width),
      ...field("next", item.next, width, "text"),
      linkRow(item.link, width),
      ...section("history", eventRows(item.history, width, now)),
      ...section("evidence", evidenceRows(item.evidence, width)),
    ]
  }
  if (tab === "pickup") {
    const item = data.pickup[selected]
    if (!item) return [[{ text: EMPTY.pickup.detail, fg: "muted" }]]
    return [
      title(item.title),
      meta([{ text: item.state, fg: STATE_TONE[item.state], bold: true }, dot, { text: item.project, fg: "muted" }, dot, { text: `left ${ago(now, item.leftAt)}`, fg: "muted" }]),
      ...gap,
      ...field("left off", item.leftOff, width),
      ...field("next", item.next, width, "text"),
      linkRow(item.link, width),
      ...section("history", eventRows(item.history, width, now)),
      ...section("evidence", evidenceRows(item.evidence, width)),
    ]
  }
  const item = data.memory[selected]
  if (!item) return [[{ text: EMPTY.memory.detail, fg: "muted" }]]
  const diff = (sign: "-" | "+", text: string, fg: ColorName): Line[] => wrap(text.replace(/\s+/g, " ").trim(), Math.max(1, width - 4)).map((part, i): Line => [{ text: "  " }, { text: i === 0 ? `${sign} ` : "  ", fg, bold: true }, { text: part, fg }])
  return [
    title(item.title),
    meta([{ text: item.kind, fg: PROPOSAL_TONE[item.kind], bold: true }, dot, { text: item.run ? `Dream ${item.run}` : "from the agent", fg: "muted" }, dot, { text: ago(now, item.at), fg: "muted" }]),
    ...gap,
    ...(dense ? [] : [...field("why", item.why, width), []]),
    heading("before → after"),
    ...(dense && item.before.length > 1 ? [...diff("-", item.before[0]!, "error"), [{ text: `    … and ${item.before.length - 1} more`, fg: "muted" } as Span]] : item.before.flatMap((text) => diff("-", text, "error"))),
    ...(item.after ? diff("+", item.after, "success") : [[{ text: "  (the memory is archived, nothing replaces it)", fg: "muted" } as Span]]),
    ...gap,
    ...field("next", item.next, width, "text"),
    linkRow(item.link, width),
    ...section("evidence", evidenceRows(item.evidence, width)),
  ]
}

/** Renders exactly `height` lines of at most `width` cells. */
export function renderTodayPage(input: { data: TodayData; state: TodayState; width: number; height: number; now: number; glyphs?: Glyphs }): Line[] {
  const { data, state, width, height, now } = input
  const glyphs = input.glyphs ?? defaultGlyphs()
  const counts: Record<TodayTab, number> = { attention: data.attention.length, pickup: data.pickup.length, memory: data.memory.length }
  const tab = state.tab
  const rows = rowsOf(data, tab)
  const selected = clamp(state.selected, rows.length)
  const link = [data.attention[selected]?.link, data.pickup[selected]?.link, data.memory[selected]?.link][TODAY_TABS.indexOf(tab)]
  const hints = state.help ? KEYS_HINTS : link ? `↑↓ select · [ ] scroll · enter open ${link.command} · ? keys · esc back` : HINTS
  const summary = `since ${ago(now, data.summary.lastVisit)} · ${plural(data.summary.projects, "project")}`
  const padded = height >= PADDED_HEIGHT
  const notes = wrap((data.notes ?? []).join(" "), Math.max(1, width)).slice(0, 2).filter(Boolean).map((text): Line => [{ text, fg: "muted" }])
  const paragraph = [...(padded ? [[]] : []), ...wrap(todaySummary(data, now), Math.max(1, width)).slice(0, 2).map((text): Line => [{ text, fg: "body" }]), ...notes]
  const room = Math.max(0, height - 2 - paragraph.length - 1)
  const chrome = padded ? 4 : 2
  const split = isWide(width) && height >= 24
  const listBody = (w: number): Line[] => {
    const capacity = (split ? room : Math.ceil((room - 1) * 0.45)) - chrome
    const head: Line[] = tab === "memory" && data.dream ? [[{ text: `Dream ${data.dream.run} · ${ago(now, data.dream.at)}`, fg: "text" }], ...wrap(data.dream.summary, w).map((text): Line => [{ text, fg: "muted" }]), []] : []
    const shown = head.length && capacity >= head.length + MIN_TWO_LINE_ROWS ? head : []
    return [...shown, ...listRows({ rows, selected, width: w, capacity: capacity - shown.length, now, glyphs, tab })]
  }
  const list = { title: `${tab === "memory" ? "Proposals" : tabLabel(tab)}${counts[tab] ? ` · ${counts[tab]}` : ""}`, active: true, weight: 3, body: listBody }
  const detail = state.help
    ? { title: "Keys", weight: 4, body: (w: number): Line[] => keysRows(w) }
    : { title: "Detail", weight: 4, scroll: state.scroll ?? 0, body: (w: number): Line[] => detailRows({ data, tab, selected, width: w, now, dense: !padded }) }
  const top = Math.ceil((room - 1) * 0.45)
  const grid = panelGrid({ width, rows: split ? [[list, detail]] : [[list], [detail]], heights: split ? [room] : [top, Math.max(0, room - top - 1)], compact: false, padding: padded, maxColumns: split ? 2 : 1 })
  const frame = pickerFrame("Today", hints, width, height, [...paragraph, [], ...grid])
  if (frame.length > 1) frame[1] = todayTabsRow({ counts, active: TODAY_TABS.indexOf(tab), right: summary, width })
  return frame
}

/** Row two, as /profiles draws it: the numbered tabs on the left, the page's summary after them. */
function todayTabsRow(input: { counts: Record<TodayTab, number>; active: number; right: string; width: number }): Line {
  const { width } = input
  const tabs = tabsRow(pageTabs(input.counts), input.active, Math.max(1, width < 100 ? width : Math.floor(width * 0.55)))
  const right = truncateEnd(input.right, Math.max(0, width - lineWidth(tabs) - 2))
  return fit(right ? spread(tabs, [{ text: right, fg: "muted" }], width) : tabs, width)
}

const KEYS: ReadonlyArray<readonly [string, string]> = [
  ["↑↓ j k", "select"], ["1 2 3 tab", "switch tab"], ["enter", "open where it is managed"], ["[ ]", "scroll the detail"], ["r", "reload"], ["esc q", "back"], ["?", "hide keys"],
]

/** The `?` section: every key and what it does, the meanings in one column. */
function keysRows(width: number): Line[] {
  const keyWidth = Math.max(...KEYS.map(([key]) => textWidth(key))) + 2
  return KEYS.map(([key, meaning]) => clip([{ text: key.padEnd(keyWidth), fg: "text", bold: true }, { text: meaning, fg: "muted" }], width))
}

export type TodayKeyResult = { state: TodayState; action: { type: "none" } | { type: "close" } | { type: "reload" } | { type: "open"; link: TodayLink } }
const UP = new Set(["\x1b[A", "\x1bOA", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "j"])

/** One raw key. Moving or switching resets the detail scroll; the same state object comes back when nothing changed. */
export function todayPageKey(state: TodayState, key: string, data: TodayData): TodayKeyResult {
  const none = { state, action: { type: "none" } } as const
  const tabIndex = TODAY_TABS.indexOf(state.tab)
  const count = rowsOf(data, state.tab).length
  const selected = clamp(state.selected, count)
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  if (key === "r") return { state, action: { type: "reload" } }
  if (key === "?") return { state: { ...state, help: !state.help }, action: { type: "none" } }
  if (key === "[" || key === "]") return { state: { ...state, scroll: Math.max(0, (state.scroll ?? 0) + (key === "]" ? 4 : -4)) }, action: { type: "none" } }
  const tab = /^[1-3]$/.test(key) ? TODAY_TABS[Number(key) - 1] : key === "\t" ? TODAY_TABS[(tabIndex + 1) % TODAY_TABS.length] : undefined
  if (tab) return tab === state.tab ? none : { state: { ...state, tab, selected: 0, scroll: 0 }, action: { type: "none" } }
  const move = (index: number) => (clamp(index, count) === selected ? none : { state: { ...state, selected: clamp(index, count), scroll: 0 }, action: { type: "none" } } as TodayKeyResult)
  if (UP.has(key)) return move(selected - 1)
  if (DOWN.has(key)) return move(selected + 1)
  const link = [data.attention[selected]?.link, data.pickup[selected]?.link, data.memory[selected]?.link][tabIndex]
  if ((key === "\r" || key === "\n") && link) return { state, action: { type: "open", link } }
  return none
}
