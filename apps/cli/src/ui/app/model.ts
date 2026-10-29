import { footerShowsModel } from "../../view/tui-profile"
import { noteRecent, setModelDefault, toggleFavorite, withModelDefault, writeModelPrefs, type ModelPrefs } from "../../view/model-prefs"
import type { AgentsReport, RecipesReport } from "@mendcode/protocol"
import type { ModelChoice, ModelRoles, ModelsReport, ReasoningReport, Settings } from "@mendcode/protocol"
import { modelLabel, modelWithEffort } from "../../view/model-label"
import { createModelPageState, type ModelPageAction } from "../../view/model-page"
import { createModelPickerState, createModelQuickState, modelOptions, quickChoice, stepQuickValue, variantOptions } from "../lazy-pages"
import { groupModels, MODEL_PAGE_ROWS, type ModelPageRow } from "../../view/model-page"
import type { preload } from "../lazy-pages"
import type { AppContext } from "./context"

export function createModel(ctx: AppContext, actions: { loadPage(name: Parameters<typeof preload>[0]): Promise<void>; connectProvider(): Promise<void> }) {
  const { input, state, requestFrame, say, fail } = ctx

  /** The model and effort the next answer uses, for the row under the prompt; asked once at start and again when the session or its model changes. */
  async function loadEffectiveModel() {
    const sessionId = state.sessionId
    const reply = await input.send({ type: "models.list", ...(state.sessionId ? { sessionId: state.sessionId } : {}) })
    if (state.sessionId !== sessionId) return
    if (reply.ok && reply.result) {
      state.modelReport = reply.result as ModelsReport
      state.effectiveModel = state.modelReport.effective
    }
    const agents = await input.send({ type: "agents.list", sessionId })
    if (state.sessionId !== sessionId) return
    if (agents.ok && agents.result) state.agentReport = agents.result as AgentsReport
    requestFrame()
  }

  /** Stores the report of a models.list / session.model.set reply, or its error. */
  function takeModels(reply: Awaited<ReturnType<typeof input.send>>) {
    if (reply.ok && reply.result) {
      state.modelReport = reply.result as ModelsReport
      state.effectiveModel = state.modelReport.effective
      state.modelError = ""
      const handoff = state.modelReport.handoff
      if (handoff?.rebuilt) say(`${handoff.to} now has the conversation from ${handoff.from} · ${handoff.turns} ${handoff.turns === 1 ? "turn" : "turns"}, ~${handoff.tokens.toLocaleString("en-US")} tokens${handoff.omitted ? ` · ${handoff.omitted} older stay in this session` : ""} · /compact packs it`, "info")
      else if (handoff) say(`context goes to ${handoff.to} with your next message · ${handoff.turns} ${handoff.turns === 1 ? "turn" : "turns"}, ~${handoff.tokens.toLocaleString("en-US")} tokens${handoff.omitted ? ` · ${handoff.omitted} older stay in this session` : ""}`, "info")
    } else if (!reply.ok) state.modelError = reply.error.message.replace(/^\[DAEMON\]: /, "")
    requestFrame()
    return reply.ok
  }

  /** `/model` opens the quick switch; `/model roles` (or `all`) the page with every role; `/model <id> [effort]` sets this session's model; `/model reset` clears it. */
  async function modelCommand(args: string) {
    if (args.trim() === "reasoning") {
      await openModelPage()
      await actions.loadPage("reasoning")
      state.modelState = { ...state.modelState, reasoning: true }
      await loadReasoning()
      return
    }
    if (args.trim() === "search") return openModelPicker()
    if (args.trim() === "roles" || args.trim() === "all") return openModelPage()
    const [id, effort] = args.split(/\s+/).filter(Boolean)
    if (!id) return state.page === "chat" ? openModelQuick() : openModelPage()
    if (!state.sessionId) {
      state.notice = "model: no session yet"
      return
    }
    const choice = id === "reset" ? null : withModelDefault(state.modelPrefs, { model: id, ...(effort ? { effort } : {}) })
    const ok = takeModels(await input.send({ type: "session.model.set", sessionId: state.sessionId, choice: choice as ModelChoice | null }))
    const effective = state.modelReport?.effective
    if (ok && choice) changeModelPrefs(noteRecent(state.modelPrefs, choice.model))
    // The footer already names the model; a notice repeating it is noise.
    if (ok && footerShowsModel(state.tuiProfile)) requestFrame()
    else if (ok) say(`model: ${effective ? modelWithEffort(effective.model, effective.effort, state.modelReport) : "default"}`, "success")
    else fail(`model: ${state.modelError}`)
  }

  /** The full page: this session, every role, recipes and the catalog. */
  async function openModelPage() {
    state.modelQuick = undefined
    state.page = "model"
    state.modelState = createModelPageState()
    state.modelReport = undefined
    state.recipes = undefined
    state.modelError = ""
    requestFrame()
    void loadRecipes()
    takeModels(await input.send({ type: "models.list", ...(state.sessionId ? { sessionId: state.sessionId } : {}) }))
  }

  /** The quick switch over the chat: shown at once from the catalog the terminal already has, refreshed from the daemon. */
  async function openModelQuick() {
    await actions.loadPage("modelQuick")
    state.modelQuick = createModelQuickState()
    state.modelError = ""
    requestFrame()
    const sessionId = state.sessionId
    const reply = await input.send({ type: "models.list", ...(sessionId ? { sessionId } : {}) })
    if (!state.modelQuick || sessionId !== state.sessionId) return
    takeModels(reply)
  }

  /** Keys of the quick switch: type to filter, ↑↓ move, enter switches this session, ←→ the effort, ctrl+f a favorite, tab the full page, esc closes. */
  async function modelQuickKey(key: string) {
    const quick = state.modelQuick
    if (!quick || /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(key)) return
    const report = state.modelReport
    const selectable = report?.selectable !== false
    const entries = selectable ? modelOptions(report, state.modelPrefs, { query: quick.query }) : []
    const row = entries[Math.max(0, Math.min(quick.selected, entries.length - 1))]?.model
    state.modelError = ""
    if (key === "\x1b") state.modelQuick = undefined
    else if (key === "\t") await openModelPage()
    else if (["\x1b[A", "\x1bOA", "\x10"].includes(key)) quick.selected = Math.max(0, quick.selected - 1)
    else if (["\x1b[B", "\x1bOB", "\x0e"].includes(key)) quick.selected = Math.min(Math.max(0, entries.length - 1), quick.selected + 1)
    else if (key === "\x1b[5~") quick.selected = Math.max(0, quick.selected - 8)
    else if (key === "\x1b[6~") quick.selected = Math.min(Math.max(0, entries.length - 1), quick.selected + 8)
    else if (["\x1b[D", "\x1bOD", "\x1b[C", "\x1bOC", "\x05"].includes(key)) {
      if (row) state.modelQuick = stepQuickValue({ state: quick, model: row, report, prefs: state.modelPrefs, direction: key === "\x1b[D" || key === "\x1bOD" ? -1 : 1 })
    } else if (key === "\x06") {
      if (row) {
        changeModelPrefs(toggleFavorite(state.modelPrefs, row.id))
        // The row moves to or from the favorites at the top: the highlight stays on the same model.
        const moved = modelOptions(report, state.modelPrefs, { query: quick.query }).findIndex((entry) => entry.model.id === row.id)
        if (moved >= 0) quick.selected = moved
      }
    } else if (key === "\r") {
      if (!row || !report?.selectable) return requestFrame()
      if (!state.sessionId) {
        state.modelError = "no session yet: send a message first"
        return requestFrame()
      }
      const choice = quickChoice({ model: row, state: quick, withDefault: (picked) => withModelDefault(state.modelPrefs, picked) })
      // The model this session already uses, with no other effort picked: nothing to change.
      if (report.effective?.model === row.id && !quick.picks[row.id]) state.modelQuick = undefined
      else if (takeModels(await input.send({ type: "session.model.set", sessionId: state.sessionId, choice }))) {
        changeModelPrefs(noteRecent(state.modelPrefs, choice.model))
        state.modelQuick = undefined
        const effective = state.modelReport?.effective
        if (!footerShowsModel(state.tuiProfile)) say(`model: ${effective ? modelWithEffort(effective.model, effective.variant ?? effective.effort, state.modelReport) : modelLabel(choice.model, state.modelReport)}`, "success")
      }
    } else if (key === "\x7f" || key === "\b") {
      quick.query = Array.from(quick.query).slice(0, -1).join("")
      quick.selected = 0
    } else if (key === "\x15") {
      quick.query = ""
      quick.selected = 0
    } else if (!/[\x00-\x1f\x7f]/.test(key)) {
      quick.query = (quick.query + key).slice(0, 100)
      quick.selected = 0
    }
    requestFrame()
  }

  /** Recipes of every extension layer for this project, shown as the recipe row of /model. */
  async function loadRecipes() {
    if (!input.directory) return
    const reply = await input.send({ type: "recipes.list", directory: input.directory })
    if (reply.ok && reply.result) state.recipes = reply.result as RecipesReport
    requestFrame()
  }

  /** Sets every model role from a recipe (from /model or /setup), then refreshes what the next answer uses. */
  async function applyRecipe(name: string) {
    const reply = await input.send({ type: "recipes.apply", directory: input.directory ?? "", name })
    if (!reply.ok) return fail(reply.error.message)
    state.recipes = reply.result as RecipesReport
    say(`recipe: ${name}`, "success")
    takeModels(await input.send({ type: "models.list", ...(state.sessionId ? { sessionId: state.sessionId } : {}) }))
  }

  /** Keeps the model page's favorites and recents; written at once, a failed write is a toast. */
  function changeModelPrefs(next: ModelPrefs) {
    if (next === state.modelPrefs) return
    state.modelPrefs = next
    if (input.dataDir) {
      const saved = writeModelPrefs(input.dataDir, state.modelPrefs)
      if (!saved.ok) fail(saved.error)
    }
    requestFrame()
  }

  async function modelAction(action: ModelPageAction) {
    if (action.type === "reasoning-refresh") await loadReasoning()
    else if (action.type === "reasoning-save") {
      const report = state.modelReport?.reasoning
      if (!report || !input.directory) return
      const saved = await input.send({ type: "reasoning.configure", directory: input.directory, config: action.config, expectedRevision: report.revision, confirm: true })
      if (!saved.ok) {
        state.modelError = saved.error.message
        requestFrame()
        return
      }
      if (action.auto !== report.reasoningAuto) {
        const settings = await input.send({ type: "settings.get" })
        if (!settings.ok) {
          await loadReasoning()
          state.modelError = settings.error.message
          requestFrame()
          return
        }
        const current = (settings.result as { settings: Settings }).settings
        const auto = await input.send({ type: "settings.set", patch: { experimental: { ...current.experimental, reasoning_auto: action.auto } } })
        if (!auto.ok) {
          await loadReasoning()
          state.modelError = auto.error.message
          requestFrame()
          return
        }
      }
      state.modelState = { row: state.modelState.row, reasoning: true }
      state.modelError = ""
      await loadReasoning()
    }
    else if (action.type === "picker") await openModelPicker(MODEL_PAGE_ROWS[state.modelState.row] ?? "session")
    else if (action.type === "providers") { await openModelPicker(); state.modelPicker.providers = true }
    else if (action.type === "close") state.page = "chat"
    else if (action.type === "recipe") await applyRecipe(action.name)
    else if (action.type === "favorite") {
      const starred = !state.modelPrefs.favorites.includes(action.model)
      changeModelPrefs(toggleFavorite(state.modelPrefs, action.model))
      say(`${starred ? "favorite" : "unfavorited"}: ${modelLabel(action.model, state.modelReport)}`)
    } else if (action.type === "session") {
      if (state.sessionId) {
        const saved = takeModels(await input.send({ type: "session.model.set", sessionId: state.sessionId, choice: action.choice }))
        if (saved && action.choice) changeModelPrefs(noteRecent(state.modelPrefs, action.choice.model))
      }
      else {
        state.modelError = "no session yet: send a message first, or set main"
        requestFrame()
      }
    }
    else if (action.type === "roles") {
      for (const [role, choice] of Object.entries(action.roles)) if (choice && choice.model !== state.modelReport?.roles[role as keyof ModelRoles]?.model) changeModelPrefs(noteRecent(state.modelPrefs, choice.model))
      const saved = await input.send({ type: "settings.set", patch: { models: Object.keys(action.roles).length ? action.roles : null } })
      if (!saved.ok) state.modelError = saved.error.message
      takeModels(await input.send({ type: "models.list", ...(state.sessionId ? { sessionId: state.sessionId } : {}) }))
    }
  }

  async function loadReasoning() {
    if (!input.directory) {
      state.modelError = "Project required"
      requestFrame()
      return
    }
    const sessionId = state.sessionId
    const reply = await input.send({ type: "reasoning.status", directory: input.directory, ...(state.sessionId ? { sessionId: state.sessionId } : {}) })
    if (state.sessionId !== sessionId) return
    if (reply.ok && reply.result && state.modelReport) {
      state.modelReport = { ...state.modelReport, reasoning: reply.result as ReasoningReport }
      state.modelError = ""
    }
    else if (!reply.ok) state.modelError = reply.error.message
    requestFrame()
  }

  async function openModelPicker(row: ModelPageRow = "session", returnPage: "chat" | "model" = "model") {
    await actions.loadPage("modelPicker")
    state.modelPicker = { ...createModelPickerState(row), returnPage }
    state.page = "model-picker"
    requestFrame()
    const sessionId = state.sessionId
    const reply = await input.send({ type: "models.list", sessionId })
    if (state.page !== "model-picker" || sessionId !== state.sessionId) return
    takeModels(reply)
  }
  async function modelPickerKey(key: string) {
    const picker = state.modelPicker
    const groups = groupModels(state.modelReport?.models ?? [])
    const entries = modelOptions(state.modelReport, state.modelPrefs, picker)
    const count = picker.providers ? groups.length + 1 : entries.length
    if (key === "\x1b") {
      if (picker.providers) { picker.providers = false; picker.selected = 0 }
      else if (picker.provider) { delete picker.provider; picker.selected = 0 }
      else state.page = picker.returnPage ?? "model"
    } else if (key === "\x01") { picker.providers = !picker.providers; picker.selected = 0 }
    else if (["\x1b[A", "\x10"].includes(key)) picker.selected = Math.max(0, picker.selected - 1)
    else if (["\x1b[B", "\x0e"].includes(key)) picker.selected = Math.min(Math.max(0, count - 1), picker.selected + 1)
    else if (key === "\x06" && !picker.providers) {
      const model = entries[picker.selected]?.model
      if (model) changeModelPrefs(toggleFavorite(state.modelPrefs, model.id))
    } else if (key === "\r") {
      if (picker.providers) {
        const group = groups[picker.selected]
        if (group) { picker.provider = group.key; picker.providers = false; picker.query = ""; picker.selected = 0 }
        else await actions.connectProvider()
      } else {
        const model = entries[picker.selected]?.model
        if (!model || !state.modelReport?.selectable) return
        const choice = withModelDefault(state.modelPrefs, { model: model.id })
        const row = picker.row
        await modelAction(row === "session" ? { type: "session", choice } : { type: "roles", roles: { ...state.modelReport.roles, [row]: choice } })
        if (!state.modelError) {
          state.page = "chat"
          if (row === "session" && (model.variants && Object.keys(model.variants).length || model.efforts.length)) await openVariants()
        }
      }
    } else if (key === "\x7f" || key === "\b") { picker.query = Array.from(picker.query).slice(0, -1).join(""); picker.selected = 0 }
    else if (!picker.providers && !/[\x00-\x1f\x7f]/.test(key)) { picker.query = (picker.query + key).slice(0, 100); picker.selected = 0 }
    requestFrame()
  }
  async function openVariants() {
    await actions.loadPage("variants")
    state.page = "variants"
    state.variantState = { selected: 0 }
    requestFrame()
    const sessionId = state.sessionId
    const reply = await input.send({ type: "models.list", sessionId })
    if (state.page !== "variants" || sessionId !== state.sessionId) return
    takeModels(reply)
    const current = state.modelReport?.session ?? state.modelReport?.roles.main ?? state.modelReport?.defaults
    state.variantState.selected = Math.max(0, variantOptions(state.modelReport).findIndex((option) => option.choice.variant === current?.variant && option.choice.effort === current?.effort))
    requestFrame()
  }
  async function variantsKey(key: string) {
    const options = variantOptions(state.modelReport)
    if (key === "\x1b") state.page = "chat"
    else if (["\x1b[A", "\x10", "k"].includes(key)) state.variantState.selected = Math.max(0, state.variantState.selected - 1)
    else if (["\x1b[B", "\x0e", "j"].includes(key)) state.variantState.selected = Math.min(Math.max(0, options.length - 1), state.variantState.selected + 1)
    else if (key === "\r") {
      const choice = options[state.variantState.selected]?.choice
      if (choice && takeModels(await input.send({ type: "session.model.set", sessionId: state.sessionId, choice }))) state.page = "chat"
    } else if (key === "d") {
      // The highlighted effort becomes what this model starts with whenever it is picked without one ("Default" takes it away).
      const choice = options[state.variantState.selected]?.choice
      if (choice) {
        changeModelPrefs(setModelDefault(state.modelPrefs, choice))
        const shown = modelLabel(choice.model, state.modelReport)
        say(choice.effort || choice.variant ? `${shown}: starts with ${choice.effort ?? choice.variant}` : `${shown}: no default effort`)
      }
    } else if (key === "s") {
      // The highlighted choice becomes the main model of every new session (the settings' `models.main`), and this model's own default.
      const choice = options[state.variantState.selected]?.choice
      if (choice && state.modelReport?.selectable) {
        changeModelPrefs(setModelDefault(state.modelPrefs, choice))
        await modelAction({ type: "roles", roles: { ...state.modelReport.roles, main: choice } })
        if (!state.modelError) say(`startup default: ${modelWithEffort(choice.model, choice.effort ?? choice.variant, state.modelReport)}`, "success")
      }
    }
    requestFrame()
  }

  return { openModelPicker, modelPickerKey, openVariants, variantsKey, modelQuickKey, loadEffectiveModel, takeModels, modelCommand, loadRecipes, applyRecipe, changeModelPrefs, modelAction }
}
