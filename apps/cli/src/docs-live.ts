import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { THEMES } from "./themes"
import { readKeybindings } from "./extensions/keybindings"
import { DEFAULT_BINDINGS, KEY_ACTIONS, LEADER_CHORDS, inlineKeyNames } from "./ui/keymap"
import { readTuiProfile } from "./view/tui-profile"
import { commandsLines } from "./docs-commands"
import { FEATURE_PROVIDERS } from "./docs-live-features"
import { QUOTA_MAX_AGE_MS, QUOTA_REFRESH_DEFAULT_MINUTES, QUOTA_REFRESH_PROVIDERS, quotaReadings, shortSpan, type QuotaSnapshotLike } from "@mendcode/protocol/wire"

/**
 * The live lines of a card: what is true on this machine right now. Local files are read directly (the terminal's own profile never goes
 * through the daemon); what only the daemon knows comes from `settings`/`prompt`, which are undefined when no daemon runs, and then the
 * card prints without those lines. Nothing here writes, starts a process or reads a credential.
 */
export type RefreshLine = { provider: string; everyMinutes: number; model?: string | undefined; state: "on" | "waiting" | "stopped"; lastProbeAt?: number | undefined; probesToday: number; lastError?: string | undefined }

export type LiveContext = {
  dataDir: string
  /** The project the command runs in (its `.mendcode/` is listed next to the data dir). */
  cwd: string
  settings: Record<string, unknown> | undefined
  prompt: Record<string, unknown> | undefined
  /** The last quota reading of each provider a running daemon holds; undefined when no daemon answered. */
  quotas?: readonly QuotaSnapshotLike[] | undefined
  /** The quota refresh probe per listed provider, as `daemon.info` reports it; undefined when no daemon answered or none is listed. */
  refresh?: readonly RefreshLine[] | undefined
  /** The word after the topic (`docs commands changes`), for the topics that take one. */
  detail?: string | undefined
  /** The clock, for the age of a reading (tests set it). */
  now?: number | undefined
}

type Provider = (context: LiveContext) => string[]

/** The names in a folder (a file `a.ts` and a folder `a/` both count as `a`), or none. */
function entries(folder: string): string[] {
  try {
    return readdirSync(folder).filter((name) => !name.startsWith(".")).map((name) => name.replace(/\.(?:ts|js|json|md)$/, "")).sort()
  } catch { return [] }
}

const exists = (file: string) => existsSync(file) && statSync(file).isFile()
const word = (value: unknown) => (typeof value === "string" && value ? value : undefined)

/** `kind/: a, b` for the data dir and the project, or one line saying there are none. */
function folders(context: LiveContext, kind: string): string[] {
  const user = entries(path.join(context.dataDir, kind))
  const project = entries(path.join(context.cwd, ".mendcode", kind))
  const lines = [`${path.join(context.dataDir, kind)}: ${user.length ? user.join(", ") : "none"}`]
  if (path.resolve(context.cwd) !== path.resolve(context.dataDir)) lines.push(`${path.join(context.cwd, ".mendcode", kind)}: ${project.length ? project.join(", ") : "none"}`)
  return lines
}

const folder = (kind: string): Provider => (context) => folders(context, kind)

/** The theme in force: the terminal profile's own, else the daemon's `theme` setting; without either it says what applies. */
function currentTheme(context: LiveContext) {
  const own = word(readTuiProfile(context.dataDir).theme) ?? word(context.settings?.theme)
  if (own) return own
  return context.settings ? "mend (the default: none chosen)" : "none saved in the terminal profile (the daemon's theme setting, else mend, applies)"
}

const THEME_FILE = /\.json$/

function themeFiles(dir: string) {
  try { return readdirSync(dir).filter((name) => THEME_FILE.test(name)).map((name) => name.replace(THEME_FILE, "")).sort() } catch { return [] }
}

/** Key names of a chord: the leader (ctrl+x) then the character. */
const chord = (key: string) => (key.startsWith("\x1b") ? undefined : `ctrl+x ${key}`)

/** The default key names of an action, without raw escape sequences (terminals send several spellings of one key). */
function defaultKeys(action: (typeof KEY_ACTIONS)[number]) {
  const chords = Object.entries(LEADER_CHORDS).filter(([key, bound]) => bound === action && chord(key)).map(([key]) => chord(key)!)
  return [...inlineKeyNames(DEFAULT_BINDINGS, action), ...chords].filter((name) => !/\\u|[\x00-\x1f\x7f]/.test(name))
}

/** Every action of this version once, with its default keys; the prompt's editing actions (`edit.*`) are named in one line. */
function keyActionLines() {
  const actions = KEY_ACTIONS.filter((action, at) => KEY_ACTIONS.indexOf(action) === at)
  const edits = actions.filter((action) => action.startsWith("edit."))
  const others = actions.filter((action) => !action.startsWith("edit."))
  return [
    ...others.filter((action) => defaultKeys(action).length).map((action) => `${action}: ${defaultKeys(action).join(" | ")}`),
    `no default key: ${others.filter((action) => !defaultKeys(action).length).join(", ")}`,
    `prompt editing, as edit.<name>: ${edits.map((action) => action.slice(5)).join(", ")}`,
  ]
}

function daemonLines(context: LiveContext, keys: string[]) {
  if (!context.settings) return []
  return keys.map((key) => {
    const value = context.settings![key]
    return `${key}: ${value === undefined || value === null ? "not set (the built-in default applies)" : typeof value === "string" ? value : JSON.stringify(value)}`
  })
}

/** The saved `modelContext`: each model's window or compaction point kept with `/context-window <n> --always`. */
function modelContextLine(value: unknown): string {
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, { window?: unknown; compactAt?: unknown }>) : []
  if (!entries.length) return "modelContext: not set (every model uses the model list's window)"
  const shown = entries.map(([ref, entry]) => `${ref} ${[typeof entry?.window === "number" ? `window ${entry.window}` : "", typeof entry?.compactAt === "number" ? `compactAt ${entry.compactAt}` : ""].filter(Boolean).join(", ")}`)
  return `modelContext: ${shown.join(" · ")}`
}

const note = (context: LiveContext, lines: string[]) => (context.settings ? lines : [...lines, "(no daemon running: daemon settings not shown)"])

/**
 * What MendCode knows about provider quota windows right now, per provider and window, with the age of each reading. The readings are
 * the ones a running daemon holds (it learns them from the provider's own responses and events); without a daemon nothing is known.
 * A provider or window that is not listed is unknown, which is the honest value to show for it.
 */
function quotaLines(context: LiveContext): string[] {
  if (!context.quotas) return ["provider quota: not known (no daemon is running; readings arrive with provider responses)", ...refreshLines(context)]
  const now = context.now ?? Date.now()
  const readings = quotaReadings(context.quotas, now)
  const lines = readings.map((reading) => {
    const reset = reading.resetsAt === undefined ? "reset time not reported" : reading.resetsAt > now ? `resets in ${shortSpan(reading.resetsAt - now)}` : "window already reset"
    const age = reading.stale ? `STALE: observed ${shortSpan(reading.ageMs)} ago, older than ${shortSpan(QUOTA_MAX_AGE_MS)} or its window ended: show it with its age or as unknown` : `fresh: observed ${shortSpan(reading.ageMs)} ago`
    return `${reading.provider} ${reading.window}: ${reading.leftPercent}% left (${reading.usedPercent}% used) · ${reset} · ${age}`
  })
  const heard = [...new Set(context.quotas.map((quota) => quota.provider))]
  return [
    ...(lines.length ? lines : ["no provider has reported a quota window yet: every window is unknown"]),
    `a provider or window not listed is unknown${heard.length ? ` (heard from: ${heard.join(", ")})` : ""}: show it as unavailable, never as 0% or 100%`,
    ...refreshLines(context),
  ]
}

/**
 * The quota refresh probe per provider: off (nothing is ever sent) unless the user's `quotaRefresh` lists it. The setting comes from the
 * terminal profile file; what the daemon did (last probe, probes today) only from a running daemon.
 */
function refreshLines(context: LiveContext): string[] {
  const now = context.now ?? Date.now()
  const listed = readTuiProfile(context.dataDir).quotaRefresh
  const reported = new Map((context.refresh ?? []).map((line) => [line.provider, line]))
  return QUOTA_REFRESH_PROVIDERS.map((provider) => {
    const entry = listed.find((item) => item.provider === provider)
    if (!entry) return `${provider} refresh: off, nothing is sent`
    const every = `every ${entry.everyMinutes ?? QUOTA_REFRESH_DEFAULT_MINUTES} min${entry.model ? ` on ${entry.model}` : ""}`
    const line = reported.get(provider)
    if (!context.quotas) return `${provider} refresh: on, ${every} (the daemon is not running: no probe has run)`
    if (!line) return `${provider} refresh: on, ${every} (the daemon has not picked it up yet)`
    const last = line.lastProbeAt === undefined ? "no probe yet" : `last probe ${shortSpan(Math.max(0, now - line.lastProbeAt))} ago`
    const state = line.state === "stopped" ? `STOPPED (${line.lastError ?? "failed too often"}); edit quotaRefresh to start again` : line.state === "waiting" ? "waiting (no terminal attached, or the provider is at its limit)" : "running"
    return `${provider} refresh: on, ${every} · ${state} · ${last} · ${line.probesToday} probes today (each spends some of the quota it measures)`
  })
}

/** One provider per topic; a topic without one prints its static card alone. Adding a topic's live lines = adding an entry. */
const PROVIDERS: Record<string, Provider> = {
  ...FEATURE_PROVIDERS,
  settings: (context) => {
    const files = ["AGENTS.md", "mcp.json", "hooks.json", "keybindings.json", "statusline.json", "mendcode.json", path.join("tui", "profile.json")]
    return note(context, [
      `data dir: ${context.dataDir}`,
      `files there: ${files.filter((name) => exists(path.join(context.dataDir, name))).join(", ") || "none"}`,
      `project: ${exists(path.join(context.cwd, ".mendcode", "project.json")) || existsSync(path.join(context.cwd, ".mendcode")) ? path.join(context.cwd, ".mendcode") : "no .mendcode folder"}`,
      ...daemonLines(context, ["tier", "defaultPermission", "outputStyle", "theme"]),
    ])
  },
  theme: (context) => {
    const user = themeFiles(path.join(context.dataDir, "themes"))
    const project = themeFiles(path.join(context.cwd, ".mendcode", "themes"))
    return note(context, [
      `current theme: ${currentTheme(context)}`,
      `built-in themes: system, ${THEMES.map((theme) => theme.name).join(", ")}`,
      `theme files, user (${path.join(context.dataDir, "themes")}): ${user.join(", ") || "none"}`,
      `theme files, project (${path.join(context.cwd, ".mendcode", "themes")}): ${project.join(", ") || "none"}`,
    ])
  },
  customize: (context) => {
    const profile = readTuiProfile(context.dataDir)
    const file = path.join(context.dataDir, "tui", "profile.json")
    return [`profile file: ${file}${exists(file) ? "" : " (not written yet: defaults)"}`, `density: ${profile.density} · theme: ${currentTheme(context)}`]
  },
  keys: (context) => {
    const { entries: mine, problems } = readKeybindings(context.dataDir)
    const file = path.join(context.dataDir, "keybindings.json")
    return [
      `file: ${file}${exists(file) ? "" : " (none: every default applies)"}`,
      ...(mine.length ? [`your bindings: ${mine.map((entry) => `${entry.spec} -> ${entry.action ?? "unbound"}`).join(", ")}`] : []),
      ...problems.map((problem) => `problem: ${problem}`),
    ]
  },
  "key-actions": () => keyActionLines(),
  footer: (context) => {
    const user = path.join(context.dataDir, "statusline.json")
    const project = path.join(context.cwd, ".mendcode", "statusline.json")
    return [`statusline.json: ${exists(user) ? user : "none in the data dir"}${exists(project) ? ` · project: ${project}` : ""}`, ...folders(context, "extensions"), ...quotaLines(context)]
  },
  usage: (context) => quotaLines(context),
  extensions: folder("extensions"),
  tools: folder("tools"),
  commands: (context) => commandsLines(context),
  skills: folder("skills"),
  agents: folder("agents"),
  packages: folder("packages"),
  hooks: (context) => {
    const files = [path.join(context.dataDir, "hooks.json"), path.join(context.cwd, ".mendcode", "hooks.json")].filter(exists)
    const events = files.flatMap((file) => {
      try { return Object.keys((JSON.parse(readFileSync(file, "utf8")) as { hooks?: Record<string, unknown> }).hooks ?? {}) } catch { return [`(unreadable: ${file})`] }
    })
    return [`hooks.json: ${files.join(", ") || "none"}${events.length ? ` · events: ${[...new Set(events)].join(", ")}` : ""}`]
  },
  mcp: (context) => {
    const files = [path.join(context.dataDir, "mcp.json"), path.join(context.cwd, ".mendcode", "mcp.json")].filter(exists)
    const servers = files.flatMap((file) => {
      try { return Object.keys((JSON.parse(readFileSync(file, "utf8")) as { servers?: Record<string, unknown> }).servers ?? {}) } catch { return [`(unreadable: ${file})`] }
    })
    return [`mcp.json: ${files.join(", ") || "none"}${servers.length ? ` · servers: ${[...new Set(servers)].join(", ")}` : ""}`]
  },
  models: (context) => [...folders(context, "recipes"), ...note(context, context.settings ? [modelContextLine(context.settings.modelContext)] : [])],
  permissions: (context) => note(context, daemonLines(context, ["defaultPermission", "sandbox"])),
  tiers: (context) => note(context, [`tier: ${word(context.settings?.tier) ?? "none set (every feature keeps its own default)"}`]),
  "prompt-modes": (context) => (context.prompt ? [`this project: mode ${word(context.prompt.mode) ?? "?"}, family ${word(context.prompt.focusID) ?? "?"}${word(context.prompt.resolvedFocus) ? ` (resolves to ${word(context.prompt.resolvedFocus)})` : ""}`] : ["(no daemon running: the saved mode is not shown)"]),
  budgets: (context) => note(context, daemonLines(context, ["budgets"])),
  // The two saved settings that move the compaction point; what they give a session is `context <session>`, which also knows the model's window.
  compaction: (context) => note(context, context.settings ? [
    `compactAtTokens: ${typeof context.settings.compactAtTokens === "number" ? context.settings.compactAtTokens : "not set (each model compacts at a percentage of its window)"}`,
    `compaction: ${context.settings.compaction && typeof context.settings.compaction === "object" ? JSON.stringify(context.settings.compaction) : "not set (automatic at 90 percent of the window, or earlier to leave room for the reply)"}`,
  ] : []),
}

/** What a topic's lines are called; most are facts of this machine, `key-actions` lists what this version offers. */
const TITLES: Record<string, string> = { "key-actions": "Actions of this version" }
export const liveTitle = (topic: string) => TITLES[topic] ?? "On this machine now"

/** The live lines of one topic; empty when the topic has none. */
export function liveLines(topic: string, context: LiveContext): string[] {
  try { return PROVIDERS[topic]?.(context) ?? [] } catch { return [] }
}

/** The topics whose live lines need the daemon (the command asks for it only then). */
export const NEEDS_SETTINGS = new Set(["settings", "theme", "permissions", "tiers", "budgets", "compaction", "models", "commands", ...Object.keys(FEATURE_PROVIDERS)])
export const NEEDS_PROMPT = new Set(["prompt-modes"])
/** The topics that read the provider quota readings a running daemon holds. */
export const NEEDS_QUOTA = new Set(["usage", "footer"])