import type { CommandInput, CommandReply } from "@mendcode/client"
import type { SessionEvent } from "@mendcode/protocol"
import { appHarness, conversation, plain, tempDir, type Harness, type HarnessOptions } from "./session-ui-harness"
import { writeTuiProfile, DEFAULT_TUI_PROFILE, type TuiProfile } from "../src/view/tui-profile"
import { locateQuote, parseCommentMessage } from "../src/view/reply-comments"
import { SIDEBAR_PRESETS } from "../src/view/sidebar-spec"
import { rightBarCells } from "../src/view/right-bar"

/** Shared by the comment tests: the real app on a fake screen, an answer with every kind of passage, and a real mouse drag over it. */

export const OPUS = "Use Opus 5 for the planner and keep the executor on codex. It starts slower, but the plan is checked once before anything runs."
export const CODEX = "Use codex for both. Faster, but the plan is never reviewed."
export const WARN = "Before either, tell the user the schema change cannot be undone once the first batch has run."
export const CODE = "await migrate({ dryRun: true })"
export const ANSWER = ["Two ways to run the migration:", "", `1. ${OPUS}`, `2. ${CODEX}`, "", WARN, "", "```ts", CODE, "```", "", "Pick one and I will start."].join("\n")
/** ctrl+g, the comment key every keyboard has, and the name the hints give it. */
export const CTRL_G = "\x07"
export const COMMENT_HINT = "ctrl+g"
export const ALT_Q = "\x1bq"
export const ALT_L = "\x1bl"
export const ENTER = "\r"
export const ESC = "\x1b"
export const CTRL_C = "\x03"

export type Size = { width: number; height: number; sidebar?: boolean }
export const SIZES: readonly Size[] = [{ width: 60, height: 24 }, { width: 80, height: 24 }, { width: 120, height: 40 }, { width: 200, height: 50 }, { width: 120, height: 40, sidebar: true }, { width: 200, height: 50, sidebar: true }]
export const tag = (size: Size) => `${size.width}x${size.height}${size.sidebar ? " with sidebar" : ""}`

export type Scene = { h: Harness; size: Size; chatW: number; talk: ReturnType<typeof conversation>; dataDir: string; directory: string; log: SessionEvent[] }

export type SceneOptions = {
  profile?: Partial<TuiProfile>
  exchanges?: ReadonlyArray<readonly [string, string]>
  mode?: "full" | "balanced" | "minimal"
  dataDir?: string
  directory?: string
  sessionId?: Harness["sessionId"]
  reply?: HarnessOptions["reply"]
  /** Events to feed instead of the one exchange: a restart of the same session. */
  replay?: readonly SessionEvent[]
  harness?: Partial<HarnessOptions>
}

export async function scene(size: Size, { profile = {}, exchanges = [["How should I run the migration?", ANSWER]], mode = "full", dataDir = tempDir(), directory = tempDir(), sessionId, reply, replay, harness: extra = {} }: SceneOptions = {}): Promise<Scene> {
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, sidebar: "hidden", copyOnSelect: true, ...(size.sidebar ? { rightSidebar: true, sidebarWidgets: structuredClone(SIDEBAR_PRESETS.pulse) } : {}), ...profile } as TuiProfile)
  const h = appHarness({ dataDir, directory, width: size.width, height: size.height, mode, ...(sessionId ? { sessionId } : {}), ...(reply ? { reply } : {}), ...extra })
  h.app.applySettings({ onboarded: true })
  await h.app.extensionsReady
  await Bun.sleep(10)
  const log: SessionEvent[] = []
  const talk = conversation(h.sessionId, (event) => (log.push(event), h.app.onEvent(event)))
  if (replay) for (const event of replay) h.app.onEvent(event)
  else for (const [user, answer] of exchanges) talk.exchange(user, answer)
  h.app.render()
  const chatW = size.width - (size.sidebar ? rightBarCells({ columns: size.width, setting: DEFAULT_TUI_PROFILE.sidebarWidth, collapsed: false }).cells : 0)
  return { h, size, chatW, talk, dataDir, directory, log }
}

/** A daemon that outlives the terminals: the drafts are kept here while harnesses come and go. */
export function daemon() {
  const drafts = new Map<string, string>()
  const reply = (command: CommandInput): CommandReply | undefined => {
    if (command.type === "draft.set") {
      if (command.text) drafts.set(command.sessionId, command.text)
      else drafts.delete(command.sessionId)
      return { ok: true }
    }
    if (command.type === "draft.get") {
      const text = drafts.get(command.sessionId)
      return { ok: true, result: text ? { draft: { text, attachments: [], updatedAt: 1 } } : {} }
    }
    if (command.type === "draft.list") return { ok: true, result: { drafts: [] } }
    return undefined
  }
  return { drafts, reply }
}

export const mouse = (code: number, col: number, row: number, up = false) => `\x1b[<${code};${col + 1};${row + 1}${up ? "m" : "M"}`
export const screen = (h: Harness) => (h.app.render(), h.frames.at(-1)!.map(plain))
export const chat = (s: Scene) => screen(s.h).map((row) => row.slice(0, s.chatW))
export const has = (rows: readonly string[], text: string) => rows.some((row) => row.includes(text))

/** A real mouse drag over `quote` in the drawn rows. */
export async function dragOver(s: Scene, quote: string) {
  const rows = chat(s)
  const at = locateQuote({ rows, quote })
  if (!at) throw new Error(`passage not on screen at ${tag(s.size)}:\n${rows.join("\n")}`)
  const first = quote.replace(/\s+/g, " ").split(" ")[0]!
  const from = rows[at.from]!.indexOf(first)
  const to = rows[at.to]!.trimEnd().length - 1
  await s.h.app.onKey(mouse(0, from, at.from))
  await s.h.app.onKey(mouse(32, Math.min(from + 1, to), at.from))
  await s.h.app.onKey(mouse(32, to, at.to))
  await s.h.app.onKey(mouse(0, to, at.to, true))
}

export const key = async (s: Scene, input: string) => {
  await s.h.app.onKey(input)
  s.h.app.render()
}
export const typeText = async (s: Scene, text: string) => {
  await s.h.app.onInput(text)
  await Bun.sleep(2)
  s.h.app.render()
}

/** A comment on a passage: drag over it, the comment key, the words, Enter. */
export async function comment(s: Scene, quote: string, text: string) {
  await dragOver(s, quote)
  await key(s, ALT_Q)
  await typeText(s, text)
  await key(s, ENTER)
}

export const prompt = (s: Scene) => s.h.app.editor.text
export const submitted = (s: Scene) => s.h.sentOf("user.submit").map((command) => (command as { text: string }).text)
export const sentComments = (s: Scene, at = 0) => parseCommentMessage(submitted(s)[at]!)
/** The chip row, however it is drawn at this width: a chip, the count, or the numbers. */
export const chipsShown = (rows: readonly string[]) => rows.some((row) => /\[1[ ↑\]]/.test(row) || /\b1 comment\b/.test(row) || /alt\+l list/.test(row))
