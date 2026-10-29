import type { ThemesReport } from "@mendcode/protocol"
import { createThemePickerState, themeEntries, themeIndex, type preload } from "../lazy-pages"
import { activeTheme, effectiveThemeMode, registerThemes, setTerminalMode, setTheme, setThemeLock, SYSTEM_THEME, themeList, themeModeState, themeNames, themeSelection } from "../theme"
import { themesFromFiles } from "../theme-files"
import type { TerminalMode } from "../terminal-mode"
import type { TuiProfile } from "../../view/tui-profile"
import type { AppContext } from "./context"

const MOVE_UP = ["\x1b[A", "\x1bOA", "\x10"]
const MOVE_DOWN = ["\x1b[B", "\x1bOB", "\x0e"]
const LOCK_KEY = "\x0c"
const QUERY_MAX = 100

/**
 * The theme picker (`/theme`, `/themes`, leader-t): every theme plus `system`, filtered as you type; the whole UI
 * repaints in the highlighted theme, Enter keeps it and Esc puts the previous one back. `system` follows the
 * terminal's light/dark mode, and the lock pins that mode so terminal changes stop moving it.
 */
export function createThemePicker(ctx: AppContext, actions: {
  changeProfile: (patch: Partial<TuiProfile>) => void
  loadPage: (name: Parameters<typeof preload>[0] | undefined) => Promise<void>
}) {
  const { input, state, requestFrame } = ctx

  setThemeLock(state.tuiProfile.themeLock || undefined)
  setTerminalMode(input.screen.terminalMode?.mode)
  input.screen.terminalMode?.subscribe((mode) => {
    setTerminalMode(mode)
    requestFrame()
  })

  const label = () => (themeSelection() === SYSTEM_THEME ? `system (${activeTheme().name})` : activeTheme().label)
  const entries = () => themeEntries({ themes: themeList(), query: state.themePicker.query, mode: themeModeState() })

  /** Re-reads theme files so one just written (by hand or by the agent) can be picked without a restart. */
  async function refreshThemeFiles() {
    const files = await input.send({ type: "themes.list", directory: input.directory ?? "" })
    if (files.ok) registerThemes(themesFromFiles((files.result as ThemesReport | undefined)?.themes ?? []).themes)
  }

  /** Keeps what is on screen: the terminal profile (when it holds a theme) and the daemon setting for the project or user. */
  async function persist() {
    const selection = themeSelection()
    const projectTheme = input.directory && state.settingsNow.projectThemes?.[input.directory]
    if (state.tuiProfile.theme && !projectTheme) actions.changeProfile({ theme: selection })
    await input.send({ type: "settings.set", patch: projectTheme ? { projectThemes: { ...state.settingsNow.projectThemes, [input.directory!]: selection } } : { theme: selection } })
  }

  async function applyTheme(requested: string) {
    if (!setTheme(requested)) {
      state.notice = `unknown theme: ${requested} (${[SYSTEM_THEME, ...themeNames()].join(", ")})`
      return
    }
    if (themeSelection() === SYSTEM_THEME) input.screen.requestTerminalMode?.()
    state.notice = `theme: ${label()}`
    await persist()
  }

  function lockMode(mode: TerminalMode | undefined) {
    setThemeLock(mode)
    actions.changeProfile({ themeLock: mode ?? "" })
    state.notice = mode ? `theme mode locked: ${mode}` : "theme mode follows the terminal"
  }

  async function openThemes() {
    await actions.loadPage("theme")
    await refreshThemeFiles()
    input.screen.requestTerminalMode?.()
    state.palette = undefined
    state.themeRestore = themeSelection()
    state.themePicker = createThemePickerState(themeIndex(themeList(), themeSelection()))
    state.page = "theme"
    requestFrame()
  }

  /** Puts back the theme the picker opened on, however it was left. */
  function restoreTheme() {
    if (state.themeRestore !== undefined) setTheme(state.themeRestore)
    state.themeRestore = undefined
  }

  function preview() {
    const entry = entries()[state.themePicker.selected]
    if (entry) setTheme(entry.name)
  }

  /** `/theme` opens the picker; `/theme <name|system>` applies one; `/theme lock [dark|light]` and `/theme unlock` pin or free the system mode. */
  async function themeCommand(args: string) {
    const requested = args.trim()
    const [word, mode] = requested.toLowerCase().split(/\s+/)
    if (!requested) return openThemes()
    if (word === "lock" && (mode === undefined || mode === "dark" || mode === "light")) return lockMode(mode ?? effectiveThemeMode())
    if (word === "unlock" && mode === undefined) return lockMode(undefined)
    await refreshThemeFiles()
    await applyTheme(requested)
  }

  async function themePickerKey(key: string) {
    const picker = state.themePicker
    const found = entries()
    if (key === "\x1b") {
      restoreTheme()
      state.page = "chat"
    } else if (key === "\r") {
      const entry = found[picker.selected]
      if (!entry) return
      state.themeRestore = undefined
      state.page = "chat"
      await applyTheme(entry.name)
    } else if (key === LOCK_KEY) lockMode(themeModeState().locked ? undefined : effectiveThemeMode())
    else if (MOVE_UP.includes(key)) {
      picker.selected = Math.max(0, picker.selected - 1)
      preview()
    } else if (MOVE_DOWN.includes(key)) {
      picker.selected = Math.min(Math.max(0, found.length - 1), picker.selected + 1)
      preview()
    } else if (key === "\x7f" || key === "\b" || (!/[\x00-\x1f\x7f]/.test(key) && key.length > 0)) {
      picker.query = key === "\x7f" || key === "\b" ? Array.from(picker.query).slice(0, -1).join("") : (picker.query + key).slice(0, QUERY_MAX)
      if (picker.query) {
        picker.selected = 0
        preview()
      } else {
        const initial = state.themeRestore ?? themeSelection()
        setTheme(initial)
        picker.selected = themeIndex(themeList(), initial)
      }
    }
    requestFrame()
  }

  return { openThemes, themeCommand, themePickerKey, restoreTheme, applyTheme }
}
