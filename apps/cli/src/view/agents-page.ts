import type { AgentCommandsReport, ForegroundState, SessionBackgroundEntry } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { shortenMiddle, truncateEnd } from "./session-list"
import { lineWidth, textWidth, wrap } from "./wrap"
import { clip, fit, panelGrid, deck, deckChrome, spread, type DeckStatus } from "./deck"
import { section, tabsRow, type PageTab } from "./page"
import { formatPaddedElapsed as formatElapsed } from "./time"

/** A session that is doing something right now (pushed by `session.activity`, seeded from `session.list`). */
export type AgentSession = {
  sessionId: string
  title: string
  tags?: string[]
  directory: string
  state: ForegroundState
  updatedAt: number
  /** Epoch ms the running turn started. */
  since?: number
  /** The tool in flight, by its short title. */
  tool?: string
  /** The approval or question the turn waits on. */
  pending?: string
  queued: number
  /** Paused (`session.control`): the running turn finishes, then nothing starts until resumed. */
  paused?: boolean
}

/** A running `task` sub-agent of the current session and its latest tool line. */
/** `facts`: what its task record knows (model, usage, files written), drawn as a second muted row when there is room. */
export type AgentSubtask = { itemId: string; title: string; latest: string; facts?: string }

export type AgentShell = { id: string; sessionId: string; command: string; startedAt: number; status: "running" | "exited" | "killed"; exitCode?: number; endedAt?: number; /** An engine's own task (Claude Code's) says whether it is an agent or a command; the daemon's shells are commands. */ kind?: "agent" | "command" }

export type AgentsPageState = {
  /** Session id of the highlighted row; the first row when unset or gone. */
  selected?: string
  /** 0 Running, 1 Done (shells), 2 Background (registered sessions); unset means Running. */
  tab?: number
  scroll?: number
  /** Session whose stop waits for a second `x`; any other key drops it. */
  confirm?: string
}

export type AgentControl = "pause" | "resume" | "stop"
export type AgentsPageAction = { type: "commands" } | { type: "none" } | { type: "close" } | { type: "open"; sessionId: string } | { type: "approval"; sessionId: string } | { type: "control"; sessionId: string; action: AgentControl }

export const AGENTS_LIMITS = { sessions: 20, subtasks: 6, shells: 6, done: 20 } as const

const NONE: AgentsPageAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const HINTS = "↑↓ select · enter open · a approval · p pause · x stop · tab/1-2 tabs · esc back"
const PAGE_TABS: PageTab[] = [{ key: "1", label: "Running" }, { key: "2", label: "Done" }]

const RANK: Record<ForegroundState, number> = { waiting_approval: 0, tool: 1, generating: 1, compacting: 2, cancelling: 2, queued: 3, error: 9, idle: 9 }
const STATE_LABEL: Record<ForegroundState, string> = {
  idle: "idle",
  queued: "queued",
  generating: "working",
  tool: "tool",
  waiting_approval: "needs approval",
  compacting: "compacting",
  cancelling: "cancelling",
  error: "error",
}
const STATE_COLOR: Record<ForegroundState, ColorName> = {
  idle: "muted",
  queued: "muted",
  generating: "text",
  tool: "text",
  waiting_approval: "warning",
  compacting: "warning",
  cancelling: "warning",
  error: "error",
}

export function createAgentsPageState(): AgentsPageState {
  return {}
}

/** Running, waiting or held, or paused (a paused idle session stays listed so it can be resumed). */
export const isBusy = (session: Pick<AgentSession, "state"> & { paused?: boolean }) => session.paused === true || session.state !== "idle" && session.state !== "error"

/** "working", or "paused" once held; a turn still running on a paused session reads "working · pausing". */
export function sessionStateLabel(session: Pick<AgentSession, "state" | "paused">): string {
  if (!session.paused) return STATE_LABEL[session.state]
  return session.state === "idle" || session.state === "queued" || session.state === "error" ? "paused" : `${STATE_LABEL[session.state]} · pausing`
}

/** Busy sessions, those needing the user first, then the longest running; bounded by AGENTS_LIMITS.sessions. */
export function busySessions(sessions: AgentSession[]): AgentSession[] {
  return sessions
    .filter(isBusy)
    .sort((a, b) => RANK[a.state] - RANK[b.state] || (a.since ?? Number.MAX_SAFE_INTEGER) - (b.since ?? Number.MAX_SAFE_INTEGER) || b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId))
}

export { formatElapsed }

/** The session `p` (pause/resume) and `x` (stop) act on: the highlighted row of the Running or Background tab. */
function controlTarget(state: AgentsPageState, sessions: AgentSession[], backgrounds?: SessionBackgroundEntry[]): { sessionId: string; paused: boolean } | undefined {
  if (state.tab === 1) return undefined
  const paused = (sessionId: string) => sessions.find((session) => session.sessionId === sessionId)?.paused === true
  if (state.tab === 2) {
    const rows = backgroundSessions(backgrounds ?? [])
    const current = rows[Math.max(0, rows.findIndex((entry) => entry.sessionId === state.selected))]
    return current ? { sessionId: current.sessionId, paused: paused(current.sessionId) } : undefined
  }
  const rows = busySessions(sessions).slice(0, AGENTS_LIMITS.sessions)
  const current = rows[Math.max(0, rows.findIndex((row) => row.sessionId === state.selected))]
  return current ? { sessionId: current.sessionId, paused: current.paused === true } : undefined
}

/** Handles one raw key over the busy sessions. Returns the same state object when nothing changed. */
export function agentsPageKey(state: AgentsPageState, key: string, sessions: AgentSession[], backgrounds?: SessionBackgroundEntry[]): { state: AgentsPageState; action: AgentsPageAction } {
  if (key === "p" || key === "x") {
    const target = controlTarget(state, sessions, backgrounds)
    const { confirm: _confirm, ...calm } = state
    if (!target) return { state: calm, action: NONE }
    if (key === "p") return { state: calm, action: { type: "control", sessionId: target.sessionId, action: target.paused ? "resume" : "pause" } }
    if (state.confirm === target.sessionId) return { state: calm, action: { type: "control", sessionId: target.sessionId, action: "stop" } }
    return { state: { ...state, confirm: target.sessionId }, action: NONE }
  }
  if (state.confirm) {
    const { confirm: _confirm, ...calm } = state
    state = calm
  }
  const count = backgrounds !== undefined ? 3 : 2
  if (state.tab === 2 && key !== "\t" && key !== "\x1b[Z" && key !== "1" && key !== "2") {
    const rows = backgroundSessions(backgrounds ?? [])
    const at = Math.max(0, rows.findIndex((entry) => entry.sessionId === state.selected))
    const current = rows[at]
    if ((UP.has(key) || DOWN.has(key)) && rows.length) return { state: { ...state, scroll: 0, selected: rows[Math.max(0, Math.min(rows.length - 1, at + (DOWN.has(key) ? 1 : -1)))]!.sessionId }, action: NONE }
    if (key === "\x1b[5~" || key === "\x1b[6~") return { state: { ...state, scroll: Math.max(0, Math.min(20_000, (state.scroll ?? 0) + (key === "\x1b[6~" ? 5 : -5))) }, action: NONE }
    if (key === "\r" && current) return { state, action: { type: "open", sessionId: current.sessionId } }
    if (key === "a" && current?.state === "needs_input") return { state, action: { type: "approval", sessionId: current.sessionId } }
  }
  const rows = busySessions(sessions).slice(0, AGENTS_LIMITS.sessions)
  const found = rows.findIndex((row) => row.sessionId === state.selected)
  const index = found < 0 ? 0 : found
  const current = rows[index]
  const running = (state.tab ?? 0) === 0
  const move = (to: number) => {
    const next = rows[Math.max(0, Math.min(to, rows.length - 1))]
    return running && next && next !== current ? { state: { ...state, selected: next.sessionId }, action: NONE } : { state, action: NONE }
  }
  const goTo = (tab: number) => (tab === (state.tab ?? 0) ? { state, action: NONE } : { state: { ...state, tab, ...(state.scroll !== undefined ? { scroll: 0 } : {}) }, action: NONE })
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  if (key === "\t" || key === "\x1b[Z") return goTo(((state.tab ?? 0) + (key === "\t" ? 1 : count - 1)) % count)
  if (key === "1" || key === "2" || key === "3" && count === 3) return goTo(Number(key) - 1)
  if (UP.has(key)) return move(index - 1)
  if (DOWN.has(key)) return move(index + 1)
  if (key === "c") return { state, action: { type: "commands" } }
  if (key === "\r") return running && current ? { state, action: { type: "open", sessionId: current.sessionId } } : { state, action: NONE }
  if (key === "a") {
    const target = current?.state === "waiting_approval" ? current : rows.find((row) => row.state === "waiting_approval")
    return target ? { state: { ...state, selected: target.sessionId }, action: { type: "approval", sessionId: target.sessionId } } : { state, action: NONE }
  }
  return { state, action: NONE }
}

function projectName(directory: string) {
  const parts = directory.split("/").filter(Boolean)
  return parts.length ? parts.slice(-2).join("/") : directory
}

function sessionRowLine(input: { session: AgentSession; selected: boolean; current: boolean; width: number; now: number; glyphs: Glyphs }): Line {
  const { session, selected, current, width, now, glyphs } = input
  const color = STATE_COLOR[session.state]
  const marker: Span = selected ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " }
  const elapsed = session.since !== undefined ? formatElapsed(now - session.since) : ""
  const right: Line = [{ text: sessionStateLabel(session), fg: session.paused ? "warning" : color, bold: session.state === "waiting_approval" }, ...(elapsed ? [{ text: `  ${elapsed}`, fg: "muted" as const }] : [])]
  const room = Math.max(4, width - lineWidth(right) - 2 - 4 - (current ? 10 : 0))
  const title = truncateEnd(session.title.trim() || "untitled", room)
  return spread(
    [marker, { text: `${glyphs.running} `, fg: color, bold: session.state === "waiting_approval" }, { text: title, fg: selected ? "primary" : "text", bold: selected }, ...(current ? [{ text: " (current)", fg: "muted" as const }] : [])],
    right,
    width,
  )
}

/** The project, then the approval it waits on or the tool in flight, then the held queue; indented under the title. */
function sessionDetailLine(input: { session: AgentSession; width: number; glyphs: Glyphs }): Line {
  const { session, width, glyphs } = input
  const indent = 4
  const available = Math.max(1, width - indent)
  const detail: Line = [{ text: " ".repeat(indent) }, { text: shortenMiddle(projectName(session.directory), Math.max(6, Math.floor(available / 3))), fg: "muted", dim: true }]
  let used = lineWidth(detail)
  if (session.pending) {
    const pending = truncateEnd(session.pending, Math.max(4, width - used - 3))
    detail.push({ text: " · ", fg: "muted" }, { text: pending, fg: "warning" })
    used += textWidth(pending) + 3
  } else if (session.tool) {
    const toolGlyph = `${glyphs.tool} `
    const tool = truncateEnd(session.tool, Math.max(4, width - used - textWidth(toolGlyph) - 3))
    detail.push({ text: " · ", fg: "muted" }, { text: toolGlyph, fg: "muted" }, { text: tool, fg: "body" })
    used += textWidth(toolGlyph) + textWidth(tool) + 3
  }
  if (session.queued > 0) {
    const queueText = `+${session.queued} queued`
    const remaining = width - used - 3
    if (remaining >= textWidth(queueText)) detail.push({ text: " · ", fg: "muted" }, { text: queueText, fg: "muted" })
    else if (remaining >= 6) detail.push({ text: " · ", fg: "muted" }, { text: truncateEnd(queueText, remaining), fg: "muted" })
  }
  if (session.tags?.length) detail.push({ text: ` · ${session.tags.map((tag) => `#${tag}`).join(" ")}`, fg: "primary" })
  return detail
}

/** Rows of `lines` that fit `room`, with a "+N more" row in place of the last ones when the rest is cut. */
function limited(items: Line[], room: number): Line[] {
  if (items.length <= room) return items
  const shown = Math.max(0, room - 1)
  return [...items.slice(0, shown), [{ text: `+${items.length - shown} more`, fg: "muted", dim: true }]]
}

function subtaskRows(subtasks: AgentSubtask[], width: number, glyphs: Glyphs): Line[] {
  const titleWidth = Math.max(8, Math.floor(width / 2) - 4)
  const rows = subtasks.slice(0, AGENTS_LIMITS.subtasks).map((task): Line => {
    const left: Line = [{ text: `${glyphs.tool} `, fg: "heading" }, { text: truncateEnd(task.title.replace(/^task:\s*/, ""), titleWidth), fg: "text" }]
    const room = Math.max(4, width - lineWidth(left) - 2)
    return spread(left, [{ text: truncateEnd(task.latest || "starting…", room), fg: "muted" }], width)
  }).flatMap((row, index): Line[] => {
    const facts = subtasks[index]!.facts
    return facts ? [row, [{ text: "  " }, { text: truncateEnd(facts, Math.max(4, width - 2)), fg: "muted", dim: true }]] : [row]
  })
  if (subtasks.length > AGENTS_LIMITS.subtasks) rows.push([{ text: `+${subtasks.length - AGENTS_LIMITS.subtasks} more`, fg: "muted", dim: true }])
  return rows
}

function shellRow(input: { task: AgentShell; titles: Record<string, string>; width: number; now: number; glyphs: Glyphs }): Line {
  const { task, titles, width, now, glyphs } = input
  const running = task.status === "running"
  const clean = task.status === "exited" && (task.exitCode ?? 0) === 0
  const status = running ? formatElapsed(now - task.startedAt) : task.status === "killed" ? "killed" : `exit ${task.exitCode ?? 0}`
  const tone: ColorName = running ? "text" : clean ? "success" : "muted"
  const right: Line = [{ text: status, fg: tone }]
  const owner = titles[task.sessionId]
  const leftRoom = width - lineWidth(right) - 2 - 2
  const command = truncateEnd(task.command.replace(/\s+/g, " "), Math.max(4, owner ? Math.floor(leftRoom * 0.6) : leftRoom))
  const left: Line = [{ text: running ? `${glyphs.running} ` : clean ? `${glyphs.ok} ` : `${glyphs.fail} `, fg: tone }, { text: command, fg: "body" }]
  if (owner) left.push({ text: `  ${truncateEnd(owner, Math.max(4, leftRoom - textWidth(command) - 2))}`, fg: "muted", dim: true })
  return spread(left, right, width)
}

const isDone = (task: AgentShell) => task.status !== "running"

function backgroundSessions(entries: SessionBackgroundEntry[]) {
  return entries.filter((entry) => !entry.metadata?.archived).sort((a, b) => Number(b.metadata?.pinned || b.pinned) - Number(a.metadata?.pinned || a.pinned) || b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId))
}

/** Renders exactly `height` lines of at most `width` cells. Push-driven: the caller re-renders on events. */
export function renderAgentsPage(input: {
  sessions: AgentSession[]
  metadata?: AgentCommandsReport["metadata"]
  backgrounds?: SessionBackgroundEntry[]
  backgroundError?: string
  subtasks?: AgentSubtask[]
  shells?: AgentShell[]
  /** Session titles by id, to say which session owns a shell task. */
  titles?: Record<string, string>
  state: AgentsPageState
  currentSessionId?: string
  width: number
  height: number
  now: number
  glyphs?: Glyphs
}): Line[] {
  const { state, width, height, now } = input
  if (height <= 0 || width <= 0) return []
  const glyphs = input.glyphs ?? defaultGlyphs()
  const titles = input.titles ?? {}
  const subtasks = input.subtasks ?? []
  const shells = (input.shells ?? []).filter((task) => task.status === "running" || (task.endedAt ?? 0) > 0)
  const sessions = input.sessions.map((session) => {
    const meta = input.metadata?.find((entry) => entry.sessionId === session.sessionId)
    return meta ? { ...session, ...(meta.title ? { title: meta.title } : {}), tags: meta.tags } : session
  })
  const all = busySessions(sessions)
  const rows = all.slice(0, AGENTS_LIMITS.sessions)
  const needing = all.filter((s) => s.state === "waiting_approval").length
  const tab = state.tab === 2 && input.backgrounds !== undefined ? 2 : state.tab === 1 ? 1 : 0
  const pageTabs = input.backgrounds !== undefined ? [...PAGE_TABS, { key: "3", label: "Background" }] : PAGE_TABS

  const runningShells = shells.filter((task) => !isDone(task))
  const doneShells = shells.filter(isDone)
  const status: DeckStatus | undefined = state.confirm ? { label: "x again to stop", tone: "warn" } : needing ? { label: `${needing} ${needing === 1 ? "needs" : "need"} approval`, tone: "warn" } : undefined
  const summary = [subtasks.length ? `${subtasks.length} sub-agent${subtasks.length === 1 ? "" : "s"}` : "", runningShells.length ? `${runningShells.length} background` : ""].filter(Boolean).join(" · ")

  const inner = Math.max(1, width - 2)
  const coordinated = input.metadata !== undefined || input.backgrounds !== undefined
  const room = Math.max(0, height - (coordinated ? 5 : deckChrome(HINTS, width, { tabs: true })))
  const frame = (body: Line[]) => {
    if (!coordinated) return deck({ page: "Agents", ...(status ? { status } : {}), subtitle: `${all.length} busy`, summary, tabs: PAGE_TABS, activeTab: tab, body, hints: HINTS, width, height })
    const hint = width < 70 ? "↑↓ · enter · a · c · p · x · esc" : width < 110 ? "↑↓ select · enter open · a · c commands · p · x · tab · r · esc" : `↑↓ select · enter open · a approval · c commands · p pause · x stop · tab · ${tab === 2 ? "pgup/dn · " : ""}r · esc`
    const right: Line = [{ text: hint, fg: "muted" }]
    const title: Line = [{ text: `Agents · ${all.length} busy`, fg: "primary", bold: true }]
    if (summary) title.push({ text: ` · ${summary}`, fg: "muted" })
    if (status) title.push({ text: ` · ${status.label}`, fg: "warning" })
    const head: Line[] = [[], spread(clip(title, Math.max(1, inner - lineWidth(right) - 1)), right, inner), tabsRow(pageTabs, tab, inner), [{ text: "─".repeat(inner), fg: "border" }], []]
    return [...head, ...Array.from({ length: room }, (_, index) => body[index] ?? [])].slice(0, height).map((row) => [{ text: " " }, ...fit(row, inner), { text: " " }])
  }

  if (tab === 2) {
    const entries = backgroundSessions(input.backgrounds ?? [])
    const at = Math.max(0, entries.findIndex((entry) => entry.sessionId === state.selected))
    const selected = entries[at]
    const row = (text: string): Line => [{ text, fg: "text" }]
    const panelHeight = width < 110 ? Math.max(4, Math.floor((room - 1) / 2)) : room
    const pausedIds = new Set(sessions.filter((session) => session.paused).map((session) => session.sessionId))
    const list: Line[] = entries.length ? entries.map((entry, i) => [{ text: `${i === at ? "›" : " "} ${entry.state}${pausedIds.has(entry.sessionId) ? " · paused" : ""} · ${entry.metadata?.title ?? entry.session.title}`, fg: i === at ? "primary" : "text" }]) : [[{ text: input.backgroundError || "No background sessions", fg: input.backgroundError ? "error" : "muted" }]]
    return frame(panelGrid({ width: inner, padding: true, compact: false, maxColumns: width < 110 ? 1 : 2, heights: [panelHeight, Math.max(4, room - panelHeight - 1)], rows: [[
      { title: `Background sessions · ${entries.length}`, body: list, scroll: Math.max(0, at - panelHeight + 5) },
      { title: "Selected session", scroll: state.scroll ?? 0, body: (w) => selected ? [
        ...(width < 70 ? [] : [row(selected.sessionId), ...wrap(selected.session.directory, w).map(row), ...(selected.session.parentId ? [row(`Owner ${selected.session.parentId}`)] : [])]),
        row(`${selected.session.agent ?? "build"} · ${selected.state}${pausedIds.has(selected.sessionId) ? " · paused" : ""}`),
        ...(width < 70 && selected.summary ? wrap(selected.summary, w).map(row) : []),
        ...(selected.writer ? [row(`Terminal present · ${formatElapsed(selected.writer.expiresAt - now)} lease`)] : []),
        ...(selected.metadata?.group ? [row(`Group ${selected.metadata.group}`)] : []),
        ...(selected.metadata?.priority ? [row(`Priority ${selected.metadata.priority}`)] : []),
        ...(selected.metadata?.tags.length ? [row(selected.metadata.tags.map((tag) => `#${tag}`).join(" "))] : []),
        ...[selected.metadata?.notes, ...(width < 70 ? [] : [selected.summary]), selected.error, input.backgroundError].filter((text): text is string => Boolean(text)).flatMap((text) => [[], ...wrap(text, w).map(row)]),
      ] : [] },
    ]] }))
  }

  if (tab === 1) {
    if (doneShells.length === 0) return frame(coordinated ? panelGrid({ width: inner, padding: true, compact: false, heights: [room], rows: [[{ title: "Finished shells", body: [[{ text: "No finished shells", fg: "muted" }]] }]] }) : [[{ text: "nothing finished yet", fg: "muted" }], [{ text: "background shells that exited or were killed appear here", fg: "muted", dim: true }]])
    const finished = [...doneShells].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, AGENTS_LIMITS.done)
    if (coordinated) return frame(panelGrid({ width: inner, padding: true, compact: false, heights: [room], rows: [[{ title: "Finished shells", body: (w) => finished.map((task) => shellRow({ task, titles, width: w, now, glyphs })) }]] }))
    const lines = finished.map((task) => shellRow({ task, titles, width: inner, now, glyphs }))
    if (doneShells.length > finished.length) lines.push([{ text: `+${doneShells.length - finished.length} more`, fg: "muted", dim: true }])
    return frame(limited(lines, room))
  }

  if (rows.length === 0 && subtasks.length === 0 && runningShells.length === 0) {
    if (coordinated) return frame(panelGrid({ width: inner, padding: true, compact: false, heights: [room], rows: [[{ title: "Sessions", body: [[{ text: "No busy sessions", fg: "muted" }]] }]] }))
    return frame([[{ text: "nothing running", fg: "muted" }], [{ text: "busy sessions, sub-agents and background shells appear here", fg: "muted", dim: true }]])
  }

  if (width >= 110) {
    const selectedIndex = Math.max(0, rows.findIndex((session) => session.sessionId === state.selected))
    const selected = rows[selectedIndex]
    return frame(panelGrid({ width: inner, ...(coordinated ? { padding: true } : {}), heights: [Math.max(8, room - 9), 8], rows: [
      [
        { title: "Sessions", weight: 2, body: (w) => rows.length ? rows.map((session) => sessionRowLine({ session, selected: session.sessionId === selected?.sessionId, current: session.sessionId === input.currentSessionId, width: w, now, glyphs })) : [[{ text: "No busy sessions", fg: "muted" }]], scroll: Math.max(0, selectedIndex + 2 - (room - 11)) },
        { title: "Selected session", weight: 3, body: (w) => selected ? [sessionRowLine({ session: selected, selected: true, current: selected.sessionId === input.currentSessionId, width: w, now, glyphs }), sessionDetailLine({ session: selected, width: w, glyphs })] : [[{ text: "No busy sessions", fg: "muted" }]] },
      ],
      [{ title: "Sub-agents", body: (w) => subtasks.length ? subtaskRows(subtasks, w, glyphs) : [[{ text: "No sub-agents", fg: "muted" }]] }, { title: "Background", body: (w) => runningShells.length ? runningShells.map((task) => shellRow({ task, titles, width: w, now, glyphs })) : [[{ text: "No running shells", fg: "muted" }]] }],
    ] }))
  }

  const selectedId = rows.some((row) => row.sessionId === state.selected) ? state.selected : rows[0]?.sessionId
  const subtaskBlock = subtasks.length ? section({ title: "Sub-agents", body: subtaskRows(subtasks, inner, glyphs), width: inner }) : []
  const shellLines = runningShells.slice(0, AGENTS_LIMITS.shells).map((task) => shellRow({ task, titles, width: inner, now, glyphs }))
  if (runningShells.length > AGENTS_LIMITS.shells) shellLines.push([{ text: `+${runningShells.length - AGENTS_LIMITS.shells} more`, fg: "muted", dim: true }])
  const shellBlock = runningShells.length ? section({ title: "Background", body: shellLines, width: inner }) : []
  const others = [subtaskBlock, shellBlock].filter((block) => block.length > 0)
  const othersHeight = others.reduce((sum, block) => sum + block.length + 1, 0)

  // Sessions come first and keep the selection in view; the other sections take what is left.
  const sessionRoom = room - (coordinated ? 4 : 2)
  const leftover = sessionRoom - othersHeight
  const avail = leftover >= 2 ? leftover : sessionRoom
  let capacity = Math.min(rows.length, Math.max(1, Math.floor(avail / 2)))
  if (rows.length > capacity) capacity = Math.max(1, Math.floor((avail - 1) / 2))
  const selectedIndex = Math.max(0, rows.findIndex((row) => row.sessionId === selectedId))
  const first = Math.min(Math.max(0, selectedIndex - capacity + 1), Math.max(0, rows.length - capacity))
  const sessionLines: Line[] = []
  for (const session of rows.slice(first, first + capacity)) {
    sessionLines.push(sessionRowLine({ session, selected: session.sessionId === selectedId, current: session.sessionId === input.currentSessionId, width: inner, now, glyphs }))
    sessionLines.push(sessionDetailLine({ session, width: inner, glyphs }))
  }
  if (rows.length > capacity) sessionLines.push([{ text: `+${rows.length - capacity} more`, fg: "muted", dim: true }])

  const body: Line[] = section({ title: "Sessions", body: rows.length ? sessionLines : [[{ text: "no busy sessions", fg: "muted", dim: true }]], width: inner })
  for (const block of others) body.push(...(body.length ? [[] as Line] : []), ...block)
  if (coordinated) {
    const extra = [
      ...(subtasks.length ? [{ title: "Sub-agents", body: (w: number) => subtaskRows(subtasks, w, glyphs) }] : []),
      ...(runningShells.length ? [{ title: "Background", body: (w: number) => runningShells.map((task) => shellRow({ task, titles, width: w, now, glyphs })) }] : []),
    ]
    return frame(panelGrid({ width: inner, padding: true, compact: false, maxColumns: width < 70 ? 1 : 2, rows: [[{ title: "Sessions", body: (w) => rows.length ? rows.slice(first, first + capacity).flatMap((session) => [sessionRowLine({ session, selected: session.sessionId === selectedId, current: session.sessionId === input.currentSessionId, width: w, now, glyphs }), sessionDetailLine({ session, width: w, glyphs })]) : [[{ text: "No busy sessions", fg: "muted" }]] }], ...(extra.length ? [extra] : [])], heights: [extra.length ? Math.max(5, room - 9) : room, 8] }))
  }
  return frame(body)
}
