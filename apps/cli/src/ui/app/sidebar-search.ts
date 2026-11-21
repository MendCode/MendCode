import type { SessionId, SessionSummary } from "@mendcode/protocol"
import { homedir, tmpdir } from "node:os"
import { buildSearchIndex, KIND_BOT, KIND_PROJECT, renderSidebarSearch, resultIds, runSearch, type SearchIndex } from "../../view/sidebar-search"
import type { Glyphs, Line } from "../theme"
import type { AppContext } from "./context"
import { startNewChatPanel } from "./session-look"

/**
 * The left list's search (docs/sidebar.md): `/` in the focused list, or `ctrl+x <` from the chat. Typing filters what the terminal
 * already holds; one `session.list` with `find` after `FIND_IDLE_MS` of no typing adds sessions it does not hold. Loaded with the
 * first `/`; closed, it holds no timer and does no work.
 */
export type SidebarSearch = ReturnType<typeof createSidebarSearch>
export type SearchDeps = { switchSession(sessionId: SessionId): Promise<void> }

const FIND_IDLE_MS = 150
const FIND_LIMIT = 50
/** Sessions the daemon found during one search, kept until it closes. */
const FOUND_MAX = 200
const QUERY_MAX = 100
/** The arrows of a terminal in application-cursor mode. */
const APPLICATION_ARROWS: Record<string, string> = { "\x1bOA": "\x1b[A", "\x1bOB": "\x1b[B" }
const PRINTABLE = /^[^\x00-\x1f\x7f]+$/

export function createSidebarSearch(ctx: AppContext) {
  const { state, input, env, requestFrame, fail } = ctx
  let open = false
  let query = ""
  let selected = 0
  /** The list's focus and selection before the search opened, given back by Esc. */
  let before: { focus: boolean; selected: string | undefined } = { focus: false, selected: undefined }
  let index: SearchIndex | undefined
  /** The lists the index was built from; a different one (a push, a refresh, a find answer) rebuilds it at the next key. */
  let builtFrom: readonly unknown[] = []
  let found: SessionSummary[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let asked = 0
  const home = env.HOME ?? homedir()
  const tmpRoots = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]

  function parts(): readonly unknown[] {
    const multi = state.sidebarBots?.live() ? state.sidebarBots.searchSources() : undefined
    return [state.sessions, multi?.others, multi?.bots, found, state.tuiProfile.sidebarHiddenProjects]
  }
  function ensureIndex(): SearchIndex {
    const now = parts()
    if (index && now.length === builtFrom.length && now.every((part, at) => part === builtFrom[at])) return index
    builtFrom = now
    const [own, others, bots, extra, hidden] = now as [SessionSummary[], SessionSummary[] | undefined, import("@mendcode/protocol").BotListReport | undefined, SessionSummary[], readonly string[]]
    index = buildSearchIndex({ sessions: [own, ...(others ? [others] : []), extra], bots, home, tmpRoots, hidden: new Set(hidden) })
    return index
  }

  /** The selected result's id becomes the list's selection, so the cursor sits on it as it does in the list. */
  function syncSelection() {
    const ids = index ? resultIds(index) : []
    selected = Math.max(0, Math.min(selected, ids.length - 1))
    state.sidebarSelected = ids[selected]
  }

  function setQuery(next: string) {
    query = next
    selected = 0
    runSearch(ensureIndex(), query)
    syncSelection()
    scheduleFind()
    requestFrame()
  }

  function stopTimer() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  /** One question after the typing stops, for the sessions past the lists held here; the latest question wins. */
  function scheduleFind() {
    stopTimer()
    const term = query.trim()
    if (term.length < 2) return
    timer = setTimeout(() => { timer = undefined; void find(term) }, FIND_IDLE_MS)
    timer.unref?.()
  }
  async function find(term: string) {
    const serial = ++asked
    const reply = await input.send({ type: "session.list", find: term, limit: FIND_LIMIT, hideEmpty: true }).catch(() => undefined)
    if (!open || serial !== asked || !reply?.ok) return
    const sessions = (reply.result?.sessions as SessionSummary[] | undefined) ?? []
    const known = new Set(found.map((session) => session.sessionId))
    const added = sessions.filter((session) => !known.has(session.sessionId))
    if (!added.length) return
    found = [...found, ...added].slice(-FOUND_MAX)
    const picked = state.sidebarSelected
    runSearch(ensureIndex(), query)
    // A result that arrives late does not move the selection off the row the user is on.
    const ids = resultIds(index!)
    selected = Math.max(0, picked ? ids.indexOf(picked) : 0)
    syncSelection()
    requestFrame()
  }

  function show() {
    if (open) return
    before = { focus: state.sidebarFocus === true, selected: state.sidebarSelected }
    open = true
    state.sidebarFocus = true
    setQuery("")
  }

  /** Closes the search; `restore` gives the list its focus and selection back (Esc), otherwise the prompt keeps the keyboard. */
  function close(restore: boolean) {
    if (!open) return
    open = false
    stopTimer()
    asked++
    found = []
    index = undefined
    builtFrom = []
    query = ""
    if (restore) {
      state.sidebarFocus = before.focus
      state.sidebarSelected = before.selected
    } else {
      state.sidebarFocus = false
      state.sidebarSelected = state.sessionId
    }
    requestFrame()
  }

  async function newChatIn(directory: string, deps: SearchDeps) {
    const created = await input.send({ type: "session.create", directory, title: "", reuseEmpty: true })
    const sessionId = created.ok ? created.result?.sessionId : undefined
    if (typeof sessionId !== "string") return void fail(created.ok ? "the session was not created" : created.error.message)
    await state.sidebarBots?.releaseChat(sessionId as SessionId)
    await deps.switchSession(sessionId as SessionId)
    startNewChatPanel(ctx)
  }

  /** Enter or a click on a result: a session opens, a project starts a new chat in its folder, a bot starts a chat with it. */
  async function activate(id: string, deps: SearchDeps) {
    const at = index ? index.id.indexOf(id) : -1
    if (at < 0 || !index) return
    const kind = index.kind[at]
    close(false)
    // A project or a bot does what `n` on its row in the list does (a new chat in the folder; for a bot, after its folder is picked).
    const multi = state.sidebarBots?.live() ? state.sidebarBots : undefined
    if ((kind === KIND_PROJECT || kind === KIND_BOT) && multi) return multi.newChat(id, deps)
    // The classic one-folder list has no project rows of its own to delegate to.
    if (kind === KIND_PROJECT) return newChatIn(id.slice("group:".length), deps)
    if (kind === KIND_BOT) return
    await deps.switchSession(id as SessionId)
  }

  function move(step: number) {
    const count = index?.topCount ?? 0
    if (!count) return
    selected = (selected + step + count) % count
    syncSelection()
  }

  /** The search's keys; false for a key it leaves to the screen (the mouse). */
  async function key(key: string, deps: SearchDeps): Promise<boolean> {
    if (!open) return false
    if (key.startsWith("\x1b[<")) return false
    const arrow = APPLICATION_ARROWS[key] ?? key
    if (key === "\x1b" || key === "\x03") close(true)
    else if (arrow === "\x1b[A" || key === "\x10") move(-1)
    else if (arrow === "\x1b[B" || key === "\x0e") move(1)
    else if (key === "\r") {
      const id = state.sidebarSelected
      if (id && index?.topCount) await activate(id, deps)
    } else if (key === "\x7f" || key === "\b") {
      if (!query) close(true)
      else setQuery(Array.from(query).slice(0, -1).join(""))
    } else if (key === "\x15") setQuery("")
    else if (key === "\x17") setQuery(query.replace(/\S*\s*$/, ""))
    else if (PRINTABLE.test(key)) setQuery(Array.from(query + key).slice(0, QUERY_MAX).join(""))
    requestFrame()
    return true
  }

  /** A bracketed paste while the search is open: one line of text added to the query. False when the search is not open. */
  function paste(text: string): boolean {
    if (!open) return false
    const line = text.replace(/\s+/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    if (line) setQuery(Array.from(query + line).slice(0, QUERY_MAX).join(""))
    requestFrame()
    return true
  }

  /**
   * The sidebar's rows while the search is open; undefined once it is not (another page, or a click that gave the prompt the
   * keyboard, ends it). A frame draws the results of the last key and never rebuilds the index, so a push during a turn costs nothing.
   */
  function draw(options: { height: number; width: number; now: number; ascii: boolean; spinner?: string | undefined; glyphs?: Glyphs | undefined }): { lines: Line[]; hits: Array<{ row: number; id: string }> } | undefined {
    if (!open) return undefined
    if (!state.sidebarFocus || state.page !== "chat") return void close(false)
    const drawn = renderSidebarSearch({ index: index ?? ensureIndex(), query, selected, width: options.width, height: options.height, now: options.now, current: state.sessionId, ascii: options.ascii, spinner: options.spinner, glyphs: options.glyphs })
    return { lines: drawn.rows, hits: drawn.hits }
  }

  return { isOpen: () => open, show, close, key, paste, activate, draw, query: () => query }
}
