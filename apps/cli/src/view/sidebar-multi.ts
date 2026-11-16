import type { BotListReport, BotState, SessionSummary } from "@mendcode/protocol"
import { glyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import type { ImagePlacement } from "../ui/image-layer"
import { botIcon, type BotIcon, type IconFaces } from "./bot-icon"
import { fit, spread } from "./deck"
import { relativeTime, truncateEnd } from "./session-list"
import { labelSpans, sessionActivityAt, sessionLabel } from "./session-label"
import { ICON_SIDEBAR_WIDTH, projectSessions, SIDEBAR_WIDTH, sessionMark, type SessionMark } from "./sidebar"
import { FRESH_MS, rankProjects } from "./sidebar-projects"
import type { SidebarSection } from "./tui-profile"
import { lineWidth, wrap } from "./wrap"

/**
 * The left sidebar of the experimental bots (docs/agents.md): sections for the projects (the opened folder's sessions, or every
 * folder's as folding groups), the bots, and the opened folder's sessions that belong to no bot; or one narrow column of icons.
 * Loaded by the first frame that needs it, never at start. The classic list (`renderSessionSidebar`) stays as it was.
 *
 * Every row that can be picked has an id: a session's own id, `group:<directory>` or `bot:<name>`.
 */
export type MultiSession = Pick<SessionSummary, "sessionId" | "title" | "state" | "queued" | "updatedAt" | "directory"> & Partial<Pick<SessionSummary, "archivedAt" | "lifecycle" | "draft" | "parentId" | "tool" | "paused" | "lastSeq" | "agent">>

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
  /** A group the user opened (true) or folded (false) by hand; the others follow the default (every shown group is open). */
  open: ReadonlyMap<string, boolean>
  /**
   * Which folders are projects and how many show: absent, every folder with a session is listed (no cap). `canonical` names a
   * linked worktree by its main repo, so its sessions list under it.
   */
  projects?: { isProject(directory: string): boolean; canonical?(directory: string): string; /** Path-only check (no disk): a folder used in the last day lists as a project even when it is no git root. */ eligible?(directory: string): boolean; /** The most projects listed before `+ N more projects`; 0 fills the sidebar's height. */ count: number }
  /** Days of activity a project's list reaches back; older sessions wait behind `+ N older`. Absent, `DEFAULT_RECENT_DAYS`; 0 lists every age. */
  recentDays?: number
  /** Each project's rank time, kept between frames (see `rankProjects`); absent, every frame ranks from scratch. */
  rankStamps?: Map<string, number>
  /** Sessions this terminal opened, by id: when, and the activity time the session had then. */
  visits?: ReadonlyMap<string, { at: number; updatedAt: number }>
  /** The `+ N more projects` row was opened: the whole ranked list shows, ending in `show fewer`. */
  projectsExpanded?: boolean
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
const MORE_PROJECTS = "projects:"
const BOT_CHATS = "botchats:"
const BOT_MORE = "botmore:"
export const DEFAULT_PREVIEW = 5
export const DEFAULT_RECENT_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000
/** An automatic project count lists at least this many projects, whatever their groups cost in rows. */
const AUTO_MIN_PROJECTS = 6
/** Projects other than the opened one preview at most this many sessions. */
const OTHER_PREVIEW = 3
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
/** The row under the last project: `+ N more projects` while the list is cut, `show fewer` once it is whole. */
export const MORE_PROJECTS_ID = MORE_PROJECTS
export const isMoreProjectsId = (id: string) => id === MORE_PROJECTS
export const botName = (id: string) => id.slice(BOT.length)
/** The row under a bot that folds or opens its chats, and the `+ N more` row under its preview. */
export const isBotChatsId = (id: string) => id.startsWith(BOT_CHATS)
export const botChatsName = (id: string) => id.slice(BOT_CHATS.length)
export const isBotMoreId = (id: string) => id.startsWith(BOT_MORE)
export const botMoreName = (id: string) => id.slice(BOT_MORE.length)
/** The key a bot's chats use in `open` (folded or opened by hand) and `expanded` (whole list); a folder path never starts with it. */
export const botKey = (name: string) => `${BOT}${name}`

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
const live = (sessions: readonly MultiSession[], directory: string, input: MultiInput) => (projectSessions(sessions as readonly SessionSummary[], directory) as MultiSession[]).filter((session) => session.archivedAt === undefined && (session.sessionId === input.current || !hiddenEmpty(session, input)))

/**
 * A session this terminal opened within the last day that has taken part since (its activity moved past the one it had when first
 * opened here) is never an empty one, whatever its pushed summary says (a pushed session carries no event count).
 */
const usedHere = (session: MultiSession, input: Pick<MultiInput, "now" | "visits">) => {
  const visit = input.visits?.get(session.sessionId)
  return visit !== undefined && input.now - visit.at <= FRESH_MS && session.updatedAt > visit.updatedAt
}
const hiddenEmpty = (session: MultiSession, input: Pick<MultiInput, "now" | "visits">) => unused(session) && !usedHere(session, input)

/** The first `limit` sessions, plus any beyond them that is open or busy (`keep`), in the same order. */
const preview = (list: readonly MultiSession[], limit: number, keep: (session: MultiSession) => boolean) => list.filter((session, index) => index < limit || keep(session))

/** The folders to list: the opened one first, then the busy ones, then the most recently used up to the cap; `rest` waits behind the more-projects row. */
function directoriesOf(input: MultiInput, busy: (session: MultiSession) => boolean): { shown: string[]; rest: string[] } {
  if (input.scope === "folder") return { shown: [input.directory], rest: [] }
  const listed = input.sessions.filter((session) => session.archivedAt === undefined && (session.sessionId === input.current || !hiddenEmpty(session, input)))
  return rankProjects({ sessions: listed, opened: input.directory, now: input.now, count: input.projects?.count || Number.POSITIVE_INFINITY, busy: busy as never, ...(input.rankStamps ? { stamps: input.rankStamps } : {}), isProject: input.projects?.isProject ?? (() => true), ...(input.projects?.eligible ? { eligible: input.projects.eligible } : {}) })
}

/** Every shown group starts open; a fold or an open by hand wins. */
const isOpen = (input: MultiInput, directory: string) => input.open.get(directory) ?? true

/** Which sections draw: the sessions without a bot only stand in for the projects, which hold them already. */
const shown = (input: MultiInput): SidebarSection[] => input.sections.filter((section) => section !== "sessions" || !input.sections.includes("projects")).filter((section) => section !== "bots" || input.bots !== undefined)

/** A linked worktree's sessions list under its main repo: only the sessions whose folder has such a name are copied. */
function canonicalized(input: MultiInput): MultiInput {
  const canonical = input.projects?.canonical
  if (!canonical || input.scope === "folder") return input
  const directory = canonical(input.directory)
  let changed = directory !== input.directory
  const sessions = input.sessions.map((session) => {
    const named = canonical(session.directory)
    if (named === session.directory) return session
    changed = true
    return { ...session, directory: named }
  })
  return changed ? { ...input, directory, sessions } : input
}

function build(raw: MultiInput): { entries: Entry[]; names: Map<string, string>; starts: Array<{ section: SidebarSection; id: string }> } {
  const input = canonicalized(raw)
  const g = input.glyphs ?? glyphs()
  const inner = (input.icons ? ICON_SIDEBAR_WIDTH : SIDEBAR_WIDTH) - 1 - PAD_X - 2
  const picked = input.focused ? input.selected ?? input.current : undefined
  const unread = new Set(input.unread ?? [])
  const botOf = new Map<string, { name: string; state: BotState; identity: BotListReport["bots"][number]["identity"] }>()
  for (const bot of input.bots?.bots ?? []) for (const project of bot.projects) for (const member of project.sessions) botOf.set(member.sessionId, { name: bot.name, state: bot.state, identity: bot.identity })
  // A chat of a bot lives under its bot: the project lists, their counts and their ranking leave it out (/sessions still lists it).
  const botNames = new Set((input.bots?.bots ?? []).map((bot) => bot.name))
  const ofBot = (session: MultiSession) => botOf.has(session.sessionId) || (session.agent !== undefined && botNames.has(session.agent))
  const projectInput: MultiInput = botNames.size ? { ...input, sessions: input.sessions.filter((session) => !ofBot(session)) } : input
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
  const starts: Array<{ section: SidebarSection; id: string }> = []
  let inSection: SidebarSection | undefined
  const push = (line: Line, id?: string, picture?: { col: number; at: NonNullable<BotIcon["image"]> }) => {
    if (id !== undefined && inSection && !starts.some((start) => start.section === inSection)) starts.push({ section: inSection, id })
    const selected = id !== undefined && id === picked
    entries.push({ line, ...(id !== undefined ? { id, lead: lead(id) } : { lead: [{ text: "  " }] }), ...(selected ? { fill: true } : {}), ...(picture ? { picture } : {}) })
  }
  const blankBetween = () => { if (entries.length) entries.push({ line: [] }) }
  const heading = (title: string, count: number) => push(spread([{ text: title, fg: "muted" }], [{ text: String(count), fg: "muted" }], inner))
  /** `slot` names the picture for the image layer when the terminal draws images: one per row. */
  const icon = (bot: { name: string; state?: BotState; identity: { shape?: never; color?: never } | BotListReport["bots"][number]["identity"] }, slot: string) => botIcon({ name: bot.name, shape: bot.identity.shape, color: bot.identity.color, ascii: input.ascii, state: bot.state, ...(input.faces ? { faces: { ...input.faces, slot: `${input.faces.slot}:${slot}` } } : {}) })
  /** The icon cells of a session row: the bot's icon, else blanks of the same width. */
  // The icon, then exactly one space: a glyph is its cell and the space, a picture its two cells and the space.
  const pictured = Boolean(input.faces && !input.ascii && input.faces.capability.images && !input.faces.capability.ascii)
  const gap = input.ascii || pictured ? 3 : 2
  const iconSpan = (bot: { name: string; state?: BotState; identity: BotListReport["bots"][number]["identity"] } | undefined, slot: string): { span: Span; image?: NonNullable<BotIcon["image"]> } => {
    if (!bot) return { span: { text: " ".repeat(gap) } }
    const made = icon(bot, slot)
    return { span: { text: input.ascii ? `${made.text} ` : made.text, fg: made.fg }, ...(made.image ? { image: made.image } : {}) }
  }

  /** `iconed` false is a bot's own chat list: every row there is that bot's, so none repeats the icon and none leaves a blank for it. */
  const sessionRows = (list: readonly MultiSession[], indent: string, iconed = true) => {
    for (const session of list) {
      const value = mark(session)
      const bot = iconed ? botOf.get(session.sessionId) : undefined
      const room = iconed && input.bots ? gap : 0
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
      const used = indent.length + 2 + room
      const titleRoom = Math.max(4, inner - used - lineWidth(meta) - 2)
      const title = labelSpans(sessionLabel(session as never, { untitled: "Untitled session", marker: "Draft" }), titleRoom, { fg: current || session.sessionId === picked || !quiet ? "text" : "muted", bold: current || session.sessionId === picked })
      const before: Line = [{ text: indent }, { ...symbol(value), text: `${symbol(value).text} ` }]
      push(spread([...before, ...(room ? [made.span] : []), ...title], meta, inner), session.sessionId, made.image ? { col: lineWidth(before), at: made.image } : undefined)
    }
  }

  /** A bot's chats in every folder, newest first: what the daemon reports for it, plus the listed sessions that name it as their agent. */
  const chatsOf = (bot: BotListReport["bots"][number]): MultiSession[] => {
    const known = new Map(input.sessions.map((session) => [session.sessionId, session]))
    const found = new Map<string, MultiSession>()
    for (const project of bot.projects) for (const member of project.sessions) found.set(member.sessionId, known.get(member.sessionId) ?? { sessionId: member.sessionId, title: member.title, state: (member.status === "running" ? "generating" : "idle") as MultiSession["state"], queued: 0, updatedAt: member.updatedAt, directory: project.directory })
    for (const session of input.sessions) if (session.agent === bot.name && !found.has(session.sessionId)) found.set(session.sessionId, session)
    return [...found.values()].filter((session) => session.archivedAt === undefined && (session.sessionId === input.current || !hiddenEmpty(session, input))).sort((a, b) => sessionActivityAt(b as never) - sessionActivityAt(a as never))
  }
  /** The folding row under a bot and, when open, its chats: a preview of three and a `+ N more` row, as another project's group. */
  const botChats = (bot: BotListReport["bots"][number]) => {
    if (input.icons) return
    const chats = chatsOf(bot)
    if (!chats.length) return
    const key = botKey(bot.name)
    const id = `${BOT_CHATS}${bot.name}`
    const busy = (session: MultiSession) => ["running", "approval"].includes(mark(session))
    const open = input.open.get(key) ?? chats.some((session) => session.sessionId === input.current)
    const active = chats.filter(busy).length
    const right: Line = [{ text: !open && active > 0 ? `${active} active` : String(chats.length), fg: !open && active > 0 ? "warning" : "muted" }]
    names.set(id, `${bot.name} chats`)
    push(spread([{ text: "  " }, { text: `${open ? (input.ascii ? "v" : "▾") : (input.ascii ? ">" : "▸")} `, fg: "muted" }, { text: "chats", fg: "muted", bold: id === picked }], right, inner), id)
    if (!open) return
    const expanded = input.expanded?.has(key) === true
    const rows = expanded ? chats : preview(chats, OTHER_PREVIEW, (session) => session.sessionId === input.current || busy(session))
    sessionRows(rows, "    ", false)
    const hidden = chats.length - rows.length
    if (hidden > 0 || (expanded && chats.length > OTHER_PREVIEW)) {
      const more = `${BOT_MORE}${bot.name}`
      push([{ text: "      " }, { text: hidden > 0 ? `+ ${hidden} more` : "show less", fg: "muted", bold: more === picked }], more)
    }
  }

  const sections = shown(input)
  for (const section of sections) {
    inSection = section
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
        botChats(bot)
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
      const ranked = input.icons ? { shown: [input.directory], rest: [] as string[] } : directoriesOf(projectInput, (session) => ["running", "approval"].includes(mark(session)))
      const directories = input.projectsExpanded ? [...ranked.shown, ...ranked.rest] : ranked.shown
      const labels = groupLabels(directories)
      if (!input.icons) { blankBetween(); heading("Projects", ranked.shown.length + ranked.rest.length) }
      else blankBetween()
      // An automatic count fills the height: a group that would not fit is taken back, and with it every plain one after it.
      const auto = !input.icons && !input.projectsExpanded && input.scope === "all" && input.projects?.count === 0
      const room = input.height - (input.header === false ? 0 : 2) - 1
      const ownBusy = (session: MultiSession) => ["running", "approval"].includes(mark(session))
      const recentMs = (input.recentDays ?? DEFAULT_RECENT_DAYS) > 0 ? (input.recentDays ?? DEFAULT_RECENT_DAYS) * DAY_MS : Number.POSITIVE_INFINITY
      let cutAt = -1
      let listed = 0
      for (const [at, directory] of directories.entries()) {
        const list = live(projectInput.sessions, directory, input)
        const forced = directory === input.directory || list.some(ownBusy)
        if (auto && cutAt >= 0 && !forced) continue
        const rollback = entries.length
        listed++
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
          const setting = input.previewCount ?? DEFAULT_PREVIEW
          const limit = directory === input.directory ? setting : Math.min(OTHER_PREVIEW, setting)
          const expanded = !input.icons && input.expanded?.has(directory) === true
          // Sessions older than the window wait behind the row too; the open, busy and pinned ones show at any age.
          const keep = (session: MultiSession) => session.sessionId === input.current || ownBusy(session) || session.lifecycle?.pinnedAt !== undefined
          const recent = input.icons || recentMs === Number.POSITIVE_INFINITY ? list : list.filter((session) => keep(session) || input.now - sessionActivityAt(session as never) <= recentMs)
          const collapsed = input.icons ? list : preview(recent, limit, keep)
          const rows = expanded ? list : collapsed
          sessionRows(rows, input.icons ? "" : "  ")
          const hidden = list.length - rows.length
          if (hidden > 0 || (expanded && list.length > collapsed.length)) {
            const id = `${MORE}${directory}`
            const older = collapsed.length === recent.length
            push([{ text: "    " }, { text: hidden > 0 ? `+ ${hidden} ${older ? "older" : "more"}` : "show less", fg: "muted", bold: id === picked }], id)
          }
        }
        if (auto && !forced && at >= AUTO_MIN_PROJECTS && entries.length > room) {
          entries.length = rollback
          listed--
          cutAt = at
        }
      }
      // The projects past the cap wait behind one row that opens the whole ranked list (and folds it back).
      const waiting = ranked.rest.length + (auto ? directories.length - listed : 0)
      const foldable = waiting > 0 || (input.projectsExpanded === true && input.projects?.count === 0 && directories.length > AUTO_MIN_PROJECTS)
      if (!input.icons && foldable) push([{ text: "  " }, { text: input.projectsExpanded ? "show fewer" : `+ ${waiting} more projects`, fg: "muted", bold: MORE_PROJECTS === picked }], MORE_PROJECTS)
    } else {
      blankBetween()
      const loose = live(projectInput.sessions, input.directory, input)
      if (!input.icons) heading("Sessions", loose.length)
      if (!loose.length && !input.icons) push([{ text: "No sessions yet", fg: "muted" }])
      sessionRows(loose, "")
    }
  }
  if (!sections.length) {
    push([{ text: "Nothing shown", fg: "muted" }])
    if (!input.icons) push([{ text: "/customize › Sidebar sections", fg: "muted" }])
  }
  return { entries, names, starts }
}

/** The ids the keyboard stops on, in drawing order. */
export function multiStops(input: MultiInput): string[] {
  return build(input).entries.flatMap((entry) => entry.id !== undefined ? [entry.id] : [])
}

/** The first pickable row of every section that has one, in drawing order: where Tab and Shift+Tab land. */
export function multiSectionStarts(input: MultiInput): string[] {
  return build(input).starts.map((start) => start.id)
}
/** The sidebar, exactly `input.height` rows by the width of its kind, every row closed by the rule. */
export function renderMultiSidebar(input: MultiInput): { rows: Line[]; hits: Array<{ row: number; id: string }>; /** The bots' pictures at the sidebar's own row and column; empty unless `faces` was given. */ images: ImagePlacement[] } {
  const g = input.glyphs ?? glyphs()
  const width = input.icons ? ICON_SIDEBAR_WIDTH : SIDEBAR_WIDTH
  const inner = width - 1 - PAD_X - 2
  const { entries, names, starts } = build(input)
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
  const summary: Line = input.focused ? [{ text: picked !== undefined && isBotId(picked) ? "↵ chat  o page  → prompt" : starts.length > 1 ? "tab section  → prompt" : "→ prompt", fg: "muted" }] : counts.running || counts.approval
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
