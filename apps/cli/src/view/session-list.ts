import type { SessionSummary } from "@mendcode/protocol"
import { SESSION_COLORS, type SessionColor } from "@mendcode/protocol/wire"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { isCompact, isWide } from "../ui/breakpoints"
import { panelGrid } from "./deck"
import { pickerFrame } from "./picker-frame"
import { readablePreview } from "./reply-comments"
import { kvList } from "./page"
import { draftSizeLabel, labelString, sessionActivityAt, sessionLabel } from "./session-label"
import { nextSort, parseSessionQuery, parseTagDraft, selectSessions, sortSessions, type SessionScope, type SessionSort, type SessionView } from "./session-query"
import { cells, shortenMiddle, takeCellSlice as takeCells, textWidth, truncateEnd, wrap } from "./wrap"

export { shortenMiddle, truncateEnd } from "./wrap"

/** Inline modal editing of one row: rename (with a draft title), tags and color, or delete confirmation. */
export type SessionListEdit = { mode: "rename"; sessionId: string; draft: string } | { mode: "tag"; sessionId: string; draft: string } | { mode: "delete"; sessionId: string }

export type SessionListState = {
  selected: number
  filter: string
  edit?: SessionListEdit
  note?: string
  archived?: boolean
  sort?: SessionSort
  scope?: SessionScope
  named?: boolean
  /** Also look in the messages (asked of the daemon); `hits` are its answers for the current filter, session id to a snippet. */
  content?: boolean
  hits?: Record<string, string>
}

export type SessionListAction =
  | { type: "none" }
  | { type: "changed" }
  | { type: "open"; sessionId: string }
  | { type: "close" }
  | { type: "rename"; sessionId: string; title: string }
  | { type: "delete"; sessionId: string }
  | { type: "archive"; sessionId: string; restore: boolean }
  | { type: "pin"; sessionId: string; pinned: boolean }
  | { type: "tag"; sessionId: string; tags: string[]; color: SessionColor | null | undefined }
  | { type: "reload" }
  | { type: "search" }

const HINT_EDIT = "^B pin · ^A settle/restore · ^O settled · ^R rename · ^T tag · ^D delete · ^S sort · ^L scope · ^E named · ^F content · esc back"
const HINT_RENAME = "enter confirm · esc cancel"
const HINT_TAG = "words are tags · color:red (or color:none) · enter confirm · esc cancel"
const HINT_DELETE = "d/y confirm · esc cancel"
/** How each color mark is drawn: a theme role, so every theme keeps the marks apart and readable. */
const MARK_COLORS: Record<SessionColor, ColorName> = { red: "error", orange: "warning", yellow: "code", green: "success", cyan: "info", blue: "link", purple: "accent", pink: "heading" }
const WIDE_HEIGHT = 30
const MAX_TITLE = 200

export function createSessionListState(): SessionListState {
  return { selected: 0, filter: "" }
}

/** The query language of the picker (words, "phrases", `re:`, `tag:`, `color:`; see session-query.ts); every part must match. */
export function filterSessions(sessions: SessionSummary[], filter: string, view: SessionView = {}): SessionSummary[] {
  return selectSessions(sessions, filter, view)
}

/** The picker's view options held in its state. */
export function viewOf(state: SessionListState): SessionView {
  return { ...(state.sort ? { sort: state.sort } : {}), ...(state.scope ? { scope: state.scope } : {}), ...(state.named ? { named: true } : {}), ...(state.content && state.hits ? { hits: state.hits } : {}) }
}

export type SessionGroup = { directory: string; sessions: SessionSummary[]; section?: string }

/**
 * Filtered sessions grouped by project: the open session's project first, then the others by most
 * recent activity (or creation, or name); newest first inside each group unless sorted by name. This is also the selection order.
 */
export function groupSessions(sessions: SessionSummary[], filter: string, currentSessionId?: string, archived = false, view: SessionView = {}): SessionGroup[] {
  const currentDirectory = sessions.find((session) => session.sessionId === currentSessionId)?.directory
  const byDirectory = new Map<string, SessionSummary[]>()
  for (const session of selectSessions(sessions, filter, view, currentDirectory)) {
    if (!archived && session.archivedAt !== undefined) continue
    const group = byDirectory.get(session.directory)
    if (group) group.push(session)
    else byDirectory.set(session.directory, [session])
  }
  const sort = view.sort ?? "recent"
  const newest = (group: SessionSummary[]) => Math.max(...group.map((session) => sort === "created" ? session.createdAt : session.updatedAt))
  const projects = [...byDirectory.entries()]
    .map(([directory, group]) => ({ directory, sessions: sortSessions(group, sort) }))
    .sort((a, b) => Number(b.directory === currentDirectory) - Number(a.directory === currentDirectory) || (sort === "name" ? a.directory.localeCompare(b.directory) : newest(b.sessions) - newest(a.sessions)))
  return projects.flatMap((project) => ["Pinned", "Active", "Settled"].map((section) => ({ ...project, section, sessions: project.sessions.filter((session) => (session.archivedAt !== undefined ? "Settled" : session.lifecycle?.pinnedAt !== undefined ? "Pinned" : "Active") === section) })).filter((group) => group.sessions.length))
}

/** The selection order: every visible session, group by group. */
export function orderSessions(sessions: SessionSummary[], filter: string, currentSessionId?: string, archived = false, view: SessionView = {}): SessionSummary[] {
  return groupSessions(sessions, filter, currentSessionId, archived, view).flatMap((group) => group.sessions)
}

function isPrintable(key: string) {
  if (key.length === 0) return false
  for (const char of key) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) return false
  }
  return true
}

function clampIndex(index: number, length: number) {
  return Math.max(0, Math.min(index, length - 1))
}

const NONE: SessionListAction = { type: "none" }

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
    return { state: bare, action: { type: "changed" } }
  }
  const cleared = state.note === undefined ? state : bare
  const result = browseKey(cleared, key, sessions, currentSessionId)
  if (result.state === cleared && cleared !== state) return { state: cleared, action: { type: "changed" } }
  return result
}

/** One-line editing of a rename or tag draft. */
function renameKey(input: { state: SessionListState; edit: Extract<SessionListEdit, { mode: "rename" | "tag" }>; key: string }): { state: SessionListState; action: SessionListAction } {
  const { state, edit, key } = input
  const changed = { type: "changed" } as const
  if (key === "\x1b") return { state, action: changed }
  if (key === "\r" || key === "\n") {
    if (edit.mode === "tag") {
      const { tags, color } = parseTagDraft(edit.draft)
      if (color && !SESSION_COLORS.includes(color as SessionColor)) return { state: { ...state, edit, note: `colors: ${SESSION_COLORS.join(" ")}` }, action: changed }
      return { state, action: { type: "tag", sessionId: edit.sessionId, tags, color: color as SessionColor | null | undefined } }
    }
    const title = edit.draft.trim()
    return { state, action: title ? { type: "rename", sessionId: edit.sessionId, title } : changed }
  }
  if (key === "\x7f" || key === "\b") return { state: { ...state, edit: { ...edit, draft: Array.from(edit.draft).slice(0, -1).join("") } }, action: changed }
  if (key === "\x15") return { state: { ...state, edit: { ...edit, draft: "" } }, action: changed }
  if (!isPrintable(key) || Array.from(edit.draft + key).length > MAX_TITLE) return { state: { ...state, edit }, action: NONE }
  return { state: { ...state, edit: { ...edit, draft: edit.draft + key } }, action: changed }
}

function browseKey(state: SessionListState, key: string, sessions: SessionSummary[], currentSessionId?: string): { state: SessionListState; action: SessionListAction } {
  const visible = orderSessions(sessions, state.filter, currentSessionId, state.archived, viewOf(state))
  const current = clampIndex(state.selected, visible.length)
  const target = visible[current]
  const move = (delta: number) => {
    const next = clampIndex(current + delta, visible.length)
    if (next === state.selected) return { state, action: NONE }
    return { state: { ...state, selected: next }, action: { type: "changed" } as const }
  }
  /** A new filter text: the selection goes back to the top; with content search on, the old hits are stale and the daemon is asked again. */
  const retyped = (filter: string) => {
    const { hits: _stale, ...kept } = state
    return state.content ? { state: { ...kept, selected: 0, filter }, action: { type: "search" } as const } : { state: { ...state, selected: 0, filter }, action: { type: "changed" } as const }
  }
  const toggled = (change: Partial<SessionListState>) => ({ state: { ...state, selected: 0, ...change }, action: { type: "changed" } as const })

  if (key === "\x1b[A" || key === "\x1bOA" || key === "\x10") return move(-1)
  if (key === "\x1b[B" || key === "\x1bOB" || key === "\x0e") return move(1)
  if (key === "\x1b") return { state, action: { type: "close" } }
  if (key === "\x0f") return { state: { ...state, selected: 0, archived: !state.archived }, action: { type: "reload" } }
  if (key === "\x01") return target ? { state, action: { type: "archive", sessionId: target.sessionId, restore: target.archivedAt !== undefined } } : { state, action: NONE }
  if (key === "\x02") return target ? { state, action: { type: "pin", sessionId: target.sessionId, pinned: target.lifecycle?.pinnedAt === undefined } } : { state, action: NONE }
  if (key === "\x12") {
    if (!target) return { state, action: NONE }
    return { state: { ...state, edit: { mode: "rename", sessionId: target.sessionId, draft: target.title } }, action: { type: "changed" } }
  }
  if (key === "\x14") {
    if (!target) return { state, action: NONE }
    const own = [...(target.tags ?? []), ...(target.color ? [`color:${target.color}`] : [])].join(" ")
    return { state: { ...state, edit: { mode: "tag", sessionId: target.sessionId, draft: own } }, action: { type: "changed" } }
  }
  if (key === "\x13") return toggled({ sort: nextSort(state.sort) })
  if (key === "\x0c") return toggled({ scope: state.scope === "project" ? "all" : "project" })
  if (key === "\x05") return toggled({ named: !state.named })
  if (key === "\x06") {
    const { hits: _hits, ...kept } = state
    return state.content ? { state: { ...kept, selected: 0, content: false }, action: { type: "changed" } } : { state: { ...state, selected: 0, content: true }, action: { type: "search" } }
  }
  if (key === "\x04") {
    if (!target) return { state, action: NONE }
    if (target.sessionId === currentSessionId) return { state: { ...state, note: "can't delete the open session" }, action: { type: "changed" } }
    return { state: { ...state, edit: { mode: "delete", sessionId: target.sessionId } }, action: { type: "changed" } }
  }
  if (key === "\r" || key === "\n") {
    return target ? { state, action: { type: "open", sessionId: target.sessionId } } : { state, action: NONE }
  }
  if (key === "\x7f" || key === "\b") {
    if (state.filter.length === 0) return { state, action: NONE }
    return retyped(Array.from(state.filter).slice(0, -1).join(""))
  }
  if (isPrintable(key)) return retyped(state.filter + key)
  return { state, action: NONE }
}

/** <60s "now", <60m "Nm", <24h "Nh", <14d "Nd", else "Nw". */
export function relativeTime(now: number, then: number) {
  const seconds = Math.max(0, Math.floor((now - then) / 1000))
  if (seconds < 60) return "now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d`
  return `${Math.floor(days / 7)}w`
}

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

const WORKING = new Set(["generating", "tool", "compacting", "cancelling"])

/** Static state marker: no timers, so "working" is a steady primary dot. */
function stateDot(session: SessionSummary, glyphs: Glyphs): Span {
  if (WORKING.has(session.state)) return { text: glyphs.running, fg: "primary" }
  if (session.state === "waiting_approval") return { text: glyphs.ask, fg: "warning", bold: true }
  if (session.state === "error") return { text: glyphs.fail, fg: "error" }
  if (session.state === "queued") return { text: glyphs.queue, fg: "muted" }
  return { text: "·", fg: "muted" }
}

/** `/Users/me/Code/app` → `~/Code/app` when `home` is a prefix. */
export function abbreviateHome(directory: string, home?: string) {
  if (!home) return directory
  const base = home.replace(/\/+$/, "")
  if (directory === base) return "~"
  return directory.startsWith(`${base}/`) ? `~${directory.slice(base.length)}` : directory
}

function groupHeader(group: SessionGroup, width: number, home?: string): Line {
  const count = ` (${group.sessions.length})`
  const name = shortenMiddle(`${group.section ?? "Active"} · ${abbreviateHome(group.directory, home)}`, Math.max(1, width - textWidth(count)))
  return clampLine([{ text: name, fg: "heading", bold: true }, { text: count, fg: "muted" }], width)
}

type RowInput = { session: SessionSummary; selected: boolean; current: boolean; width: number; now: number; glyphs: Glyphs }

function sessionRow({ session, selected, current, width, now, glyphs }: RowInput): Line {
  const marker: Span = selected ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " }
  const dot = stateDot(session, glyphs)
  const time = relativeTime(now, sessionActivityAt(session))
  const queued = session.queued > 0 ? ` +${session.queued}` : ""
  const label = session.archivedAt !== undefined ? "archived" : session.state === "waiting_approval" ? "needs approval" : ""
  const right = `${label ? `${label} ` : ""}${queued ? `${queued.trim()} ` : ""}${time}`
  const mark: Span[] = session.color ? [{ text: "● ", fg: MARK_COLORS[session.color] }] : []
  const prefixWidth = 2 + textWidth(dot.text) + 1 + mark.length * 2
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
  const line: Line = [marker, dot, { text: " " }, ...mark, ...titleSpans]
  if (showSuffix) line.push({ text: suffix, fg: "muted" })
  if (showTags) line.push({ text: tagText, fg: "info" })
  line.push({ text: " ".repeat(pad) })
  if (label) line.push({ text: `${label} `, fg: session.archivedAt !== undefined ? "muted" : "warning", bold: true })
  if (queued) line.push({ text: `${queued.trim()} `, fg: "muted" })
  line.push({ text: time, fg: "muted" })
  return clampLine(line, width)
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** The selected session's detail column: its title, project, and the facts as label/value rows. */
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
    { label: "updated", value: relativeTime(now, at) === "now" ? "just now" : `${relativeTime(now, at)} ago` },
    ...(session.archivedAt !== undefined ? [{ label: "archived", value: new Date(session.archivedAt).toISOString().slice(0, 10) }] : []),
    ...(session.queued > 0 ? [{ label: "queued", value: String(session.queued) }] : []),
    { label: "id", value: session.sessionId.slice(0, 16) },
  ]
  return [
    clampLine([{ text: truncateEnd(labelString(named), width), fg: named.placeholder ? "muted" : "text", bold: true }], width),
    clampLine([{ text: shortenMiddle(abbreviateHome(session.directory, home), width), fg: "muted" }], width),
    [],
    ...kvList(facts, width),
    ...(snippet ? [[], clampLine([{ text: "message match", fg: "muted" }], width), ...wrap(readablePreview(snippet), width).slice(0, 4).map((text): Line => [{ text, fg: "text" }])] : []),
  ]
}

/** Renders at most `height` lines of at most `width` cells: project headers with their sessions under them. */
export function renderSessionList(input: {
  sessions: SessionSummary[]
  state: SessionListState
  currentSessionId?: string
  /** Home directory, so project paths read `~/Code/app`. */
  home?: string
  width: number
  height: number
  now: number
  glyphs?: Glyphs
}): Line[] {
  const { sessions, state, currentSessionId, width, height, now } = input
  const glyphs = input.glyphs ?? defaultGlyphs()
  const view = viewOf(state)
  const groups = groupSessions(sessions, state.filter, currentSessionId, state.archived, view)
  const visible = groups.flatMap((group) => group.sessions)
  const edit = state.edit
  const hints = edit?.mode === "rename" ? HINT_RENAME : edit?.mode === "tag" ? HINT_TAG : edit?.mode === "delete" ? HINT_DELETE : HINT_EDIT

  if (edit?.mode === "rename" || edit?.mode === "tag") {
    const session = sessions.find((entry) => entry.sessionId === edit.sessionId)
    const prompt = edit.mode === "tag" ? "tags: " : "rename: "
    return pickerFrame(edit.mode === "tag" ? "Tag session" : "Rename session", `ctrl+u clear · ${hints}`, width, height, panelGrid({ width, compact: false, padding: true, maxColumns: 1, heights: [Math.max(0, height - 2)], rows: [[{ title: edit.mode === "tag" ? "Tags and color" : "Session title", active: true, body: (w): Line[] => [[{ text: prompt, fg: "muted" }, { text: takeCells([...cells(edit.draft)], Math.max(0, w - prompt.length - 1), true), fg: "text", bold: true }, { text: "▏", fg: "primary" }], ...(edit.mode === "tag" ? [[{ text: state.note ?? `colors: ${SESSION_COLORS.join(" ")}`, fg: "muted" }] as Line] : [])] }]] }), session?.directory ?? "")
  }

  const included = sessions.filter((session) => (state.archived || session.archivedAt === undefined) && (!state.named || session.named) && (state.scope !== "project" || session.directory === sessions.find((entry) => entry.sessionId === currentSessionId)?.directory))
  const working = included.filter((session) => WORKING.has(session.state)).length
  const approval = included.filter((session) => session.state === "waiting_approval").length
  const invalid = parseSessionQuery(state.filter).invalid
  const summary = [
    state.scope === "project" ? "this project" : "all projects",
    state.archived ? "including archived" : "unarchived",
    state.sort && state.sort !== "recent" ? `sort ${state.sort}` : "",
    state.named ? "named only" : "",
    state.content ? (state.hits ? `messages ${Object.keys(state.hits).length}` : "messages") : "",
    invalid ?? "",
    state.filter ? `${visible.length} of ${plural(included.length, "session")}` : plural(included.length, "session"),
    working ? `${working} working` : "",
    approval ? `${approval} needs approval` : "",
  ]
    .filter(Boolean)
    .join(" · ")

  const bodyHeight = Math.max(0, height - 2)
  const wide = !edit && isWide(width) && height >= WIDE_HEIGHT
  const bodyRoom = Math.max(1, bodyHeight - (isCompact(width) ? 2 : 4))
  const listBody = (rowWidth: number): Line[] => {
    const editRows: Line[] = []
    if (state.filter) editRows.push(clampLine([{ text: `/ ${state.filter}`, fg: "text" }], rowWidth))
    if (edit?.mode === "delete") {
      const title = sessions.find((session) => session.sessionId === edit.sessionId)?.title.trim() || "untitled"
      editRows.push(clampLine([{ text: `delete ${truncateEnd(title, Math.max(4, rowWidth - 24))}? `, fg: "error", bold: true }, { text: "d/y confirm", fg: "error" }], rowWidth))
    }
    if (state.note) editRows.push(clampLine([{ text: state.note, fg: "muted" }], rowWidth))

    let listRows: Line[] = []
    if (visible.length === 0) {
      const text = state.filter ? `no match for "${state.filter}"` : state.named || state.scope === "project" ? "no sessions with these toggles" : "no sessions yet"
      listRows.push(clampLine([{ text, fg: "muted" }], rowWidth))
    } else {
      const selected = clampIndex(state.selected, visible.length)
      const items: { line: Line; header: boolean; selected: boolean; head: Line }[] = []
      let position = 0
      for (const group of groups) {
        const head = groupHeader(group, rowWidth, input.home)
        items.push({ line: head, header: true, selected: false, head })
        for (const session of group.sessions) {
          const isSelected = position++ === selected
          items.push({ line: sessionRow({ session, selected: isSelected, current: session.sessionId === currentSessionId, width: rowWidth, now, glyphs }), header: false, selected: isSelected, head })
        }
      }
      const capacity = Math.max(1, bodyRoom - editRows.length)
      const at = items.findIndex((item) => item.selected)
      let offset = Math.min(Math.max(0, at - capacity + 1), Math.max(0, items.length - capacity))
      // A scrolled list keeps its project context: a first visible row is replaced by its (sticky) project header.
      const sticky = capacity >= 2 && offset > 0 && !items[offset]!.header
      if (sticky && at === offset) offset--
      const window = items.slice(offset, offset + capacity)
      if (sticky && !window[0]!.header) window[0] = { ...window[0]!, line: window[0]!.head }
      listRows = window.map((item) => item.line)
    }

    return [...editRows, ...listRows]
  }
  const selectedSession = visible[clampIndex(state.selected, visible.length)]
  const body = panelGrid({ width, compact: isCompact(width), padding: true, maxColumns: wide ? 2 : 1, heights: [bodyHeight], rows: [[
    { title: state.archived ? "All sessions" : "Sessions", weight: 3, active: true, body: listBody },
    ...(wide ? [{ title: "Selected session", weight: 1, body: (w: number) => selectedSession ? detailRows({ session: selectedSession, width: w, now, home: input.home, snippet: state.content ? state.hits?.[selectedSession.sessionId] : undefined }) : [] }] : []),
  ]] })
  return pickerFrame("Sessions", hints, width, height, body, summary)
}
