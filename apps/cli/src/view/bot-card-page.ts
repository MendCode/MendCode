import type { BotInfo, BotState } from "@mendcode/protocol"
import type { ImagePlacement } from "../ui/image-layer"
import type { ColorName, Line, Theme } from "../ui/theme"
import { botFace, CARD_COLS, facePlacement, faceStateOf, type FaceCapability } from "./bot-face"
import { createFaceAnimator } from "./bot-face-anim"
import { botIcon } from "./bot-icon"
import { clip, panelGrid, spread } from "./deck"
import { pickerFrame } from "./picker-frame"
import { relativeTime, truncateEnd } from "./session-list"
import { wrap } from "./wrap"

/**
 * The page of one bot (experimental bots, docs/agents.md): who it is, what it runs on, the chats it has in each folder, and the
 * things to do with it. Opened by `o` on its row in the sidebar or `/bot open`; loaded by that, never at start. It is drawn like the
 * other list pages (stash, drafts): the shared header, a summary line, panels, the wheel and Esc.
 */
export type BotCardActions = {
  openSession(sessionId: string): Promise<void>
  /** A new session of this bot in `directory`, opened. */
  newSession(directory: string): Promise<void>
  /** Opens the bot form on this bot. */
  edit(): Promise<void>
  /** Opens the delete confirmation of this bot. */
  delete(): Promise<void>
  memory(): Promise<void>
  /** An external bot: opens the app it lives in. */
  openApp?(): Promise<void>
  close(): void
  redraw(): void
}
/** The face of the page: what the terminal can show, and the frame clock's hooks. Absent, the page keeps its one-line icon header. */
export type BotCardFace = {
  capability(): FaceCapability
  /** The face moved: draw again. */
  onFrame(): void
  reducedMotion?(): boolean
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}
export type BotCard = {
  /** `placements` receives the face's picture (screen rows and columns) when the terminal draws images. */
  render(input: { width: number; height: number; now: number; ascii?: boolean; theme?: Pick<Theme, "colors">; placements?: ImagePlacement[] }): Line[]
  key(key: string): Promise<void>
  /** Whether the page is on screen: the face moves only while it is, and no timer exists otherwise. */
  setVisible(visible: boolean): void
  /** The page is closed: the frame clock is gone for good. */
  stop(): void
}

/** The two-panel layout starts here, as the other list pages; below it the page is the list alone. */
const TWO_PANELS = 70
/** The face needs this much height to sit above the text in the left panel. */
const FACE_MIN_HEIGHT = 16
/** Where the left panel's content starts in the page: the header (2 rows), the box's border and its padding row; and the box's border and space. */
const FACE_AT = { row: 4, col: 2 }
const PAGE_STEP = 10

type Row = { kind: "action"; id: "new" | "edit" | "memory" | "delete" | "app"; label: string; hint: string } | { kind: "session"; sessionId: string; title: string; status: string; updatedAt: number }
/** `row` is the index in `rows` of a line the cursor can stand on. */
type Item = { line: Line; row?: number }

const ACTIONS: ReadonlyArray<Extract<Row, { kind: "action" }>> = [
  { kind: "action", id: "new", label: "New chat in a folder", hint: "n" },
  { kind: "action", id: "edit", label: "Edit", hint: "e" },
  { kind: "action", id: "memory", label: "Memory", hint: "m" },
  { kind: "action", id: "delete", label: "Delete", hint: "d" },
]
const OPEN_APP = (app: string): Extract<Row, { kind: "action" }> => ({ kind: "action", id: "app", label: `Open in ${app}`, hint: "o" })
const STATE_FG: Record<BotState, ColorName> = { working: "primary", idle: "muted", waiting: "warning", problem: "error" }
const STATE_MARK: Record<BotState, readonly [string, string]> = { working: ["●", "*"], idle: ["◌", "o"], waiting: ["…", "~"], problem: ["!", "!"] }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const PAGE_UP = new Set(["\x1b[5~"])
const PAGE_DOWN = new Set(["\x1b[6~"])
const FIRST = new Set(["\x1b[H", "\x1bOH", "\x1b[1~"])
const LAST = new Set(["\x1b[F", "\x1bOF", "\x1b[4~"])

/** The folders a new session may start in: the ones the bot already works in, then every other folder with sessions. */
export const foldersFor = (bot: Pick<BotInfo, "projects">, known: readonly string[]): string[] => [...new Set([...bot.projects.map((project) => project.directory), ...known])]

/** The bot's folders with the newest chat first in each, and the folder of the newest chat first. */
const newestFirst = (bot: Pick<BotInfo, "projects">): BotInfo["projects"] => bot.projects
  .map((project) => ({ ...project, sessions: [...project.sessions].sort((a, b) => b.updatedAt - a.updatedAt) }))
  .sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0))

/** `external`: a bot of another app (a connector's): only a new chat and, when it names its app, opening that app; edit, memory and delete belong to the app. */
export function createBotCard({ bot, folders, actions, face, external }: { bot: BotInfo; folders: readonly string[]; actions: BotCardActions; face?: BotCardFace | undefined; external?: { app?: string | undefined } }): BotCard {
  const actionList: ReadonlyArray<Extract<Row, { kind: "action" }>> = external ? [ACTIONS[0]!, ...(external.app && actions.openApp ? [OPEN_APP(external.app)] : [])] : ACTIONS
  const animator = face ? createFaceAnimator({ onChange: face.onFrame, ...(face.reducedMotion ? { reducedMotion: face.reducedMotion } : {}), ...(face.setTimer ? { setTimer: face.setTimer } : {}), ...(face.clearTimer ? { clearTimer: face.clearTimer } : {}) }) : undefined
  animator?.setState(faceStateOf(bot.state))
  const projects = newestFirst(bot)
  const rows: Row[] = [...actionList, ...projects.flatMap((project) => project.sessions.map((session): Row => ({ kind: "session", sessionId: session.sessionId, title: session.title, status: session.status, updatedAt: session.updatedAt })))]
  let selected = 0
  /** The folder list of "New chat", while it is open. */
  let picking: { selected: number } | undefined

  async function activate(row: Row) {
    if (row.kind === "session") return actions.openSession(row.sessionId)
    if (row.id === "app") return actions.openApp?.()
    if (row.id === "edit") return actions.edit()
    if (row.id === "memory") return actions.memory()
    if (row.id === "delete") return actions.delete()
    picking = { selected: 0 }
    actions.redraw()
  }

  async function key(value: string) {
    if (picking) {
      if (value === "\x1b" || value === "q") picking = undefined
      else if (UP.has(value)) picking.selected = Math.max(0, picking.selected - 1)
      else if (DOWN.has(value)) picking.selected = Math.min(folders.length - 1, picking.selected + 1)
      else if (PAGE_UP.has(value)) picking.selected = Math.max(0, picking.selected - PAGE_STEP)
      else if (PAGE_DOWN.has(value)) picking.selected = Math.min(folders.length - 1, picking.selected + PAGE_STEP)
      else if (value === "\r" && folders[picking.selected] !== undefined) {
        const directory = folders[picking.selected]!
        picking = undefined
        await actions.newSession(directory)
        return
      }
      return actions.redraw()
    }
    if (value === "\x1b" || value === "q") return actions.close()
    if (UP.has(value)) selected = Math.max(0, selected - 1)
    else if (DOWN.has(value)) selected = Math.min(rows.length - 1, selected + 1)
    else if (PAGE_UP.has(value)) selected = Math.max(0, selected - PAGE_STEP)
    else if (PAGE_DOWN.has(value)) selected = Math.min(rows.length - 1, selected + PAGE_STEP)
    else if (FIRST.has(value)) selected = 0
    else if (LAST.has(value)) selected = rows.length - 1
    else if (value === "n") return activate(ACTIONS[0]!)
    else if (value === "o" && external) { const open = actionList.find((action) => action.id === "app"); if (open) return activate(open) }
    else if (value === "e" && !external) return activate(ACTIONS[1]!)
    else if (value === "m" && !external) return activate(ACTIONS[2]!)
    else if (value === "d" && !external) return activate(ACTIONS[3]!)
    else if (value === "\r" || value === " ") return activate(rows[selected]!)
    return actions.redraw()
  }

  /** The list panel's lines: the actions, then the chats by folder (or, while "New chat" is open, the folders to start in). */
  function listItems({ width, ascii, now }: { width: number; ascii: boolean; now: number }): Item[] {
    const items: Item[] = []
    const mark = (on: boolean) => ({ text: on ? (ascii ? "> " : "› ") : "  ", fg: "primary" as const })
    if (picking) {
      if (!folders.length) items.push({ line: [{ text: "No folder known yet", fg: "muted" }] })
      folders.forEach((directory, index) => items.push({ line: clip([mark(index === picking!.selected), { text: truncateEnd(directory, Math.max(1, width - 2)), fg: "text", bold: index === picking!.selected }], width), row: index }))
      return items
    }
    actionList.forEach((action, index) => items.push({ line: spread([mark(selected === index), { text: action.label, fg: "text", bold: selected === index }], [{ text: action.hint, fg: "muted" }], width), row: index }))
    const total = rows.length - actionList.length
    items.push({ line: [] }, { line: [{ text: "Chats", fg: "heading", bold: true }, { text: `  ${total}`, fg: "muted" }] })
    if (!total) items.push({ line: [{ text: external ? "Chats open as normal sessions · /sessions lists them" : "None yet · enter on the bot in the sidebar starts one", fg: "muted" }] })
    let index = actionList.length
    for (const project of projects) {
      if (!project.sessions.length) continue
      items.push({ line: [{ text: truncateEnd(project.directory, width), fg: "muted" }] })
      for (const session of project.sessions) {
        const at = index++
        const on = at === selected
        items.push({ line: spread([mark(on), { text: truncateEnd(session.title || "Untitled session", Math.max(4, width - 24)), fg: "text", bold: on }], [{ text: `${session.status} · ${relativeTime(now, session.updatedAt)}`, fg: "muted" }], width), row: at })
      }
    }
    return items
  }

  /** The left panel: the face over the name, state, origin, what it is for, and the model and permission. */
  function aboutLines({ width, ascii, theme, withFace }: { width: number; ascii: boolean; theme?: Pick<Theme, "colors"> | undefined; withFace: boolean }): { lines: Line[]; picture?: ImagePlacement } {
    const [unicodeMark, asciiMark] = STATE_MARK[bot.state]
    const lines: Line[] = []
    let picture: ImagePlacement | undefined
    const faced = face !== undefined && withFace
    if (face && withFace) {
      const drawn = botFace({
        name: bot.name, shape: bot.identity.shape, color: bot.identity.color, state: faceStateOf(bot.state), size: "card",
        capability: { ...face.capability(), ascii, ...(theme ? { theme } : {}) }, frame: animator!.frame(), label: bot.state,
      })
      // Under a picture the glyph rows are blank cells; the state word under it stays text.
      lines.push(...drawn.lines.map((line, at): Line => drawn.image && at < drawn.pictureRows ? [{ text: " ".repeat(CARD_COLS) }] : line), [])
      picture = facePlacement({ face: drawn, slot: "bot-card", ...FACE_AT })
    } else {
      const icon = botIcon({ name: bot.name, shape: bot.identity.shape, color: bot.identity.color, ascii })
      lines.push([{ text: ascii ? `${icon.text} ` : icon.text, fg: icon.fg }, { text: truncateEnd(bot.name, Math.max(1, width - 3)), fg: "text", bold: true }])
    }
    if (faced) lines.push([{ text: truncateEnd(bot.name, width), fg: "text", bold: true }])
    lines.push([{ text: `${ascii ? asciiMark : unicodeMark} ${bot.state}`, fg: STATE_FG[bot.state] }, { text: `  ${truncateEnd(bot.identity.origin, Math.max(1, width - bot.state.length - 4))}`, fg: "muted" }])
    if (bot.description) lines.push([], ...wrap(bot.description, width).slice(0, 4).map((line): Line => [{ text: line, fg: "muted" }]))
    lines.push([], [{ text: "Model ", fg: "muted" }, { text: truncateEnd(bot.model ?? "default", Math.max(1, width - 6)), fg: "text" }], ...(external ? [] : [[{ text: "Permission ", fg: "muted" as const }, { text: bot.permission ?? "default", fg: "text" as const }] as Line]))
    return { lines, ...(picture ? { picture } : {}) }
  }

  function render({ width, height, now, ascii, theme, placements }: { width: number; height: number; now: number; ascii?: boolean; theme?: Pick<Theme, "colors"> | undefined; placements?: ImagePlacement[] }): Line[] {
    const plainAscii = ascii === true
    const [unicodeMark, asciiMark] = STATE_MARK[bot.state]
    const summary = `${plainAscii ? asciiMark : unicodeMark} ${bot.state} · ${bot.identity.origin} · ${bot.model ?? "default"}${external ? "" : ` · permission ${bot.permission ?? "default"}`}`
    const hints = picking ? "↑↓ select · enter start here · esc back" : external ? `↑↓ select · enter open · n new${actionList.length > 1 ? " · o open app" : ""} · esc back` : "↑↓ select · enter open · n new · e edit · m memory · d delete · esc back"
    const room = Math.max(0, height - 2)
    const two = width >= TWO_PANELS
    // The list scrolls to keep the cursor in view: its panel shows `room` rows less the box's border and padding.
    const listWidth = Math.max(1, (two ? Math.floor(width * 0.6) : width) - 4)
    const items = listItems({ width: listWidth, ascii: plainAscii, now })
    const at = Math.max(0, items.findIndex((item) => item.row === (picking ? picking.selected : selected)))
    const scroll = Math.max(0, at - Math.max(1, room - 6))
    const panels = [{ title: picking ? "Folder for a new chat" : "Actions and chats", active: true, scroll, body: (w: number): Line[] => listItems({ width: w, ascii: plainAscii, now }).map((item) => item.line), weight: 3 }]
    let picture: ImagePlacement | undefined
    if (two) {
      const about = aboutLines({ width: Math.max(1, Math.floor((width - 1) * 0.4) - 4), ascii: plainAscii, theme, withFace: room >= FACE_MIN_HEIGHT })
      picture = about.picture
      panels.unshift({ title: "Bot", active: false, scroll: 0, body: () => about.lines, weight: 2 })
    }
    const frame = pickerFrame(`Bot · ${bot.name}`, hints, width, height, panelGrid({ width, padding: true, compact: false, maxColumns: two ? 2 : 1, heights: [room], rows: [panels] }), summary)
    if (picture && placements) placements.push(picture)
    return frame
  }

  return { render, key, setVisible: (visible) => animator?.setVisible(visible), stop: () => animator?.stop() }
}
