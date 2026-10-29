import { TUI_DEFAULTS, tuiProblems } from "./tui-data"
import { isTier, TIER_BUNDLES, type Tier } from "./tier-data"

/**
 * A package's activation profile (`"activate"` in mendcode-package.json): the look and keys it brings as one unit, applied as an
 * OVERLAY over the user's own settings and removed again when the package is disabled or removed (docs/packages.md).
 *
 * Data and pure functions only, no imports that load zod, so the daemon (manifest validation, enable), the thin terminal client
 * (applying it) and `package check` share one definition of what is allowed and how overlays combine.
 *
 *   effective value = what the user chose after the package was activated  >  the package's overlay  >  the user's own value
 *
 * Nothing here is ever written into the user's stored profile, keybindings or settings: the overlay is computed from the enabled
 * packages every time, so there is nothing to undo when it goes away.
 */

export const ACTIVATION_KEYS = ["theme", "tuiProfile", "keybindings", "tier", "promptFiles", "views", "panelPreset"] as const
export const ACTIVATION_PROMPT_FILES = ["SYSTEM.md", "APPEND_SYSTEM.md", "COMPACTION.md"] as const
export const ACTIVATION_PANEL_PRESETS = ["pulse", "crew", "ledger", "focus", "full", "galaxy", "orbit"] as const
export const ACTIVATION_MAX_BYTES = 16 * 1024

export type Activation = {
  /** A theme shipped in the package's `themes/` (or any registered one). */
  theme?: string
  /** A subset of the terminal profile (`/customize`), validated like the profile itself. */
  tuiProfile?: Record<string, unknown>
  /** A file of the package in the format of `keybindings.json`. */
  keybindings?: string
  /** The terminal-side part of a tier bundle: presentation, density and whether the right panel hides. Features, prompt mode and process mode stay the user's. */
  tier?: Tier
  /** Prompt files the package ships and expects to apply (they take effect through the layer; this makes them visible and checked). */
  promptFiles?: string[]
  /** View slot -> module of `extensions/` that draws it. Those modules load only while the package owns the look. */
  views?: Record<string, string>
  /** One of the right panel's presets; shows the panel. */
  panelPreset?: string
}

/** Names a package may never set through activation, anywhere in the profile it ships: they are the user's authority, not a look. */
const FORBIDDEN = /^(permissions?|permissionMode|approvals?|approvalRules?|autoApprove|trust(ed\w*)?|providers?|credentials?|secrets?|apiKeys?|tokens?|passwords?|budgets?|features|experimental|tools|hooks|mcp|sandbox|network|models?|disabledPackages|disabledPackageResources|safeMode)$/i
export const ACTIVATION_FORBIDDEN_MESSAGE = "a package cannot set permissions, approvals, providers, credentials, trust, budgets or other settings of the user's authority"

/** Valid terminal-profile keys a package still may not set: they start things, spend calls, touch the clipboard or the network, or switch the user's own extensions off. */
export const ACTIVATION_DENIED_PROFILE_KEYS: ReadonlySet<string> = new Set([
  "processMode", "accessible", "altScreen", "disabledUiExtensions", "disabledViews", "copyOnSelect", "rightClickPaste", "autoRecap",
  "usageWeatherEnabled", "usageWeatherRegion", "turnBell", "turnNotify", "fileOpener", "pathClick", "viewerFocus", "draftRetentionDays", "resumePrompts", "idleReturn",
])

const THEME_NAME = /^[A-Za-z0-9][\w .-]{0,63}$/
const FILE_PATH = /^(?!.*\.\.)(?!\/)[A-Za-z0-9_./-]{1,100}\.json$/
const SLOT_NAME = /^[a-z]+(\.[a-z]+)?$/
const MODULE_NAME = /^(?!.*\.\.)(?!\/)[A-Za-z0-9_./-]{1,100}$/

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Everything wrong with an `activate` value, as short lines; empty means it is valid. */
export function activationProblems(raw: unknown): string[] {
  if (!isRecord(raw)) return ["activate must be an object"]
  const problems: string[] = []
  if (JSON.stringify(raw).length > ACTIVATION_MAX_BYTES) return [`activate is larger than ${ACTIVATION_MAX_BYTES / 1024} KB`]
  for (const [key, value] of Object.entries(raw)) {
    if (FORBIDDEN.test(key)) { problems.push(`activate.${key}: ${ACTIVATION_FORBIDDEN_MESSAGE}`); continue }
    if (!(ACTIVATION_KEYS as readonly string[]).includes(key)) { problems.push(`activate.${key}: unknown key (known: ${ACTIVATION_KEYS.join(", ")})`); continue }
    if (key === "theme" && (typeof value !== "string" || !THEME_NAME.test(value))) problems.push("activate.theme: expected a theme name")
    else if (key === "keybindings" && (typeof value !== "string" || !FILE_PATH.test(value))) problems.push("activate.keybindings: expected a relative .json path inside the package")
    else if (key === "tier" && !isTier(value)) problems.push("activate.tier: expected minimalist, balanced or full")
    else if (key === "panelPreset" && !(ACTIVATION_PANEL_PRESETS as readonly unknown[]).includes(value)) problems.push(`activate.panelPreset: expected ${ACTIVATION_PANEL_PRESETS.filter((preset) => preset !== "orbit").join(", ")}`)
    else if (key === "promptFiles") {
      if (!Array.isArray(value) || value.length > ACTIVATION_PROMPT_FILES.length || new Set(value).size !== value.length || value.some((name) => !(ACTIVATION_PROMPT_FILES as readonly unknown[]).includes(name))) problems.push(`activate.promptFiles: expected some of ${ACTIVATION_PROMPT_FILES.join(", ")}`)
    } else if (key === "views") {
      if (!isRecord(value) || Object.keys(value).length > 32) problems.push("activate.views: expected an object of view slot -> module of extensions/")
      else for (const [slot, module] of Object.entries(value)) if (!SLOT_NAME.test(slot) || typeof module !== "string" || !MODULE_NAME.test(module)) problems.push(`activate.views.${slot}: expected a view slot and a module name`)
    } else if (key === "tuiProfile") {
      if (!isRecord(value)) { problems.push("activate.tuiProfile: expected an object"); continue }
      const allowed: Record<string, unknown> = {}
      for (const [name, field] of Object.entries(value)) {
        if (FORBIDDEN.test(name)) problems.push(`activate.tuiProfile.${name}: ${ACTIVATION_FORBIDDEN_MESSAGE}`)
        else if (ACTIVATION_DENIED_PROFILE_KEYS.has(name)) problems.push(`activate.tuiProfile.${name}: not allowed through activation (it is the user's: launch settings, clipboard, notifications, other extensions)`)
        else allowed[name] = field
      }
      problems.push(...tuiProblems(allowed).map((line) => `activate.tuiProfile.${line}`))
    }
  }
  return problems
}

/** Whether the activation changes how MendCode looks (so only one package may own it per scope). Keybindings and prompt files are independent. */
export const hasLook = (activation: Activation) => Boolean(activation.theme || activation.tier || activation.panelPreset || (activation.tuiProfile && Object.keys(activation.tuiProfile).length) || (activation.views && Object.keys(activation.views).length))

export type ProfileOrigin = "tier" | "panel" | "theme" | "profile"
/** The module name as the extension loader calls it: no `.ts`/`.js`, no `/index`. */
export const moduleStem = (module: string) => module.replace(/\.(ts|js)$/, "").replace(/\/index$/, "")

/** The terminal-profile keys an activation sets, with where each came from; later sources win over earlier ones (tier < panel < theme < tuiProfile). */
export function activationProfile(activation: Activation, panel: (name: string) => Record<string, unknown> | undefined): Array<{ key: string; value: unknown; origin: ProfileOrigin }> {
  const out = new Map<string, { value: unknown; origin: ProfileOrigin }>()
  const put = (key: string, value: unknown, origin: ProfileOrigin) => out.set(key, { value, origin })
  if (activation.tier) {
    const bundle = TIER_BUNDLES[activation.tier]
    put("presentation", bundle.view, "tier")
    put("density", bundle.density, "tier")
    if (bundle.hideRightSidebar) put("rightSidebar", false, "tier")
  }
  if (activation.panelPreset) {
    for (const [key, value] of Object.entries(panel(activation.panelPreset) ?? {})) put(key, value, "panel")
    put("rightSidebar", true, "panel")
  }
  if (activation.theme) put("theme", activation.theme, "theme")
  for (const [key, value] of Object.entries(activation.tuiProfile ?? {})) put(key, value, "profile")
  return [...out].map(([key, entry]) => ({ key, ...entry }))
}

export type ActivationScope = "user" | "project"
export type ActivationPackage = {
  /** `user:name` / `project:name`. */
  key: string
  scope: ActivationScope
  activation: Activation
  /** The package's keybindings file, parsed: `{ "ctrl+g": "action" | null }`. */
  keybindings?: Record<string, string | null>
}
/** What the user chose by hand under one set of look owners: the keys (`keptKey`) and, for profile keys, the values. */
export type SavedLook = { kept: readonly string[]; values: Readonly<Record<string, unknown>> }
/**
 * What `activation.json` keeps per scope: who owns the look, and (user scope only) which keys the user chose by hand after activation.
 * `kept`/`keptFor` are the slot of the owners in force when it was written; `saved` holds every owner set's slot, so switching the
 * look away and back finds each one's choices as they were left.
 */
export type ActivationState = { look?: string | undefined; keptFor?: string | undefined; kept: readonly string[]; saved?: Readonly<Record<string, SavedLook>> }
export const EMPTY_ACTIVATION_STATE: ActivationState = { kept: [] }
export const ACTIVATION_STATE_FILE = "activation.json"
const MAX_SAVED_LOOKS = 32
const MAX_SAVED_BYTES = 16 * 1024

/** `mine` is the value the user chose for a kept key under these owners (absent: their stored value, `base`). */
export type OverrideRow = { part: ProfileOrigin | "keybinding" | "prompt" | "view"; key: string; package: string; value: unknown; base?: unknown; kept: boolean; mine?: unknown }
export type WaitingLook = { package: string; owner: string; changes: string[] }
export type ActivationResult = {
  owners: Partial<Record<ActivationScope, string>>
  /** Profile keys the owners ask for, before the user's explicit choices. */
  overlay: Record<string, unknown>
  /** `overlay` without the keys the user kept: what is layered over the user's own profile. */
  applied: Record<string, unknown>
  rows: OverrideRow[]
  keybindings: Array<{ spec: string; action: string | null; package: string }>
  promptFiles: Array<{ file: string; package: string }>
  /** `user:name/extensions/module` of look modules whose package does not own the look: loaders skip them. */
  suppressed: string[]
  waiting: WaitingLook[]
  conflicts: string[]
  /** Identifies the set of owners; `kept` is valid only while it is unchanged. */
  signature: string
  kept: string[]
  /** The values the user chose for kept profile keys under these owners; applied over the package like the overlay. */
  keptValues: Record<string, unknown>
}

/** `activation.json` as stored: anything unreadable is the empty state (nothing recorded, nothing kept). */
export function parseActivationState(raw: unknown): ActivationState {
  if (!isRecord(raw)) return EMPTY_ACTIVATION_STATE
  const look = typeof raw.look === "string" && /^(user|project):[a-z0-9][a-z0-9._-]{0,63}$/.test(raw.look) ? raw.look : undefined
  const keptFor = typeof raw.keptFor === "string" && raw.keptFor.length <= 200 ? raw.keptFor : undefined
  const kept = keptNames(raw.kept)
  const saved: Record<string, SavedLook> = {}
  if (isRecord(raw.saved)) for (const [signature, slot] of Object.entries(raw.saved).slice(0, MAX_SAVED_LOOKS)) {
    if (signature.length > 200 || !isRecord(slot) || JSON.stringify(slot).length > MAX_SAVED_BYTES) continue
    saved[signature] = { kept: keptNames(slot.kept), values: isRecord(slot.values) ? slot.values : {} }
  }
  return { ...(look ? { look } : {}), ...(keptFor ? { keptFor } : {}), kept, ...(Object.keys(saved).length ? { saved } : {}) }
}

const keptNames = (raw: unknown) => Array.isArray(raw) ? raw.filter((name): name is string => typeof name === "string" && name.length > 0 && name.length <= 100).slice(0, 256) : []

export const activationStateJson = (state: ActivationState) => `${JSON.stringify({ version: 1, ...(state.look ? { look: state.look } : {}), ...(state.keptFor ? { keptFor: state.keptFor } : {}), kept: state.kept, ...(state.saved && Object.keys(state.saved).length ? { saved: state.saved } : {}) }, null, 2)}\n`

/** The state with `signature`'s slot replaced (an empty slot is dropped), the newest slot last so the oldest go first past the limit. */
export function saveLook(state: ActivationState, signature: string, slot: SavedLook): ActivationState {
  const { [signature]: _previous, ...others } = state.saved ?? {}
  const entries = Object.entries(others)
  if (slot.kept.length && JSON.stringify(slot).length <= MAX_SAVED_BYTES) entries.push([signature, { kept: [...slot.kept], values: { ...slot.values } }])
  const saved = Object.fromEntries(entries.slice(-MAX_SAVED_LOOKS))
  const { saved: _old, ...rest } = state
  return { ...rest, keptFor: signature, kept: [...slot.kept], ...(Object.keys(saved).length ? { saved } : {}) }
}

export const keptKey =(kind: "profile" | "keybinding", name: string) => kind === "profile" ? name : `keybindings:${name}`

/** The owner among look candidates (lowest precedence first): the recorded one while it still qualifies, else the highest-precedence package. */
export function lookOwner(candidates: readonly string[], recorded?: string): string | undefined {
  return recorded !== undefined && candidates.includes(recorded) ? recorded : candidates.at(-1)
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const show = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value)

/** `key: from -> to` lines, for asking before a switch and for the report. */
export function describeChanges(activation: Activation, base: Record<string, unknown>, panel: (name: string) => Record<string, unknown> | undefined): string[] {
  const lines = activationProfile(activation, panel).filter(({ key, value }) => !same(base[key] ?? TUI_DEFAULTS[key], value)).map(({ key, value }) => `${key}: ${show(base[key] ?? TUI_DEFAULTS[key])} -> ${show(value)}`)
  if (activation.panelPreset) lines.push(`right panel: ${activation.panelPreset}`)
  for (const [slot, module] of Object.entries(activation.views ?? {})) lines.push(`view ${slot}: ${moduleStem(module)}`)
  return lines
}

/**
 * Combines the enabled packages' activations. Per scope one package owns the look (the recorded owner while it is still enabled
 * and has one, else the highest-precedence one); project owners layer over user owners and only count when the project is
 * trusted. Keybindings and prompt files are independent: they merge across packages, later wins, every clash is reported.
 */
export function resolveActivation(input: {
  /** Enabled packages with an activation, lowest precedence first (user packages, then project packages). */
  packages: readonly ActivationPackage[]
  state: Record<ActivationScope, ActivationState>
  projectTrusted: boolean
  /** The user's own profile (what is stored). */
  base: Record<string, unknown>
  panel: (name: string) => Record<string, unknown> | undefined
}): ActivationResult {
  const usable = input.packages.filter((pkg) => pkg.scope === "user" || input.projectTrusted)
  const owners: Partial<Record<ActivationScope, string>> = {}
  const waiting: WaitingLook[] = []
  const suppressed: string[] = []
  const conflicts: string[] = []
  const overlay: Record<string, unknown> = {}
  const origin = new Map<string, { package: string; part: ProfileOrigin }>()
  for (const scope of ["user", "project"] as const) {
    const candidates = usable.filter((pkg) => pkg.scope === scope && hasLook(pkg.activation))
    const owner = lookOwner(candidates.map((pkg) => pkg.key), input.state[scope].look)
    if (owner) owners[scope] = owner
    for (const pkg of candidates) {
      if (pkg.key === owner) continue
      waiting.push({ package: pkg.key, owner: owner!, changes: describeChanges(pkg.activation, input.base, input.panel) })
      for (const module of Object.values(pkg.activation.views ?? {})) suppressed.push(`${pkg.key}/extensions/${moduleStem(module)}`)
    }
    const winner = candidates.find((pkg) => pkg.key === owner)
    if (!winner) continue
    for (const { key, value, origin: part } of activationProfile(winner.activation, input.panel)) {
      const before = origin.get(key)
      if (before && before.package !== winner.key && !same(overlay[key], value)) conflicts.push(`${winner.key} overrides ${before.package}: ${key}`)
      overlay[key] = value
      origin.set(key, { package: winner.key, part })
    }
  }
  const signature = JSON.stringify([owners.user ?? null, owners.project ?? null])
  const keptState = input.state.user
  // The owners' own slot; an older file has only `kept`/`keptFor`, whose values are still in the stored profile.
  const slot = keptState.saved?.[signature] ?? (keptState.keptFor === signature ? { kept: keptState.kept, values: {} } : undefined)
  const kept = [...slot?.kept ?? []]
  const keptValues = Object.fromEntries(Object.entries(slot?.values ?? {}).filter(([key]) => key in overlay && kept.includes(keptKey("profile", key))))
  const applied = { ...Object.fromEntries(Object.entries(overlay).filter(([key]) => !kept.includes(keptKey("profile", key)))), ...keptValues }
  const rows: OverrideRow[] = []
  for (const [key, value] of Object.entries(overlay)) {
    const base = input.base[key] ?? TUI_DEFAULTS[key]
    const found = origin.get(key)!
    if (!same(base, value) || kept.includes(keptKey("profile", key))) rows.push({ part: found.part, key, package: found.package, value, base, kept: kept.includes(keptKey("profile", key)), ...(key in keptValues ? { mine: keptValues[key] } : {}) })
  }
  const keybindings: ActivationResult["keybindings"] = []
  const holder = new Map<string, number>()
  for (const pkg of usable) {
    for (const [spec, action] of Object.entries(pkg.keybindings ?? {})) {
      const at = holder.get(spec)
      if (at !== undefined) {
        const before = keybindings[at]!
        if (before.package !== pkg.key && before.action !== action) conflicts.push(`key ${spec}: ${pkg.key} wins over ${before.package}`)
        keybindings[at] = { spec, action, package: pkg.key }
      } else { holder.set(spec, keybindings.length); keybindings.push({ spec, action, package: pkg.key }) }
    }
  }
  for (const entry of keybindings) rows.push({ part: "keybinding", key: entry.spec, package: entry.package, value: entry.action, kept: kept.includes(keptKey("keybinding", entry.spec)) })
  const promptFiles: ActivationResult["promptFiles"] = []
  for (const pkg of usable) for (const file of pkg.activation.promptFiles ?? []) {
    const at = promptFiles.findIndex((entry) => entry.file === file)
    if (at >= 0) { conflicts.push(`${file}: ${pkg.key} wins over ${promptFiles[at]!.package}`); promptFiles[at] = { file, package: pkg.key } } else promptFiles.push({ file, package: pkg.key })
  }
  for (const entry of promptFiles) rows.push({ part: "prompt", key: entry.file, package: entry.package, value: "replaces the prompt file", kept: false })
  for (const pkg of usable) for (const [slot, module] of Object.entries(pkg.activation.views ?? {})) if (owners[pkg.scope] === pkg.key) rows.push({ part: "view", key: slot, package: pkg.key, value: moduleStem(module), kept: false })
  return { owners, overlay, applied, rows, keybindings, promptFiles, suppressed, waiting, conflicts, signature, kept, keptValues }
}
