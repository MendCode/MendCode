import type { ModelChoice, ModelInfo, ModelsReport } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { servedBy } from "./model-page"
import { modelOptions, type ModelOption } from "./model-picker"
import { modelParts } from "./model-label"
import type { ModelPrefs } from "./model-prefs"
import { truncateEnd } from "./session-list"
import { textWidth } from "./wrap"

/**
 * The quick model switch: a small card over the chat, anchored above the prompt, for the common case of changing this
 * session's model without a page. The list is `modelOptions` (favorites, recents, then the catalog by provider; a typed filter
 * ranks the matches), the same code the pages use. `picks` holds the effort (or variant) chosen in place for a model, by id,
 * until the card closes; a model without a pick starts with its saved default, the session's own effort, or its catalog default.
 */
export type ModelQuickState = { query: string; selected: number; picks: Record<string, string> }
export type ModelQuickCard = { rows: Line[]; top: number; left: number; cursor: { row: number; col: number } }

export const createModelQuickState = (): ModelQuickState => ({ query: "", selected: 0, picks: {} })

const CARD: ColorName = "panel"
const PADDING = 2
const MAX_WIDTH = 84
const MIN_WIDTH = 40
const MAX_LIST_ROWS = 14
const MIN_BOTTOM = 7
const AIRY_BOTTOM = 24
/** A card this close to the width of the screen fills it: a margin of two cells would only leave stray ends of the transcript beside it. */
const FULL_WIDTH_BELOW = MAX_WIDTH + 6
const PLACEHOLDER = "filter models…"

/** Hints in the order they read; when the card is narrow the ones with the lowest `keep` go first. */
const HINTS: ReadonlyArray<{ key: string; text: string; keep: number }> = [
  { key: "enter", text: "switch", keep: 4 },
  { key: "←→", text: "effort", keep: 2 },
  { key: "ctrl+f", text: "fav", keep: 1 },
  { key: "tab", text: "roles & defaults", keep: 5 },
  { key: "esc", text: "", keep: 3 },
]

/** The names ←→ cycles through for a model: its provider variants when it has any, else its efforts. */
export function quickChoices(model: ModelInfo): { kind: "variant" | "effort"; names: string[] } {
  const variants = Object.keys(model.variants ?? {})
  return variants.length ? { kind: "variant", names: variants } : { kind: "effort", names: [...model.efforts] }
}

/** What the model would start with: the pick, else its saved default, else the session's own choice when it is the current model, else the catalog default. */
export function quickValue(input: { model: ModelInfo; state: ModelQuickState; report: ModelsReport | undefined; prefs: ModelPrefs }): string | undefined {
  const { model, state, report, prefs } = input
  const { kind, names } = quickChoices(model)
  if (!names.length) return undefined
  const picked = state.picks[model.id]
  if (picked && names.includes(picked)) return picked
  const saved = prefs.defaults?.[model.id]
  const own = kind === "variant" ? saved?.variant : saved?.effort
  if (own && names.includes(own)) return own
  const current = report?.effective
  if (current?.model === model.id) {
    const value = kind === "variant" ? current.variant : current.effort
    if (value && names.includes(value)) return value
  }
  return kind === "effort" ? model.defaultEffort : undefined
}

/** The next (or previous) effort or variant for the highlighted model; the same state when it has none to choose from. */
export function stepQuickValue(input: { state: ModelQuickState; model: ModelInfo; report: ModelsReport | undefined; prefs: ModelPrefs; direction: 1 | -1 }): ModelQuickState {
  const { state, model, direction } = input
  const { names } = quickChoices(model)
  if (names.length < 2) return state
  const at = names.indexOf(quickValue(input) ?? "")
  const next = names[(at < 0 ? (direction === 1 ? 0 : names.length - 1) : (at + direction + names.length) % names.length)]!
  return { ...state, picks: { ...state.picks, [model.id]: next } }
}

/** The choice Enter sends for a model: the in-place pick when there is one, else the model with its saved default. */
export function quickChoice(input: { model: ModelInfo; state: ModelQuickState; withDefault: (choice: ModelChoice) => ModelChoice }): ModelChoice {
  const { model, state } = input
  const picked = state.picks[model.id]
  if (!picked) return input.withDefault({ model: model.id })
  return quickChoices(model).kind === "variant" ? { model: model.id, variant: picked } : { model: model.id, effort: picked as NonNullable<ModelChoice["effort"]> }
}

type Entry = { type: "heading"; text: string } | { type: "gap" } | { type: "match"; index: number }

/** The list with a heading before each group (favorites, recent, a provider) while nothing is typed; a filter is one ranked list. */
function entriesOf(options: readonly ModelOption[], grouped: boolean): Entry[] {
  const entries: Entry[] = []
  let category: string | undefined
  options.forEach((option, index) => {
    if (grouped && option.category !== category) {
      if (category !== undefined) entries.push({ type: "gap" })
      entries.push({ type: "heading", text: option.category })
      category = option.category
    }
    entries.push({ type: "match", index })
  })
  return entries
}

const width = (spans: readonly Span[]) => spans.reduce((sum, span) => sum + textWidth(span.text), 0)

/** The hint line: every hint that fits, dropping the least useful ones first. */
function hintSpans(room: number): Span[] {
  const shown = [...HINTS]
  const build = (items: typeof shown): Span[] => items.flatMap((hint, index): Span[] => [...(index ? [{ text: " · ", fg: "muted" as const }] : []), { text: hint.key, fg: "text", bold: true }, ...(hint.text ? [{ text: ` ${hint.text}`, fg: "muted" as const }] : [])])
  while (shown.length > 2 && width(build(shown)) > room) shown.splice(shown.indexOf([...shown].sort((a, b) => a.keep - b.keep)[0]!), 1)
  return build(shown)
}

/**
 * The card, its bottom edge at `bottom` (the row above the prompt). Rows are exactly the card's width. `error` replaces the hint
 * line; without a catalog the list says it is loading, and an engine that chooses its own model says so instead of a list.
 */
export function renderModelQuick(input: { state: ModelQuickState; report: ModelsReport | undefined; prefs: ModelPrefs; width: number; bottom: number; error?: string; glyphs?: Glyphs }): ModelQuickCard | undefined {
  const { state, report, prefs } = input
  const cardWidth = input.width <= FULL_WIDTH_BELOW ? input.width : Math.min(MAX_WIDTH, input.width - 4)
  if (cardWidth < MIN_WIDTH || input.bottom < MIN_BOTTOM) return undefined
  const glyphs = input.glyphs ?? defaultGlyphs()
  const inner = cardWidth - PADDING * 2
  const options = report?.selectable === false ? [] : modelOptions(report, prefs, { query: state.query })
  const selected = Math.max(0, Math.min(state.selected, options.length - 1))
  const airy = input.bottom >= AIRY_BOTTOM
  const fixed = airy ? 8 : 3
  const entries = entriesOf(options, !state.query.trim())
  // A small list, not a page: about 60% of the room above the prompt, at most MAX_LIST_ROWS lines.
  const listRows = Math.max(1, Math.min(MAX_LIST_ROWS, Math.max(5, Math.floor(input.bottom * 0.6)), input.bottom - fixed, Math.max(1, entries.length)))
  const selectedEntry = Math.max(0, entries.findIndex((entry) => entry.type === "match" && entry.index === selected))
  const first = Math.min(Math.max(0, selectedEntry - listRows + 1), Math.max(0, entries.length - listRows))

  const painted = (spans: Span[]): Line => spans.map((span) => ({ ...span, bg: span.bg ?? CARD }))
  const pad = (spans: Span[], to: number): Span[] => (width(spans) < to ? [...spans, { text: " ".repeat(to - width(spans)) }] : spans)
  const line = (spans: Span[]): Line => painted([{ text: " ".repeat(PADDING) }, ...pad(spans, inner), { text: " ".repeat(PADDING) }])
  const blank = (): Line => painted([{ text: " ".repeat(cardWidth) }])
  const spread = (left: Span[], right: Span[]): Span[] => [...left, { text: " ".repeat(Math.max(1, inner - width(left) - width(right))) }, ...right]

  const count = options.length ? `${selected + 1}/${options.length}` : ""
  const queryRoom = Math.max(1, inner - textWidth(count) - 2)
  const queryText = truncateEnd(state.query, queryRoom)
  const title = line(spread([{ text: "Model", fg: "text", bold: true }, { text: "  this session", fg: "muted" }], [{ text: "esc", fg: "muted" }]))
  const search = line(spread(state.query ? [{ text: queryText, fg: "text" }] : [{ text: truncateEnd(PLACEHOLDER, queryRoom), fg: "muted" }], count ? [{ text: count, fg: "muted" }] : []))
  const rows: Line[] = [...(airy ? [blank()] : []), title, ...(airy ? [blank()] : []), search, ...(airy ? [blank()] : [])]
  const searchRow = rows.length - 1 - (airy ? 1 : 0)

  if (options.length === 0) {
    const note = report?.selectable === false ? `${report.engine} engine chooses its own model` : !report ? "Loading models…" : state.query ? "No matching models" : "No models available"
    rows.push(line([{ text: note, fg: "muted" }]))
  }
  const visible = entries.slice(first, first + listRows)
  // A window never ends on the gap before a group it cannot show.
  if (visible.at(-1)?.type === "gap") visible.pop()
  for (const [position, entry] of visible.entries()) {
    if (entry.type === "gap") {
      if (position > 0) rows.push(blank())
      continue
    }
    if (entry.type === "heading") {
      rows.push(line([{ text: entry.text, fg: "accent", bold: true }]))
      continue
    }
    const { model } = options[entry.index]!
    const on = entry.index === selected
    const { label } = modelParts(model.id, report)
    const current = report?.effective?.model === model.id
    const value = quickValue({ model, state, report, prefs })
    const adjustable = quickChoices(model).names.length > 1
    const effort = on && adjustable ? `‹ ${value ?? "default"} ›` : value
    const hint = [servedBy(model), effort ?? ""].filter(Boolean).join(" · ")
    const star = prefs.favorites.includes(model.id) ? "* " : ""
    const room = inner - 2 - textWidth(hint) - 2
    const labelText = truncateEnd(`${star}${label}`, Math.max(4, room))
    const idRoom = room - textWidth(labelText) - 2
    const idText = model.id !== label && idRoom >= 8 ? `  ${truncateEnd(model.id, idRoom)}` : ""
    const fg = (muted: boolean): ColorName => (on ? "background" : muted ? "muted" : "text")
    const body: Span[] = [{ text: labelText, fg: fg(false), bold: on || current }, ...(idText ? [{ text: idText, fg: fg(true) }] : [])]
    const bar: ColorName | undefined = on ? "primary" : undefined
    const left: Span[] = [{ text: current ? glyphs.dot : " ", fg: on ? "background" : "primary" }, { text: " " }, ...body]
    const spans = pad(spread(left, [{ text: hint, fg: fg(true) }]), inner)
    rows.push([{ text: " ".repeat(PADDING - 1) }, { text: " " }, ...spans, { text: " ".repeat(PADDING) }].map((span): Span => ({ ...span, bg: bar ?? CARD })))
  }
  rows.push(...(airy ? [blank()] : []), line(input.error ? [{ text: truncateEnd(input.error, inner), fg: "error" }] : hintSpans(inner)), ...(airy ? [blank()] : []))

  const top = Math.max(0, input.bottom - rows.length)
  const left = Math.max(0, Math.floor((input.width - cardWidth) / 2))
  return { rows, top, left, cursor: { row: top + searchRow, col: left + PADDING + (state.query ? Math.min(textWidth(state.query), textWidth(queryText)) : 0) } }
}
