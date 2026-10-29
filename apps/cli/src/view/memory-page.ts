import type { DreamRun, EvolutionMode, MemoryCategoryInfo, MemoryEntry, MemoryGraphReport, MemoryKind, MemoryScope } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { isWide } from "../ui/breakpoints"
import { beside, deck, deckChrome, type DeckStatus } from "./deck"
import { createDreamTabState, dreamTabHints, dreamTabKey, renderDreamTab, type DreamTabState } from "./dream-tab"
import { createEvolutionState, EVOLUTION_HINTS, evolutionKey, renderEvolutionTab, type EvolutionData, type EvolutionTabState } from "./memory-evolution"
import { createMemoryGraphState, MEMORY_GRAPH_HINTS, memoryGraphKey, memoryGraphMetrics, renderMemoryGraph, type MemoryGraphState } from "./memory-graph-view"
import { createPoliciesState, POLICIES_HINTS, policiesKey, renderPoliciesTab, type MemoryPolicy, type PoliciesState } from "./memory-policies"
import { extractionKey, renderExtraction, EXTRACTION_HINTS, type ExtractionData, type ExtractionState, type ExtractionAction } from "./memory-extraction-tab"
import { sharingKey, renderSharing, SHARING_HINTS, type SharingData, type SharingState, type SharingAction } from "./memory-sharing-tab"
import { renderWorkspacePicker, workspaceOptions, type WorkspaceSelection } from "./memory-workspaces"
import { pickerFrame } from "./picker-frame"
import { panelGrid, columns } from "./deck"
import type { MemoryWorkspacesReport } from "@mendcode/protocol"
import { appearancePage } from "./appearance-layout"
import { section, tabsRow, type PageTab } from "./page"
import { relativeTime, shortenMiddle, truncateEnd } from "./session-list"
import { lineWidth, textWidth, wrap } from "./wrap"

export type MemoryTab = "pending" | "saved" | "archived"
/** The list tabs, Dream (its schedule and runs), Graph (saved memories and their links), Policies (per category) and Evolution (its mode and suggestions). */
export type MemoryPageTab = MemoryTab | "dream" | "graph" | "policies" | "evolution" | "extraction" | "sharing"

/** A picker opened over a list tab: where to move the memory (`scope`) or which category to give it. */
export type MemoryPick = { kind: "scope" | "category"; index: number }

export type MemoryPageState = {
  tab: MemoryPageTab
  /** Index into the visible (tab + filter) list. */
  selected: number
  filter: string
  /** True while typed characters extend the filter instead of acting as commands. */
  filtering: boolean
  /** Index of the first visible entry; the renderer moves it further when the selection would be off screen. */
  scroll: number
  confirmDelete: boolean
  pick?: MemoryPick
  workspace: WorkspaceSelection
  sharing: SharingState
  extraction: ExtractionState
  dream: DreamTabState
  graph: MemoryGraphState
  policies: PoliciesState
  evolution: EvolutionTabState
}

/** What the page needs besides the memories, loaded by the app: the category policies, Evolution's suggestions and two settings. */
export type MemoryPageData = {
  workspaces?: MemoryWorkspacesReport | undefined
  sharing?: SharingData | undefined
  currentDirectory?: string | undefined
  omitted?: number | undefined
  extraction?: ExtractionData | undefined
  categories?: MemoryCategoryInfo[] | undefined
  evolution?: EvolutionData | undefined
  /** The `evolution` setting in effect (`off` when unset). */
  evolutionMode?: EvolutionMode | undefined
  evolutionSize?: { width: number; height: number } | undefined
  /** The `dreamMaxTokens` setting; undefined = the default. */
  dreamMaxTokens?: number | undefined
  /** Rows the page body has, so a scrolling report stops at its end. */
  bodyRoom?: number | undefined
}

export type MemoryPageAction = SharingAction | ExtractionAction
  | { type: "browseMemory" }
  | { type: "none" }
  | { type: "close" }
  | { type: "approve"; memoryId: string }
  | { type: "reject"; memoryId: string }
  | { type: "restore"; memoryId: string }
  | { type: "delete"; memoryId: string }
  | { type: "edit"; memoryId: string; text: string }
  | { type: "pin"; memoryId: string; pinned: boolean }
  | { type: "scope"; memoryId: string; scope: MemoryScope }
  | { type: "category"; memoryId: string; category: string }
  | { type: "link"; from: string; to: string }
  | { type: "unlink"; from: string; to: string }
  | { type: "notice"; text: string }
  | { type: "dream" }
  | { type: "dreamBudget"; tokens: number | null }
  | { type: "policy"; category: MemoryCategoryInfo["id"]; policy: MemoryPolicy }
  | { type: "evolutionMode"; mode: EvolutionMode }
  | { type: "suggestion"; suggestionId: number; decision: "accept" | "reject"; expectedHash?: string }
  | { type: "evolutionWorkflows"; enabled: boolean }
  | { type: "evolutionPromote"; suggestionId: number; expectedHash: string; policyRevision: string }
  | { type: "evolutionRollback"; suggestionId: number; expectedHash: string; expectedRevision: number }

const TABS: MemoryTab[] = ["pending", "saved", "archived"]
const PAGE_TAB_ORDER: MemoryPageTab[] = [...TABS, "dream", "graph", "policies", "evolution", "extraction", "sharing"]
const MAX_TEXT_LINES = 3
const MAX_DIFF_SIDE_LINES = 2
const DEFAULT_VISIBLE_ROWS = 3
const NONE: MemoryPageAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e"])

const PICK_HINTS = "↑↓ choose · 1-9 pick · enter set · esc cancel"
const HINTS: Record<MemoryPageTab, string> = {
  pending: "a approve · x reject · e edit · c category · d delete · / filter · w projects · tab/1-9 tabs · esc back",
  saved: "p pin · x archive · e edit · c category · s scope · d delete · / filter · w projects · tab/1-9 tabs · esc back",
  archived: "r restore · e edit · c category · d delete · / filter · w projects · tab/1-9 tabs · esc back",
  dream: dreamTabHints({ selected: 0 }),
  graph: MEMORY_GRAPH_HINTS,
  policies: POLICIES_HINTS,
  evolution: EVOLUTION_HINTS,
  extraction: EXTRACTION_HINTS,
  sharing: SHARING_HINTS,
}
const TAB_LABELS: Record<MemoryPageTab, { label: string; short: string }> = {
  pending: { label: "Pending", short: "Pend" },
  saved: { label: "Saved", short: "Saved" },
  archived: { label: "Archived", short: "Arch" },
  dream: { label: "Dream", short: "Dream" },
  graph: { label: "Graph", short: "Graph" },
  policies: { label: "Policies", short: "Pol" },
  evolution: { label: "Evolution", short: "Evo" },
  extraction: { label: "Extraction", short: "Ext" },
  sharing: { label: "Sharing", short: "Share" },
}
const PAGE_TABS: PageTab[] = PAGE_TAB_ORDER.map((tab, index) => ({ key: String(index + 1), ...TAB_LABELS[tab] }))
const SCOPE_CHOICES: ReadonlyArray<{ id: MemoryScope; note: string }> = [
  { id: "user", note: "every project of your profile" },
  { id: "project", note: "this project only" },
  { id: "session", note: "this session only" },
]
const TAB_KEY = new RegExp(`^[1-${PAGE_TAB_ORDER.length}]$`)
const GUTTER = 4

export function createMemoryPageState(): MemoryPageState {
  return { tab: "pending", selected: 0, filter: "", filtering: false, scroll: 0, confirmDelete: false, workspace: { view: "project" }, sharing: { scope: "project", scroll: 0 }, extraction: { selected: 0 }, dream: createDreamTabState(), graph: createMemoryGraphState(), policies: createPoliciesState(), evolution: createEvolutionState() }
}

/** The Graph tab's canvas for a page of this size; key handling needs it to move the selection on the same layout the render draws. */
export function memoryGraphCanvas(width: number, height: number, workspaceGrid = false) {
  if (workspaceGrid) return memoryGraphMetrics({ width: Math.max(1, width - 4), height: Math.max(0, height - 7) }).canvas
  return memoryGraphMetrics({ width: Math.max(1, width - 2), height: Math.max(0, height - deckChrome(HINTS.graph, width, { tabs: true })) }).canvas
}

/** Rows the body of `tab` has on a page of this size (what a scrolling tab may show at once). */
export function memoryBodyRoom(tab: MemoryPageTab, width: number, height: number) {
  return Math.max(0, height - deckChrome(HINTS[tab], width, { tabs: true }))
}

function nextTab(tab: MemoryPageTab, step: number): MemoryPageTab {
  return PAGE_TAB_ORDER[(PAGE_TAB_ORDER.indexOf(tab) + step + PAGE_TAB_ORDER.length) % PAGE_TAB_ORDER.length]!
}

const withoutPick = ({ pick: _pick, ...rest }: MemoryPageState): MemoryPageState => rest

function tabSwitch(state: MemoryPageState, key: string): { state: MemoryPageState; action: MemoryPageAction } | undefined {
  const to = key === "\t" ? nextTab(state.tab, 1) : key === "\x1b[Z" ? nextTab(state.tab, -1) : TAB_KEY.test(key) ? PAGE_TAB_ORDER[Number(key) - 1]! : undefined
  if (to === undefined) return undefined
  return to === state.tab ? { state, action: NONE } : { state: { ...withoutPick(state), tab: to, selected: 0, scroll: 0, confirmDelete: false }, action: NONE }
}

function dreamKey(state: MemoryPageState, key: string, runs: DreamRun[] | undefined, data: MemoryPageData | undefined): { state: MemoryPageState; action: MemoryPageAction } {
  // Typing the token budget: digits are characters, not tab numbers.
  const switched = state.dream.typing === undefined ? tabSwitch(state, key) : undefined
  if (switched) return switched
  const result = dreamTabKey(state.dream, key, runs, data?.bodyRoom !== undefined ? { room: Math.max(0, data.bodyRoom - 2) } : {})
  const next = result.state === state.dream ? state : { ...state, dream: result.state }
  if (result.action.type === "close") return { state: next, action: result.action }
  if (result.action.type === "run") return { state: next, action: { type: "dream" } }
  if (result.action.type === "budget") return { state: next, action: { type: "dreamBudget", tokens: result.action.tokens } }
  if (result.action.type === "review") return { state: { ...next, tab: "pending", selected: 0, scroll: 0 }, action: NONE }
  return { state: next, action: NONE }
}

function policiesTabKey(state: MemoryPageState, key: string, data: MemoryPageData | undefined): { state: MemoryPageState; action: MemoryPageAction } {
  const switched = tabSwitch(state, key)
  if (switched) return switched
  const result = policiesKey(state.policies, key, data?.categories)
  const next = result.state === state.policies ? state : { ...state, policies: result.state }
  if (result.action.type === "close" || result.action.type === "policy") return { state: next, action: result.action }
  return { state: next, action: NONE }
}

function evolutionTabKey(state: MemoryPageState, key: string, data: MemoryPageData | undefined): { state: MemoryPageState; action: MemoryPageAction } {
  const switched = tabSwitch(state, key)
  if (switched) return switched
  const result = evolutionKey(state.evolution, key, { mode: data?.evolutionMode ?? "off", suggestions: data?.evolution?.suggestions, workflows: data?.evolution?.workflows, policyRevision: data?.evolution?.policyRevision, size: data?.evolutionSize, error: data?.evolution?.error })
  const next = result.state === state.evolution ? state : { ...state, evolution: result.state }
  if (result.action.type === "close" || result.action.type === "suggestion" || result.action.type === "evolutionWorkflows" || result.action.type === "evolutionPromote" || result.action.type === "evolutionRollback") return { state: next, action: result.action }
  if (result.action.type === "mode") return { state: next, action: { type: "evolutionMode", mode: result.action.mode } }
  return { state: next, action: NONE }
}

function graphTabKey(state: MemoryPageState, key: string, graph: { report?: MemoryGraphReport | undefined; size: { width: number; height: number } } | undefined): { state: MemoryPageState; action: MemoryPageAction } {
  const switched = tabSwitch(state, key)
  if (switched) return switched
  if (!graph?.report) return key === "\x1b" ? { state, action: { type: "close" } } : { state, action: NONE }
  const result = memoryGraphKey(state.graph, key, graph.report, graph.size)
  const next = result.state === state.graph ? state : { ...state, graph: result.state }
  const { action } = result
  if (action.type === "close") return { state: next, action }
  if (action.type === "unlink") return { state: next, action }
  if (action.type === "link") return { state: next, action: action.to ? { type: "link", from: action.from, to: action.to } : { type: "notice", text: "mark a memory with m, then press c on another" } }
  return { state: next, action: NONE }
}

/** Entries of one tab, newest update first, narrowed by a case-insensitive text/category filter (all terms must match). */
export function visibleMemories(memories: MemoryEntry[], tab: MemoryTab, filter: string): MemoryEntry[] {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean)
  return memories
    .filter((memory) => memory.status === tab)
    .filter((memory) => {
      const haystack = `${memory.directory ?? ""}\n${memory.source}\n${memory.text}\n${memory.category}\n${memory.reason ?? ""}\n${memory.kind ?? ""}\n${memory.scope}${memory.pinned ? " pinned" : ""}`.toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.memoryId.localeCompare(b.memoryId))
}

function isPrintable(key: string) {
  if (key.length === 0) return false
  for (const char of key) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) return false
  }
  return true
}

const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))

/**
 * Handles one raw key. Returns the same state object when nothing changed. `visibleRows` is how many
 * entries the app expects on screen, used to keep the selection in view (the renderer corrects the rest).
 */
export function memoryPageKey(
  state: MemoryPageState,
  key: string,
  memories: MemoryEntry[],
  visibleRows = DEFAULT_VISIBLE_ROWS,
  graph?: { report?: MemoryGraphReport | undefined; size: { width: number; height: number } },
  dreamRuns?: DreamRun[],
  data?: MemoryPageData,
): { state: MemoryPageState; action: MemoryPageAction } {
  const options = workspaceOptions(data?.workspaces, data?.currentDirectory)
  if (state.workspace.picking !== undefined) {
    const index = Math.max(0, Math.min(state.workspace.picking, options.length - 1))
    const { picking: _picking, ...closed } = state.workspace
    if (key === "\x1b") return { state: { ...state, workspace: closed }, action: NONE }
    if (key === "\r" || key === "\n") {
      const option = options[index]!
      return { state: { ...state, workspace: { view: option.view, ...("root" in option && option.root ? { root: option.root } : {}) }, selected: 0, scroll: 0, filter: "", filtering: false, graph: createMemoryGraphState() }, action: { type: "browseMemory" } }
    }
    const delta = UP.has(key) || key === "k" ? -1 : DOWN.has(key) || key === "j" ? 1 : 0
    return { state: { ...state, workspace: { ...state.workspace, picking: Math.max(0, Math.min(index + delta, options.length - 1)) } }, action: NONE }
  }
  const typing = state.filtering || state.pick || state.confirmDelete || state.dream.typing !== undefined || state.extraction.editing !== undefined || state.sharing.confirmation !== undefined || state.sharing.busy
  if (key === "w" && !typing) return { state: { ...state, workspace: { ...state.workspace, picking: Math.max(0, options.findIndex((option) => option.view === state.workspace.view && (option.view !== "project" || ("root" in option && option.root === (state.workspace.root ?? data?.currentDirectory))))) } }, action: NONE }
  if (state.tab === "sharing") {
    const switched = state.sharing.confirmation === undefined && !state.sharing.busy ? tabSwitch(state, key) : undefined
    if (switched) return switched
    const result = sharingKey(state.sharing, key)
    return { state: { ...state, sharing: result.state }, action: result.action }
  }
  if (state.tab === "extraction") {
    const switched = state.extraction.editing === undefined ? tabSwitch(state, key) : undefined
    if (switched) return switched
    if (key === "\x1b" && state.extraction.editing === undefined) return { state, action: { type: "close" } }
    const result = extractionKey(state.extraction, key, data?.extraction ?? {})
    return { state: { ...state, extraction: result.state }, action: result.action }
  }
  if (state.tab === "graph") return graphTabKey(state, key, graph)
  if (state.tab === "dream") return dreamKey(state, key, dreamRuns, data)
  if (state.tab === "policies") return policiesTabKey(state, key, data)
  if (state.tab === "evolution") return evolutionTabKey(state, key, data)
  const tab = state.tab
  const visible = visibleMemories(memories, tab, state.filter)
  const selected = clamp(state.selected, visible.length)
  const target = visible[selected]
  const stay = (next: Partial<MemoryPageState>, action: MemoryPageAction = NONE) => ({ state: { ...state, ...next }, action })
  const go = (index: number) => {
    const next = clamp(index, visible.length)
    if (next === state.selected) return { state, action: NONE }
    const scroll = next < state.scroll ? next : next >= state.scroll + visibleRows ? next - visibleRows + 1 : state.scroll
    return stay({ selected: next, scroll })
  }
  const switchTab = (to: MemoryPageTab) => (to === tab ? { state, action: NONE } : { state: { ...withoutPick(state), tab: to, selected: 0, scroll: 0, confirmDelete: false }, action: NONE })
  const refilter = (filter: string, filtering = state.filtering) => stay({ filter, filtering, selected: 0, scroll: 0 })

  if (state.pick) {
    const options = pickOptions(state.pick.kind, data?.categories)
    const close = (action: MemoryPageAction = NONE) => ({ state: withoutPick(state), action })
    const choose = (index: number): { state: MemoryPageState; action: MemoryPageAction } => {
      const option = options[index]
      if (!option || !target) return close()
      if (state.pick!.kind === "scope") return option.id === target.scope ? close({ type: "notice", text: `already in ${option.id} scope` }) : close({ type: "scope", memoryId: target.memoryId, scope: option.id as MemoryScope })
      return option.id === target.category ? close({ type: "notice", text: `already in ${option.id}` }) : close({ type: "category", memoryId: target.memoryId, category: option.id })
    }
    const move = (to: number) => ({ state: { ...state, pick: { kind: state.pick!.kind, index: clamp(to, options.length) } }, action: NONE })
    if (key === "\x1b") return close()
    if (UP.has(key) || key === "k") return move(state.pick.index - 1)
    if (DOWN.has(key) || key === "j") return move(state.pick.index + 1)
    if (key === "\r" || key === "\n") return choose(state.pick.index)
    if (/^[1-9]$/.test(key)) return choose(Number(key) - 1)
    return { state, action: NONE }
  }

  if (state.confirmDelete) {
    if ((key === "d" || key === "y") && target) return stay({ confirmDelete: false }, { type: "delete", memoryId: target.memoryId })
    return stay({ confirmDelete: false })
  }
  if (key === "\x1b") {
    if (state.filter || state.filtering) return stay({ filter: "", filtering: false, selected: 0, scroll: 0 })
    return { state, action: { type: "close" } }
  }
  if (key === "\t") return switchTab(nextTab(tab, 1))
  if (key === "\x1b[Z") return switchTab(nextTab(tab, -1))
  if (UP.has(key)) return go(selected - 1)
  if (DOWN.has(key)) return go(selected + 1)
  if (key === "\x7f" || key === "\b") return state.filter ? refilter(Array.from(state.filter).slice(0, -1).join("")) : { state, action: NONE }
  if (state.filtering) {
    if (key === "\r" || key === "\n") return stay({ filtering: false })
    return isPrintable(key) ? refilter(state.filter + key) : { state, action: NONE }
  }

  switch (key) {
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
    case "6":
    case "7":
    case "8":
    case "9":
      return switchTab(PAGE_TAB_ORDER[Number(key) - 1]!)
    case "k":
      return go(selected - 1)
    case "j":
      return go(selected + 1)
    case "/":
      return stay({ filtering: true })
    case "a":
      return tab === "pending" && target ? { state, action: { type: "approve", memoryId: target.memoryId } } : { state, action: NONE }
    case "x":
      return tab !== "archived" && target ? { state, action: { type: "reject", memoryId: target.memoryId } } : { state, action: NONE }
    case "r":
      return tab === "archived" && target ? { state, action: { type: "restore", memoryId: target.memoryId } } : { state, action: NONE }
    case "e":
      return target && target.kind !== "archive" ? { state, action: { type: "edit", memoryId: target.memoryId, text: target.text } } : { state, action: NONE }
    case "d":
      return target ? stay({ confirmDelete: true }) : { state, action: NONE }
    case "p":
      if (!target) return { state, action: NONE }
      return tab === "saved" ? { state, action: { type: "pin", memoryId: target.memoryId, pinned: target.pinned !== true } } : { state, action: { type: "notice", text: "only saved memories can be pinned" } }
    case "s":
      if (!target) return { state, action: NONE }
      if (tab !== "saved") return { state, action: { type: "notice", text: tab === "pending" ? "approve it first to change its scope" : "restore it first to change its scope" } }
      return stay({ pick: { kind: "scope", index: Math.max(0, SCOPE_CHOICES.findIndex((choice) => choice.id === target.scope)) } })
    case "c": {
      if (!target) return { state, action: NONE }
      if (!data?.categories) return { state, action: { type: "notice", text: "categories are still loading" } }
      return stay({ pick: { kind: "category", index: Math.max(0, data.categories.findIndex((category) => category.id === target.category)) } })
    }
  }
  return isPrintable(key) ? refilter(key, true) : { state, action: NONE }
}

function pickOptions(kind: MemoryPick["kind"], categories: MemoryCategoryInfo[] | undefined): Array<{ id: string; note: string }> {
  return kind === "scope" ? SCOPE_CHOICES.map((choice) => ({ ...choice })) : (categories ?? []).map((category) => ({ id: category.id, note: category.description }))
}

/** The scope (and pin) of an entry as row spans: `user`, `project`, `session`, then `pinned` for a pinned saved memory. */
function scopeSpans(memory: MemoryEntry): Span[] {
  const scope: Span = memory.scope === "project" ? { text: "project", fg: "heading" } : memory.scope === "session" ? { text: "session", fg: "accent" } : { text: "user", fg: "link" }
  return memory.pinned ? [scope, { text: " · ", fg: "muted" }, { text: "pinned", fg: "warning", bold: true }] : [scope]
}

/** The picker over a list tab: a title, one row per choice (current one marked) and the choice's note; at most `max` choices show. */
function pickRows(input: { pick: MemoryPick; target: MemoryEntry | undefined; categories: MemoryCategoryInfo[] | undefined; width: number; max: number }): Line[] {
  const { pick, target, width } = input
  const options = pickOptions(pick.kind, input.categories)
  const title = pick.kind === "scope" ? "move to scope" : "set category"
  const rows: Line[] = [clampLine([{ text: title, fg: "primary", bold: true }, ...(pick.kind === "scope" ? [{ text: " · re-creates the memory: its links are lost", fg: "muted" as const, dim: true }] : [])], width)]
  const room = Math.max(1, input.max)
  const start = Math.max(0, Math.min(pick.index - room + 1, options.length - room))
  options.slice(start, start + room).forEach((option, offset) => {
    const index = start + offset
    const chosen = index === pick.index
    const current = target !== undefined && option.id === (pick.kind === "scope" ? target.scope : target.category)
    rows.push(clampLine([{ text: chosen ? "› " : "  ", fg: "primary", bold: true }, { text: `${index + 1} `, fg: "muted" }, { text: option.id, fg: chosen ? "primary" : "body", bold: chosen }, ...(current ? [{ text: " (current)", fg: "muted" as const }] : []), { text: `  ${option.note}`, fg: "muted", dim: true }], width))
  })
  if (options.length === 0) rows.push([{ text: "  no options", fg: "muted" }])
  return rows
}

function clampLine(line: Line, width: number): Line {
  const out: Line = []
  let used = 0
  for (const span of line) {
    const w = textWidth(span.text)
    if (used + w <= width) {
      out.push(span)
      used += w
      continue
    }
    const text = truncateEnd(span.text, width - used)
    if (text) out.push({ ...span, text })
    break
  }
  return out
}

function accent(tab: MemoryTab): ColorName {
  return tab === "pending" ? "warning" : "primary"
}

function emptyText(tab: MemoryTab, filter: string): string {
  if (filter) return `no match for "${filter}"`
  return { pending: "no pending proposals", saved: "nothing saved yet · /remember <text>", archived: "nothing archived" }[tab]
}

const KIND_BADGE: Record<MemoryKind, { text: string; fg: ColorName }> = { new: { text: "new", fg: "success" }, update: { text: "update", fg: "warning" }, archive: { text: "archive", fg: "error" } }

/** Wraps `text` into at most `max` lines of `width` cells, ending the last one with an ellipsis when cut. */
function clippedLines(text: string, width: number, max: number): string[] {
  const wrapped = wrap(text.replace(/\s+/g, " ").trim(), Math.max(1, width))
  const shown = wrapped.slice(0, max)
  if (wrapped.length > max) shown[max - 1] = truncateEnd(`${shown[max - 1]}…`, width)
  return shown
}

function entryLines(input: { memory: MemoryEntry; previous?: MemoryEntry | undefined; selected: boolean; tab: MemoryTab; directory?: string | undefined; width: number; now: number; glyphs: Glyphs }): Line[] {
  const { memory, previous, selected, tab, directory, width, now, glyphs } = input
  const bodyWidth = Math.max(1, width - 2)
  const kind: MemoryKind = tab === "pending" ? (memory.kind ?? "new") : "new"
  const textStyle: Partial<Span> = selected ? { fg: "primary", bold: true } : { fg: "body" }
  const marker = (index: number): Span => (index === 0 && selected ? { text: `${glyphs.user} `, fg: accent(tab), bold: true } : { text: "  " })
  const lines: Line[] = []
  if (kind === "new") {
    clippedLines(memory.text, bodyWidth, MAX_TEXT_LINES).forEach((text, index) => lines.push([marker(index), { text, ...textStyle }]))
  } else {
    // A revision reads as a diff: what is saved now (-) and what it would become (+); an archive shows only what would be retired.
    const oldText = previous ? previous.text : kind === "archive" ? memory.text : "(the memory no longer exists)"
    const oldLines = clippedLines(oldText, bodyWidth - 2, kind === "update" ? MAX_DIFF_SIDE_LINES : MAX_TEXT_LINES)
    oldLines.forEach((text, index) => lines.push([marker(index), { text: "- ", fg: "error", bold: true }, { text, fg: previous || kind === "archive" ? "error" : "muted", dim: !selected }]))
    if (kind === "update") clippedLines(memory.text, bodyWidth - 2, MAX_DIFF_SIDE_LINES).forEach((text) => lines.push([{ text: "  " }, { text: "+ ", fg: "success", bold: true }, { text, ...(selected ? { fg: "success" as const, bold: true } : { fg: "success" as const }) }]))
    if (memory.reason) lines.push(clampLine([{ text: "  " }, { text: "why ", fg: "muted" }, { text: memory.reason.replace(/\s+/g, " "), fg: "muted", dim: true }], width))
  }

  const left: Line = [{ text: "  " }]
  if (tab === "pending") left.push({ ...KIND_BADGE[kind], bold: true }, { text: " · ", fg: "muted" })
  left.push(...scopeSpans(memory))
  if (memory.scope === "project" && memory.directory && memory.directory !== directory) {
    left.push({ text: " · ", fg: "muted" }, { text: shortenMiddle(memory.directory, Math.max(8, Math.floor(width / 3))), fg: "muted", dim: true })
  }
  if (memory.category) left.push({ text: " · ", fg: "muted" }, { text: memory.category, fg: "muted" })
  if (memory.source === "agent") left.push({ text: " · ", fg: "muted" }, { text: "agent", fg: "muted", dim: true })
  const time = relativeTime(now, memory.updatedAt)
  const room = Math.max(0, width - textWidth(time) - 1)
  const clipped = clampLine(left, room)
  const pad = Math.max(1, width - lineWidth(clipped) - textWidth(time))
  lines.push(clampLine([...clipped, { text: " ".repeat(pad) }, { text: time, fg: tab === "pending" ? "warning" : "muted" }], width))
  return lines
}

/** The right-rail counterpart of a compact entry row: the full text/diff/reason, never truncated to 3 lines. */
function detailRows(input: { active: MemoryEntry | undefined; tab: MemoryTab; byId: Map<string, MemoryEntry>; directory: string | undefined; width: number; now: number }): Line[] {
  const { active, tab, byId, directory, width, now } = input
  if (!active) return [[{ text: "no entry selected", fg: "muted", dim: true }]]
  const kind: MemoryKind = tab === "pending" ? (active.kind ?? "new") : "new"
  const rows: Line[] = []
  const meta: Line = []
  if (tab === "pending") meta.push({ ...KIND_BADGE[kind], bold: true }, { text: " · ", fg: "muted" })
  meta.push(...scopeSpans(active))
  if (active.category) meta.push({ text: " · ", fg: "muted" }, { text: active.category, fg: "muted" })
  if (active.source) meta.push({ text: " · ", fg: "muted" }, { text: active.source === "agent" ? "agent" : "manual", fg: "muted", dim: true })
  rows.push(clampLine(meta, width))
  if (active.scope === "session" && active.sessionId) rows.push(clampLine([{ text: "session ", fg: "muted" }, { text: active.sessionId, fg: "muted" }], width))
  if (active.scope !== "user" && active.directory) rows.push(clampLine([{ text: "dir ", fg: "muted" }, { text: active.directory, fg: active.directory === directory ? "body" : "muted" }], width))
  rows.push(clampLine([{ text: "updated ", fg: "muted" }, { text: relativeTime(now, active.updatedAt), fg: "muted" }], width))
  rows.push([])
  const clean = (text: string) => text.replace(/\s+/g, " ").trim()
  if (kind === "new") {
    wrap(clean(active.text), width).forEach((line) => rows.push([{ text: line, fg: "text" }]))
    if (active.details?.action) {
      rows.push([], [{ text: `Action · ${active.details.action.kind}`, fg: "primary" }])
      for (const [label, value] of Object.entries(active.details.action)) if (value !== undefined && label !== "text" && label !== "kind") wrap(`${label}: ${Array.isArray(value) ? value.join(", ") : value}`, width).forEach((line) => rows.push([{ text: line, fg: "muted" }]))
    }
    if (active.details?.evidence) {
      rows.push([], [{ text: "Evidence", fg: "primary" }])
      wrap(active.details.evidence, width).forEach((line) => rows.push([{ text: line, fg: "muted" }]))
    }
    return rows
  }
  const previous = active.targetId ? byId.get(active.targetId) : undefined
  const oldText = previous ? previous.text : kind === "archive" ? active.text : "(the memory no longer exists)"
  wrap(clean(oldText), Math.max(1, width - 2)).forEach((line) => rows.push([{ text: "- ", fg: "error", bold: true }, { text: line, fg: "error" }]))
  if (kind === "update") {
    rows.push([])
    wrap(clean(active.text), Math.max(1, width - 2)).forEach((line) => rows.push([{ text: "+ ", fg: "success", bold: true }, { text: line, fg: "success" }]))
  }
  if (active.reason) {
    rows.push([], [{ text: "why", fg: "muted" }])
    wrap(clean(active.reason), width).forEach((line) => rows.push([{ text: line, fg: "muted", dim: true }]))
  }
  return rows
}

/** Renders exactly `height` lines of at most `width` cells. */
export function renderMemoryPage(input: {
  memories: MemoryEntry[]
  state: MemoryPageState
  directory?: string
  width: number
  height: number
  now: number
  glyphs?: Glyphs
  /** The Graph tab's report; undefined while it loads. */
  graph?: MemoryGraphReport | undefined
  /** The Dream tab's recent runs (undefined while they load) and its daily time. */
  dream?: { runs: DreamRun[] | undefined; dreamAt?: string | undefined }
  /** Category policies, Evolution and the two settings; see `MemoryPageData`. */
  data?: MemoryPageData
}): Line[] {
  const { memories, state, directory, width, now } = input
  const height = Math.max(0, input.height)
  const glyphs = input.glyphs ?? defaultGlyphs()
  const hints = state.tab === "sharing" && state.sharing.confirmation !== undefined ? "enter enable · ctrl+u clear · esc cancel" : state.tab === "dream" ? `${state.dream.typing === undefined ? "t assistant · " : ""}${dreamTabHints(state.dream)}` : state.pick ? PICK_HINTS : `t assistant · ${HINTS[state.tab]}`

  if (state.workspace.picking !== undefined) return pickerFrame("Memory / Projects", "↑↓ choose · enter select · esc cancel", width, height, renderWorkspacePicker(state.workspace, input.data?.workspaces, input.data?.currentDirectory, width, Math.max(0, height - 2)), `${input.data?.workspaces?.workspaces.length ?? 0} projects${input.data?.workspaces?.omitted ? ` · ${input.data.workspaces.omitted} omitted` : ""}`)
  const activeTab = PAGE_TAB_ORDER.indexOf(state.tab)
  const byId = new Map(memories.map((m) => [m.memoryId as string, m]))
  const counts = { pending: 0, saved: 0, archived: 0 } as Record<MemoryTab, number>
  for (const tab of TABS) counts[tab] = memories.filter((m) => m.status === tab).length

  const status: DeckStatus | undefined = state.confirmDelete ? { label: "Confirm", tone: "warn" } : undefined
  const workspaceLabel = state.workspace.view === "all" ? "All projects" : state.workspace.view === "user" ? "User memories" : directory ? `dir ${shortenMiddle(directory, 42)}` : "global"
  const subtitle = ["pending", "saved", "archived", "graph", "sharing"].includes(state.tab) ? workspaceLabel : directory ? `dir ${shortenMiddle(directory, 42)}` : "global"
  const summaryRoom = width - 2 - textWidth(`Memory · ${subtitle}`) - 1 - (status ? textWidth(status.label) + 3 : 0)
  const summary = [`${counts.pending} pending · ${counts.saved} saved · ${counts.archived} archived`, `${counts.pending} pending`].find((text) => textWidth(text) <= summaryRoom) ?? ""

  const inner = Math.max(1, width - 2)
  const wide = isWide(width)
  const room = Math.max(0, height - deckChrome(hints, width, { tabs: true }))
  const gridTab = (title: string, body: (w: number, h: number) => Line[]) => pickerFrame("Memory", `${hints} · w projects · tab tabs · esc back`, width, height, [tabsRow(PAGE_TABS, activeTab, width), ...panelGrid({ width, compact: false, padding: true, heights: [Math.max(0, height - 3)], rows: [[{ title, body: (w) => body(w, Math.max(0, height - 7)) }]] })], subtitle)
  if (input.data?.workspaces && state.tab === "graph") return gridTab("Memory graph", (w, h) => renderMemoryGraph({ report: input.graph, state: state.graph, width: w, height: h }))
  if (input.data?.workspaces && state.tab === "dream") return gridTab("Dream", (w, h) => renderDreamTab({ runs: input.dream?.runs, state: state.dream, dreamAt: input.dream?.dreamAt, dreamMaxTokens: input.data?.dreamMaxTokens, pending: counts.pending, width: w, height: h, now }))
  if (input.data?.workspaces && state.tab === "policies") return gridTab("Policies", (w, h) => renderPoliciesTab({ categories: input.data?.categories, state: state.policies, width: w, height: h }))
  if (state.tab === "evolution") return pickerFrame("Memory / Evolution", `←→ mode · ${EVOLUTION_HINTS.replace(" · ←→ mode", "")}`, width, height, [tabsRow(PAGE_TABS, activeTab, width), ...renderEvolutionTab({ mode: input.data?.evolutionMode ?? "off", data: input.data?.evolution, state: state.evolution, width, height: Math.max(0, height - 3), now })], subtitle)
  if (input.data?.workspaces && state.tab === "extraction" && width < 70) return gridTab("Extraction", (w, h) => renderExtraction(input.data?.extraction ?? {}, state.extraction, w, h))
  if (input.data?.workspaces && state.tab === "extraction") return pickerFrame("Memory", `${hints} · w projects · tab tabs · esc back`, width, height, [tabsRow(PAGE_TABS, activeTab, width), ...renderExtraction(input.data?.extraction ?? {}, state.extraction, width, Math.max(0, height - 3))], subtitle)
  if (state.tab === "sharing") return pickerFrame("Memory / Sharing", hints, width, height, [tabsRow(PAGE_TABS, activeTab, width), ...renderSharing(state.sharing, input.data?.sharing ?? {}, width, Math.max(0, height - 3))], subtitle)
  if (state.tab === "extraction") {
    const columns = Math.max(1, width - 4)
    const body = [tabsRow(PAGE_TABS, activeTab, columns), [], ...renderExtraction(input.data?.extraction ?? {}, state.extraction, columns, Math.max(0, height - 4))]
    return appearancePage({ title: "Memory", subtitle: `${subtitle} · ${summary}`, body, hints, width, height })
  }
  if (state.tab === "graph") {
    const body = renderMemoryGraph({ report: input.graph, state: state.graph, width: inner, height: room })
    return deck({ page: "Memory", subtitle, summary, tabs: PAGE_TABS, activeTab, body, hints, width, height })
  }
  if (state.tab === "dream") {
    const body = renderDreamTab({ runs: input.dream?.runs, state: state.dream, dreamAt: input.dream?.dreamAt, dreamMaxTokens: input.data?.dreamMaxTokens, pending: counts.pending, width: inner, height: room, now })
    return deck({ page: "Memory", subtitle, summary, tabs: PAGE_TABS, activeTab, body, hints, width, height })
  }
  if (state.tab === "policies") {
    const body = renderPoliciesTab({ categories: input.data?.categories, state: state.policies, width: inner, height: room })
    return deck({ page: "Memory", subtitle, summary, tabs: PAGE_TABS, activeTab, body, hints, width, height })
  }
  const tab = state.tab
  const visible = visibleMemories(memories, tab, state.filter)
  const selected = clamp(state.selected, visible.length)
  const active = visible[selected]

  const gridWidths = columns(width, wide ? [3, 2] : [1])
  const listWidth = input.data?.workspaces ? Math.max(1, gridWidths[0]! - 4) : wide ? Math.min(70, Math.max(40, Math.floor(inner * 0.55))) : inner
  const detailWidth = input.data?.workspaces && wide ? Math.max(1, gridWidths[1]! - 4) : wide ? inner - listWidth - GUTTER : 0

  const headRows: Line[] = []
  if (state.filter || state.filtering) headRows.push(clampLine([{ text: `/ ${state.filter}`, fg: "text" }, ...(state.filtering ? [{ text: "▏", fg: "primary" as const }] : [])], listWidth))
  if (state.confirmDelete) headRows.push(clampLine([{ text: "delete this memory? d/y confirm · any other key cancels", fg: "error", bold: true }], listWidth))
  if (state.pick) headRows.push(...pickRows({ pick: state.pick, target: active, categories: input.data?.categories, width: listWidth, max: Math.max(2, Math.min(7, room - 6)) }))
  if (headRows.length) headRows.push([])

  const entryRows: Line[] = []
  if (visible.length === 0) entryRows.push(clampLine([{ text: emptyText(tab, state.filter), fg: "muted" }], listWidth))
  else {
    const entryCapacity = Math.max(0, (input.data?.workspaces ? height - 7 : room) - headRows.length)
    const rows = visible.map((memory, index) => entryLines({ memory, previous: memory.targetId ? byId.get(memory.targetId) : undefined, selected: index === selected, tab, directory, width: listWidth, now, glyphs }))
    let start = Math.min(Math.max(0, state.scroll), selected)
    const span = (from: number, to: number) => rows.slice(from, to + 1).reduce((sum, row) => sum + row.length, 0)
    while (start < selected && span(start, selected) > entryCapacity) start++
    while (start > 0 && span(start - 1, rows.length - 1) <= entryCapacity) start--
    for (let index = start; index < rows.length && entryRows.length < entryCapacity; index++) entryRows.push(...rows[index]!)
  }

  const listBody = [...headRows, ...entryRows]
  const body = wide
    ? beside(
        [
          { lines: listBody, width: listWidth },
          { lines: section({ title: "Detail", body: detailRows({ active, tab, byId, directory, width: detailWidth, now }), width: detailWidth }), width: detailWidth },
        ],
        GUTTER,
      )
    : listBody

  if (input.data?.workspaces) {
    const panelRoom = Math.max(0, height - 3)
    const grid = panelGrid({ width, compact: false, padding: true, maxColumns: wide ? 2 : 1, heights: [panelRoom], rows: [[
      { title: `${TAB_LABELS[tab].label} · ${visible.length}`, body: listBody, active: true, weight: 3 },
      ...(wide ? [{ title: "Origin / Detail", body: detailRows({ active, tab, byId, directory, width: detailWidth, now }), weight: 2 }] : []),
    ]] })
    return pickerFrame("Memory", hints, width, height, [tabsRow(PAGE_TABS, activeTab, width), ...grid], `${subtitle} · ${summary}${input.data.omitted ? ` · ${input.data.omitted} omitted` : ""}`)
  }
  return deck({ page: "Memory", ...(status ? { status } : {}), subtitle, summary, tabs: PAGE_TABS, activeTab, body, hints, width, height })
}

export { renderMemoryAssistant, memoryAssistantCursor } from "./memory-assistant-page"
