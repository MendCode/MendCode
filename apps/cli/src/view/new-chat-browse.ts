import { opendir, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

/**
 * The folder browsing of the "New chat in…" picker (docs/sidebar.md): what a typed path means, which subfolders it offers and how Tab,
 * `→`, `←` and Backspace move through them. The parsing is plain text work; the only disk reads are `readDirectories` and `isGitRepo`,
 * each asked on a key press (never while drawing), bounded and cached by the picker for as long as it stays open. Loaded with the picker.
 */

/** Subfolders kept from one directory, and entries looked at to find them (a folder of files costs no more than this). */
export const MAX_DIRECTORIES = 500
export const MAX_INSPECTED = 5000

const TOP_LEVELS = new Set(["~/", "/", "./", "../"])

/** Whether the typed text names a path (and so lists directories from the disk) instead of filtering the known folders: `~`, `/`, `./`, `../` or any text with a slash. */
export const looksLikePath = (query: string) => {
  const typed = query.trim()
  return /^(~|\/|\.{1,2}(\/|$))/.test(typed) || typed.includes("/")
}

/** The typed path split at its last slash: `head` is the directory to read (kept as typed), `partial` what is being named in it. `~`, `.` and `..` alone name a directory. */
export function parseBrowse(typed: string): { head: string; partial: string } {
  const bare = typed === "~" || typed === "." || typed === ".." ? `${typed}/` : typed
  const slash = bare.lastIndexOf("/")
  return { head: bare.slice(0, slash + 1), partial: bare.slice(slash + 1) }
}

/** The absolute path a typed path names: `~` is home, a relative path starts from `base`. */
export const expandTyped = ({ typed, base, home }: { typed: string; base: string; home: string }) =>
  resolve(base, typed === "~" ? home : typed.startsWith("~/") ? join(home, typed.slice(2)) : typed)

/** The folder's own name at the end of a path. */
export const lastSegment = (directory: string) => directory.replace(/\/+$/, "").split("/").pop() ?? ""

/**
 * The names that fit what is typed, best first: those that start with it, then those that hold it, then those that hold its letters in
 * order (fuzzy); each group alphabetical. Hidden folders appear only when the typed name starts with a dot. Returns how many start with it.
 */
export function rankNames({ names, partial }: { names: readonly string[]; partial: string }): { ranked: string[]; prefixCount: number } {
  const lower = partial.toLowerCase()
  const scored: Array<{ name: string; score: number }> = []
  for (const name of names) {
    if (name.startsWith(".") && !partial.startsWith(".")) continue
    const text = name.toLowerCase()
    const score = !lower || text.startsWith(lower) ? 0 : text.includes(lower) ? 1 : subsequence(text, lower) ? 2 : undefined
    if (score !== undefined) scored.push({ name, score })
  }
  scored.sort((a, b) => a.score - b.score || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.name < b.name ? -1 : 1))
  return { ranked: scored.map((found) => found.name), prefixCount: scored.filter((found) => found.score === 0).length }
}

function subsequence(text: string, letters: string): boolean {
  let at = 0
  for (const letter of text) if (letter === letters[at] && ++at === letters.length) return true
  return false
}

const commonPrefix = (names: readonly string[]) => {
  let prefix = names[0] ?? ""
  for (const name of names) {
    let end = 0
    while (end < prefix.length && end < name.length && prefix[end]!.toLowerCase() === name[end]!.toLowerCase()) end++
    prefix = prefix.slice(0, end)
  }
  return prefix
}

/**
 * What Tab leaves in the field: one name that starts with the typed one completes and enters it; several complete their common prefix;
 * when there is nothing more to add, the picked folder is entered. Undefined when there is nothing to do.
 */
export function completeTab({ head, partial, prefixed, picked }: { head: string; partial: string; prefixed: readonly string[]; picked?: string | undefined }): string | undefined {
  if (partial && prefixed.length === 1) return `${head}${prefixed[0]}/`
  if (partial && prefixed.length > 1) {
    const common = commonPrefix(prefixed)
    if (common.length > partial.length) return `${head}${common}`
  }
  return picked === undefined ? undefined : `${head}${picked}/`
}

/** `←` at the end of a directory: its parent, as typed. `~/` goes to the folder above home; `/` has none. Undefined when the field does not end a directory. */
export function goUp({ typed, home }: { typed: string; home: string }): string | undefined {
  if (!typed.endsWith("/") || typed === "/") return undefined
  if (typed === "~/") return `${dirname(home).replace(/\/+$/, "")}/`
  if (typed === "./") return "../"
  if (typed.endsWith("../")) return `${typed}../`
  return typed.slice(0, typed.slice(0, -1).lastIndexOf("/") + 1)
}

/** Backspace at the end of a directory takes its last name away; the first slash of a path (`~/`, `/`, `./`, `../`) is plain text and goes by itself. */
export function eraseBack({ typed, home }: { typed: string; home: string }): string | undefined {
  if (TOP_LEVELS.has(typed) || typed.endsWith("/../")) return undefined
  return goUp({ typed, home })
}

/** The folder a "Browse folders…" row opens: the parent most known folders share under home (`~/Code/`), else home. */
export function usualRoot({ folders, home }: { folders: readonly string[]; home: string }): string {
  const counts = new Map<string, number>()
  for (const folder of folders) {
    if (!folder.startsWith(`${home}/`)) continue
    const parent = dirname(folder)
    counts.set(parent, (counts.get(parent) ?? 0) + 1)
  }
  let best = home
  let most = 0
  for (const [parent, count] of counts) if (count > most) { best = parent; most = count }
  return best === home ? "~/" : `~${best.slice(home.length)}/`
}

/** The name of the folder `typed` would create: the last name of a path that is none yet, undefined for `.`/`..` or a path with no name. */
export const nameToCreate = (typed: string) => {
  const name = lastSegment(typed.trim())
  return !name || name === "." || name === ".." || name === "~" ? undefined : name
}

/** The subfolders of a directory (links to folders too), at most `MAX_DIRECTORIES`, looking at no more than `MAX_INSPECTED` entries. Empty for a folder that cannot be read. */
export async function readDirectories(directory: string): Promise<string[]> {
  const names: string[] = []
  try {
    let inspected = 0
    for await (const entry of await opendir(directory)) {
      if (++inspected > MAX_INSPECTED) break
      if (entry.isDirectory() || entry.isSymbolicLink() && await stat(join(directory, entry.name)).then((found) => found.isDirectory(), () => false)) names.push(entry.name)
      if (names.length >= MAX_DIRECTORIES) break
    }
  } catch { /* an unreadable folder offers nothing */ }
  return names
}

/** What a path is on the disk: a directory, some other file, or nothing. */
export async function kindOfPath(path: string): Promise<"directory" | "file" | undefined> {
  try { return (await stat(path)).isDirectory() ? "directory" : "file" } catch { return undefined }
}

/** Whether the folder is the top of a git repository (it holds `.git`, a folder or a worktree's file). */
export const isGitRepo = (directory: string) => stat(join(directory, ".git")).then(() => true, () => false)
