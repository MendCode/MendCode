import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { MAX_PACKAGE_BYTES, MAX_PACKAGE_FILES, PackageError } from "@mendcode/packages"

/**
 * What the chat approval of a package covers. The fingerprint hashes EVERY byte of EVERY file (so a change after the preview voids
 * the approval); the summary is what the approval shows of the tree: counts, size, the biggest files, and every file that can run
 * or configure something, in full. A tree over a limit is refused with the limit, the measured value and the shell alternative.
 * The file and byte limits are the ones a package has anywhere (`package install` refuses the same trees).
 */
export const TREE_LIMITS = { depth: 12, files: MAX_PACKAGE_FILES, bytes: MAX_PACKAGE_BYTES, runnable: 150, largest: 5, folders: 12 } as const
/** The scan stops counting here: a tree this big is refused whatever its exact size. */
const COUNT_STOP = 20_000
const SKIPPED = new Set([".git", "node_modules"])
const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".fish", ".py", ".rb", ".pl", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".ps1", ".bat", ".cmd", ".command", ".exe", ".dll", ".so", ".dylib", ".node", ".wasm"])
/** Files that configure hooks, servers, tools or the status line wherever they sit. */
const CONFIG_NAMES = new Set(["hooks.json", "mcp.json", ".mcp.json", "statusline.json"])
/** Folders whose files MendCode loads or runs: a file below one is listed whatever its name. */
const RUNNABLE_FOLDERS = new Set(["hooks", "bin", "scripts", "tools", "extensions"])

export type TreeSummary = {
  files: number
  bytes: number
  /** Files and bytes per top-level folder (files at the root under `(root)`), the biggest first. */
  folders: Array<{ name: string; files: number; bytes: number }>
  omittedFolders?: number
  largest: Array<{ path: string; bytes: number }>
  /** Every executable, script, hook, tool definition and configuration file, listed in full; the tree is refused when there are more than the approval can list. */
  runnable: Array<{ path: string; bytes: number; why: "executable bit" | "script or binary" | "hook or configuration" | "loaded from a code folder" }>
}

type Entry = { file: string; relative: string; size: number; executable: boolean }

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

function why(entry: Entry): TreeSummary["runnable"][number]["why"] | undefined {
  const name = path.basename(entry.relative), extension = path.extname(name).toLowerCase()
  if (CONFIG_NAMES.has(name)) return "hook or configuration"
  if (entry.executable) return "executable bit"
  if (SCRIPT_EXTENSIONS.has(extension)) return "script or binary"
  if (entry.relative.split(path.sep).slice(0, -1).some((folder) => RUNNABLE_FOLDERS.has(folder))) return "loaded from a code folder"
  return undefined
}

/**
 * Fingerprints and summarises a package folder. `alternative` is the shell command the refusal offers instead.
 * Throws a PackageError for a link, an unsupported file or a tree over a limit.
 */
export function readPackageTree(directory: string, alternative: string): { fingerprint: string; summary: TreeSummary } {
  const entries: Entry[] = []
  let counted = 0, bytes = 0, deepest = 0, stopped = false
  const scan = (folder: string, depth: number) => {
    deepest = Math.max(deepest, depth)
    const root = lstatSync(folder)
    if (!root.isDirectory() || root.isSymbolicLink()) throw new PackageError("Package directory must not be linked")
    if (depth > TREE_LIMITS.depth + 1) return
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((first, second) => first.name.localeCompare(second.name))) {
      if (SKIPPED.has(entry.name)) continue
      const file = path.join(folder, entry.name), stat = lstatSync(file)
      if (stat.isSymbolicLink()) throw new PackageError("Linked package resources cannot be approved")
      if (stat.isDirectory()) scan(file, depth + 1)
      else if (stat.isFile()) {
        if (counted >= COUNT_STOP) { stopped = true; return }
        counted++
        bytes += stat.size
        entries.push({ file, relative: path.relative(directory, file), size: stat.size, executable: (stat.mode & 0o111) !== 0 })
      } else throw new PackageError("Unsupported package resource")
      if (stopped) return
    }
  }
  scan(directory, 0)
  const tooBig = (what: string, limit: string, found: string) => new PackageError(`Package tree is too large to approve in chat: ${what} (limit ${limit}, found ${found}). Nothing was changed. ${alternative}`)
  if (deepest > TREE_LIMITS.depth) throw tooBig("nested folders", `${TREE_LIMITS.depth} levels`, `${deepest} levels`)
  if (counted > TREE_LIMITS.files) throw tooBig("files", `${TREE_LIMITS.files}`, stopped ? `more than ${COUNT_STOP}` : `${counted}`)
  if (bytes > TREE_LIMITS.bytes) throw tooBig("total size", megabytes(TREE_LIMITS.bytes), megabytes(bytes))
  const runnable = entries.flatMap((entry) => {
    const reason = why(entry)
    return reason ? [{ path: entry.relative.split(path.sep).join("/").slice(0, 160), bytes: entry.size, why: reason }] : []
  }).sort((first, second) => (first.path < second.path ? -1 : first.path > second.path ? 1 : 0))
  if (runnable.length > TREE_LIMITS.runnable) throw tooBig("scripts, hooks, tools and executables, which the approval must list one by one", `${TREE_LIMITS.runnable}`, `${runnable.length}`)
  const hash = createHash("sha256")
  for (const entry of entries) hash.update(entry.file).update(readFileSync(entry.file))
  const groups = new Map<string, { files: number; bytes: number }>()
  for (const entry of entries) {
    const top = entry.relative.includes(path.sep) ? entry.relative.split(path.sep)[0]! : "(root)"
    const group = groups.get(top) ?? { files: 0, bytes: 0 }
    group.files++
    group.bytes += entry.size
    groups.set(top, group)
  }
  const folders = [...groups].map(([name, group]) => ({ name, ...group })).sort((first, second) => second.bytes - first.bytes || first.name.localeCompare(second.name))
  const largest = [...entries].sort((first, second) => second.size - first.size || first.relative.localeCompare(second.relative)).slice(0, TREE_LIMITS.largest).map((entry) => ({ path: entry.relative.split(path.sep).join("/").slice(0, 160), bytes: entry.size }))
  return {
    fingerprint: hash.digest("hex"),
    summary: { files: counted, bytes, folders: folders.slice(0, TREE_LIMITS.folders), ...(folders.length > TREE_LIMITS.folders ? { omittedFolders: folders.length - TREE_LIMITS.folders } : {}), largest, runnable },
  }
}
