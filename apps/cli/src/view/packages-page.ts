import type { PackageInfo, PackagesReport } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line } from "../ui/theme"
import { isWide } from "../ui/breakpoints"
import { panelGrid } from "./deck"
import { pickerFrame } from "./picker-frame"
import { relativeTime, shortenMiddle, truncateEnd } from "./session-list"
import { textWidth, wrap } from "./wrap"
import { PROGRAM_NAME } from "@mendcode/program"

/** One package's switchable resources (`c`): `resources` is undefined until the daemon answers. */
export type PackagesConfigState = { key: string; selected: number; resources?: Array<{ id: string; kind: string; name: string; enabled: boolean }> }
/** What a package's activation overrides right now (`o`): `selected` is the row, `key` the package. */
export type PackagesOverridesState = { key: string; selected: number }
export type PackagesPageState = { selected: number; confirm?: { key: string }; confirmAll?: boolean; scroll?: number; config?: PackagesConfigState; overrides?: PackagesOverridesState }

/** One thing an enabled package overrides: a profile key, a keybinding, a prompt file or a view slot. `kept`: the user chose their own. */
export type ActivationRowView = { package: string; part: string; key: string; value: string; base?: string; mine?: string; kept: boolean }
/** What `/packages` shows of the activation layer; built from the terminal's activation (see `activationView`). */
export type PackagesActivationView = { rows: ActivationRowView[]; owners: string[]; waiting: Array<{ package: string; owner: string; changes: string[] }>; conflicts: string[]; problems: string[] }

const shown = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value) ?? "—"

/** The activation as the page draws it; undefined when no enabled package has one. */
export type ActivationLive = { result: { rows: Array<{ package: string; part: string; key: string; value: unknown; base?: unknown; kept: boolean; mine?: unknown }>; owners: Partial<Record<string, string>>; waiting: Array<{ package: string; owner: string; changes: string[] }>; conflicts: string[] }; problems: string[] }

export function activationView(live: ActivationLive | undefined): PackagesActivationView | undefined {
  if (!live) return undefined
  return {
    rows: live.result.rows.map((row) => ({ package: row.package, part: row.part, key: row.key, value: truncateEnd(shown(row.value), 60), ...(row.base !== undefined ? { base: truncateEnd(shown(row.base), 40) } : {}), ...(row.mine !== undefined ? { mine: truncateEnd(shown(row.mine), 40) } : {}), kept: row.kept })),
    owners: Object.values(live.result.owners).filter((owner): owner is string => owner !== undefined),
    waiting: live.result.waiting,
    conflicts: live.result.conflicts,
    problems: live.problems,
  }
}

export type PackagesPageAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "reload" }
  | { type: "marketplace" }
  | { type: "precedence" }
  | { type: "disable-all" }
  | { type: "enable"; key: string; enabled: boolean; switch?: boolean }
  | { type: "keep"; key: string; on: boolean }
  | { type: "remove"; name: string; scope: PackageInfo["source"] }
  | { type: "config"; key: string }
  | { type: "resource"; key: string; resource: string; enabled: boolean }

const NONE: PackagesPageAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const MAX_DESCRIPTION_LINES = 4
const LABEL_WIDTH = 10
const STATE_WIDTH = 7
const HINTS = "↑↓ select · space/e on/off · o overrides · p precedence · c resources · d remove · x deselect all · m marketplace · r reload · esc back"
const OVERRIDES_HINTS = "↑↓ select · k keep mine / use package · d turn package off · esc back"
const CONFIG_HINTS = "↑↓ select · space/e on/off · esc back"
const CONFIRM_HINTS = "d/y remove · esc cancel"
const EMPTY = `no packages · install with: ${PROGRAM_NAME} package install <folder|github:owner/repo>`
const WIDE_HEIGHT = 24

export function createPackagesPageState(): PackagesPageState {
  return { selected: 0 }
}

const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))

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

/** Handles one raw key. Returns the same state object when nothing changed. */
export function packagesPageKey(state: PackagesPageState, key: string, packages: PackageInfo[], live?: ActivationLive): { state: PackagesPageState; action: PackagesPageAction } {
  const activation = activationView(live)
  if (state.config) return configKey(state, state.config, key)
  if (state.overrides) return overridesKey(state, state.overrides, key, activation)
  if (state.confirmAll) { const { confirmAll, ...rest } = state; return { state: rest, action: key === "y" ? { type: "disable-all" } : NONE } }
  if (key === "m") return { state, action: { type: "marketplace" } }
  if (key === "x" && packages.some((pkg) => pkg.enabled)) return { state: { ...state, confirmAll: true }, action: NONE }
  const selected = clamp(state.selected, packages.length)
  const target = packages[selected]
  const { confirm, ...withoutConfirm } = state
  if (confirm) {
    if ((key === "d" || key === "y") && target?.key === confirm.key) return { state: withoutConfirm, action: { type: "remove", name: target.name, scope: target.source } }
    return { state: withoutConfirm, action: NONE }
  }
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  if (key === "r") return { state, action: { type: "reload" } }
  if (key === "[" || key === "]") return { state: { ...state, scroll: Math.max(0, (state.scroll ?? 0) + (key === "]" ? 4 : -4)) }, action: NONE }
  const move = (index: number) => {
    const next = clamp(index, packages.length)
    return next === state.selected ? { state, action: NONE } : { state: { ...state, selected: next, scroll: 0 }, action: NONE }
  }
  if (UP.has(key)) return move(selected - 1)
  if (DOWN.has(key)) return move(selected + 1)
  if (key === "p") return { state, action: { type: "precedence" } }
  if (!target) return { state, action: NONE }
  if (key === " " || key === "e") return { state, action: { type: "enable", key: target.key, enabled: !target.enabled } }
  if (key === "c") return { state: { ...state, selected, config: { key: target.key, selected: 0 } }, action: { type: "config", key: target.key } }
  if (key === "o") return { state: { ...state, selected, overrides: { key: target.key, selected: 0 } }, action: NONE }
  if (key === "d") return { state: { ...state, selected, confirm: { key: target.key } }, action: NONE }
  return { state, action: NONE }
}

/** The rows of the activation that belong to one package. */
export function overrideRows(activation: PackagesActivationView | undefined, key: string): ActivationRowView[] {
  return (activation?.rows ?? []).filter((row) => row.package === key)
}

const keepable = (row: ActivationRowView) => row.part !== "prompt" && row.part !== "view"
const keptName = (row: ActivationRowView) => row.part === "keybinding" ? `keybindings:${row.key}` : row.key

function overridesKey(state: PackagesPageState, overrides: PackagesOverridesState, key: string, activation: PackagesActivationView | undefined): { state: PackagesPageState; action: PackagesPageAction } {
  const rows = overrideRows(activation, overrides.key)
  const selected = clamp(overrides.selected, rows.length)
  const move = (index: number) => ({ state: { ...state, overrides: { ...overrides, selected: clamp(index, rows.length) } }, action: NONE })
  if (key === "\x1b" || key === "q") { const { overrides: _closed, ...rest } = state; return { state: rest, action: NONE } }
  if (UP.has(key)) return move(selected - 1)
  if (DOWN.has(key)) return move(selected + 1)
  const target = rows[selected]
  if (target && keepable(target) && (key === "k" || key === " " || key === "\r")) return { state, action: { type: "keep", key: keptName(target), on: !target.kept } }
  if (key === "d") { const { overrides: _closed, ...rest } = state; return { state: rest, action: { type: "enable", key: overrides.key, enabled: false } } }
  return { state, action: NONE }
}

function overridesRows(key: string, activation: PackagesActivationView | undefined, selected: number, width: number, capacity: number): Line[] {
  const rows = overrideRows(activation, key)
  const waiting = activation?.waiting.find((entry) => entry.package === key)
  const head: Line[] = waiting ? [clampLine([{ text: `look inactive: ${waiting.owner} owns it. Enabling ${key} again asks to switch.`, fg: "warning" }], width)] : []
  if (!rows.length && !waiting) return [[{ text: "this package overrides nothing right now", fg: "muted" }]]
  const at = clamp(selected, rows.length)
  const room = Math.max(1, capacity - head.length)
  const offset = Math.max(0, at - room + 1)
  const label = Math.max(8, Math.floor(width * 0.35))
  return [...head, ...rows.slice(offset, offset + room).map((row, i): Line => {
    const name = row.part === "keybinding" ? `key ${row.key}` : row.part === "view" ? `view ${row.key}` : row.key
    const change = row.part === "prompt" ? "replaces the prompt file" : row.kept ? `${row.mine ?? row.base ?? "default"}  (yours, kept)` : `${row.base !== undefined ? `${row.base} → ` : ""}${row.value}`
    return clampLine([
      offset + i === at ? { text: "› ", fg: "primary", bold: true } : { text: "  " },
      { text: truncateEnd(name, label).padEnd(label), fg: offset + i === at ? "primary" : "text", bold: offset + i === at },
      { text: ` ${change}`, fg: row.kept ? "success" : "muted" },
    ], width)
  })]
}

function configKey(state: PackagesPageState, config: PackagesConfigState, key: string): { state: PackagesPageState; action: PackagesPageAction } {
  const resources = config.resources ?? []
  const selected = clamp(config.selected, resources.length)
  const move = (index: number) => ({ state: { ...state, config: { ...config, selected: clamp(index, resources.length) } }, action: NONE })
  if (key === "\x1b" || key === "q") { const { config: _closed, ...rest } = state; return { state: rest, action: NONE } }
  if (UP.has(key)) return move(selected - 1)
  if (DOWN.has(key)) return move(selected + 1)
  const target = resources[selected]
  if (target && (key === " " || key === "e" || key === "\r")) return { state, action: { type: "resource", key: config.key, resource: target.id, enabled: !target.enabled } }
  return { state, action: NONE }
}

function configRows(config: PackagesConfigState, width: number, capacity: number): Line[] {
  const resources = config.resources
  if (!resources) return [[{ text: "loading resources…", fg: "muted" }]]
  if (!resources.length) return [[{ text: "this package ships no switchable resources", fg: "muted" }]]
  const selected = clamp(config.selected, resources.length)
  const offset = Math.max(0, selected - capacity + 1)
  return resources.slice(offset, offset + capacity).map((resource, i): Line => clampLine([
    offset + i === selected ? { text: "› ", fg: "primary", bold: true } : { text: "  " },
    { text: "● ", fg: resource.enabled ? "success" : "muted" },
    { text: truncateEnd(resource.id, Math.max(1, width - 12)), fg: offset + i === selected ? "primary" : "text", bold: offset + i === selected },
    { text: ` ${(resource.enabled ? "on" : "off").padStart(3)}`, fg: resource.enabled ? "success" : "muted" },
  ], width))
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** "2 tools, 1 skill, 3 commands, 1 theme, mcp"; zero counts are omitted. */
export function describeContents(contents: PackageInfo["contents"]): string {
  const parts = [
    contents.tools ? plural(contents.tools, "tool") : "",
    contents.skills ? plural(contents.skills, "skill") : "",
    contents.commands ? plural(contents.commands, "command") : "",
    contents.themes ? plural(contents.themes, "theme") : "",
    contents.mcp ? "mcp" : "",
    contents.agents ? plural(contents.agents, "agent") : "",
    contents.extensions ? plural(contents.extensions, "extension") : "",
  ].filter(Boolean)
  return parts.length ? parts.join(", ") : "—"
}

function stateOf(pkg: PackageInfo): { label: string; fg: ColorName } {
  if (pkg.problem) return { label: "problem", fg: "error" }
  return pkg.enabled ? { label: "on", fg: "success" } : { label: "off", fg: "muted" }
}

function summaryOf(packages: PackageInfo[]): string {
  if (packages.length === 0) return "no packages"
  const off = packages.filter((pkg) => !pkg.enabled).length
  const problems = packages.filter((pkg) => pkg.problem).length
  return [plural(packages.length, "package"), off ? `${off} off` : "", problems ? plural(problems, "problem") : ""].filter(Boolean).join(" · ")
}

function installedText(installedAt: number, now: number | undefined): string {
  const date = new Date(installedAt)
  const two = (value: number) => String(value).padStart(2, "0")
  const stamp = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
  if (now === undefined) return stamp
  const ago = relativeTime(now, installedAt)
  return `${stamp} · ${ago === "now" ? "just now" : `${ago} ago`}`
}

type Widths = { key: number; version: number }

function packageRow(input: { pkg: PackageInfo; selected: boolean; width: number; widths: Widths; glyphs: Glyphs }): Line {
  const { pkg, selected, width, widths, glyphs } = input
  const state = stateOf(pkg)
  const room = Math.max(0, width - 4 - STATE_WIDTH - 1)
  const keyWidth = Math.max(1, Math.min(widths.key, room))
  let rest = room - keyWidth
  const versionCol = widths.version > 0 && rest >= widths.version + 1 ? widths.version + 1 : 0
  rest -= versionCol
  const addsWidth = rest - 1
  const version = pkg.manifest?.version ?? ""
  const line: Line = [
    selected ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " },
    { text: "● ", fg: state.fg },
    { text: truncateEnd(pkg.key, keyWidth).padEnd(keyWidth), fg: selected ? "primary" : "text", bold: selected },
  ]
  if (versionCol) line.push({ text: ` ${truncateEnd(version, widths.version).padEnd(widths.version)}`, fg: "muted" })
  if (addsWidth >= 8) line.push({ text: ` ${truncateEnd(describeContents(pkg.contents), addsWidth).padEnd(addsWidth)}`, fg: "muted" })
  else line.push({ text: " ".repeat(Math.max(0, rest)) })
  line.push({ text: ` ${state.label.padStart(STATE_WIDTH)}`, fg: state.fg })
  return clampLine(line, width)
}

function wrapped(text: string, width: number, max: number, indent: string, fg: ColorName): Line[] {
  const lines = wrap(text.replace(/\s+/g, " ").trim(), Math.max(1, width - indent.length))
  return lines.slice(0, max).map((line, i): Line => [{ text: indent }, { text: i === max - 1 && lines.length > max ? truncateEnd(`${line} …`, width - indent.length) : line, fg }])
}

function detailRows(pkg: PackageInfo, width: number, now: number | undefined, activation?: PackagesActivationView): Line[] {
  const state = stateOf(pkg)
  const kv = (label: string, value: string, options: { fg?: ColorName; middle?: boolean } = {}): Line => {
    const room = Math.max(1, width - LABEL_WIDTH)
    return clampLine([{ text: label.padEnd(LABEL_WIDTH), fg: "muted" }, { text: options.middle ? shortenMiddle(value, room) : truncateEnd(value, room), fg: options.fg ?? "body" }], width)
  }
  const manifest = pkg.manifest
  const title: Line = [{ text: truncateEnd(pkg.key, Math.max(1, width - 12)), fg: "text", bold: true }]
  if (manifest) title.push({ text: ` · ${manifest.version}`, fg: "muted" })
  title.push({ text: ` · ${state.label}`, fg: state.fg })
  const rows: Line[] = [clampLine(title, width)]
  if (pkg.problem) rows.push(...wrapped(pkg.problem, width, Number.MAX_SAFE_INTEGER, "", "error"))
  if (manifest?.description) rows.push(...wrapped(manifest.description, width, MAX_DESCRIPTION_LINES, "", "body"))
  if (manifest?.author) rows.push(kv("author", manifest.author))
  if (manifest?.homepage) rows.push(kv("homepage", manifest.homepage, { fg: "link", middle: true }))
  if (manifest?.license) rows.push(kv("license", manifest.license))
  const adds = wrap(describeContents(pkg.contents), Math.max(1, width - LABEL_WIDTH)).slice(0, 2)
  adds.forEach((text, i) => rows.push(clampLine([{ text: (i === 0 ? "adds" : "").padEnd(LABEL_WIDTH), fg: "muted" }, { text, fg: "body" }], width)))
  const own = overrideRows(activation, pkg.key)
  const waiting = activation?.waiting.find((entry) => entry.package === pkg.key)
  if (own.length) rows.push(kv("overrides", `${own.filter((row) => !row.kept).length} active${own.some((row) => row.kept) ? `, ${own.filter((row) => row.kept).length} yours` : ""} · o lists them`, { fg: "primary" }))
  if (waiting) rows.push(kv("look", `waiting: ${waiting.owner} owns it`, { fg: "warning" }))
  rows.push(kv("context", pkg.contextCost ? `idle ~${pkg.contextCost.idleTokens} tokens` : "unknown"))
  if (pkg.contextCost) rows.push(kv("on-demand", `~${pkg.contextCost.onDemandTokens} tokens (total)`))
  if (pkg.install) {
    rows.push(kv("source", pkg.install.source, { middle: true }))
    if (pkg.install.commit) rows.push(kv("commit", pkg.install.commit.slice(0, 7)))
    if (pkg.install.integrity) rows.push(kv("digest", pkg.install.integrity.slice(0, 20)))
    if (pkg.install.pinned) rows.push(kv("pinned", "yes"))
    rows.push(kv("installed", installedText(pkg.install.installedAt, now)))
  }
  rows.push(kv("folder", pkg.dir, { fg: "muted", middle: true }))
  return rows
}

function emptyRows(width: number): Line[] {
  const text = textWidth(EMPTY) <= width ? [EMPTY] : wrap(EMPTY, width)
  return text.map((line): Line => clampLine([{ text: line, fg: "muted" }], width))
}

/** Renders exactly `height` lines of at most `width` cells. `report` is undefined until the first load answers. */
export function renderPackagesPage(input: { report: PackagesReport | undefined; error?: string | undefined; state: PackagesPageState; width: number; height: number; now?: number; glyphs?: Glyphs; activation?: ActivationLive | undefined }): Line[] {
  const { report, state, width, height, now } = input
  const activation = activationView(input.activation)
  const glyphs = input.glyphs ?? defaultGlyphs()
  const packages = report?.packages ?? []
  const selected = clamp(state.selected, packages.length)
  const room = Math.max(0, height - 2)
  if (state.config) {
    const config = state.config
    const off = config.resources?.filter((resource) => !resource.enabled).length ?? 0
    const panel = { title: `Resources · ${config.key}`, active: true, weight: 1, body: (w: number): Line[] => configRows(config, w, Math.max(1, room - 4)) }
    return pickerFrame(`Packages · ${config.key}`, CONFIG_HINTS, width, height, panelGrid({ width, rows: [[panel]], heights: [room], compact: false, padding: true, maxColumns: 1 }), input.error ? `Error · ${input.error}` : config.resources ? `${plural(config.resources.length, "resource")}${off ? ` · ${off} off` : ""}` : "")
  }
  if (state.overrides) {
    const overrides = state.overrides
    const rows = overrideRows(activation, overrides.key)
    const panel = { title: `Overrides · ${overrides.key}`, active: true, weight: 1, body: (w: number): Line[] => overridesRows(overrides.key, activation, overrides.selected, w, Math.max(1, room - 4)) }
    const kept = rows.filter((row) => row.kept).length
    return pickerFrame(`Packages · ${overrides.key}`, OVERRIDES_HINTS, width, height, panelGrid({ width, rows: [[panel]], heights: [room], compact: false, padding: true, maxColumns: 1 }), input.error ? `Error · ${input.error}` : `${plural(rows.length, "override")}${kept ? ` · ${kept} yours` : ""}`)
  }
  const split = isWide(width) && height >= WIDE_HEIGHT
  const confirming = !!state.confirm
  const notice = state.confirmAll ? "Deselect all packages? y confirms · any key cancels" : input.error || (confirming ? `remove ${packages[selected]?.key}? d or y confirms · any key cancels` : "")
  const summary = notice ? `${state.confirmAll ? "Confirm deselect all" : confirming ? "Confirm remove" : "Error"} · ${notice}` : report ? summaryOf(packages) : ""
  const hints = state.confirmAll ? "y deselect all · esc cancel" : confirming ? CONFIRM_HINTS : HINTS
  const list = { title: "Installed", active: true, weight: 3, body: (w: number): Line[] => {
    if (!report) return [[{ text: input.error || "loading packages…", fg: input.error ? "error" : "muted" }]]
    if (!packages.length) return emptyRows(w)
    const widths: Widths = { key: Math.max(4, Math.min(30, Math.floor(w * 0.4), Math.max(...packages.map((pkg) => textWidth(pkg.key))))), version: Math.min(12, Math.max(...packages.map((pkg) => textWidth(pkg.manifest?.version ?? "")))) }
    const capacity = Math.max(1, (split ? room : Math.floor((room - 1) * 0.4)) - 4)
    const offset = Math.max(0, selected - capacity + 1)
    return packages.slice(offset, offset + capacity).map((pkg, i) => packageRow({ pkg, selected: offset + i === selected, width: w, widths, glyphs }))
  } }
  const detail = { title: "Package", weight: 4, scroll: state.scroll ?? 0, body: (w: number): Line[] => packages[selected] ? detailRows(packages[selected]!, w, now, activation) : [] }
  const top = Math.max(6, Math.floor((room - 1) * 0.4))
  const body = panelGrid({ width, rows: split ? [[list, detail]] : [[list], [detail]], heights: split ? [room] : [top, Math.max(0, room - top - 1)], compact: false, padding: true, maxColumns: split ? 2 : 1 })
  return pickerFrame(`Packages${report ? ` · ${report.directory}` : ""}`, hints, width, height, body, summary)
}
