import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { instructionChain, instructionFileIn, type InstructionOptions } from "@mendcode/tools"

/**
 * The orientation block of a session's first user message (feature `orientation`): where the session is, what the top of the tree
 * holds, how the project is tested, and which instruction files the system prompt already carries. It is the answer to the questions
 * a model otherwise spends its first calls on (`glob AGENTS.md`, `ls`, reading `package.json`). It is computed once, bounded, and sent
 * in the user message, so the cached system prefix is the same whatever the project.
 */
export const MAX_ORIENTATION_PATHS = 150
export const MAX_ORIENTATION_CHARS = 6_000

const SKIPPED = new Set([".git", "node_modules", "dist", "build", "out", ".next", ".turbo", ".cache", "coverage", "target", "__pycache__", ".venv", "venv", ".DS_Store"])
const LOCKFILES: ReadonlyArray<readonly [string, string]> = [["bun.lock", "bun"], ["bun.lockb", "bun"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["package-lock.json", "npm"]]

const readText = (file: string, limit = 64_000) => { try { return readFileSync(file, "utf8").slice(0, limit) } catch { return undefined } }

/** Plain names from a `.gitignore` (no wildcards or negations): enough to keep generated folders out of the listing. */
function ignoredNames(root: string): Set<string> {
  const names = new Set<string>()
  for (const raw of (readText(path.join(root, ".gitignore")) ?? "").split("\n")) {
    const line = raw.trim().replace(/^\//, "").replace(/\/$/, "")
    if (line && !line.startsWith("#") && !line.startsWith("!") && !/[*?[\]/]/.test(line)) names.add(line)
  }
  return names
}

function entries(dir: string, skip: (name: string) => boolean): Array<{ name: string; directory: boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !skip(entry.name))
      .map((entry) => ({ name: entry.name, directory: entry.isDirectory() || (entry.isSymbolicLink() && statSync(path.join(dir, entry.name), { throwIfNoEntry: false })?.isDirectory() === true) }))
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
  } catch { return [] }
}

/** Top-level entries first, then the entries of each top-level directory, at most `MAX_ORIENTATION_PATHS` in all. */
export function topLevelTree(cwd: string): { paths: string[]; omitted: number } {
  const ignored = ignoredNames(cwd)
  const skip = (name: string) => SKIPPED.has(name) || ignored.has(name)
  const top = entries(cwd, skip)
  const paths = top.map((entry) => entry.directory ? `${entry.name}/` : entry.name)
  let total = paths.length
  const nested: string[] = []
  for (const entry of top) {
    if (!entry.directory) continue
    for (const child of entries(path.join(cwd, entry.name), skip)) {
      total += 1
      nested.push(`${entry.name}/${child.name}${child.directory ? "/" : ""}`)
    }
  }
  const room = Math.max(0, MAX_ORIENTATION_PATHS - paths.length)
  const shown = [...paths.slice(0, MAX_ORIENTATION_PATHS), ...nested.slice(0, room)]
  return { paths: shown, omitted: total - shown.length }
}

/** The package manager and test command a project's own files name; undefined when nothing says. */
export function projectCommands(cwd: string): string | undefined {
  const manifest = readText(path.join(cwd, "package.json"))
  if (manifest !== undefined) {
    const manager = LOCKFILES.find(([file]) => existsSync(path.join(cwd, file)))?.[1]
    let test: string | undefined
    try { test = (JSON.parse(manifest) as { scripts?: Record<string, unknown> }).scripts?.test as string | undefined } catch {}
    const run = manager ? (manager === "npm" ? "npm test" : `${manager} run test`) : undefined
    const parts = [manager ? `package manager ${manager}` : undefined, run && typeof test === "string" ? `tests: ${run} (${test.slice(0, 120)})` : undefined].filter(Boolean)
    if (parts.length) return parts.join(" · ")
  }
  if (existsSync(path.join(cwd, "Cargo.toml"))) return "cargo · tests: cargo test"
  if (existsSync(path.join(cwd, "go.mod"))) return "go · tests: go test ./..."
  if (existsSync(path.join(cwd, "pyproject.toml"))) return "python (pyproject.toml)"
  return undefined
}

/** The checked-out branch, read from `.git/HEAD` (a worktree's `.git` file points at it); undefined outside a repository. */
export function gitBranch(cwd: string): string | undefined {
  let dir = path.resolve(cwd)
  for (let depth = 0; depth < 8; depth += 1) {
    const dot = path.join(dir, ".git")
    const info = statSync(dot, { throwIfNoEntry: false })
    if (info) {
      let git = dot
      if (info.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(readText(dot, 1_000) ?? "")?.[1]
        if (!pointer) return undefined
        git = path.resolve(dir, pointer.trim())
      }
      const head = readText(path.join(git, "HEAD"), 500)?.trim()
      const ref = head ? /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] : undefined
      return ref ?? (head ? `detached ${head.slice(0, 8)}` : undefined)
    }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** The instruction files of the system prompt that sit in the project (global and configured files are not listed). */
export function projectInstructionFiles(cwd: string, instructions?: InstructionOptions): string[] {
  try {
    return instructionChain(cwd, instructions).flatMap((dir) => {
      const file = instructionFileIn(dir, instructions)
      return file ? [path.relative(cwd, file) || path.basename(file)] : []
    })
  } catch { return [] }
}

export function orientationBlock({ cwd, instructions }: { cwd: string; instructions?: InstructionOptions }): string {
  const tree = topLevelTree(cwd)
  const branch = gitBranch(cwd)
  const commands = projectCommands(cwd)
  const files = projectInstructionFiles(cwd, instructions)
  const lines = [
    `cwd: ${cwd}`,
    ...(branch ? [`git branch: ${branch}`] : []),
    ...(commands ? [commands] : []),
    files.length ? `instruction files already in your system prompt (do not search for them): ${files.join(", ")}` : "no project instruction file (AGENTS.md, CLAUDE.md) exists here or above",
    `files (${tree.paths.length}${tree.omitted ? ` of ${tree.paths.length + tree.omitted}` : ""}):`,
    ...tree.paths,
  ]
  let text = lines.join("\n")
  if (text.length > MAX_ORIENTATION_CHARS) text = `${text.slice(0, MAX_ORIENTATION_CHARS)}\n…`
  return `<orientation>\n${text}\n</orientation>`
}
