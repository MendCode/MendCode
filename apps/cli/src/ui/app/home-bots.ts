import type { BotListReport, SessionId } from "@mendcode/protocol"
import { botIndex, patchBotReport } from "../../view/bot-live"
import type { HomeBotHit, HomeBots } from "../../view/home"
import { homeBotEntries, renderHomeBots, type HomeBotEntry } from "../../view/home-bots"
import type { ActivityEvent } from "../../view/session-activity"
import type { AppContext } from "./context"

/**
 * The bots the home's Agent View lists while they work, wait for the user or are in trouble (experimental bots, docs/agents.md). The
 * bot list is asked once when the home first draws with the flag on and again only after a push named a session no list held or the
 * connection came back (at most once a second, from a frame; no timer). `session.activity` pushes move the held report in place.
 * Loaded by the first home frame with the flag on (chat-rows.ts), never at start.
 */
export type HomeBotsLive = ReturnType<typeof createHomeBots>

/** The least time between two bot lists asked for because of pushes. */
const WINDOW_MS = 1000
const CLASSIFIED_MAX = 500

export function createHomeBots(ctx: AppContext) {
  const { input, state, now, requestFrame } = ctx
  let report: BotListReport | undefined
  let loading = false
  let askedAt = Number.NEGATIVE_INFINITY
  /** A push named a session no list held, or the connection came back: the next frame asks again. */
  let stale = false
  let botOfSession = new Map<string, string>()
  /** Sessions known not to belong to a bot, so a busy old session does not ask for the list at every push. */
  const classified = new Set<string>()
  const unknown = new Set<string>()
  /** Pushes that came while the list was on its way; the answer may predate them. */
  const during: ActivityEvent[] = []
  let shown: HomeBotEntry[] = []
  let entriesFor: { report: BotListReport | undefined; ascii: boolean; entries: HomeBotEntry[] } | undefined

  /** The report the left list already holds (it asks for and patches its own), so no second `bot.list` goes out. */
  const shared = () => (state.sidebarBots?.live() ? state.sidebarBots.report() : undefined)
  const on = () => state.settingsNow.experimental?.bots === true && !input.remote

  async function load() {
    loading = true
    askedAt = now()
    stale = false
    during.length = 0
    try {
      const reply = await input.send({ type: "bot.list" })
      if (reply.ok) {
        report = reply.result as BotListReport
        for (const event of during) report = patchBotReport(report, event, now()) ?? report
        botOfSession = botIndex(report)
        for (const id of unknown) if (!botOfSession.has(id)) classified.add(id)
        unknown.clear()
        while (classified.size > CLASSIFIED_MAX) classified.delete(classified.values().next().value!)
      }
    } finally { loading = false; during.length = 0 }
    requestFrame()
  }

  /** Asks for the list when none was asked for yet, or when something made it stale and a second has passed. */
  function ensure() {
    if (!on() || loading || shared()) return
    if (askedAt === Number.NEGATIVE_INFINITY || (stale && now() - askedAt >= WINDOW_MS)) void load().catch(() => undefined)
  }

  /** A `session.activity` push: a session of a listed bot moves its state in place; one no list held may be a bot's new chat. */
  function onActivity(event: ActivityEvent) {
    if (!on()) return
    if (loading && during.length < 200) during.push(event)
    if (!report) return
    if (botOfSession.has(event.sessionId)) {
      const next = patchBotReport(report, event, now())
      if (next) { report = next; requestFrame() }
    } else if (!classified.has(event.sessionId) && !state.sessions.some((session) => session.sessionId === event.sessionId)) {
      unknown.add(event.sessionId)
      stale = true
      requestFrame()
    }
  }

  /** The connection came back: pushes may have been missed. */
  function resync() {
    stale = true
  }

  function entries(ascii: boolean): HomeBotEntry[] {
    // The left list's report, when it holds one, is the one kept current; this module's own is for terminals where that list never draws.
    const used = shared() ?? report
    if (entriesFor && entriesFor.report === used && entriesFor.ascii === ascii) return entriesFor.entries
    entriesFor = { report: used, ascii, entries: homeBotEntries(used, ascii) }
    return entriesFor.entries
  }

  /** What the home draws: the block for a width, and where it landed (the bots a click or Enter can reach). */
  function view(options: { ascii: boolean; placed(hits: HomeBotHit[]): void }): HomeBots {
    ensure()
    return {
      render: ({ width, maxRows, selectedId }) => renderHomeBots({ entries: entries(options.ascii), width, maxRows, ascii: options.ascii, ...(selectedId !== undefined ? { selectedId } : {}) }),
      placed: (hits) => { shown = entries(options.ascii).filter((entry) => hits.some((hit) => hit.id === entry.id)); options.placed(hits) },
    }
  }

  /** Enter or a click on a bot: its active (most recent) chat, else its page. */
  async function open(id: string, deps: { switchSession(sessionId: SessionId): Promise<void> }) {
    const entry = shown.find((candidate) => candidate.id === id)
    if (!entry) return
    if (entry.chat) return deps.switchSession(entry.chat as SessionId)
    state.sidebarBots ??= (await import("./sidebar-bots")).createSidebarBots(ctx)
    if (entry.external) return state.sidebarBots.openPage((await import("../../view/sidebar-multi")).externalBotId(entry.external), deps)
    return state.sidebarBots.openNamed(entry.name, deps)
  }

  return { view, onActivity, resync, open }
}
