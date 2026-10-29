import { TIERS, type Tier } from "@mendcode/protocol/wire"
import type { PermissionMode } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, GLYPH_CHOICES, type ColorName, type GlyphChoice, type Glyphs, type Line } from "../ui/theme"
import { appearancePage, focusedWindow } from "./appearance-layout"
import { beside, fit, panelGrid } from "./deck"
import { textWidth, wrap } from "./wrap"
import type { Detected, ModelOption } from "./onboarding-detect"
import { importPickerText, importSummary, importValue, openPicker, pickerKey, renderImportPicker, toggleAll, validSelection, type ImportPicker } from "./onboarding-import"
import { PERMISSION_NOTES, onboardingSample, tierLine, type SampleLook, type SamplePart } from "./onboarding-sample"
import { diffViewNote } from "./tool-card"
import { DIFF_VIEWS, PROMPT_CHROMES, TOOL_LAYOUTS, TOOL_LAYOUT_NAMES, type TuiProfile } from "./tui-profile"

/**
 * `/setup` and the first run: what is ready on this machine, the choices (model, tier, permission, then the look: theme,
 * glyphs, tool cards, diff, prompt, pet; then import) and one real preview of the focused choice. Enter on any row but Import
 * starts chatting with the choices shown; Enter or Space on Import opens a picker in the same screen. Nothing is written,
 * imported or saved until that final Enter; esc keeps working defaults. Everything else (memory, budget, home) lives in
 * `/customize` and `/setup advanced`. Under 60 columns, or under 72 and 34 rows, the preview is a key (`p`) away instead of under the choices.
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
  /** Where the preview is a key away (see `STACKED_PREVIEW_HEIGHT`): it is shown in place of the choices. */
  preview?: boolean
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

const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j", "\t"])
const LEFT = new Set(["\x1b[D", "\x1bOD", "h"])
const RIGHT = new Set(["\x1b[C", "\x1bOC", "l", " "])

export const onboardingRows = (detected: Detected | undefined, state?: Pick<OnboardingState, "look" | "glyphs" | "style">): OnboardingRow[] => ["model", "tier", "permission", ...(state?.look !== undefined ? ["look" as const] : []), ...(state?.glyphs !== undefined ? ["glyphs" as const] : []), ...(state?.style ? STYLE_ROWS : []), ...(detected?.importRow ? ["import" as const] : []), "start"]

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

export function onboardingKey(state: OnboardingState, key: string, ctx: { detected: Detected | undefined; firstRun: boolean; themes?: readonly string[] | undefined }): { state: OnboardingState; action: OnboardingAction } {
  const importRow = ctx.detected?.importRow
  const none = (next: OnboardingState = state) => ({ state: next, action: { type: "none" } as OnboardingAction })
  if (state.picker) {
    const result = pickerKey(state.picker, key, importRow)
    const { picker, ...rest } = state
    void picker
    return none({ ...rest, ...(result.picker ? { picker: result.picker } : {}), ...(result.commit ? { imports: result.commit } : {}) })
  }
  const rows = onboardingRows(ctx.detected, state)
  const row = rows[Math.min(state.row, rows.length - 1)]!
  if (key === "\x1b" && state.preview) return none({ ...state, preview: false })
  if (key === "\x1b") return { state, action: { type: "defaults" } }
  if (key === "r") return { state, action: { type: "recheck" } }
  if (key === "p") return none({ ...state, preview: !state.preview })
  if (UP.has(key)) return none({ ...state, row: Math.max(0, state.row - 1) })
  if (DOWN.has(key)) return none({ ...state, row: Math.min(rows.length - 1, state.row + 1) })
  if (row === "import" && key === " ") return none({ ...state, picker: openPicker(importRow, state.imports) })
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

const TONE = (ok: boolean): ColorName => (ok ? "success" : "muted")

/** The tier a row shows: `none` previews as balanced chat, as the daemon would without a tier. */
const previewTier = (tier: OnboardingTier): Tier => (tier === "none" ? "balanced" : tier)

const modelOf = (detected: Detected | undefined, state: OnboardingState): ModelOption | undefined => {
  const id = state.model ?? detected?.recommended
  return detected?.options.find((option) => option.id === id)
}

const tierName = (tier: OnboardingTier) => tier === "none" ? "no tier" : tier

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

const petNote = (pet: string) => pet === "off" ? "no pet beside the prompt" : pet === "mend" ? "Mend stands on the prompt" : `${pet} stands on the prompt (a picture: not in this preview)`

/** The detail under a focused style row. */
function styleNote(input: OnboardingInput, row: OnboardingRow, style: SetupStyle): string {
  if (row === "tools") return TOOL_NOTES[style.tools] ?? TOOL_NOTES.custom!
  if (row === "diff") return diffViewNote(style.diffView, input.chatWidth ?? input.width)
  if (row === "prompt") return PROMPT_NOTES[style.promptChrome] ?? ""
  return petNote(style.pet)
}

/** The style as the sample draws it. */
const sampleLook = (style: SetupStyle | undefined): SampleLook | undefined => style ? { ...stylePatch(style) } as SampleLook : undefined

function readyLines(input: OnboardingInput, width: number): Line[] {
  const { detected } = input
  if (!detected) return [[{ text: input.loading ? "checking this machine…" : "nothing detected", fg: "muted" }]]
  const lines: Line[] = []
  for (const item of detected.items) {
    if (!item.ok && (item.id === "pi" || item.id === "chatgpt" && item.detail === "not used by this engine")) continue
    const glyph = item.ok ? "✓" : "·"
    const tail = item.ok ? item.detail : item.fix ? `→ ${item.fix}` : item.detail
    lines.push([{ text: `${glyph} `, fg: TONE(item.ok) }, { text: item.label.padEnd(14), fg: item.ok ? "text" : "muted" }, { text: tail, fg: "muted" }])
  }
  return lines.map((line) => fit(line, width))
}

/** The ready list as at most two wrapped lines, found items first. */
function readySummary(input: OnboardingInput, width: number): Line[] {
  const { detected } = input
  if (!detected) return [[{ text: input.loading ? "checking this machine…" : "nothing detected", fg: "muted" }]]
  const items = detected.items.filter((item) => item.ok || item.fix)
  const text = items.map((item) => item.ok ? `✓ ${item.label}` : `· ${item.label} → ${item.fix}`).join("   ")
  return wrap(text, Math.max(10, width)).slice(0, 2).map((row) => [{ text: row, fg: "muted" as ColorName }])
}

/** The one line that says what Enter will do: start chatting with exactly these choices. */
export function actionText(input: OnboardingInput, onImportRow: boolean): { lead: string; text: string } {
  const { state, detected } = input
  const model = modelOf(detected, state)
  const lead = onImportRow ? "↓ enter  " : "enter  "
  return { lead, text: `${lead}start chatting · ${model?.label ?? "default model"} · ${tierName(state.tier)} · ${state.permission} · ${importSummary(detected?.importRow, state.imports)}` }
}

function actionLines(input: OnboardingInput, width: number, current: OnboardingRow | undefined, glyphs: Glyphs): Line[] {
  const { lead, text } = actionText(input, current === "import")
  const mark: Line = [{ text: current === "start" ? `${glyphs.user} ` : "  ", fg: "primary" }]
  return wrap(text, Math.max(10, width - 2)).map((row, index): Line => index === 0
    ? [...mark, { text: row.slice(0, lead.length), fg: "primary", bold: true }, { text: row.slice(lead.length), fg: "text", bold: current === "start" }]
    : [{ text: `  ${row}`, fg: "text" }])
}

/** The dim line under a focused row: what its value does. */
function rowDetail(input: OnboardingInput, row: OnboardingRow): string {
  const { state, detected } = input
  const model = modelOf(detected, state)
  if (row === "model") return model ? `${model.current ? "current · " : model.recommended ? "recommended · " : ""}${model.line}` : detected && !detected.options.length ? "nothing to run yet: fix a row under Ready, then press r" : "the engine chooses its own model"
  if (row === "tier") return state.tier === "none" ? "no tier: every feature at its own default" : tierLine(state.tier)
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
  const current = rows[Math.min(state.row, rows.length - 1)]
  const lines: Line[] = []
  let focus = 0
  const model = modelOf(detected, state)
  const rowLine = (row: OnboardingRow, label: string, value: string) => {
    const on = current === row
    lines.push([{ text: on ? `${glyphs.user} ` : "  ", fg: "primary" }, { text: label.padEnd(12), fg: on ? "primary" : "text", bold: on }, { text: `‹ ${value} ›`, fg: on ? "text" : "muted", bold: on }])
    if (!on) return
    for (const text of wrap(rowDetail(input, row), Math.max(10, width - 4)).slice(0, 2)) lines.push([{ text: `    ${text}`, fg: "muted" }])
    // The window follows the detail's last line, so a scrolled list never cuts the note under the row.
    focus = lines.length - 1
  }
  const none = detected && !detected.options.length
  rowLine("model", "Model", model?.label ?? (none ? "none found" : input.loading ? "checking…" : "default"))
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

/** The sample sized to its content (no blank rows above the prompt), cut to `room` rows only when it cannot fit. */
function previewLines(input: OnboardingInput, width: number, room: number, glyphs: Glyphs, row: OnboardingRow): Line[] {
  const model = modelOf(input.detected, input.state)
  const look = sampleLook(input.state.style)
  const base = { tier: previewTier(input.state.tier), permission: input.state.permission, model: model?.id ?? "your model", width, glyphs, now: input.now, pad: false, ...(look ? { look } : {}), ...(input.chatWidth ? { chatWidth: input.chatWidth } : {}) }
  const whole = onboardingSample({ ...base, height: 1000 })
  if (whole.length <= room) return whole
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
  const subtitle = firstFit(input.firstRun
    ? ["welcome · all optional · nothing is saved until you start chatting", "all optional · nothing is saved until you start chatting", "all optional · saved when you start"]
    : ["nothing is saved until you start chatting", "saved when you start chatting"], inner)
  const hintRoom = inner - "Setup".length - 2
  const importRow = detected?.importRow
  if (state.picker && importRow) {
    const hints = firstFit(["↑↓ move · space toggle · a all · n none · enter done · esc back", "space toggle · a/n all/none · enter done · esc back", "space toggle · enter done · esc back"], hintRoom)
    const body = renderImportPicker({ row: importRow, picker: state.picker, width: Math.min(inner, 110), height: room, glyphs })
    return appearancePage({ title: "Setup", subtitle, hints, body, width, height })
  }
  const keyed = width < PREVIEW_KEY_WIDTH || width < 72 && height < STACKED_PREVIEW_HEIGHT
  const hints = firstFit(state.preview && keyed
    ? ["←→ change · p choices · esc back", "p choices · esc back"]
    : !usable
      ? ["r check again · enter continue anyway · esc keep defaults", "r recheck · enter go on · esc skip", "r recheck · esc skip"]
      : row === "import"
        ? ["↑↓ row · ←→ nothing/all · enter pick · esc keep defaults", "↑↓ row · enter pick · esc skip", "enter pick · esc skip"]
        : keyed
          ? ["↑↓ ←→ change · p preview · esc skip", "p preview · esc skip"]
          : ["↑↓ row · ←→ change · enter start chatting · esc keep defaults", "↑↓ ←→ change · enter start · esc skip"], hintRoom)
  const foot = (text: string): Line[] => [[{ text, fg: "muted", dim: true }]]
  let body: Line[]
  if (width >= 72) {
    const leftWidth = Math.max(34, Math.min(56, Math.floor(inner * 0.42)))
    const rightWidth = Math.min(110, inner - leftWidth - 1)
    const readyBody = readyLines(input, leftWidth)
    const readyHeight = Math.min(readyBody.length + 2, Math.max(4, Math.floor(room * 0.4)))
    const action = actionLines(input, leftWidth, row, glyphs)
    const choose = chooseLines(input, leftWidth, glyphs)
    // Ready, a gap, Choose, a gap and the Enter line, over the one-line foot: the Enter line stays put while Choose scrolls.
    const chooseHeight = Math.min(choose.lines.length + 2, Math.max(6, room - readyHeight - action.length - 3))
    const left = [...panelGrid({ width: leftWidth, compact: true, maxColumns: 1, padding: false, gap: 1, rows: [
      [{ title: "Ready", body: readyBody.slice(0, readyHeight - 2) }],
      [{ title: "Choose", body: focusedWindow(choose.lines, choose.focus, chooseHeight - 2) }],
    ], heights: [readyHeight, chooseHeight] }), [], ...action]
    const sample = previewLines(input, rightWidth, Math.max(2, room - 3), glyphs, row)
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
    // Stacked: the ready list folds into two lines; where the preview is a key away, Choose takes its room.
    const readyBody = readySummary(input, inner)
    const readyHeight = readyBody.length + 2
    const action = actionLines(input, inner, row, glyphs)
    const choose = chooseLines(input, inner, glyphs)
    const previewRoom = keyed ? 0 : 8
    const chooseHeight = Math.max(4, Math.min(choose.lines.length + 2, room - readyHeight - action.length - previewRoom))
    const top = panelGrid({ width: inner, compact: true, maxColumns: 1, gap: 0, rows: [
      [{ title: "Ready", body: readyBody }],
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
  const out = ["Setup. Enter starts chatting with the choices below. Escape keeps working defaults. Nothing is written until you start chatting."]
  for (const item of detected?.items ?? []) out.push(`${item.ok ? "Found" : "Missing"}: ${item.label}, ${item.detail}${!item.ok && item.fix ? `. To fix: ${item.fix}` : ""}.`)
  const model = modelOf(detected, state)
  out.push(`Model: ${model?.label ?? "none"}${model?.recommended ? " (recommended)" : ""}. ${model?.line ?? ""}`)
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
  out.push(`Enter starts chatting: ${actionText(input, false).text.slice("enter  ".length)}.`)
  return out
}
