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
  function model(width = input.screen.size.width, height = Math.max(3, input.screen.size.height - 9)) {
    // A recalled line is walked past with ↑/↓ and sent with Enter as it was entered; the menu comes back with the first edit.
    if (state.recall.index >= 0) return undefined
    if (editor.text !== previous) {
      if (!previous.startsWith("/") || editor.text === "/" || previous.includes(" ") && !editor.text.includes(" ")) navigation = createSlashMenuState()
      state.suggestion = 0
      previous = editor.text
    }
    return slashMenuModel({ text: editor.text, custom: actions.suggestionPool(), profile: state.tuiProfile, settings: state.settingsNow, recents, state: navigation, selected: state.suggestion, width, height, bindings: state.bindings, ascii: state.tuiProfile.accessible || asciiChrome(state) })
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
