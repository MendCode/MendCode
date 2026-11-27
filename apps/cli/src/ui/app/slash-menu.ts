import type { AppContext } from "./context"
import { asciiChrome } from "./glyph-mode"
import type { SlashCommand } from "../../view/commands"
import type { ViewHit } from "../../view/views"
import { createSlashMenuState, slashMenuModel, slashMenuWindow, type MenuModel } from "../../view/slash-menu"
import { hasSlashLayout, noteSlashRecent, readSlashRecents, saveSlashRecent } from "../../view/slash-recents"

/** Owns menu navigation only. Selecting a command goes through the existing slash/submit paths. */
export function createSlashMenu(ctx: AppContext, actions: { suggestionPool(): SlashCommand[]; extOn(): boolean }) {
  const { input, state, editor } = ctx
  let navigation = createSlashMenuState()
  let previous = ""
  let recents = input.dataDir && !input.remote ? readSlashRecents(input.dataDir) : []
  let customDrawing = false
  /** Hit regions of the custom view last drawn (action `select`, `arg` the index in `items`). */
  let hits: ViewHit[] = []
  let inheritMinimal = !input.profile && !(input.dataDir && !input.remote && hasSlashLayout(input.dataDir))
  let lastLayout = state.tuiProfile.slashMenu
  function syncDefault() {
    if (state.tuiProfile.slashMenu !== lastLayout) { inheritMinimal = false; lastLayout = state.tuiProfile.slashMenu }
    if (inheritMinimal) {
      state.tuiProfile = { ...state.tuiProfile, slashMenu: state.settingsNow.tier === "minimalist" ? "flat" : "tabs" }
      lastLayout = state.tuiProfile.slashMenu
    }
  }
  /**
   * `/cd` completion for a chat that runs on the sync hub: its folder is not on this machine (the mirror keeps the hub's path), so the hub lists
   * the subfolders (`session.dirs`, docs/sync.md). One question per typed directory, asked on first need and kept while the chat is open; the
   * menu draws what is known and comes back when the answer arrives.
   */
  const hubListings = new Map<string, readonly string[] | "pending" | { failedAt: number }>()
  const MAX_HUB_LISTINGS = 40
  /** A listing that failed is asked again after this long, not on every frame and not never. */
  const HUB_RETRY_MS = 3_000
  const hubFolders = (head: string) => {
    // A listing belongs to the chat and the folder it was asked for: after /cd or a switch to another chat the same typed text asks again.
    const sessionId = state.sessionId
    const key = `${sessionId}\0${input.directory ?? ""}\0${head}`
    const known = hubListings.get(key)
    if (known === "pending") return undefined
    if (Array.isArray(known)) return known as readonly string[]
    if (known && Date.now() - (known as { failedAt: number }).failedAt < HUB_RETRY_MS) return []
    if (hubListings.size >= MAX_HUB_LISTINGS) hubListings.clear()
    hubListings.set(key, "pending")
    const failed = () => { hubListings.set(key, { failedAt: Date.now() }) }
    void input.send({ type: "session.dirs", sessionId, path: head || "." }).then((reply) => {
      if (reply.ok) hubListings.set(key, Array.isArray(reply.result?.names) ? reply.result.names as string[] : [])
      else { failed(); state.notice = reply.error.message.replace(/^\[(SYNC|DAEMON)\]:\s*/, "") }
    }, () => { failed(); state.notice = "The hub could not be reached to list its folders" }).then(() => {
      // A failure is shown once the retry time has passed, not forever: the frame that finds it due asks again.
      if (hubListings.get(key) !== undefined && !Array.isArray(hubListings.get(key))) setTimeout(() => ctx.requestFrame(), HUB_RETRY_MS + 50).unref?.()
      ctx.requestFrame()
    })
    return undefined
  }
  /** Whether the open chat is a copy of one the sync hub runs: the daemon's own ownership (the list's `hub`), not whether its folder exists here. */
  const runsOnHub = () => {
    if (input.remote || !editor.text.startsWith("/cd")) return false
    const summary = state.sessions.find((listed) => listed.sessionId === state.sessionId) ?? state.paletteSessions.find((listed) => listed.sessionId === state.sessionId)
    return summary?.hub !== undefined
  }
  function model(width = input.screen.size.width, height = Math.max(3, input.screen.size.height - 9)) {
    // A recalled line is walked past with ↑/↓ and sent with Enter as it was entered; the menu comes back with the first edit.
    if (state.recall.index >= 0) return undefined
    if (editor.text !== previous) {
      if (!previous.startsWith("/") || editor.text === "/" || previous.includes(" ") && !editor.text.includes(" ")) navigation = createSlashMenuState()
      state.suggestion = 0
      previous = editor.text
    }
    return slashMenuModel({ text: editor.text, ...(input.directory && !input.remote ? { directory: input.directory } : {}), ...(runsOnHub() ? { hubFolders } : {}), custom: actions.suggestionPool(), profile: state.tuiProfile, settings: state.settingsNow, recents, state: navigation, selected: state.suggestion, width, height, bindings: state.bindings, ascii: state.tuiProfile.accessible || asciiChrome(state) })
  }
  /** The public data of a command: what a custom view sees. */
  const publicCommand = ({ name, aliases, summary, group, shortcut, setting, custom, ext, mcp }: { name: string; aliases: readonly string[]; summary: string; group: string; shortcut?: string | undefined; setting?: string | undefined; custom?: true | undefined; ext?: true | undefined; mcp?: true | undefined }) => ({ name, aliases, summary, group, ...(shortcut ? { shortcut } : {}), ...(setting ? { setting } : {}), ...(custom ? { custom } : {}), ...(ext ? { ext } : {}), ...(mcp ? { mcp } : {}) })
  const publicModel = (view: MenuModel) => ({ catalog: view.catalog.map(publicCommand), query: view.query, selection: view.selection, group: view.group, groups: view.groups, ...(view.suggested !== undefined ? { suggested: view.suggested } : {}), layout: view.layout, items: view.items.map((item) => ({ ...item, ...(item.command ? { command: publicCommand(item.command) } : {}) })) })
  function draw(width: number, height: number) {
    const view = model(width, height)
    if (!view) return []
    const drawn = ctx.views.draw("slash.menu", view, { width, height, prepare: publicModel as never })
    customDrawing = drawn.custom
    hits = drawn.hits
    return drawn.lines
  }
  function key(key: string): boolean {
    const view = model()
    if (!view) return false
    const down = ["\x1b[B", "\x1bOB"].includes(key)
    const up = ["\x1b[A", "\x1bOA"].includes(key)
    const right = ["\x1b[C", "\x1bOC"].includes(key)
    const left = ["\x1b[D", "\x1bOD"].includes(key)
    if (up || down) {
      state.suggestion = (view.selection + (down ? 1 : view.items.length - 1)) % Math.max(1, view.items.length)
      return true
    }
    if (view.query || view.layout === "flat") return false
    const selected = view.items[view.selection]
    if (view.layout === "groups") {
      if (selected?.kind === "group" && (right || left || key === "\r" || key === "\t")) {
        navigation.expanded = right ? [...new Set([...navigation.expanded, selected.group])] : left ? navigation.expanded.filter((id) => id !== selected.group) : navigation.expanded.includes(selected.group) ? navigation.expanded.filter((id) => id !== selected.group) : [...navigation.expanded, selected.group]
        return true
      }
      if (left && selected?.command && navigation.expanded.includes(selected.group)) {
        navigation.expanded = navigation.expanded.filter((id) => id !== selected.group)
        const next = model()!
        state.suggestion = next.items.findIndex((entry) => entry.kind === "group" && entry.group === selected.group)
        return true
      }
    } else if (right || left || key === "\x1b[Z") { // tab completes the highlighted command, like every other list
      navigation.group = (navigation.group + (left || key === "\x1b[Z" ? view.groups.length - 1 : 1)) % view.groups.length
      state.suggestion = 0
      return true
    }
    return false
  }
  function record(name: string) {
    if (input.remote) return
    try { recents = input.dataDir ? saveSlashRecent(input.dataDir, name, ctx.now()) : noteSlashRecent(recents, name, ctx.now()) }
    catch { state.notice = "Could not save command recents" }
  }
  function hit(row: number, width: number, height: number) {
    // A custom view names its own clickable rows (`select` on an item index); without any, only the keyboard acts.
    if (customDrawing) return hits.find((entry) => entry.action === "select" && entry.row === row)?.arg as number | undefined
    const view = model(width, height)
    if (!view) return undefined
    const window = slashMenuWindow(view)
    const index = row - window.header + window.first
    return row >= window.header && row < window.header + window.rows && index < view.items.length ? index : undefined
  }
  return { model, draw, key, record, hit, syncDefault }
}
