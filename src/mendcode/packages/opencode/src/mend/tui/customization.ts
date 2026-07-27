export const MEND_TUI_CUSTOMIZATION_KV_KEY = "mendcode_tui_customization"

export type MendTuiSessionAccent = "theme" | "random" | `#${string}`

export type MendTuiCustomization = {
  /** Show the context usage bar in the session top chrome. */
  contextBar: boolean
  /** Show +added/-removed diff totals in the session top chrome. */
  diffCount: boolean
  /** Show the number of changed files beside the diff totals. */
  diffFiles: boolean
  /** Show the current session title in the session top chrome. */
  sessionTitle: boolean
  /** Show the current project path in the session top chrome. */
  projectPath: boolean
  /** Write route/session information to the terminal window title. */
  terminalTitle: boolean
  /** Use the theme accent, a deterministic per-session accent, or a custom hex color. */
  sessionAccent: MendTuiSessionAccent
  /** Terminal title template. Supported tokens: {product}, {session}, {route}, {path}. */
  terminalTitleTemplate: string
}

export type MendTuiCustomizationBooleanKey =
  | "contextBar"
  | "diffCount"
  | "diffFiles"
  | "sessionTitle"
  | "projectPath"
  | "terminalTitle"

export const MEND_TUI_CUSTOMIZATION_BOOLEAN_KEYS: readonly MendTuiCustomizationBooleanKey[] = [
  "contextBar",
  "diffCount",
  "diffFiles",
  "sessionTitle",
  "projectPath",
  "terminalTitle",
]

export const DEFAULT_MEND_TUI_CUSTOMIZATION: MendTuiCustomization = {
  contextBar: true,
  diffCount: true,
  diffFiles: false,
  sessionTitle: true,
  projectPath: true,
  terminalTitle: true,
  sessionAccent: "theme",
  terminalTitleTemplate: "{product} | {session}",
}

type KVGet = <Value = unknown>(key: string, fallback?: Value) => Value
type KVSet = (key: string, value: unknown) => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function validAccent(value: unknown): value is MendTuiSessionAccent {
  return value === "theme" || value === "random" || (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value))
}

export function normalizeMendTuiCustomization(input: unknown): MendTuiCustomization {
  const value = isRecord(input) ? input : {}
  const template = typeof value.terminalTitleTemplate === "string" ? value.terminalTitleTemplate.trim() : ""
  return {
    contextBar: typeof value.contextBar === "boolean" ? value.contextBar : DEFAULT_MEND_TUI_CUSTOMIZATION.contextBar,
    diffCount: typeof value.diffCount === "boolean" ? value.diffCount : DEFAULT_MEND_TUI_CUSTOMIZATION.diffCount,
    diffFiles: typeof value.diffFiles === "boolean" ? value.diffFiles : DEFAULT_MEND_TUI_CUSTOMIZATION.diffFiles,
    sessionTitle:
      typeof value.sessionTitle === "boolean" ? value.sessionTitle : DEFAULT_MEND_TUI_CUSTOMIZATION.sessionTitle,
    projectPath:
      typeof value.projectPath === "boolean" ? value.projectPath : DEFAULT_MEND_TUI_CUSTOMIZATION.projectPath,
    terminalTitle:
      typeof value.terminalTitle === "boolean" ? value.terminalTitle : DEFAULT_MEND_TUI_CUSTOMIZATION.terminalTitle,
    sessionAccent: validAccent(value.sessionAccent)
      ? value.sessionAccent
      : DEFAULT_MEND_TUI_CUSTOMIZATION.sessionAccent,
    terminalTitleTemplate: template.slice(0, 160) || DEFAULT_MEND_TUI_CUSTOMIZATION.terminalTitleTemplate,
  }
}

export function readMendTuiCustomization(get: KVGet): MendTuiCustomization {
  const stored = get<unknown>(MEND_TUI_CUSTOMIZATION_KV_KEY, {})
  const next = normalizeMendTuiCustomization(stored)
  if (!isRecord(stored) || !Object.prototype.hasOwnProperty.call(stored, "terminalTitle")) {
    next.terminalTitle = get("terminal_title_enabled", DEFAULT_MEND_TUI_CUSTOMIZATION.terminalTitle) !== false
  }
  return next
}

export function writeMendTuiCustomization(get: KVGet, set: KVSet, patch: Partial<MendTuiCustomization>) {
  const next = normalizeMendTuiCustomization({ ...readMendTuiCustomization(get), ...patch })
  set(MEND_TUI_CUSTOMIZATION_KV_KEY, next)
  if (patch.terminalTitle !== undefined) set("terminal_title_enabled", next.terminalTitle)
  return next
}

export function resetMendTuiCustomization(set: KVSet) {
  set(MEND_TUI_CUSTOMIZATION_KV_KEY, DEFAULT_MEND_TUI_CUSTOMIZATION)
  set("terminal_title_enabled", DEFAULT_MEND_TUI_CUSTOMIZATION.terminalTitle)
  return DEFAULT_MEND_TUI_CUSTOMIZATION
}

export function resolveMendTerminalTitle(input: {
  template: string
  product: string
  session?: string
  route?: string
  path?: string
}) {
  const values = {
    product: input.product || "MendCode",
    session: input.session || "MendCode",
    route: input.route || "MendCode",
    path: input.path || "",
  }
  const title = input.template.replace(
    /\{(product|session|route|path)\}/g,
    (_, token: keyof typeof values) => values[token],
  )
  return title.trim() || values.product
}

const SESSION_ACCENTS = [
  "#7dd3fc",
  "#c4b5fd",
  "#f9a8d4",
  "#86efac",
  "#fcd34d",
  "#fdba74",
  "#67e8f9",
  "#fca5a5",
] as const

function sessionAccentIndex(sessionID: string) {
  let hash = 2166136261
  for (const char of sessionID) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash) % SESSION_ACCENTS.length
}

export function resolveMendSessionAccent(input: { sessionID: string; accent: MendTuiSessionAccent; fallback: string }) {
  if (input.accent === "theme") return input.fallback
  if (input.accent === "random") return SESSION_ACCENTS[sessionAccentIndex(input.sessionID)]
  return input.accent
}
