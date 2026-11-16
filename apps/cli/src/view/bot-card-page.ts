import type { BotInfo, BotState } from "@mendcode/protocol"
import type { ImagePlacement } from "../ui/image-layer"
import type { ColorName, Line, Theme } from "../ui/theme"
import { appearancePage } from "./appearance-layout"
import { botFace, CARD_COLS, facePlacement, faceStateOf, type FaceCapability } from "./bot-face"
import { createFaceAnimator } from "./bot-face-anim"
import { botIcon } from "./bot-icon"
import { fit, spread } from "./deck"
import { relativeTime, truncateEnd } from "./session-list"
import { wrap } from "./wrap"

/**
 * The page of one bot (experimental bots, docs/agents.md): who it is, what it runs on, the sessions it has in each folder, and the
 * three things to do with it. Opened by Enter on its row in the sidebar; loaded by that, never at start.
 */
export type BotCardActions = {
  openSession(sessionId: string): Promise<void>
  /** A new session of this bot in `directory`, opened. */
  newSession(directory: string): Promise<void>
  edit(): Promise<void>
  memory(): Promise<void>
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

/** Narrower or shorter than this, the page keeps the one-line header: the face needs room beside the text. */
const FACE_MIN_INNER = 40
const FACE_MIN_HEIGHT = 12
const FACE_GAP = 2

type Row = { kind: "action"; id: "new" | "edit" | "memory"; label: string; hint: string } | { kind: "session"; sessionId: string; title: string; status: string; updatedAt: number }
type Item = { line: Line; row?: number }

const ACTIONS: ReadonlyArray<Extract<Row, { kind: "action" }>> = [
  { kind: "action", id: "new", label: "New session in a folder", hint: "n" },
  { kind: "action", id: "edit", label: "Edit", hint: "e" },
  { kind: "action", id: "memory", label: "Memory", hint: "m" },
]
const STATE_FG: Record<BotState, ColorName> = { working: "primary", idle: "muted", waiting: "warning", problem: "error" }
const STATE_MARK: Record<BotState, readonly [string, string]> = { working: ["●", "*"], idle: ["◌", "o"], waiting: ["…", "~"], problem: ["!", "!"] }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])

/** The folders a new session may start in: the ones the bot already works in, then every other folder with sessions. */
export const foldersFor = (bot: Pick<BotInfo, "projects">, known: readonly string[]): string[] => [...new Set([...bot.projects.map((project) => project.directory), ...known])]

export function createBotCard({ bot, folders, actions, face }: { bot: BotInfo; folders: readonly string[]; actions: BotCardActions; face?: BotCardFace | undefined }): BotCard {
  const animator = face ? createFaceAnimator({ onChange: face.onFrame, ...(face.reducedMotion ? { reducedMotion: face.reducedMotion } : {}), ...(face.setTimer ? { setTimer: face.setTimer } : {}), ...(face.clearTimer ? { clearTimer: face.clearTimer } : {}) }) : undefined
  animator?.setState(faceStateOf(bot.state))
  const rows: Row[] = [...ACTIONS, ...bot.projects.flatMap((project) => project.sessions.map((session): Row => ({ kind: "session", sessionId: session.sessionId, title: session.title, status: session.status, updatedAt: session.updatedAt })))]
  let selected = 0
  /** The folder list of "New session", while it is open. */
  let picking: { selected: number } | undefined

  async function activate(row: Row) {
    if (row.kind === "session") return actions.openSession(row.sessionId)
    if (row.id === "edit") return actions.edit()
    if (row.id === "memory") return actions.memory()
    picking = { selected: 0 }
    actions.redraw()
  }

  async function key(value: string) {
    if (picking) {
      if (value === "\x1b" || value === "q") picking = undefined
      else if (UP.has(value)) picking.selected = Math.max(0, picking.selected - 1)
      else if (DOWN.has(value)) picking.selected = Math.min(folders.length - 1, picking.selected + 1)
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
    else if (value === "n") return activate(ACTIONS[0]!)
    else if (value === "e") return activate(ACTIONS[1]!)
    else if (value === "m") return activate(ACTIONS[2]!)
    else if (value === "\r" || value === " ") return activate(rows[selected]!)
    return actions.redraw()
  }

  /** The page's top block, with the face beside the text; the face's picture is placed at `placements` when the terminal draws images. */
  function faceBlock({ inner, ascii, theme }: { inner: number; ascii: boolean; theme?: Pick<Theme, "colors"> | undefined }): { rows: Line[]; picture?: ImagePlacement } {
    const drawn = botFace({
      name: bot.name, shape: bot.identity.shape, color: bot.identity.color, state: faceStateOf(bot.state), size: "card",
      capability: { ...face!.capability(), ascii, ...(theme ? { theme } : {}) }, frame: animator!.frame(), label: bot.state,
    })
    const [unicodeMark, asciiMark] = STATE_MARK[bot.state]
    const room = inner - CARD_COLS - FACE_GAP
    const text: Line[] = [
      [{ text: truncateEnd(bot.name, Math.max(1, room)), fg: "text", bold: true }],
      [{ text: `${ascii ? asciiMark : unicodeMark} ${bot.state}`, fg: STATE_FG[bot.state] }, { text: `  ${truncateEnd(bot.identity.origin, Math.max(1, room - bot.state.length - 4))}`, fg: "muted" }],
      ...(bot.description ? wrap(bot.description, room).slice(0, 2).map((line): Line => [{ text: line, fg: "muted" }]) : []),
      [{ text: "Model ", fg: "muted" }, { text: bot.model ?? "default", fg: "text" }, { text: "  Permission ", fg: "muted" }, { text: bot.permission ?? "default", fg: "text" }],
    ]
    // Under a picture the glyph rows are blank cells; the state word under it stays text.
    const left = drawn.lines.map((line, at): Line => drawn.image && at < drawn.pictureRows ? [{ text: " ".repeat(CARD_COLS) }] : line)
    const rows = Array.from({ length: Math.max(left.length, text.length) }, (_, at): Line => [...(left[at] ?? [{ text: " ".repeat(CARD_COLS) }]), { text: " ".repeat(FACE_GAP) }, ...fit(text[at] ?? [], room)])
    const picture = facePlacement({ face: drawn, slot: "bot-card", row: 0, col: 2 })
    return { rows, ...(picture ? { picture } : {}) }
  }

  function render({ width, height, now, ascii, theme, placements }: { width: number; height: number; now: number; ascii?: boolean; theme?: Pick<Theme, "colors">; placements?: ImagePlacement[] }): Line[] {
    const inner = Math.max(1, width - 4)
    const icon = botIcon({ name: bot.name, shape: bot.identity.shape, color: bot.identity.color, ascii })
    const [unicodeMark, asciiMark] = STATE_MARK[bot.state]
    const items: Item[] = []
    const plain = (line: Line) => items.push({ line })
    const selectable = (line: Line, row: number) => {
      const on = row === (picking ? -1 : selected)
      items.push({ line: on ? line.map((span) => ({ ...span, bg: "element" as const })) : line, row })
    }
    let picture: ImagePlacement | undefined
    if (face && inner >= FACE_MIN_INNER && height >= FACE_MIN_HEIGHT) {
      const block = faceBlock({ inner, ascii: ascii === true, theme })
      for (const row of block.rows) plain(row)
      picture = block.picture
    } else {
      plain(spread([{ text: ascii ? `${icon.text} ` : icon.text, fg: icon.fg }, { text: bot.name, fg: "text", bold: true }, { text: `  ${bot.identity.origin}`, fg: "muted" }], [{ text: `${ascii ? asciiMark : unicodeMark} ${bot.state}`, fg: STATE_FG[bot.state] }], inner))
      if (bot.description) for (const text of wrap(bot.description, inner)) plain([{ text, fg: "muted" }])
      plain([{ text: "Model ", fg: "muted" }, { text: bot.model ?? "default", fg: "text" }, { text: "   Permission ", fg: "muted" }, { text: bot.permission ?? "default", fg: "text" }])
    }
    plain([])
    if (picking) {
      plain([{ text: "Folder", fg: "heading", bold: true }, { text: "  for a new session of this bot", fg: "muted" }])
      if (!folders.length) plain([{ text: "No folder known yet", fg: "muted" }])
      folders.forEach((directory, index) => {
        const on = index === picking!.selected
        const line: Line = [{ text: on ? (ascii ? "> " : "› ") : "  ", fg: "primary" }, { text: truncateEnd(directory, inner - 2), fg: "text", bold: on }]
        items.push({ line: on ? line.map((span) => ({ ...span, bg: "element" as const })) : line })
      })
    } else {
      plain([{ text: "Actions", fg: "heading", bold: true }])
      ACTIONS.forEach((action, index) => selectable(spread([{ text: selected === index ? (ascii ? "> " : "› ") : "  ", fg: "primary" }, { text: action.label, fg: "text", bold: selected === index }], [{ text: action.hint, fg: "muted" }], inner), index))
      plain([])
      plain([{ text: "Sessions", fg: "heading", bold: true }, { text: `  ${rows.length - ACTIONS.length}`, fg: "muted" }])
      if (rows.length === ACTIONS.length) plain([{ text: "None yet · New session starts one", fg: "muted" }])
      let index = ACTIONS.length
      for (const project of bot.projects) {
        plain([{ text: truncateEnd(project.directory, inner), fg: "muted" }])
        for (const session of project.sessions) {
          const at = index++
          const on = at === selected
          selectable(spread([{ text: on ? (ascii ? "> " : "› ") : "  ", fg: "primary" }, { text: truncateEnd(session.title || "Untitled session", Math.max(4, inner - 22)), fg: "text", bold: on }], [{ text: `${session.status} · ${relativeTime(now, session.updatedAt)}`, fg: "muted" }], inner), at)
        }
      }
    }
    // The window keeps the picked row in view.
    const room = Math.max(1, height - 2)
    const focus = Math.max(0, items.findIndex((item) => picking ? false : item.row === selected))
    const start = Math.max(0, Math.min(focus - Math.floor(room / 2), items.length - room))
    const body = items.slice(start, start + room).map((item) => fit(item.line, inner))
    // The page's header takes two rows and a margin two cells; a face scrolled out of the window shows no picture.
    if (picture && start === 0) placements?.push({ ...picture, row: 2 })
    return appearancePage({ title: "Bot", hints: picking ? "↑↓ · ↵ start here · esc back" : "↑↓ · ↵ open · n new · e edit · m memory · esc back", body, width, height })
  }

  return { render, key, setVisible: (visible) => animator?.setVisible(visible), stop: () => animator?.stop() }
}
