import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

/**
 * The Trash packages use, for authoring (`packages delete-local`) and for removing an installed package: `<base>/.Trash/<label>@<ms>@<id>`,
 * where `base` is the scope's data folder (the data dir, or `<project>/.mendcode`). Nothing is deleted when it moves there;
 * it can be restored for TRASH_RETENTION_MS, and anything older is deleted the next time something moves to the Trash.
 */
export const TRASH_DIR = ".Trash"
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const ENTRY = /^(.+)@(\d{10,15})@[0-9a-f]{8}$/

export type TrashEntry = { label: string; at: number; dir: string }

/** Moves `source` into the Trash under `label`; returns where it went. `rename` is injectable so tests can fail the move. */
export function moveToTrash(input: { base: string; source: string; label: string; now?: () => number; rename?: (from: string, to: string) => void }): string {
  const at = (input.now ?? Date.now)()
  if (lstatSync(path.join(input.base, TRASH_DIR), { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${TRASH_DIR} is a link; refusing to move files through it`)
  const target = path.join(input.base, TRASH_DIR, `${input.label}@${at}@${randomUUID().slice(0, 8)}`)
  mkdirSync(path.dirname(target), { recursive: true })
  ;(input.rename ?? renameSync)(input.source, target)
  pruneTrash({ base: input.base, now: at })
  return target
}

/** What the Trash holds for `label` (or everything), newest first. */
export function listTrash({ base, label }: { base: string; label?: string }): TrashEntry[] {
  const root = path.join(base, TRASH_DIR)
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((name): TrashEntry[] => {
    const match = ENTRY.exec(name)
    return match && (!label || match[1] === label) ? [{ label: match[1]!, at: Number(match[2]), dir: path.join(root, name) }] : []
  }).sort((a, b) => b.at - a.at)
}

/** Deletes entries older than the retention period (the only place the Trash is ever deleted from). Returns how many. */
export function pruneTrash({ base, now = Date.now(), keepMs = TRASH_RETENTION_MS }: { base: string; now?: number; keepMs?: number }): number {
  let pruned = 0
  for (const entry of listTrash({ base })) {
    if (now - entry.at <= keepMs || !lstatSync(entry.dir, { throwIfNoEntry: false })?.isDirectory()) continue
    rmSync(entry.dir, { recursive: true, force: true })
    pruned++
  }
  return pruned
}

/** Moves the newest Trash entry of `label` to `target` (which must not exist); returns it, or undefined when there is none. */
export function restoreFromTrash({ base, label, target, rename = renameSync }: { base: string; label: string; target: string; rename?: (from: string, to: string) => void }): TrashEntry | undefined {
  const entry = listTrash({ base, label })[0]
  if (!entry) return undefined
  if (existsSync(target)) throw new Error(`${path.basename(target)} already exists; remove it first`)
  mkdirSync(path.dirname(target), { recursive: true })
  rename(entry.dir, target)
  return entry
}
