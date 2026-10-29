import { DEFAULT_COMPACT_AT_TOKENS, DEFAULT_COMPACT_NOTICE_PERCENT, DEFAULT_FOOTER, DEFAULT_IDLE_COMPACT_AT_TOKENS, featureOn } from "@mendcode/protocol/wire"
import type { Settings } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { panelGrid, clip, fit, columns } from "./deck"
import { appearancePage } from "./appearance-layout"
import { truncateEnd } from "./session-list"
import { normalizeTime } from "./setup-page"
import { textWidth, wrap } from "./wrap"
import { settingsPreview } from "./settings-preview"
import type { TuiProfile } from "./tui-profile"

/**
 * `/settings`: every daemon setting in one place, grouped, with the same edits the setup page makes (each one is a
 * `settings.set` patch, saved at once). Settings that hold lists or folder rules (models, profiles, trusted directories,
 * disabled packages, the footer) are shown here and edited where they live: the row says where.
 */

export type SettingsRow =
  | "theme" | "view" | "reducedMotion" | "pet" | "footer"
  | "defaultPermission" | "compactAtTokens" | "idleCompactAtTokens" | "compactNoticePercent" | "promptCacheTtl" | "claudeCacheTtl" | "profiles" | "trustedToolDirs" | "disabledPackages" | "onboarded"
  | "models" | "acp"
  | "dreamAt"
  | "retentionDays" | "worktreeGcDays" | "storage"
  | "customize" | "extensions"
  | "subagentOwnerWake" | "subagentMaxChildren" | "subagentMaxDescendants"
  | "queue"

type RowKind = "cycle" | "toggle" | "typed" | "link" | "readonly"
type RowDef = { id: SettingsRow; label: string; kind: RowKind }

export const SETTINGS_GROUPS: ReadonlyArray<{ title: string; rows: readonly RowDef[] }> = [
  {
    title: "Appearance",
    rows: [
      { id: "theme", label: "theme", kind: "cycle" },
      { id: "view", label: "view", kind: "cycle" },
      { id: "reducedMotion", label: "motion", kind: "toggle" },
      { id: "pet", label: "pet", kind: "link" },
      { id: "footer", label: "footer", kind: "link" },
    ],
  },
  {
    title: "Behavior",
    rows: [
      { id: "defaultPermission", label: "permission", kind: "cycle" },
      { id: "compactAtTokens", label: "compact at", kind: "typed" },
      { id: "idleCompactAtTokens", label: "idle compact", kind: "typed" },
      { id: "promptCacheTtl", label: "cache ttl", kind: "cycle" },
      { id: "claudeCacheTtl", label: "claude ttl", kind: "toggle" },
      { id: "compactNoticePercent", label: "compact notice", kind: "cycle" },
      { id: "profiles", label: "profiles", kind: "readonly" },
      { id: "trustedToolDirs", label: "trusted tools", kind: "link" },
      { id: "disabledPackages", label: "disabled pkgs", kind: "link" },
      { id: "onboarded", label: "onboarded", kind: "toggle" },
    ],
  },
  { title: "Models", rows: [{ id: "models", label: "roles", kind: "link" }] },
  { title: "Memory", rows: [{ id: "dreamAt", label: "dream at", kind: "typed" }] },
  {
    title: "Storage",
    rows: [
      { id: "retentionDays", label: "retention", kind: "typed" },
      { id: "worktreeGcDays", label: "worktree gc", kind: "typed" },
      { id: "storage", label: "disk usage", kind: "link" },
    ],
  },
  {
    title: "More",
    rows: [
      { id: "customize", label: "customize", kind: "link" },
      { id: "extensions", label: "extensions", kind: "link" },
      { id: "acp", label: "ACP agents", kind: "link" },
    ],
  },
  {
    title: "Subagents",
    rows: [
      { id: "subagentMaxChildren", label: "at once", kind: "cycle" },
      { id: "subagentMaxDescendants", label: "whole tree", kind: "cycle" },
      { id: "subagentOwnerWake", label: "owner wake", kind: "toggle" },
    ],
  },
  { title: "Queue", rows: [{ id: "queue", label: "prompt policy", kind: "cycle" }] },
]

const ALL_ROWS: readonly RowDef[] = SETTINGS_GROUPS.flatMap((group) => group.rows)

export type SettingsPageState = { row: number; tui?: string; /** Characters typed into a number or time row. */ typing?: string; error?: string }

/** `open` runs that slash command (the page closes). `set` is the `settings.set` patch, `null` clearing a setting. */
export type SettingsAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "set"; patch: Record<string, unknown> }
  | { type: "open"; command: string }

export type SettingsValues = {
  settings: Settings
  /** The theme, view and motion in effect (they apply locally before the daemon echoes them). */
  theme: string
  view: string
  reducedMotion: boolean
}

const NONE: SettingsAction = { type: "none" }
const VIEWS = ["minimal", "balanced", "full"]
const PERMISSIONS = ["ask", "edits", "full"]
const COMPACT_PRESETS = ["default", "100000", "200000", "400000", "800000", "1600000"]
const IDLE_COMPACT_PRESETS = ["default", "50000", "100000", "200000", "400000"]
const COMPACT_NOTICE_PRESETS = ["default", "50", "60", "70", "90", "off"]
const DREAM_PRESETS = ["off", "03:00"]
const RETENTION_PRESETS = ["off", "30", "90", "180", "365"]
/** Children of one agent running at once (default 4) and in its whole tree (default 16): the daemon's admission limits. */
const SUBAGENT_CHILD_PRESETS = ["2", "default", "8", "16", "32", "64"]
const SUBAGENT_TREE_PRESETS = ["8", "default", "32", "64", "128", "256"]
const COMPACT_RANGE = { min: 8_000, max: 2_000_000 }
const RETENTION_RANGE = { min: 7, max: 3_650 }
const WORKTREE_GC_PRESETS = ["off", "7", "14", "30"]
const WORKTREE_GC_RANGE = { min: 1, max: 3_650 }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const LEFT = new Set(["\x1b[D", "\x1bOD", "h"])
const RIGHT = new Set(["\x1b[C", "\x1bOC", "l"])
const HINTS = ["↑↓ row · ←→ change · enter open · esc back", "↑↓ · ←→ · enter · esc back", "esc back"]
const TYPING_HINTS = ["type a value · enter save · esc cancel", "enter save · esc cancel"]
const NAME_WIDTH = 15
const VALUE_WIDTH = 22
const MAX_COLUMN = 112

export function createSettingsPageState(): SettingsPageState {
  return { row: 0 }
}

const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))
const rowAt = (state: SettingsPageState) => ALL_ROWS[clamp(state.row, ALL_ROWS.length)]!

function cycle(list: readonly string[], current: string, direction: 1 | -1) {
  const index = list.indexOf(current)
  if (index < 0) return list[direction === 1 ? 0 : list.length - 1]!
  return list[(index + direction + list.length) % list.length]!
}

/** `200k` for whole thousands, else the plain count. */
export const formatTokens = (count: number) => (count >= 1000 && count % 1000 === 0 ? `${count / 1000}k` : String(count))

/** `200k` / `200000` as a token count inside the allowed range, else undefined. */
export function parseTokens(text: string): number | undefined {
  const match = /^(\d+)(k?)$/i.exec(text.trim())
  if (!match) return undefined
  const value = Number(match[1]) * (match[2] ? 1000 : 1)
  return value >= COMPACT_RANGE.min && value <= COMPACT_RANGE.max ? value : undefined
}

export function parseDays(text: string): number | undefined {
  if (!/^\d+$/.test(text.trim())) return undefined
  const value = Number(text)
  return value >= RETENTION_RANGE.min && value <= RETENTION_RANGE.max ? value : undefined
}

const TYPED_ERROR: Partial<Record<SettingsRow, string>> = {
  compactAtTokens: `tokens must be ${COMPACT_RANGE.min}-${COMPACT_RANGE.max} (200k works)`,
  idleCompactAtTokens: `tokens must be ${COMPACT_RANGE.min}-${COMPACT_RANGE.max} (200k works)`,
  dreamAt: "time must be HH:MM (00:00-23:59)",
  retentionDays: `days must be ${RETENTION_RANGE.min}-${RETENTION_RANGE.max}`,
  worktreeGcDays: `days must be ${WORKTREE_GC_RANGE.min}-${WORKTREE_GC_RANGE.max}`,
}

const TYPING_CHARS: Partial<Record<SettingsRow, RegExp>> = { compactAtTokens: /^[\dkK]$/, idleCompactAtTokens: /^[\dkK]$/, dreamAt: /^[\d:]$/, retentionDays: /^\d$/, worktreeGcDays: /^\d$/ }
const TYPING_MAX: Partial<Record<SettingsRow, number>> = { compactAtTokens: 8, idleCompactAtTokens: 8, dreamAt: 5, retentionDays: 4, worktreeGcDays: 4 }

/** The patch a typed value makes, or undefined when it is not valid for `row`. */
function typedPatch(row: SettingsRow, text: string): Record<string, unknown> | undefined {
  if (row === "compactAtTokens" || row === "idleCompactAtTokens") {
    const value = parseTokens(text)
    return value === undefined ? undefined : { [row]: value }
  }
  if (row === "dreamAt") {
    const value = normalizeTime(text)
    return value === undefined ? undefined : { dreamAt: value }
  }
  if (row === "retentionDays") {
    const value = parseDays(text)
    return value === undefined ? undefined : { retentionDays: value }
  }
  if (row === "worktreeGcDays") {
    const value = /^\d+$/.test(text.trim()) ? Number(text) : undefined
    return value !== undefined && value >= WORKTREE_GC_RANGE.min && value <= WORKTREE_GC_RANGE.max ? { worktreeGcDays: value } : undefined
  }
  return undefined
}

function choose(def: RowDef, values: SettingsValues, themes: readonly string[], direction: 1 | -1): SettingsAction {
  const { settings } = values
  switch (def.id) {
    case "theme":
      return { type: "set", patch: { theme: cycle(themes, values.theme, direction) } }
    case "view":
      return { type: "set", patch: { view: cycle(VIEWS, values.view, direction) } }
    case "reducedMotion":
      return { type: "set", patch: { reducedMotion: !values.reducedMotion } }
    case "onboarded":
      return { type: "set", patch: { onboarded: settings.onboarded !== true } }
    case "subagentOwnerWake":
      return { type: "set", patch: { subagentOwnerWake: settings.subagentOwnerWake === false } }
    case "subagentMaxChildren": {
      const next = cycle(SUBAGENT_CHILD_PRESETS, settings.subagentMaxChildren === undefined ? "default" : String(settings.subagentMaxChildren), direction)
      return { type: "set", patch: { subagentMaxChildren: next === "default" ? null : Number(next) } }
    }
    case "subagentMaxDescendants": {
      const next = cycle(SUBAGENT_TREE_PRESETS, settings.subagentMaxDescendants === undefined ? "default" : String(settings.subagentMaxDescendants), direction)
      return { type: "set", patch: { subagentMaxDescendants: next === "default" ? null : Number(next) } }
    }
    case "defaultPermission":
      return { type: "set", patch: { defaultPermission: cycle(PERMISSIONS, settings.defaultPermission ?? "ask", direction) } }
    case "compactAtTokens": {
      const next = cycle(COMPACT_PRESETS, settings.compactAtTokens === undefined ? "default" : String(settings.compactAtTokens), direction)
      return { type: "set", patch: { compactAtTokens: next === "default" ? null : Number(next) } }
    }
    case "idleCompactAtTokens": {
      const next = cycle(IDLE_COMPACT_PRESETS, settings.idleCompactAtTokens === undefined ? "default" : String(settings.idleCompactAtTokens), direction)
      return { type: "set", patch: { idleCompactAtTokens: next === "default" ? null : Number(next) } }
    }
    case "compactNoticePercent": {
      const next = cycle(COMPACT_NOTICE_PRESETS, settings.compactNoticePercent === undefined ? "default" : String(settings.compactNoticePercent), direction)
      return { type: "set", patch: { compactNoticePercent: next === "default" ? null : next === "off" ? "off" : Number(next) } }
    }
    case "promptCacheTtl":
      // Two values, so both directions switch; 5m is the unset default.
      return { type: "set", patch: { promptCacheTtl: settings.promptCacheTtl === "1h" ? null : "1h" } }
    case "claudeCacheTtl":
      return { type: "set", patch: { claudeCacheTtl: settings.claudeCacheTtl !== true } }
    case "dreamAt": {
      const next = cycle(DREAM_PRESETS, settings.dreamAt ?? "off", direction)
      return { type: "set", patch: { dreamAt: next === "off" ? null : next } }
    }
    case "retentionDays": {
      const next = cycle(RETENTION_PRESETS, settings.retentionDays === undefined ? "off" : String(settings.retentionDays), direction)
      return { type: "set", patch: { retentionDays: next === "off" ? null : Number(next) } }
    }
    case "worktreeGcDays": {
      const next = cycle(WORKTREE_GC_PRESETS, settings.worktreeGcDays === undefined ? "off" : String(settings.worktreeGcDays), direction)
      return { type: "set", patch: { worktreeGcDays: next === "off" ? null : Number(next) } }
    }
    case "footer":
      // A custom footer goes back to the default; choosing segments is `/footer +branch -quota`.
      return settings.footer ? { type: "set", patch: { footer: null } } : NONE
    case "pet":
      return { type: "open", command: "pet" }
    case "models":
      return { type: "open", command: "model" }
    case "acp":
      return { type: "open", command: "acp" }
    case "trustedToolDirs":
      return { type: "open", command: "tools" }
    case "disabledPackages":
      return { type: "open", command: "packages" }
    case "storage":
      return { type: "open", command: "storage" }
    case "customize":
      return { type: "open", command: "customize" }
    case "extensions":
      return { type: "open", command: "extensions" }
    case "profiles":
      return NONE
    case "queue":
      return { type: "set", patch: { queue: { mode: cycle(["after-response", "after-tools", "immediate"], settings.queue?.mode ?? "after-response", direction) } } }
  }
}

/** Handles one raw key. Returns the same state object when nothing changed. */
export function settingsPageKey(state: SettingsPageState, key: string, values: SettingsValues, options: { themes: readonly string[] }): { state: SettingsPageState; action: SettingsAction } {
  const def = rowAt(state)
  const cleared: SettingsPageState = { row: state.row }
  if (state.typing !== undefined) {
    if (key === "\x1b") return { state: cleared, action: NONE }
    if (key === "\x7f" || key === "\b") return { state: { row: state.row, typing: state.typing.slice(0, -1) }, action: NONE }
    if (key === "\r") {
      const patch = typedPatch(def.id, state.typing)
      return patch ? { state: cleared, action: { type: "set", patch } } : { state: { ...state, error: TYPED_ERROR[def.id] ?? "not a valid value" }, action: NONE }
    }
    const allowed = TYPING_CHARS[def.id]
    if (allowed && [...key].every((char) => allowed.test(char))) return typeInto(state, def.id, key)
    if (!UP.has(key) && !DOWN.has(key)) return { state, action: NONE }
  }
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  const move = (index: number) => {
    const next = clamp(index, ALL_ROWS.length)
    return next === state.row && state.typing === undefined && !state.error ? { state, action: NONE } : { state: { row: next }, action: NONE }
  }
  if (UP.has(key)) return move(state.row - 1)
  if (DOWN.has(key)) return move(state.row + 1)
  const allowed = TYPING_CHARS[def.id]
  // A digit starts typing on a number or time row ('k' alone is still "up"; it only counts inside `200k`).
  if (allowed && /\d/.test(key) && [...key].every((char) => allowed.test(char))) return typeInto({ row: state.row, typing: "" }, def.id, key)
  if (def.kind === "link" || def.kind === "readonly") return key === "\r" || RIGHT.has(key) || key === " " ? { state, action: choose(def, values, options.themes, 1) } : { state, action: NONE }
  if (LEFT.has(key)) return { state: cleared, action: choose(def, values, options.themes, -1) }
  if (RIGHT.has(key) || key === " " || key === "\r") return { state: cleared, action: choose(def, values, options.themes, 1) }
  return { state, action: NONE }
}

/** Adds typed characters; a full valid time applies at once (like the setup page's Dream time). */
function typeInto(state: SettingsPageState, row: SettingsRow, chunk: string): { state: SettingsPageState; action: SettingsAction } {
  const max = TYPING_MAX[row] ?? 8
  let typing = state.typing ?? ""
  for (const char of chunk) {
    if (typing.length >= max) break
    if (row === "dreamAt" && char === ":" && (typing.includes(":") || typing.length === 0)) continue
    typing += char
    if (row === "dreamAt" && /^\d\d$/.test(typing)) typing += ":"
  }
  if (row === "dreamAt" && typing.length === 5) {
    const patch = typedPatch(row, typing)
    return patch ? { state: { row: state.row }, action: { type: "set", patch } } : { state: { row: state.row, typing, error: TYPED_ERROR.dreamAt! }, action: NONE }
  }
  return { state: { row: state.row, typing }, action: NONE }
}

type Shown = { text: string; fg: ColorName; note: string; arrows: boolean }

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

function modelsSummary(settings: Settings) {
  const roles = Object.entries(settings.models ?? {})
  if (roles.length === 0) return "engine default"
  const main = settings.models?.main?.model
  return `${main ?? "main unset"}${roles.length > (main ? 1 : 0) ? ` · ${plural(roles.length - (main ? 1 : 0), "more role")}` : ""}`
}

function shown(def: RowDef, values: SettingsValues, state: SettingsPageState): Shown {
  const { settings } = values
  const on = (value: boolean) => ({ text: value ? "on" : "off", fg: (value ? "success" : "muted") as ColorName })
  switch (def.id) {
    case "theme":
      return { text: values.theme, fg: "primary", note: "previews live", arrows: true }
    case "view":
      return { text: values.view, fg: "text", note: "how much of a turn shows", arrows: true }
    case "reducedMotion":
      return { text: values.reducedMotion ? "reduced" : "normal", fg: "text", note: "space toggles", arrows: true }
    case "subagentOwnerWake":
      return { ...on(settings.subagentOwnerWake !== false), note: "background children notify their owner", arrows: true }
    case "subagentMaxChildren":
      return { text: settings.subagentMaxChildren === undefined ? "default (4)" : String(settings.subagentMaxChildren), fg: settings.subagentMaxChildren === undefined ? "muted" : "text", note: "children of one agent running together", arrows: true }
    case "subagentMaxDescendants":
      return { text: settings.subagentMaxDescendants === undefined ? "default (16)" : String(settings.subagentMaxDescendants), fg: settings.subagentMaxDescendants === undefined ? "muted" : "text", note: "running in one conversation's tree", arrows: true }
    case "pet":
      return { text: settings.pet && settings.pet !== "off" ? settings.pet : "off", fg: settings.pet && settings.pet !== "off" ? "text" : "muted", note: "enter opens /pet", arrows: false }
    case "footer":
      return { text: settings.footer ? `${plural(settings.footer.length, "segment")}` : `default (${DEFAULT_FOOTER.length})`, fg: settings.footer ? "text" : "muted", note: settings.footer ? "enter resets · /footer +branch -quota" : "/footer +branch -quota to choose", arrows: false }
    case "defaultPermission":
      return { text: settings.defaultPermission ?? "ask", fg: settings.defaultPermission === "full" ? "error" : "text", note: "for new sessions", arrows: true }
    case "compactAtTokens": {
      if (state.typing !== undefined) return { text: `${state.typing}_`, fg: "warning", note: "tokens, or 200k · enter saves · esc cancels", arrows: true }
      return settings.compactAtTokens === undefined
        ? { text: "default (95% of the model's window)", fg: "muted", note: "type a count to change", arrows: true }
        : { text: formatTokens(settings.compactAtTokens), fg: "text", note: "native engine compacts past this", arrows: true }
    }
    case "idleCompactAtTokens": {
      if (state.typing !== undefined) return { text: `${state.typing}_`, fg: "warning", note: "tokens, or 200k · enter saves · esc cancels", arrows: true }
      const note = featureOn(settings, "idle_compact") ? "idle sessions past this compact" : "off · /tier idle_compact on"
      return settings.idleCompactAtTokens === undefined
        ? { text: `default (${formatTokens(DEFAULT_IDLE_COMPACT_AT_TOKENS)})`, fg: "muted", note, arrows: true }
        : { text: formatTokens(settings.idleCompactAtTokens), fg: "text", note, arrows: true }
    }
    case "compactNoticePercent": {
      const note = featureOn(settings, "compact_notice") ? "says once that a compaction is near" : "off · /tier compact_notice on"
      const value = settings.compactNoticePercent
      return value === undefined
        ? { text: `default (${DEFAULT_COMPACT_NOTICE_PERCENT}% of the compaction point)`, fg: "muted", note, arrows: true }
        : { text: value === "off" ? "off" : `${value}%`, fg: value === "off" ? "muted" : "text", note, arrows: true }
    }
    case "promptCacheTtl": {
      // Short enough to show whole beside the value at 120 columns, like the rows around it.
      if (settings.promptCacheTtl === "1h") return { text: "1h", fg: "text", note: "Anthropic · writes 2x", arrows: true }
      return { text: "5m", fg: "muted", note: featureOn(settings, "wait_cache") ? "1h after two long waits" : "Anthropic · writes 1.25x", arrows: true }
    }
    case "claudeCacheTtl":
      return { ...on(settings.claudeCacheTtl === true), note: settings.claudeCacheTtl === true && settings.promptCacheTtl !== "1h" ? "needs cache ttl 1h" : "1h also to Claude Code", arrows: true }
    case "profiles":
      return { text: settings.profiles?.length ? settings.profiles.map((profile) => profile.name).join(", ") : "none", fg: settings.profiles?.length ? "text" : "muted", note: "folder rules · not editable here", arrows: false }
    case "trustedToolDirs":
      return { text: `${settings.trustedToolDirs?.length ?? 0} ${settings.trustedToolDirs?.length === 1 ? "directory" : "directories"}`, fg: settings.trustedToolDirs?.length ? "text" : "muted", note: "enter opens /tools", arrows: false }
    case "disabledPackages":
      return { text: `${settings.disabledPackages?.length ?? 0} off`, fg: settings.disabledPackages?.length ? "warning" : "muted", note: "enter opens /packages", arrows: false }
    case "onboarded":
      return { ...on(settings.onboarded === true), note: "first-run setup done", arrows: true }
    case "acp":
      return { text: plural(Object.keys(settings.acpAgents ?? {}).length, "agent"), fg: "text", note: "enter opens /acp", arrows: false }
    case "models":
      return { text: modelsSummary(settings), fg: Object.keys(settings.models ?? {}).length ? "text" : "muted", note: "enter opens /model", arrows: false }
    case "dreamAt":
      return state.typing !== undefined
        ? { text: `${state.typing}_`, fg: "warning", note: "HH:MM · enter saves · esc cancels", arrows: true }
        : { text: settings.dreamAt ?? "off", fg: settings.dreamAt ? "text" : "muted", note: "daily · type a time to change", arrows: true }
    case "retentionDays":
      return state.typing !== undefined
        ? { text: `${state.typing}_`, fg: "warning", note: "days · enter saves · esc cancels", arrows: true }
        : { text: settings.retentionDays === undefined ? "off" : `${settings.retentionDays} days`, fg: settings.retentionDays === undefined ? "muted" : "text", note: "remove idle sessions · type days", arrows: true }
    case "worktreeGcDays":
      return state.typing !== undefined
        ? { text: `${state.typing}_`, fg: "warning", note: "days · enter saves · esc cancels", arrows: true }
        : { text: settings.worktreeGcDays === undefined ? "off" : `${settings.worktreeGcDays} days`, fg: settings.worktreeGcDays === undefined ? "muted" : "text", note: "remove merged, clean, unused worktrees · type days", arrows: true }
    case "storage":
      return { text: "", fg: "muted", note: "enter opens /storage", arrows: false }
    case "customize":
      return { text: "", fg: "muted", note: "prompt, logo and home layout", arrows: false }
    case "extensions":
      return { text: "", fg: "muted", note: "what extensions registered", arrows: false }
    case "queue": {
      const mode = settings.queue?.mode ?? "after-response"
      return { text: mode, fg: "text", note: mode === "after-tools" ? "join after the tool iteration · native" : mode === "immediate" ? "interrupt and send the next prompt" : "wait for the complete response", arrows: true }
    }
  }
}

/** The settings, for tests and for anything that wants the same values the page shows. */
export function settingsRows(values: SettingsValues): Array<{ group: string; id: SettingsRow; label: string; value: string }> {
  return SETTINGS_GROUPS.flatMap((group) => group.rows.map((def) => ({ group: group.title, id: def.id, label: def.label, value: shown(def, values, { row: 0 }).text })))
}

/** Renders exactly `height` lines of at most `width` cells. */
export function renderSettingsPage(input: { state: SettingsPageState; values: SettingsValues; width: number; height: number; glyphs?: Glyphs; profile?: TuiProfile; pet?: Line[] | undefined; now?: number }): Line[] {
  const { state, values, width, height } = input
  if (height <= 0 || width <= 0) return []
  const glyphs = input.glyphs ?? defaultGlyphs()
  const typing = state.typing !== undefined
  const hints = (typing ? TYPING_HINTS : HINTS).find((text) => textWidth(text) <= Math.max(20, width - 15)) ?? "esc back"
  const wide = width >= 90
  const inner = Math.min(MAX_COLUMN, Math.max(1, columns(Math.max(1, width - 4), wide ? [3, 2] : [1])[0]! - 4))
  const nameWidth = Math.min(NAME_WIDTH, Math.max(8, Math.floor(inner / 3)))
  const valueWidth = Math.min(VALUE_WIDTH, Math.max(8, inner - nameWidth - 2))
  const focus = rowAt(state)
  let body: Line[] = []
  let focusLine = 0
  SETTINGS_GROUPS.forEach((group, index) => {
    if (index > 0) body.push([])
    body.push([{ text: group.title, fg: "text", bold: true }])
    for (const def of group.rows) {
      const on = def.id === focus.id
      const view = shown(def, values, on ? state : { row: 0 })
      const marker: Span = on ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " }
      const value: Span[] = view.text || view.arrows ? (view.arrows ? [{ text: "‹ ", fg: "muted" }, { text: truncateEnd(view.text, valueWidth - 4), fg: view.fg, bold: on }, { text: " ›", fg: "muted" }] : [{ text: truncateEnd(view.text, valueWidth), fg: view.fg, bold: on }]) : [{ text: "›", fg: "muted" }]
      if (on) focusLine = body.length
      const head = fit([marker, { text: truncateEnd(def.label, nameWidth).padEnd(nameWidth), fg: on ? "primary" : "text", bold: on }, ...value], 2 + nameWidth + valueWidth)
      const noteRoom = inner - 2 - nameWidth - valueWidth - 2
      body.push(clip([...head, ...(noteRoom >= 12 ? [{ text: `  ${truncateEnd(view.note, noteRoom)}`, fg: "muted" as const, dim: true }] : [])], inner))
      if (on && width < 70) body.push(...wrap(view.note, inner).map((text): Line => [{ text, fg: "muted" }]))
      if (on && state.error) body.push([{ text: " ".repeat(2 + nameWidth) + state.error, fg: "error" }])
    }
  })
  const room = Math.max(0, height - 2)
  const view = shown(focus, values, state)
  const appearance = ["theme", "view", "reducedMotion", "pet", "footer"].includes(focus.id)
  const detail = { title: appearance ? `${focus.label} preview` : focus.label, weight: 2, body: (w: number): Line[] => [
        [{ text: view.text || focus.kind, fg: view.fg, bold: true }],
        ...wrap(view.note, w).map((text): Line => [{ text, fg: "muted" }]),
        ...(appearance ? wrap(SETTINGS_HELP[focus.id], w).map((text): Line => [{ text, fg: "muted" }]) : []),
        ...(appearance ? settingsPreview({ values, ...(input.profile ? { profile: input.profile } : {}), ...(input.pet ? { pet: input.pet } : {}), width: w, height: Math.max(1, detailRoom - 6 - wrap(view.note, w).length - wrap(SETTINGS_HELP[focus.id], w).length), glyphs, now: input.now ?? 0 }) : [
          [],
          ...wrap(SETTINGS_HELP[focus.id], w).map((text): Line => [{ text, fg: "text" }]),
          [],
          ...wrap(`Stored: ${SETTINGS_STORAGE[focus.id] ?? `daemon database settings.${focus.id}`}`, w).map((text): Line => [{ text, fg: "muted" }]),
        ]),
        ...(state.error ? [[{ text: state.error, fg: "error" } as Span]] : []),
      ] }
  const optionsRoom = wide ? room : Math.max(5, Math.floor(room * .45))
  const detailRoom = wide ? room : Math.max(0, room - optionsRoom - 1)
  const options = { title: "Settings", weight: 3, body, scroll: Math.max(0, focusLine + 2 - (optionsRoom - 4)) }
  body = panelGrid({ width: Math.max(1, width - 4), heights: wide ? [room] : [optionsRoom, detailRoom], padding: true, compact: false, rows: wide ? [[options, detail]] : [[options], [detail]] })
  return appearancePage({ title: "Settings", subtitle: `${ALL_ROWS.length} settings`, body, hints, width, height })
}

const SETTINGS_HELP: Record<SettingsRow, string> = {
  theme: "Choose the terminal palette.", view: "minimal: plain turns. balanced: collapsed tools. full: expanded details.", reducedMotion: "normal animates activity; reduced holds it still.", pet: "Choose a pet in /pet; off hides it.", footer: "Use /footer +branch -quota to choose segments; reset restores defaults.",
  defaultPermission: "ask requests approval; edits allows file edits; full allows tools. Applies to new sessions; remote restrictions still apply.",
  compactAtTokens: "Default uses the engine threshold. Choose a preset or type 8k-2000k tokens; native compaction summarizes older context.",
  idleCompactAtTokens: "Default 100k. Choose a preset or type 8k-2000k tokens; an idle native session at least this large compacts once, just before the provider's prompt cache expires. /tier idle_compact on|off switches it (on in the full tier).",
  compactNoticePercent: "Default 80. When a call leaves the context at this share of the compaction point, the transcript says once how many tokens are left, about how many turns that is (from three turns of growth on) and that /compact packs it now. off never says it; compactNoticePercent in settings.json takes 10-99. /tier compact_notice on|off switches the feature.",
  promptCacheTtl: "5m (default) or 1h: how long Anthropic keeps what the native engine caches. 1h survives waits up to an hour; cache writes then cost 2x the input price instead of 1.25x. Anthropic API and Claude on Vertex only. At 5m, /tier wait_cache on|off (on in the full tier) switches a session to 1h once its calls were twice 5 to 60 minutes apart.",
  claudeCacheTtl: "off by default. on: a cache ttl of 1h is also given to Claude Code when it is the engine (CLAUDE_CODE_PROMPT_CACHE_TTL and CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, Claude Code 2.1.242 or later), from its next process on. At 5m nothing is passed and Claude Code keeps its own defaults.",
  profiles: "Named folder rules select models and permissions. Read-only here; edit profiles in settings configuration.",
  trustedToolDirs: "Open /tools to inspect local tool trust. Trusted directories allow their configured tools to load.",
  disabledPackages: "Open /packages to enable or disable installed extension packages. Disabled packages do not load.",
  onboarded: "on records completed setup; off offers setup on the next start.",
  models: "Open /model roles to choose main and helper roles. Unset roles use engine defaults.",
  acp: "Open /acp to manage opt-in external agent definitions. Unconfigured agents are not launched.",
  dreamAt: "off disables daily memory consolidation; HH:MM schedules it at that local time.",
  retentionDays: "off keeps idle sessions. Choose 30/90/180/365 or type 7-3650 days to set retention.",
  worktreeGcDays: "off keeps worktrees. Choose 7/14/30 or type 1-3650 days. Only merged, clean, unused worktrees qualify.",
  storage: "Open /storage to inspect disk usage and explicit cleanup options. Viewing usage removes nothing.",
  customize: "Open /customize for prompt, transcript and home appearance. Changes preview live and save locally.",
  extensions: "Open /extensions to inspect registered commands, tools and UI modules, including load errors.",
  subagentMaxChildren: "How many children one agent can have running at once (queued, running or waiting for approval); a finished child frees its place. Default 4, up to 64. More at once spends quota faster.",
  subagentMaxDescendants: "How many sub-agents can run at once in one conversation's whole tree, nested ones included. Default 16, up to 256.",
  subagentOwnerWake: "on notifies the owning agent when background children finish; off leaves results for explicit reads.",
  queue: "after-response waits for the turn; after-tools joins between tools; immediate steers now. Explicit delivery overrides this default.",
}
const SETTINGS_STORAGE: Partial<Record<SettingsRow, string>> = {
  storage: "daemon database and blob store; /storage is a report",
  customize: "data directory tui/profile.json",
  extensions: "extension manifests and data directory tui/profile.json",
  models: "daemon database settings.models",
  acp: "data directory acp-agents.json",
}
