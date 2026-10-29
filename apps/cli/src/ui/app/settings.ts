import type { createSession } from "./session"
import type { createPrompt } from "./prompt"
import type { createPets } from "./pets"
import type { createLoops } from "./loops"
import type { createWorkflows } from "./workflows"
import type { createModel } from "./model"
import type { createChanges } from "./changes"
import type { createAgents } from "./agents"
import { activeTheme, registerThemes, setTheme, SYSTEM_THEME, themeSelection } from "../theme"
import { configureKeyLabels } from "../key-labels"
import { keyboardWanted } from "../keyboard-protocol"
import { themesFromFiles } from "../theme-files"
import type { ThemesReport } from "@mendcode/protocol"
import type { Settings, PermissionMode } from "@mendcode/protocol"
import { featureOn } from "@mendcode/protocol/wire"
import { readTuiProfile, normalizeTuiProfile, writeTuiProfile, type TuiProfile } from "../../view/tui-profile"
import { keepSessionLook } from "./session-look"
import { ACCESSIBLE_LOOK, NORMAL_LOOK } from "../../view/accessible"
import { createProfileLayers } from "./profile-layers"
import { applyGlyphMode } from "./glyph-mode"
import { PRESENTATION_MODES, type PresentationMode } from "../../view/transcript"
import type { AppContext } from "./context"

export function createSettings(ctx: AppContext, actions: {
  syncSlashDefault?(): void
  syncAudio(): void
  ensureBranch: () => void
  choosePet: ReturnType<typeof createPets>["choosePet"]
  syncImages: () => Promise<void>
  syncExtensions: () => void
  loadEffectiveModel: ReturnType<typeof createModel>["loadEffectiveModel"]
  loadLiveLoops: ReturnType<typeof createLoops>["loadLiveLoops"]
  loadLiveWorkflows: ReturnType<typeof createWorkflows>["loadLiveWorkflows"]
  loadHomeMcp: ReturnType<typeof createAgents>["loadHomeMcp"]
  loadAgentShells: ReturnType<typeof createAgents>["loadAgentShells"]
  loadTitle: ReturnType<typeof createSession>["loadTitle"]
  loadDiffTotals: ReturnType<typeof createChanges>["loadDiffTotals"]
  restoreDraft: ReturnType<typeof createPrompt>["restoreDraft"]
}) {
  const { input, state, say, fail, report, requestFrame } = ctx
  /** The transcript's look from the profile, with the glyph set resolved first so the cache it drops is rebuilt with the right marks. */
  const syncAppearance = () => {
    applyGlyphMode({ state, glyphs: ctx.glyphs, pinned: input.glyphs, env: input.env ?? process.env })
    state.transcript.setAppearance({ ...state.tuiProfile, username: state.tuiProfile.username || (input.env ?? process.env).USER || "You" })
  }
  const { ensureBranch, choosePet, syncImages, syncExtensions, loadEffectiveModel, loadLiveLoops, loadLiveWorkflows, loadHomeMcp, loadAgentShells, loadTitle, loadDiffTotals, restoreDraft } = actions
  let settingsApplied = false

  // ─── /permissions and /diagram ──────────────────────────────────────────────────────────────────────────────────────

  /** Asks the daemon to push this project's script-backed status line (`status.line`). */
  function watchStatus() {
    if (input.directory && !input.remote?.readOnly) void input.send({ type: "status.watch", directory: input.directory, watching: true })
  }

  /** The daemon echoes `session.permission` to every client; the footer updates from that event. */
  async function setPermission(next: PermissionMode) {
    const reply = await input.send({ type: "session.permission.set", sessionId: state.sessionId, mode: next })
    report(reply)
    requestFrame()
  }

  function setMode(next: PresentationMode) {
    if (state.tuiProfile.presentation !== "auto") changeProfile({ presentation: next })
    state.mode = next
    state.transcript.setMode(next)
    ensureBranch()
    // The notice names the next view too, so a reader learns the cycle from the first press.
    state.notice = `view: ${next} · tab: ${PRESENTATION_MODES[(PRESENTATION_MODES.indexOf(next) + 1) % PRESENTATION_MODES.length]}`
    void input.send({ type: "settings.set", patch: { view: next } })
  }

  /** Applies daemon-owned settings (startup and live `settings.changed` from any terminal). */
  function applySettings(settings: Settings) {
    const previous = state.settingsNow
    if (settingsApplied && settings.theme !== previous.theme) state.tuiProfile = { ...state.tuiProfile, theme: settings.theme ?? "" }
    settingsApplied = true
    state.settingsNow = settings
    actions.syncSlashDefault?.()
    actions.syncAudio()
    void syncImages()
    state.customFooter = settings.footer
    // The pet companion belongs to the `full` tier (docs/tiers.md); `features.pets` or the tier switch it.
    void choosePet(featureOn(settings, "pets") ? state.tuiProfile.pet || settings.pet : undefined)
    const chosenTheme = themeInForce(settings)
    if (chosenTheme) {
      setTheme(chosenTheme)
      if (themeSelection() === SYSTEM_THEME) input.screen.requestTerminalMode?.()
      void input.send({ type: "themes.list", directory: input.directory ?? "" }).then((reply) => {
        if (!reply.ok || state.settingsNow !== settings) return
        registerThemes(themesFromFiles((reply.result as ThemesReport | undefined)?.themes ?? []).themes)
        setTheme(chosenTheme)
        requestFrame()
      })
    }
    const chosen = state.tuiProfile.presentation
    const presentation = chosen === "auto" ? settings.view : chosen === "raw" ? "full" : chosen === "mendcode" ? "balanced" : chosen
    syncAppearance()
    if (presentation && presentation !== state.mode) {
      state.mode = presentation
      state.transcript.setMode(presentation)
    }
    ensureBranch()
    if (settings.reducedMotion !== undefined) state.reducedMotion = settings.reducedMotion || state.accessible
    else if (state.accessible) state.reducedMotion = true
    state.pet?.syncMotion()
    syncExtensions()
    if (!state.statusLoaded) {
      state.statusLoaded = true
      void loadEffectiveModel()
      void loadLiveLoops()
      void loadLiveWorkflows()
      void loadAgentShells()
      if (state.tuiProfile.homeFooter) void loadHomeMcp()
      watchStatus()
      void loadTitle()
      void loadDiffTotals()
      void restoreDraft(state.sessionId, { announce: true })
    }
    requestFrame()
  }

  // ─── /customize, /settings, /status and /extensions ─────────────────────────────────────────────────────────────────

  const settingsValues = () => ({ settings: state.settingsNow, theme: themeSelection(), view: state.mode, reducedMotion: state.reducedMotion })

  /** Theme files come from the daemon's layers (a package's `themes/`); asks again and registers them, so a package's theme appears when it turns on and is gone when it turns off. */
  function refreshThemes() {
    void input.send({ type: "themes.list", directory: input.directory ?? "" }).then((reply) => {
      if (!reply.ok) return
      registerThemes(themesFromFiles((reply.result as ThemesReport | undefined)?.themes ?? []).themes)
      setTheme(themeInForce(state.settingsNow) || "mend")
      requestFrame()
    })
  }

  /** The theme this terminal shows: the project's own (`projectThemes`), else the profile's, else the global setting. */
  function themeInForce(settings: typeof state.settingsNow) {
    const projectTheme = input.directory ? settings.projectThemes?.[input.directory] : undefined
    return projectTheme || state.tuiProfile.theme || settings.theme
  }

  /**
   * One change to the terminal's own look: applied at once (the home and prompt redraw), then saved next to the other terminal files.
   * A `layer` change (a package's activation or an extension's `settings.set`) is applied but never saved and never touches the
   * user's settings: the stored profile stays the user's own (profile-layers.ts).
   */
  function changeProfile(requested: Partial<TuiProfile>, options: { layer?: boolean; session?: boolean } = {}) {
    // Screen-reader mode brings the plain look with it (like /raw); turning it off puts the normal look back.
    const patch: Partial<TuiProfile> = requested.accessible === undefined ? requested : { ...(requested.accessible ? ACCESSIBLE_LOOK : NORMAL_LOOK), ...requested }
    const layered = Object.keys(state.profileApplied).length > 0
    // A `session` change (a slash command's show/hide) is this session's in this terminal: applied, kept in memory, never saved.
    const stored = !options.layer && !options.session
    const coupling = patch.showContext !== undefined && patch.contextBar === undefined ? { contextBar: patch.showContext ? "top" as const : "off" as const } : {}
    // Keys a package holds keep the user's value with the look's owners (activation.json), so the stored profile gets only the rest.
    const held = new Set(stored ? profileLayers.userChanged({ ...patch, ...coupling }) : [])
    const own = Object.fromEntries(Object.entries({ ...patch, ...coupling }).filter(([key]) => !held.has(key))) as Partial<TuiProfile>
    state.tuiProfile = normalizeTuiProfile({ ...state.tuiProfile, ...patch, ...coupling })
    if (stored) state.profileBase = normalizeTuiProfile({ ...state.profileBase, ...own })
    if (options.session) keepSessionLook(ctx, { ...patch, ...coupling })
    configureKeyLabels({ setting: state.tuiProfile.altLabel })
    input.screen.setKeyboard?.(keyboardWanted(state.tuiProfile.keyProtocol, input.platform))
    actions.syncAudio()
    if (state.customFooter && (patch.footerQuota !== undefined || patch.footerToday !== undefined)) {
      for (const [field, segment] of [["footerQuota", "quota"], ["footerToday", "today"]] as const) {
        if (patch[field] === undefined) continue
        state.customFooter = state.customFooter.filter((item) => item !== segment)
        if (patch[field]) state.customFooter = [...state.customFooter, segment]
      }
      void input.send({ type: "settings.set", patch: { footer: [...state.customFooter] } })
    }
    if (patch.theme !== undefined) {
      const theme = patch.theme || state.settingsNow.theme || "mend"
      setTheme(theme)
      if (options.layer) refreshThemes()
      if (!options.layer && input.directory && state.settingsNow.projectThemes?.[input.directory]) void input.send({ type: "settings.set", patch: { projectThemes: { ...state.settingsNow.projectThemes, [input.directory]: theme } } })
    }
    if (patch.pet !== undefined) void choosePet(patch.pet || state.settingsNow.pet)
    syncAppearance()
    if (patch.presentation !== undefined) {
      state.mode = patch.presentation === "auto" ? state.settingsNow.view ?? "balanced" : patch.presentation === "raw" ? "full" : patch.presentation === "mendcode" ? "balanced" : patch.presentation
      state.transcript.setMode(state.mode)
    }
    if (patch.accessible !== undefined) {
      state.accessible = input.accessible === true || patch.accessible
      state.reducedMotion = state.accessible || state.settingsNow.reducedMotion === true || input.reducedMotion === true
      state.pet?.syncMotion()
      void choosePet(state.tuiProfile.pet || state.settingsNow.pet)
    }
    if (patch.images !== undefined) void syncImages()
    if (patch.homeFooter) void loadHomeMcp()
    if (patch.disabledUiExtensions !== undefined) syncExtensions()
    if (!stored) return
    if (!input.dataDir) {
      say(input.unsavedNote ?? "look applied for this session only: no data dir to save it in", input.unsavedNote ? "info" : "warning")
      return
    }
    const userProfile = readTuiProfile(input.dataDir)
    // A run that asked for screen-reader mode by flag or environment keeps its plain look out of the saved file.
    const keptLook = input.accessible === true && !userProfile.accessible && patch.accessible === undefined ? Object.fromEntries((Object.keys(ACCESSIBLE_LOOK) as Array<keyof typeof ACCESSIBLE_LOOK>).filter((key) => patch[key] === undefined).map((key) => [key, userProfile[key]])) : {}
    // With a layer over the profile, what is on screen is not what is stored: the stored profile plus this change is what gets saved.
    if (layered && Object.keys(own).length === 0) return
    const toSave = layered ? normalizeTuiProfile({ ...userProfile, ...own }) : state.tuiProfile
    const saved = writeTuiProfile(input.dataDir, { ...toSave, ...keptLook, ...(input.directory && state.settingsNow.projectThemes?.[input.directory] ? { theme: userProfile.theme } : {}), sidebarWidgets: own.sidebarWidgets ?? userProfile.sidebarWidgets, rightSidebar: own.rightSidebar ?? userProfile.rightSidebar })
    if (!saved.ok) fail(saved.error)
  }

  /** The stored profile with a package's activation and running extensions' requests over it; see profile-layers.ts. */
  const profileLayers = createProfileLayers(ctx, { changeProfile })

  // ─── Prompt editor: undo/redo, stash, external editor, copy ─────────────────────────────────────────────────────────

  /** Whether the bell and the desktop notice are wanted now: always with `notifyWhen: always`, otherwise unless the terminal said its window has the focus (a terminal that never reports focus counts as unfocused). */
  function noticeWanted() {
    return state.tuiProfile.notifyWhen === "always" || input.screen.focus?.state !== "focused"
  }

  /** The terminal bell when a turn of this session ends while you are here; events replayed from before this terminal opened stay silent. */
  function ringTurnBell(event: { type: string; at: number; kind?: string; title?: string }) {
    if (event.at < state.openedAt || !noticeWanted()) return
    if (state.tuiProfile.turnBell && (event.type === "turn.completed" || event.type === "turn.failed")) input.screen.write?.("\x07")
    notifyDesktop(event)
  }

  /** A desktop notification through the terminal (OSC 9, or OSC 777 for terminals that read that one) when a turn ends or asks something; the text is stripped of control characters. */
  function notifyDesktop(event: { type: string; kind?: string; title?: string }) {
    const mode = state.tuiProfile.turnNotify
    if (mode === "off") return
    const text = event.type === "turn.completed" ? "turn finished" : event.type === "turn.failed" ? "turn failed" : event.type === "server.request" ? `${event.kind === "question" ? "question" : "needs approval"}: ${event.title ?? ""}` : undefined
    if (!text) return
    const clean = text.replace(/[\x00-\x1f\x7f;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120)
    const product = (state.tuiProfile.productName || "MendCode").replace(/[\x00-\x1f\x7f;]/g, " ")
    input.screen.write?.(mode === "osc9" ? `\x1b]9;${product}: ${clean}\x07` : `\x1b]777;notify;${product};${clean}\x07`)
  }

  return { watchStatus, setPermission, setMode, applySettings, settingsValues, changeProfile, ringTurnBell, profileLayers, refreshThemes }
}
