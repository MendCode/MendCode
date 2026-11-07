import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import type { TodayTriageAction, TodayTriageGroup, TodayTriageItem } from "@mendcode/protocol"
import { isWide } from "../ui/breakpoints"
import { clip, fit, panelGrid, spread } from "./deck"
import { tabsRow, type PageTab } from "./page"
import { pickerFrame } from "./picker-frame"
import { relativeTime, truncateEnd } from "./session-list"
import { lineWidth, textWidth, wrap } from "./wrap"

/**
 * /today (docs/today.md): where to get back in control. It relates and prioritizes what /reviews, /memory and the sessions
 * already manage and never duplicates them: every row says why it is there and where it is managed, and opening the page runs
 * nothing. `m` pins a row for today (local, the page never pins on its own); `t` asks a cheap model to group the rows, and the
 * groups only propose: accepting one does what the page already offers per row. Pure renderer over `TodayData` and `TodayState`.
 */

export type TodayTab = "attention" | "pickup" | "memory"
/** The triage of this open page: asked with `t`, kept until the page closes. */
export type TodayTriageView = {
  /** True while the triage list is on screen; `esc` hides it and `t` shows it again without a new call. */
  open: boolean
  status: "running" | "ready" | "error"
  model?: string
  message?: string
  /** How many rows were sent. */
  sent: number
  groups: TodayTriageGroup[]
  selected: number
  /** Indexes of the groups the user accepted. */
  accepted: number[]
}
export type TodayState = {
  tab: TodayTab
  selected: number
  /** `?` shows every key in the header. */
  help: boolean
  scroll?: number
  /** Row keys (`tab:id`) pinned for today; they come first, under "Today". */
  marks?: string[]
  /** A triage group opened with enter: only its rows are listed until `esc`. */
  filter?: { title: string; keys: string[] }
  triage?: TodayTriageView
}

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
/** The rows one triage call may carry, attention first. */
export const MAX_TRIAGE_ITEMS = 60
const LABEL_WIDTH = 9
const MIN_TWO_LINE_ROWS = 6
const PADDED_HEIGHT = 30

const KIND_TONE: Record<AttentionKind, ColorName> = { approval: "warning", decision: "info", review: "info", contradiction: "error" }
const STATE_TONE: Record<PickupState, ColorName> = { interrupted: "warning", failed: "error", blocked: "error", "awaiting-review": "info", finished: "success" }
const PROPOSAL_TONE: Record<ProposalKind, ColorName> = { new: "success", merge: "warning", fix: "info", drop: "error" }

export function createTodayState(marks: string[] = []): TodayState {
  return { tab: "attention", selected: 0, help: false, ...(marks.length ? { marks } : {}) }
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))
const ago = (now: number, then: number) => (relativeTime(now, then) === "now" ? "just now" : `${relativeTime(now, then)} ago`)

/** The paragraph on top, from counts only (no model call). It says what is waiting, in the words of the tabs. */
export function todaySummary(data: TodayData, now: number, marked = 0): string {
  const { summary, attention, pickup, memory } = data
  const since = `Since you left ${ago(now, summary.lastVisit)}`
  const ran = summary.sessionsRan === 0 ? "no session ran" : `${plural(summary.sessionsRan, "session")} ran in ${plural(summary.projects, "project")} and ${summary.sessionsFinished} finished`
  const waiting = attention.length + pickup.length + memory.length
  if (waiting === 0) return `${since}: ${ran}. Nothing needs you, nothing is left to pick up and Dream has no proposals.`
  const parts = [
    attention.length ? `${plural(attention.length, "thing")} ${attention.length === 1 ? "waits" : "wait"} for your answer` : "",
    pickup.length ? `${plural(pickup.length, "session")} ${pickup.length === 1 ? "was" : "were"} left half-done` : "",
    memory.length ? `Dream proposes ${plural(memory.length, "memory change")}` : "",
  ].filter(Boolean)
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]!
  return `${since}: ${ran}. ${list}.${marked ? ` ${plural(marked, "row")} pinned for today.` : ""}`
}

const tabLabel = (tab: TodayTab) => ({ attention: "Attention", pickup: "Pick up", memory: "Memory" })[tab]
const tabShort = (tab: TodayTab) => ({ attention: "Att", pickup: "Pick", memory: "Mem" })[tab]
/** What a tab means, under its list's title: Attention blocks on you, Pick up does not. */
export const TAB_MEANING: Record<TodayTab, string> = {
  attention: "blocked until you answer",
  pickup: "left half-done · nothing waits on you",
  memory: "Dream's proposals · you decide in /memory",
}

function pageTabs(counts: Record<TodayTab, number>): PageTab[] {
  return TODAY_TABS.map((tab, index) => ({ key: String(index + 1), label: tabLabel(tab), count: counts[tab], short: tabShort(tab) }))
}

/** What every tab shows when it has nothing: names what is empty and why that is fine. */
const EMPTY: Record<TodayTab, { list: string[]; detail: string }> = {
  attention: { list: ["nothing needs you", "no approval, question or review waits for you and no memories contradict each other"], detail: "select an item to see why it is here, its history and the next step" },
  pickup: { list: ["nothing to pick up", "no session of the last 7 days was left interrupted, failed, paused or with unreviewed changes"], detail: "select a session to see where it was left and what was next" },
  memory: { list: ["no proposals", "Dream has nothing to merge, fix or drop and no memory waits for review"], detail: "select a proposal to compare the memory before and after" },
}

type Row = { dot: ColorName; title: string; tag: string; tagTone: ColorName; why: string; at: number; ageTone: ColorName }
type Entry = { key: string; tab: TodayTab; kind: string; link: TodayLink; row: Row; marked: boolean }

export const todayKey = (tab: TodayTab, id: string) => `${tab}:${id}`

function entriesOfTab(data: TodayData, tab: TodayTab): Omit<Entry, "marked">[] {
  if (tab === "attention") return data.attention.map((item) => ({ key: todayKey(tab, item.id), tab, kind: item.kind, link: item.link, row: { dot: KIND_TONE[item.kind], title: item.title, tag: item.kind, tagTone: KIND_TONE[item.kind], why: `${item.project} · ${item.why}`, at: item.since, ageTone: "warning" } }))
  if (tab === "pickup") return data.pickup.map((item) => ({ key: todayKey(tab, item.sessionId), tab, kind: item.state, link: item.link, row: { dot: STATE_TONE[item.state], title: item.title, tag: item.state, tagTone: STATE_TONE[item.state], why: `${item.project} · ${item.why}`, at: item.leftAt, ageTone: "muted" } }))
  return data.memory.map((item) => ({ key: todayKey(tab, item.id), tab, kind: item.kind, link: item.link, row: { dot: PROPOSAL_TONE[item.kind], title: item.title, tag: item.kind, tagTone: PROPOSAL_TONE[item.kind], why: item.why, at: item.at, ageTone: "muted" } }))
}

/** A tab's rows as listed: the pinned ones first, then the rest in their order; an open triage group keeps only its rows. */
function entriesOf(data: TodayData, tab: TodayTab, state: TodayState): Entry[] {
  const marks = new Set(state.marks ?? [])
  const keep = state.filter ? new Set(state.filter.keys) : undefined
  const all = entriesOfTab(data, tab).filter((entry) => !keep || keep.has(entry.key)).map((entry) => ({ ...entry, marked: marks.has(entry.key) }))
  return [...all.filter((entry) => entry.marked), ...all.filter((entry) => !entry.marked)]
}

/** The item behind the selected row, in the listed order. */
function itemAt(data: TodayData, entry: Entry | undefined): AttentionItem | PickupItem | MemoryProposal | undefined {
  if (!entry) return undefined
  const id = entry.key.slice(entry.tab.length + 1)
  if (entry.tab === "attention") return data.attention.find((item) => item.id === id)
  if (entry.tab === "pickup") return data.pickup.find((item) => item.sessionId === id)
  return data.memory.find((item) => item.id === id)
}

/** What the triage model reads: every row of the three tabs, attention first, as short text. */
export function triageItems(data: TodayData): TodayTriageItem[] {
  const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
  return TODAY_TABS.flatMap((tab) => entriesOfTab(data, tab)).slice(0, MAX_TRIAGE_ITEMS).map((entry) => ({ id: entry.key, tab: entry.tab, kind: entry.kind, title: short(entry.row.title, 120), why: short(entry.row.why, 200) }))
}

/** What enter does on a row, in words: jump to the session, or open the page that manages it. */
const enterVerb = (link: TodayLink) => (link.sessionId ? "open the session" : `open ${link.command}`)

function listRows(input: { rows: Entry[]; selected: number; width: number; capacity: number; now: number; glyphs: Glyphs; tab: TodayTab; filtered: boolean }): Line[] {
  const { rows, selected, width, now, glyphs, tab } = input
  if (!rows.length) return input.filtered ? [[{ text: "no rows of this group here", fg: "text", bold: true }], [{ text: "the group's rows are in another tab; esc shows every row", fg: "muted" }]] : [[{ text: EMPTY[tab].list[0]!, fg: "text", bold: true }], ...wrap(EMPTY[tab].list[1]!, width).map((text): Line => [{ text, fg: "muted" }])]
  const pinned = rows.filter((row) => row.marked).length
  const grouped = pinned > 0
  const capacity = input.capacity - (grouped ? (pinned < rows.length ? 2 : 1) : 0)
  const twoLine = capacity >= MIN_TWO_LINE_ROWS
  const perRow = twoLine ? 2 : 1
  const spaced = twoLine && rows.length * 3 - 1 <= capacity
  const stride = perRow + (spaced ? 1 : 0)
  const visible = Math.max(1, Math.floor((capacity + (spaced ? 1 : 0)) / stride))
  const offset = Math.max(0, Math.min(selected - visible + 1, rows.length - visible))
  const out: Line[] = []
  rows.slice(offset, offset + visible).forEach((row, i) => {
    const index = offset + i
    if (grouped && row.marked && (i === 0 || !rows[index - 1]?.marked)) out.push([{ text: `${glyphs.goal} Today`, fg: "primary", bold: true }, { text: ` · ${pinned} pinned`, fg: "muted" }])
    if (grouped && !row.marked && (i === 0 || rows[index - 1]?.marked)) out.push([{ text: "The rest", fg: "muted", bold: true }])
    const active = index === selected
    const age = relativeTime(now, row.row.at)
    const marker: Span = active ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " }
    const dot: Span = row.marked ? { text: `${glyphs.goal} `, fg: "primary" } : { text: `${glyphs.dot} `, fg: row.row.dot }
    const right: Line = twoLine ? [{ text: age, fg: row.row.ageTone }] : [{ text: row.row.tag, fg: row.row.tagTone }, { text: ` ${age}`.padStart(4), fg: row.row.ageTone }]
    const title = truncateEnd(row.row.title, Math.max(1, width - 4 - lineText(right) - 1))
    out.push(spread([marker, dot, { text: title, fg: active ? "primary" : "text", bold: active }], right, width))
    if (twoLine) out.push([{ text: "    " }, { text: row.row.tag, fg: row.row.tagTone }, { text: " · ", fg: "muted" }, { text: truncateEnd(row.row.why, Math.max(1, width - 7 - textWidth(row.row.tag))), fg: "muted" }])
    if (spaced && i < visible - 1 && index < rows.length - 1 && rows[index + 1]?.marked === row.marked) out.push([])
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

/** The row's keys in words: what enter does here and what `m` would do. */
function keysRow(entry: Entry, width: number): Line {
  return clip([{ text: "keys".padEnd(LABEL_WIDTH), fg: "muted" }, { text: "enter ", fg: "text", bold: true }, { text: enterVerb(entry.link), fg: "body" }, { text: " · ", fg: "muted" }, { text: "m ", fg: "text", bold: true }, { text: entry.marked ? "unpin from today" : "pin for today", fg: "body" }], width)
}

function detailRows(input: { data: TodayData; entry: Entry | undefined; tab: TodayTab; width: number; now: number; dense: boolean }): Line[] {
  const { data, entry, tab, width, now, dense } = input
  const gap: Line[] = dense ? [] : [[]]
  const title = (text: string): Line => [{ text: truncateEnd(text, width), fg: "text", bold: true }]
  const meta = (spans: Span[]): Line => clip(spans, width)
  const dot: Span = { text: " · ", fg: "muted" }
  const pin: Span[] = entry?.marked ? [dot, { text: "pinned for today", fg: "primary" }] : []
  const found = itemAt(data, entry)
  if (!found || !entry) return wrap(EMPTY[tab].detail, Math.max(1, width)).map((text): Line => [{ text, fg: "muted" }])
  if (tab === "attention") {
    const item = found as AttentionItem
    return [
      title(item.title),
      meta([{ text: item.kind, fg: KIND_TONE[item.kind], bold: true }, dot, { text: item.project, fg: "muted" }, dot, { text: `waiting ${relativeTime(now, item.since)}`, fg: "warning" }, ...pin]),
      ...gap,
      ...field("why", item.explain, width),
      ...field("next", item.next, width, "text"),
      keysRow(entry, width),
      linkRow(item.link, width),
      ...section("history", eventRows(item.history, width, now)),
      ...section("evidence", evidenceRows(item.evidence, width)),
    ]
  }
  if (tab === "pickup") {
    const item = found as PickupItem
    return [
      title(item.title),
      meta([{ text: item.state, fg: STATE_TONE[item.state], bold: true }, dot, { text: item.project, fg: "muted" }, dot, { text: `left ${ago(now, item.leftAt)}`, fg: "muted" }, ...pin]),
      ...gap,
      ...field("left off", item.leftOff, width),
      ...field("next", item.next, width, "text"),
      keysRow(entry, width),
      linkRow(item.link, width),
      ...section("history", eventRows(item.history, width, now)),
      ...section("evidence", evidenceRows(item.evidence, width)),
    ]
  }
  const item = found as MemoryProposal
  const diff = (sign: "-" | "+", text: string, fg: ColorName): Line[] => wrap(text.replace(/\s+/g, " ").trim(), Math.max(1, width - 4)).map((part, i): Line => [{ text: "  " }, { text: i === 0 ? `${sign} ` : "  ", fg, bold: true }, { text: part, fg }])
  return [
    title(item.title),
    meta([{ text: item.kind, fg: PROPOSAL_TONE[item.kind], bold: true }, dot, { text: item.run ? `Dream ${item.run}` : "from the agent", fg: "muted" }, dot, { text: ago(now, item.at), fg: "muted" }, ...pin]),
    ...gap,
    ...(dense ? [] : [...field("why", item.why, width), []]),
    heading("before → after"),
    ...(dense && item.before.length > 1 ? [...diff("-", item.before[0]!, "error"), [{ text: `    … and ${item.before.length - 1} more`, fg: "muted" } as Span]] : item.before.flatMap((text) => diff("-", text, "error"))),
    ...(item.after ? diff("+", item.after, "success") : [[{ text: "  (the memory is archived, nothing replaces it)", fg: "muted" } as Span]]),
    ...gap,
    ...field("next", item.next, width, "text"),
    keysRow(entry, width),
    linkRow(item.link, width),
    ...section("evidence", evidenceRows(item.evidence, width)),
  ]
}

/** What accepting a group does, in the words the detail shows. */
export function triageActionText(action: TodayTriageAction, count: number): string {
  return {
    review: `go through the ${plural(count, "row")} one by one (lists only them; each one stays your call)`,
    mark: `pin the ${plural(count, "row")} for today (runs nothing, changes nothing)`,
    memory: "open /memory to review them together (A or X there approve or reject the list, after you press y)",
    wait: "nothing to do now; accepting only sets the group aside",
  }[action]
}
const ACTION_LABEL: Record<TodayTriageAction, string> = { review: "one by one", mark: "pin for today", memory: "review in /memory", wait: "nothing now" }
const ACTION_TONE: Record<TodayTriageAction, ColorName> = { review: "info", mark: "primary", memory: "warning", wait: "muted" }

function triageRows(input: { data: TodayData; triage: TodayTriageView; width: number; capacity: number; glyphs: Glyphs }): Line[] {
  const { triage, width, glyphs } = input
  if (triage.status === "running") return [[{ text: "grouping the rows…", fg: "text", bold: true }], [{ text: `${plural(triage.sent, "row")} sent in one call; nothing runs until you accept a group`, fg: "muted" }]]
  if (triage.status === "error") return [[{ text: "triage failed", fg: "error", bold: true }], ...wrap(triage.message ?? "the model did not answer", width).map((text): Line => [{ text, fg: "muted" }]), [], [{ text: "t tries again · esc back to the rows", fg: "muted" }]]
  if (!triage.groups.length) return [[{ text: "no groups", fg: "text", bold: true }], [{ text: "the model found nothing worth handling together", fg: "muted" }]]
  const selected = clamp(triage.selected, triage.groups.length)
  const visible = Math.max(1, Math.floor((input.capacity + 1) / 3))
  const offset = Math.max(0, Math.min(selected - visible + 1, triage.groups.length - visible))
  return triage.groups.slice(offset, offset + visible).flatMap((group, i): Line[] => {
    const index = offset + i
    const active = index === selected
    const done = triage.accepted.includes(index)
    const marker: Span = active ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " }
    const state: Line = done ? [{ text: `${glyphs.ok} accepted`, fg: "success" }] : [{ text: ACTION_LABEL[group.action], fg: ACTION_TONE[group.action] }]
    return [
      spread([marker, { text: truncateEnd(group.title, Math.max(1, width - 4 - lineText(state))), fg: active ? "primary" : "text", bold: active }], state, width),
      [{ text: "  " }, { text: truncateEnd(group.reason || `${plural(group.ids.length, "row")}`, Math.max(1, width - 2)), fg: "muted" }],
      ...(i < visible - 1 ? [[] as Line] : []),
    ]
  })
}

function triageDetail(input: { data: TodayData; triage: TodayTriageView; width: number }): Line[] {
  const { data, triage, width } = input
  const group = triage.groups[clamp(triage.selected, triage.groups.length)]
  if (triage.status !== "ready" || !group) return wrap("The model only proposes. It never approves a command, accepts or rejects a memory, or pins a row by itself.", Math.max(1, width)).map((text): Line => [{ text, fg: "muted" }])
  const titles = new Map(TODAY_TABS.flatMap((tab) => entriesOfTab(data, tab)).map((entry) => [entry.key, entry]))
  const example = titles.get(group.example)
  const done = triage.accepted.includes(clamp(triage.selected, triage.groups.length))
  return [
    [{ text: truncateEnd(group.title, width), fg: "text", bold: true }],
    clip([{ text: plural(group.ids.length, "row"), fg: "muted" }, { text: " · ", fg: "muted" }, { text: ACTION_LABEL[group.action], fg: ACTION_TONE[group.action], bold: true }, ...(done ? [{ text: " · accepted", fg: "success" as const }] : [])], width),
    [],
    ...field("why", group.reason || "no reason given", width),
    ...field("accept", triageActionText(group.action, group.ids.length), width, "text"),
    ...(example ? field("example", `${example.row.title} — ${example.row.why}`, width) : []),
    clip([{ text: "keys".padEnd(LABEL_WIDTH), fg: "muted" }, { text: "a ", fg: "text", bold: true }, { text: "accept", fg: "body" }, { text: " · ", fg: "muted" }, { text: "enter ", fg: "text", bold: true }, { text: "list its rows", fg: "body" }], width),
    ...section("rows", group.ids.slice(0, 12).map((key): Line => {
      const entry = titles.get(key)
      return clip([{ text: "  · ", fg: "muted" }, { text: entry ? `${tabLabel(entry.tab)}: ${entry.row.title}` : key, fg: "body" }], width)
    })),
    ...(group.ids.length > 12 ? [[{ text: `    … and ${group.ids.length - 12} more`, fg: "muted" } as Span]] : []),
  ]
}

function hintsOf(state: TodayState, entry: Entry | undefined): string {
  if (state.help) return "↑↓ select · [ ] scroll · ? hide keys · esc back"
  if (state.triage?.open) return state.triage.status === "ready" ? "↑↓ group · a accept · enter list rows · t again · esc rows" : "t try again · esc rows"
  return [entry ? `enter ${enterVerb(entry.link)}` : "", entry ? (entry.marked ? "m unpin" : "m pin for today") : "", "t triage", "? keys", state.filter ? "esc all rows" : "esc back"].filter(Boolean).join(" · ")
}

/** Renders exactly `height` lines of at most `width` cells. */
export function renderTodayPage(input: { data: TodayData; state: TodayState; width: number; height: number; now: number; glyphs?: Glyphs }): Line[] {
  const { data, state, width, height, now } = input
  const glyphs = input.glyphs ?? defaultGlyphs()
  const tab = state.tab
  const entries = entriesOf(data, tab, state)
  const counts = Object.fromEntries(TODAY_TABS.map((name) => [name, name === tab ? entries.length : entriesOf(data, name, state).length])) as Record<TodayTab, number>
  const selected = clamp(state.selected, entries.length)
  const entry = entries[selected]
  const triage = state.triage?.open ? state.triage : undefined
  const marked = (state.marks ?? []).filter((key) => TODAY_TABS.some((name) => key.startsWith(`${name}:`) && entriesOfTab(data, name).some((row) => row.key === key))).length
  const right = state.filter ? `group: ${state.filter.title}` : `since ${ago(now, data.summary.lastVisit)} · ${plural(data.summary.projects, "project")}`
  const padded = height >= PADDED_HEIGHT
  const notes = wrap((data.notes ?? []).join(" "), Math.max(1, width)).slice(0, 2).filter(Boolean).map((text): Line => [{ text, fg: "muted" }])
  const lead = triage ? triageLead(triage, data) : todaySummary(data, now, marked)
  const paragraph = [...(padded ? [[]] : []), ...wrap(lead, Math.max(1, width)).slice(0, 2).map((text): Line => [{ text, fg: "body" }]), ...(triage ? [] : notes)]
  const room = Math.max(0, height - 2 - paragraph.length - 1)
  const chrome = padded ? 4 : 2
  const split = isWide(width) && height >= 24
  const capacityOf = () => (split ? room : Math.ceil((room - 1) * 0.45)) - chrome
  const listBody = (w: number): Line[] => {
    if (triage) return triageRows({ data, triage, width: w, capacity: capacityOf(), glyphs })
    const meaning: Line[] = [[{ text: truncateEnd(TAB_MEANING[tab], w), fg: "muted" }], []]
    const capacity = capacityOf() - meaning.length
    const head: Line[] = tab === "memory" && data.dream && !state.filter ? [[{ text: `Dream ${data.dream.run} · ${ago(now, data.dream.at)}`, fg: "text" }], ...wrap(data.dream.summary, w).map((text): Line => [{ text, fg: "muted" }]), []] : []
    const shown = head.length && capacity >= head.length + MIN_TWO_LINE_ROWS ? head : []
    return [...meaning, ...shown, ...listRows({ rows: entries, selected, width: w, capacity: capacity - shown.length, now, glyphs, tab, filtered: !!state.filter })]
  }
  const listTitle = triage ? `Triage${triage.status === "ready" ? ` · ${plural(triage.groups.length, "group")}` : ""}` : tab === "memory" ? "Proposals" : tabLabel(tab)
  const list = { title: listTitle, active: true, weight: 3, body: listBody }
  const detail = state.help
    ? { title: "Keys", weight: 4, body: (w: number): Line[] => keysRows(w) }
    : triage
      ? { title: "Group", weight: 4, scroll: state.scroll ?? 0, body: (w: number): Line[] => triageDetail({ data, triage, width: w }) }
      : { title: "Detail", weight: 4, scroll: state.scroll ?? 0, body: (w: number): Line[] => detailRows({ data, entry, tab, width: w, now, dense: !padded }) }
  const top = Math.ceil((room - 1) * 0.45)
  const grid = panelGrid({ width, rows: split ? [[list, detail]] : [[list], [detail]], heights: split ? [room] : [top, Math.max(0, room - top - 1)], compact: false, padding: padded, maxColumns: split ? 2 : 1 })
  const frame = pickerFrame(triage ? "Today · Triage" : "Today", hintsOf(state, entry), width, height, [...paragraph, [], ...grid])
  if (frame.length > 1) frame[1] = todayTabsRow({ counts, active: TODAY_TABS.indexOf(tab), right, width })
  return frame
}

function triageLead(triage: TodayTriageView, data: TodayData): string {
  const total = data.attention.length + data.pickup.length + data.memory.length
  if (triage.status === "running") return `Asking ${triage.model ?? "the cheap model"} to group ${plural(triage.sent, "row")}. One call; it only proposes.`
  if (triage.status === "error") return `Triage did not finish${triage.model ? ` (${triage.model})` : ""}. Your rows are unchanged.`
  const grouped = new Set(triage.groups.flatMap((group) => group.ids)).size
  return `${triage.model ?? "The cheap model"} grouped ${grouped} of ${plural(total, "row")} in one call. It only proposes: approvals, memory decisions and pins stay yours.`
}

/** Row two, as /profiles draws it: the numbered tabs on the left, the page's summary after them. */
function todayTabsRow(input: { counts: Record<TodayTab, number>; active: number; right: string; width: number }): Line {
  const { width } = input
  const tabs = tabsRow(pageTabs(input.counts), input.active, Math.max(1, width < 100 ? width : Math.floor(width * 0.55)))
  const right = truncateEnd(input.right, Math.max(0, width - lineWidth(tabs) - 2))
  return fit(right ? spread(tabs, [{ text: right, fg: "muted" }], width) : tabs, width)
}

const KEYS: ReadonlyArray<readonly [string, string]> = [
  ["↑↓ j k", "select"], ["1 2 3 tab", "switch tab"], ["enter", "open where it is managed"], ["m", "pin or unpin for today (until midnight; runs nothing)"],
  ["t", "triage: one cheap-model call groups the rows; you accept per group"], ["[ ]", "scroll the detail"], ["r", "reload"], ["esc q", "back"], ["?", "hide keys"],
]

/** The `?` section: every key and what it does, the meanings in one column. */
function keysRows(width: number): Line[] {
  const keyWidth = Math.max(...KEYS.map(([key]) => textWidth(key))) + 2
  return KEYS.flatMap(([key, meaning]) => wrap(meaning, Math.max(1, width - keyWidth)).map((part, i) => clip([{ text: (i ? "" : key).padEnd(keyWidth), fg: "text", bold: true }, { text: part, fg: "muted" }], width)))
}

export type TodayAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "reload" }
  | { type: "open"; link: TodayLink }
  /** Pin (`on`) or unpin rows for today: the app stores the keys; nothing else changes. */
  | { type: "mark"; keys: string[]; on: boolean }
  /** Ask the cheap model to group the rows (only on `t`). */
  | { type: "triage" }
export type TodayKeyResult = { state: TodayState; action: TodayAction }
const UP = new Set(["\x1b[A", "\x1bOA", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "j"])

/** Sets the pins in the state the same way the app stores them, so the list moves at once. */
export function withMarks(state: TodayState, keys: string[], on: boolean): TodayState {
  const current = state.marks ?? []
  const marks = on ? [...current.filter((key) => !keys.includes(key)), ...keys].slice(-50) : current.filter((key) => !keys.includes(key))
  return { ...state, marks }
}

/** `[` and `]` move the detail (or the triage group) panel by four rows. */
const scrolled = (state: TodayState, key: "[" | "]"): TodayState => ({ ...state, scroll: Math.max(0, (state.scroll ?? 0) + (key === "]" ? 4 : -4)) })

function triageKey(state: TodayState, triage: TodayTriageView, key: string): TodayKeyResult {
  const none = { state, action: { type: "none" } } as const
  const set = (next: Partial<TodayTriageView>, extra: Partial<TodayState> = {}): TodayState => ({ ...state, ...extra, triage: { ...triage, ...next } })
  if (key === "\x1b" || key === "q") return { state: set({ open: false }), action: { type: "none" } }
  if (key === "t" && triage.status !== "running") return { state, action: { type: "triage" } }
  if (key === "[" || key === "]") return { state: scrolled(state, key), action: { type: "none" } }
  if (triage.status !== "ready" || !triage.groups.length) return none
  const selected = clamp(triage.selected, triage.groups.length)
  if (UP.has(key) || DOWN.has(key)) {
    const next = clamp(selected + (UP.has(key) ? -1 : 1), triage.groups.length)
    return next === selected ? none : { state: set({ selected: next }, { scroll: 0 }), action: { type: "none" } }
  }
  const group = triage.groups[selected]!
  const accepted = triage.accepted.includes(selected) ? triage.accepted : [...triage.accepted, selected]
  const listRowsOf = (accept: boolean): TodayKeyResult => {
    const first = TODAY_TABS.find((tab) => group.ids.some((id) => id.startsWith(`${tab}:`))) ?? state.tab
    return { state: { ...set({ open: false, ...(accept ? { accepted } : {}) }), tab: first, selected: 0, scroll: 0, filter: { title: group.title, keys: group.ids } }, action: { type: "none" } }
  }
  if (key === "\r" || key === "\n") return listRowsOf(false)
  if (key !== "a") return none
  if (group.action === "review") return listRowsOf(true)
  if (group.action === "mark") return { state: withMarks(set({ accepted }), group.ids, true), action: { type: "mark", keys: group.ids, on: true } }
  if (group.action === "memory") return { state: set({ accepted }), action: { type: "open", link: { command: "/memory" } } }
  return { state: set({ accepted }), action: { type: "none" } }
}

/** One raw key. Moving or switching resets the detail scroll; the same state object comes back when nothing changed. */
export function todayPageKey(state: TodayState, key: string, data: TodayData): TodayKeyResult {
  const none = { state, action: { type: "none" } } as const
  if (state.triage?.open && !state.help) return triageKey(state, state.triage, key)
  const tabIndex = TODAY_TABS.indexOf(state.tab)
  const entries = entriesOf(data, state.tab, state)
  const count = entries.length
  const selected = clamp(state.selected, count)
  if (key === "\x1b" && state.filter) { const { filter: _filter, ...rest } = state; return { state: { ...rest, selected: 0, scroll: 0 }, action: { type: "none" } } }
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  if (key === "r") return { state, action: { type: "reload" } }
  if (key === "?") return { state: { ...state, help: !state.help }, action: { type: "none" } }
  if (key === "t") return state.triage && state.triage.status !== "error" ? { state: { ...state, help: false, scroll: 0, triage: { ...state.triage, open: true } }, action: { type: "none" } } : { state: { ...state, help: false }, action: { type: "triage" } }
  if (key === "[" || key === "]") return { state: scrolled(state, key), action: { type: "none" } }
  const tab = /^[1-3]$/.test(key) ? TODAY_TABS[Number(key) - 1] : key === "\t" ? TODAY_TABS[(tabIndex + 1) % TODAY_TABS.length] : undefined
  if (tab) return tab === state.tab ? none : { state: { ...state, tab, selected: 0, scroll: 0 }, action: { type: "none" } }
  const move = (index: number) => (clamp(index, count) === selected ? none : { state: { ...state, selected: clamp(index, count), scroll: 0 }, action: { type: "none" } } as TodayKeyResult)
  if (UP.has(key)) return move(selected - 1)
  if (DOWN.has(key)) return move(selected + 1)
  const entry = entries[selected]
  if (key === "m" && entry) {
    const on = !entry.marked
    const next = withMarks(state, [entry.key], on)
    // The row moves into or out of "Today": the selection follows it.
    const index = entriesOf(data, state.tab, next).findIndex((row) => row.key === entry.key)
    return { state: { ...next, selected: Math.max(0, index) }, action: { type: "mark", keys: [entry.key], on } }
  }
  if ((key === "\r" || key === "\n") && entry) return { state, action: { type: "open", link: entry.link } }
  return none
}
