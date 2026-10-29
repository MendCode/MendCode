export { renderIntroPage } from "./intro-page"
import { TIERS, promptCostLine, promptCostOf, promptCostWarning, promptFocusLabel, tierDiff, type BudgetPolicy, type SetupReport, type SetupPreset, type Tier } from "@mendcode/protocol/wire"
import type { DaemonInfoReport } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line } from "../ui/theme"
import { isWide } from "../ui/breakpoints"
import { wrap } from "./wrap"
import { panelGrid } from "./deck"
import { appearancePage, focusedWindow } from "./appearance-layout"
import { customizePreview, type CustomizeInput } from "./customize-page"
import { modelLabel } from "./model-label"
import { DEFAULT_TUI_PROFILE, HOME_LAYOUTS, HOME_PANELS, LOGO_KINDS, type TuiProfile } from "./tui-profile"

export const SETUP_ROWS = ["recipe", "theme", "view", "permission", "motion", "dream", "retention", "homeLayout", "homeRightPanel", "logoKind", "promptContext", "preset", "tier", "budgetMode", "warnUsd", "stopUsd", "expensive", "helper", "done"] as const
export type SetupRow = (typeof SETUP_ROWS)[number]

export type SetupHelper = { open: boolean; draft: string; cursor: number; messages: Array<{ role: "user" | "assistant"; text: string }>; busy: boolean; error?: string }
export type SetupPageState = { helper?: SetupHelper; row: number; /** Digits typed for a custom Dream time. */ typing?: string; error?: string }

export type SetupValues = {
  theme: string
  profile?: TuiProfile
  view: string
  defaultPermission: string
  reducedMotion: boolean
  dreamAt?: string
  retentionDays?: number
  /** Recipes that can be applied (no problem), and the one matching the current roles; absent until loaded. */
  recipes?: string[]
  recipe?: string
  budget?: BudgetPolicy
  readiness?: SetupReport
  preset?: SetupPreset
  /** Settings `tier`; absent means no tier (every feature at its own default). */
  tier?: Tier
  prompt?: import("@mendcode/protocol/wire").PromptStatus
}

export type SetupOptions = { themes: string[] }

export type SetupAction = { type: "profile"; patch: Partial<TuiProfile> } | { type: "none" } | { type: "set"; patch: Record<string, unknown> } | { type: "recipe"; name: string } | { type: "finish" } | { type: "prompt" } | { type: "preset"; preset: SetupPreset } | { type: "tier"; tier: Tier | null } | { type: "helper" } | { type: "ask"; text: string }

export type SetupChecks = {
  readiness?: SetupReport
  connected: boolean
  buildId?: string
  info?: DaemonInfoReport
  infoError?: string
  quotas: Array<{ provider: string; windows: Array<{ label: string; usedPercent: number }> }>
  mcpServers?: number
  memory?: { saved: number; pending: number }
}

const NONE: SetupAction = { type: "none" }
const VIEWS = ["minimal", "balanced", "full"]
const PERMISSIONS = ["ask", "edits", "full"]
const DREAM_PRESETS = ["off", "03:00"]
const RETENTION_PRESETS = ["off", "30", "90", "180", "365"]
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const LEFT = new Set(["\x1b[D", "\x1bOD", "h"])
const RIGHT = new Set(["\x1b[C", "\x1bOC", "l"])
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/

export function createSetupPageState(): SetupPageState {
  return { row: 0 }
}

const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))

function cycle(list: string[], current: string, direction: 1 | -1) {
  const index = list.indexOf(current)
  if (index < 0) return list[direction === 1 ? 0 : list.length - 1]!
  return list[(index + direction + list.length) % list.length]!
}

export function normalizeTime(text: string): string | undefined {
  const match = TIME.exec(text.trim())
  return match ? `${match[1]!.padStart(2, "0")}:${match[2]}` : undefined
}

function choice(row: SetupRow, values: SetupValues, options: SetupOptions, direction: 1 | -1): SetupAction {
  switch (row) {
    case "recipe":
      // Custom roles (no recipe matches) start the cycle at the first recipe.
      return values.recipes?.length ? { type: "recipe", name: values.recipe ? cycle(values.recipes, values.recipe, direction) : values.recipes[direction === 1 ? 0 : values.recipes.length - 1]! } : NONE
    case "theme":
      return { type: "set", patch: { theme: cycle(options.themes, values.theme, direction) } }
    case "view":
      return { type: "set", patch: { view: cycle(VIEWS, values.view, direction) } }
    case "permission":
      return { type: "set", patch: { defaultPermission: cycle(PERMISSIONS, values.defaultPermission, direction) } }
    case "motion":
      return { type: "set", patch: { reducedMotion: !values.reducedMotion } }
    case "dream": {
      const next = cycle(DREAM_PRESETS, values.dreamAt ?? "off", direction)
      return { type: "set", patch: { dreamAt: next === "off" ? null : next } }
    }
    case "retention": {
      const next = cycle(RETENTION_PRESETS, values.retentionDays === undefined ? "off" : String(values.retentionDays), direction)
      return { type: "set", patch: { retentionDays: next === "off" ? null : Number(next) } }
    }
    case "homeLayout":
      return { type: "profile", patch: { homeLayout: cycle([...HOME_LAYOUTS], (values.profile ?? DEFAULT_TUI_PROFILE).homeLayout, direction) as TuiProfile["homeLayout"] } }
    case "homeRightPanel":
      return { type: "profile", patch: { homeRightPanel: cycle([...HOME_PANELS], (values.profile ?? DEFAULT_TUI_PROFILE).homeRightPanel, direction) as TuiProfile["homeRightPanel"] } }
    case "logoKind":
      return { type: "profile", patch: { logoKind: cycle([...LOGO_KINDS], (values.profile ?? DEFAULT_TUI_PROFILE).logoKind, direction) as TuiProfile["logoKind"] } }
    case "preset":
      return { type: "preset", preset: cycle(["default", "minimal", "full", "custom"], values.preset ?? "default", direction) as SetupPreset }
    case "tier": {
      const next = cycle(["none", ...TIERS], values.tier ?? "none", direction)
      return { type: "tier", tier: next === "none" ? null : next as Tier }
    }
    case "budgetMode": {
      const current = budgetFor(values)
      const api = current.mode !== "api-usage"
      return { type: "set", patch: { budgets: { ...current, mode: api ? "api-usage" : "subscription", warnUsd: api ? 1 : null, stopUsd: api ? 3 : null, expensiveModelRequiresConfirm: api } } }
    }
    case "warnUsd":
    case "stopUsd":
      return NONE
    case "expensive":
      return { type: "set", patch: { budgets: { ...budgetFor(values), expensiveModelRequiresConfirm: !budgetFor(values).expensiveModelRequiresConfirm } } }
    case "helper":
      return { type: "helper" }
    case "done":
      return { type: "finish" }
    case "promptContext":
      return { type: "prompt" }
  }
}

const budgetFor = (values: SetupValues): BudgetPolicy => values.budget ?? { mode: "subscription", warnUsd: null, stopUsd: null, expensiveModelRequiresConfirm: false, prices: {}, suppliedUsd: null }

function helperKey(state: SetupPageState, key: string): { state: SetupPageState; action: SetupAction } {
  const helper = state.helper!
  if (key === "\x1b") return { state: { ...state, helper: { ...helper, open: false } }, action: NONE }
  if (key === "\x0c" && !helper.busy) return { state: { ...state, helper: { open: true, draft: "", cursor: 0, messages: [], busy: false } }, action: NONE }
  if (key === "\r") return { state, action: helper.draft.trim() && !helper.busy ? { type: "ask", text: helper.draft.trim() } : NONE }
  let { draft, cursor } = helper
  if (key === "\x1b[D") cursor = Math.max(0, cursor - 1)
  else if (key === "\x1b[C") cursor = Math.min(draft.length, cursor + 1)
  else if (key === "\x01" || key === "\x1b[H") cursor = 0
  else if (key === "\x05" || key === "\x1b[F") cursor = draft.length
  else if (key === "\x7f" || key === "\b") { draft = draft.slice(0, Math.max(0, cursor - 1)) + draft.slice(cursor); cursor = Math.max(0, cursor - 1) }
  else if (key >= " " && !key.includes("\x1b") && draft.length + key.length <= 4000) { draft = draft.slice(0, cursor) + key + draft.slice(cursor); cursor += key.length }
  return { state: { ...state, helper: { ...helper, draft, cursor } }, action: NONE }
}

/** Feeds digits and colons into the Dream time: the colon follows two digits, a full valid time applies at once. */
function typeInto(state: SetupPageState, chunk: string): { state: SetupPageState; action: SetupAction } {
  let typing = state.typing ?? ""
  for (const char of chunk) {
    if (typing.length >= 5) break
    if (char === ":" && (typing.includes(":") || typing.length === 0)) continue
    typing += char
    if (/^\d\d$/.test(typing)) typing += ":"
  }
  const time = typing.length === 5 ? normalizeTime(typing) : undefined
  if (time) return { state: { row: state.row }, action: { type: "set", patch: { dreamAt: time } } }
  return { state: typing.length === 5 ? { row: state.row, typing, error: "time must be HH:MM (00:00-23:59)" } : { row: state.row, typing }, action: NONE }
}

/** Handles one raw key. Returns the same state object when nothing changed. */
export function setupPageKey(state: SetupPageState, key: string, values: SetupValues, options: SetupOptions): { state: SetupPageState; action: SetupAction } {
  const result = setupKey(state, key, values, options)
  if (state.helper && !result.state.helper) result.state = { ...result.state, helper: state.helper }
  return result
}

function setupKey(state: SetupPageState, key: string, values: SetupValues, options: SetupOptions): { state: SetupPageState; action: SetupAction } {
  if (state.helper?.open) return helperKey(state, key)
  const row = SETUP_ROWS[clamp(state.row, SETUP_ROWS.length)]!
  if (row === "warnUsd" || row === "stopUsd") {
    if (key === "\x1b" && state.typing !== undefined) return { state: { row: state.row }, action: NONE }
    if (key === "\r") {
      if (state.typing === undefined) return { state: { row: state.row, typing: budgetFor(values)[row]?.toString() ?? "" }, action: NONE }
      const amount = state.typing.trim() ? Number(state.typing) : null
      const next = { ...budgetFor(values), [row]: amount }
      if (amount !== null && (!Number.isFinite(amount) || amount < 0) || next.warnUsd !== null && next.stopUsd !== null && next.stopUsd < next.warnUsd) return { state: { ...state, error: "USD must be non-negative; stop ≥ warn" }, action: NONE }
      return { state: { row: state.row }, action: { type: "set", patch: { budgets: next } } }
    }
    if (/^[\d.]+$/.test(key)) return { state: { row: state.row, typing: ((state.typing ?? "") + key).slice(0, 16) }, action: NONE }
    if ((key === "\x7f" || key === "\b") && state.typing !== undefined) return { state: { row: state.row, typing: state.typing.slice(0, -1) }, action: NONE }
  }
  const cleared: SetupPageState = { row: state.row }
  if (state.typing !== undefined && row === "dream") {
    if (key === "\x1b") return { state: cleared, action: NONE }
    if (key === "\x7f" || key === "\b") return { state: { row: state.row, typing: state.typing.slice(0, -1) }, action: NONE }
    if (key === "\r") {
      const time = normalizeTime(state.typing)
      return time ? { state: cleared, action: { type: "set", patch: { dreamAt: time } } } : { state: { ...state, error: "time must be HH:MM (00:00-23:59)" }, action: NONE }
    }
    if (/^[\d:]+$/.test(key)) return typeInto(state, key)
    if (!UP.has(key) && !DOWN.has(key)) return { state, action: NONE }
  }
  if (key === "\x1b") return { state, action: { type: "finish" } }
  const move = (index: number) => {
    const next = clamp(index, SETUP_ROWS.length)
    return next === state.row && state.typing === undefined && !state.error ? { state, action: NONE } : { state: { row: next }, action: NONE }
  }
  if (UP.has(key)) return move(state.row - 1)
  if (DOWN.has(key)) return move(state.row + 1)
  if (row === "dream" && /^[\d:]+$/.test(key)) return typeInto({ row: state.row, typing: "" }, key)
  if (LEFT.has(key)) return row === "done" ? { state, action: NONE } : { state: { row: state.row }, action: choice(row, values, options, -1) }
  if (RIGHT.has(key) || key === " " || key === "\r") return { state: { row: state.row }, action: choice(row, values, options, 1) }
  return { state, action: NONE }
}


type Check = { label: string; tone: "ok" | "warn" | "error" | "idle"; text: string }

const TONE: Record<Check["tone"], ColorName> = { ok: "success", warn: "warning", error: "error", idle: "muted" }

export function buildChecks(checks: SetupChecks): Check[] {
  const info = checks.info
  const build = checks.buildId ?? info?.buildId
  const out: Check[] = [
    { label: "daemon", tone: checks.connected ? "ok" : "error", text: checks.connected ? `connected${build ? ` · build ${build.slice(0, 8)}` : ""}` : "not connected" },
  ]
  if (info) out.push({ label: "engine", tone: "ok", text: [info.engine, info.model ? modelLabel(info.model) : undefined, info.effort].filter(Boolean).join(" · ") })
  else out.push({ label: "engine", tone: checks.infoError ? "warn" : "idle", text: checks.infoError ?? "checking…" })
  if (info?.login) out.push({ label: "login", tone: info.login.ok ? "ok" : "error", text: info.login.ok ? "ChatGPT login ok" : (info.login.message ?? "no login") })
  else if (info) out.push({ label: "login", tone: "idle", text: "not needed for this engine" })
  const windows = checks.quotas.flatMap((q) => q.windows.map((w) => `${w.label} ${Math.round(w.usedPercent)}%`))
  out.push({ label: "quota", tone: windows.length ? "ok" : "idle", text: windows.length ? `${checks.quotas.map((q) => q.provider).join(", ")} · ${windows.join(" · ")}` : "no snapshot yet" })
  out.push({
    label: "mcp",
    tone: checks.mcpServers === undefined ? "idle" : "ok",
    text: checks.mcpServers === undefined ? "checking…" : checks.mcpServers === 0 ? "none configured" : `${checks.mcpServers} ${checks.mcpServers === 1 ? "server" : "servers"} configured`,
  })
  out.push({
    label: "memory",
    tone: checks.memory ? "ok" : "idle",
    text: checks.memory ? `${checks.memory.saved} saved${checks.memory.pending ? ` · ${checks.memory.pending} to review` : ""}` : "checking…",
  })
  if (checks.readiness) {
    const ready = checks.readiness
    out.push({ label: "helper", tone: ready.helper.ready ? "ok" : "warn", text: ready.helper.ready ? modelLabel(ready.helper.model) : ready.helper.reason ?? "unavailable" })
    out.push({ label: "budget", tone: ready.budget.enforcement.state === "stop" ? "error" : ready.budget.enforcement.state === "warn" ? "warn" : "idle", text: `${ready.budget.policy.mode} · ${ready.budget.enforcement.state}${ready.budget.policy.mode === "api-usage" ? ` · $${ready.budget.enforcement.currentKnownUsd.toFixed(2)} known` : ""}` })
  }
  if (info) out.push({ label: "data", tone: "idle", text: info.dataDir })
  return out
}

function valueText(row: SetupRow, values: SetupValues, state: SetupPageState): { text: string; fg: ColorName; hint: string } {
  switch (row) {
    case "recipe":
      if (!values.recipes) return { text: "loading…", fg: "muted", hint: "" }
      if (!values.recipes.length) return { text: "none", fg: "muted", hint: "this engine chooses its model" }
      return { text: values.recipe ?? "custom", fg: values.recipe ? "text" : "muted", hint: "models for every role · /model roles to fine-tune" }
    case "theme":
      return { text: values.theme, fg: "primary", hint: "previews live" }
    case "view":
      return { text: values.view, fg: "text", hint: "how much of a turn shows" }
    case "permission":
      return { text: values.defaultPermission, fg: values.defaultPermission === "full" ? "error" : "text", hint: "for new sessions" }
    case "motion":
      return { text: values.reducedMotion ? "reduced" : "normal", fg: "text", hint: "space toggles" }
    case "dream":
      return state.row === SETUP_ROWS.indexOf("dream") && state.typing !== undefined
        ? { text: `${state.typing}_`, fg: "warning", hint: "HH:MM · enter applies · esc cancels" }
        : { text: values.dreamAt ?? "off", fg: values.dreamAt ? "text" : "muted", hint: "daily · type a time to change" }
    case "retention":
      return { text: values.retentionDays === undefined ? "off" : `${values.retentionDays} days`, fg: values.retentionDays === undefined ? "muted" : "text", hint: "remove idle sessions" }
    case "homeLayout":
    case "homeRightPanel":
    case "logoKind":
      return { text: (values.profile ?? DEFAULT_TUI_PROFILE)[row], fg: "text", hint: "previews live" }
    case "preset":
      return { text: values.preset ?? "default", fg: "text", hint: "minimal/full set prompt, memory and approval; keep models" }
    case "tier": {
      if (!values.tier) return { text: "none", fg: "muted", hint: "minimalist · balanced · full bundle features, view and prompt · /tier" }
      const next = TIERS[TIERS.indexOf(values.tier) + 1]
      if (!next) return { text: values.tier, fg: "text", hint: "next: no tier (features at their own defaults)" }
      const diff = tierDiff(values.tier, next)
      const change = [...diff.added.map((id) => `+${id}`), ...diff.removed.map((id) => `-${id}`)].join(" ")
      return { text: values.tier, fg: "text", hint: `next ${next}: ${change || "no feature change"}` }
    }
    case "budgetMode":
      return { text: budgetFor(values).mode, fg: "text", hint: "subscription: no USD gate · API: known cost only" }
    case "warnUsd":
    case "stopUsd":
      return { text: state.row === SETUP_ROWS.indexOf(row) && state.typing !== undefined ? `${state.typing}_` : budgetFor(values)[row] === null ? "off" : `$${budgetFor(values)[row]}`, fg: "text", hint: "enter edits · empty clears · enter saves" }
    case "expensive":
      return { text: budgetFor(values).expensiveModelRequiresConfirm ? "on" : "off", fg: "text", hint: "confirm explicitly priced expensive API calls" }
    case "helper":
      return { text: values.readiness?.helper.ready ? modelLabel(values.readiness.helper.model) : "unavailable", fg: values.readiness?.helper.ready ? "text" : "muted", hint: "enter opens setup chat" }
    case "done":
      return { text: "", fg: "muted", hint: "" }
    case "promptContext":
      return { text: values.prompt ? `${values.prompt.mode} · ${promptFocusLabel(values.prompt)}` : "loading…", fg: "text", hint: values.prompt ? [promptCostLine(promptCostOf(values.prompt, values.prompt.mode)), promptCostWarning(values.prompt.mode), "enter selects mode and family"].filter(Boolean).join(" · ") : "enter selects mode and family" }
  }
}

/** Bordered Checks and Choices, with a real home preview and header keys. */
export function renderSetupPage(input: {
  state: SetupPageState; values: SetupValues; checks: SetupChecks; firstRun: boolean
  width: number; height: number; glyphs?: Glyphs; preview?: CustomizeInput["preview"]
}): Line[] {
  const { state, values, width, height } = input
  const glyphs = input.glyphs ?? defaultGlyphs()
  if (state.helper?.open) return renderSetupHelper(input)
  const checks = buildChecks(input.checks)
  const labels: Partial<Record<SetupRow, string>> = { homeLayout: "Welcome mode", homeRightPanel: "Split panel", logoKind: "Home logo", promptContext: "Prompt context" }
  const issues = checks.filter((check) => check.tone === "warn" || check.tone === "error").length
  const checkTitle = `Checks${issues ? ` · ${issues} issue${issues === 1 ? "" : "s"}` : ""}`
  let checkLines: Line[] = checks.map((check) => [{ text: `${check.tone === "error" ? "!" : check.tone === "ok" ? "✓" : "·"} `, fg: TONE[check.tone] }, { text: `${check.label.padEnd(8)} `, fg: "muted" }, { text: check.text, fg: "text" }])
  let focus = 0
  const choices: Line[] = []
  SETUP_ROWS.forEach((row, index) => {
    const on = index === state.row
    if (on) focus = choices.length
    const value = valueText(row, values, state)
    choices.push([{ text: on ? `${glyphs.user} ` : "  ", fg: "primary" }, { text: (labels[row] ?? row).padEnd(15), fg: on ? "primary" : "text", bold: on }, { text: row === "done" ? "enter to finish" : `‹ ${value.text} ›`, fg: value.fg }])
    if (on && !state.error && ["preset", "tier", "promptContext", "budgetMode", "warnUsd", "stopUsd", "expensive", "helper"].includes(row) && value.hint) choices.push([{ text: `  ${value.hint}`, fg: "muted" }])
    if (on && state.error) choices.push([{ text: state.error, fg: "error" }])
  })
  const inner = Math.max(1, width - 4)
  const room = Math.max(1, height - 2)
  const wide = isWide(width)
  const previewInput = input.preview ?? { root: "", now: 0, tip: "" }
  let body: Line[]
  const previewPanel = (previewWidth: number, previewHeight: number) => customizePreview({ profile: values.profile ?? { ...DEFAULT_TUI_PROFILE }, preview: previewInput, screenHeight: height, width: previewWidth, height: Math.max(1, previewHeight), glyphs, showPrompt: false })
  if (wide) {
    const topHeight = Math.min(choices.length + 4, Math.max(7, Math.floor((room - 1) * 0.65)))
    const previewHeight = Math.max(3, room - topHeight - 1)
    body = panelGrid({ width: inner, compact: false, padding: true, gap: 1, rows: [
      [{ title: checkTitle, body: checkLines, weight: 1 }, { title: "Choices", body: focusedWindow(choices, focus, topHeight - 4), weight: 1 }],
      [{ title: "Home preview", body: (w) => previewPanel(w, previewHeight - 4) }],
    ], heights: [topHeight, previewHeight] })
  } else {
    const connection = checks.find((check) => check.label === "daemon")!
    const engine = checks.find((check) => check.label === "engine")!
    const login = checks.find((check) => check.label === "login" && check.tone === "error")
    const ready = input.checks.readiness
    const helperBudget = ready ? `helper: ${ready.helper.ready ? modelLabel(ready.helper.model) : "unavailable"} · budget: ${ready.budget.enforcement.state}${ready.budget.policy.mode === "api-usage" ? ` $${ready.budget.enforcement.currentKnownUsd.toFixed(2)}` : ""}` : undefined
    checkLines = [
      [{ text: `daemon: ${connection.text}`, fg: TONE[connection.tone] }],
      [{ text: `engine: ${engine.text}${login ? ` · login: ${login.text}` : ""}`, fg: login ? "error" : TONE[engine.tone] }],
      [{ text: width < 70 ? helperBudget ?? `mcp: ${input.checks.mcpServers ?? "pending"} · memory: ${input.checks.memory?.saved ?? "pending"}` : checks.filter((check) => ["quota", "mcp", "memory"].includes(check.label)).map((check) => `${check.label}: ${check.text}`).join(" · "), fg: "muted" }],
      ...(helperBudget && width >= 70 ? [[{ text: helperBudget, fg: "muted" as const }]] : []),
    ]
    const padded = width >= 70
    const inset = padded ? 4 : 2
    const checksHeight = Math.max(4, Math.min(padded ? 8 : 7, Math.floor(room * 0.3)))
    const choicesHeight = Math.max(4, Math.floor(room * 0.4))
    const previewHeight = Math.max(3, room - checksHeight - choicesHeight - 2)
    body = panelGrid({ width: inner, compact: false, padding: padded, maxColumns: 1, rows: [
      [{ title: checkTitle, body: checkLines }],
      [{ title: "Choices", body: focusedWindow(choices, focus, choicesHeight - inset) }],
      [{ title: "Home preview", body: (w) => previewPanel(w, previewHeight - inset) }],
    ], heights: [checksHeight, choicesHeight, previewHeight] })
  }
  return appearancePage({ title: "Setup", subtitle: input.firstRun ? "welcome" : "", hints: "↑↓ row · ←→ change · enter next · esc skip", body, width, height })
}

function renderSetupHelper(input: Parameters<typeof renderSetupPage>[0]): Line[] {
  const helper = input.state.helper!
  const width = input.width
  const room = Math.max(1, input.height - 2)
  const inner = Math.max(1, width - 4)
  const readiness = input.checks.readiness
  const chat: Line[] = []
  for (const message of helper.messages) {
    const prefix = message.role === "user" ? "› " : "◆ "
    for (const [index, text] of wrap(message.text, Math.max(1, inner - 6)).entries()) chat.push([{ text: `${index ? "  " : prefix}${text}`, fg: message.role === "user" ? "primary" : "text" }])
    chat.push([])
  }
  if (helper.error) chat.push([{ text: helper.error, fg: "error" }])
  if (helper.busy) chat.push([{ text: "Answering…", fg: "muted" }])
  const start = Math.max(0, helper.cursor - Math.max(1, inner - 10))
  const draft = helper.draft.slice(start, helper.cursor) + "│" + helper.draft.slice(helper.cursor)
  const body = panelGrid({ width: inner, compact: false, padding: true, maxColumns: 1, rows: [
    [{ title: "Setup helper", body: chat.slice(-Math.max(1, room - 10)) }],
    [{ title: readiness?.helper.ready ? modelLabel(readiness.helper.model) : "Helper unavailable", body: [[{ text: readiness?.helper.reason ?? `› ${draft}`, fg: readiness?.helper.ready ? "text" : "warning" }]] }],
  ], heights: [Math.max(4, room - 6), 5] })
  return appearancePage({ title: "Setup", hints: "enter send · ctrl-l clear · esc choices", body, width, height: input.height })
}
