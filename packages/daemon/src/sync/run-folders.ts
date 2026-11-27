import { opendir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

/** Subfolders one answer carries, and entries looked at to find them: a folder of files costs no more than this. */
export const MAX_FOLDER_NAMES = 500
export const MAX_FOLDER_INSPECTED = 5000

export const FOLDER_OUTSIDE = "[SYNC]: that folder is not a project of this machine"
export const FOLDER_MISSING = "[SYNC]: no such directory on this machine"

export type FolderListing = { directory: string; names: string[]; truncated: boolean }

/** The real folder a typed path names for a session in `base` (`~` is home, a relative path starts at `base`), or undefined when it is not a directory here. */
export async function resolveFolder({ base, requested }: { base: string; requested: string }): Promise<string | undefined> {
  const raw = requested === "~" || requested.startsWith("~/") ? path.join(homedir(), requested.slice(1)) : requested
  try {
    const real = await realpath(path.resolve(base, raw))
    return (await stat(real)).isDirectory() ? real : undefined
  } catch { return undefined }
}

/**
 * The subfolders of a folder a device asked about (links to folders too), names only. The folder must exist and lie inside the folders this
 * machine already works in (`allowed`): the same rule that lets a device start a chat there. Returns the refusal text instead when it does not.
 */
export async function listFolders({ base, requested, allowed }: { base: string; requested: string; allowed(directory: string): boolean }): Promise<FolderListing | { refusal: string }> {
  const directory = await resolveFolder({ base, requested })
  if (!directory) return { refusal: FOLDER_MISSING }
  if (!allowed(directory)) return { refusal: FOLDER_OUTSIDE }
  const names: string[] = []
  let truncated = false
  try {
    let inspected = 0
    for await (const entry of await opendir(directory)) {
      if (++inspected > MAX_FOLDER_INSPECTED) { truncated = true; break }
      const folder = entry.isDirectory() || entry.isSymbolicLink() && await stat(path.join(directory, entry.name)).then((found) => found.isDirectory(), () => false)
      if (!folder) continue
      if (names.length >= MAX_FOLDER_NAMES) { truncated = true; break }
      names.push(entry.name)
    }
  } catch { return { refusal: FOLDER_MISSING } }
  return { directory, names: names.sort(), truncated }
}
