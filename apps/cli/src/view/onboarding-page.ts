import { TIERS, type Tier } from "@mendcode/protocol/wire"
import type { PermissionMode } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, GLYPH_CHOICES, type ColorName, type GlyphChoice, type Glyphs, type Line } from "../ui/theme"
import { appearancePage, focusedWindow } from "./appearance-layout"
import { beside, fit, panelGrid } from "./deck"
import { lineWidth, textWidth, wrap } from "./wrap"
import { wayStateWord, type Detected, type ModelOption, type ReadyItem, type Way, type WayAction } from "./onboarding-detect"
import { importPickerText, importSummary, importValue, openPicker, pickerKey, renderImportPicker, toggleAll, validSelection, type ImportPicker } from "./onboarding-import"
import { modelConnects, modelPickerFocus, modelPickerKey, modelPickerText, openModelPicker, renderModelPicker, type ModelPicker } from "./onboarding-models"
import { PERMISSION_NOTES, TIER_WHAT, onboardingSample, tierLine, type SampleLook, type SamplePart } from "./onboarding-sample"
import { diffViewNote } from "./tool-card"
import { DIFF_VIEWS, PROMPT_CHROMES, TOOL_LAYOUTS, TOOL_LAYOUT_NAMES, type TuiProfile } from "./tui-profile"

/**
 * `/setup` and the first run: what is ready on this machine, the choices (model, tier, permission, then the look: theme,
 * glyphs, tool cards, diff, prompt, pet; then import) and one real preview of the focused choice. Enter on any row but Import
 * starts chatting with the choices shown; Enter or Space on Import opens a picker in the same screen, and Space on Model lists
 * every model found, grouped by who runs it, with the sign-ins that would add more (`onboarding-models`). Up from the first
 * choice reaches the Ready rows MendCode's own engine signs in with (`connectRows`): Enter there runs that `/connect` flow
 * and comes back here. Nothing is written, imported or saved until that final Enter, except what a `/connect` flow saves
 * itself; esc keeps working defaults. Everything else (memory, budget, home) lives in `/customize` and `/setup advanced`.
 * Under 60 columns, or under 72 and 34 rows, the preview is a key (`p`) away instead of under the choices.
 */
export const ONBOARDING_PERMISSIONS = ["ask", "edits", "full", "plan"] as const
export type OnboardingPermission = (typeof ONBOARDING_PERMISSIONS)[number]
export type OnboardingRow = "model" | "tier" | "permission" | "look" | "glyphs" | "tools" | "diff" | "prompt" | "pet" | "import" | "start"
export type OnboardingTier = Tier | "none"
/** The look rows past theme and glyphs, as the profile holds them now: `tools` is a tool layout name or `custom`. */
export type SetupStyle = { tools: string; diffView: TuiProfile["diffView"]; promptChrome: TuiProfile["promptChrome"]; pet: string }
/** The rows a `SetupStyle` adds, in order. */
const STYLE_ROWS = ["tools", "diff", "prompt", "pet"] as const
/** Below this width the preview leaves the page and `p` shows it in place of the choices. */
export const PREVIEW_KEY_WIDTH = 60
/** Stacked (under 72 columns), the preview stays under the choices only from this height; shorter, it would show a sliver, so `p` shows it whole. */
export const STACKED_PREVIEW_HEIGHT = 34

export type OnboardingState = {
  row: number
  /** The model picked; absent follows the recommendation. */
  model?: string
  tier: OnboardingTier
  permission: PermissionMode
  /** The theme shown (applied live, saved on the final Enter). Absent: the page has no Look row. */
  look?: string
  /** The symbol set shown (applied live, saved on the final Enter). Absent: the page has no Glyphs row. */
  glyphs?: GlyphChoice
  /** Tool cards, diff, prompt and pet as shown (applied live, saved on the final Enter). Absent: the page has none of these rows. */
  style?: SetupStyle
  /** `setupImportKey`s chosen to import; empty is the default and imports nothing. */
  imports: readonly string[]
  /** The open Import picker, when there is one. */
  picker?: ImportPicker
  /** The open model list (Space on the Model row), when there is one. */
  models?: ModelPicker
  /** Where the preview is a key away (see `STACKED_PREVIEW_HEIGHT`): it is shown in place of the choices. */
  preview?: boolean
  /** The focused sign-in row (an index into `connectRows`), while the focus is up in Ready instead of on a choice. */
  ready?: number
}
export type OnboardingCurrent = { model?: string | undefined; tier?: Tier | undefined; permission?: PermissionMode | undefined; theme?: string | undefined; glyphs?: GlyphChoice | undefined; style?: SetupStyle | undefined }
export type OnboardingChoices = { model?: string; tier: OnboardingTier; permission: PermissionMode; theme?: string; glyphs?: GlyphChoice; style?: SetupStyle; imports: string[] }
export type OnboardingAction =
  | { type: "none" }
  /** Enter: start chatting with these choices. */
  | { type: "finish"; choices: OnboardingChoices }
  /** Esc: leave with working defaults and write nothing but "done". */
  | { type: "defaults" }
  /** The Look row moved: the app applies the theme now so the preview and the page repaint in it. */
  | { type: "look"; theme: string }
  /** A Glyphs, Tools, Diff, Prompt or Pet row moved: the app applies the profile keys now (not saved), so the screen redraws with them. */
  | { type: "style"; patch: Partial<TuiProfile> }
  | { type: "recheck" }
  /** Enter on a sign-in row: `/connect <target>` (the provider list when empty), then back to this page, checked again. */
  | { type: "connect"; target: string }
  /** Enter on "Use Codex · its own harness" before its models are listed: turn its thread bridge on, then back here, checked again. */
  | { type: "harness"; engine: "codex" }

const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j", "\t"])
const LEFT = new Set(["\x1b[D", "\x1bOD", "h"])
const RIGHT = new Set(["\x1b[C", "\x1bOC", "l", " "])

/** No Model row while nothing can run: a model means something only once a harness or an account is chosen above it. */
export const onboardingRows = (detected: Detected | undefined, state?: Pick<OnboardingState, "look" | "glyphs" | "style">): OnboardingRow[] => [...(detected && !detected.usable ? [] : ["model" as const]), "tier", "permission", ...(state?.look !== undefined ? ["look" as const] : []), ...(state?.glyphs !== undefined ? ["glyphs" as const] : []), ...(state?.style ? STYLE_ROWS : []), ...(detected?.importRow ? ["import" as const] : []), "start"]

/** First-run values start at the recommendation; a reopened page starts at what is saved, so Enter changes nothing by itself. */
export function createOnboardingState(input: { current: OnboardingCurrent; firstRun: boolean }): OnboardingState {
  const { current } = input
  return { row: 0, ...(current.model ? { model: current.model } : {}), tier: current.tier ?? (input.firstRun ? "balanced" : "none"), permission: current.permission ?? "ask", ...(current.theme ? { look: current.theme } : {}), ...(current.glyphs ? { glyphs: current.glyphs } : {}), ...(current.style ? { style: current.style } : {}), imports: [] }
}

/** The profile keys a style row's value stands for. */
export function stylePatch(style: SetupStyle): Partial<TuiProfile> {
  const layout = TOOL_LAYOUTS[style.tools as keyof typeof TOOL_LAYOUTS]
  return { ...(layout ?? {}), diffView: style.diffView, promptChrome: style.promptChrome, pet: style.pet }
}

/** The next value of a style row: a tool layout (`custom` steps to the first), a diff view, a prompt chrome, or off/Mend (a picture pet stays one of the values). */
function cycleStyle(style: SetupStyle, row: (typeof STYLE_ROWS)[number], direction: 1 | -1): { style: SetupStyle; patch: Partial<TuiProfile> } {
  if (row === "tools") {
    const tools = cycle(TOOL_LAYOUT_NAMES, style.tools as (typeof TOOL_LAYOUT_NAMES)[number], direction)
    return { style: { ...style, tools }, patch: { ...TOOL_LAYOUTS[tools] } }
  }
  if (row === "diff") {
    const diffView = cycle(DIFF_VIEWS, style.diffView, direction)
    return { style: { ...style, diffView }, patch: { diffView } }
  }
  if (row === "prompt") {
    const promptChrome = cycle(PROMPT_CHROMES, style.promptChrome, direction)
    return { style: { ...style, promptChrome }, patch: { promptChrome } }
  }
  const pets = ["off", "mend", ...(style.pet === "off" || style.pet === "mend" ? [] : [style.pet])]
  const pet = cycle(pets, style.pet, direction)
  return { style: { ...style, pet }, patch: { pet } }
}

const cycle = <T,>(list: readonly T[], value: T, direction: 1 | -1): T => {
  const index = list.indexOf(value)
  return index < 0 ? list[0]! : list[(index + direction + list.length) % list.length]!
}

/** The tier values this page can show: none only when nothing is saved and this is not the first run. */
export const tierChoices = (firstRun: boolean): OnboardingTier[] => firstRun ? [...TIERS] : ["none", ...TIERS]

/** The Ready rows MendCode's own engine uses; Claude Code, Codex and pi run as external harnesses on their own logins. */
const NATIVE_ITEMS: ReadonlySet<ReadyItem["id"]> = new Set(["chatgpt", "keys"])
/** A Ready row worth a line: pi only when found, the ChatGPT login only where this engine uses it. */
const shownItem = (item: ReadyItem) => item.ok || !(item.id === "pi" || item.id === "chatgpt" && item.detail === "not used by this engine")

/** A Ready row Enter acts on, and the `/connect` target it opens (empty: the provider list). */
export type ConnectRow = { id: ReadyItem["id"]; target: string }

/**
 * The sign-in rows, in the order Ready draws them: the ChatGPT login runs `/connect chatgpt`, API keys open `/connect`. An
 * external harness keeps the login of its own tool, so its row has nothing MendCode could run.
 */
export function connectRows(detected: Detected | undefined): ConnectRow[] {
  return (detected?.items ?? []).filter((item) => shownItem(item) && NATIVE_ITEMS.has(item.id)).map((item) => ({ id: item.id, target: item.id === "chatgpt" ? "chatgpt" : "" }))
}

/** One focusable line of Ready: an action of a way, in the order Ready draws them. */
export type WayRow = { way: Way; action: WayAction }
export const wayRows = (detected: Detected | undefined): WayRow[] => (detected?.ways ?? []).flatMap((way) => way.actions.map((action) => ({ way, action })))

/**
 * Where the focus stands after a check: with nothing that can run, on the first way to fix that (the page's main action); once
 * something can run where it could not (back from a sign-in, a harness turned on), on the Model row showing it. Every choice
 * made so far is kept.
 */
export function focusAfterCheck(state: OnboardingState, detected: Detected, before?: Detected): OnboardingState {
  const { ready, ...choosing } = state
  void ready
  const rows = wayRows(detected)
  // The focused action is followed by what it is, not where it stood: a sign-in that worked is gone from the list.
  if (state.ready !== undefined && before) {
    const left = wayRows(before)[Math.min(state.ready, wayRows(before).length - 1)]
    const at = left ? rows.findIndex((row) => wayKey(row) === wayKey(left)) : -1
    if (at >= 0) return { ...state, ready: at }
    return detected.usable || !rows.length ? { ...choosing, row: 0 } : { ...state, ready: 0 }
  }
  if (!detected.usable) return rows.length && state.ready === undefined && state.row === 0 ? { ...state, ready: 0 } : state
  if (before && !before.usable) return { ...choosing, row: 0 }
  return state
}
const wayKey = (row: WayRow) => `${row.way.id}:${row.action.kind}:${row.action.label}`

/** What Enter does on a focused way, as the hints say it. */
const WAY_ENTER: Record<WayAction["kind"], string> = { model: "enter use it", connect: "enter sign in, then back here", harness: "enter turn it on, then back here", recheck: "enter check again" }
const WAY_ENTER_SHORT: Record<WayAction["kind"], string> = { model: "enter use it", connect: "enter sign in", harness: "enter turn on", recheck: "enter recheck" }

export function onboardingKey(state: OnboardingState, key: string, ctx: { detected: Detected | undefined; firstRun: boolean; themes?: readonly string[] | undefined }): { state: OnboardingState; action: OnboardingAction } {
  const importRow = ctx.detected?.importRow
  const none = (next: OnboardingState = state) => ({ state: next, action: { type: "none" } as OnboardingAction })
  if (state.picker) {
    const result = pickerKey(state.picker, key, importRow)
    const { picker, ...rest } = state
    void picker
    return none({ ...rest, ...(result.picker ? { picker: result.picker } : {}), ...(result.commit ? { imports: result.commit } : {}) })
  }
  if (state.models) {
    const result = modelPickerKey({ picker: state.models, key, detected: ctx.detected, connects: modelConnects(ctx.detected, connectRows(ctx.detected)), chosen: state.model ?? ctx.detected?.recommended })
    const { models, ...rest } = state
    void models
    if (!result.picker) return none({ ...rest, ...(result.model ? { model: result.model } : {}) })
    return { state: { ...state, models: result.picker }, action: result.action ?? { type: "none" } }
  }
  const rows = onboardingRows(ctx.detected, state)
  const row = rows[Math.min(state.row, rows.length - 1)]!
  if (key === "\x1b" && state.preview) return none({ ...state, preview: false })
  if (key === "\x1b") return { state, action: { type: "defaults" } }
  if (key === "r") return { state, action: { type: "recheck" } }
  if (key === "p") return none({ ...state, preview: !state.preview })
  const ways = wayRows(ctx.detected)
  if (state.ready !== undefined && ways.length) {
    const at = Math.min(state.ready, ways.length - 1)
    const { ready, ...choosing } = state
    void ready
    if (UP.has(key)) return none({ ...state, ready: Math.max(0, at - 1) })
    if (DOWN.has(key)) return none(at + 1 < ways.length ? { ...state, ready: at + 1 } : { ...choosing, row: 0 })
    if (key === "\r" || key === " ") {
      const { action } = ways[at]!
      // A model is picked on the page (the Model row shows it), never saved here; the other actions leave and come back.
      if (action.kind === "model") return none({ ...choosing, model: action.model, row: 0 })
      if (action.kind === "connect") return { state, action: { type: "connect", target: action.target } }
      if (action.kind === "harness") return { state, action: { type: "harness", engine: action.engine } }
      return { state, action: { type: "recheck" } }
    }
    return none()
  }
  if (UP.has(key) && state.row === 0 && ways.length) return none({ ...state, ready: ways.length - 1 })
  if (UP.has(key)) return none({ ...state, row: Math.max(0, state.row - 1) })
  if (DOWN.has(key)) return none({ ...state, row: Math.min(rows.length - 1, state.row + 1) })
  if (row === "import" && key === " ") return none({ ...state, picker: openPicker(importRow, state.imports) })
  // Space lists every model found, grouped by who runs it, with the sign-ins that would add more; ←→ still step through them.
  if (row === "model" && key === " " && ctx.detected) return none({ ...state, models: openModelPicker(state.model ?? ctx.detected.recommended) })
  const direction = LEFT.has(key) ? -1 : RIGHT.has(key) ? 1 : 0
  if (direction) {
    if (row === "model") {
      const ids = (ctx.detected?.options ?? []).map((option) => option.id)
      if (!ids.length) return none()
      return none({ ...state, model: cycle(ids, state.model ?? ctx.detected?.recommended ?? ids[0]!, direction) })
    }
    if (row === "tier") return none({ ...state, tier: cycle(tierChoices(ctx.firstRun), state.tier, direction) })
    if (row === "permission") {
      const list: PermissionMode[] = [...ONBOARDING_PERMISSIONS]
      if (!list.includes(state.permission)) list.push(state.permission)
      return none({ ...state, permission: cycle(list, state.permission, direction) })
    }
    if (row === "look" && state.look !== undefined && ctx.themes?.length) {
      const theme = cycle(ctx.themes, state.look, direction)
      return { state: { ...state, look: theme }, action: { type: "look", theme } }
    }
    if (row === "glyphs" && state.glyphs !== undefined) {
      const glyphs = cycle(GLYPH_CHOICES, state.glyphs, direction)
      return { state: { ...state, glyphs }, action: { type: "style", patch: { glyphs } } }
    }
    if ((row === "tools" || row === "diff" || row === "prompt" || row === "pet") && state.style) {
      const next = cycleStyle(state.style, row, direction)
      return { state: { ...state, style: next.style }, action: { type: "style", patch: next.patch } }
    }
    if (row === "import") return none({ ...state, imports: toggleAll(importRow, state.imports) })
    return none()
  }
  if (key === "\r") {
    if (row === "import") return none({ ...state, picker: openPicker(importRow, state.imports) })
    // Nothing can answer yet: only the last row ("skip for now") leaves; Enter elsewhere goes to the first way to fix that.
    if (ctx.detected && !ctx.detected.usable && row !== "start" && ways.length) return none({ ...state, ready: 0 })
    const model = state.model ?? ctx.detected?.recommended
    return { state, action: { type: "finish", choices: { ...(model ? { model } : {}), tier: state.tier, permission: state.permission, ...(state.look !== undefined ? { theme: state.look } : {}), ...(state.glyphs !== undefined ? { glyphs: state.glyphs } : {}), ...(state.style ? { style: state.style } : {}), imports: validSelection(importRow, state.imports) } } }
  }
  return none()
}

export type OnboardingInput = {
  state: OnboardingState
  detected: Detected | undefined
  firstRun: boolean
  width: number
  height: number
  glyphs?: Glyphs
  now: number
  /** Whether detection is still running. */
  loading: boolean
  /** Screen-reader mode: one linear paragraph per fact instead of panels. */
  accessible?: boolean
  /** The columns the chat's transcript will have: the Diff row splits the sample by it, as the chat will. */
  chatWidth?: number
}

/** "Ready" says what is; with nothing that can run, the panel is where to choose how to run. */
const readyTitle = (usable: boolean) => usable ? "Ready" : "Choose how to run"

/** The tier a row shows: `none` previews as balanced chat, as the daemon would without a tier. */
const previewTier = (tier: OnboardingTier): Tier => (tier === "none" ? "balanced" : tier)

const modelOf = (detected: Detected | undefined, state: OnboardingState): ModelOption | undefined => {
  const id = state.model ?? detected?.recommended
  return detected?.options.find((option) => option.id === id)
}

const tierName = (tier: OnboardingTier) => tier === "none" ? "no tier" : tier

/** `TIER_WHAT` in fewer words, for the Tier row beside its value. */
const TIER_SHORT: Readonly<Record<Tier, string>> = { minimalist: "bare chat", balanced: "code graph, sub-agents", full: "everything" }

/** What each Glyphs value draws; the whole screen switches as the row moves. */
const GLYPH_NOTES: Record<GlyphChoice, string> = {
  auto: "the terminal decides: ASCII on old ones, Nerd Font icons where bundled",
  ascii: "plain ASCII only, for any terminal or font",
  unicode: "Unicode marks and box lines",
  nerd: "Nerd Font icons; needs a Nerd Font in this terminal",
}

/** What each tool layout does to the cards, as `/customize` sets the same three keys. */
const TOOL_NOTES: Record<string, string> = {
  quiet: "every tool card and the code map folded to one line",
  default: "long output folds, short shows; the shipped look",
  detailed: "every call shows a preview and the code map opens",
  everything: "every card open in full",
  custom: "your own mix from /customize · ←→ picks a layout",
}

const PROMPT_NOTES: Record<string, string> = {
  box: "a rounded frame around the prompt",
  "top-bottom": "a rule above and below the prompt",
  minimal: "a tinted band, no lines",
  "ascii-box": "a square frame",
}

const petNote = (pet: string) => pet === "off" ? "no pet beside the prompt" : pet === "mend" ? "Mend stands on the prompt (drawn small in this preview)" : `${pet} stands on the prompt (a picture: not in this preview)`

/** The detail under a focused style row. */
function styleNote(input: OnboardingInput, row: OnboardingRow, style: SetupStyle): string {
  if (row === "tools") return TOOL_NOTES[style.tools] ?? TOOL_NOTES.custom!
  if (row === "diff") return diffViewNote(style.diffView, input.chatWidth ?? input.width)
  if (row === "prompt") return PROMPT_NOTES[style.promptChrome] ?? ""
  return petNote(style.pet)
}

/** The style as the sample draws it. */
const sampleLook = (style: SetupStyle | undefined): SampleLook | undefined => style ? { ...stylePatch(style) } as SampleLook : undefined

/** The label column of a Ready row: its mark (2) and the longest label. */
const READY_LABEL = 13
/** The column an action and its note start at, under their way. */
const ACTION_INDENT = 2
const NOTE_INDENT = 4

/** The focused Ready line, when the focus is up in Ready. */
const focusedWay = (input: Pick<OnboardingInput, "state" | "detected">): WayRow | undefined => {
  const rows = wayRows(input.detected)
  return input.state.ready === undefined || !rows.length ? undefined : rows[Math.min(input.state.ready, rows.length - 1)]
}

/** The state of a way in words: what it is now, before the detail of how. */
const stateWord = (way: Way): string => way.state === "missing" ? "" : wayStateWord(way)
const STATE_MARK: Record<Way["state"], { text: string; fg: ColorName }> = { ready: { text: "✓", fg: "success" }, unconfirmed: { text: "?", fg: "warning" }, "sign-in": { text: "·", fg: "warning" }, failed: { text: "!", fg: "error" }, missing: { text: "·", fg: "muted" } }

/** `text` after `prefix` on the first line and indented by `indent` on the next ones; every word kept, nothing cut. */
function wrapped(prefix: Line, text: string, width: number, indent: number, fg: ColorName, bold = false): Line[] {
  const first = Math.max(10, width - lineWidth(prefix))
  const rows = wrap(text, first)
  const head = rows[0] ?? ""
  const rest = wrap(rows.slice(1).join(" "), Math.max(10, width - indent))
  return [[...prefix, { text: head, fg, bold }], ...rest.filter(Boolean).map((row): Line => [{ text: " ".repeat(indent) }, { text: row, fg, bold }])]
}

/**
 * Ready as rows: each tool or login found, best first, with its state (ready, needs sign-in, failed) and, under it, every action
 * Enter can take on it from here: use it, sign in and come back, turn the Codex harness on, or check again after a step in a
 * terminal. What is not installed closes the list on one line each. The focused action carries the focus mark and the line
 * under it says what Enter does; nothing is ever cut, so a narrow terminal wraps instead. `focus` is the focused note's last line.
 */
function readyLines(input: OnboardingInput, width: number, glyphs: Glyphs): { lines: Line[]; focus: number } {
  const { detected } = input
  if (!detected) return { lines: [[{ text: input.loading ? "checking this machine…" : "nothing detected", fg: "muted" }]], focus: 0 }
  const focused = focusedWay(input)
  // Something can run and the focus is on a choice: one line per way, its actions a key (↑) away.
  const folded = detected.usable && !focused
  const lines: Line[] = []
  let focus = 0
  for (const way of detected.ways) {
    if (folded) {
      const head: Line = [{ text: `${STATE_MARK[way.state].text} `, fg: STATE_MARK[way.state].fg }, { text: way.label.padEnd(READY_LABEL), fg: way.state === "missing" ? "muted" : "text", bold: way.state === "ready" }]
      lines.push(...wrapped(head, [stateWord(way), way.detail].filter(Boolean).join(" · "), width, 2 + READY_LABEL, "muted"))
      continue
    }
    const mark = STATE_MARK[way.state]
    const word = stateWord(way)
    const tail = [word, way.detail].filter(Boolean).join(" · ")
    const head: Line = [{ text: `${mark.text} `, fg: mark.fg }, { text: way.label.padEnd(READY_LABEL), fg: way.state === "missing" ? "muted" : "text", bold: way.state === "ready" }]
    lines.push(...wrapped(head, tail, width, 2 + READY_LABEL, "muted"))
    for (const action of way.actions) {
      const on = focused?.action === action
      const prefix: Line = [{ text: " ".repeat(ACTION_INDENT) }, { text: `${on ? glyphs.user : "›"} `, fg: on ? "primary" : "muted" }]
      lines.push(...wrapped(prefix, action.label, width, ACTION_INDENT + 2, on ? "primary" : "text", on))
      if (!on) continue
      for (const text of wrap(action.note, Math.max(10, width - NOTE_INDENT))) lines.push([{ text: `${" ".repeat(NOTE_INDENT)}${text}`, fg: "muted" }])
      focus = lines.length - 1
    }
  }
  if (!detected.ways.length) lines.push([{ text: "nothing found on this machine · r checks again", fg: "muted" }])
  else if (folded && wayRows(detected).length) lines.push([{ text: "↑ from the first choice: use, sign in or check again", fg: "muted" }])
  return { lines, focus }
}

/** Ready folded, while something can run and the focus is on a choice: the ways that are ready, and the key to see them all. Wrapped whole. */
function readySummary(input: OnboardingInput, width: number): Line[] {
  const { detected } = input
  if (!detected) return [[{ text: input.loading ? "checking this machine…" : "nothing detected", fg: "muted" }]]
  const ready = detected.ways.filter((way) => way.state === "ready").map((way) => `✓ ${way.label}`)
  const text = [...ready, wayRows(detected).length ? "↑ every way to run" : ""].filter(Boolean).join("   ")
  return wrap(text, Math.max(10, width)).map((row) => [{ text: row, fg: "muted" as ColorName }])
}

/** The one line that says what Enter will do: start chatting with exactly these choices. */
export function actionText(input: OnboardingInput, onImportRow: boolean, onStart = false): { lead: string; text: string } {
  const { state, detected } = input
  // Nothing can answer yet: the last line never promises a chat, it offers an honest way out (this page opens again next launch).
  if (detected && !detected.usable) {
    const lead = onStart ? "enter  " : "↓ enter  "
    return { lead, text: `${lead}skip for now · nothing can answer yet · /setup reopens this` }
  }
  const model = modelOf(detected, state)
  const lead = onImportRow ? "↓ enter  " : "enter  "
  return { lead, text: `${lead}start chatting · ${model?.label ?? "default model"} · ${tierName(state.tier)} · ${state.permission} · ${importSummary(detected?.importRow, state.imports)}` }
}

function actionLines(input: OnboardingInput, width: number, current: OnboardingRow | undefined, glyphs: Glyphs): Line[] {
  const { lead, text } = actionText(input, current === "import", current === "start")
  const mark: Line = [{ text: current === "start" ? `${glyphs.user} ` : "  ", fg: "primary" }]
  return wrap(text, Math.max(10, width - 2)).map((row, index): Line => index === 0
    ? [...mark, { text: row.slice(0, lead.length), fg: "primary", bold: true }, { text: row.slice(lead.length), fg: "text", bold: current === "start" }]
    : [{ text: `  ${row}`, fg: "text" }])
}

/** `space lists all 9 from 3 sources`: the Model row's way to the whole grouped list. */
function modelCount(detected: Detected | undefined): string {
  const count = detected?.options.length ?? 0
  const groups = detected?.groups.length ?? 0
  return `space lists all ${count}${groups > 1 ? ` from ${groups} sources` : ""}`
}

/** The Model row's value: the model and who runs it (`Opus · Claude Code`), the model alone when both do not fit. */
function modelValue(model: ModelOption | undefined, detected: Detected | undefined, room: number): string | undefined {
  if (!model) return undefined
  const short = detected?.groups.find((group) => group.key === model.group)?.short
  const both = short ? `${model.name} · ${short}` : model.label
  return textWidth(both) + 4 <= room ? both : model.label
}

/** The dim line under a focused row: what its value does. */
function rowDetail(input: OnboardingInput, row: OnboardingRow): string {
  const { state, detected } = input
  const model = modelOf(detected, state)
  // The way to the whole list comes before the line about the model, so a narrow column never cuts it.
  if (row === "model") return model ? `${model.current ? "current · " : model.recommended ? "recommended · " : ""}${modelCount(detected)} · ${model.line}` : detected && !detected.options.length ? "nothing to run yet: ↑ choose how to run, then the model" : "the engine chooses its own model"
  if (row === "tier") return `${state.tier === "none" ? "no tier: every feature at its own default" : tierLine(state.tier)} · ←→ ${tierChoices(input.firstRun).map(tierName).join(" · ")}`
  if (row === "permission") return PERMISSION_NOTES[state.permission] ?? ""
  if (row === "look") return "the whole screen repaints now · saved when you start chatting"
  if (row === "glyphs") return state.glyphs ? GLYPH_NOTES[state.glyphs] : ""
  if (row === "import") return "enter picks which · nothing is copied yet"
  if (row === "start") return ""
  return state.style ? styleNote(input, row, state.style) : ""
}

/** The rows of the Choose panel, the Look rows under their own heading, and the index of the focused one. The Enter line is drawn apart, so it never scrolls away. */
function chooseLines(input: OnboardingInput, width: number, glyphs: Glyphs): { lines: Line[]; focus: number } {
  const { state, detected } = input
  const rows = onboardingRows(detected, state)
  // Up in Ready, no choice is focused.
  const current = focusedWay(input) ? undefined : rows[Math.min(state.row, rows.length - 1)]
  const lines: Line[] = []
  let focus = 0
  const model = modelOf(detected, state)
  const rowLine = (row: OnboardingRow, label: string, value: string) => {
    const on = current === row
    const head: Line = [{ text: on ? `${glyphs.user} ` : "  ", fg: "primary" }, { text: label.padEnd(12), fg: on ? "primary" : "text", bold: on }, { text: `‹ ${value} ›`, fg: on ? "text" : "muted", bold: on }]
    // The tier is the choice that changes the most, so its row says what the value gives even unfocused, in the words that fit whole.
    const gives = row === "tier" && !on && state.tier !== "none" ? [TIER_WHAT[state.tier], TIER_SHORT[state.tier]].find((text) => lineWidth(head) + 2 + textWidth(text) <= width) : undefined
    lines.push(gives ? [...head, { text: `  ${gives}`, fg: "muted" }] : head)
    if (!on) return
    for (const text of wrap(rowDetail(input, row), Math.max(10, width - 4)).slice(0, 3)) lines.push([{ text: `    ${text}`, fg: "muted" }])
    // The window follows the detail's last line, so a scrolled list never cuts the note under the row.
    focus = lines.length - 1
  }
  const none = detected && !detected.options.length
  if (rows.includes("model")) rowLine("model", "Model", modelValue(model, detected, width - 14) ?? (none ? "none found" : input.loading ? "checking…" : "default"))
  rowLine("tier", "Tier", state.tier)
  rowLine("permission", "Permission", state.permission)
  if (state.look !== undefined || state.glyphs !== undefined || state.style) lines.push([{ text: "  Look", fg: "muted", bold: true }])
  if (state.look !== undefined) rowLine("look", "Theme", state.look)
  if (state.glyphs !== undefined) rowLine("glyphs", "Glyphs", state.glyphs)
  const style = state.style
  if (style) {
    rowLine("tools", "Tools", style.tools)
    rowLine("diff", "Diff", style.diffView)
    rowLine("prompt", "Prompt", style.promptChrome)
    rowLine("pet", "Pet", style.pet)
  }
  const importRow = detected?.importRow
  if (importRow) rowLine("import", "Import", importValue(importRow, state.imports))
  return { lines, focus }
}

/** The focused row as `name: value`, for the preview title; undefined when the row changes nothing the sample shows. */
function focusLabel(input: OnboardingInput, row: OnboardingRow): string | undefined {
  const { state, detected } = input
  if (row === "model") return `model: ${modelOf(detected, state)?.label ?? "default"}`
  if (row === "tier") return `tier: ${tierName(state.tier)}`
  if (row === "permission") return `permission: ${state.permission}`
  if (row === "look" && state.look !== undefined) return `look: ${state.look}`
  if (row === "glyphs" && state.glyphs !== undefined) return `glyphs: ${state.glyphs}`
  if (state.style && row === "tools") return `tools: ${state.style.tools}`
  if (state.style && row === "diff") return `diff: ${state.style.diffView}`
  if (state.style && row === "prompt") return `prompt: ${state.style.promptChrome}`
  if (state.style && row === "pet") return `pet: ${state.style.pet}`
  return undefined
}

/** Below this many rows the sample cannot hold the chat, the card and the prompt: only what the focused row controls stays. */
const WHOLE_SAMPLE_ROWS = 25

/** The previewed parts when the whole sample is cut: all of them with room for it, else the ones the focused row controls. */
function partsFor(row: OnboardingRow, room: number): readonly SamplePart[] {
  if (room >= WHOLE_SAMPLE_ROWS) return ["chat", "approval", "prompt", "footer"]
  if (row === "permission") return ["approval", "footer"]
  if (row === "prompt" || row === "pet") return ["chat", "prompt"]
  if (row === "tools" || row === "diff") return ["chat"]
  return ["chat", "footer"]
}

/**
 * The sample sized to its content (no blank rows above the prompt), or with `fill` all `room` rows with the prompt at the
 * bottom, as the chat stands in a terminal that size; cut to `room` rows only when it cannot fit.
 */
function previewLines(input: OnboardingInput, width: number, room: number, glyphs: Glyphs, row: OnboardingRow, fill = false): Line[] {
  const model = modelOf(input.detected, input.state)
  const look = sampleLook(input.state.style)
  const base = { tier: previewTier(input.state.tier), permission: input.state.permission, model: model?.id ?? "your model", width, glyphs, now: input.now, pad: false, ...(look ? { look } : {}), ...(input.chatWidth ? { chatWidth: input.chatWidth } : {}) }
  const whole = onboardingSample({ ...base, height: 1000 })
  if (whole.length <= room) return fill ? onboardingSample({ ...base, height: room, pad: true }) : whole
  return onboardingSample({ ...base, height: room, parts: partsFor(row, room) })
}

function previewTitle(input: OnboardingInput, row: OnboardingRow, width: number): string {
  const label = focusLabel(input, row)
  if (!label) return width >= 44 ? "Preview · sample session, nothing is sent" : "Preview · sample"
  return width >= 52 ? `Preview · ${label} · nothing is sent` : `Preview · ${label}`
}

export function renderOnboardingPage(input: OnboardingInput): Line[] {
  const { width, height, state, detected } = input
  if (input.accessible) {
    const rows = onboardingText(input).flatMap((text) => [...wrap(text, Math.max(10, width - 4)).map((row): Line => [{ text: `  ${row}`, fg: "text" }]), [] as Line])
    return Array.from({ length: Math.max(0, height) }, (_, y) => fit(rows[y] ?? [], width))
  }
  const glyphs = input.glyphs ?? defaultGlyphs()
  const inner = Math.max(1, width - 4)
  const room = Math.max(1, height - 2)
  const rows = onboardingRows(detected, state)
  const row = rows[Math.min(state.row, rows.length - 1)]!
  const usable = detected?.usable ?? true
  const firstFit = (candidates: string[], room: number) => candidates.find((text) => textWidth(text) <= room) ?? candidates[candidates.length - 1]!
  // With nothing that can answer, the page never speaks of starting a chat: choosing how to run comes first.
  const subtitle = firstFit(!usable
    ? [`${input.firstRun ? "welcome · " : ""}choose how to run first · or skip for now`, "choose how to run · or skip for now", "choose how to run first"]
    : input.firstRun
    ? ["welcome · all optional · nothing is saved until you start chatting", "all optional · nothing is saved until you start chatting", "all optional · saved when you start"]
    : ["nothing is saved until you start chatting", "saved when you start chatting"], inner)
  const hintRoom = inner - "Setup".length - 2
  const importRow = detected?.importRow
  if (state.picker && importRow) {
    const hints = firstFit(["↑↓ move · space toggle · a all · n none · enter done · esc back", "space toggle · a/n all/none · enter done · esc back", "space toggle · enter done · esc back"], hintRoom)
    const body = renderImportPicker({ row: importRow, picker: state.picker, width: Math.min(inner, 110), height: room, glyphs })
    return appearancePage({ title: "Setup", subtitle, hints, body, width, height })
  }
  if (state.models) {
    const list = { picker: state.models, detected, connects: modelConnects(detected, connectRows(detected)), chosen: state.model ?? detected?.recommended }
    const hints = modelPickerFocus(list) === "connect"
      ? firstFit(["↑↓ move · enter sign in, then back here · esc back", "enter sign in · esc back"], hintRoom)
      : firstFit(["↑↓ move · enter pick · r check again · esc back", "↑↓ move · enter pick · esc back", "enter pick · esc back"], hintRoom)
    const body = renderModelPicker({ ...list, width: Math.min(inner, 110), height: room, glyphs })
    return appearancePage({ title: "Setup", subtitle, hints, body, width, height })
  }
  const keyed = width < PREVIEW_KEY_WIDTH || width < 72 && height < STACKED_PREVIEW_HEIGHT
  const way = focusedWay(input)
  const signingIn = way !== undefined
  const hints = firstFit(state.preview && keyed
    ? ["←→ change · p choices · esc back", "p choices · esc back"]
    : way
      ? [`↑↓ way · ${WAY_ENTER[way.action.kind]} · r check again · esc skip`, `↑↓ · ${WAY_ENTER[way.action.kind]} · esc skip`, `↑↓ · ${WAY_ENTER_SHORT[way.action.kind]} · r recheck · esc skip`, `↑↓ · ${WAY_ENTER_SHORT[way.action.kind]} · esc skip`, `${WAY_ENTER_SHORT[way.action.kind]} · esc skip`]
      : !usable
        ? ["↑ pick a way to run · r check again · esc skip for now", "↑ ways to run · r recheck · esc skip", "↑ ways to run · esc skip"]
        : row === "import"
          ? ["↑↓ row · ←→ nothing/all · enter pick · esc keep defaults", "↑↓ row · enter pick · esc skip", "enter pick · esc skip"]
          : keyed
            ? ["↑↓ ←→ change · p preview · esc skip", "p preview · esc skip"]
            : row === "model"
              ? ["↑↓ row · ←→ change · space all models · enter start chatting · esc keep defaults", "↑↓ ←→ change · space all models · enter start · esc skip", "↑↓ ←→ change · enter start · esc skip"]
            : ["↑↓ row · ←→ change · enter start chatting · esc keep defaults", "↑↓ ←→ change · enter start · esc skip"], hintRoom)
  const foot = (text: string): Line[] => [[{ text, fg: "muted", dim: true }]]
  let body: Line[]
  if (width >= 72) {
    // The whole width: the choices grow to 64 columns, the preview takes the rest, as wide as a chat on this terminal.
    const leftWidth = Math.max(34, Math.min(64, Math.floor(inner * 0.45)))
    const rightWidth = inner - leftWidth - 1
    // Ready takes at most two fifths of the rows (half while nothing can run); past that it scrolls with the focused way.
    const readyCap = Math.max(4, Math.floor(room * (usable ? 0.4 : 0.5)))
    const ready = readyLines(input, leftWidth, glyphs)
    const readyHeight = Math.min(ready.lines.length + 2, readyCap)
    const readyBody = focusedWindow(ready.lines, ready.focus, readyHeight - 2)
    const action = actionLines(input, leftWidth, row, glyphs)
    const choose = chooseLines(input, leftWidth, glyphs)
    // Ready, a gap, Choose, a gap and the Enter line, over the one-line foot: the Enter line stays put while Choose scrolls.
    const chooseHeight = Math.min(choose.lines.length + 2, Math.max(6, room - readyHeight - action.length - 3))
    const panels = panelGrid({ width: leftWidth, compact: true, maxColumns: 1, padding: false, gap: 1, rows: [
      [{ title: readyTitle(usable), body: readyBody }],
      [{ title: "Choose", body: focusedWindow(choose.lines, choose.focus, chooseHeight - 2) }],
    ], heights: [readyHeight, chooseHeight] })
    // The whole height: the Enter line stands at the foot of the column, level with the bottom of the preview.
    const left = [...panels, ...Array.from({ length: Math.max(1, room - 1 - panels.length - action.length) }, (): Line => []), ...action]
    const sample = previewLines(input, rightWidth, Math.max(2, room - 3), glyphs, row, true)
    const right = panelGrid({ width: rightWidth, compact: true, maxColumns: 1, padding: false, rows: [
      [{ title: previewTitle(input, row, rightWidth), body: sample }],
    ] })
    body = [...beside([{ lines: left, width: leftWidth }, { lines: right, width: rightWidth }], 1), ...foot("More: /customize · /setup advanced")]
  } else if (keyed && state.preview) {
    // The preview in place of the choices: the focused row's note on top, then as much of the sample as fits.
    const note = wrap(rowDetail(input, row), Math.max(10, inner)).slice(0, 2).map((text): Line => [{ text, fg: "muted" }])
    const sample = previewLines(input, inner, Math.max(2, room - note.length - 3), glyphs, row)
    body = panelGrid({ width: inner, compact: true, maxColumns: 1, gap: 0, rows: [
      [{ title: previewTitle(input, row, inner), body: [...note, [], ...sample] }],
    ] })
  } else {
    // Stacked: every way with its actions while nothing can run or one is focused, else the ready ones folded (wrapped whole);
    // where the preview is a key away, Choose takes its room. Ready scrolls with its focus rather than cut a line.
    const action = actionLines(input, inner, row, glyphs)
    const choose = chooseLines(input, inner, glyphs)
    const previewRoom = keyed ? 0 : 8
    const ready = signingIn || !usable ? readyLines(input, inner, glyphs) : { lines: readySummary(input, inner), focus: 0 }
    const readyHeight = Math.min(ready.lines.length + 2, Math.max(4, room - action.length - previewRoom - Math.min(choose.lines.length + 2, 6)))
    const readyBody = focusedWindow(ready.lines, ready.focus, readyHeight - 2)
    const chooseHeight = Math.max(4, Math.min(choose.lines.length + 2, room - readyHeight - action.length - previewRoom))
    const top = panelGrid({ width: inner, compact: true, maxColumns: 1, gap: 0, rows: [
      [{ title: readyTitle(usable), body: readyBody }],
      [{ title: "Choose", body: focusedWindow(choose.lines, choose.focus, chooseHeight - 2) }],
    ], heights: [readyHeight, chooseHeight] })
    body = [...top, ...action]
    if (!keyed) {
      const sample = previewLines(input, inner, Math.max(2, room - body.length - 2), glyphs, row)
      body.push(...panelGrid({ width: inner, compact: true, maxColumns: 1, gap: 0, rows: [[{ title: previewTitle(input, row, inner), body: sample }]] }))
    }
  }
  return appearancePage({ title: "Setup", subtitle, hints, body, width, height })
}

/** Plain linear text for screen-reader mode: one line per fact, no panels. */
export function onboardingText(input: OnboardingInput): string[] {
  const { detected, state } = input
  if (state.picker && detected?.importRow) return importPickerText(detected.importRow, state.picker)
  if (state.models) return modelPickerText({ picker: state.models, detected, connects: modelConnects(detected, connectRows(detected)), chosen: state.model ?? detected?.recommended })
  const usable = detected?.usable !== false
  const out = [usable
    ? "Setup. Enter starts chatting with the choices below. Escape keeps working defaults. Nothing is written until you start chatting."
    : "Setup. Nothing can answer yet: choose how to run first. Up and down move between the ways below; Enter acts on the focused one. Escape skips for now."]
  for (const way of detected?.ways ?? []) out.push(`${way.label}: ${wayStateWord(way)}, ${way.detail}.${way.actions.length ? ` Actions: ${way.actions.map((action) => action.label).join("; ")}.` : ""}`)
  const focused = focusedWay(input)
  if (focused) out.push(`Focused: ${focused.way.label}, ${focused.action.label}. Enter: ${focused.action.note}.`)
  const model = modelOf(detected, state)
  if (usable) out.push(`Model: ${model?.label ?? "none"}${model?.recommended ? " (recommended)" : ""}. ${model?.line ?? ""}`)
  if (detected?.options.length) out.push(`${detected.options.length} ${detected.options.length === 1 ? "model" : "models"} found, from ${detected.groups.map((group) => group.title).join(", ")}. Space on the Model row lists them all; left and right step through them.`)
  out.push(`Tier: ${state.tier}. ${state.tier === "none" ? "No tier." : tierLine(state.tier)}.`)
  out.push(`Permission: ${state.permission}. ${PERMISSION_NOTES[state.permission] ?? ""}.`)
  if (state.look !== undefined) out.push(`Look: ${state.look}. Left and right change the theme now.`)
  if (state.glyphs !== undefined) out.push(`Glyphs: ${state.glyphs}. ${GLYPH_NOTES[state.glyphs]}. Left and right change it now.`)
  const style = state.style
  if (style) {
    out.push(`Tools: ${style.tools}. ${styleNote(input, "tools", style)}.`)
    out.push(`Diff: ${style.diffView}. ${styleNote(input, "diff", style)}.`)
    out.push(`Prompt: ${style.promptChrome}. ${styleNote(input, "prompt", style)}.`)
    out.push(`Pet: ${style.pet}. ${styleNote(input, "pet", style)}.`)
  }
  if (detected?.importRow) out.push(`Import: ${importValue(detected.importRow, state.imports)}. Available from ${detected.importRow.summary}. Enter or Space on the Import row opens the list; the default imports nothing.`)
  if (usable && wayRows(detected).length) out.push("Up from the first choice reaches the ways to run above; Enter there uses one, signs in and comes back here, or checks again. Claude Code, Codex and pi use their own logins.")
  out.push(usable ? `Enter starts chatting: ${actionText(input, false).text.slice("enter  ".length)}.` : "The last row skips for now: nothing can answer yet, and /setup reopens this page.")
  return out
}
