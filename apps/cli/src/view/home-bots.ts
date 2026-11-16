import type { BotListReport, BotState } from "@mendcode/protocol"
import type { ColorName, Line, Span } from "../ui/theme"
import { botIcon } from "./bot-icon"
import { HOME_BOT_PREFIX, type HomeBotHit, type HomeBotsBlock } from "./home"
import { lineWidth, textWidth, truncateEnd } from "./wrap"

/**
 * The Bots block of the home's Agent View (experimental bots, docs/agents.md): one row per state a bot is in (working, waiting for
 * you, problem; idle bots are not listed), each row the bots' icons and short names that fit the width, then `+ N more`. Never one
 * row per bot. Loaded by the first home frame with the flag on (ui/app/home-bots.ts), never at start.
 */
export type HomeBotState = Exclude<BotState, "idle">
export type HomeBotEntry = {
  /** `HOME_BOT_PREFIX` plus what opens it: `mendcode:<name>` or `external:<origin>:<id>`. */
  id: string
  name: string
  state: HomeBotState
  /** The icon as the sidebar draws it (the glyph of its shape in its theme color role; ASCII when the terminal draws no unicode). */
  glyph: Span
  /** The bot's most recent chat, the active one first; absent when it has none (Enter then opens its page). */
  chat?: string
  /** A bot of another app: what its page is found by. */
  external?: { origin: string; id: string }
}

export const HOME_BOT_STATES: readonly HomeBotState[] = ["working", "waiting", "problem"]
const MARK: Record<HomeBotState, readonly [string, string]> = { working: ["●", "*"], waiting: ["?", "?"], problem: ["✗", "x"] }
const FG: Record<HomeBotState, ColorName> = { working: "primary", waiting: "warning", problem: "error" }
const WORD: Record<HomeBotState, string> = { working: "working", waiting: "waiting", problem: "problem" }
const ROWS_MAX = 3
const NAME_MAX = 14
const GAP = 2
const LABEL = "Bots"
/** Under this width the state word goes: the mark alone says it. */
const COMPACT_BELOW = 34

export const homeBotId = (kind: "mendcode" | "external", ref: string) => `${HOME_BOT_PREFIX}${kind}:${ref}`

/** The session a chat with the bot means: one at work or waiting first, else the newest. */
function activeChat(sessions: ReadonlyArray<{ sessionId: string; status: string; updatedAt: number }>): string | undefined {
  const live = sessions.filter((session) => session.status === "running" || session.status.startsWith("waiting_"))
  const pool = live.length ? live : sessions
  return pool.reduce<{ sessionId: string; updatedAt: number } | undefined>((best, session) => (!best || session.updatedAt > best.updatedAt ? session : best), undefined)?.sessionId
}

/** Every bot of the report that is not idle, MendCode's own and those of other apps alike, in the report's order. */
export function homeBotEntries(report: BotListReport | undefined, ascii: boolean): HomeBotEntry[] {
  const glyph = (name: string, identity: { shape?: never; color?: never } | NonNullable<BotListReport["external"][number]["identity"]> | undefined, state: BotState): Span => {
    const icon = botIcon({ name, shape: identity?.shape, color: identity?.color, ascii, state })
    return { text: ascii ? `${icon.text} ` : icon.text, fg: icon.fg }
  }
  const out: HomeBotEntry[] = []
  for (const bot of report?.bots ?? []) {
    if (bot.state === "idle") continue
    const chat = activeChat(bot.projects.flatMap((project) => project.sessions))
    out.push({ id: homeBotId("mendcode", bot.name), name: bot.name, state: bot.state, glyph: glyph(bot.name, bot.identity, bot.state), ...(chat ? { chat } : {}) })
  }
  for (const bot of report?.external ?? []) {
    if (bot.state === "idle") continue
    const chat = activeChat((bot.projects ?? []).flatMap((project) => project.sessions))
    out.push({ id: homeBotId("external", `${bot.origin}:${bot.id}`), name: bot.name, state: bot.state, glyph: glyph(bot.name, bot.identity, bot.state), external: { origin: bot.origin, id: bot.id }, ...(chat ? { chat } : {}) })
  }
  return out
}

/** How many of `widths` fit in `room` with `gap` between them and, when some are left out, the `more` text right after a gap. */
function fitCount(widths: readonly number[], room: number, gap: number, more: (left: number) => string): number {
  let best = -1
  let used = 0
  for (let count = 0; count <= widths.length; count++) {
    if (count > 0) used += widths[count - 1]! + (count > 1 ? gap : 0)
    const rest = widths.length - count
    const total = used + (rest > 0 ? (count > 0 ? gap : 0) + textWidth(more(rest)) : 0)
    if (total <= room) best = count
    else break
  }
  return best
}

/**
 * The block for `width`: at most `maxRows` rows, in the order working, waiting, problem. A row lists the bots whose icon and name fit, then
 * `+ N more`; where not even one name fits it lists icons alone and folds the rest into `+N`. Hits are relative to the block.
 */
export function renderHomeBots(input: { entries: readonly HomeBotEntry[]; width: number; maxRows?: number; ascii?: boolean; selectedId?: string }): HomeBotsBlock {
  const { entries, width, selectedId } = input
  const groups = HOME_BOT_STATES.map((state) => ({ state, bots: entries.filter((entry) => entry.state === state) })).filter((group) => group.bots.length > 0).slice(0, Math.min(ROWS_MAX, input.maxRows ?? ROWS_MAX))
  const compact = width < COMPACT_BELOW
  const lines: Line[] = []
  const hits: HomeBotHit[] = []
  for (const [index, { state, bots }] of groups.entries()) {
    const mark = MARK[state][input.ascii ? 1 : 0]
    const label = (index === 0 ? LABEL : "").padEnd(LABEL.length)
    const head: Span[] = compact
      ? [{ text: `${label} ` }, { text: `${mark} `, fg: FG[state] }]
      : [{ text: `${label}   ` }, { text: `${mark} `, fg: FG[state] }, { text: WORD[state].padEnd(WORD.working.length), fg: FG[state] }, { text: " ".repeat(GAP) }]
    const room = Math.max(0, width - lineWidth(head))
    const named = bots.map((bot) => ({ bot, name: truncateEnd(bot.name, NAME_MAX) }))
    const longMore = (left: number) => `+ ${left} more`
    const shortMore = (left: number) => `+${left}`
    const namedFit = fitCount(named.map(({ bot, name }) => textWidth(bot.glyph.text) + textWidth(name)), room, GAP, longMore)
    // Names while at least two fit (or the row's only bot): one name of many hides more than it tells, so the icons alone take over.
    const withNames = namedFit >= Math.min(2, bots.length)
    const shown = withNames ? namedFit : Math.max(0, fitCount(bots.map((bot) => textWidth(bot.glyph.text)), room, 0, shortMore))
    const more = bots.length - shown
    const moreText = more > 0 ? (withNames ? longMore(more) : shortMore(more)) : ""
    const spans: Span[] = [...head]
    let col = lineWidth(head)
    for (const [at, { bot, name }] of named.slice(0, shown).entries()) {
      const bg: Partial<Span> = bot.id === selectedId ? { bg: "element" } : {}
      if (withNames && at > 0) { spans.push({ text: " ".repeat(GAP) }); col += GAP }
      const from = col
      spans.push({ ...bot.glyph, ...bg })
      col += textWidth(bot.glyph.text)
      if (withNames) {
        spans.push({ text: name, fg: "text", ...bg })
        col += textWidth(name)
      }
      hits.push({ row: index, from, to: col, id: bot.id })
    }
    if (moreText) {
      const pad = Math.max(1, width - col - textWidth(moreText))
      spans.push({ text: " ".repeat(pad) }, { text: moreText, fg: "muted" })
    }
    lines.push(spans)
  }
  return { lines, hits }
}
