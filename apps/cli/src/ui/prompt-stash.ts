import fs from "node:fs"
import path from "node:path"
import type { PendingAttachment } from "../view/attachments"

/**
 * v1's prompt stash: park the text being typed, get it back later. A short list kept on this machine in
 * `<dataDir>/tui/stash.json` (never through the daemon), so it survives the terminal. Text and attachment references stay together. Values are checked by hand, so the startup graph stays free of zod; a
 * missing or broken file is an empty stash.
 */

export type StashEntry = { text: string; at: number; attachments?: PendingAttachment[] }

export const STASH_LIMIT = 20
export const STASH_TEXT_LIMIT = 100_000

export const stashPath = (dataDir: string) => path.join(dataDir, "tui", "stash.json")

function normalize(raw: unknown): StashEntry[] {
  const list = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as { entries?: unknown }).entries : undefined
  if (!Array.isArray(list)) return []
  const entries: StashEntry[] = []
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue
    const { text, at, attachments: rawAttachments } = item as { text?: unknown; at?: unknown; attachments?: unknown }
    const attachments: PendingAttachment[] = Array.isArray(rawAttachments) ? rawAttachments.filter((entry) => {
      if (!entry || typeof entry !== "object" || typeof entry.name !== "string") return false
      if (entry.kind === "text") return typeof entry.content === "string" && entry.content.length <= STASH_TEXT_LIMIT
      return (entry.kind === "image" || entry.kind === "document") && entry.ref && /^[a-f0-9]{64}$/.test(entry.ref.sha256) && typeof entry.ref.mime === "string" && Number.isFinite(entry.ref.bytes)
    }).slice(0, 20) : []
    if (typeof text !== "string" || text.trim() === "" && !attachments.length) continue
    entries.push({ text: text.slice(0, STASH_TEXT_LIMIT), at: typeof at === "number" && Number.isFinite(at) ? at : 0, ...(attachments.length ? { attachments } : {}) })
  }
  return entries.slice(-STASH_LIMIT)
}

/** The saved entries, oldest first; empty when the file is missing, unreadable or not what we wrote. */
export function readStash(dataDir: string): StashEntry[] {
  try {
    const file = stashPath(dataDir)
    return fs.existsSync(file) ? normalize(JSON.parse(fs.readFileSync(file, "utf8"))) : []
  } catch {
    return []
  }
}

/** Writes the whole list, then renames it into place. */
export function writeStash(dataDir: string, entries: readonly StashEntry[]): { ok: true } | { ok: false; error: string } {
  const file = stashPath(dataDir)
  const temp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, `${JSON.stringify({ entries }, null, 2)}\n`, { mode: 0o600 })
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

/**
 * The stash of one terminal. Without a data dir it lives in memory only. The file is read on first use and
 * after that this object is the truth for the session; every change is saved at once (the list is tiny).
 */
export function createPromptStash(input: { dataDir?: string | undefined; now?: () => number }) {
  const now = input.now ?? Date.now
  let entries: StashEntry[] | undefined

  const load = () => (entries ??= input.dataDir ? readStash(input.dataDir) : [])
  function save(): { ok: true } | { ok: false; error: string } {
    return input.dataDir ? writeStash(input.dataDir, load()) : { ok: true }
  }

  return {
    /** Oldest first; the last one is what `pop` returns. */
    list: (): readonly StashEntry[] => load(),
    get size() {
      return load().length
    },
    /** Parks `text` (ignored when blank). The oldest entry goes when the list is full. */
    push(text: string, attachments: readonly PendingAttachment[] = []) {
      if (text.trim() === "" && !attachments.length) return { ok: true as const, saved: false }
      const list = load()
      const before = structuredClone(list)
      list.push({ text: text.slice(0, STASH_TEXT_LIMIT), at: now(), ...(attachments.length ? { attachments: structuredClone([...attachments]) } : {}) })
      if (list.length > STASH_LIMIT) list.splice(0, list.length - STASH_LIMIT)
      const result = save()
      if (!result.ok) entries = before
      return { ...result, saved: result.ok }
    },
    /** Takes an entry out: the newest, or the 1-based `number` as `list` shows it newest first. */
    pop(number?: number, replacement?: StashEntry): { entry?: StashEntry; result: ReturnType<typeof save> } {
      const list = load()
      const index = number === undefined ? list.length - 1 : list.length - number
      if (index < 0 || index >= list.length) return { result: { ok: true } }
      const before = structuredClone(list)
      const [entry] = list.splice(index, 1)
      if (replacement) list.push(replacement)
      const result = save()
      if (!result.ok) { entries = before; return { result } }
      return { ...(entry ? { entry } : {}), result }
    },
    /** Empties the stash. */
    clear() {
      const before = structuredClone(load())
      entries = []
      const result = save()
      if (!result.ok) entries = before
      return result
    },
  }
}
export type PromptStash = ReturnType<typeof createPromptStash>
