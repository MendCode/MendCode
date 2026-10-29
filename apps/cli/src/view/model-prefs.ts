import fs from "node:fs"
import path from "node:path"

/**
 * The model page's own memory, kept on this machine in `<dataDir>/tui/models.json` (like the TUI profile, it never goes
 * through the daemon): the models starred with `f` and the last few used. Ids are the catalog's (`gpt-6-luna`,
 * `anthropic:claude-sonnet-5-5`). Values are checked by hand so the startup graph stays free of zod; a missing or broken
 * file is empty.
 */

/** The effort (or variant) a model starts with when it is picked without one. */
export type ModelDefault = { effort?: string; variant?: string }
type ModelChoiceLike = { model: string; effort?: string | undefined; variant?: string | undefined }
export type ModelPrefs = { favorites: string[]; recents: string[]; /** Per-model defaults, by catalog id; absent while none is saved. */ defaults?: Record<string, ModelDefault> }

export const MAX_RECENTS = 5
const MAX_FAVORITES = 100
const MAX_ID = 100
const FILE = ["tui", "models.json"] as const

export const EMPTY_MODEL_PREFS: Readonly<ModelPrefs> = { favorites: [], recents: [] }

export const modelPrefsPath = (dataDir: string) => path.join(dataDir, ...FILE)

function ids(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) if (typeof entry === "string" && entry.length > 0 && entry.length <= MAX_ID && !out.includes(entry)) out.push(entry)
  return out.slice(0, max)
}

const MAX_DEFAULTS = 100
const word = (value: unknown) => (typeof value === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(value) ? value : undefined)

function defaultsOf(value: unknown): Record<string, ModelDefault> {
  const out: Record<string, ModelDefault> = {}
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out
  for (const [id, entry] of Object.entries(value).slice(0, MAX_DEFAULTS)) {
    if (id.length === 0 || id.length > MAX_ID || typeof entry !== "object" || entry === null || Array.isArray(entry)) continue
    const effort = word((entry as Record<string, unknown>).effort)
    const variant = word((entry as Record<string, unknown>).variant)
    if (effort || variant) out[id] = { ...(effort ? { effort } : {}), ...(variant ? { variant } : {}) }
  }
  return out
}

/** Any parsed JSON as complete preferences: bad entries are dropped, lists are capped. */
export function normalizeModelPrefs(raw: unknown): ModelPrefs {
  const source = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const defaults = defaultsOf(source.defaults)
  return { favorites: ids(source.favorites, MAX_FAVORITES), recents: ids(source.recents, MAX_RECENTS), ...(Object.keys(defaults).length ? { defaults } : {}) }
}

/**
 * The choice to send for `model` when the user picked it without an effort: its saved default, if any. A given effort or
 * variant always wins.
 */
export function withModelDefault<T extends ModelChoiceLike>(prefs: ModelPrefs, choice: T): T {
  const saved = prefs.defaults?.[choice.model]
  if (!saved || choice.effort !== undefined || choice.variant !== undefined) return choice
  return { ...choice, ...(saved.effort ? { effort: saved.effort } : {}), ...(saved.variant ? { variant: saved.variant } : {}) }
}

/** `choice`'s effort or variant saved as the default of its model; a choice with neither takes the saved default away. */
export function setModelDefault(prefs: ModelPrefs, choice: ModelChoiceLike): ModelPrefs {
  const { [choice.model]: _old, ...others } = prefs.defaults ?? {}
  const next: Record<string, ModelDefault> = choice.effort || choice.variant ? { ...others, [choice.model]: { ...(choice.effort ? { effort: choice.effort } : {}), ...(choice.variant ? { variant: choice.variant } : {}) } } : others
  const { defaults: _previous, ...rest } = prefs
  return Object.keys(next).length ? { ...rest, defaults: next } : rest
}

/** The saved preferences; empty when the file is missing, unreadable or not JSON. */
export function readModelPrefs(dataDir: string): ModelPrefs {
  try {
    const file = modelPrefsPath(dataDir)
    if (!fs.existsSync(file)) return { favorites: [], recents: [] }
    return normalizeModelPrefs(JSON.parse(fs.readFileSync(file, "utf8")))
  } catch {
    return { favorites: [], recents: [] }
  }
}

/** Saves `prefs` (validated again); written whole, then renamed into place. */
export function writeModelPrefs(dataDir: string, prefs: ModelPrefs): { ok: true } | { ok: false; error: string } {
  const file = modelPrefsPath(dataDir)
  const temp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, `${JSON.stringify(normalizeModelPrefs(prefs), null, 2)}\n`)
    fs.renameSync(temp, file)
    return { ok: true }
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // Nothing left to clean up.
    }
    return { ok: false, error: `[TUI]: could not save ${file}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** A favorite added at the end, or taken out when it was one. */
export function toggleFavorite(prefs: ModelPrefs, model: string): ModelPrefs {
  const has = prefs.favorites.includes(model)
  return { ...prefs, favorites: has ? prefs.favorites.filter((id) => id !== model) : [...prefs.favorites, model].slice(-MAX_FAVORITES) }
}

/** `model` first in the recents (once), the list kept to the last `MAX_RECENTS`. The same object when nothing changes. */
export function noteRecent(prefs: ModelPrefs, model: string): ModelPrefs {
  if (prefs.recents[0] === model) return prefs
  return { ...prefs, recents: [model, ...prefs.recents.filter((id) => id !== model)].slice(0, MAX_RECENTS) }
}
