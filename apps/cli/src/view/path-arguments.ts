import { readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** Commands whose argument is a path, and what they take: `/cd` and `/add-dir` a directory, `/attach` a file or a directory to walk into. */
const PATH_COMMANDS: Record<string, "directory" | "any"> = { cd: "directory", "add-dir": "directory", attach: "any" }
const MAX_ROWS = 40
const MAX_READ = 2000

export type PathMatch = { name: string; summary: string; directory: boolean }

export const takesPath = (command: string) => command in PATH_COMMANDS

/** The entries of one directory, read once per call: a keystroke reads at most `MAX_READ` names and `MAX_ROWS` rows come back. */
function entriesOf(directory: string): Array<{ name: string; directory: boolean }> {
  try {
    return readdirSync(directory, { withFileTypes: true }).slice(0, MAX_READ).map((entry) => ({
      name: entry.name,
      directory: entry.isDirectory() || entry.isSymbolicLink() && (() => { try { return statSync(join(directory, entry.name)).isDirectory() } catch { return false } })(),
    }))
  } catch { return [] }
}

/**
 * The paths that continue what was typed after `/cd `: the directory part is read from disk (relative to `base`, `~` is home), the rest
 * is a prefix filter. Hidden entries show only once the partial starts with a dot. Directories come first and end with `/`, so Tab walks
 * into them. Empty for a command that takes no path, a remote terminal (`base` undefined) or an unreadable directory. Local only.
 */
export function pathMatches(input: { command: string; args: string; base: string | undefined }): PathMatch[] {
  const kind = PATH_COMMANDS[input.command]
  if (!kind || !input.base) return []
  const typed = input.args.replace(/^\s+/, "")
  const slash = typed.lastIndexOf("/")
  const head = slash >= 0 ? typed.slice(0, slash + 1) : ""
  const partial = typed.slice(slash + 1)
  const expanded = head === "~/" || head.startsWith("~/") ? join(homedir(), head.slice(2)) : head
  const directory = resolve(input.base, expanded || ".")
  const lower = partial.toLowerCase()
  return entriesOf(directory)
    .filter((entry) => (kind === "any" || entry.directory) && entry.name.toLowerCase().startsWith(lower) && (partial.startsWith(".") || !entry.name.startsWith(".")))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
    .slice(0, MAX_ROWS)
    .map((entry) => ({ name: `${input.command} ${head}${entry.name}${entry.directory ? "/" : ""}`, summary: entry.directory ? "directory" : "file", directory: entry.directory }))
}

