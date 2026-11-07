import type { ColorName, Line, Span } from "../ui/theme"
import { fit as fitLine, spread } from "./deck"
import { tabsRow, type PageTab } from "./page"
import { actionLabel, DIRECT_KEYS, INLINE_KEYS, LEADER_CHORDS, type BindingAction } from "../ui/keymap"
import { parseKeySpec } from "../extensions/keybindings"
import { PROFILE_KEY_HELP } from "@mendcode/protocol/tui-key-help"
import { GROUPS, LABELS } from "./customize-rows"
import { textWidth, truncateEnd, wrap } from "./wrap"

/**
 * What `/profiles` → `o` shows of one profile's overrides: each override with a human name, a group, and its before and after
 * summarized in words (`default`, on/off, "1 pinned command: retro-crt"), plus the detail of the selected one. Pure: built from
 * the activation rows the terminal already holds.
 */

/** The tabs /profiles and /marketplace share, in this order: 1, 2 and 3 switch between them on both pages. */
export const PROFILE_TABS: PageTab[] = [{ key: "1", label: "What it takes over", short: "Takes over" }, { key: "2", label: "Installed", short: "Installed" }, { key: "3", label: "Marketplace", short: "Market" }]

/** Row two of /profiles and /marketplace: the three tabs on the left (`active` on the element background), `right` after them. */
export function profileTabsRow(input: { active: number; right: string; tone?: ColorName; width: number }): Line {
  const { width } = input
  const tabs = tabsRow(PROFILE_TABS, input.active, Math.max(1, width < 100 ? width : Math.floor(width * 0.55)))
  const used = tabs.reduce((sum, span) => sum + textWidth(span.text), 0)
  const right = truncateEnd(input.right, Math.max(0, width - used - 2))
  return fitLine(right ? spread(tabs, [{ text: right, fg: input.tone ?? "muted" }], width) : tabs, width)
}

/** A value as the page shows it: `quiet` ones (`default`, `none`, `built-in`) are drawn dim. */
export type ShownValue = { text: string; quiet: boolean }

/** One thing an enabled profile overrides: a profile key, a keybinding, a prompt file or a view slot. `kept`: the user chose their own. */
export type ActivationRowView = {
  package: string
  part: string
  key: string
  kept: boolean
  label: string
  group: OverrideGroup
  before: ShownValue
  after: ShownValue
  /** The full values for the detail: the profile's, and what it replaces (the user's own when kept). */
  full: { after: string; before?: string }
}

export type RawOverrideRow = { package: string; part: string; key: string; value: unknown; base?: unknown; kept: boolean; mine?: unknown }

export const OVERRIDE_GROUPS = ["Look", "Home", "Prompt", "Chat", "Activity", "Sidebar & commands", "Input", "Other", "Keys", "Views", "Prompt files"] as const
export type OverrideGroup = (typeof OVERRIDE_GROUPS)[number]

/** Names that read better out of /customize's sections, and keys /customize has no row for. */
const OVERRIDE_LABELS: Readonly<Record<string, string>> = {
  homeTips: "Home tips", homeLayout: "Home layout", slashCommands: "Slash commands", slashMenu: "Slash menu layout", slashGroups: "Slash menu groups",
  sidebarWidgets: "Sidebar widgets", rightSidebar: "Right panel", statusSeparator: "Footer separator", disabledViews: "Views switched off",
  disabledUiExtensions: "UI modules switched off",
}

/** Symbols and spacing a look sets, wherever /customize files them. */
const LOOK_KEYS = new Set(["density", "doneSymbol", "userLead", "assistantLead", "userIcon", "assistantIcon", "statusSeparator", "promptGlyphs", "scrollbarGlyphs"])
const SIDE_KEYS = new Set(["sidebarWidgets", "rightSidebar", "slashMenu", "slashCommands", "slashGroups"])

const SECTION_OF = new Map<string, { group: string; part: string }>(GROUPS.flatMap((group) => group.parts.flatMap((part) => part.rows.map((row) => [row, { group: group.title, part: part.title }] as const))))
const SECTION_GROUP: Readonly<Record<string, OverrideGroup>> = { Look: "Look", Home: "Home", "Prompt & footer": "Prompt", Chat: "Chat", Activity: "Activity", "Top & side": "Sidebar & commands", "Input & keys": "Input" }

/** "sidebarWidgets" → "Sidebar widgets", for keys no table names. */
const humanize = (key: string) => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The setting's name on screen: /customize's label, a better one out of context, or the id in words. */
export function settingLabel(key: string): string {
  return OVERRIDE_LABELS[key] ?? (LABELS as Readonly<Record<string, string>>)[key] ?? humanize(key)
}

/** Where an override is listed: keys, views and prompt files by kind; settings by their /customize section. */
export function overrideGroup(part: string, key: string): OverrideGroup {
  if (part === "keybinding") return "Keys"
  if (part === "view") return "Views"
  if (part === "prompt") return "Prompt files"
  if (LOOK_KEYS.has(key)) return "Look"
  if (SIDE_KEYS.has(key) || /^(sidebar|slash)[A-Z]/.test(key)) return "Sidebar & commands"
  const section = SECTION_OF.get(key)
  if (!section) return "Other"
  if (section.group === "Home" && section.part === "Logo") return "Look"
  if (section.part === "Slash menu") return "Sidebar & commands"
  return SECTION_GROUP[section.group] ?? "Other"
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown) => typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value) ?? ""

/** The noun a list setting holds: slashCommands → command, sidebarWidgets → widget. */
function itemNoun(key: string): string {
  const match = /(Command|Widget|Group|View|Extension|Segment|Row|Stat|Part)s?$/.exec(key)
  return match ? match[1]!.toLowerCase() : "item"
}

/** A list in words: "1 pinned command: retro-crt", "2 widgets: text RETRO, context", "3 items". */
function summarizeList(key: string, items: unknown[]): string {
  const noun = itemNoun(key)
  const names = items.map((item) => typeof item === "string" ? item : isRecord(item) ? [item.type, item.title ?? item.name ?? item.label].filter((part) => typeof part === "string" && part).join(" ") : "").filter(Boolean)
  const records = items.filter(isRecord)
  const flag = records.length === items.length && records.length ? (["pinned", "hidden"] as const).find((name) => records.every((item) => item[name] === true)) : undefined
  const head = `${items.length} ${flag ? `${flag} ` : ""}${noun}${items.length === 1 ? "" : "s"}`
  return names.length === items.length ? `${head}: ${names.join(", ")}` : head
}

/** A setting's value in words: `default` when unset or empty, booleans as on/off, lists and objects summarized. */
export function summarizeValue(key: string, value: unknown): ShownValue {
  if (value === undefined || value === null || value === "") return { text: "default", quiet: true }
  if (typeof value === "boolean") return { text: value ? "on" : "off", quiet: false }
  if (typeof value === "number") return { text: String(value), quiet: false }
  if (typeof value === "string") return { text: value.trim() === value ? value : JSON.stringify(value), quiet: false }
  if (Array.isArray(value)) return value.length ? { text: summarizeList(key, value), quiet: false } : { text: "default", quiet: true }
  if (isRecord(value)) {
    const keys = Object.keys(value)
    return keys.length ? { text: `${plural(keys.length, "entry")}: ${keys.join(", ")}`, quiet: false } : { text: "default", quiet: true }
  }
  return { text: text(value), quiet: false }
}

/** What a key runs without any profile: its built-in action, or undefined when nothing has it. */
export function builtinKeyAction(spec: string): string | undefined {
  const parsed = parseKeySpec(spec)
  if (!parsed.ok) return undefined
  const target = parsed.target
  if (target.kind === "leader") return LEADER_CHORDS[target.key]
  if (target.kind === "leader-key") return "leader"
  return target.seqs.map((seq) => DIRECT_KEYS[seq] ?? INLINE_KEYS[seq]).find(Boolean)
}

const actionText = (action: string) => actionLabel(action as BindingAction) ?? action

/** "message.assistant" → "assistant message", "tool.card" → "tool card". */
export function slotLabel(slot: string): string {
  const parts = slot.split(".")
  return parts[0] === "message" && parts.length === 2 ? `${parts[1]} message` : parts.join(" ")
}

const profileName = (key: string) => key.slice(key.indexOf(":") + 1)

/** One activation row as the page lists it. */
export function describeOverride(row: RawOverrideRow): ActivationRowView {
  const base = { package: row.package, part: row.part, key: row.key, kept: row.kept, group: overrideGroup(row.part, row.key) }
  if (row.part === "keybinding") {
    const builtin = builtinKeyAction(row.key)
    return { ...base, label: row.key, before: builtin ? { text: actionText(builtin), quiet: false } : { text: "none", quiet: true }, after: { text: actionText(text(row.value)), quiet: false }, full: { after: text(row.value), ...(builtin ? { before: builtin } : {}) } }
  }
  if (row.part === "view") return { ...base, label: slotLabel(row.key), before: { text: "built-in", quiet: true }, after: { text: `${profileName(row.package)} view`, quiet: false }, full: { after: text(row.value) } }
  if (row.part === "prompt") return { ...base, label: row.key, before: { text: "built-in", quiet: true }, after: { text: `${profileName(row.package)} file`, quiet: false }, full: { after: text(row.value) } }
  const before = row.kept && row.mine !== undefined ? row.mine : row.base
  return { ...base, label: settingLabel(row.key), before: summarizeValue(row.key, before), after: summarizeValue(row.key, row.value), full: { after: text(row.value), ...(before !== undefined ? { before: text(before) } : {}) } }
}

/** The rows in the order the page lists them: by group, then as the profile declares them. */
export function sortOverrides(rows: ActivationRowView[]): ActivationRowView[] {
  return rows.map((row, index) => ({ row, index })).sort((a, b) => OVERRIDE_GROUPS.indexOf(a.row.group) - OVERRIDE_GROUPS.indexOf(b.row.group) || a.index - b.index).map(({ row }) => row)
}

export const keepable = (row: ActivationRowView) => row.part !== "prompt" && row.part !== "view"

const LABEL_MAX = 24
const BEFORE_MAX = 22
const AFTER_MAX = 40
const ARROW = " → "
const KEPT_TAG = "yours"

function clampLine(line: Line, width: number): Line {
  const out: Line = []
  let used = 0
  for (const span of line) {
    const w = textWidth(span.text)
    if (used + w <= width) { out.push(span); used += w; continue }
    const cut = truncateEnd(span.text, width - used)
    if (cut) out.push({ ...span, text: cut })
    break
  }
  return out
}

const fit = (value: string, width: number) => {
  const cut = truncateEnd(value, width)
  return cut + " ".repeat(Math.max(0, width - textWidth(cut)))
}

/**
 * The list: a dim heading per group, then label | before (dim) | → | after, each column as wide as its longest entry up to a cap,
 * so the arrows line up. A kept row draws the profile's value dim and a `yours` tag.
 */
export function overrideListRows(input: { rows: ActivationRowView[]; selected: number; width: number; capacity: number; head?: Line[] }): Line[] {
  const { rows, width } = input
  const head = input.head ?? []
  const label = Math.min(LABEL_MAX, Math.max(...rows.map((row) => textWidth(row.label))))
  const before = Math.min(BEFORE_MAX, Math.max(...rows.map((row) => textWidth(row.before.text))))
  const left = Math.max(4, width - 2 - label - 2 - before - textWidth(ARROW) - (rows.some((row) => row.kept) ? KEPT_TAG.length + 2 : 0))
  const after = Math.min(AFTER_MAX, left, Math.max(...rows.map((row) => textWidth(row.after.text))))
  const lines: Line[] = []
  let selectedLine = 0
  rows.forEach((row, index) => {
    if (index === 0 || rows[index - 1]!.group !== row.group) {
      if (index > 0) lines.push([])
      lines.push([{ text: row.group, fg: "muted", bold: true }])
    }
    const at = index === input.selected
    if (at) selectedLine = lines.length
    const spans: Span[] = [
      at ? { text: "› ", fg: "primary", bold: true } : { text: "  " },
      { text: fit(row.label, label), fg: at ? "primary" : "text", bold: at },
      { text: "  " },
      // A kept row's own value is the one in force: it reads as normal text, the profile's as dim.
      { text: fit(row.before.text, before), fg: row.kept && !row.before.quiet ? "text" : "muted" },
      { text: ARROW, fg: "muted" },
      { text: row.kept ? truncateEnd(row.after.text, after) : fit(row.after.text, after), fg: row.kept || row.after.quiet ? "muted" : at ? "primary" : "text" },
    ]
    if (row.kept) spans.push({ text: " ".repeat(Math.max(0, after - textWidth(truncateEnd(row.after.text, after))) + 2) }, { text: KEPT_TAG, fg: "muted" })
    lines.push(clampLine(spans, width))
  })
  const room = Math.max(1, input.capacity - head.length)
  const offset = Math.max(0, selectedLine - room + 1)
  const shown = lines.slice(offset, offset + room)
  // A scrolled list never starts on the blank line between two groups.
  return [...head, ...(shown[0]?.length === 0 && shown.length > 1 ? shown.slice(1) : shown)]
}

const MAX_VALUE_LINES = 6
const KV_WIDTH = 9

/** The selected override in full: its name, raw id, before and after, the whole value, and what k and d do for it. */
export function overrideDetailRows(input: { row: ActivationRowView | undefined; count: number; width: number }): Line[] {
  const { row, width } = input
  if (!row) return []
  const kv = (name: string, value: string, fg: Span["fg"] = "body"): Line => clampLine([{ text: name.padEnd(KV_WIDTH), fg: "muted" }, { text: truncateEnd(value, Math.max(1, width - KV_WIDTH)), fg }], width)
  const kind = row.part === "keybinding" ? "key" : row.part === "view" ? "view slot" : row.part === "prompt" ? "prompt file" : row.part === "theme" ? "theme" : row.part === "tier" ? "setting from a tier" : row.part === "panel" ? "setting from a panel preset" : "setting"
  const lines: Line[] = [
    clampLine([{ text: row.label, fg: "text", bold: true }, ...(row.kept ? [{ text: `  ${KEPT_TAG}`, fg: "muted" as const }] : [])], width),
    clampLine([{ text: `${row.key} · ${kind}`, fg: "muted" }], width),
    ...(row.part === "keybinding" || row.part === "view" || row.part === "prompt" ? [] : wrap(PROFILE_KEY_HELP[row.key] ?? "", Math.max(1, width)).slice(0, 2).map((part): Line => [{ text: part, fg: "body" }])),
    [],
    kv(row.kept ? "yours" : "before", row.before.text, row.before.quiet ? "muted" : "body"),
    kv("profile", row.after.text, row.kept ? "muted" : "primary"),
  ]
  const full = row.part === "view" ? `module ${row.full.after}` : row.part === "keybinding" ? `action ${row.full.after}` : row.full.after
  if (full && full !== row.after.text && row.part !== "prompt") {
    const wrapped = wrap(full, Math.max(1, width - KV_WIDTH))
    wrapped.slice(0, MAX_VALUE_LINES).forEach((part, i) => lines.push(kv(i === 0 ? "value" : "", i === MAX_VALUE_LINES - 1 && wrapped.length > MAX_VALUE_LINES ? `${part} …` : part, "muted")))
  }
  lines.push([])
  const key = (name: string, meaning: string): Line => clampLine([{ text: name.padEnd(3), fg: "text", bold: true }, { text: meaning, fg: "muted" }], width)
  if (!keepable(row)) lines.push(key("k", row.part === "view" ? "views follow the profile while it owns the look" : "prompt files follow the profile while it is on"))
  else if (row.kept) lines.push(key("k", `use the profile's ${row.after.text} again`))
  else if (row.part === "keybinding") lines.push(key("k", `keep ${row.key} as yours: your keybindings.json entry, else ${row.before.quiet ? "nothing" : row.before.text}`))
  else lines.push(key("k", row.before.quiet ? "keep the default instead" : `keep yours (${row.before.text}) instead`))
  lines.push(key("d", `turn ${row.package} off: ${input.count === 1 ? "its override goes" : `all ${input.count} overrides go`} back`))
  return lines
}
