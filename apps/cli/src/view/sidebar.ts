import type { McpServerStatus, SessionSummary } from "@mendcode/protocol"
import { BREAKPOINTS } from "../ui/breakpoints"
import { glyphs, type ColorName, type Glyphs, type Line } from "../ui/theme"
import type { SidebarMode } from "./tui-profile"
import { clip, fit, spread } from "./deck"
import { compact } from "./format"
import type { TodoItem, TodoStatus } from "./dock"
import { relativeTime, shortenMiddle, truncateEnd } from "./session-list"
import { draftSizeLabel, labelSpans, sessionActivityAt, sessionLabel } from "./session-label"
import { lineWidth, textWidth, wrap } from "./wrap"
import { elapsedLabel, prSpans, SETTLED_FIRST } from "./sidebar-marks"
import { sidebarWindowStart, type SidebarScroll } from "./sidebar-window"

/**
 * The left session list uses `auto` from wide (110 columns), with at least 71 cells left for chat.
 * `always` is kept for saved profiles; `hidden`, minimal and home show no sidebar.
 * The facts renderer below is retained for an opt-in right surface; chat no longer attaches it.
 */
export const SIDEBAR_WIDTH = 38
/** One blank cell between the chat column and the sidebar. */
export const SIDEBAR_GAP = 1
const PAD_X = 2
const MAX_TODOS = 6
const MAX_FILES = 6
const MAX_SERVERS = 5
const MAX_QUEUE = 3

export type SidebarChange = { path: string; status: "added" | "modified" | "deleted" | "renamed" | "untracked"; additions: number; deletions: number }

export type SidebarInput = {
  height: number
  title: string
  /** Context tokens in use and the size at which compaction starts. */
  context?: { tokens: number; limit: number }
  todos: readonly TodoItem[]
  /** Undefined until the project's changes were asked for. */
  changes?: readonly SidebarChange[]
  /** Undefined until the project's MCP servers were asked for. */
  mcp?: readonly Pick<McpServerStatus, "name" | "state" | "enabled" | "tools">[]
  queue: readonly string[]
  glyphs: Pick<Glyphs, "barFull" | "barEmpty" | "queue">
}

/** Whether the sidebar shows at `width` columns, given the profile's mode; the minimal view never shows it. The home screen shows it like a chat does. */
export function sidebarVisible(input: { mode: SidebarMode; width: number; minimal: boolean }): boolean {
  if (input.mode === "hidden" || input.minimal) return false
  return input.width >= BREAKPOINTS.wide
}

/** The narrow icons-only column of the experimental bots sidebar: a margin mark, an icon, a state symbol and the rule. */
export const ICON_SIDEBAR_WIDTH = 12

/**
 * How the left sidebar shows at `width` columns. With bots on it can also be the icons-only column, chosen by the layout or
 * because the width is under the wide breakpoint (the full list needs it) but still has room for the chat; with bots off it is
 * today's rule: full from wide, else none.
 */
export function sidebarKind(input: { mode: SidebarMode; width: number; minimal: boolean; bots: boolean; iconsOnly: boolean }): "none" | "icons" | "full" {
  if (!sidebarVisible({ mode: input.mode, width: BREAKPOINTS.wide, minimal: input.minimal })) return "none"
  if (!input.bots) return input.width >= BREAKPOINTS.wide ? "full" : "none"
  if (input.width < BREAKPOINTS.normal) return "none"
  return input.iconsOnly || input.width < BREAKPOINTS.wide ? "icons" : "full"
}

/** Columns left for the chat when the sidebar shows. */
export const chatColumns = (width: number) => width - SIDEBAR_WIDTH - SIDEBAR_GAP

const TODO_MARK: Record<TodoStatus, { glyph: string; fg: ColorName }> = {
  done: { glyph: "✓", fg: "muted" },
  in_progress: { glyph: "▸", fg: "warning" },
  cancelled: { glyph: "×", fg: "error" },
  pending: { glyph: "□", fg: "text" },
}
const CHANGE_MARK: Record<SidebarChange["status"], { glyph: string; fg: ColorName }> = {
  added: { glyph: "A", fg: "success" },
  modified: { glyph: "M", fg: "warning" },
  deleted: { glyph: "D", fg: "error" },
  renamed: { glyph: "R", fg: "warning" },
  untracked: { glyph: "?", fg: "muted" },
}

function heading(title: string, right: string, width: number): Line {
  return spread([{ text: title, fg: "heading", bold: true }], right ? [{ text: right, fg: "muted" }] : [], width)
}

function bounded(rows: Line[], room: number): Line[] {
  if (rows.length <= room) return rows
  const kept = rows.slice(0, Math.max(0, room - 1))
  return [...kept, [{ text: `+${rows.length - kept.length} more`, fg: "muted" }]]
}

function contextRows(context: NonNullable<SidebarInput["context"]>, glyphs: SidebarInput["glyphs"], width: number): Line[] {
  const percent = Math.max(0, Math.round((context.tokens / Math.max(1, context.limit)) * 100))
  const tone: ColorName = percent >= 90 ? "error" : percent >= 70 ? "warning" : "success"
  const cells = Math.max(6, Math.min(20, width - 8))
  const filled = Math.min(cells, Math.round((Math.min(percent, 100) / 100) * cells))
  return [
    heading("Context", `${percent}%`, width),
    [{ text: glyphs.barFull.repeat(filled), fg: tone }, { text: glyphs.barEmpty.repeat(cells - filled), fg: "border" }],
    [{ text: `${compact(context.tokens)} of ${compact(context.limit)} tokens`, fg: "muted" }],
  ]
}

function todoRows(todos: readonly TodoItem[], width: number, room: number): Line[] {
  const open = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress").length
  const rows = todos.map((todo): Line => {
    const mark = TODO_MARK[todo.status]
    return clip([{ text: `${mark.glyph} `, fg: mark.fg }, ...(todo.priority ? [{ text: `${todo.priority} · `, fg: todo.priority === "high" ? "warning" as const : "muted" as const }] : []), { text: todo.text, fg: todo.status === "done" ? "muted" : mark.fg === "text" ? "text" : mark.fg }], width)
  })
  return [heading("Todos", `${open} open`, width), ...bounded(rows, Math.min(room, MAX_TODOS))]
}

function changeRows(changes: readonly SidebarChange[], width: number, room: number): Line[] {
  const added = changes.reduce((sum, file) => sum + file.additions, 0)
  const removed = changes.reduce((sum, file) => sum + file.deletions, 0)
  const rows = changes.map((file): Line => {
    const mark = CHANGE_MARK[file.status]
    const stat = file.additions || file.deletions ? `+${file.additions} -${file.deletions}` : ""
    const pathRoom = Math.max(4, width - 2 - (stat ? textWidth(stat) + 1 : 0))
    return spread([{ text: `${mark.glyph} `, fg: mark.fg }, { text: shortenMiddle(file.path, pathRoom), fg: "text" }], stat ? [{ text: stat, fg: "muted" }] : [], width)
  })
  return [heading("Changes", `${changes.length} file${changes.length === 1 ? "" : "s"} · +${added} -${removed}`, width), ...bounded(rows, Math.min(room, MAX_FILES))]
}

function mcpRows(servers: readonly NonNullable<SidebarInput["mcp"]>[number][], width: number, room: number): Line[] {
  const running = servers.filter((server) => server.state === "running").length
  const rows = servers.map((server): Line => {
    const [glyph, fg, label]: [string, ColorName, string] = !server.enabled
      ? ["○", "muted", "off"]
      : server.state === "running"
        ? ["●", "success", `${server.tools} tool${server.tools === 1 ? "" : "s"}`]
        : server.state === "failed"
          ? ["!", "error", "failed"]
          : server.state === "starting"
            ? ["…", "warning", "starting"]
            : ["○", "muted", "stopped"]
    const nameRoom = Math.max(4, width - 2 - textWidth(label) - 2)
    return spread([{ text: `${glyph} `, fg }, { text: truncateEnd(server.name, nameRoom), fg: "text" }], [{ text: label, fg }], width)
  })
  return [heading("MCP", `${running}/${servers.length}`, width), ...bounded(rows, Math.min(room, MAX_SERVERS))]
}

function queueRows(queue: readonly string[], glyphs: SidebarInput["glyphs"], width: number, room: number): Line[] {
  const rows = queue.map((preview): Line => clip([{ text: `${glyphs.queue} `, fg: "muted" }, { text: preview.replace(/\s+/g, " ").trim(), fg: "body" }], width))
  return [heading("Queue", String(queue.length), width), ...bounded(rows, Math.min(room, MAX_QUEUE))]
}

/** The sidebar, exactly `input.height` rows by `SIDEBAR_WIDTH` cells, every cell on the panel fill. */
export function renderSidebar(input: SidebarInput): Line[] {
  const inner = SIDEBAR_WIDTH - PAD_X * 2
  const body: Line[] = [[]]
  /** Rows still free; the last row stays blank. */
  const room = () => input.height - 1 - body.length
  const title = wrap(input.title.trim() || "Untitled session", inner).slice(0, 2)
  body.push(...title.map((text): Line => [{ text, fg: "text", bold: true }]))
  body.push([])
  if (input.context) body.push(...contextRows(input.context, input.glyphs, inner))
  const sections: Array<() => Line[]> = [
    () => (input.todos.length ? todoRows(input.todos, inner, Math.max(1, room() - 2)) : []),
    () => (input.changes?.length ? changeRows(input.changes, inner, Math.max(1, room() - 2)) : []),
    () => (input.mcp?.length ? mcpRows(input.mcp, inner, Math.max(1, room() - 2)) : []),
    () => (input.queue.length ? queueRows(input.queue, input.glyphs, inner, Math.max(1, room() - 2)) : []),
  ]
  // A section needs a blank row, its heading and one row; one that does not fit in what is left is skipped.
  for (const make of sections) {
    const section = make()
    if (section.length === 0 || room() < 3) continue
    body.push([])
    body.push(...section.slice(0, Math.max(0, room())))
  }
  const side: Line = [{ text: " ".repeat(PAD_X), bg: "panel" }]
  const rows = body.slice(0, input.height).map((line): Line => [...side, ...fit(line, inner).map((span) => ({ ...span, bg: span.bg ?? "panel" })), ...side])
  while (rows.length < input.height) rows.push([{ text: " ".repeat(SIDEBAR_WIDTH), bg: "panel" }])
  return rows
}

/** Left sidebar, gap, then the chat padded to `mainWidth`. */
export function attachSidebar(main: readonly Line[], sidebar: readonly Line[], mainWidth: number, side: "left" | "right" = "left", cells = SIDEBAR_WIDTH): Line[] {
  const height = Math.max(main.length, sidebar.length)
  const blank: Line = [{ text: " ".repeat(cells), bg: "panel" }]
  return Array.from({ length: height }, (_, row): Line => side === "left" ? [...(sidebar[row] ?? blank), { text: " ".repeat(SIDEBAR_GAP) }, ...fit(main[row] ?? [], mainWidth)] : [...fit(main[row] ?? [], mainWidth), { text: " ".repeat(SIDEBAR_GAP) }, ...(sidebar[row] ?? blank)])
}

export function projectSessions(sessions: readonly SessionSummary[], directory: string) {
  const section = (session: SessionSummary) => session.archivedAt !== undefined ? 2 : session.lifecycle?.pinnedAt !== undefined ? 0 : 1
  // The top sessions only: a child listed with its parent (as /sessions lists a folder) stays under it there, not here.
  const listed = new Set(sessions.map((session) => session.sessionId))
  return sessions.filter((session) => session.directory === directory && !(session.parentId && listed.has(session.parentId))).sort((a, b) => section(a) - section(b) || sessionActivityAt(b) - sessionActivityAt(a) || a.sessionId.localeCompare(b.sessionId))
}

/** The collapsed Settled row's stop among the hits and the keyboard's rows; never a session id (those are ULID-like). */
export const SETTLED_ROW = "settled"
/** The `+ N more` row under the open Settled shelf, which shows the next page of it. */
export const SETTLED_MORE = "settled-more"

/** What a session row's leading symbol says, most urgent first (the order t3code's status pill uses). */
export type SessionMark = "approval" | "question" | "plan" | "running" | "error" | "unread" | "queued" | "settled" | "idle"

const RUNNING_STATES: ReadonlySet<string> = new Set(["generating", "tool", "compacting", "cancelling"])
const MARK_RANK: Record<SessionMark, number> = { approval: 0, question: 1, plan: 2, error: 3, unread: 4, running: 5, queued: 6, settled: 7, idle: 8 }
const MARK_FG: Record<SessionMark, ColorName> = { approval: "warning", question: "info", plan: "accent", running: "primary", error: "error", unread: "success", queued: "muted", settled: "muted", idle: "muted" }

type SidebarSession = Pick<SessionSummary, "sessionId" | "title" | "state" | "queued" | "updatedAt"> & Partial<Pick<SessionSummary, "archivedAt" | "lifecycle" | "draft" | "parentId" | "tool" | "paused" | "since" | "pending" | "pendingKind">>

/** The row's state: waiting for you (to approve, to answer, or to review a plan), working, failed, a reply you have not opened yet, queued or paused, settled, or nothing. */
export function sessionMark(session: SidebarSession, unread: boolean): SessionMark {
  if (session.state === "waiting_approval") return session.pendingKind === "question" ? "question" : session.pendingKind === "plan" ? "plan" : "approval"
  if (RUNNING_STATES.has(session.state)) return "running"
  if (session.state === "error") return "error"
  if (session.archivedAt !== undefined) return "settled"
  // Messages still waiting to run mean the session is not done, so queued wins over a reply not read yet.
  if (session.state === "queued" || session.queued > 0 || session.paused) return "queued"
  if (unread) return "unread"
  return "idle"
}

/** Whether the session waits for you: a tool to approve, a question to answer or a plan to review. */
export const waitsOnYou = (mark: SessionMark) => mark === "approval" || mark === "question" || mark === "plan"

/** Whether a row moves on the activity tick: only running and waiting rows do. */
export const markAnimates = (mark: SessionMark) => mark === "running" || waitsOnYou(mark)

/**
 * The symbol of a mark: the spinner frame for a running row, `?` (approval), `◎` (question) and `◈` (plan) blinking while they wait
 * (the plan one stays lit), `✗` for a failure; idle rows keep a dim dot so every title starts in the same column, and ASCII's
 * queue mark is that dot, so queued reads `~` there.
 */
export function markSymbol(mark: SessionMark, { g, spinner, blink, ascii }: { g: Pick<Glyphs, "ask" | "running" | "fail" | "dot" | "queue" | "collapsed" | "goal" | "done">; spinner?: string | undefined; blink?: boolean | undefined; ascii?: boolean | undefined }): { text: string; fg: ColorName } {
  if (mark === "running") return { text: spinner || g.running, fg: "primary" }
  if (mark === "approval") return { text: g.ask, fg: blink === false ? "muted" : "warning" }
  if (mark === "question") return { text: g.goal, fg: blink === false ? "muted" : "info" }
  if (mark === "plan") return { text: g.done, fg: "accent" }
  const text = mark === "error" ? g.fail : mark === "unread" ? g.dot : mark === "queued" ? (ascii ? "~" : g.queue) : mark === "settled" ? g.collapsed : ascii ? "." : "·"
  return { text, fg: MARK_FG[mark] }
}

/** The rows the keyboard stops on, in drawing order: the sessions, with the settled ones folded into `SETTLED_ROW` until opened. */
export function sidebarStops(sessions: readonly Pick<SessionSummary, "sessionId" | "archivedAt">[], settledOpen: boolean, settledShown = SETTLED_FIRST): string[] {
  const live = sessions.filter((session) => session.archivedAt === undefined).map((session) => session.sessionId)
  const settled = sessions.filter((session) => session.archivedAt !== undefined).map((session) => session.sessionId)
  return settled.length === 0 ? live : [...live, SETTLED_ROW, ...(settledOpen ? [...settled.slice(0, settledShown), ...(settled.length > settledShown ? [SETTLED_MORE] : [])] : [])]
}

type SidebarGlyphs = Pick<Glyphs, "ask" | "running" | "fail" | "dot" | "queue" | "collapsed" | "goal" | "done">

function startOfDay(now: number): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/**
 * One row per session: a state symbol, the title, then age, child sessions and the PR on the right. Groups are Pinned, Today,
 * Earlier and a Settled row that folds the settled sessions (showing the most urgent symbol among them) until it is opened.
 * The current session carries a bar in the margin; the selected row (with focus) gets the element fill and one muted detail line.
 * `spinner` is the activity tick's frame for running rows and `blink` its on/off for approval rows; with neither the rows are still.
 */
export function renderSessionSidebar(input: {
  sessions: readonly SidebarSession[]
  current: string
  selected?: string
  focused: boolean
  height: number
  now: number
  header?: boolean
  unread?: readonly string[]
  spinner?: string
  blink?: boolean
  settledOpen?: boolean
  /** Settled sessions the open shelf lists; absent, `SETTLED_FIRST`. Each `+ N more` row adds a page of 25. */
  settledShown?: number
  /** The opened folder's branch and, when it is a linked worktree, that worktree's name: told on the selected row's detail line only. */
  folder?: { branch?: string; worktree?: string }
  ascii?: boolean
  glyphs?: SidebarGlyphs
  /** Where the wheel put the list's window; the renderer reports the window it drew in it. */
  scroll?: SidebarScroll
}): { rows: Line[]; hits: Array<{ row: number; sessionId: string }> } {
  // One gutter cell, the two-cell margin (current bar or selection mark), the row, then a blank and the rule.
  const inner = SIDEBAR_WIDTH - 1 - PAD_X - 2
  const g = input.glyphs ?? glyphs()
  const unread = new Set(input.unread ?? [])
  const children = new Map<string, number>()
  for (const session of input.sessions) if (session.parentId) children.set(session.parentId, (children.get(session.parentId) ?? 0) + 1)
  const marks = new Map(input.sessions.map((session) => [session.sessionId, sessionMark(session, unread.has(session.sessionId) && session.sessionId !== input.current)]))
  const symbol = (mark: SessionMark) => markSymbol(mark, { g, spinner: input.spinner, blink: input.blink, ascii: input.ascii })
  // The header's right side: how many work and how many wait for you (the mark, a space, the count), else the focus hint.
  const counts = [...marks.values()].reduce((sum, mark) => ({ running: sum.running + (mark === "running" ? 1 : 0), approval: sum.approval + (waitsOnYou(mark) ? 1 : 0) }), { running: 0, approval: 0 })
  const summary: Line = input.focused ? [{ text: "→ prompt", fg: "muted" }] : counts.running || counts.approval
    ? [...(counts.running ? [{ ...symbol("running"), text: `${symbol("running").text} ${counts.running}` }] : []), ...(counts.running && counts.approval ? [{ text: "  " }] : []), ...(counts.approval ? [{ text: `${g.ask} ${counts.approval}`, fg: "warning" as const }] : [])]
    : [{ text: "← focus", fg: "muted" }]
  // `sidebarHeader` off gives the title row and the blank under it to the sessions.
  const head: Line[] = input.header === false ? [] : [spread([{ text: "Sessions", fg: "primary", bold: true }], summary, inner), []]
  const picked = input.focused ? (input.selected ?? input.current) : undefined
  const today = startOfDay(input.now)
  const list: Array<{ line: Line; lead?: Line; id?: string; fill?: boolean; detail?: boolean }> = []
  let group = ""
  // A dim group heading, with a blank row before every one but the first.
  const groupHeading = (name: string) => {
    if (list.length) list.push({ line: [] })
    list.push({ line: [{ text: name, fg: "muted" }] })
  }
  const sessionRow = (session: SidebarSession) => {
    const mark = marks.get(session.sessionId)!
    const current = session.sessionId === input.current
    const selected = session.sessionId === picked
    // A running row counts up from the turn's start on the same tick that moves its spinner; every other row shows its age.
    const time = mark === "running" && session.since !== undefined && input.now >= session.since ? elapsedLabel(input.now - session.since) : relativeTime(input.now, sessionActivityAt(session))
    const childCount = children.get(session.sessionId) ?? 0
    const pr = session.lifecycle?.pr
    const metaOf = (withNumber: boolean): Line => [{ text: time, fg: "muted" }, ...(childCount ? [{ text: ` ${input.ascii ? "^" : "↳"}${childCount}`, fg: "muted" as const }] : []), ...(pr ? prSpans(pr, withNumber) : [])]
    // The PR state word keeps its place; when the title would be left with under ten cells the number goes first.
    const full = metaOf(true)
    const meta = pr && inner - 2 - lineWidth(full) - 2 < 10 ? metaOf(false) : full
    const quiet = mark === "idle" || mark === "settled" || mark === "queued"
    // The meta sits on the right edge with at least two blanks before it; the title gives way with an ellipsis.
    const titleRoom = Math.max(4, inner - 2 - lineWidth(meta) - 2)
    const title = labelSpans(sessionLabel(session, { untitled: "Untitled session", marker: "Draft" }), titleRoom, { fg: current || selected || !quiet ? "text" : "muted", bold: current || selected })
    const lead: Line = current ? [{ text: "▌", fg: "primary" }, { text: " " }] : selected ? [{ text: input.ascii ? ">" : "›", fg: "muted" }, { text: " " }] : [{ text: "  " }]
    list.push({ line: spread([{ ...symbol(mark), text: `${symbol(mark).text} ` }, ...title], meta, inner), lead, id: session.sessionId, fill: selected })
    if (!selected) return
    const branch = pr?.branch || (current ? input.folder?.branch : undefined)
    const detail = [branch ?? "", input.folder?.worktree ? `worktree ${input.folder.worktree}` : "", session.tool ? `tool ${session.tool}` : "", session.queued > 0 ? `${session.queued} queued` : "", session.paused ? "paused" : "", session.draft ? `draft ${draftSizeLabel(session.draft)}` : "", childCount ? `${childCount} child${childCount === 1 ? "" : "ren"}` : "", pr ? `PR ${pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open"}` : "", mark === "unread" ? "new reply" : mark === "error" ? "failed" : mark === "approval" ? "needs approval" : mark === "question" ? "asks you a question" : mark === "plan" ? "plan ready" : ""].filter(Boolean)
    if (detail.length) list.push({ line: [{ text: `  ${truncateEnd(detail.join(" · "), inner - 2)}`, fg: "muted" }], id: session.sessionId, detail: true, fill: true })
  }
  const settled = input.sessions.filter((session) => session.archivedAt !== undefined)
  for (const session of input.sessions) {
    if (session.archivedAt !== undefined) continue
    const next = session.lifecycle?.pinnedAt !== undefined ? "Pinned" : sessionActivityAt(session) >= today ? "Today" : "Earlier"
    if (next !== group) { groupHeading(next); group = next }
    sessionRow(session)
  }
  if (settled.length) {
    if (list.length) list.push({ line: [] })
    const urgent = settled.map((session) => marks.get(session.sessionId)!).sort((a, b) => MARK_RANK[a] - MARK_RANK[b])[0]!
    const shown = urgent === "settled" || urgent === "idle" ? symbol("settled") : symbol(urgent)
    list.push({ line: spread([{ ...shown, text: `${shown.text} ` }, { text: "Settled", fg: "muted" }, { text: ` · ${settled.length}`, fg: "muted" }], [{ text: input.settledOpen ? (input.ascii ? "v" : "▾") : (input.ascii ? ">" : "▸"), fg: "muted" }], inner), lead: [{ text: "  " }], id: SETTLED_ROW, fill: picked === SETTLED_ROW })
    if (input.settledOpen) {
      const shownCount = input.settledShown ?? SETTLED_FIRST
      for (const session of settled.slice(0, shownCount)) sessionRow(session)
      const left = settled.length - shownCount
      if (left > 0) list.push({ line: [{ text: `  + ${left} more`, fg: "muted", bold: picked === SETTLED_MORE }], lead: input.focused && picked === SETTLED_MORE ? [{ text: input.ascii ? ">" : "›", fg: "muted" }, { text: " " }] : [{ text: "  " }], id: SETTLED_MORE, fill: picked === SETTLED_MORE })
    }
  }
  // A window over the rows that keeps the selected row (and its detail line) in view; the last row counts what is left out.
  const room = Math.max(0, input.height - head.length)
  const overflow = list.length > room
  const shownRoom = overflow ? Math.max(0, room - 1) : room
  const anchor = picked ?? input.current
  const lastOfPicked = list.findLastIndex((entry) => entry.id === anchor)
  const start = sidebarWindowStart({ total: list.length, shownRoom, overflow, anchorIndex: lastOfPicked, scroll: input.scroll })
  const windowed = list.slice(start, start + shownRoom)
  const body: Array<{ line: Line; lead?: Line; fill?: boolean }> = head.map((line) => ({ line }))
  const hits: Array<{ row: number; sessionId: string }> = []
  for (const entry of windowed) {
    if (entry.id) hits.push({ row: body.length, sessionId: entry.id })
    body.push(entry)
  }
  if (overflow) {
    const hidden = list.filter((entry, index) => (index < start || index >= start + windowed.length) && entry.id && !entry.detail).length
    const [up, down] = input.ascii ? ["^", "v"] : ["↑", "↓"]
    body.push({ line: [{ text: `${start > 0 ? `${up} ` : ""}${start + windowed.length < list.length ? `${down} ` : ""}${hidden} more`, fg: "muted" }] })
  }
  while (body.length < input.height) body.push({ line: [] })
  const rows = body.slice(0, input.height).map(({ line, lead, fill }): Line => {
    // The selected row's fill runs across the whole row, margin and the cell before the rule included.
    const row: Line = [{ text: " " }, ...(lead ?? [{ text: " ".repeat(PAD_X) }]), ...fit(line, inner), { text: " ", fg: "muted" }]
    return [...(fill ? row.map((span) => ({ ...span, bg: "element" as const })) : row), { text: "│", fg: "border" }]
  })
  return { rows, hits }
}
