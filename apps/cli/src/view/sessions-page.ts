import type { SessionSummary } from "@mendcode/protocol"
import { SESSION_COLORS, type SessionColor } from "@mendcode/protocol/wire"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { isCompact, isWide } from "../ui/breakpoints"
import { fit, panelGrid, spread } from "./deck"
import { pickerFrame } from "./picker-frame"
import { readablePreview } from "./reply-comments"
import { kvList } from "./page"
import { draftSizeLabel, labelString, sessionActivityAt, sessionLabel } from "./session-label"
import { abbreviateHome, groupSessions, listedSessions, orderSessions, relativeTime, timeAgo, viewOf, type SessionGroup, type SessionListAction, type SessionListState } from "./session-list"
import { isDraftOnly, nestingDepths, nextSort, parseSessionQuery, parseTagDraft, type SessionScope } from "./session-query"
import { cells, shortenMiddle, takeCellSlice as takeCells, textWidth, truncateEnd, wrap } from "./wrap"

/**
 * /sessions: a search row on top (typing searches title, folder and id at once), sessions grouped by folder, the selected
 * one's facts beside them when wide, a folder picker on Tab and every key behind `?`. Loaded when the page first opens.
 */

const HINT_RENAME = "enter confirm · esc cancel"
const HINT_TAG = "words are tags · color:red (or color:none) · enter confirm · esc cancel"
const HINT_DELETE = "d/y confirm · esc cancel"
const HINT_FOLDERS = "type to filter · ↑↓ folder · enter pick · esc back"
export const SEARCH_PLACEHOLDER = "Search sessions, folders or ids"
const FOLDER_PLACEHOLDER = "Type part of a folder path"
/** Every key of the page, for the `?` section. */
const PAGE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["↑↓", "select"], ["pgup pgdn", "page"], ["home end", "first, last"], ["enter", "open"], ["type", "search title, folder, id"], ["tab", "pick a folder"],
  ["^L", "this folder, all"], ["^B", "pin"], ["^A", "settle, restore"], ["^O", "show settled"], ["^R", "rename"], ["^T", "tags, color"],
  ["^D", "delete"], ["^S", "sort"], ["^E", "named only"], ["^F", "search messages"], ["esc", "clear, back"], ["?", "hide keys"],
]
/** How each color mark is drawn: a theme role, so every theme keeps the marks apart and readable. */
const MARK_COLORS: Record<SessionColor, ColorName> = { red: "error", orange: "warning", yellow: "code", green: "success", cyan: "info", blue: "link", purple: "accent", pink: "heading" }
const WIDE_HEIGHT = 30
const MAX_TITLE = 200
const MAX_QUERY = 200
const PAGE_STEP = 10
const WORKING = new Set(["generating", "tool", "compacting", "cancelling"])
const NONE: SessionListAction = { type: "none" }
const CHANGED: SessionListAction = { type: "changed" }

const UP = new Set(["\x1b[A", "\x1bOA", "\x10"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e"])
const PAGE_UP = new Set(["\x1b[5~"])
const PAGE_DOWN = new Set(["\x1b[6~"])
const FIRST = new Set(["\x1b[H", "\x1bOH", "\x1b[1~"])
const LAST = new Set(["\x1b[F", "\x1bOF", "\x1b[4~"])

function isPrintable(key: string) {
  if (key.length === 0) return false
  for (const char of key) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) return false
  }
  return true
}

const clampIndex = (index: number, length: number) => Math.max(0, Math.min(index, length - 1))

/** The selected row: the session `selectedId` names while it is listed (a push that reorders the list keeps it), else the position. */
export function selectedIndex(state: Pick<SessionListState, "selected" | "selectedId">, visible: readonly SessionSummary[]): number {
  const at = state.selectedId === undefined ? -1 : visible.findIndex((session) => session.sessionId === state.selectedId)
  return at >= 0 ? at : clampIndex(state.selected, visible.length)
}

/** A typed query never starts with `/`: the key that means "search" elsewhere only focuses this always-open row. */
const cleanQuery = (text: string) => text.replace(/^\/+/, "").slice(0, MAX_QUERY)

/** One folder of the picker; `directory` undefined is "All folders". */
export type FolderEntry = { directory?: string; count: number }

/** The folders the picker offers: all folders, then this folder, the picked one and every listed folder by latest activity. */
export function folderEntries(sessions: SessionSummary[], state: SessionListState): FolderEntry[] {
  const counts = new Map<string, { count: number; newest: number }>()
  for (const session of listedSessions(sessions, state)) {
    if (isDraftOnly(session) || (!state.archived && session.archivedAt !== undefined)) continue
    const entry = counts.get(session.directory) ?? { count: 0, newest: 0 }
    counts.set(session.directory, { count: entry.count + 1, newest: Math.max(entry.newest, sessionActivityAt(session)) })
  }
  for (const pinned of [state.origin, state.directory]) if (pinned && !counts.has(pinned)) counts.set(pinned, { count: 0, newest: 0 })
  const folders = [...counts.entries()].sort(([a, x], [b, y]) => Number(b === state.origin) - Number(a === state.origin) || y.newest - x.newest || a.localeCompare(b))
  const query = (state.folders?.query ?? "").trim().toLowerCase().replace(/^~/, "")
  const total = [...counts.values()].reduce((sum, entry) => sum + entry.count, 0)
  return [
    ...(query ? [] : [{ count: total }]),
    ...folders.filter(([directory]) => !query || directory.toLowerCase().includes(query)).map(([directory, entry]) => ({ directory, count: entry.count })),
  ]
}

/**
 * Handles one raw key. Returns a new state object only when something changed. Rename is ctrl+r and
 * delete ctrl+d because plain letters already type into the filter. `currentSessionId` is the open
 * session, which cannot be deleted from here.
 */
export function sessionListKey(
  state: SessionListState,
  key: string,
  sessions: SessionSummary[],
  currentSessionId?: string,
): { state: SessionListState; action: SessionListAction } {
  const { edit, note: _note, ...rest } = state
  const bare: SessionListState = rest
  if (edit?.mode === "rename" || edit?.mode === "tag") return renameKey({ state: bare, edit, key })
  if (edit?.mode === "delete") {
    if (key === "d" || key === "y") return { state: bare, action: { type: "delete", sessionId: edit.sessionId } }
    return { state: bare, action: CHANGED }
  }
  const cleared = state.note === undefined ? state : bare
  const result = state.folders ? folderKey(cleared, key, sessions) : browseKey(cleared, key, sessions, currentSessionId)
  if (result.state === cleared && cleared !== state) return { state: cleared, action: CHANGED }
  return result
}

/** One-line editing of a rename or tag draft. */
function renameKey(input: { state: SessionListState; edit: Extract<SessionListState["edit"], { mode: "rename" | "tag" }>; key: string }): { state: SessionListState; action: SessionListAction } {
  const { state, edit, key } = input
  if (!edit) return { state, action: NONE }
  if (key === "\x1b") return { state, action: CHANGED }
  if (key === "\r" || key === "\n") {
    if (edit.mode === "tag") {
      const { tags, color } = parseTagDraft(edit.draft)
      if (color && !SESSION_COLORS.includes(color as SessionColor)) return { state: { ...state, edit, note: `colors: ${SESSION_COLORS.join(" ")}` }, action: CHANGED }
      return { state, action: { type: "tag", sessionId: edit.sessionId, tags, color: color as SessionColor | null | undefined } }
    }
    const title = edit.draft.trim()
    return { state, action: title ? { type: "rename", sessionId: edit.sessionId, title } : CHANGED }
  }
  if (key === "\x7f" || key === "\b") return { state: { ...state, edit: { ...edit, draft: Array.from(edit.draft).slice(0, -1).join("") } }, action: CHANGED }
  if (key === "\x15") return { state: { ...state, edit: { ...edit, draft: "" } }, action: CHANGED }
  if (!isPrintable(key) || Array.from(edit.draft + key).length > MAX_TITLE) return { state: { ...state, edit }, action: NONE }
  return { state: { ...state, edit: { ...edit, draft: edit.draft + key } }, action: CHANGED }
}

/** The folder picker: typing filters the folders, Enter shows the picked one's sessions (or every folder's), Esc goes back. */
function folderKey(state: SessionListState, key: string, sessions: SessionSummary[]): { state: SessionListState; action: SessionListAction } {
  const picker = state.folders!
  const entries = folderEntries(sessions, state)
  const at = clampIndex(picker.selected, entries.length)
  const { folders: _closed, ...closed } = state
  const edited = (query: string) => ({ state: { ...state, folders: { ...picker, query: query.slice(0, MAX_QUERY), selected: 0 } }, action: CHANGED })
  if (UP.has(key) || DOWN.has(key)) {
    const next = clampIndex(at + (UP.has(key) ? -1 : 1), entries.length)
    return next === picker.selected ? { state, action: NONE } : { state: { ...state, folders: { ...picker, selected: next } }, action: CHANGED }
  }
  // Back to the list as it was: a folder's list is asked of the daemon again.
  if (key === "\x1b" || key === "\t") return picker.back === "project" ? { state: { ...closed, scope: "project" }, action: { type: "reload" } } : { state: closed, action: CHANGED }
  if (key === "\r" || key === "\n") {
    const entry = entries[at]
    if (!entry) return { state, action: NONE }
    const { selectedId: _id, ...unselected } = closed
    if (entry.directory === undefined) return { state: { ...unselected, selected: 0, scope: "all" }, action: state.scope === "all" ? CHANGED : { type: "reload" } }
    return { state: { ...unselected, selected: 0, scope: "project", directory: entry.directory }, action: { type: "reload" } }
  }
  if (key === "\x7f" || key === "\b") return picker.query ? edited(Array.from(picker.query).slice(0, -1).join("")) : { state, action: NONE }
  if (key === "\x15") return picker.query ? edited("") : { state, action: NONE }
  if (isPrintable(key)) return edited(picker.query + key)
  return { state, action: NONE }
}

function browseKey(state: SessionListState, key: string, sessions: SessionSummary[], currentSessionId?: string): { state: SessionListState; action: SessionListAction } {
  const visible = orderSessions(listedSessions(sessions, state), state.filter, currentSessionId, state.archived, viewOf(state))
  const current = selectedIndex(state, visible)
  const target = visible[current]
  const moveTo = (index: number) => {
    const next = clampIndex(index, visible.length)
    const session = visible[next]
    if (!session || next === current) return { state, action: NONE }
    return { state: { ...state, selected: next, selectedId: session.sessionId }, action: CHANGED }
  }
  const { selectedId: _id, ...unselected } = state
  /** A new filter text: the selection goes back to the top and the daemon is asked past the loaded page (and in the messages when on). */
  const retyped = (filter: string) => {
    if (filter === state.filter) return { state, action: NONE }
    const { hits: _stale, ...kept } = unselected
    return { state: { ...(state.content ? kept : unselected), selected: 0, filter }, action: { type: "search" } as const }
  }
  const toggled = (change: Partial<SessionListState>) => ({ state: { ...unselected, selected: 0, ...change }, action: CHANGED })

  if (UP.has(key)) return moveTo(current - 1)
  if (DOWN.has(key)) return moveTo(current + 1)
  if (PAGE_UP.has(key)) return moveTo(current - PAGE_STEP)
  if (PAGE_DOWN.has(key)) return moveTo(current + PAGE_STEP)
  if (FIRST.has(key)) return moveTo(0)
  if (LAST.has(key)) return moveTo(visible.length - 1)
  if (key === "\x1b") {
    if (state.filter) return retyped("")
    if (state.keys) return { state: { ...state, keys: false }, action: CHANGED }
    return { state, action: { type: "close" } }
  }
  // The picker lists every project's folders: a folder's list is swapped for all projects' while it is open.
  if (key === "\t") {
    const folder = state.scope === "project" && state.directory !== undefined
    const entries = folderEntries(sessions, { ...state, folders: { query: "", selected: 0 } })
    const at = folder ? entries.findIndex((entry) => entry.directory === state.directory) : 0
    return { state: { ...state, scope: "all", folders: { query: "", selected: Math.max(0, at), ...(folder ? { back: "project" as const } : {}) } }, action: folder ? { type: "reload" } : CHANGED }
  }
  if (key === "?" && !state.filter) return { state: { ...state, keys: !state.keys }, action: CHANGED }
  if (key === "\x0f") return { state: { ...unselected, selected: 0, archived: !state.archived }, action: { type: "reload" } }
  if (key === "\x01") return target ? { state, action: { type: "archive", sessionId: target.sessionId, restore: target.archivedAt !== undefined } } : { state, action: NONE }
  if (key === "\x02") return target ? { state, action: { type: "pin", sessionId: target.sessionId, pinned: target.lifecycle?.pinnedAt === undefined } } : { state, action: NONE }
  if (key === "\x12") {
    if (!target) return { state, action: NONE }
    return { state: { ...state, edit: { mode: "rename", sessionId: target.sessionId, draft: target.title } }, action: CHANGED }
  }
  if (key === "\x14") {
    if (!target) return { state, action: NONE }
    const own = [...(target.tags ?? []), ...(target.color ? [`color:${target.color}`] : [])].join(" ")
    return { state: { ...state, edit: { mode: "tag", sessionId: target.sessionId, draft: own } }, action: CHANGED }
  }
  if (key === "\x13") return toggled({ sort: nextSort(state.sort) })
  // The folder's list holds its child sessions too, every project's only the top ones: the daemon is asked again.
  if (key === "\x0c") {
    const scope: SessionScope = state.scope === "project" ? "all" : "project"
    return state.directory ? { state: { ...unselected, selected: 0, scope }, action: { type: "reload" } } : toggled({ scope })
  }
  if (key === "\x05") return toggled({ named: !state.named })
  if (key === "\x06") {
    const { hits: _hits, ...kept } = unselected
    return state.content ? { state: { ...kept, selected: 0, content: false }, action: CHANGED } : { state: { ...unselected, selected: 0, content: true }, action: { type: "search" } }
  }
  if (key === "\x04") {
    if (!target) return { state, action: NONE }
    if (target.sessionId === currentSessionId) return { state: { ...state, note: "can't delete the open session" }, action: CHANGED }
    return { state: { ...state, edit: { mode: "delete", sessionId: target.sessionId } }, action: CHANGED }
  }
  if (key === "\r" || key === "\n") return target ? { state, action: { type: "open", sessionId: target.sessionId } } : { state, action: NONE }
  if (key === "\x7f" || key === "\b") return state.filter ? retyped(Array.from(state.filter).slice(0, -1).join("")) : { state, action: NONE }
  if (key === "\x15") return state.filter ? retyped("") : { state, action: NONE }
  if (isPrintable(key)) return retyped(cleanQuery(state.filter + key))
  return { state, action: NONE }
}

// ── Drawing ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

function clampLine(line: Line, width: number): Line {
  const out: Line = []
  let used = 0
  for (const span of line) {
    const w = textWidth(span.text)
    if (used + w <= width) {
      out.push(span)
      used += w
      continue
    }
    const text = truncateEnd(span.text, width - used)
    if (text) out.push({ ...span, text })
    break
  }
  return out
}

/** Static state marker: no timers, so "working" is a steady primary dot. */
function stateDot(session: SessionSummary, glyphs: Glyphs): Span {
  if (WORKING.has(session.state)) return { text: glyphs.running, fg: "primary" }
  if (session.state === "waiting_approval") return { text: glyphs.ask, fg: "warning", bold: true }
  if (session.state === "error") return { text: glyphs.fail, fg: "error" }
  if (session.state === "queued") return { text: glyphs.queue, fg: "muted" }
  return { text: "·", fg: "muted" }
}

/** `Active · ~/Code/app (3)`: the folder reads first in the heading color, the section and count are muted. */
function groupHeader(group: SessionGroup, width: number, home?: string): Line {
  const section = `${group.section ?? "Active"} · `
  const count = ` (${group.sessions.length})`
  const folder = shortenMiddle(abbreviateHome(group.directory, home), Math.max(1, width - textWidth(section) - textWidth(count)))
  return clampLine([{ text: section, fg: "muted", bold: true }, { text: folder, fg: "heading", bold: true }, { text: count, fg: "muted" }], width)
}

type RowInput = { session: SessionSummary; selected: boolean; current: boolean; width: number; now: number; glyphs: Glyphs; depth?: number }

function sessionRow({ session, selected, current, width, now, glyphs, depth = 0 }: RowInput): Line {
  // A child session sits under its parent: two cells per level, then the branch mark.
  const nest: Span[] = depth > 0 ? [{ text: `${"  ".repeat(Math.min(depth, 4) - 1)}↳ `, fg: "muted" }] : []
  const marker: Span = selected ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " }
  const dot = stateDot(session, glyphs)
  const time = relativeTime(now, sessionActivityAt(session))
  const queued = session.queued > 0 ? ` +${session.queued}` : ""
  const label = session.archivedAt !== undefined ? "archived" : session.state === "waiting_approval" ? "needs approval" : ""
  const right = `${label ? `${label} ` : ""}${queued ? `${queued.trim()} ` : ""}${time}`
  const mark: Span[] = session.color ? [{ text: "● ", fg: MARK_COLORS[session.color] }] : []
  const prefixWidth = 2 + (nest[0] ? textWidth(nest[0].text) : 0) + textWidth(dot.text) + 1 + mark.length * 2
  const room = Math.max(0, width - prefixWidth - textWidth(right) - 1)
  const named = sessionLabel(session, { untitled: "untitled", marker: "draft" })
  const rawTitle = `${labelString(named)}${session.lifecycle?.pr ? ` #${session.lifecycle.pr.number}` : ""}`
  const suffix = current ? " (current)" : ""
  const showSuffix = suffix && textWidth(rawTitle) + textWidth(suffix) <= room
  const title = truncateEnd(rawTitle, showSuffix ? room - textWidth(suffix) : room)
  const tagText = session.tags?.length ? ` ${session.tags.map((tag) => `#${tag}`).join(" ")}` : ""
  const showTags = tagText !== "" && textWidth(title) + (showSuffix ? textWidth(suffix) : 0) + textWidth(tagText) <= room
  const used = textWidth(title) + (showSuffix ? textWidth(suffix) : 0) + (showTags ? textWidth(tagText) : 0)
  const pad = Math.max(1, width - prefixWidth - used - textWidth(right))
  // A draft's marker is muted and its words are the row's text; cut short, the words give way first.
  const lead = named.marker ? `${named.marker} · ` : ""
  const titleSpans: Span[] = lead && title.startsWith(lead) ? [{ text: lead, fg: "muted", bold: selected }, { text: title.slice(lead.length), fg: "text", bold: selected }] : [{ text: title, fg: named.placeholder || lead ? "muted" : "text", bold: selected }]
  const line: Line = [marker, ...nest, dot, { text: " " }, ...mark, ...titleSpans]
  if (showSuffix) line.push({ text: suffix, fg: "muted" })
  if (showTags) line.push({ text: tagText, fg: "info" })
  line.push({ text: " ".repeat(pad) })
  if (label) line.push({ text: `${label} `, fg: session.archivedAt !== undefined ? "muted" : "warning", bold: true })
  if (queued) line.push({ text: `${queued.trim()} `, fg: "muted" })
  line.push({ text: time, fg: "muted" })
  return clampLine(line, width)
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** The selected session's detail column: its title, folder, and the facts as label/value rows. */
function detailRows({ session, width, now, home, snippet }: { session: SessionSummary; width: number; now: number; home: string | undefined; snippet?: string | undefined }): Line[] {
  const named = sessionLabel(session, { untitled: "untitled", marker: "draft" })
  const at = sessionActivityAt(session)
  const facts = [
    ...(session.lifecycle?.pr ? [{ label: "PR", value: `#${session.lifecycle.pr.number} ${session.lifecycle.pr.state.toLowerCase()}` }] : []),
    ...(session.lifecycle?.settledReason ? [{ label: "settled", value: session.lifecycle.settledReason }] : []),
    ...(session.tags?.length ? [{ label: "tags", value: session.tags.map((tag) => `#${tag}`).join(" ") }] : []),
    ...(session.color ? [{ label: "color", value: session.color }] : []),
    { label: "state", value: session.state, ...(session.state === "error" ? { tone: "error" as const } : {}) },
    ...(session.draft ? [{ label: "draft", value: draftSizeLabel(session.draft) }] : []),
    { label: "updated", value: timeAgo(now, at) },
    ...(session.archivedAt !== undefined ? [{ label: "archived", value: new Date(session.archivedAt).toISOString().slice(0, 10) }] : []),
    ...(session.queued > 0 ? [{ label: "queued", value: String(session.queued) }] : []),
  ]
  return [
    clampLine([{ text: truncateEnd(labelString(named), width), fg: named.placeholder ? "muted" : "text", bold: true }], width),
    clampLine([{ text: shortenMiddle(abbreviateHome(session.directory, home), width), fg: "muted" }], width),
    [],
    ...kvList(facts, width),
    [],
    clampLine([{ text: "id", fg: "muted" }], width),
    clampLine([{ text: session.sessionId, fg: "text" }], width),
    ...(snippet ? [[], clampLine([{ text: "message match", fg: "muted" }], width), ...wrap(readablePreview(snippet), width).slice(0, 4).map((text): Line => [{ text, fg: "text" }])] : []),
  ]
}

/** The always-open input row: `/` then the query and a caret, or the placeholder; a count or a folder on the right. */
function inputRow(input: { text: string; placeholder: string; right: string; width: number }): Line {
  const { text, placeholder, right, width } = input
  const lead: Line = [{ text: "/ ", fg: "primary", bold: true }]
  const body: Line = text ? [{ text, fg: "text", bold: true }, { text: "▏", fg: "primary" }] : [{ text: "▏", fg: "primary" }, { text: placeholder, fg: "muted" }]
  const left = clampLine([...lead, ...body], width)
  return right ? spread(left, [{ text: right, fg: "muted" }], width) : left
}

const rule = (width: number, glyphs: Glyphs): Line => [{ text: glyphs.rule.repeat(Math.max(0, width)), fg: "muted", dim: true }]

/** The `?` section: the keys in as many columns as fit (at most four), read down each column. */
function keysRows(width: number): Line[] {
  for (let columns = 4; columns >= 1; columns--) {
    const rows = Math.ceil(PAGE_KEYS.length / columns)
    const sets = Array.from({ length: columns }, (_, column) => PAGE_KEYS.slice(column * rows, (column + 1) * rows))
    const keyWidth = sets.map((set) => Math.max(0, ...set.map(([key]) => textWidth(key))))
    const meaningWidth = sets.map((set) => Math.max(0, ...set.map(([, meaning]) => textWidth(meaning))))
    const total = sets.reduce((sum, _, column) => sum + keyWidth[column]! + 2 + meaningWidth[column]! + (column ? 4 : 0), 1)
    if (total > width && columns > 1) continue
    return Array.from({ length: rows }, (_, row) => clampLine([{ text: " " }, ...sets.flatMap((set, column): Span[] => {
      const entry = set[row]
      if (!entry) return []
      const [key, meaning] = entry
      const gap = column ? [{ text: "    " }] : []
      const pad = column === sets.length - 1 ? "" : " ".repeat(meaningWidth[column]! - textWidth(meaning))
      return [...gap, { text: key.padEnd(keyWidth[column]! + 2), fg: "text", bold: true }, { text: meaning + pad, fg: "muted" }]
    })], width))
  }
  return []
}

/** The header keys: a few, with `?` for the rest; esc names what it does now. */
export function sessionsHints(state: SessionListState): string {
  const edit = state.edit
  if (edit?.mode === "rename") return HINT_RENAME
  if (edit?.mode === "tag") return HINT_TAG
  if (edit?.mode === "delete") return HINT_DELETE
  if (state.folders) return HINT_FOLDERS
  return ["enter open", "/ search", "tab folder", state.keys ? "? hide keys" : "? keys", state.filter ? "esc clear" : "esc back"].join(" · ")
}

/** Row two: the scope as a small toggle on the left, only the counters that are not zero on the right. */
function summaryRow(input: { state: SessionListState; shown: number; included: SessionSummary[]; width: number; home: string | undefined; glyphs: Glyphs; hasProject: boolean }): Line {
  const { state, shown, included, width, home, glyphs, hasProject } = input
  const project = state.scope === "project" && hasProject
  const folderName = state.directory && state.directory !== state.origin ? shortenMiddle(abbreviateHome(state.directory, home), 32) : "this folder"
  const option = (on: boolean, text: string): Span[] => [{ text: `${on ? glyphs.dot : glyphs.sep} `, fg: on ? "primary" : "muted", bold: on }, { text, fg: on ? "text" : "muted", bold: on }]
  const toggle: Line = [...option(project, folderName), { text: "   " }, ...option(!project, "all projects"), { text: "  ^L", fg: "muted", dim: true }]
  const working = included.filter((session) => WORKING.has(session.state)).length
  const approval = included.filter((session) => session.state === "waiting_approval").length
  const invalid = parseSessionQuery(state.filter).invalid
  const counters = [
    invalid ?? "",
    state.filter ? (shown ? `${shown} match${shown === 1 ? "" : "es"}` : "") : plural(included.length, "session"),
    working ? `${working} working` : "",
    approval ? `${approval} need${approval === 1 ? "s" : ""} approval` : "",
    state.archived ? "settled shown" : "",
    state.sort && state.sort !== "recent" ? `sort ${state.sort}` : "",
    state.named ? "named only" : "",
    state.content ? (state.hits ? `in messages ${Object.keys(state.hits).length}` : "in messages") : "",
  ].filter(Boolean).join(" · ")
  return fit(spread(toggle, [{ text: counters, fg: "muted" }], width), width)
}

/** Renders exactly `height` lines of `width` cells: the search row, then folder headers with their sessions under them. */
export function renderSessionList(input: {
  sessions: SessionSummary[]
  state: SessionListState
  currentSessionId?: string
  /** Home directory, so folder paths read `~/Code/app`. */
  home?: string
  width: number
  height: number
  now: number
  glyphs?: Glyphs
}): Line[] {
  const { state, currentSessionId, width, height, now } = input
  const sessions = listedSessions(input.sessions, state)
  const glyphs = input.glyphs ?? defaultGlyphs()
  const view = viewOf(state)
  const groups = groupSessions(sessions, state.filter, currentSessionId, state.archived, view)
  const visible = groups.flatMap((group) => group.sessions)
  const edit = state.edit
  const hints = sessionsHints(state)

  if (edit?.mode === "rename" || edit?.mode === "tag") {
    const session = sessions.find((entry) => entry.sessionId === edit.sessionId)
    const prompt = edit.mode === "tag" ? "tags: " : "rename: "
    return pickerFrame(edit.mode === "tag" ? "Tag session" : "Rename session", `ctrl+u clear · ${hints}`, width, height, panelGrid({ width, compact: false, padding: true, maxColumns: 1, heights: [Math.max(0, height - 2)], rows: [[{ title: edit.mode === "tag" ? "Tags and color" : "Session title", active: true, body: (w): Line[] => [[{ text: prompt, fg: "muted" }, { text: takeCells([...cells(edit.draft)], Math.max(0, w - prompt.length - 1), true), fg: "text", bold: true }, { text: "▏", fg: "primary" }], ...(edit.mode === "tag" ? [[{ text: state.note ?? `colors: ${SESSION_COLORS.join(" ")}`, fg: "muted" }] as Line] : [])] }]] }), session?.directory ?? "")
  }

  const project = state.directory ?? sessions.find((entry) => entry.sessionId === currentSessionId)?.directory
  const included = sessions.filter((session) => !isDraftOnly(session) && (state.archived || session.archivedAt === undefined) && (!state.named || session.named) && (state.scope !== "project" || project === undefined || session.directory === project))
  const keyLines = state.keys && !state.folders ? keysRows(width) : []
  const keyBlock = keyLines.length ? [...keyLines.slice(0, Math.max(1, height - 9)), []] : []
  const bodyHeight = Math.max(0, height - 2 - keyBlock.length)
  const wide = !edit && !state.folders && isWide(width) && height >= WIDE_HEIGHT
  const bodyRoom = Math.max(1, bodyHeight - (isCompact(width) ? 2 : 4))

  const folderBody = (rowWidth: number): Line[] => {
    const picker = state.folders!
    const entries = folderEntries(input.sessions, state)
    const at = clampIndex(picker.selected, entries.length)
    const head = [inputRow({ text: picker.query, placeholder: FOLDER_PLACEHOLDER, right: plural(entries.filter((entry) => entry.directory).length, "folder"), width: rowWidth }), rule(rowWidth, glyphs)]
    if (!entries.length) return [...head, clampLine([{ text: `no folder has "${picker.query}"`, fg: "muted" }], rowWidth)]
    const rows = entries.map((entry, index): Line => {
      const selected = index === at
      const count = String(entry.count)
      const name = entry.directory === undefined ? "All folders" : `${abbreviateHome(entry.directory, input.home)}${entry.directory === state.origin ? "  this folder" : ""}`
      const marker: Span = selected ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " }
      const label = shortenMiddle(name, Math.max(1, rowWidth - 3 - textWidth(count)))
      return spread([marker, { text: label, fg: entry.directory === undefined ? "heading" : "text", bold: selected }], [{ text: count, fg: "muted" }], rowWidth)
    })
    const capacity = Math.max(1, bodyRoom - head.length)
    const offset = Math.min(Math.max(0, at - capacity + 1), Math.max(0, rows.length - capacity))
    return [...head, ...rows.slice(offset, offset + capacity)]
  }

  const listBody = (rowWidth: number): Line[] => {
    const right = state.scope === "project" && state.directory && state.directory !== state.origin ? `in ${abbreviateHome(state.directory, input.home)}` : ""
    const head: Line[] = [inputRow({ text: state.filter, placeholder: SEARCH_PLACEHOLDER, right, width: rowWidth }), rule(rowWidth, glyphs)]
    if (edit?.mode === "delete") {
      const title = sessions.find((session) => session.sessionId === edit.sessionId)?.title.trim() || "untitled"
      head.push(clampLine([{ text: `delete ${truncateEnd(title, Math.max(4, rowWidth - 24))}? `, fg: "error", bold: true }, { text: "d/y confirm", fg: "error" }], rowWidth))
    }
    if (state.note) head.push(clampLine([{ text: state.note, fg: "muted" }], rowWidth))
    if (visible.length === 0) {
      const text = state.filter ? `no session matches "${state.filter}"` : state.named || state.scope === "project" ? "no sessions with these toggles" : "no sessions yet"
      const tip = state.filter && state.scope === "project" ? "^L looks in all projects" : state.filter && !state.content ? "^F also looks in the messages" : ""
      return [...head, clampLine([{ text, fg: "muted" }], rowWidth), ...(tip ? [clampLine([{ text: tip, fg: "muted", dim: true }], rowWidth)] : [])]
    }
    const selected = selectedIndex(state, visible)
    const items: { line: Line; header: boolean; selected: boolean; head: Line }[] = []
    let position = 0
    for (const group of groups) {
      const header = groupHeader(group, rowWidth, input.home)
      items.push({ line: header, header: true, selected: false, head: header })
      const depths = nestingDepths(group.sessions)
      for (const session of group.sessions) {
        const isSelected = position++ === selected
        items.push({ line: sessionRow({ session, selected: isSelected, current: session.sessionId === currentSessionId, width: rowWidth, now, glyphs, depth: depths.get(session.sessionId) ?? 0 }), header: false, selected: isSelected, head: header })
      }
    }
    const capacity = Math.max(1, bodyRoom - head.length)
    const at = items.findIndex((item) => item.selected)
    // The selected row is always in the window; near the end the window holds the last full page.
    let offset = Math.min(Math.max(0, at - capacity + 1), Math.max(0, items.length - capacity))
    // A scrolled list keeps its folder context: a first visible row is replaced by its (sticky) folder header.
    const sticky = capacity >= 2 && offset > 0 && !items[offset]!.header
    if (sticky && at === offset) offset--
    const window = items.slice(offset, offset + capacity)
    if (sticky && !window[0]!.header) window[0] = { ...window[0]!, line: window[0]!.head }
    return [...head, ...window.map((item) => item.line)]
  }

  const selectedSession = visible[selectedIndex(state, visible)]
  const listTitle = state.folders ? "Pick a folder" : state.archived ? "All sessions" : "Sessions"
  const body = panelGrid({ width, compact: isCompact(width), padding: true, maxColumns: wide ? 2 : 1, heights: [bodyHeight], rows: [[
    { title: listTitle, weight: 3, active: true, body: state.folders ? folderBody : listBody },
    ...(wide ? [{ title: "Selected session", weight: 1, body: (w: number) => selectedSession ? detailRows({ session: selectedSession, width: w, now, home: input.home, snippet: state.content ? state.hits?.[selectedSession.sessionId] : undefined }) : [] }] : []),
  ]] })
  const frame = pickerFrame("Sessions", hints, width, height, [...keyBlock, ...body])
  if (height > 1) frame[1] = summaryRow({ state, shown: visible.length, included, width, home: input.home, glyphs, hasProject: project !== undefined })
  return frame
}
