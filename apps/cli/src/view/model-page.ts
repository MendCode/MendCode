import type { ModelChoice, ModelInfo, ModelRole, ModelRoles, ModelsReport, ReasoningEffort, ReasoningPolicy, RecipesReport } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type Glyphs, type Line, type Span } from "../ui/theme"
import { panelGrid, clip, fit, columns, lineWidth } from "./deck"
import { EMPTY_MODEL_PREFS, MAX_RECENTS, type ModelPrefs } from "./model-prefs"
import { pickerFrame } from "./picker-frame"
import { modelLabel, modelParts } from "./model-label"
import { providerName } from "./provider-presets"
import { truncateEnd } from "./session-list"
import { textWidth } from "./wrap"

/** `session` is this session's own choice; the rest are the settings' roles (MODEL_ROLES, in order). */
export const MODEL_PAGE_ROWS = ["session", "main", "plan", "subagent", "compaction", "dream", "aside", "small", "permissionReviewer", "memoryExtractor", "memoryAssistant", "memoryConsolidator", "title", "summary", "workflow"] as const satisfies ReadonlyArray<"session" | ModelRole>
export type ModelPageRow = (typeof MODEL_PAGE_ROWS)[number]

/** `recipe` is the recipe the recipe row points at; unset until it is cycled (then the active one, else the first). */
export type ModelPageState = { row: number; recipe?: number; reasoning?: boolean; reasoningTab?: number; reasoningScroll?: number; pendingReasoning?: ReasoningPolicy; pendingAuto?: boolean }

export type ModelPageAction =
  | { type: "none" }
  | { type: "session"; choice: ModelChoice | null }
  | { type: "roles"; roles: ModelRoles }
  | { type: "recipe"; name: string }
  /** `f`: star or unstar the model of the focused row (kept by the terminal, not the daemon). */
  | { type: "favorite"; model: string }
  | { type: "picker" }
  | { type: "providers" }
  | { type: "close" }
  | { type: "reasoning-refresh" }
  | { type: "reasoning-save"; config: ReasoningPolicy; auto: boolean }

const NONE: ModelPageAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const LEFT = new Set(["\x1b[D", "\x1bOD", "h"])
const RIGHT = new Set(["\x1b[C", "\x1bOC", "l", " "])
const FAVORITE_MARK = "*"
/** Rows of a panel (border and blank rows included) when the roles and the models share the page. */
const ROLES_MIN = 8
const CATALOG_MIN = 9
/** A page shorter than this (24 rows less the frame) shows the roles alone. */
const STACKED_MIN_ROOM = 22
const SUBSCRIPTION_TITLE = "ChatGPT subscription"
const CLAUDE_CODE_TITLE = "Claude Code"
const PI_TITLE = "pi"

export type ModelGroup = { key: string; title: string; models: ModelInfo[] }

/**
 * The catalog by who serves it: the ChatGPT subscription, then Claude Code, then each API-key provider in the order its
 * models first appear. Models keep their catalog order inside a group; a group with no models is not listed.
 */
export function groupModels(models: readonly ModelInfo[]): ModelGroup[] {
  const subscription: ModelGroup = { key: "subscription", title: SUBSCRIPTION_TITLE, models: [] }
  const claude: ModelGroup = { key: "claude", title: CLAUDE_CODE_TITLE, models: [] }
  const pi: ModelGroup = { key: "pi", title: PI_TITLE, models: [] }
  const providers = new Map<string, ModelGroup>()
  for (const model of models) {
    if (model.provider) {
      const group = providers.get(model.provider) ?? { key: `provider:${model.provider}`, title: providerName(model.provider), models: [] }
      group.models.push(model)
      providers.set(model.provider, group)
    } else if (model.engine === "claude") claude.models.push(model)
    else if (model.engine === "pi") pi.models.push(model)
    else subscription.models.push(model)
  }
  return [subscription, claude, pi, ...providers.values()].filter((group) => group.models.length > 0)
}

/** Who serves a model, in words (the group title it is listed under). */
export const servedBy = (model: ModelInfo) => (model.provider ? providerName(model.provider) : model.engine === "claude" ? CLAUDE_CODE_TITLE : model.engine === "pi" ? PI_TITLE : SUBSCRIPTION_TITLE)

/** The models the catalog lists that `ids` name, in `ids` order. */
const listed = (ids: readonly string[], models: readonly ModelInfo[]) => ids.flatMap((id) => models.find((model) => model.id === id) ?? [])

/** The recipe row comes after the role rows, and only when the recipes were loaded. */
const rowCount = (recipes: RecipesReport | undefined) => MODEL_PAGE_ROWS.length + (recipes ? 1 : 0)

/** Index of the recipe the row points at: the cycled one, else the active recipe, else the first. */
export function recipeIndex(state: ModelPageState, recipes: RecipesReport): number {
  if (state.recipe !== undefined) return Math.max(0, Math.min(state.recipe, recipes.recipes.length - 1))
  const active = recipes.recipes.findIndex((recipe) => recipe.name === recipes.active)
  return Math.max(0, active)
}

export function createModelPageState(): ModelPageState {
  return { row: 0 }
}

const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))

function chosen(row: ModelPageRow, report: ModelsReport): ModelChoice | undefined {
  return row === "session" ? report.session : report.roles[row]
}

function withChoice(row: ModelPageRow, report: ModelsReport, choice: ModelChoice | undefined): ModelPageAction {
  if (row === "session") return { type: "session", choice: choice ?? null }
  const roles: ModelRoles = { ...report.roles }
  if (choice) roles[row] = choice
  else delete roles[row]
  return { type: "roles", roles }
}

/** Fast mode is OpenAI's priority processing: only Responses hosts (the ChatGPT subscription and the `openai` provider) honor it. */
export const fastCapable = (model: ModelInfo | undefined) => Boolean(model && !model.engine && (!model.provider || model.provider === "openai"))
export const isFast = (choice: ModelChoice | undefined) => choice?.parameters?.service_tier === "priority"

/** The choice's parameters with fast set or cleared; other parameters stay. */
function fastParameters(choice: ModelChoice | undefined, fast: boolean): Pick<ModelChoice, "parameters"> {
  const { service_tier: _tier, ...rest } = choice?.parameters ?? {}
  const parameters = fast ? { ...rest, service_tier: "priority" } : rest
  return Object.keys(parameters).length ? { parameters } : {}
}

/** Next model for a row: unset (inherit) first, then every catalog model in the order the page lists them; a kept effort must be one the new model supports, and fast stays only on a model that offers it. */
function cycleModel(row: ModelPageRow, report: ModelsReport, direction: 1 | -1): ModelPageAction {
  const current = chosen(row, report)
  const options: Array<ModelInfo | undefined> = [undefined, ...groupModels(report.models).flatMap((group) => group.models)]
  const at = options.findIndex((model) => model?.id === current?.model)
  const next = options[(Math.max(0, at) + direction + options.length) % options.length]
  if (!next) return withChoice(row, report, undefined)
  const effort = current?.effort && next.efforts.includes(current.effort) ? current.effort : undefined
  return withChoice(row, report, { model: next.id, ...(effort ? { effort } : {}), ...(isFast(current) && fastCapable(next) ? fastParameters(undefined, true) : {}) })
}

/** Next effort for a row with a model: the model's default first, then each supported effort. Fast is kept. */
function cycleEffort(row: ModelPageRow, report: ModelsReport): ModelPageAction {
  const current = chosen(row, report)
  const info = current && report.models.find((model) => model.id === current.model)
  if (!current || !info || info.efforts.length === 0) return NONE
  const options: Array<ReasoningEffort | undefined> = [undefined, ...info.efforts]
  const at = options.indexOf(current.effort)
  const effort = options[(Math.max(0, at) + 1) % options.length]
  return withChoice(row, report, { model: current.model, ...(effort ? { effort } : {}), ...fastParameters(current, isFast(current)) })
}

/** `s`: fast on or off for a row whose model offers it; the effort and variant stay. */
function toggleFast(row: ModelPageRow, report: ModelsReport): ModelPageAction {
  const current = chosen(row, report)
  if (!current || !fastCapable(report.models.find((model) => model.id === current.model))) return NONE
  const { parameters: _parameters, ...rest } = current
  return withChoice(row, report, { ...rest, ...fastParameters(current, !isFast(current)) })
}

/** Handles one raw key. Returns the same state object when nothing changed. Without a report only moving and closing work. */
export function modelPageKey(state: ModelPageState, key: string, report: ModelsReport | undefined, recipes?: RecipesReport): { state: ModelPageState; action: ModelPageAction } {
  if (state.reasoning) {
    if (key === "\x1b" || key === "q") return { state: { row: state.row }, action: NONE }
    if (key === "r") return { state: { row: state.row, reasoning: true }, action: { type: "reasoning-refresh" } }
    if (key === "1" || key === "2") return { state: { ...state, reasoningTab: Number(key) - 1, reasoningScroll: 0 }, action: NONE }
    if (key === "\x1b[A" || key === "\x1b[B") return { state: { ...state, reasoningScroll: Math.max(0, Math.min(40, (state.reasoningScroll ?? 0) + (key === "\x1b[A" ? -1 : 1))) }, action: NONE }
    const config = state.pendingReasoning ?? report?.reasoning?.consent
    if (!config || !report?.reasoning?.valid) return { state, action: NONE }
    const auto = state.pendingAuto ?? report.reasoning.reasoningAuto
    if (key === "\r" && (state.pendingReasoning || state.pendingAuto !== undefined)) return { state, action: { type: "reasoning-save", config, auto } }
    const modes = { o: "off", s: "shadow", a: "adaptive" } as const
    const mode = modes[key as keyof typeof modes]
    const leases = [1, 2, 5] as const
    const next = mode ? { ...config, mode } : key === "c" ? { ...config, remoteProcessing: !config.remoteProcessing } : key === "f" ? { ...config, failureMode: config.failureMode === "pause" ? "baseline" as const : "pause" as const } : key === "l" ? { ...config, maxLeaseSteps: leases[(leases.indexOf(config.maxLeaseSteps) + 1) % leases.length]! } : key === "p" ? { ...config, provider: config.provider === "openrouter" ? "vercel-ai-gateway" as const : "openrouter" as const } : key === "+" || key === "-" ? { ...config, maxDecisionsPerTurn: Math.max(1, Math.min(20, config.maxDecisionsPerTurn + (key === "+" ? 1 : -1))) } : undefined
    return next ? { state: { ...state, pendingReasoning: next }, action: NONE } : key === "t" ? { state: { ...state, pendingAuto: !auto }, action: NONE } : { state, action: NONE }
  }
  if (key === "a") return { state: { ...state, reasoning: true }, action: { type: "reasoning-refresh" } }
  if (key === "/") return { state, action: { type: "picker" } }
  if (key === "\x01") return { state, action: { type: "providers" } }
  const onRecipe = recipes !== undefined && state.row === MODEL_PAGE_ROWS.length
  // Enter applies the recipe on the recipe row; everywhere else it closes the page like Esc.
  if (key === "\r" && onRecipe) {
    const recipe = recipes.recipes[recipeIndex(state, recipes)]
    return { state, action: recipe && !recipe.problem ? { type: "recipe", name: recipe.name } : NONE }
  }
  if (key === "\x1b" || key === "\r" || key === "q") return { state, action: { type: "close" } }
  const move = (index: number) => {
    const next = clamp(index, rowCount(recipes))
    return next === state.row ? { state, action: NONE } : { state: { ...state, row: next }, action: NONE }
  }
  if (UP.has(key)) return move(state.row - 1)
  if (DOWN.has(key)) return move(state.row + 1)
  if (onRecipe && (LEFT.has(key) || RIGHT.has(key))) {
    if (recipes.recipes.length === 0) return { state, action: NONE }
    const count = recipes.recipes.length
    return { state: { ...state, recipe: (recipeIndex(state, recipes) + (LEFT.has(key) ? count - 1 : 1)) % count }, action: NONE }
  }
  if (!report?.selectable || onRecipe) return { state, action: NONE }
  const row = MODEL_PAGE_ROWS[clamp(state.row, MODEL_PAGE_ROWS.length)]!
  if (LEFT.has(key)) return { state, action: cycleModel(row, report, -1) }
  if (RIGHT.has(key)) return { state, action: cycleModel(row, report, 1) }
  if (key === "e") return { state, action: cycleEffort(row, report) }
  if (key === "s") return { state, action: toggleFast(row, report) }
  if (key === "f") {
    const model = chosen(row, report)?.model
    return { state, action: model ? { type: "favorite", model } : NONE }
  }
  return { state, action: NONE }
}

// ---------------------------------------------------------------------------------------------
// Rendering


const describe = (choice: ModelChoice | undefined, report?: ModelsReport) => (choice ? [modelLabel(choice.model, report), choice.variant ?? choice.effort ?? "default effort", ...(isFast(choice) ? ["fast"] : [])].join(" · ") : "")
const ID_COLUMN_MAX = 40
const contextLabel =(tokens: number | undefined) => (tokens ? `${Math.round(tokens / 1000)}k` : "")

/** What an unset row falls back to, in words. */
function inherited(row: ModelPageRow, report: ModelsReport): string {
  if (row === "main") return `default · ${describe(report.defaults, report)}`
  if (row === "session") return `main · ${describe(report.roles.main ?? report.defaults, report)}`
  // /btw asks the aside role, then small, then the session's own model.
  if (row === "memoryAssistant") return report.roles.memoryExtractor ? `memoryExtractor · ${describe(report.roles.memoryExtractor, report)}` : report.roles.small ? `small · ${describe(report.roles.small, report)}` : "memoryExtractor, small, else main"
  if (row === "memoryConsolidator") return "unset: deterministic Dream consolidation"
  if (row === "aside" || row === "memoryExtractor" || row === "title" || row === "summary") return report.roles.small ? `small · ${describe(report.roles.small, report)}` : "small, else this session's model"
  return "same as main"
}

/** The recipe row (`‹ name ›`, marked when active) and, under it, the recipe's description; or how to add one. */
function recipeRows(input: { state: ModelPageState; recipes: RecipesReport; nameWidth: number; width: number; glyphs: Glyphs }): Line[] {
  const { state, recipes, nameWidth, width, glyphs } = input
  const on = state.row === MODEL_PAGE_ROWS.length
  const marker: Span = on ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " }
  const name: Span = { text: "recipe".padEnd(nameWidth), fg: on ? "primary" : "text", bold: on }
  const recipe = recipes.recipes[recipeIndex(state, recipes)]
  if (!recipe) return [fit([marker, name, { text: "no recipes · add recipes/<name>.json", fg: "muted" }], width)]
  const isActive = recipe.name === recipes.active
  const value: Line = [
    { text: "‹ ", fg: "muted" },
    { text: recipe.name, fg: "text", bold: on },
    { text: " › ", fg: "muted" },
    ...(isActive ? [{ text: "active", fg: "success" as const }] : [{ text: recipe.problem ? "unusable" : "enter applies", fg: recipe.problem ? ("error" as const) : ("muted" as const) }]),
  ]
  const detail = recipe.problem ?? recipe.description
  const rows: Line[] = [fit([marker, name, ...value], width)]
  if (detail) rows.push(fit([{ text: " ".repeat(nameWidth + 2) }, { text: detail, fg: recipe.problem ? "error" : "muted", dim: !recipe.problem }], width))
  return rows
}

/**
 * The catalog: Favorites and Recent on top (only when there are any), then one group per server with its name as the
 * heading. A starred model carries `*` wherever it is listed; Favorites and Recent also say who serves each model.
 */
type CatalogRow = { line: Line; model?: string; section?: "group" }

function modelRows(input: { report: ModelsReport; prefs: ModelPrefs; width: number; focus?: string | undefined }): CatalogRow[] {
  const { report, prefs, width } = input
  const labelOf = (model: ModelInfo) => modelParts(model.id, report).label
  const idWidth = Math.max(0, ...report.models.map((model) => labelOf(model).length)) + 2
  // The exact id stays visible, muted, beside the label: on the page where models are picked a namespace (`xai:`, `local/`) tells two routes apart.
  const idColumn = Math.min(ID_COLUMN_MAX, Math.max(0, ...report.models.map((model) => model.id.length))) + 2
  const entry = (model: ModelInfo, withServer: boolean, section?: "group"): CatalogRow => {
    const labelWidth = Math.min(idWidth, Math.max(1, width - 4))
    const label = truncateEnd(labelOf(model), Math.max(1, width - 4)).padEnd(labelWidth)
    const idRoom = Math.max(0, width - 4 - labelWidth)
    const id = truncateEnd(model.id, Math.min(ID_COLUMN_MAX, idRoom)).padEnd(Math.min(idColumn, idRoom))
    const facts = factsFor({ model, withServer, room: idRoom - textWidth(id) })
    const on = model.id === input.focus
    const star: Span = prefs.favorites.includes(model.id) ? { text: `${FAVORITE_MARK} `, fg: "warning", bold: true } : { text: "  " }
    return { line: fit([{ text: "  " }, star, { text: label, fg: on ? "primary" : "text", bold: on }, { text: id, fg: "muted" }, ...(facts ? [{ text: facts, fg: "muted" as const, dim: true }] : [])], width), model: model.id, ...(section ? { section } : {}) }
  }
  const heading = (title: string, detail?: string): CatalogRow => ({ line: clip([{ text: title, fg: "text", bold: true }, ...(detail ? [{ text: `  ${detail}`, fg: "muted" as const }] : [])], width) })
  const rows: CatalogRow[] = []
  const add = (head: CatalogRow, lines: CatalogRow[]) => {
    if (lines.length === 0) return
    if (rows.length) rows.push({ line: [] })
    rows.push(head, ...lines)
  }
  const favorites = listed(prefs.favorites, report.models)
  add(heading("Favorites", "f on a row's model stars it"), favorites.map((model) => entry(model, true)))
  const recents = listed(prefs.recents, report.models)
  add(heading("Recent", `last ${MAX_RECENTS} used`), recents.map((model) => entry(model, true)))
  for (const group of groupModels(report.models)) add(heading(group.title, `${group.models.length}`), group.models.map((model) => entry(model, false, "group")))
  return rows
}

/**
 * What a model row says after its id, as whole segments: who serves it (Recent and Favorites only), its efforts, its context
 * window. A segment that does not fit is dropped, least important first (efforts, then the server, then the context), so a
 * number is never cut in the middle (`272k` does not become `272`).
 */
function factsFor(input: { model: ModelInfo; withServer: boolean; room: number }): string {
  const { model, withServer, room } = input
  const server = withServer ? servedBy(model) : ""
  const efforts = model.efforts.join(" ")
  const context = contextLabel(model.contextWindow)
  const choices = [[server, efforts, context], [server, context], [context]]
  for (const segments of choices) {
    const text = segments.filter(Boolean).join(" · ")
    if (textWidth(text) <= room) return text
  }
  return ""
}

/**
 * The part of `rows` that fits `room` lines with the focused model's row inside it, and a muted `↑ N more` / `↓ N more` line (N
 * models) in place of what is hidden above or below. Everything shows when it fits.
 */
function windowRows(input: { rows: CatalogRow[]; focus: string | undefined; room: number; width: number }): Line[] {
  const { rows, room, width } = input
  if (rows.length <= room) return rows.map((row) => row.line)
  if (room <= 0) return []
  const focusAt = Math.max(0, rows.findIndex((row) => row.model !== undefined && row.model === input.focus && row.section === "group"))
  const count = (from: number, to: number) => rows.slice(from, to).filter((row) => row.model !== undefined).length
  const more = (arrow: string, n: number): Line => fit([{ text: `  ${arrow} ${n} more`, fg: "muted" }], width)
  let best: { start: number; visible: number } | undefined
  for (let start = 0; start < rows.length; start++) {
    const up = start > 0 ? 1 : 0
    const down = start + room - up < rows.length ? 1 : 0
    const visible = room - up - down
    // Never a window that ends short of the room while rows remain above it: the last page is full.
    if (visible < 1 || focusAt < start || focusAt >= start + visible || (start > 0 && rows.length - start < visible)) continue
    // The least scrolling that shows the focus: Favorites and Recent stay on top for as long as the selected model is below them in view.
    best = { start, visible }
    break
  }
  const { start, visible } = best ?? { start: Math.min(focusAt, rows.length - 1), visible: room }
  const end = start + visible
  return [...(start > 0 ? [more("↑", count(0, start))] : []), ...rows.slice(start, end).map((row) => row.line), ...(end < rows.length ? [more("↓", count(end, rows.length))] : [])].slice(0, room)
}

/** Renders exactly `height` lines of at most `width` cells. */
export function renderModelPage(input: { state: ModelPageState; report?: ModelsReport | undefined; recipes?: RecipesReport | undefined; prefs?: ModelPrefs | undefined; error?: string | undefined; width: number; height: number; glyphs?: Glyphs }): Line[] {
  const { state, report, recipes, error, width, height } = input
  if (height <= 0) return []
  const glyphs = input.glyphs ?? defaultGlyphs()
  const prefs = input.prefs ?? EMPTY_MODEL_PREFS

  const room = Math.max(0, height - 2)
  const inner = Math.max(1, width - 2)

  let body: Line[] = []

  if (!report) {
    body = [[{ text: error ?? "loading…", fg: error ? "error" : "muted" }]]
  } else if (!report.selectable) {
    body = [[{ text: `${report.engine} engine chooses its own model`, fg: "muted" }]]
  } else {
    const nameWidth = Math.max(...MODEL_PAGE_ROWS.map((row) => (row === "session" ? "this session" : row).length)) + 2
    const rolesBody: Line[] = []
    const hasVertexAnthropic = report.models.some((model) => model.id.startsWith("google-vertex-anthropic:"))
    const roleWidth = hasVertexAnthropic ? Math.max(1, (width >= 150 ? columns(width, [3, 2])[0]! : width) - 4) : inner

    MODEL_PAGE_ROWS.forEach((row, index) => {
      const on = index === clamp(state.row, MODEL_PAGE_ROWS.length)
      const choice = chosen(row, report)
      const parts = choice ? modelParts(choice.model, report) : undefined
      const marker: Span = on ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " }
      const name: Span = { text: (row === "session" ? "this session" : row).padEnd(nameWidth), fg: on ? "primary" : "text", bold: on }
      const value: Line = choice && parts
        ? [
            { text: "‹ ", fg: "muted" },
            { text: parts.label, fg: "text", bold: on },
            { text: " › ", fg: "muted" },
            { text: choice.variant ?? choice.effort ?? "default", fg: choice.variant || choice.effort ? "text" : "muted" },
            ...(isFast(choice) ? [{ text: " · fast", fg: "warning" as const }] : []),
            ...(choice.model !== parts.label ? [{ text: `  ${choice.model}`, fg: "muted" as const }] : []),
          ]
        : [{ text: "‹ ", fg: "muted" }, { text: inherited(row, report), fg: "muted" }, { text: " ›", fg: "muted" }]

      const available = Math.max(1, roleWidth - nameWidth - 2)
      const shown = hasVertexAnthropic && lineWidth(value) > available ? [...clip(value, available - 1), { text: "…", fg: "muted" as const }] : value
      rolesBody.push(fit([marker, name, ...shown], roleWidth))
    })
    if (recipes) rolesBody.push(...recipeRows({ state, recipes, nameWidth, width: inner, glyphs }))


    // Below 150 columns the two panels stack: the models keep at least CATALOG_MIN rows (the roles scroll with their selection), unless the page is too short for both.
    const sideBySide = width >= 150
    const stacked = !sideBySide && room >= STACKED_MIN_ROOM
    const rolesHeight = sideBySide || !stacked ? room : Math.max(ROLES_MIN, Math.min(rolesBody.length + 4, room - 1 - CATALOG_MIN))
    const catalogHeight = sideBySide ? room : room - rolesHeight - 1
    // A panel's own rows: its height less the border and the blank row above and below its body.
    const catalogRoom = Math.max(0, catalogHeight - 4)
    const focusRow = MODEL_PAGE_ROWS[clamp(state.row, MODEL_PAGE_ROWS.length)]!
    const focus = chosen(focusRow, report)?.model ?? (focusRow === "session" ? report.effective?.model : (report.roles.main ?? report.defaults).model)
    const roles = { title: "Roles", weight: 3, body: rolesBody, scroll: Math.max(0, state.row + 1 - (rolesHeight - 4)), active: true }
    const catalog = { title: "Models", weight: 2, body: (w: number) => windowRows({ rows: modelRows({ report, prefs, width: w, focus }), focus, room: catalogRoom, width: w }) }
    body = sideBySide
      ? panelGrid({ width, compact: false, padding: true, heights: [room], rows: [[roles, catalog]] })
      : panelGrid({ width, compact: false, padding: true, ...(width < 70 ? { maxColumns: 1 } : {}), heights: stacked ? [rolesHeight, catalogHeight] : [room], rows: stacked ? [[roles], [catalog]] : [[roles]] })
  }

  if (!report || !report.selectable) body = panelGrid({ width, compact: false, padding: true, ...(width < 70 ? { maxColumns: 1 } : {}), heights: [room], rows: [[{ title: "Model", body }]] })
  const summary = report?.selectable ? `next: ${describe(report.effective ?? report.roles.main ?? report.defaults, report)}` : error ? "Error" : ""
  const rows = pickerFrame("Model", width < 70 ? "a reasoning · / search · e effort · esc close" : "a reasoning · ↑↓ row · ←→ model · / search · ctrl+a providers · e effort · s fast · f favorite · esc close", width, height, body, summary)
  if (error) rows[1] = fit([{ text: "Error", fg: "error", bold: true }, { text: ` · ${error}`, fg: "error" }], width)
  return rows
}
