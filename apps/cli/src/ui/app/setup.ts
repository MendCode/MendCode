import type { SetupReport, Tier } from "@mendcode/protocol/wire"
import { createOnboardingState, createSetupPageState, detectReady, type preload } from "../lazy-pages"
import { activeTheme, setTheme, SYSTEM_THEME, themeSelection } from "../theme"
import type { DaemonInfoReport, McpStatusReport, MemoryEntry, Settings } from "@mendcode/protocol"
import type { SetupAction, SetupChecks, SetupHelper, SetupValues } from "../../view/setup-page"
import type { OnboardingAction } from "../../view/onboarding-page"
import { toolLayoutOf, type TuiProfile } from "../../view/tui-profile"

/** The profile keys the setup's Look rows (Glyphs, Tools, Diff, Prompt, Pet) move live; Theme is held apart, as a theme selection. */
/** Said when the first setup closes with no model to talk to: it is not marked done, so the next launch opens it again. */
const NOT_SET_UP = "no model is set up yet · this setup opens again next launch · /connect chatgpt signs MendCode in, /setup reopens it"
const SETUP_STYLE_KEYS =["glyphs", "toolOutput", "toolDensity", "codeMapCard", "diffView", "promptChrome", "pet"] as const satisfies readonly (keyof TuiProfile)[]
import type { AppContext } from "./context"
import { applyTierBundle } from "./tier"

export function createSetup(ctx: AppContext, actions: {
  loadRecipes(): Promise<void>
  loadPage(name: Parameters<typeof preload>[0] | undefined): Promise<void>
  applySettings(settings: Settings): void
  changeProfile(patch: Partial<TuiProfile>, options?: { layer?: boolean }): void
}) {
  const { input, state, quotas, requestFrame, report } = ctx
  const { loadRecipes, loadPage, applySettings, changeProfile } = actions

  let readiness: SetupReport | undefined
  let helper: SetupHelper | undefined
  let introTimer: ReturnType<typeof setInterval> | undefined

  function setupValues(): SetupValues {
    return {
      theme: activeTheme().name,
      ...(readiness ? { readiness } : {}),
      ...(state.settingsNow.budgets ?? readiness?.budget.policy ? { budget: state.settingsNow.budgets ?? readiness!.budget.policy } : {}),
      preset: state.settingsNow.setupPreset ?? readiness?.preset ?? "default",
      ...(state.settingsNow.tier ? { tier: state.settingsNow.tier } : {}),
      profile: state.tuiProfile,
      view: state.mode,
      defaultPermission: state.settingsNow.defaultPermission ?? "ask",
      reducedMotion: state.reducedMotion,
      ...(state.settingsNow.dreamAt ? { dreamAt: state.settingsNow.dreamAt } : {}),
      ...(state.settingsNow.retentionDays ? { retentionDays: state.settingsNow.retentionDays } : {}),
      ...(state.recipes ? { recipes: state.recipes.recipes.filter((recipe) => !recipe.problem).map((recipe) => recipe.name) } : {}),
      ...(state.recipes?.active ? { recipe: state.recipes.active } : {}),
      ...(state.promptReport ? { prompt: state.promptReport } : {}),
    }
  }

  function setupChecks(): SetupChecks {
    return {
      ...(readiness ? { readiness } : {}),
      connected: state.connection === "connected",
      ...(input.daemonBuildId ? { buildId: input.daemonBuildId } : {}),
      ...(state.setupInfo ? { info: state.setupInfo } : {}),
      ...(state.setupInfoError ? { infoError: state.setupInfoError } : {}),
      quotas: [...quotas.values()].map((q) => ({ provider: q.provider, windows: q.windows.map((w) => ({ label: w.label, usedPercent: w.usedPercent })) })),
      ...(state.setupMcp !== undefined ? { mcpServers: state.setupMcp } : {}),
      ...(state.setupMemory ? { memory: state.setupMemory } : {}),
    }
  }

  /** Read-only health checks; each answer repaints when it arrives. */
  async function loadSetup() {
    const directory = input.directory ?? ""
    await Promise.all([
      loadRecipes(),
      input.send({ type: "setup.status", directory: directory || "." }).then((reply) => {
        if (reply.ok && reply.result) readiness = reply.result as SetupReport
        requestFrame()
      }),
      input.send({ type: "prompt.status", directory: directory || ".", ...(state.effectiveModel?.model ? { modelID: state.effectiveModel.model } : {}) }).then((reply) => {
        if (reply.ok && reply.result) state.promptReport = reply.result as import("@mendcode/protocol/wire").PromptStatus
        requestFrame()
      }),
      input.send({ type: "daemon.info" }).then((reply) => {
        if (reply.ok) state.setupInfo = reply.result as DaemonInfoReport
        else state.setupInfoError = reply.error.message
        requestFrame()
      }),
      input.send({ type: "mcp.status", directory }).then((reply) => {
        if (reply.ok) state.setupMcp = ((reply.result as McpStatusReport).servers ?? []).length
        requestFrame()
      }),
      input.send({ type: "memory.list", ...(directory ? { directory } : {}) }).then((reply) => {
        const list = reply.ok ? ((reply.result?.memories as MemoryEntry[]) ?? []) : undefined
        if (list) state.setupMemory = { saved: list.filter((m) => m.status === "saved").length, pending: list.filter((m) => m.status === "pending").length }
        requestFrame()
      }),
    ])
  }

  /** What the settings already say, so a reopened page starts on it and Enter changes nothing by itself. */
  function savedChoices() {
    const profile = state.tuiProfile
    const style = { tools: toolLayoutOf(profile), diffView: profile.diffView, promptChrome: profile.promptChrome, pet: profile.pet || state.settingsNow.pet || "off" }
    return { model: state.settingsNow.models?.main?.model, tier: state.settingsNow.tier, permission: state.settingsNow.defaultPermission, theme: themeSelection(), glyphs: profile.glyphs, style }
  }

  /** The profile keys the Look rows past the theme move, as they were when the page opened. */
  const styleOf = (profile: TuiProfile): Partial<TuiProfile> => Object.fromEntries(SETUP_STYLE_KEYS.map((key) => [key, profile[key]]))

  /** Read-only answers the daemon already has: models (what each engine found), providers (which keys), login, importable setup. `answered` is false when the model list itself was not answered. */
  async function detectAnswers({ imports }: { imports: boolean }) {
    const directory = input.directory ?? "."
    const [models, providers, info, imported] = await Promise.all([
      input.send({ type: "models.list" }),
      input.send({ type: "providers.list" }),
      input.send({ type: "daemon.info" }),
      imports && !input.remote ? input.send({ type: "setup.import", directory }) : Promise.resolve(undefined),
    ])
    const report = models.ok ? (models.result as import("@mendcode/protocol").ModelsReport) : undefined
    const list = providers.ok ? ((providers.result?.providers as import("@mendcode/protocol").ProviderInfo[] | undefined) ?? []) : []
    const infoReport = info.ok ? (info.result as DaemonInfoReport) : undefined
    const loginReport = infoReport?.login
    const login = loginReport ? { ok: loginReport.ok, ...(loginReport.message ? { message: loginReport.message } : {}) } : undefined
    return {
      answered: models.ok,
      detected: detectReady({
        selectable: report?.selectable ?? true,
        models: report?.models ?? [],
        providers: list,
        login,
        ...(imported?.ok ? { imports: imported.result as import("../../view/onboarding-detect").DetectImport } : {}),
        selected: state.settingsNow.models?.main?.model,
        ...(infoReport?.harnesses ? { harnesses: infoReport.harnesses } : {}),
        ...(infoReport?.ownLogins ? { ownLogins: true } : {}),
      }),
    }
  }

  async function detect() {
    const onboarding = state.onboarding
    if (!onboarding) return
    onboarding.loading = true
    const { detected } = await detectAnswers({ imports: true })
    if (state.onboarding !== onboarding) return
    onboarding.detected = detected
    onboarding.loading = false
    requestFrame()
  }

  /**
   * The first launch of the minimalist preset (docs/setup.md): no page and no welcome. It applies the tier like `/tier minimalist`,
   * picks the model the setup page would have recommended (the one already chosen stays) and records `onboarded`. With nothing
   * usable found it opens the setup page instead and records nothing. When the daemon does not answer nothing is written, so the next launch tries again.
   */
  async function configureMinimalist() {
    await loadPage("detect")
    const { answered, detected } = await detectAnswers({ imports: false })
    if (!answered) return
    // Nothing to talk to: the page shows what was found and how to sign in, instead of a prompt no model answers.
    if (!detected.usable) { await openSetup({ firstRun: true, preset: "minimalist" }); return }
    const applied = await applyTierBundle(ctx, { tier: "minimalist", changeProfile })
    if (applied) applySettings(applied.settings)
    const patch: Record<string, unknown> = { onboarded: true }
    if (detected.recommended && detected.recommended !== state.settingsNow.models?.main?.model) patch.models = { ...(state.settingsNow.models ?? {}), main: { ...(state.settingsNow.models?.main ?? {}), model: detected.recommended } }
    await setupChoice(patch)
    requestFrame()
  }

  /**
   * What the first launch does: the minimalist preset configures itself; any other opens the setup page, with the preset as its
   * tier. A new install (no setup done, no model chosen, no session with a message) signs in for itself from now on (`ownLogins`):
   * an install that already ran keeps the logins it used, so an upgrade changes no session's model or login.
   */
  async function openSetupIfFirstRun(settings: Settings, preset?: Tier) {
    if (settings.onboarded) return
    if (settings.ownLogins === undefined && !settings.models?.main?.model && await noSessionUsed()) await setupChoice({ ownLogins: true })
    const tier = settings.tier === undefined ? preset : undefined
    if (tier === "minimalist") await configureMinimalist()
    else await openSetup({ firstRun: true, ...(tier ? { preset: tier } : {}) })
  }
  /** True only when the daemon answers and no session has a message: an unanswered list is not proof of a new install. */
  async function noSessionUsed() {
    const listed = await input.send({ type: "session.list", limit: 1, hideEmpty: true }).catch(() => undefined)
    if (!listed?.ok) return false
    const sessions = (listed.result as { sessions?: unknown[] } | undefined)?.sessions
    return Array.isArray(sessions) && sessions.length === 0
  }

  async function openSetup(options: { advanced?: boolean; firstRun?: boolean; preset?: Tier } = {}) {
    if (!options.advanced) {
      await loadPage("setup")
      const firstRun = options.firstRun ?? state.settingsNow.onboarded !== true
      state.setupAdvanced = false
      const current = savedChoices()
      state.onboarding = { state: createOnboardingState({ current: { ...current, tier: current.tier ?? options.preset }, firstRun }), detected: undefined, loading: true, firstRun, lookStart: themeSelection(), styleStart: styleOf(state.tuiProfile), ...(options.preset && !current.tier ? { preset: options.preset } : {}) }
      state.page = "setup"
      requestFrame()
      await detect()
      return
    }
    state.setupAdvanced = true
    state.onboarding = undefined
    await loadPage("setup")
    state.page = "setup"
    helper = state.setupState?.helper ?? helper
    readiness = undefined
    state.setupState = createSetupPageState()
    state.setupInfo = undefined
    state.setupInfoError = ""
    state.setupMcp = undefined
    state.setupMemory = undefined
    requestFrame()
    await loadSetup()
  }

  /** Each choice is saved at once; theme, view and motion also apply locally before the daemon echoes them. */
  async function setupChoice(patch: Record<string, unknown>) {
    if (typeof patch.theme === "string" && state.tuiProfile.theme) changeProfile({ theme: patch.theme })
    if (typeof patch.view === "string" && state.tuiProfile.presentation !== "auto") changeProfile({ presentation: patch.view as TuiProfile["presentation"] })
    const next: Record<string, unknown> = { ...state.settingsNow }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key]
      else next[key] = value
    }
    applySettings(next as Settings)
    const reply = typeof patch.budgets === "object" && patch.budgets !== null
      ? await input.send({ type: "budget.set", policy: patch.budgets as import("@mendcode/protocol/wire").BudgetPolicy })
      : await input.send({ type: "settings.set", patch })
    report(reply)
    if (reply.ok && reply.result?.settings) applySettings(reply.result.settings as Settings)
    if (reply.ok && patch.budgets) await loadSetup()
    requestFrame()
  }

  async function setupAction(action: SetupAction) {
    const directory = input.directory ?? "."
    if (action.type === "preset") {
      const reply = await input.send({ type: "setup.preset", directory, preset: action.preset })
      report(reply)
      if (reply.ok) {
        if (reply.result?.settings) applySettings(reply.result.settings as Settings)
        if (reply.result?.profile) changeProfile(reply.result.profile as Partial<TuiProfile>)
        if (reply.result?.prompt) state.promptReport = reply.result.prompt as import("@mendcode/protocol/wire").PromptStatus
        await loadSetup()
      }
    } else if (action.type === "tier") {
      if (action.tier) {
        const applied = await applyTierBundle(ctx, { tier: action.tier, changeProfile })
        if (applied) { applySettings(applied.settings); state.notice = applied.summary }
      } else {
        const reply = await input.send({ type: "settings.set", patch: { tier: null } } as never)
        report(reply)
        if (reply.ok && reply.result?.settings) applySettings(reply.result.settings as Settings)
      }
      await loadSetup()
    } else if (action.type === "helper") {
      helper = state.setupState.helper ?? helper ?? { open: true, draft: "", cursor: 0, messages: [], busy: false }
      state.setupState.helper = { ...helper, open: true }
    } else if (action.type === "ask") {
      const chat = state.setupState.helper
      if (!chat || chat.busy) return
      if (!readiness?.helper.ready) { chat.error = readiness?.helper.reason ?? "Setup helper unavailable"; requestFrame(); return }
      const history = chat.messages.slice(-12)
      chat.messages.push({ role: "user", text: action.text })
      chat.draft = ""
      chat.cursor = 0
      chat.busy = true
      delete chat.error
      requestFrame()
      const reply = await input.send({ type: "setup.ask", directory, text: action.text, history })
      chat.busy = false
      if (reply.ok) chat.messages.push({ role: "assistant", text: String(reply.result?.text ?? "") })
      else chat.error = reply.error.message
      // Keys may replace the editing state while the answer is in flight.
      if (state.setupState.helper) state.setupState.helper = { ...state.setupState.helper, messages: chat.messages, busy: false, ...(chat.error ? { error: chat.error } : {}) }
      helper = state.setupState.helper ?? chat
    }
    requestFrame()
  }

  /** What the final Enter asked for about Import: the daemon writes exactly these keys, and says how many it wrote. */
  async function applyImports(keys: readonly string[]) {
    const reply = await input.send({ type: "setup.import", directory: input.directory ?? ".", apply: true, only: [...keys] })
    if (!reply.ok) { ctx.fail(reply.error.message); return }
    const items = (reply.result as import("@mendcode/protocol").SetupImportReport).items
    const written = items.filter((item) => item.status === "imported")
    const failed = items.filter((item) => item.status === "failed").length
    const off = written.filter((item) => item.enabled === false).length
    ctx.say(`imported ${written.length} of ${keys.length}${off ? ` · ${off} disabled until you set their variables` : ""}${failed ? ` · ${failed} failed` : ""}`, failed ? "warning" : "success")
  }

  /** Themes switch live while the Look row moves; esc puts back the one the page opened on. */
  function applyLook(theme: string) {
    if (!setTheme(theme)) return
    if (theme === SYSTEM_THEME) input.screen.requestTerminalMode?.()
    requestFrame()
  }

  /**
   * Enter writes the choices shown (a value equal to what is saved is not written again, so a reopened page never
   * resets a density or home layout the user tuned) and imports exactly the selection, nothing by default; esc on the
   * first run writes only "done" and keeps defaults.
   */
  async function onboardingAction(action: OnboardingAction) {
    const onboarding = state.onboarding
    if (!onboarding || action.type === "none") return
    if (action.type === "recheck") { await detect(); return }
    if (action.type === "look") { applyLook(action.theme); return }
    // In memory only while the row moves; the final Enter saves it, esc puts the opening value back.
    if (action.type === "style") { changeProfile(action.patch, { layer: true }); requestFrame(); return }
    state.onboarding = undefined
    state.page = "chat"
    const styleMoved = (): Partial<TuiProfile> => Object.fromEntries(Object.entries(styleOf(state.tuiProfile)).filter(([key, value]) => value !== onboarding.styleStart[key as keyof TuiProfile]))
    if (action.type === "defaults") {
      if (themeSelection() !== onboarding.lookStart) applyLook(onboarding.lookStart)
      if (Object.keys(styleMoved()).length) changeProfile(onboarding.styleStart, { layer: true })
      // With no model to talk to the first run is not over: the next launch opens this page again (nothing else is written).
      if (onboarding.firstRun && onboarding.detected?.usable !== false) await setupChoice({ onboarded: true })
      else if (onboarding.firstRun) ctx.say(NOT_SET_UP, "info")
      // Leaving the page keeps the starting tier the installer was asked for.
      if (onboarding.preset && !state.settingsNow.tier) {
        const applied = await applyTierBundle(ctx, { tier: onboarding.preset, changeProfile })
        if (applied) applySettings(applied.settings)
      }
      requestFrame()
      return
    }
    const { choices } = action
    const patch: Record<string, unknown> = {}
    if (choices.theme !== undefined && choices.theme !== onboarding.lookStart) patch.theme = choices.theme
    const usable = onboarding.detected?.usable !== false
    if (state.settingsNow.onboarded !== true && usable) patch.onboarded = true
    if (choices.permission !== state.settingsNow.defaultPermission) patch.defaultPermission = choices.permission
    if (choices.model && choices.model !== state.settingsNow.models?.main?.model) patch.models = { ...(state.settingsNow.models ?? {}), main: { ...(state.settingsNow.models?.main ?? {}), model: choices.model } }
    if (Object.keys(patch).length) await setupChoice(patch)
    // The rows already show their values in memory; what moved is saved after the tier, so a tier's bundle never undoes a row.
    const moved = styleMoved()
    if (choices.tier === "none") {
      if (state.settingsNow.tier) await setupAction({ type: "tier", tier: null })
    } else if (choices.tier !== state.settingsNow.tier) {
      const applied = await applyTierBundle(ctx, { tier: choices.tier, changeProfile })
      if (applied) applySettings(applied.settings)
    }
    if (Object.keys(moved).length) changeProfile(moved)
    if (onboarding.firstRun && usable) ctx.say("ready · new here? /tutorial · 4 min", "info")
    if (choices.imports.length) await applyImports(choices.imports)
    // Last, so the tier's own notice does not cover it.
    if (onboarding.firstRun && !usable) ctx.say(NOT_SET_UP, "info")
    requestFrame()
  }

  function finishIntro() {
    if (introTimer) clearInterval(introTimer)
    introTimer = undefined
    if (!state.intro) return
    if (state.page === "intro") state.page = state.intro.returnPage
    state.intro = undefined
    requestFrame()
  }
  async function openIntro() {
    const previous = state.page === "intro" ? state.intro?.returnPage ?? "chat" : state.page
    finishIntro()
    await loadPage("intro")
    state.intro = { returnPage: previous, elapsedMs: state.reducedMotion || input.env?.TERM === "dumb" || input.env?.NO_COLOR !== undefined ? 1460 : 0 }
    state.page = "intro"
    const started = performance.now()
    const reduced = state.intro.elapsedMs > 0
    introTimer = setInterval(() => {
      if (!state.intro || state.page !== "intro") { finishIntro(); return }
      const elapsed = performance.now() - started
      if (elapsed >= (reduced ? 80 : 2140)) { finishIntro(); return }
      if (!reduced) state.intro.elapsedMs = elapsed
      requestFrame()
    }, 40)
    introTimer.unref?.()
    requestFrame()
  }

  return { setupValues, setupChecks, openSetup, openSetupIfFirstRun, setupChoice, setupAction, onboardingAction, openIntro, finishIntro }

}
