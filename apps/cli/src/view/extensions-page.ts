import type { ExtensionInfo, ExtensionsReport } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line } from "../ui/theme"
import type { TerminalRegistration } from "../extensions/runtime"
import { panelGrid, clip, fit } from "./deck"
import { pluginChrome, pluginFrame } from "./plugin-chrome"
import { truncateEnd } from "./session-list"
import { textWidth, wrap } from "./wrap"

/**
 * `/extensions`: what the daemon found for this project (`extensions.list`: name, source, trust, which halves each module
 * has, what the daemon half registered, load errors) and, below it, what the terminal halves registered here (slots, keys,
 * commands, pages) and their problems. Enter opens a row, `t` trusts the project's extensions (the same `tools.trust` as /tools).
 */

export type ExtensionsPageState = { selected: number; /** Keys (`daemon:<file>` / `terminal:<name>`) of the open rows. */ open: readonly string[] }
export type ExtensionsPageAction = { type: "none" } | { type: "close" } | { type: "refresh" } | { type: "trust"; trusted: boolean } | { type: "disable"; name: string; disabled: boolean }

/** `enabled: false` is an extension turned off with `d` (or in /customize): listed, never run in this terminal. `conflicts` are collisions it is part of. */
export type TerminalExtension = TerminalRegistration & { source?: string; errors: string[]; enabled?: boolean; conflicts?: string[] }

export type ExtensionsTier = "minimalist" | "balanced" | "full"

export type ExtensionsPageInput = {
  state: ExtensionsPageState
  report?: ExtensionsReport
  error?: string
  terminal: readonly TerminalExtension[]
  /** Problems no extension owns: invalid `keybindings.json` entries and key conflicts. */
  terminalProblems: readonly string[]
  /** Project extensions left unloaded in this terminal because the directory is not trusted. */
  skipped?: number
  /** Minimalist keeps the page to what is broken (a conflict count, errors); balanced and full add per-extension context cost and every collision. */
  tier?: ExtensionsTier
  width: number
  height: number
  glyphs?: Glyphs
}

const NONE: ExtensionsPageAction = { type: "none" }
const MINIMALIST_CONFLICTS = "something was replaced by another extension · /tier balanced shows which"
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const HINTS = ["↑↓ select · enter open · d disable/enable · t trust project · r refresh · esc back", "↑↓ · enter · d disable · t trust · esc back", "esc back"]
const EMPTY = "no extensions found · add a folder or file under <data dir>/extensions or .mendcode/extensions"

export function createExtensionsPageState(): ExtensionsPageState {
  return { selected: 0, open: [] }
}

export type Item =
  | { kind: "daemon"; key: string; info: ExtensionInfo }
  | { kind: "terminal"; key: string; extension: TerminalExtension }

export function extensionItems(report: ExtensionsReport | undefined, terminal: readonly TerminalExtension[]): Item[] {
  return [
    ...(report?.extensions ?? []).map((info): Item => ({ kind: "daemon", key: `daemon:${info.file}`, info })),
    ...terminal.map((extension): Item => ({ kind: "terminal", key: `terminal:${extension.name}`, extension })),
  ]
}

const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))

/** Handles one raw key. Returns the same state object when nothing changed. */
export function extensionsPageKey(state: ExtensionsPageState, key: string, items: readonly Item[], report?: ExtensionsReport): { state: ExtensionsPageState; action: ExtensionsPageAction } {
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  if (key === "r" || key === "R") return { state, action: { type: "refresh" } }
  const selected = clamp(state.selected, items.length)
  const go = (index: number) => {
    const next = clamp(index, items.length)
    return next === state.selected ? { state, action: NONE } : { state: { ...state, selected: next }, action: NONE }
  }
  if (UP.has(key)) return go(selected - 1)
  if (DOWN.has(key)) return go(selected + 1)
  if (key === "\r" || key === " ") {
    const item = items[selected]
    if (!item) return { state, action: NONE }
    const open = state.open.includes(item.key) ? state.open.filter((entry) => entry !== item.key) : [...state.open, item.key]
    return { state: { ...state, open }, action: NONE }
  }
  if (key === "d") {
    const item = items[selected]
    if (!item) return { state, action: NONE }
    // Turning off is by name and covers both halves: the daemon's setting and this terminal's profile.
    const off = item.kind === "daemon" ? item.info.disabled === true : item.extension.enabled === false
    return { state, action: { type: "disable", name: item.kind === "daemon" ? item.info.name : item.extension.name, disabled: !off } }
  }
  if (key === "t") {
    const project = (report?.extensions ?? []).filter((info) => info.source === "project")
    if (project.length === 0) return { state, action: NONE }
    return { state, action: { type: "trust", trusted: !project.every((info) => info.trusted) } }
  }
  return { state, action: NONE }
}

const list = (label: string, values: readonly string[]): string[] => (values.length ? [`${label}  ${values.join(", ")}`] : [])
const count = (values: readonly unknown[], noun: string) => (values.length ? `${values.length} ${noun}${values.length === 1 ? "" : "s"}` : "")
const joinCounts = (parts: string[]) => parts.filter(Boolean).join(" · ")

function halves(info: ExtensionInfo) {
  if (info.daemon && info.tui) return "daemon + tui"
  if (info.daemon) return "daemon"
  if (info.tui) return "tui"
  return "not loaded"
}

function trustLabel(info: ExtensionInfo): { text: string; fg: ColorName } {
  if (info.source !== "project") return { text: "trusted", fg: "success" }
  return info.trusted ? { text: "trusted", fg: "success" } : { text: "not trusted", fg: "warning" }
}

function headRow(input: { selected: boolean; dot: ColorName; name: string; cells: Array<{ text: string; fg: ColorName; width: number }>; width: number; nameWidth: number; glyphs: Glyphs; expanded: boolean }): Line {
  const { selected, width } = input
  const row: Line = [selected ? { text: `${input.glyphs.user} `, fg: "primary", bold: true } : { text: "  " }, { text: input.expanded ? "▾ " : "▸ ", fg: "muted" }, { text: "● ", fg: input.dot }, { text: truncateEnd(input.name, input.nameWidth).padEnd(input.nameWidth), fg: selected ? "primary" : "text", bold: selected }]
  for (const cell of input.cells) {
    if (textWidth(row.map((span) => span.text).join("")) + 2 + cell.width > width) break
    row.push({ text: "  " }, { text: truncateEnd(cell.text, cell.width).padEnd(cell.width), fg: cell.fg })
  }
  return fit(row, width)
}

function detail(lines: string[], width: number, tone: ColorName = "muted"): Line[] {
  return lines.map((text): Line => clip([{ text: "      " }, { text: truncateEnd(text, Math.max(1, width - 6)), fg: tone }], width))
}

/** `~320 tok` for the tool schemas an extension adds to every request; empty when it adds none (or the tier keeps the page minimal). */
const costText = (info: ExtensionInfo, tier: ExtensionsTier) => (tier === "minimalist" || !info.context || (info.context.tokens === 0 && info.context.rewrites.length === 0) ? "" : `~${info.context.tokens}${info.context.rewrites.length ? "+" : ""} tok`)

function contextDetail(info: ExtensionInfo): string[] {
  const context = info.context
  if (!context) return []
  return [
    `context  ~${context.tokens} tokens per request${context.tools.length ? ` · ${context.tools.map((tool) => `${tool.name} ~${tool.tokens}${tool.offered ? "" : " (not offered at your tier)"}`).join(", ")}` : ""}`,
    ...(context.rewrites.length ? [`context  ${context.rewrites.join(", ")} may rewrite what the model reads: cost not measured`] : []),
  ]
}

function daemonRows(input: { info: ExtensionInfo; selected: boolean; open: boolean; width: number; nameWidth: number; glyphs: Glyphs; tier?: ExtensionsTier }): Line[] {
  const { info, width } = input
  const tier = input.tier ?? "balanced"
  const trust: { text: string; fg: ColorName } = info.disabled ? { text: "disabled", fg: "warning" } : trustLabel(info)
  const what = joinCounts([count(info.tools, "tool"), count(info.commands, "command"), count(info.hooks, "hook")])
  const stopped = info.breaker?.length ?? 0
  const conflicts = info.conflicts?.length ?? 0
  const dot: ColorName = info.disabled ? "muted" : info.errors.length ? "error" : stopped || conflicts || info.kept ? "warning" : info.trusted || info.source !== "project" ? "success" : "warning"
  const cost = costText(info, tier)
  const rows: Line[] = [
    headRow({
      selected: input.selected,
      dot,
      name: info.name,
      cells: [
        { text: info.source, fg: "muted", width: 7 },
        { text: trust.text, fg: trust.fg, width: 11 },
        { text: halves(info), fg: "text", width: 12 },
        { text: what, fg: "muted", width: 36 },
        ...(cost ? [{ text: cost, fg: "muted" as ColorName, width: 10 }] : []),
        ...(conflicts ? [{ text: `${conflicts} conflict${conflicts === 1 ? "" : "s"}`, fg: "warning" as ColorName, width: 11 }] : []),
        ...(stopped ? [{ text: `${stopped} stopped`, fg: "warning" as ColorName, width: 10 }] : []),
        ...(info.kept ? [{ text: "kept old", fg: "warning" as ColorName, width: 8 }] : []),
        ...(info.errors.length ? [{ text: `${info.errors.length} error${info.errors.length === 1 ? "" : "s"}`, fg: "error" as ColorName, width: 9 }] : []),
      ],
      width,
      nameWidth: input.nameWidth,
      glyphs: input.glyphs,
      expanded: input.open,
    }),
  ]
  if (!input.open) return rows
  rows.push(
    ...detail([`file  ${info.file}`, ...(info.pluginId ? [`plugin  ${info.pluginId}`, `ABI  ${info.abi ?? "v2"}`] : []), ...(info.authProvider ? [`auth  ${info.authProvider}`] : []), ...(info.provider ? [`provider  ${info.provider}`] : []), ...list("tools", info.tools), ...list("commands", info.commands), ...list("hooks", info.hooks), ...(tier === "minimalist" ? [] : contextDetail(info))], width),
    ...(info.disabled ? detail(["turned off: nothing of it runs · press d to turn it on"], width, "warning") : []),
    ...(info.source === "project" && !info.trusted ? detail(["not trusted: press t to let this project's extensions load"], width, "warning") : []),
    ...(info.kept ? detail([`reload failed, the previous version keeps running: ${info.kept}`], width, "warning") : []),
    ...detail((info.breaker ?? []).map((key) => `stopped for this session after repeated failures: ${key} · reload (/extensions reload) turns it back on`), width, "warning"),
    ...(tier === "minimalist" ? [] : detail(info.conflicts ?? [], width, "warning")),
    ...detail(info.errors, width, "error"),
  )
  return rows
}

function terminalRows(input: { extension: TerminalExtension; selected: boolean; open: boolean; width: number; nameWidth: number; glyphs: Glyphs; tier?: ExtensionsTier }): Line[] {
  const { extension, width } = input
  const off = extension.enabled === false
  const conflicts = extension.conflicts ?? []
  const what = joinCounts([count(extension.slots, "slot"), count(extension.keys, "key"), count(extension.commands, "command"), count(extension.pages, "page"), count(extension.modals ?? [], "modal"), count(extension.actions ?? [], "action"), count(extension.renderers, "renderer"), count(Array.from({ length: extension.transforms }), "transform")])
  const rows: Line[] = [
    headRow({
      selected: input.selected,
      dot: off ? "muted" : extension.errors.length ? "error" : conflicts.length ? "warning" : "success",
      name: extension.name,
      cells: [
        { text: extension.source ?? "terminal", fg: "muted", width: 7 },
        { text: off ? "disabled" : what || "nothing registered", fg: off ? "warning" : "muted", width: 52 },
        ...(conflicts.length ? [{ text: `${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`, fg: "warning" as ColorName, width: 11 }] : []),
        ...(extension.errors.length ? [{ text: `${extension.errors.length} error${extension.errors.length === 1 ? "" : "s"}`, fg: "error" as ColorName, width: 9 }] : []),
      ],
      width,
      nameWidth: input.nameWidth,
      glyphs: input.glyphs,
      expanded: input.open,
    }),
  ]
  if (!input.open) return rows
  rows.push(
    ...detail([...list("slots", extension.slots), ...list("keys", extension.keys), ...list("commands", extension.commands), ...list("pages", extension.pages), ...list("modals", extension.modals ?? []), ...list("actions", extension.actions ?? []), ...list("renderers", extension.renderers)], width),
    ...(off ? detail(["turned off: nothing of it runs here · press d to turn it on"], width, "warning") : []),
    ...(input.tier === "minimalist" ? [] : detail(conflicts, width, "warning")),
    ...detail(extension.errors, width, "error"),
  )
  return rows
}

const title = (text: string, note: string): Line => [{ text, fg: "text", bold: true }, { text: note ? `  ${note}` : "", fg: "muted" }]

/** Renders exactly `height` lines of at most `width` cells. */
export function renderExtensionsPage(input: ExtensionsPageInput): Line[] {
  const { state, report, terminal, width, height } = input
  if (height <= 0 || width <= 0) return []
  const glyphs = input.glyphs ?? defaultGlyphs()
  const inner = Math.max(1, width - 2)
  const items = extensionItems(report, terminal)
  const selected = clamp(state.selected, items.length)
  const tier = input.tier ?? "balanced"
  const nameWidth = Math.max(6, Math.min(22, Math.floor(inner / 4), Math.max(...items.map((item) => textWidth(item.kind === "daemon" ? item.info.name : item.extension.name)), 6)))
  let body: Line[] = []
  let focusLine = 0

  const push = (item: Item, rows: Line[]) => {
    if (items[selected]?.key === item.key) focusLine = body.length
    body.push(...rows)
  }
  body.push(title("Daemon", report ? `${report.extensions.length} found for this project` : (input.error ?? "loading…")))
  if (input.error && !report) body.push([{ text: truncateEnd(input.error, inner), fg: "warning" }])
  else if (report && report.extensions.length === 0) body.push([{ text: truncateEnd(EMPTY, inner), fg: "muted" }])
  for (const item of items) {
    if (item.kind !== "daemon") continue
    push(item, daemonRows({ info: item.info, selected: items[selected]?.key === item.key, open: state.open.includes(item.key), width: inner, nameWidth, glyphs, tier }))
  }
  body.push([], title("Terminal", `${terminal.length} loaded in this terminal`))
  if (terminal.length === 0) body.push([{ text: "no terminal extensions loaded", fg: "muted" }])
  for (const item of items) {
    if (item.kind !== "terminal") continue
    push(item, terminalRows({ extension: item.extension, selected: items[selected]?.key === item.key, open: state.open.includes(item.key), width: inner, nameWidth, glyphs, tier }))
  }
  if ((input.skipped ?? 0) > 0) body.push([{ text: truncateEnd(`${input.skipped} project extension${input.skipped === 1 ? "" : "s"} not loaded here: directory not trusted (press t)`, inner), fg: "warning" }])
  const conflictLines = [...new Set([...(report?.conflicts ?? []).map((entry) => entry.note), ...terminal.flatMap((extension) => extension.conflicts ?? [])])]
  if (conflictLines.length > 0) {
    body.push([], title("Conflicts", `${conflictLines.length}`))
    // Minimalist names that there are collisions; balanced and full say who won and who lost.
    if (tier === "minimalist") body.push([{ text: truncateEnd(MINIMALIST_CONFLICTS, inner), fg: "warning" }])
    else for (const note of conflictLines) body.push([{ text: truncateEnd(note, inner), fg: "warning" }])
  }
  if (input.terminalProblems.length > 0) {
    body.push([], title("Other problems", ""))
    for (const problem of input.terminalProblems) body.push([{ text: truncateEnd(problem, inner), fg: "warning" }])
  }

  const errors = (report?.extensions.reduce((sum, extension) => sum + extension.errors.length, 0) ?? 0) + terminal.reduce((sum, extension) => sum + extension.errors.length, 0) + input.terminalProblems.length
  const untrusted = (report?.extensions ?? []).filter((info) => info.source === "project" && !info.trusted).length
  const hints = HINTS.find((text) => textWidth(text) <= Math.max(8, width - 16)) ?? "esc back"
  const room = Math.max(0, height - pluginChrome)
  if (width >= 70 && items.length) {
    const picked = items[selected]!
    const statusOf = (info: ExtensionInfo) => (info.disabled ? "disabled" : trustLabel(info).text)
    // What needs a look comes first in the muted line: cost (balanced and full), collisions, stopped handlers, a kept version, errors.
    const flags = (info: ExtensionInfo) => [costText(info, tier), info.conflicts?.length ? `${info.conflicts.length} conflict${info.conflicts.length === 1 ? "" : "s"}` : "", info.breaker?.length ? `${info.breaker.length} stopped` : "", info.kept ? "kept old" : ""].filter(Boolean)
    const summaryOf = (item: Item) => item.kind === "daemon"
      ? `${item.info.name}  ${item.info.source}  ${statusOf(item.info)}  ${halves(item.info)}  ${joinCounts([count(item.info.tools, "tool"), count(item.info.commands, "command"), count(item.info.hooks, "hook"), ...flags(item.info)])}${item.info.errors.length ? ` · ${item.info.errors.length} error` : ""}`
      : `${item.extension.name}  ${item.extension.source}  ${joinCounts([...(item.extension.enabled === false ? ["disabled"] : []), count(item.extension.slots, "slot"), count(item.extension.keys, "key"), count(item.extension.commands, "command"), count(item.extension.pages, "page"), count(item.extension.modals ?? [], "modal"), count(item.extension.actions ?? [], "action"), count(item.extension.renderers, "renderer"), ...(item.extension.conflicts?.length ? [`${item.extension.conflicts.length} conflict${item.extension.conflicts.length === 1 ? "" : "s"}`] : [])])}`
    const list = (w: number) => items.flatMap((item): Line[] => [
      [{ text: `${item.key === picked.key ? "› " : "  "}${item.kind === "daemon" ? `${item.info.name}  ${item.info.source}  ${statusOf(item.info)}` : `${item.extension.name}  ${item.extension.source}`}`, fg: item.key === picked.key ? "primary" : "text", bold: item.key === picked.key }],
      ...wrap(summaryOf(item).split("  ").slice(item.kind === "daemon" ? 3 : 2).join(" · "), w - 2).map((text): Line => [{ text: `  ${text}`, fg: "muted" }]),
    ])
    const details = (w: number): Line[] => [
      ...wrap(summaryOf(picked), w).map((text): Line => [{ text, fg: "text" }]),
      ...(picked.kind === "daemon" ? daemonRows({ info: picked.info, selected: true, open: state.open.includes(picked.key), width: w, nameWidth: 22, glyphs, tier }) : terminalRows({ extension: picked.extension, selected: true, open: state.open.includes(picked.key), width: w, nameWidth: 22, glyphs, tier })).slice(1),
    ]
    const summaryRows: Line[] = [
      [{ text: `Daemon ${report?.extensions.length ?? 0} found for this project · Terminal ${terminal.length} loaded`, fg: "text" }],
      [{ text: `${errors} errors · ${untrusted} untrusted${conflictLines.length ? ` · ${conflictLines.length} conflicts` : ""}`, fg: "muted" }],
      ...(tier === "minimalist" ? (conflictLines.length ? [[{ text: MINIMALIST_CONFLICTS, fg: "warning" } as const]] : []) : conflictLines.map((text): Line => [{ text, fg: "warning" }])),
      ...((input.skipped ?? 0) > 0 ? [[{ text: `${input.skipped} project extensions not loaded: directory not trusted (press t)`, fg: "warning" } as const]] : []),
      ...(input.terminalProblems.length ? [[{ text: "Other problems", fg: "warning" } as const], ...input.terminalProblems.map((text): Line => [{ text, fg: "warning" }])] : []),
    ]
    const summaryHeight = Math.min(Math.max(6, summaryRows.length + 4), Math.max(6, room - 10))
    // Variable-height entries keep the selected extension in the list's visible window.
    body = panelGrid({ width: inner, compact: false, padding: true, heights: [summaryHeight, Math.max(3, room - summaryHeight - 1)], rows: [
      [{ title: "Summary", body: summaryRows }],
      [{ title: "Extensions", weight: 2, body: (w) => {
        const lines = list(w)
        const focus = Math.max(0, lines.findIndex((row) => row.some((span) => span.text.startsWith("› "))))
        const offset = Math.max(0, focus + 3 - (room - summaryHeight - 3))
        return lines.slice(offset)
      } }, { title: "Selected extension", weight: 3, body: details }],
    ] })
    focusLine = 0
  }
  return pluginFrame({
    title: "Extensions",
    body,
    scroll: Math.max(0, focusLine + 2 - room),
    hints,
    width,
    height,
  })
}
