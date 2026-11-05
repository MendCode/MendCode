import { readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { expandPermissionPath, toolPaths } from "./permission-rules"
import { asShellCall, insideProject, isSecretPath, projectRoot, realOf } from "./smart-permissions"

/**
 * What MendCode itself loads into a session's prompt, as the daemon's skill and instruction loaders found them: the folder of
 * every skill the model may load and every AGENTS.md / CLAUDE.md file. Paths as found; symlinks are resolved here.
 */
export type InstructionRoots = { dirs: readonly string[]; files: readonly string[] }

/** Tools that only read: listing, finding, searching and reading files. Never a write, never a command. */
const READ_TOOLS = new Set(["read", "grep", "glob", "ls", "list"])
/** Login and token files that `isSecretPath` does not name. */
const TOKEN_FILE = /^(auth|tokens?|oauth[\w.-]*)\.json$/i
/** A `grep` over a folder reads every file in it: at most this many entries are checked for secrets before it asks instead. */
const MAX_SCANNED = 2000

const contains = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative === "" || !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
}
const secretName = (relative: string) => isSecretPath(relative) || relative.split(/[\\/]/).some((segment) => segment === ".git" || TOKEN_FILE.test(segment))

/** Whether a folder holds a secrets-looking file anywhere below it (or more entries than are checked). */
function holdsSecrets(dir: string): boolean {
  let seen = 0
  const pending = [dir]
  while (pending.length) {
    const current = pending.pop()!
    let entries: import("node:fs").Dirent[]
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (++seen > MAX_SCANNED || secretName(entry.name)) return true
      if (entry.isDirectory()) pending.push(path.join(current, entry.name))
    }
  }
  return false
}

/** Glob patterns that could climb out of the folder they are given. */
function climbs(record: Record<string, unknown>): boolean {
  const patterns = [record.pattern, record.include, ...(Array.isArray(record.patterns) ? record.patterns : [])].filter((value): value is string => typeof value === "string")
  return patterns.some((pattern) => path.isAbsolute(pattern) || pattern.startsWith("~") || pattern.startsWith("$") || pattern.split(/[\\/]/).includes(".."))
}

/**
 * True when a read-only call (read, grep, glob, ls) touches nothing outside the project but MendCode's own skill folders and
 * instruction files for this session. Every target is resolved through symlinks first, so `..` or a link that leads out of a
 * root does not count; a secrets-looking path inside a root (`.env*`, keys, `credentials*`, `auth.json`, `.git/`) does not
 * count either, nor a `grep` over a folder that holds one. Instruction files are single files: only `read` reaches them.
 */
export function instructionRootRead(input: { tool: string; args: unknown; cwd: string; roots: InstructionRoots }): boolean {
  const { tool, args } = asShellCall(input.tool, input.args)
  if (!READ_TOOLS.has(tool)) return false
  const record = (args ?? {}) as Record<string, unknown>
  if (climbs(record)) return false
  const targets = toolPaths(tool, args)
  if (!targets.length) return false
  const project = projectRoot(input.cwd)
  const home = realOf(homedir())
  const dirs = input.roots.dirs.map((dir) => path.resolve(dir))
  const files = new Set(input.roots.files.map((file) => realOf(path.resolve(file))))
  // A filesystem root or the home folder is never a skill folder, whatever a configuration says.
  const realRoot = (candidates: readonly string[], real: string) => candidates.map(realOf).find((dir) => path.parse(dir).root !== dir && dir !== home && contains(dir, real))
  return targets.every((target) => {
    const absolute = path.resolve(input.cwd, expandPermissionPath(target))
    if (insideProject(absolute, project)) return true
    const real = realOf(absolute)
    if (files.has(real)) return tool === "read"
    // Only the roots the path names are resolved, unless none of them holds it.
    const named = dirs.filter((dir) => contains(dir, absolute) || contains(dir, real))
    const root = (named.length ? realRoot(named, real) : undefined) ?? (named.length === dirs.length ? undefined : realRoot(dirs, real))
    if (!root || secretName(path.relative(root, real)) || secretName(path.basename(absolute))) return false
    return tool !== "grep" || !statSync(real, { throwIfNoEntry: false })?.isDirectory() || !holdsSecrets(real)
  })
}
