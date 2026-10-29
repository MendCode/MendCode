import type { createSession } from "./session"
import type { createPrompt } from "./prompt"
import { createPaletteState, paletteKey, preload } from "../lazy-pages"
import { SYSTEM_THEME, themeNames, themeSelection } from "../theme"
import type { SessionId, SessionSummary } from "@mendcode/protocol"
import type { PaletteItem } from "../../view/palette"
import { SLASH_COMMANDS, listedBuiltins } from "../../view/commands"
import { PRESENTATION_MODES } from "../../view/transcript"
import { OPEN_FILE_TITLE, rangeLabel, type FileRef } from "../../view/file-ref"
import type { AppContext } from "./context"
import { SELECTABLE_PERMISSION_MODES } from "./constants"
import { labelString, sessionLabel } from "../../view/session-label"

export function createPalette(ctx: AppContext, actions: {
  suggestionPool: ReturnType<typeof createPrompt>["suggestionPool"]
  loadPage: (name: Parameters<typeof preload>[0] | undefined) => Promise<void>
  forkSession: ReturnType<typeof createSession>["forkSession"]
  switchSession: ReturnType<typeof createSession>["switchSession"]
  runSlash: (text: string) => Promise<boolean>
  changeProfile: (patch: Partial<import("../../view/tui-profile").TuiProfile>) => void
  /** Opens a path the user picked from the "Open file" list. */
  openRef: (ref: FileRef) => void
  /** Runs a terminal extension's named action (`api.action`). */
  runExtensionAction: (id: string) => boolean
  /** Parks what is typed in the stash (`/stash pop` brings it back). */
  stashPrompt: () => void
}) {
  const { input, state, editor, permissionLabels: PERMISSION_LABEL, requestFrame } = ctx
  const { suggestionPool, loadPage, forkSession, switchSession, runSlash } = actions

  function paletteItems(): PaletteItem[] {
    if (state.palette?.title === OPEN_FILE_TITLE) return state.pathPicks.map((ref, index): PaletteItem => ({ id: `file:${index}`, kind: "file", title: ref.line ? `${ref.raw}:${rangeLabel(ref.line, ref.endLine)}` : ref.raw }))
    if (state.palette?.title === "Home welcome mode") return [
      { id: "home:centered", kind: "setting", title: "Centered", hint: "identity and launcher centered", current: state.tuiProfile.homeLayout === "centered" },
      { id: "home:split", kind: "setting", title: "Split", hint: "bordered hero with a right panel", current: state.tuiProfile.homeLayout === "split" },
    ]
    const builtin = new Set(SLASH_COMMANDS.map((c) => c.name))
    const items: PaletteItem[] = [
      { id: "home:picker", kind: "setting", title: "Home welcome mode", keywords: "layout centered split" },
      ...[["logoKind", "Home identity"], ["logoText", "Home title text"], ["logoFont", "Home title font"], ["customAscii", "Home mascot ASCII"], ["homeRightPanel", "Home split panel"]].map(([row, title]): PaletteItem => ({ id: `customize:${row}`, kind: "setting", title: title! })),
      ...listedBuiltins(state.settingsNow, state.tuiProfile.slashCommands).map((c): PaletteItem => ({ id: `command:${c.name}`, kind: "command", title: c.name, hint: c.summary, keywords: c.aliases.join(" ") })),
      ...suggestionPool().filter((c) => !builtin.has(c.name)).map((c): PaletteItem => ({ id: `command:${c.name}`, kind: "command", title: c.name, hint: c.summary })),
      // Named actions of terminal extensions (`api.action`): every tier lists them, they are the user's own.
      ...(state.ext?.active ? state.ext.actions() : []).map((a): PaletteItem => ({ id: `action:${a.id}`, kind: "action", title: a.title, ...(a.description ? { hint: a.description } : {}), keywords: a.id })),
      ...state.paletteSessions.filter((s) => s.sessionId !== state.sessionId).map((s): PaletteItem => ({ id: `session:${s.sessionId}`, kind: "session", title: labelString(sessionLabel(s, { untitled: "untitled", marker: "draft" })), hint: "open", keywords: s.directory })),
      ...[SYSTEM_THEME, ...themeNames()].map((name): PaletteItem => ({ id: `theme:${name}`, kind: "theme", title: name, ...(name === themeSelection() ? { hint: "current" } : {}), keywords: "theme colors" })),
      ...PRESENTATION_MODES.map((m): PaletteItem => ({ id: `view:${m}`, kind: "view", title: m, ...(m === state.mode ? { hint: "current" } : {}), keywords: "view mode" })),
      { id: "fork:session", kind: "session", title: "Fork session", hint: "copy this conversation into a new session", keywords: "branch duplicate" },
      { id: "fork:side", kind: "session", title: "Side chat", hint: "read-only fork to ask something aside", keywords: "fork btw question" },
      ...SELECTABLE_PERMISSION_MODES.map((m): PaletteItem => ({ id: `permission:${m}`, kind: "permission", title: PERMISSION_LABEL[m], ...(m === state.transcript.permissionMode ? { hint: "current" } : {}), keywords: `permissions ${m}` })),
    ]
    return items
  }

  // ─── Session history: undo, redo, timeline, fork at a message, export (docs/sessions.md) ─────────────────────────────

  // ─── The dock's scratch note ─────────────────────────────────────────────────────────────────────────────────────────

  // ─── /goal (docs/goals.md) ──────────────────────────────────────────────────────────────────────────────────────────

  async function openPalette() {
    await loadPage("palette")
    state.palette = createPaletteState()
    requestFrame()
    const reply = await input.send({ type: "session.list", limit: 30, hideEmpty: true })
    if (reply.ok) state.paletteSessions = (reply.result?.sessions as SessionSummary[]) ?? []
    requestFrame()
  }

  /** The `file.open` key found several paths: a list of them in the palette's picker. */
  async function openPathPicker(refs: FileRef[]) {
    await loadPage("palette")
    state.pathPicks = refs
    state.palette = { query: "", selected: 0, title: OPEN_FILE_TITLE }
    requestFrame()
  }

  /** A command run from the palette: the prompt holds a draft, not the command, so the draft is kept as typed. */
  async function runKeepingDraft(command: string) {
    const draft = editor.text
    await runSlash(command)
    if (draft && !editor.text) editor.insert(draft)
  }

  async function paletteInput(key: string) {
    if (!state.palette) return
    const result = paletteKey(state.palette, key, paletteItems())
    state.palette = result.state
    if (result.action.type === "close") state.palette = undefined
    else if (result.action.type === "run") {
      const { item } = result.action
      const value = item.id.slice(item.id.indexOf(":") + 1)
      const picking = state.palette?.title === OPEN_FILE_TITLE
      state.palette = undefined
      if (picking && item.kind === "file") {
        const ref = state.pathPicks[Number(value)]
        state.pathPicks = []
        if (ref) actions.openRef(ref)
      } else if (item.id === "home:picker") state.palette = { query: "", selected: state.tuiProfile.homeLayout === "split" ? 1 : 0, title: "Home welcome mode" }
      else if (item.id.startsWith("home:")) {
        // Through the one profile path, so a layer over the profile (a package's look) is never saved as the user's own.
        actions.changeProfile({ homeLayout: value as "centered" | "split" })
      } else if (item.id.startsWith("customize:")) {
        await runKeepingDraft("/customize")
        const { CUSTOMIZE_ROWS } = await import("../../view/customize-page")
        state.customizeState = { row: Math.max(0, CUSTOMIZE_ROWS.indexOf(value as typeof CUSTOMIZE_ROWS[number])) }
      } else if (item.id.startsWith("fork:")) await forkSession(value === "side")
      else if (item.kind === "session") await switchSession(value as SessionId)
      else if (item.kind === "action") actions.runExtensionAction(value)
      else if (item.kind === "command") {
        if (SLASH_COMMANDS.some((c) => c.name === value)) await runKeepingDraft(`/${value}`)
        else {
          // The command takes the prompt's place: what was typed there goes to the stash, never away.
          if (editor.text.trim()) actions.stashPrompt()
          editor.clear()
          editor.insert(`/${value}`)
        }
      } else if (item.kind === "theme") await runKeepingDraft(`/theme ${value}`)
      else if (item.kind === "view") await runKeepingDraft(`/view ${value}`)
      else if (item.kind === "permission") await runKeepingDraft(`/permissions ${value}`)
    }
    requestFrame()
  }

  return { paletteItems, openPalette, paletteInput, openPathPicker }
}
