import type { ContextReport } from "@mendcode/protocol"
import type { ColorName, Glyphs, Line, Span } from "../ui/theme"
import { beside, boxPanel, columns, fit, panelGrid, spread } from "./deck"
import { tabsRow, type PageTab } from "./page"
import { wrap } from "./wrap"

export type ContextPageAction = { type: "none" } | { type: "close" } | { type: "refresh" }

/** `tab` is 0 for Sections, 1 for Largest and 2 for Files. Without a state the page shows both stacked, without tabs. */
export type ContextPageState = { tab?: number; scroll?: number }

const PAGE_TABS: PageTab[] = [{ key: "1", label: "Sections" }, { key: "2", label: "Largest" }, { key: "3", label: "Files" }]
const TAB_COUNT = PAGE_TABS.length
/** Esc/q closes, r refreshes; everything else is ignored. */
export function contextPageKey(key: string): ContextPageAction {
  if (key === "\x1b" || key === "q") return { type: "close" }
  if (key === "r") return { type: "refresh" }
  return { type: "none" }
}

export function createContextPageState(): ContextPageState {
  return {}
}

/** Like `contextPageKey`, with the tab state: tab and shift-tab cycle, 1 and 2 jump. Same state object when nothing changed. */
export function contextPageStateKey(state: ContextPageState, key: string): { state: ContextPageState; action: ContextPageAction } {
  const tab = state.tab === 1 || state.tab === 2 ? state.tab : 0
  const go = (next: number) => ({ state: next === tab ? state : { ...state, tab: next, scroll: 0 }, action: { type: "none" } as ContextPageAction })
  if (key === "\t") return go((tab + 1) % TAB_COUNT)
  if (key === "\x1b[Z") return go((tab + TAB_COUNT - 1) % TAB_COUNT)
  if (key === "1" || key === "2" || key === "3") return go(Number(key) - 1)
  if (key === "\x1b[6~" || key === "\x1b[5~") return { state: { ...state, scroll: Math.max(0, (state.scroll ?? 0) + (key === "\x1b[6~" ? 10 : -10)) }, action: { type: "none" } }
  return { state, action: contextPageKey(key) }
}

const CATEGORIES: Array<{ id: string; label: string; color: ColorName; glyph: string }> = [
  { id: "system", label: "System prompt", color: "heading", glyph: "■" },
  { id: "tools", label: "Tools", color: "link", glyph: "◆" },
  { id: "mcp", label: "MCP", color: "info", glyph: "●" },
  { id: "agents", label: "Agents", color: "accent", glyph: "▲" },
  { id: "memory", label: "Memory", color: "warning", glyph: "◇" },
  { id: "skills", label: "Skills", color: "code", glyph: "◈" },
  { id: "messages", label: "Messages", color: "text", glyph: "▪" },
]
const label = (text: string): Span => ({ text, fg: "muted" })
const value = (text: string): Span => ({ text, fg: "text", bold: true })
const tokens = (n: number) => Math.round(n).toLocaleString("en-US")

/** Older reports remain usable; unknown MCP/agent attribution stays unknown. */
function slices(report: ContextReport) {
  if (report.categories) return report.categories
  const grouped = new Map<string, { id: string; label: string; chars: number; tokens: number; count?: number }>()
  for (const section of report.sections) {
    const id = section.id.startsWith("history") ? "messages" : section.id === "tools" ? "tools" : section.id === "system:skills" ? "skills" : section.id === "system:memory" ? "memory" : section.id === "system:agent" ? "agents" : "system"
    const target = grouped.get(id) ?? { id, label: id, chars: 0, tokens: 0 }
    target.chars += section.chars
    target.tokens += section.tokens
    if (section.count !== undefined) target.count = (target.count ?? 0) + section.count
    grouped.set(id, target)
  }
  return [...grouped.values()]
}

export function contextWindowSlices(report: ContextReport) {
  const limit = report.contextWindow ?? report.compactAtTokens
  const categories = slices(report)
  const attributed = categories.reduce((sum, entry) => sum + entry.tokens, 0)
  const used = Math.max(attributed, report.estimatedTokens)
  const buffer = report.contextWindow === undefined ? 0 : Math.max(0, limit - report.compactAtTokens)
  const free = Math.max(0, limit - used - buffer)
  return {
    limit,
    categories: [...CATEGORIES.map((entry) => ({ ...entry, tokens: categories.find((part) => part.id === entry.id)?.tokens ?? 0, known: categories.some((part) => part.id === entry.id) })),
      ...(used > attributed ? [{ id: "unknown", label: "Unattributed", tokens: used - attributed, known: true, color: "muted" as const, glyph: "?" }] : []),
      { id: "free", label: "Free space", tokens: free, known: true, color: "border" as const, glyph: "·" },
      { id: "buffer", label: "Autocompact buffer", tokens: buffer, known: report.contextWindow !== undefined, color: "secondary" as const, glyph: "▒" }],
  }
}

/** 100 cells, ten columns. Largest-remainder allocation keeps even small slices visible without overfilling. */
export function contextGlyphGrid(report: ContextReport): Line[] {
  const { categories, limit } = contextWindowSlices(report)
  const buffer = categories.find((entry) => entry.id === "buffer")!.tokens
  const used = categories.filter((entry) => entry.id !== "free" && entry.id !== "buffer").reduce((sum, entry) => sum + entry.tokens, 0)
  const scale = Math.min(1, (limit - buffer) / Math.max(1, used))
  const counts = categories.map((entry) => entry.tokens * (entry.id === "free" || entry.id === "buffer" ? 1 : scale) / limit * 100)
  const allocated = counts.map(Math.floor)
  const order = counts.map((n, i) => ({ i, remainder: n - allocated[i]! })).sort((a, b) => b.remainder - a.remainder)
  for (let rest = 100 - allocated.reduce((a, b) => a + b, 0), i = 0; rest > 0; rest--, i++) allocated[order[i % order.length]!.i]!++
  const cells = categories.flatMap((entry, i) => Array.from({ length: allocated[i]! }, (): Span => ({ text: `${entry.glyph} `, fg: entry.color })))
  return Array.from({ length: 10 }, (_, row) => cells.slice(row * 10, row * 10 + 10))
}

function overview(report: ContextReport, width: number): Line[] {
  const { limit, categories } = contextWindowSlices(report)
  const pressure = report.estimatedTokens / report.compactAtTokens
  const meta: Line[] = [
    [value(report.model)],
    [label(`id ${report.sessionId ?? "unavailable"}`)],
    [{ text: `≈${tokens(report.estimatedTokens)} / ${tokens(limit)} (${(report.estimatedTokens / limit * 100).toFixed(1)}%)`, fg: pressure >= 0.9 ? "error" : pressure >= 0.7 ? "warning" : "success", bold: true }],
    [label(report.contextWindow === undefined ? "Window unknown · compact threshold shown" : `Autocompact at ${tokens(report.compactAtTokens)}${report.contextWindowOverride ? " · window set with /context-window" : ""}`)],
    [label(report.measuredTokens === undefined ? "Measured: none yet" : `Measured: ${tokens(report.measuredTokens)} at last call`)],
    ...categories.map((entry): Line => [{ text: `${entry.glyph} `, fg: entry.color }, { text: `${entry.label}: ${entry.known ? `${tokens(entry.tokens)} tokens (${(entry.tokens / limit * 100).toFixed(1)}%)` : "unavailable"}`, fg: entry.color }]),
    ...(report.images ? [[label(`${report.images} images · tokens not estimated`)]] : []),
    ...(report.contextWindow !== undefined && report.estimatedTokens > report.compactAtTokens ? [[{ text: `${tokens(report.estimatedTokens - report.compactAtTokens)} tokens in buffer`, fg: "warning" } as Span]] : []),
  ]
  const metaWidth = Math.max(1, width - 22)
  const wrapped = meta.flatMap((row) => row.length === 1 ? wrap(row[0]!.text, metaWidth).map((text): Line => [{ ...row[0]!, text }]) : wrap(row.map((span) => span.text).join(""), metaWidth).map((text): Line => [{ text, fg: row[0]?.fg ?? "text" }]))
  return beside([{ lines: contextGlyphGrid(report), width: 20 }, { lines: wrapped, width: metaWidth }], 2)
}

/** Tool schemas grouped by owner (built-in, an MCP server, an extension): what they cost every request against the calls seen. Biggest first. */
export function rentByOwner(report: ContextReport): Array<{ owner: string; tokens: number; tools: number; uses: number }> {
  const owners = new Map<string, { owner: string; tokens: number; tools: number; uses: number }>()
  for (const entry of report.rent ?? []) {
    const total = owners.get(entry.owner) ?? { owner: entry.owner, tokens: 0, tools: 0, uses: 0 }
    total.tokens += entry.tokens
    total.tools++
    total.uses += entry.uses
    owners.set(entry.owner, total)
  }
  return [...owners.values()].sort((a, b) => b.tokens - a.tokens || a.owner.localeCompare(b.owner))
}

/** An owner this large is worth a hint when none of its tools was called. */
const IDLE_RENT_TOKENS = 600

export function contextSuggestions(report: ContextReport): string[] {
  const out: string[] = []
  for (const owner of rentByOwner(report)) {
    if (owner.owner !== "built-in" && owner.uses === 0 && owner.tokens >= IDLE_RENT_TOKENS) out.push(`${owner.owner} adds ≈${tokens(owner.tokens)} tokens to every request (${owner.tools} tool${owner.tools === 1 ? "" : "s"}) and none was called in this history. Turn it off in /mcp or /extensions, or use /tier.`)
  }
  const result = report.largest.find((message) => message.role === "tool" && message.tokens >= Math.max(1000, report.compactAtTokens * 0.01))
  if (result) out.push(`Largest tool result: ${tokens(result.tokens)} tokens (${(result.tokens / Math.max(1, report.estimatedTokens) * 100).toFixed(1)}% of used). Narrow this output: ${result.preview}`)
  for (const read of report.repeatedReads ?? []) out.push(`Re-read ${read.path} ${read.count} times · ${tokens(read.tokens)} tokens. Reuse the previous read when the file is unchanged.`)
  if (report.estimatedTokens >= report.compactAtTokens * 0.9) out.push(`Only ${tokens(Math.max(0, report.compactAtTokens - report.estimatedTokens))} tokens before autocompact. /compact can summarize this history now.`)
  return out
}

function resources(report: ContextReport, width: number): Line[] {
  const parts = slices(report)
  const out: Line[] = []
  for (const [id, name] of [["mcp", "MCP tools"], ["agents", "Custom agents"], ["skills", "Skills"], ["memory", "Memory"]]) {
    const entry = parts.find((part) => part.id === id)
    out.push([{ text: `${name}: ${entry?.count === undefined ? "count unavailable" : `${entry.count} ${id === "mcp" ? "tools" : "entries"}`} · ${entry ? `${tokens(entry.tokens)} tokens` : "tokens unavailable"}`, fg: "primary", bold: true }])
    if (id === "mcp") for (const tool of report.mcpTools ?? []) out.push(...wrap(`${tool.label}: ${tokens(tool.tokens)} tokens`, width).map((text): Line => [label(text)]))
    out.push([])
  }
  // Tool schemas an extension adds (already inside "tools"): who owns them, so a heavy one can be turned off in /extensions.
  const owned = report.extensions ?? []
  if (owned.length) {
    out.push([{ text: `Extensions: ${owned.length} adding ${tokens(owned.reduce((sum, entry) => sum + entry.tokens, 0))} tokens of tool schemas`, fg: "primary", bold: true }])
    for (const entry of owned) out.push(...wrap(`${entry.label}: ${tokens(entry.tokens)} tokens${entry.count ? ` · ${entry.count} tool${entry.count === 1 ? "" : "s"}` : ""}`, width).map((text): Line => [label(text)]))
    out.push([])
  }
  // Rent: the same schemas by owner, against how often they were called. A tool nobody calls still costs its schema every request.
  const rent = report.rent ?? []
  if (rent.length) {
    const owners = rentByOwner(report)
    const total = rent.reduce((sum, entry) => sum + entry.tokens, 0)
    const idle = rent.filter((entry) => entry.uses === 0)
    out.push([{ text: `Context rent: ≈${tokens(total)} tokens of tool schemas on every request · ${idle.length} of ${rent.length} tools unused (≈${tokens(idle.reduce((sum, entry) => sum + entry.tokens, 0))})`, fg: "primary", bold: true }])
    for (const owner of owners.slice(0, 8)) out.push(...wrap(`${owner.owner}: ≈${tokens(owner.tokens)} tokens · ${owner.tools} tool${owner.tools === 1 ? "" : "s"} · ${owner.uses} use${owner.uses === 1 ? "" : "s"}${owner.uses === 0 ? " · unused" : ""}`, width).map((text): Line => [{ text, fg: owner.uses === 0 ? "warning" : "muted" }]))
    if (owners.length > 8) out.push([label(`+${owners.length - 8} more owners`)])
    out.push(...wrap("Uses count calls still in this history; schema cost is an estimate (chars / 4).", width).map((text): Line => [label(text)]))
    out.push([])
  }
  return out.slice(0, -1)
}

function largestRows(report: ContextReport, width: number): Line[] {
  if (!report.largest.length) return [[label("History is empty")]]
  return report.largest.flatMap((message): Line[] => [
    [{ text: `${message.role} · ≈${tokens(message.tokens)} tokens`, fg: message.role === "tool" ? "warning" : "text", bold: true }],
    ...wrap(message.preview, width).map((text): Line => [label(text)]),
    [],
  ])
}

/** One row per file the history holds: path, how often it was read and edited, and what its results weigh. */
export function fileRows(report: ContextReport, width: number): Line[] {
  const files = report.files ?? []
  if (!files.length) return [[label(report.files === undefined ? "This engine does not report files" : "No files in context yet")]]
  const total = files.reduce((sum, file) => sum + file.tokens, 0)
  const rows: Line[] = [[{ text: `${files.length} ${files.length === 1 ? "file" : "files"} · ≈${tokens(total)} tokens`, fg: "primary", bold: true }], []]
  for (const file of files) {
    const facts = `${file.reads ? `read ${file.reads}` : ""}${file.reads && file.edits ? " · " : ""}${file.edits ? `edited ${file.edits}` : ""} · ≈${tokens(file.tokens)}`
    const room = Math.max(8, width - facts.length - 2)
    const shown = file.path.length > room ? `…${file.path.slice(file.path.length - room + 1)}` : file.path
    rows.push([{ text: shown, fg: file.edits ? "warning" : "text" }, { text: " ".repeat(Math.max(2, width - shown.length - facts.length)) }, label(facts)])
  }
  return rows
}

/** Full-width panels on large terminals; small terminals retain tabs and page scrolling. */
export function renderContextPage(input: { report: ContextReport | undefined; error?: string; state?: ContextPageState; width: number; height: number; glyphs?: Glyphs }): Line[] {
  const { report, width, height, state } = input
  if (height <= 0 || width <= 0) return []
  const inner = Math.max(1, width - 2)
  const tabbed = report !== undefined && state !== undefined
  const tab = state?.tab === 1 || state?.tab === 2 ? state.tab : 0
  const hints = tabbed ? "r refresh · tab/1-3 tabs · PgDn more · esc back" : "r refresh · esc back"
  const head: Line[] = [spread([{ text: "Context", fg: "primary", bold: true }], [label(hints)], inner), ...(tabbed ? [tabsRow(PAGE_TABS, tab, inner)] : []), [{ text: "─".repeat(inner), fg: "border" }]]
  const room = Math.max(0, height - head.length)
  let body: Line[]
  if (!report) body = [[{ text: input.error ?? "loading context…", fg: input.error ? "warning" : "muted" }]]
  else {
    const suggestions = contextSuggestions(report)
    const sections = (w: number) => [...resources(report, w), ...(suggestions.length ? [[{ text: "Suggestions", fg: "primary", bold: true }] as Line, ...suggestions.flatMap((text) => wrap(text, w).map((text): Line => [label(text)]))] : [])]
    if (tab === 2) body = fileRows(report, inner)
    else if (width >= 110) {
      const [main, side] = columns(inner, [3, 2])
      const overviewHeight = Math.min(room, Math.max(18, overview(report, main! - 4).length + 4))
      const left = panelGrid({ width: main!, padding: true, gap: 0, heights: [overviewHeight, Math.max(4, room - overviewHeight)], rows: [[{ title: "Window · ≈tokens", body: (w) => overview(report, w), active: tab === 0 }], [{ title: "Resources", body: sections, scroll: state?.scroll ?? 0 }]] })
      const right = boxPanel({ title: "Largest messages", body: largestRows(report, side! - 4), width: side!, height: room, borderTitle: true, active: tab === 1, scroll: tab === 1 ? state?.scroll ?? 0 : 0 })
      body = beside([{ lines: left, width: main! }, { lines: right, width: side! }])
    } else body = tab === 1 ? [[{ text: "Largest messages", fg: "primary", bold: true }], ...largestRows(report, inner)] : [...overview(report, inner), [], ...sections(inner), ...(!tabbed ? [[{ text: "Largest messages", fg: "primary", bold: true }] as Line, ...largestRows(report, inner)] : [])]
  }
  const start = width >= 110 && tab !== 2 ? 0 : Math.min(state?.scroll ?? 0, Math.max(0, body.length - room))
  const rows = [...head, ...body.slice(start, start + room)]
  while (rows.length < height) rows.push([])
  return rows.slice(0, height).map((row) => [{ text: " " }, ...fit(row, inner), { text: " " }])
}
