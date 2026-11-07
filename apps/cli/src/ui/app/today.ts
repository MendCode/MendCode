import type { SessionId, TodayTriageGroup } from "@mendcode/protocol"
import { featureOn } from "@mendcode/protocol/wire"
import { pickerFrame } from "../../view/picker-frame"
import type { TodayData, TodayLink, TodayState } from "../../view/today-page"
import type { Line } from "../theme"
import { createTodayState, loadTodayData, preload, renderTodayPage, todayPageKey, triageItems, withDismissed } from "../lazy-pages"
import type { AppContext } from "./context"

/**
 * `/today` (docs/today.md): where to get back in control. Reads what the daemon already answers when the page opens (and on `r`),
 * runs nothing and keeps nothing of its own except the time of the last visit, today's pins and the dismissed rows, which the TUI
 * profile holds (written by MendCode, never by hand).
 * Enter jumps to the row's session, or opens the page that manages it (/reviews, /workflows, /memory). `t` sends the rows to
 * `today.triage` once; nothing else calls a model. Loaded by its first command, not at start-up.
 */

/** The local day pins belong to; another day's pins read as none. */
export const localDay = (at: number) => {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

export function createToday(ctx: AppContext, deps: { switchSession(sessionId: SessionId): Promise<void>; runSlash(text: string): Promise<void> }) {
  const { input, state, requestFrame, say, fail, now } = ctx
  let view: TodayState | undefined
  let data: TodayData | undefined
  /** The visit the data in flight was asked for: a close or a new open makes an older answer be dropped. */
  let visit = 0
  /** The triage call in flight: a newer `t`, a close or a reopen drops an older answer. */
  let asking = 0
  /** The last visit before this one; kept for the whole open page so `r` does not move "since". */
  let since = 0

  async function save(patch: Partial<typeof state.tuiProfile>, keys: Array<keyof typeof state.tuiProfile>) {
    state.tuiProfile = { ...state.tuiProfile, ...patch }
    if (!input.dataDir) return
    const { readTuiProfile, writeTuiProfile } = await import("../../view/tui-profile")
    const saved = writeTuiProfile(input.dataDir, { ...readTuiProfile(input.dataDir), ...patch }, keys)
    if (!saved.ok) fail(saved.error)
  }

  const todaysMarks = () => (state.tuiProfile.todayMarks?.day === localDay(now()) ? state.tuiProfile.todayMarks.ids : [])

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
    if (first) await save({ todayLastVisit: now() }, ["todayLastVisit"])
    if (ticket === visit && state.page === "today") requestFrame()
  }

  async function command(args: string) {
    if (args.trim()) return say("usage: /today", "warning")
    await preload("today")
    visit++
    asking++
    view = createTodayState(todaysMarks(), { ...state.tuiProfile.todayDismissed })
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
    asking++
    state.page = "chat"
  }

  async function open(link: TodayLink) {
    close()
    if (link.sessionId) return deps.switchSession(link.sessionId as SessionId)
    await deps.runSlash(link.command)
  }

  /** Stores the pins for today; the page already shows them. Ids of another day are dropped. */
  async function mark(keys: string[], on: boolean) {
    const current = todaysMarks()
    const ids = on ? [...current.filter((key) => !keys.includes(key)), ...keys].slice(-50) : current.filter((key) => !keys.includes(key))
    await save({ todayMarks: { day: localDay(now()), ids } }, ["todayMarks"])
  }

  /** Stores the dismissals with the row's time (the newest `MAX_DISMISSED`); the page already hides or shows them. */
  async function dismiss(rows: Array<{ key: string; at: number }>, on: boolean) {
    const next = withDismissed({ ...createTodayState(), dismissed: { ...state.tuiProfile.todayDismissed } }, rows, on).dismissed ?? {}
    await save({ todayDismissed: next }, ["todayDismissed"])
  }

  /** One `today.triage` call with the rows on the page; its answer only fills the triage view. */
  async function triage() {
    if (!view || !data) return
    const items = triageItems(data, view)
    if (!items.length) {
      view = { ...view, triage: { open: true, status: "error", message: "there are no rows to group", sent: 0, groups: [], selected: 0, accepted: [] } }
      return requestFrame()
    }
    const ticket = ++asking
    view = { ...view, scroll: 0, triage: { open: true, status: "running", sent: items.length, groups: [], selected: 0, accepted: [] } }
    requestFrame()
    let next: NonNullable<TodayState["triage"]>
    try {
      const reply = await input.send({ type: "today.triage", items, ...(input.directory ? { directory: input.directory } : {}) })
      next = reply.ok
        ? { open: true, status: "ready", model: String(reply.result?.model ?? ""), sent: items.length, groups: (reply.result?.groups as TodayTriageGroup[] | undefined) ?? [], selected: 0, accepted: [] }
        : { open: true, status: "error", message: reply.error.message.replace(/^\[[A-Z_-]+\]:\s*/, ""), sent: items.length, groups: [], selected: 0, accepted: [] }
    } catch (error) {
      next = { open: true, status: "error", message: `the daemon did not answer: ${error instanceof Error ? error.message : String(error)}`, sent: items.length, groups: [], selected: 0, accepted: [] }
    }
    if (ticket !== asking || !view) return
    view = { ...view, triage: { ...next, open: view.triage?.open ?? true } }
    if (state.page === "today") requestFrame()
  }

  async function key(raw: string) {
    if (!view) { state.page = "chat"; return }
    if (!data) {
      if (raw === "\x1b" || raw === "q") close()
      return requestFrame()
    }
    const result = todayPageKey(view, raw, data, now())
    view = result.state
    const action = result.action
    if (action.type === "close") close()
    else if (action.type === "reload") { visit++; void load(false) }
    else if (action.type === "open") return open(action.link)
    else if (action.type === "mark") await mark(action.keys, action.on)
    else if (action.type === "dismiss") await dismiss(action.rows, action.on)
    else if (action.type === "triage") return triage()
    requestFrame()
  }

  return { command, key, render }
}
