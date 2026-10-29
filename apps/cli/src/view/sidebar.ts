import type { McpServerStatus, SessionSummary } from "@mendcode/protocol"
import { BREAKPOINTS } from "../ui/breakpoints"
import type { ColorName, Glyphs, Line } from "../ui/theme"
import type { SidebarMode } from "./tui-profile"
import { clip, fit, spread } from "./deck"
import { compact } from "./format"
import type { TodoItem, TodoStatus } from "./dock"
import { relativeTime, shortenMiddle, truncateEnd } from "./session-list"
import { labelSpans, sessionActivityAt, sessionLabel } from "./session-label"
import { textWidth, wrap } from "./wrap"

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
export function attachSidebar(main: readonly Line[], sidebar: readonly Line[], mainWidth: number, side: "left" | "right" = "left"): Line[] {
  const height = Math.max(main.length, sidebar.length)
  const blank: Line = [{ text: " ".repeat(SIDEBAR_WIDTH), bg: "panel" }]
  return Array.from({ length: height }, (_, row): Line => side === "left" ? [...(sidebar[row] ?? blank), { text: " ".repeat(SIDEBAR_GAP) }, ...fit(main[row] ?? [], mainWidth)] : [...fit(main[row] ?? [], mainWidth), { text: " ".repeat(SIDEBAR_GAP) }, ...(sidebar[row] ?? blank)])
}

export function projectSessions(sessions: readonly SessionSummary[], directory: string) {
  const section = (session: SessionSummary) => session.archivedAt !== undefined ? 2 : session.lifecycle?.pinnedAt !== undefined ? 0 : 1
  return sessions.filter((session) => session.directory === directory).sort((a, b) => section(a) - section(b) || sessionActivityAt(b) - sessionActivityAt(a) || a.sessionId.localeCompare(b.sessionId))
}

/** Two rows per session: its title, then relative time and live activity. */
export function renderSessionSidebar(input: { sessions: readonly SessionSummary[]; current: string; selected?: string; focused: boolean; height: number; now: number; header?: boolean }): { rows: Line[]; hits: Array<{ row: number; sessionId: string }> } {
  const inner = SIDEBAR_WIDTH - PAD_X - 2
  // `sidebarHeader` off gives the title row and the blank under it to the sessions.
  const head: Line[] = input.header === false ? [] : [spread([{ text: "Sessions", fg: "primary", bold: true }], [{ text: input.focused ? "→ prompt" : "← focus", fg: "muted" }], inner), []]
  const capacity = Math.max(0, Math.floor((input.height - 4 - head.length) / 4))
  const selected = input.sessions.findIndex((session) => session.sessionId === (input.selected ?? input.current))
  const start = Math.max(0, Math.min(selected - capacity + 1, input.sessions.length - capacity))
  const body: Line[] = [...head]
  const hits: Array<{ row: number; sessionId: string }> = []
  let section = ""
  for (const session of input.sessions.slice(start, start + capacity)) {
    const next = session.archivedAt !== undefined ? "Settled" : session.lifecycle?.pinnedAt !== undefined ? "Pinned" : "Active"
    if (next !== section) { body.push([{ text: next, fg: "heading", bold: true }]); section = next }
    const current = session.sessionId === input.current
    const picked = input.focused && session.sessionId === (input.selected ?? input.current)
    const waiting = session.state === "waiting_approval"
    const running = ["generating", "tool", "compacting", "cancelling"].includes(session.state)
    const mark = waiting ? "?" : running ? "●" : session.state === "queued" || session.queued > 0 ? "…" : " "
    const live = waiting ? "waiting" : running ? "running" : session.queued > 0 ? `${session.queued} queued` : ""
    const time = relativeTime(input.now, sessionActivityAt(session))
    hits.push({ row: body.length, sessionId: session.sessionId }, { row: body.length + 1, sessionId: session.sessionId })
    body.push(clip([{ text: picked ? "› " : current ? "◆ " : "  ", fg: "primary" }, ...labelSpans(sessionLabel(session, { untitled: "Untitled session", marker: "Draft" }), inner - 2, { fg: current || picked ? "text" : "muted", bold: current || picked })], inner))
    body.push(spread([{ text: `  ${time === "now" ? time : `${time} ago`}${session.lifecycle?.pr ? ` #${session.lifecycle.pr.number}` : ""}`, fg: "muted" }], [{ text: `${mark}${live ? ` ${live}` : ""}`, fg: waiting ? "warning" : running ? "success" : "muted" }], inner), [])
  }
  if (start > 0 || start + capacity < input.sessions.length) body.push([{ text: `${Math.min(input.sessions.length, start + 1)}–${Math.min(input.sessions.length, start + capacity)} of ${input.sessions.length}`, fg: "muted" }])
  while (body.length < input.height) body.push([])
  return { rows: body.slice(0, input.height).map((row): Line => [{ text: " ".repeat(PAD_X) }, ...fit(row, inner), { text: " ", fg: "muted" }, { text: "│", fg: "border" }]), hits }
}
