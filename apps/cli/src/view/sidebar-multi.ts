import type { BotListReport, BotState, SessionSummary } from "@mendcode/protocol"
import { glyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import type { ImagePlacement } from "../ui/image-layer"
import { botIcon, type BotIcon, type IconFaces } from "./bot-icon"
import { fit, spread } from "./deck"
import { relativeTime, truncateEnd } from "./session-list"
import { labelSpans, sessionActivityAt, sessionLabel } from "./session-label"
import { ICON_SIDEBAR_WIDTH, projectSessions, SIDEBAR_WIDTH, sessionMark, type SessionMark } from "./sidebar"
import type { SidebarSection } from "./tui-profile"
import { lineWidth, wrap } from "./wrap"

/**
 * The left sidebar of the experimental bots (docs/agents.md): sections for the projects (the opened folder's sessions, or every
 * folder's as folding groups), the bots, and the opened folder's sessions that belong to no bot; or one narrow column of icons.
 * Loaded by the first frame that needs it, never at start. The classic list (`renderSessionSidebar`) stays as it was.
 *
 * Every row that can be picked has an id: a session's own id, `group:<directory>` or `bot:<name>`.
 */
export type MultiSession = Pick<SessionSummary, "sessionId" | "title" | "state" | "queued" | "updatedAt" | "directory"> & Partial<Pick<SessionSummary, "archivedAt" | "lifecycle" | "draft" | "parentId" | "tool" | "paused" | "lastSeq">>

export type MultiInput = {
  sessions: readonly MultiSession[]
  current: string
  /** The opened project: its group comes first and starts open. */
  directory: string
  selected?: string
  focused: boolean
  height: number
  now: number
  /** The bots, once asked for; undefined draws no bots section and no icon column. */
  bots?: BotListReport | undefined
  sections: readonly SidebarSection[]
  scope: "folder" | "all"
  icons: boolean
  /** A group the user opened (true) or folded (false) by hand; the others follow the default (only the opened project is open). */
  open: ReadonlyMap<string, boolean>
  /** Sessions a project shows before its `+ N more` row (the profile's `sidebarPreviewCount`); absent, `DEFAULT_PREVIEW`. */
  previewCount?: number
  /** The folders whose whole list the user opened with the more row; the others show the preview. */
  expanded?: ReadonlySet<string>
  unread?: readonly string[]
  spinner?: string
  blink?: boolean
  ascii?: boolean
  header?: boolean
  glyphs?: Glyphs
  /** The terminal draws images: bot icons become pictures (see `botIcon`); absent, the glyphs of today. */
  faces?: IconFaces | undefined
}

const PAD_X = 2
const GROUP = "group:"
const BOT = "bot:"
const MORE = "more:"
export const DEFAULT_PREVIEW = 5
/** An untitled session whose log holds no more than this many events (created, permission mode) was opened and left alone. */
const UNUSED_EVENTS = 2
const STATE_WORD: Record<BotState, string> = { working: "working", idle: "idle", waiting: "waiting", problem: "problem" }
const STATE_FG: Record<BotState, ColorName> = { working: "primary", idle: "muted", waiting: "warning", problem: "error" }
const STATE_MARK: Record<BotState, readonly [string, string]> = { working: ["●", "*"], idle: ["◌", "o"], waiting: ["…", "~"], problem: ["!", "!"] }
const MARK_FG: Record<SessionMark, ColorName> = { approval: "warning", running: "primary", error: "error", unread: "success", queued: "muted", settled: "muted", idle: "muted" }

type Entry = { line: Line; lead?: Line; id?: string; fill?: boolean; /** A bot's picture over the cells `col` in from the line's start. */ picture?: { col: number; at: NonNullable<BotIcon["image"]> } }

export const isGroupId = (id: string) => id.startsWith(GROUP)
export const isBotId = (id: string) => id.startsWith(BOT)
export const groupDirectory = (id: string) => id.slice(GROUP.length)
/** The row under a project's preview: `+ N more` while it is short, `show less` once opened. */
export const isMoreId = (id: string) => id.startsWith(MORE)
export const moreDirectory = (id: string) => id.slice(MORE.length)
export const botName = (id: string) => id.slice(BOT.length)

const baseName = (directory: string) => directory.replace(/\/+$/, "").split("/").pop() || directory
/** The folder's own name, with its parent's when two listed folders share it. */
function groupLabels(directories: readonly string[]): Map<string, string> {
  const counts = new Map<string, number>()
  for (const directory of directories) counts.set(baseName(directory), (counts.get(baseName(directory)) ?? 0) + 1)
  return new Map(directories.map((directory) => {
    const parts = directory.replace(/\/+$/, "").split("/").filter(Boolean)
    return [directory, (counts.get(baseName(directory)) ?? 0) > 1 ? parts.slice(-2).join("/") : baseName(directory)]
  }))
}

/**
 * A chat nobody used: no title, no draft, nothing queued, idle, and a log that stops at its first events. The daemon already
 * leaves the structurally empty ones out of the list; this catches the ones a model choice kept alive. They stay in /sessions.
 */
const unused = (session: MultiSession) => !session.title.trim() && !session.draft && session.queued === 0 && session.state === "idle" && !session.paused && session.lifecycle === undefined && session.lastSeq !== undefined && session.lastSeq <= UNUSED_EVENTS

/** The folder's listed sessions in drawing order, without the unused ones (the open session is always kept). */
const live = (sessions: readonly MultiSession[], directory: string, current: string) => (projectSessions(sessions as readonly SessionSummary[], directory) as MultiSession[]).filter((session) => session.archivedAt === undefined && (session.sessionId === current || !unused(session)))

/** The first `limit` sessions, plus any beyond them that is open or busy (`keep`), in the same order. */
const preview = (list: readonly MultiSession[], limit: number, keep: (session: MultiSession) => boolean) => list.filter((session, index) => index < limit || keep(session))

/** The folders to list, the opened one first and the rest by their latest activity. */
function directoriesOf(input: MultiInput): string[] {
  if (input.scope === "folder") return [input.directory]
  const latest = new Map<string, number>()
  for (const session of input.sessions) if (session.archivedAt === undefined) latest.set(session.directory, Math.max(latest.get(session.directory) ?? 0, sessionActivityAt(session)))
  const others = [...latest.keys()].filter((directory) => directory !== input.directory).sort((a, b) => latest.get(b)! - latest.get(a)! || a.localeCompare(b))
  return [input.directory, ...others]
}

const isOpen = (input: MultiInput, directory: string) => input.open.get(directory) ?? directory === input.directory

/** Which sections draw: the sessions without a bot only stand in for the projects, which hold them already. */
const shown = (input: MultiInput): SidebarSection[] => input.sections.filter((section) => section !== "sessions" || !input.sections.includes("projects")).filter((section) => section !== "bots" || input.bots !== undefined)

function build(input: MultiInput): { entries: Entry[]; names: Map<string, string> } {
  const g = input.glyphs ?? glyphs()
  const inner = (input.icons ? ICON_SIDEBAR_WIDTH : SIDEBAR_WIDTH) - 1 - PAD_X - 2
  const picked = input.focused ? input.selected ?? input.current : undefined
  const unread = new Set(input.unread ?? [])
  const botOf = new Map<string, { name: string; state: BotState; identity: BotListReport["bots"][number]["identity"] }>()
  for (const bot of input.bots?.bots ?? []) for (const project of bot.projects) for (const member of project.sessions) botOf.set(member.sessionId, { name: bot.name, state: bot.state, identity: bot.identity })
  const mark = (session: MultiSession) => sessionMark(session as never, unread.has(session.sessionId) && session.sessionId !== input.current)
  const symbol = (value: SessionMark): Span => {
    if (value === "running") return { text: input.spinner || g.running, fg: "primary" }
    if (value === "approval") return { text: g.ask, fg: input.blink === false ? "muted" : "warning" }
    const text = value === "error" ? g.fail : value === "unread" ? g.dot : value === "queued" ? (input.ascii ? "~" : g.queue) : value === "settled" ? g.collapsed : input.ascii ? "." : "·"
    return { text, fg: MARK_FG[value] }
  }
  const names = new Map<string, string>()
  const entries: Entry[] = []
  const lead = (id: string): Line => id === input.current ? [{ text: "▌", fg: "primary" }, { text: " " }] : id === picked ? [{ text: input.ascii ? ">" : "›", fg: "muted" }, { text: " " }] : [{ text: "  " }]
  const push = (line: Line, id?: string, picture?: { col: number; at: NonNullable<BotIcon["image"]> }) => {
    const selected = id !== undefined && id === picked
    entries.push({ line, ...(id !== undefined ? { id, lead: lead(id) } : { lead: [{ text: "  " }] }), ...(selected ? { fill: true } : {}), ...(picture ? { picture } : {}) })
  }
  const blankBetween = () => { if (entries.length) entries.push({ line: [] }) }
  const heading = (title: string, count: number) => push(spread([{ text: title, fg: "muted" }], [{ text: String(count), fg: "muted" }], inner))
  /** `slot` names the picture for the image layer when the terminal draws images: one per row. */
  const icon = (bot: { name: string; state?: BotState; identity: { shape?: never; color?: never } | BotListReport["bots"][number]["identity"] }, slot: string) => botIcon({ name: bot.name, shape: bot.identity.shape, color: bot.identity.color, ascii: input.ascii, state: bot.state, ...(input.faces ? { faces: { ...input.faces, slot: `${input.faces.slot}:${slot}` } } : {}) })
  /** The icon cells of a session row: the bot's icon, else blanks of the same width. */
  const gap = input.ascii ? 3 : 2
  const iconSpan = (bot: { name: string; state?: BotState; identity: BotListReport["bots"][number]["identity"] } | undefined, slot: string): { span: Span; image?: NonNullable<BotIcon["image"]> } => {
    if (!bot) return { span: { text: " ".repeat(gap) } }
    const made = icon(bot, slot)
    return { span: { text: input.ascii ? `${made.text} ` : made.text, fg: made.fg }, ...(made.image ? { image: made.image } : {}) }
  }

  const sessionRows = (list: readonly MultiSession[], indent: string) => {
    for (const session of list) {
      const value = mark(session)
      const bot = botOf.get(session.sessionId)
      names.set(session.sessionId, session.title || "Untitled session")
      const made = iconSpan(bot, session.sessionId)
      if (input.icons) {
        const mark: Span = { ...symbol(value), text: `${symbol(value).text} ` }
        push([mark, ...(bot ? [made.span] : [])], session.sessionId, made.image ? { col: lineWidth([mark]), at: made.image } : undefined)
        continue
      }
      const current = session.sessionId === input.current
      const quiet = value === "idle" || value === "settled" || value === "queued"
      const meta: Line = [{ text: relativeTime(input.now, sessionActivityAt(session)), fg: "muted" }]
      const used = indent.length + 2 + (input.bots ? gap : 0)
      const titleRoom = Math.max(4, inner - used - lineWidth(meta) - 2)
      const title = labelSpans(sessionLabel(session as never, { untitled: "Untitled session", marker: "Draft" }), titleRoom, { fg: current || session.sessionId === picked || !quiet ? "text" : "muted", bold: current || session.sessionId === picked })
      const before: Line = [{ text: indent }, { ...symbol(value), text: `${symbol(value).text} ` }]
      push(spread([...before, ...(input.bots ? [made.span] : []), ...title], meta, inner), session.sessionId, made.image ? { col: lineWidth(before), at: made.image } : undefined)
    }
  }

  const sections = shown(input)
  for (const section of sections) {
    if (section === "bots") {
      const bots = input.bots!
      if (!input.icons) { blankBetween(); heading("Bots", bots.bots.length + bots.external.length) }
      else blankBetween()
      if (!bots.bots.length && !bots.external.length && !input.icons) push([{ text: "No bots · /bot new <name>", fg: "muted" }])
      for (const bot of bots.bots) {
        names.set(`${BOT}${bot.name}`, bot.name)
        const made = icon(bot, `${BOT}${bot.name}`)
        const [unicodeMark, asciiMark] = STATE_MARK[bot.state]
        const stateMark = input.ascii ? asciiMark : unicodeMark
        const fg = STATE_FG[bot.state]
        const iconCells: Span = { text: input.ascii ? `${made.text} ` : made.text, fg: made.fg }
        const picture = made.image ? { col: 0, at: made.image } : undefined
        if (input.icons) { push([iconCells, { text: stateMark, fg }], `${BOT}${bot.name}`, picture); continue }
        const right: Line = [{ text: `${stateMark} ${STATE_WORD[bot.state]}`, fg }]
        const room = inner - lineWidth(right) - 2 - lineWidth([iconCells])
        const name = truncateEnd(bot.name, Math.max(3, room))
        const originRoom = room - lineWidth([{ text: name }]) - 2
        const origin = originRoom >= 3 ? [{ text: `  ${truncateEnd(bot.identity.origin, originRoom)}`, fg: "muted" as const }] : []
        push(spread([iconCells, { text: name, fg: "text", bold: `${BOT}${bot.name}` === picked }, ...origin], right, inner), `${BOT}${bot.name}`, picture)
      }
      for (const external of bots.external) {
        if (input.icons) continue
        const [unicodeMark, asciiMark] = STATE_MARK[external.state]
        const stateMark = input.ascii ? asciiMark : unicodeMark
        const identity = external.identity ?? { origin: external.origin }
        // An imported bot keeps its glyph: it has no row to pick, so no picture is placed for it.
        const made = botIcon({ name: external.name, shape: identity.shape, color: identity.color, ascii: input.ascii })
        push(spread([{ text: input.ascii ? `${made.text} ` : made.text, fg: made.fg }, { text: truncateEnd(external.name, 14), fg: "muted" }, { text: `  ${truncateEnd(external.origin, 8)}`, fg: "muted" }], [{ text: `${stateMark} ${STATE_WORD[external.state]}`, fg: STATE_FG[external.state] }], inner))
      }
    } else if (section === "projects") {
      const directories = input.icons ? [input.directory] : directoriesOf(input)
      const labels = groupLabels(directories)
      if (!input.icons) { blankBetween(); heading("Projects", directories.length) }
      else blankBetween()
      for (const directory of directories) {
        const list = live(input.sessions, directory, input.current)
        const open = input.icons || isOpen(input, directory)
        const active = list.filter((session) => ["running", "approval"].includes(mark(session))).length
        if (!input.icons) {
          const id = `${GROUP}${directory}`
          names.set(id, labels.get(directory) ?? baseName(directory))
          const holdsCurrent = list.some((session) => session.sessionId === input.current)
          // A folded group says how many of its sessions work or wait; otherwise how many it holds.
          const right: Line = [{ text: !open && active > 0 ? `${active} active` : String(list.length), fg: !open && active > 0 ? "warning" : "muted" }]
          push(spread([{ text: `${open ? (input.ascii ? "v" : "▾") : (input.ascii ? ">" : "▸")} `, fg: "muted" }, { text: truncateEnd(labels.get(directory) ?? baseName(directory), inner - lineWidth(right) - 4), fg: "text", bold: holdsCurrent || id === picked }], right, inner), id)
        }
        if (open) {
          if (!list.length && !input.icons) push([{ text: "  No sessions yet", fg: "muted" }])
          // Past the limit a project shows the open session and the busy ones, and a row that opens the rest (or folds it again).
          const limit = input.previewCount ?? DEFAULT_PREVIEW
          const expanded = !input.icons && input.expanded?.has(directory) === true
          const rows = input.icons || expanded ? list : preview(list, limit, (session) => session.sessionId === input.current || ["running", "approval"].includes(mark(session)))
          sessionRows(rows, input.icons ? "" : "  ")
          const hidden = list.length - rows.length
          if (hidden > 0 || (expanded && list.length > limit)) {
            const id = `${MORE}${directory}`
            push([{ text: "    " }, { text: hidden > 0 ? `+ ${hidden} more` : "show less", fg: "muted", bold: id === picked }], id)
          }
        }
      }
    } else {
      blankBetween()
      const loose = live(input.sessions, input.directory, input.current).filter((session) => !botOf.has(session.sessionId))
      if (!input.icons) heading("Sessions", loose.length)
      if (!loose.length && !input.icons) push([{ text: "No sessions yet", fg: "muted" }])
      sessionRows(loose, "")
    }
  }
  if (!sections.length) {
    push([{ text: "Nothing shown", fg: "muted" }])
    if (!input.icons) push([{ text: "/customize › Sidebar sections", fg: "muted" }])
  }
  return { entries, names }
}

/** The ids the keyboard stops on, in drawing order. */
export function multiStops(input: MultiInput): string[] {
  return build(input).entries.flatMap((entry) => entry.id !== undefined ? [entry.id] : [])
}

/** The sidebar, exactly `input.height` rows by the width of its kind, every row closed by the rule. */
export function renderMultiSidebar(input: MultiInput): { rows: Line[]; hits: Array<{ row: number; id: string }>; /** The bots' pictures at the sidebar's own row and column; empty unless `faces` was given. */ images: ImagePlacement[] } {
  const g = input.glyphs ?? glyphs()
  const width = input.icons ? ICON_SIDEBAR_WIDTH : SIDEBAR_WIDTH
  const inner = width - 1 - PAD_X - 2
  const { entries, names } = build(input)
  const picked = input.focused ? input.selected ?? input.current : undefined
  const unread = new Set(input.unread ?? [])
  // The header's right side counts what works and what waits, over the sessions listed.
  const counts = { running: 0, approval: 0 }
  for (const session of input.sessions) {
    if (session.archivedAt !== undefined) continue
    const value = sessionMark(session as never, unread.has(session.sessionId) && session.sessionId !== input.current)
    if (value === "running") counts.running++
    else if (value === "approval") counts.approval++
  }
  const summary: Line = input.focused ? [{ text: "→ prompt", fg: "muted" }] : counts.running || counts.approval
    ? [...(counts.running ? [{ text: `${input.spinner || g.running} ${counts.running}`, fg: "primary" as const }] : []), ...(counts.running && counts.approval ? [{ text: "  " }] : []), ...(counts.approval ? [{ text: `${g.ask} ${counts.approval}`, fg: "warning" as const }] : [])]
    : [{ text: "← focus", fg: "muted" }]
  const head: Entry[] = input.icons || input.header === false ? [] : [{ line: spread([{ text: "Sessions", fg: "primary", bold: true }], summary, inner) }, { line: [] }]
  // The icons column names the picked row under the list, since an icon alone does not say who it is.
  const caption = input.icons && picked && names.get(picked) ? wrap(names.get(picked)!, inner).slice(0, 2) : []
  const reserved = caption.length ? caption.length + 1 : 0
  const room = Math.max(0, input.height - head.length - reserved)
  const overflow = entries.length > room
  const shownRoom = overflow ? Math.max(0, room - 1) : room
  const anchor = picked ?? input.current
  const lastOfPicked = entries.findLastIndex((entry) => entry.id === anchor)
  const start = overflow && lastOfPicked >= 0 ? Math.max(0, Math.min(lastOfPicked - shownRoom + 1, entries.length - shownRoom)) : 0
  const windowed = entries.slice(start, start + shownRoom)
  const body: Entry[] = [...head]
  const hits: Array<{ row: number; id: string }> = []
  const images: ImagePlacement[] = []
  for (const entry of windowed) {
    if (entry.id !== undefined) hits.push({ row: body.length, id: entry.id })
    // One cell of margin, the two of the marker, then the cells before the icon.
    const placed = entry.picture?.at({ row: body.length, col: 1 + PAD_X + entry.picture.col })
    if (placed && body.length < input.height) images.push(placed)
    body.push(entry)
  }
  if (overflow) {
    const hidden = entries.filter((entry, index) => (index < start || index >= start + windowed.length) && entry.id !== undefined).length
    const [up, down] = input.ascii ? ["^", "v"] : ["↑", "↓"]
    body.push({ line: [{ text: `${start > 0 ? `${up} ` : ""}${start + windowed.length < entries.length ? `${down} ` : ""}${hidden} more`, fg: "muted" }] })
  }
  while (body.length < input.height - reserved) body.push({ line: [] })
  if (reserved) body.push({ line: [] }, ...caption.map((text): Entry => ({ line: [{ text, fg: "text", bold: true }] })))
  const rows = body.slice(0, input.height).map(({ line, lead, fill }): Line => {
    const row: Line = [{ text: " " }, ...(lead ?? [{ text: " ".repeat(PAD_X) }]), ...fit(line, inner), { text: " ", fg: "muted" }]
    return [...(fill ? row.map((span) => ({ ...span, bg: "element" as const })) : row), { text: "│", fg: "border" }]
  })
  return { rows, hits, images }
}
