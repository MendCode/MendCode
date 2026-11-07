import type { PackageAssetsReport, PackageCatalogEntry, PackageCatalogReport, PackageInfo, PackagePreviewReport, PackageSourceInfo } from "@mendcode/protocol"
import type { ColorName, Line, Span } from "../ui/theme"
import { isCompact, isWide } from "../ui/breakpoints"
import { fit, panelGrid, spread, type GridPanel } from "./deck"
import { pickerFrame } from "./picker-frame"
import { tabsRow } from "./page"
import { describeContents } from "./packages-page"
import { describeOverride, overrideListRows, profileTabsRow, sortOverrides, type RawOverrideRow } from "./profile-overrides"
import { shortenMiddle, textWidth, truncateEnd, wrap } from "./wrap"
import { pageSearchKey, SEARCH_HINT, searchMatches } from "./page-search"

/**
 * /marketplace: the profile catalog (the built-in `local` source, which lists the installed profiles, and the sources the user
 * added). A search row on top, kind filters under it, one row per profile with its kind, source and an installed or update
 * badge, and beside it what installing the selected one changes. The keys return actions; `ui/app/package-catalog.ts` runs them.
 * Loaded when the page first opens.
 */

export type MarketplaceConfirm =
  | { kind: "install" | "update" | "reinstall"; name: string; sourceId: string }
  | { kind: "remove"; name: string; scope: "user" | "project" }
  | { kind: "remove-source"; sourceId: string }

export type MarketplaceState = {
  mode: "catalog" | "sources" | "assets"
  selected: number
  /** The selected entry (`source/name`): a reload that reorders the list keeps it selected. */
  selectedId?: string
  query: string
  /** The kind filter: "all" or one of `KINDS`' ids. */
  kind: string
  sourceId?: string
  scope: "user" | "project"
  editing?: "query" | "id" | "location"
  input: string
  draftId: string
  confirm?: MarketplaceConfirm
  sourceDetail?: boolean
  scroll: number
  keys?: boolean
  /** A one-line answer to a key that did nothing (`d` on a profile that is not installed). */
  note?: string
}

/** What a catalog profile takes over once on: rows read from its manifest, none, unknown, or remote (not fetched until install). */
export type TakeoverPreview = { status: "rows"; rows: RawOverrideRow[]; problems?: string[] } | { status: "none" | "unknown" | "remote"; problems?: string[] }

/** What the keys and the drawing read: the controller's data. `installed` is undefined until `profiles.list` answers. */
export type MarketplaceData = { report?: PackageCatalogReport | undefined; installed?: PackageInfo[] | undefined; sources: PackageSourceInfo[]; preview?: PackagePreviewReport | undefined }

export type MarketplaceAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "reload" }
  | { type: "preview"; entry: PackageCatalogEntry }
  | { type: "close-preview" }
  | { type: "install"; name: string; sourceId: string; replace: boolean; verb: "install" | "update" | "reinstall" }
  | { type: "remove"; name: string; scope: "user" | "project" }
  | { type: "sources" }
  | { type: "catalog" }
  | { type: "refresh"; sourceId: string }
  | { type: "toggle-source"; source: PackageSourceInfo }
  | { type: "add-source"; sourceId: string; location: string }
  | { type: "remove-source"; sourceId: string }
  | { type: "tab"; tab: 0 | 1 }

const NONE: MarketplaceAction = { type: "none" }
const SEARCH_PLACEHOLDER = "Search names, descriptions, tags, sources"
const PAGE_STEP = 10
const UP = new Set(["\x1b[A", "\x1bOA", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "j"])
const PAGE_UP = "\x1b[5~"
const PAGE_DOWN = "\x1b[6~"
const FIRST = new Set(["\x1b[H", "\x1bOH", "\x1b[1~"])
const LAST = new Set(["\x1b[F", "\x1bOF", "\x1b[4~"])
const BACK_TAB = "\x1b[Z"

/** The kinds a profile can carry, in the order the filters and the kind column name them. Remote entries show their contents only after install. */
export const KINDS: ReadonlyArray<{ id: string; one: string; label: string }> = [
  { id: "themes", one: "theme", label: "Themes" }, { id: "extensions", one: "extension", label: "Extensions" }, { id: "tools", one: "tool", label: "Tools" },
  { id: "skills", one: "skill", label: "Skills" }, { id: "commands", one: "command", label: "Commands" }, { id: "agents", one: "agent", label: "Agents" },
  { id: "mcp", one: "mcp", label: "MCP" }, { id: "remote", one: "remote", label: "Remote" },
]

/** Every key of the catalog, for the `?` section. */
const PAGE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["↑↓ j k", "select"], ["pgup pgdn", "page"], ["home end", "first, last"], ["enter", "install, update"], ["d", "remove"], ["/", "search"],
  ["tab ⇧tab", "kind"], ["p", "for you, this project"], ["s", "sources"], ["[ ]", "scroll the detail"], ["r", "reload"], ["1 2 3", "tabs"],
  ["esc", "clear, back"], ["?", "hide keys"],
]

export const createMarketplaceState = (): MarketplaceState => ({ mode: "catalog", selected: 0, query: "", kind: "all", scope: "user", input: "", draftId: "", scroll: 0 })

const entryId = (entry: PackageCatalogEntry) => `${entry.sourceId}/${entry.name}`
const scopeWords = (scope: "user" | "project") => scope === "user" ? "for you" : "in this project"

/** The kinds an entry carries (KINDS ids). A remote entry's contents are known only after install. */
export function entryKinds(entry: PackageCatalogEntry): string[] {
  const contents = entry.contents
  const kinds = KINDS.filter((kind) => kind.id === "mcp" ? contents.mcp : kind.id !== "remote" && (contents[kind.id as "tools"] ?? 0) > 0).map((kind) => kind.id)
  return kinds.length || !entry.remote ? kinds : ["remote"]
}

/** The kind column: the first kind and how many more, `remote` when unknown, `files` for a profile with none of the counted kinds. */
function kindLabel(entry: PackageCatalogEntry): string {
  const kinds = entryKinds(entry)
  const first = KINDS.find((kind) => kind.id === kinds[0])
  return first ? `${first.one}${kinds.length > 1 ? ` +${kinds.length - 1}` : ""}` : "files"
}

/** The entries the search and the kind filter keep, in catalog order. */
export function catalogMatches(report: PackageCatalogReport | undefined, query: string, kind = "all"): PackageCatalogEntry[] {
  return (report?.entries ?? []).filter((entry) => (kind === "all" || entryKinds(entry).includes(kind)) && searchMatches(query, [entry.name, entry.title ?? "", entry.description, entry.version, entry.sourceId, entry.author ?? "", ...entry.tags]))
}

/** "all" and the kinds at least one entry has, with their counts: what Tab steps through. */
export function kindFilters(report: PackageCatalogReport | undefined): Array<{ id: string; label: string; count: number }> {
  const entries = report?.entries ?? []
  return [{ id: "all", label: "All", count: entries.length }, ...KINDS.map((kind) => ({ id: kind.id, label: kind.label, count: entries.filter((entry) => entryKinds(entry).includes(kind.id)).length })).filter((kind) => kind.count > 0)]
}

/** Whether version `a` is newer than `b`, comparing the numbers of x.y.z; anything that is not numbers compares as not newer. */
export function newerVersion(a: string, b: string): boolean {
  const parts = (version: string) => version.replace(/^v/, "").split(/[-+]/)[0]!.split(".").map((part) => /^\d+$/.test(part) ? Number(part) : Number.NaN)
  const x = parts(a), y = parts(b)
  if (x.some(Number.isNaN) || y.some(Number.isNaN)) return false
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const left = x[i] ?? 0, right = y[i] ?? 0
    if (left !== right) return left > right
  }
  return false
}

/** Where an entry stands: the installed copy (in the chosen scope first), whether this one is newer, and the badge the row shows. */
export function entryStatus(entry: PackageCatalogEntry, installed: PackageInfo[] | undefined, scope: "user" | "project"): { badge: string; tone: ColorName; copy?: PackageInfo; update: boolean; inScope: boolean } {
  const copies = installed?.filter((pkg) => pkg.name === entry.name) ?? []
  const copy = copies.find((pkg) => pkg.source === scope) ?? copies[0]
  if (entry.problem) return { badge: "problem", tone: "error", ...(copy ? { copy } : {}), update: false, inScope: copy?.source === scope }
  if (!copy) {
    if (installed || entry.state === "available") return { badge: "", tone: "muted", update: false, inScope: false }
    return { badge: entry.state === "active" ? "on" : "off", tone: entry.state === "active" ? "success" : "muted", update: false, inScope: false }
  }
  const version = copy.manifest?.version
  const update = !!version && entry.sourceId !== "local" && newerVersion(entry.version, version)
  if (update) return { badge: "update", tone: "warning", copy, update, inScope: copy.source === scope }
  return { badge: copy.problem ? "problem" : copy.enabled ? "on" : "off", tone: copy.problem ? "error" : copy.enabled ? "success" : "muted", copy, update, inScope: copy.source === scope }
}

/** What Enter does to an entry: install it, update the installed copy, or install the same version again. */
export function enterVerb(entry: PackageCatalogEntry | undefined, installed: PackageInfo[] | undefined, scope: "user" | "project"): "install" | "update" | "reinstall" {
  if (!entry) return "install"
  const status = entryStatus(entry, installed, scope)
  if (!status.inScope) return "install"
  return status.update ? "update" : "reinstall"
}

/** The selected row: the entry `selectedId` names while it is listed, else the position. */
export function selectedEntryIndex(state: Pick<MarketplaceState, "selected" | "selectedId">, entries: readonly PackageCatalogEntry[]): number {
  const at = state.selectedId === undefined ? -1 : entries.findIndex((entry) => entryId(entry) === state.selectedId)
  return at >= 0 ? at : Math.max(0, Math.min(state.selected, entries.length - 1))
}

/** The catalog's `/` search through the shared page search. True when the key was the search's (the state is changed in place). */
export function catalogSearchKey(page: MarketplaceState, key: string, mayOpen: boolean): boolean {
  if (page.editing !== "query" && !(key === "/" && !page.editing && page.mode === "catalog" && mayOpen)) return false
  const result = pageSearchKey({ open: page.editing === "query", query: page.input }, key)
  if (!result) return false
  page.input = result.search.query
  page.query = result.search.query
  page.selected = 0
  delete page.selectedId
  page.scroll = 0
  if (result.search.open) page.editing = "query"
  else delete page.editing
  return true
}

/** The confirm question once a preview came back clean: what Enter (or y) then does. */
export function confirmFor(preview: PackagePreviewReport, installed: PackageInfo[] | undefined): MarketplaceConfirm {
  const { entry } = preview
  const kind = preview.action === "install" ? "install" : newerVersion(entry.version, preview.installedVersion ?? installed?.find((pkg) => pkg.name === entry.name && pkg.source === preview.scope)?.manifest?.version ?? entry.version) ? "update" : "reinstall"
  return { kind, name: entry.name, sourceId: entry.sourceId }
}

/** Handles one key of the page. Returns a new state object (the old one is never changed) and what the controller should do. */
/** How far the drawn detail can scroll: set by the last frame, so `]` stops at the end instead of counting past it. */
let scrollLimit = Number.MAX_SAFE_INTEGER
const scrolled = (state: MarketplaceState, delta: number): MarketplaceState => ({ ...state, scroll: Math.max(0, Math.min(scrollLimit, state.scroll + delta)) })

export function marketplaceKey(current: MarketplaceState, key: string, data: MarketplaceData): { state: MarketplaceState; action: MarketplaceAction } {
  const { note: _note, ...rest } = current
  const state: MarketplaceState = { ...rest }
  if (state.mode === "assets") {
    if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
    if (key === "r") return { state, action: { type: "reload" } }
    if (key === "]" || key === "[" || key === PAGE_DOWN || key === PAGE_UP) return { state: scrolled(state, key === "]" || key === PAGE_DOWN ? 5 : -5), action: NONE }
    return { state, action: NONE }
  }
  if (catalogSearchKey(state, key, !state.confirm)) return { state, action: NONE }
  if (state.editing) return editKey(state, key)
  if (state.confirm) {
    const confirm = state.confirm
    delete state.confirm
    const removing = confirm.kind === "remove" || confirm.kind === "remove-source"
    const yes = key === "y" || (removing ? key === "d" : key === "\r")
    if (!yes) return { state, action: NONE }
    if (confirm.kind === "remove") return { state, action: { type: "remove", name: confirm.name, scope: confirm.scope } }
    if (confirm.kind === "remove-source") return { state, action: { type: "remove-source", sourceId: confirm.sourceId } }
    return { state, action: { type: "install", name: confirm.name, sourceId: confirm.sourceId, replace: confirm.kind !== "install", verb: confirm.kind } }
  }
  if (key === "?") return { state: { ...state, keys: !state.keys }, action: NONE }
  if (key === "1" || key === "2") return { state, action: { type: "tab", tab: key === "1" ? 0 : 1 } }
  if (key === "3") return state.mode === "sources" ? { state, action: { type: "catalog" } } : { state, action: NONE }
  if (key === "]" || key === "[") return { state: scrolled(state, key === "]" ? 5 : -5), action: NONE }
  if (key === "r") return { state, action: { type: "reload" } }
  return state.mode === "sources" ? sourcesKey(state, key, data) : catalogKey(state, key, data)
}

function editKey(state: MarketplaceState, key: string): { state: MarketplaceState; action: MarketplaceAction } {
  if (key === "\x1b") { delete state.editing; return { state, action: NONE } }
  if (key === "\r") {
    if (state.editing === "id") {
      const id = state.input.trim()
      return id ? { state: { ...state, draftId: id, input: "", editing: "location" }, action: NONE } : { state, action: NONE }
    }
    const location = state.input.trim()
    return location ? { state, action: { type: "add-source", sourceId: state.draftId, location } } : { state, action: NONE }
  }
  if (key === "\x7f" || key === "\b") return { state: { ...state, input: [...state.input].slice(0, -1).join("") }, action: NONE }
  if (key === "\x15") return { state: { ...state, input: "" }, action: NONE }
  if (!/[\x00-\x1f\x7f]/.test(key)) return { state: { ...state, input: (state.input + key).slice(0, state.editing === "id" ? 64 : 4096) }, action: NONE }
  return { state, action: NONE }
}

function sourcesKey(state: MarketplaceState, key: string, data: MarketplaceData): { state: MarketplaceState; action: MarketplaceAction } {
  const sources = data.sources
  const at = Math.max(0, Math.min(state.selected, sources.length - 1))
  const source = sources[at]
  if (key === "\x1b" || key === "q") {
    if (state.sourceDetail) { delete state.sourceDetail; return { state, action: NONE } }
    return { state, action: { type: "catalog" } }
  }
  if (UP.has(key) || DOWN.has(key)) {
    const next = Math.max(0, Math.min(sources.length - 1, at + (UP.has(key) ? -1 : 1)))
    delete state.sourceDetail
    return { state: { ...state, selected: next, scroll: 0 }, action: NONE }
  }
  if (key === "c") return { state, action: { type: "catalog" } }
  if (key === "\r") return { state: { ...state, sourceDetail: !state.sourceDetail }, action: NONE }
  if (key === "a") return { state: { ...state, editing: "id", input: "" }, action: NONE }
  if (!source) return { state, action: NONE }
  if (key === "u") return source.remote ? { state, action: { type: "refresh", sourceId: source.id } } : { state: { ...state, note: `${source.id} is a local folder: it is read as it is, nothing to fetch` }, action: NONE }
  if (key === "e") return source.builtin ? { state: { ...state, note: "the local catalog is always on" }, action: NONE } : { state, action: { type: "toggle-source", source } }
  if (key === "d") return source.builtin ? { state: { ...state, note: "the local catalog lists your installed profiles and stays" }, action: NONE } : { state: { ...state, confirm: { kind: "remove-source", sourceId: source.id } }, action: NONE }
  return { state, action: NONE }
}

function catalogKey(state: MarketplaceState, key: string, data: MarketplaceData): { state: MarketplaceState; action: MarketplaceAction } {
  const entries = catalogMatches(data.report, state.query, state.kind)
  const at = selectedEntryIndex(state, entries)
  const entry = entries[at]
  const moveTo = (index: number) => {
    const next = Math.max(0, Math.min(entries.length - 1, index))
    const target = entries[next]
    if (!target || next === at && state.selectedId === entryId(target)) return { state, action: NONE }
    return { state: { ...state, selected: next, selectedId: entryId(target), scroll: 0 }, action: data.preview ? { type: "close-preview" } as const : NONE }
  }
  if (key === "\x1b" || key === "q") {
    if (state.keys) return { state: { ...state, keys: false }, action: NONE }
    if (data.preview) return { state: { ...state, scroll: 0 }, action: { type: "close-preview" } }
    if (key === "\x1b" && state.query) return { state: { ...state, query: "", input: "", selected: 0, scroll: 0 }, action: NONE }
    return { state, action: { type: "close" } }
  }
  if (UP.has(key)) return moveTo(at - 1)
  if (DOWN.has(key)) return moveTo(at + 1)
  if (key === PAGE_UP) return moveTo(at - PAGE_STEP)
  if (key === PAGE_DOWN) return moveTo(at + PAGE_STEP)
  if (FIRST.has(key)) return moveTo(0)
  if (LAST.has(key)) return moveTo(entries.length - 1)
  if (key === "\t" || key === BACK_TAB) {
    const filters = kindFilters(data.report)
    const index = Math.max(0, filters.findIndex((filter) => filter.id === state.kind))
    const next = filters[(index + (key === "\t" ? 1 : filters.length - 1)) % filters.length]!
    const { selectedId: _id, ...unselected } = state
    return { state: { ...unselected, kind: next.id, selected: 0, scroll: 0 }, action: data.preview ? { type: "close-preview" } : NONE }
  }
  if (key === "s") return { state, action: { type: "sources" } }
  if (key === "p") {
    const next = { ...state, scope: state.scope === "user" ? "project" as const : "user" as const }
    return { state: next, action: data.preview && entry ? { type: "preview", entry } : NONE }
  }
  if (!entry) return { state, action: NONE }
  if (key === "\r" || key === "i") return { state: { ...state, selectedId: entryId(entry) }, action: { type: "preview", entry } }
  if (key === "d") {
    const status = entryStatus(entry, data.installed, state.scope)
    const copy = status.copy
    if (!copy) return { state: { ...state, note: `${entry.name} is not installed: nothing to remove` }, action: NONE }
    return { state: { ...state, selectedId: entryId(entry), confirm: { kind: "remove", name: copy.name, scope: copy.source } }, action: NONE }
  }
  return { state, action: NONE }
}

// ── Drawing ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const row = (text: string, fg: ColorName = "text"): Line => [{ text, fg }]
const prose = (text: string, width: number, fg: ColorName = "muted"): Line[] => wrap(text, Math.max(1, width)).map((part) => row(part, fg))
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`
const LABEL = 10

function kv(label: string, value: string, width: number, fg: ColorName = "body"): Line {
  return fit([{ text: label.padEnd(LABEL), fg: "muted" }, { text: truncateEnd(value, Math.max(1, width - LABEL)), fg }], width)
}

/** The header keys: a few, with `?` for the rest; Enter names what it does to the selected profile. */
export function marketplaceHints(state: MarketplaceState, data: MarketplaceData): string {
  if (state.mode === "assets") return "[] scroll · r reload · esc back"
  if (state.editing === "query") return SEARCH_HINT
  if (state.editing) return "enter save · esc cancel"
  if (state.confirm) return state.confirm.kind === "remove" || state.confirm.kind === "remove-source" ? "d/y confirm · esc cancel" : "enter/y confirm · esc cancel"
  if (state.mode === "sources") return state.sourceDetail ? "e on/off · u fetch · d remove · esc list" : "enter details · a add · e on/off · u fetch · d remove · esc catalog"
  const entries = catalogMatches(data.report, state.query, state.kind)
  const entry = entries[selectedEntryIndex(state, entries)]
  const back = data.preview ? "esc close preview" : state.query ? "esc clear" : "esc back"
  return [...(entry ? [`enter ${enterVerb(entry, data.installed, state.scope)}`] : []), "/ search", "tab kind", state.keys ? "? hide keys" : "? keys", back].join(" · ")
}

/** The search row: `/` then the query and a caret while typing, or the placeholder; the match count on the right. */
function searchRow(state: MarketplaceState, shown: number, total: number, width: number): Line {
  const typing = state.editing === "query"
  const text = typing ? state.input : state.query
  const body: Line = text ? [{ text, fg: "text", bold: true }, ...(typing ? [{ text: "▏", fg: "primary" as const }] : [])] : [...(typing ? [{ text: "▏", fg: "primary" as const }] : []), { text: SEARCH_PLACEHOLDER, fg: "muted" }]
  const right = text || state.kind !== "all" ? `${shown} of ${total}` : plural(total, "profile")
  const left: Line = [{ text: "/ ", fg: "primary", bold: true }, ...body]
  const room = Math.max(1, width - textWidth(right) - 2)
  const clipped = left.reduce<{ line: Line; used: number }>((acc, span) => {
    const cut = truncateEnd(span.text, Math.max(0, room - acc.used))
    return cut ? { line: [...acc.line, { ...span, text: cut }], used: acc.used + textWidth(cut) } : acc
  }, { line: [], used: 0 }).line
  return fit(spread(clipped, [{ text: right, fg: "muted" }], width), width)
}

/** The kind filters as a tab row: the active one on the element background. */
function kindRow(state: MarketplaceState, report: PackageCatalogReport | undefined, width: number): Line {
  const filters = kindFilters(report)
  const draw = (label: (filter: (typeof filters)[number]) => string): Line => filters.flatMap((filter, index): Span[] => [
    ...(index ? [{ text: " " }] : []),
    filter.id === state.kind ? { text: ` ${label(filter)} `, fg: "text", bg: "element", bold: true } : { text: ` ${label(filter)} `, fg: "muted" },
  ])
  // The counts go first, then the long names; the active filter always reads whole.
  for (const label of [(filter: (typeof filters)[number]) => `${filter.label} ${filter.count}`, (filter: (typeof filters)[number]) => filter.label, (filter: (typeof filters)[number]) => filter.id === state.kind ? filter.label : filter.label.slice(0, 3)]) {
    const line = draw(label)
    if (line.reduce((sum, span) => sum + textWidth(span.text), 0) <= width) return fit(line, width)
  }
  return fit(draw((filter) => filter.label.slice(0, 3)), width)
}

type Columns = { name: number; kind: number; source: number; description: number; badge: number }

function columnsFor(entries: PackageCatalogEntry[], width: number): Columns {
  const room = width - 2
  const badge = 7
  const name = Math.min(26, Math.max(8, ...entries.map((entry) => textWidth(entry.title ?? entry.name))))
  const kind = Math.min(12, Math.max(4, ...entries.map((entry) => textWidth(kindLabel(entry)))))
  const source = Math.min(16, Math.max(6, ...entries.map((entry) => textWidth(entry.author ?? entry.sourceId))))
  const fixed = name + 2 + kind + 2 + badge + 1
  if (room - fixed - source - 2 >= 16) return { name, kind, source, description: room - fixed - source - 2, badge }
  if (room - fixed >= source + 2) return { name, kind, source, description: 0, badge }
  return { name: Math.max(4, room - kind - 2 - badge - 1), kind, source: 0, description: 0, badge }
}

function entryRow(input: { entry: PackageCatalogEntry; selected: boolean; columns: Columns; width: number; data: MarketplaceData; scope: "user" | "project" }): Line {
  const { entry, selected, columns, width } = input
  const status = entryStatus(entry, input.data.installed, input.scope)
  const pad = (text: string, size: number) => {
    const cut = truncateEnd(text, size)
    return cut + " ".repeat(Math.max(0, size - textWidth(cut)))
  }
  const spans: Span[] = [
    selected ? { text: "› ", fg: "primary", bold: true } : { text: "  " },
    { text: pad(entry.title ?? entry.name, columns.name), fg: selected ? "primary" : "text", bold: selected },
    { text: "  " },
    { text: pad(kindLabel(entry), columns.kind), fg: "info" },
  ]
  if (columns.source) spans.push({ text: "  " }, { text: pad(entry.author ?? entry.sourceId, columns.source), fg: "muted" })
  if (columns.description) spans.push({ text: "  " }, { text: pad(entry.description.replace(/\s+/g, " ").trim(), columns.description), fg: "body" })
  spans.push({ text: " " }, { text: status.badge.padStart(columns.badge), fg: status.tone, bold: status.badge === "update" })
  return fit(spans, width)
}

/** The empty, offline and error states of the list, in words, with what to do next. */
function emptyRows(input: { data: MarketplaceData; state: MarketplaceState; error: string; offline: boolean; width: number }): Line[] {
  const { data, state, error, offline, width } = input
  if (offline && !data.report) return prose("The daemon is offline. The catalog fills in when the terminal reconnects.", width, "warning")
  if (error && !data.report) return [...prose(`The catalog did not load: ${error}`, width, "warning"), [], ...prose("r tries again.", width)]
  if (!data.report) return [row("reading the catalog…", "muted")]
  if (!data.report.entries.length) return [
    row("No profiles in the catalog yet.", "muted"), [],
    ...prose("It lists the profiles you installed and the sources you added. s opens sources: a add takes a folder (a profile or a catalog, such as examples/official-profiles) or an https catalog.", width),
  ]
  if (state.query) return [row(`No profile matches "${state.query}".`, "muted"), ...prose(state.kind !== "all" ? "tab shows other kinds · esc clears the search" : "esc clears the search", width)]
  return [row("No profile of this kind.", "muted"), ...prose("tab shows another kind", width)]
}

function issueRows(report: PackageCatalogReport | undefined, width: number): Line[] {
  if (!report?.issues.length) return []
  return [[], ...report.issues.flatMap((issue) => prose(`! ${issue.replace(/; run refresh$/, ": s, then u fetches it")}`, width, "warning"))]
}

/** The question that replaces the top of the list while it waits: install, update, reinstall or remove. */
function confirmRow(state: MarketplaceState, data: MarketplaceData, width: number): Line[] {
  const confirm = state.confirm
  if (!confirm) return state.note ? [fit([{ text: state.note, fg: "muted" }], width), []] : []
  const entry = data.preview?.entry
  const text = confirm.kind === "remove" ? `remove ${confirm.name} (${confirm.scope})? d or y removes · any key keeps it`
    : confirm.kind === "remove-source" ? `remove the source ${confirm.sourceId}? d or y removes · any key keeps it`
    : `${confirm.kind} ${confirm.name}${entry ? ` ${entry.version}` : ""} ${scopeWords(data.preview?.scope ?? state.scope)}? enter or y · any key cancels`
  return [fit([{ text: truncateEnd(text, width), fg: confirm.kind.startsWith("remove") ? "error" : "warning", bold: true }], width), []]
}

function listRows(input: { data: MarketplaceData; state: MarketplaceState; error: string; offline: boolean; width: number; room: number; rule: string }): Line[] {
  const { data, state, width, room } = input
  const entries = catalogMatches(data.report, state.query, state.kind)
  const head: Line[] = [searchRow(state, entries.length, data.report?.entries.length ?? 0, width)]
  if (kindFilters(data.report).length > 2) head.push(kindRow(state, data.report, width))
  head.push([{ text: input.rule.repeat(Math.max(0, width)), fg: "muted", dim: true }], ...confirmRow(state, data, width))
  if (!entries.length) return [...head, ...emptyRows({ ...input, width }), ...issueRows(data.report, width)]
  const columns = columnsFor(entries, width)
  const at = selectedEntryIndex(state, entries)
  const issues = issueRows(data.report, width)
  const free = Math.max(1, room - head.length - Math.min(issues.length, 3))
  // More than fit: the last row says which ones are shown.
  const capacity = entries.length > free && free > 1 ? free - 1 : free
  const offset = Math.min(Math.max(0, at - capacity + 1), Math.max(0, entries.length - capacity))
  const rows = entries.slice(offset, offset + capacity).map((entry, i) => entryRow({ entry, selected: offset + i === at, columns, width, data, scope: state.scope }))
  const more = capacity < free ? [fit([{ text: `${offset + 1}-${offset + rows.length} of ${entries.length}`, fg: "muted", dim: true }], width)] : []
  return [...head, ...rows, ...more, ...issues.slice(0, 3)]
}

/** "What it takes over": the before → after rows /profiles shows, from the live activation or from the profile's manifest. */
function takeoverRows(input: { entry: PackageCatalogEntry; data: MarketplaceData; state: MarketplaceState; live?: RawOverrideRow[] | undefined; takeover?: TakeoverPreview | undefined; width: number }): Line[] {
  const { entry, data, state, width } = input
  const status = entryStatus(entry, data.installed, state.scope)
  const heading: Line = [{ text: "What it takes over", fg: "text", bold: true }]
  const own = status.copy?.enabled ? (input.live ?? []).filter((item) => item.package === status.copy!.key) : []
  const rows = own.length ? own : input.takeover?.status === "rows" ? input.takeover.rows : []
  if (rows.length) {
    const views = sortOverrides(rows.map(describeOverride))
    // Every row: the detail scrolls with [ ].
    const lines = overrideListRows({ rows: views, selected: -1, width, capacity: Number.MAX_SAFE_INTEGER })
    return [heading, row(own.length ? `on now · ${plural(views.length, "override")} · 1 lists them, k keeps yours` : `${plural(views.length, "override")}, before → after, once it is on`, "muted"), ...lines]
  }
  const words = input.takeover?.status === "remote" ? "Known after install: a remote profile is fetched only then."
    : input.takeover?.status === "none" ? "Nothing: it adds what it carries and changes no setting, key or view."
    : input.takeover?.status === "unknown" ? "Unknown: its manifest could not be read here."
    : status.copy?.enabled ? "Nothing right now." : "enter shows it before anything is installed."
  return [heading, ...prose(words, width), ...(input.takeover?.problems ?? []).flatMap((problem) => prose(problem, width, "warning"))]
}

function trustRows(entry: PackageCatalogEntry, preview: PackagePreviewReport | undefined, width: number): Line[] {
  const rows: Line[] = [[], [{ text: "Source and trust", fg: "text", bold: true }]]
  const origin = entry.sourceId === "local" ? entry.tags.includes("authored") ? "this project's authored profile" : "installed profile (the local catalog)" : entry.remote ? `${entry.sourceId} · remote catalog` : `${entry.sourceId} · local folder`
  rows.push(kv("source", origin, width), kv("location", shortenMiddle(entry.location, Math.max(1, width - LABEL)), width, "muted"))
  if (entry.author) rows.push(kv("author", entry.author, width))
  rows.push(...prose(entry.remote ? "Unsigned. Fetched, checked against its pin and audited only when you confirm the install." : "Unsigned. Read from the folder as it is; audited before it installs, and nothing installs without your confirm.", width))
  if (preview?.trust) {
    const trust = preview.trust
    rows.push([], row("Trust · unsigned", "warning"), ...prose(`Identity: ${trust.identity} · ${preview.scope}`, width, "text"), ...prose("Capabilities do not grant permission", width), ...trust.duplicates.flatMap((key) => prose(`Duplicate content: ${key}`, width, "warning")))
    if (!trust.comparisonComplete) rows.push(...prose("Duplicate scan incomplete", width))
  }
  if (preview?.capabilities) {
    const caps = preview.capabilities
    rows.push([], row("Capabilities · static hints", "primary"), ...prose(`Declared: ${caps.declared.join(", ") || "none"}`, width, "text"), ...prose(`Observed: ${caps.observed.join(", ") || "none"}`, width, "text"), ...prose(caps.complete ? "Code can do more than this scan detects" : "Partial scan · capabilities unknown", width))
    if (caps.declaredEnvironment?.length || caps.observedEnvironment?.length) rows.push(...prose(`Env names: ${[...new Set([...(caps.declaredEnvironment ?? []), ...(caps.observedEnvironment ?? [])])].join(", ")}`, width, "text"))
  }
  return rows
}

/** The selected profile: what it is, where it stands, what installing changes, and where it comes from. */
function detailRows(input: { entry: PackageCatalogEntry; data: MarketplaceData; state: MarketplaceState; live?: RawOverrideRow[] | undefined; takeover?: TakeoverPreview | undefined; width: number }): Line[] {
  const { entry, data, state, width } = input
  const preview = data.preview && entryId(data.preview.entry) === entryId(entry) ? data.preview : undefined
  const status = entryStatus(entry, data.installed, state.scope)
  const copy = status.copy
  const standing = entry.problem ? entry.problem
    : status.update ? `${copy!.manifest?.version} installed in ${copy!.source} · ${entry.version} here`
    : copy ? `installed in ${copy.source}${copy.manifest?.version ? ` · ${copy.manifest.version}` : ""} · ${copy.enabled ? "on" : "off"}`
    : entry.state !== "available" && !data.installed ? `installed · ${entry.state === "active" ? "on" : "off"}` : "not installed"
  const rows: Line[] = [
    fit([{ text: entry.title ?? entry.name, fg: "text", bold: true }, ...(status.badge ? [{ text: `  ${status.badge}`, fg: status.tone, bold: true }] : [])], width),
    fit([{ text: `${entry.name} · ${entry.version}`, fg: "muted" }], width),
    ...wrap(entry.description.replace(/\s+/g, " ").trim(), Math.max(1, width)).slice(0, 4).map((part) => row(part, "body")),
    [],
    kv("state", standing, width, entry.problem ? "error" : status.update ? "warning" : "body"),
    kv("adds", entry.remote && !entryKinds(entry).some((kind) => kind !== "remote") ? "known after install" : describeContents(entry.contents), width),
    ...(entry.tags.length ? [kv("tags", entry.tags.join(", "), width, "muted")] : []),
  ]
  if (preview) {
    const verb = preview.action === "install" ? "Install" : status.update ? `Update ${preview.installedVersion ?? copy?.manifest?.version ?? ""} → ${entry.version}`.replace("  ", " ") : `Replace ${preview.installedVersion ?? "installed"}`
    rows.push([], fit([{ text: `${verb} → ${preview.scope}`, fg: "primary", bold: true }], width), row(`${preview.problems.length} audit problems`, preview.problems.length ? "error" : "text"), ...preview.problems.flatMap((problem) => prose(problem, width, "error")))
  }
  rows.push([], ...takeoverRows(input), ...trustRows(entry, preview, width))
  return rows
}

/** The `?` section: the keys in as many columns as fit (at most four), read down each column. */
function keysRows(width: number): Line[] {
  for (let columns = 4; columns >= 1; columns--) {
    const count = Math.ceil(PAGE_KEYS.length / columns)
    const sets = Array.from({ length: columns }, (_, column) => PAGE_KEYS.slice(column * count, (column + 1) * count))
    const keyWidth = sets.map((set) => Math.max(0, ...set.map(([key]) => textWidth(key))))
    const meaningWidth = sets.map((set) => Math.max(0, ...set.map(([, meaning]) => textWidth(meaning))))
    const total = sets.reduce((sum, _, column) => sum + keyWidth[column]! + 2 + meaningWidth[column]! + (column ? 4 : 0), 1)
    if (total > width && columns > 1) continue
    return Array.from({ length: count }, (_, line) => fit([{ text: " " }, ...sets.flatMap((set, column): Span[] => {
      const entry = set[line]
      if (!entry) return []
      const [key, meaning] = entry
      const pad = column === sets.length - 1 ? "" : " ".repeat(meaningWidth[column]! - textWidth(meaning))
      return [...(column ? [{ text: "    " }] : []), { text: key.padEnd(keyWidth[column]! + 2), fg: "text", bold: true }, { text: meaning + pad, fg: "muted" }]
    })], width))
  }
  return []
}

function catalogSummary(data: MarketplaceData, state: MarketplaceState, error: string, offline: boolean): { text: string; tone: ColorName } {
  if (offline) return { text: "daemon offline", tone: "warning" }
  if (error && data.report) return { text: `last action failed · ${error}`, tone: "error" }
  if (!data.report) return { text: error ? "catalog unavailable" : "", tone: error ? "warning" : "muted" }
  const entries = data.report.entries
  const updates = entries.filter((entry) => entryStatus(entry, data.installed, state.scope).update).length
  const on = new Set(entries.filter((entry) => entryStatus(entry, data.installed, state.scope).badge === "on").map((entry) => entry.name)).size
  return { text: [plural(entries.length, "profile"), on ? `${on} on` : "", updates ? plural(updates, "update") : "", state.sourceId ? `source ${state.sourceId}` : "", `installs ${scopeWords(state.scope)}`].filter(Boolean).join(" · "), tone: "muted" }
}

function sourceRows(state: MarketplaceState, sources: PackageSourceInfo[], width: number, room: number): Line[] {
  const head = confirmRow(state, { sources }, width)
  if (state.editing === "id" || state.editing === "location") {
    const label = state.editing === "id" ? "source id " : `folder or https catalog for ${state.draftId} `
    head.unshift(fit([{ text: label, fg: "warning", bold: true }, { text: state.input, fg: "text" }, { text: "▏", fg: "primary" }], width), [])
  }
  if (!sources.length) return [...head, row("reading the sources…", "muted")]
  const visible = Math.max(1, room - head.length)
  const selected = Math.max(0, Math.min(state.selected, sources.length - 1))
  const start = Math.max(0, selected - visible + 1)
  const id = Math.min(24, Math.max(...sources.map((source) => textWidth(source.id))))
  return [...head, ...sources.slice(start, start + visible).map((source, i): Line => fit([
    start + i === selected ? { text: "› ", fg: "primary", bold: true } : { text: "  " },
    { text: `${source.id} · ${source.enabled ? "on" : "off"}${source.remote ? " · remote" : ""}`.padEnd(id + 16), fg: start + i === selected ? "primary" : "text", bold: start + i === selected },
    { text: source.builtin ? "installed profiles" : shortenMiddle(source.location, Math.max(1, width - id - 20)), fg: "muted" },
  ], width))]
}

function sourceDetailRows(source: PackageSourceInfo | undefined, width: number): Line[] {
  if (!source) return [row("No sources", "muted")]
  return [
    fit([{ text: source.id, fg: "text", bold: true }, { text: `  ${source.enabled ? "on" : "off"}`, fg: source.enabled ? "success" : "muted", bold: true }], width),
    ...wrap(source.location, Math.max(1, width)).map((text) => row(text, "muted")), [],
    ...(source.builtin ? prose("The installed profiles of both scopes, and this project's authored profile. Always on; it cannot be removed.", width) : []),
    ...(source.remote ? [row(source.fetchedAt ? `Fetched ${new Date(source.fetchedAt).toISOString().slice(0, 16).replace("T", " ")}` : "Not fetched yet", "muted"), ...prose(source.enabled ? "u fetches the index (the only key that reaches the network); search reads the copy kept here." : "Enable it with e, then u fetches the index.", width)] : []),
    ...(!source.builtin && !source.remote ? prose("A folder on this machine: a profile itself or a catalog index. Read as it is on every search.", width) : []),
    ...(source.builtin ? [] : [[], row("e on/off · d remove", "muted")]),
  ]
}

/** Renders exactly `height` lines of `width` cells. */
export function renderMarketplacePage(input: { state: MarketplaceState; report?: PackageCatalogReport | undefined; installed?: PackageInfo[] | undefined; sources: PackageSourceInfo[]; preview?: PackagePreviewReport | undefined; assets?: PackageAssetsReport | undefined; takeover?: TakeoverPreview | undefined; live?: RawOverrideRow[] | undefined; error: string; offline?: boolean; rule?: string; width: number; height: number }): Line[] {
  const { state, width, height } = input
  if (height <= 0) return []
  const offline = input.offline ?? false
  const data: MarketplaceData = { report: input.report, installed: input.installed, sources: input.sources, preview: input.preview }
  const hints = marketplaceHints(state, data)
  const rule = input.rule ?? "─"
  if (state.mode === "assets") return assetsPage(input, hints)
  const keyLines = state.keys && state.mode === "catalog" ? keysRows(width) : []
  const keyBlock = keyLines.length ? [...keyLines.slice(0, Math.max(1, height - 9)), []] : []
  const room = Math.max(0, height - 2 - keyBlock.length)
  const compact = isCompact(width)
  const split = isWide(width) && room >= 20
  const panelRoom = (rows: number) => Math.max(1, rows - 4)
  let body: Line[]
  let summary: { text: string; tone: ColorName }
  // The detail's own rows (border and padding off): what `]` may scroll past.
  const detailRoom = panelRoom(split || compact ? room : Math.max(0, room - stackedTop(room) - 1))
  const limited = (rows: Line[]) => { scrollLimit = Math.max(0, rows.length - detailRoom); return rows }
  scrollLimit = 0
  if (state.mode === "sources") {
    const source = input.sources[Math.max(0, Math.min(state.selected, input.sources.length - 1))]
    const listRoom = panelRoom(split || compact ? room : stackedTop(room))
    const list: GridPanel = { title: "Sources", active: true, weight: 3, body: (w) => sourceRows(state, input.sources, w, listRoom) }
    const detail: GridPanel = { title: source?.remote ? "Remote catalog" : "Local catalog", weight: 2, scroll: state.scroll, body: (w) => limited(sourceDetailRows(source, w)) }
    body = layout({ list, detail, width, room, split, compact, showDetail: !!state.sourceDetail })
    summary = { text: input.error ? `last action failed · ${input.error}` : `${plural(input.sources.length, "source")} · ${input.sources.filter((item) => item.enabled).length} on`, tone: input.error ? "error" : "muted" }
  } else {
    const entries = catalogMatches(data.report, state.query, state.kind)
    const entry = input.preview?.entry && !entries.some((item) => entryId(item) === entryId(input.preview!.entry)) ? input.preview.entry : entries[selectedEntryIndex(state, entries)]
    const top = split || compact || !entry ? room : stackedTop(room)
    const list: GridPanel = { title: "Catalog", active: true, weight: 1, body: (w) => listRows({ data, state, error: input.error, offline, width: w, room: panelRoom(top), rule }) }
    const detail: GridPanel = { title: input.preview ? "Install preview" : "Profile", weight: 1, scroll: state.scroll, body: (w) => limited(entry ? detailRows({ entry, data, state, live: input.live, takeover: input.takeover, width: w }) : []) }
    body = entry ? layout({ list, detail, width, room, split, compact, showDetail: !!input.preview }) : panelGrid({ width, compact: false, padding: true, maxColumns: 1, heights: [room], rows: [[list]] })
    summary = catalogSummary(data, state, input.error, offline)
  }
  const frame = pickerFrame("Marketplace", hints, width, height, [...keyBlock, ...body])
  if (height > 1) frame[1] = profileTabsRow({ active: 2, right: summary.text, tone: summary.tone, width })
  return frame
}

/** Beside when wide, stacked otherwise; a compact screen shows one panel, the detail while it is asked for. */
function layout(input: { list: GridPanel; detail: GridPanel; width: number; room: number; split: boolean; compact: boolean; showDetail: boolean }): Line[] {
  const { list, detail, width, room, split, compact } = input
  if (split) return panelGrid({ width, compact: false, padding: true, maxColumns: 2, heights: [room], rows: [[list, detail]] })
  if (compact) return panelGrid({ width, compact: false, padding: true, maxColumns: 1, heights: [room], rows: [[input.showDetail ? { ...detail, active: true } : list]] })
  const top = stackedTop(room)
  return panelGrid({ width, compact: false, padding: true, maxColumns: 1, heights: [top, Math.max(0, room - top - 1)], rows: [[list], [detail]] })
}

/** The list's height when the detail sits under it. */
const stackedTop = (room: number) => Math.max(8, Math.floor(room * 0.45))

/** /mend-assets: what the enabled layers hold, counted. */
function assetsPage(input: { state: MarketplaceState; assets?: PackageAssetsReport | undefined; error: string; width: number; height: number }, hints: string): Line[] {
  const { state, width, height } = input
  const room = Math.max(0, height - 2)
  scrollLimit = Number.MAX_SAFE_INTEGER
  const totals = input.assets?.totals
  const summaryRows = totals ? [row(`Skills: ${totals.skills}`), row(`Slash commands: ${totals.commands}`), row(`Agents: ${totals.agents ?? 0}`), row(`Prompt templates: ${totals.templates}`), row(`MCP files: ${input.assets!.layers.filter((layer) => layer.contents.mcp).length}`), row(`Prompt mode: ${input.assets!.promptMode}`), row(`Prompt files: ${totals.prompts}`), row(`Tools: ${totals.tools}`), row(`Themes: ${totals.themes}`), row(`Extensions: ${totals.extensions ?? 0}`)] : [row(input.error || "Loading assets…", input.error ? "error" : "muted")]
  const layers = (w: number) => input.assets?.layers.flatMap((layer) => [row(layer.source, "primary"), ...wrap(`${describeContents(layer.contents)}${layer.prompts ? ` · ${plural(layer.prompts, "prompt file")}` : ""}${layer.templates ? ` · ${plural(layer.templates, "template")}` : ""}`, w).map((text) => row(text, "muted")), []]) ?? []
  const body = isWide(width)
    ? panelGrid({ width, compact: false, padding: true, heights: [room], rows: [[{ title: "Runtime assets", body: summaryRows, weight: 1, active: true }, { title: "Active layers", body: layers, weight: 2, scroll: state.scroll }]] })
    : panelGrid({ width, compact: false, padding: true, maxColumns: 1, heights: [room], rows: [[{ title: "Runtime assets", active: true, scroll: state.scroll, body: [...summaryRows, [], row("Active layers", "primary"), ...input.assets?.layers.map((layer) => row(`${layer.source} · ${describeContents(layer.contents)}`)) ?? []] }]] })
  return pickerFrame("MendCode Assets", hints, width, height, body)
}
