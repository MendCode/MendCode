import type { SessionId } from "@mendcode/protocol"
import { featureOn } from "@mendcode/protocol/wire"
import { pickerFrame } from "../../view/picker-frame"
import type { TodayData, TodayLink, TodayState } from "../../view/today-page"
import type { Line } from "../theme"
import { createTodayState, loadTodayData, preload, renderTodayPage, todayPageKey } from "../lazy-pages"
import type { AppContext } from "./context"

/**
 * `/today` (docs/today.md): where to get back in control. Reads what the daemon already answers when the page opens (and on `r`),
 * runs nothing and keeps nothing of its own except the time of the last visit, which the TUI profile holds. Enter jumps to the
 * row's session, or opens the page that manages it (/reviews, /workflows, /memory). Loaded by its first command, not at start-up.
 */
export function createToday(ctx: AppContext, deps: { switchSession(sessionId: SessionId): Promise<void>; runSlash(text: string): Promise<void> }) {
  const { input, state, requestFrame, say, fail, now } = ctx
  let view: TodayState | undefined
  let data: TodayData | undefined
  /** The visit the data in flight was asked for: a close or a new open makes an older answer be dropped. */
  let visit = 0
  /** The last visit before this one; kept for the whole open page so `r` does not move "since". */
  let since = 0

  async function remember(at: number) {
    state.tuiProfile = { ...state.tuiProfile, todayLastVisit: at }
    if (!input.dataDir) return
    const { readTuiProfile, writeTuiProfile } = await import("../../view/tui-profile")
    const saved = writeTuiProfile(input.dataDir, { ...readTuiProfile(input.dataDir), todayLastVisit: at }, ["todayLastVisit"])
    if (!saved.ok) fail(saved.error)
  }

  async function load(first: boolean) {
    const ticket = visit
    const loaded = await loadTodayData({
      send: (command) => input.send(command),
      directory: input.directory,
      sessionId: state.sessionId,
      remote: input.remote,
      reviews: featureOn(state.settingsNow, "pr_review"),
      now: now(),
      lastVisit: since,
    })
    if (ticket !== visit) return
    data = loaded
    if (first) await remember(now())
    if (ticket === visit && state.page === "today") requestFrame()
  }

  async function command(args: string) {
    if (args.trim()) return say("usage: /today", "warning")
    await preload("today")
    visit++
    view = createTodayState()
    data = undefined
    since = state.tuiProfile.todayLastVisit
    state.page = "today"
    requestFrame()
    await load(true)
  }

  function render(width: number, height: number): Line[] {
    if (!view) return []
    if (!data) return pickerFrame("Today", "esc back", width, height, [[{ text: "Reading sessions, reviews and memory...", fg: "muted" }]])
    return renderTodayPage({ data, state: view, width, height, now: now() })
  }

  function close() {
    visit++
    state.page = "chat"
  }

  async function open(link: TodayLink) {
    close()
    if (link.sessionId) return deps.switchSession(link.sessionId as SessionId)
    await deps.runSlash(link.command)
  }

  async function key(raw: string) {
    if (!view) { state.page = "chat"; return }
    if (!data) {
      if (raw === "\x1b" || raw === "q") close()
      return requestFrame()
    }
    const result = todayPageKey(view, raw, data)
    view = result.state
    if (result.action.type === "close") close()
    else if (result.action.type === "reload") { visit++; void load(false) }
    else if (result.action.type === "open") return open(result.action.link)
    requestFrame()
  }

  return { command, key, render }
}
