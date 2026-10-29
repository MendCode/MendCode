import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/**
 * The one instruction loader. The system prompt (`createInstructionLoader`: session directory up to the project root) and the
 * `read` tool and `@file` mentions (`readInstructions`: instructions below the session directory, loaded when a file there is
 * read) share the same file rules, include rules, limits and mtime/size invalidation, so what the model is told does not
 * depend on which path delivered it.
 *
 * File rule, per directory: the first of `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md` and the configured
 * fallback names. A directory with both `AGENTS.md` and `CLAUDE.md` loads `AGENTS.md` only (a `CLAUDE.md` that is just
 * `@AGENTS.md`, or a symlink to it, therefore never loads twice); `AGENTS.override.md` replaces the rest of its directory.
 */
export const INSTRUCTION_OVERRIDE = "AGENTS.override.md"
export const INSTRUCTION_FILES = [INSTRUCTION_OVERRIDE, "AGENTS.md", "CLAUDE.md", "CONTEXT.md"] as const
export const MAX_INSTRUCTION_CHARS = 16_000
/** Characters of every file and include of one load together. */
export const MAX_INSTRUCTION_TOTAL_CHARS = 64_000
export const MAX_INSTRUCTION_FILES = 100
const MAX_INCLUDE_DEPTH = 8
const MAX_CACHED = 500

export type InstructionOptions = {
  maxChars?: number
  /** Whether `@relative/path` lines pull in other files (the `instruction_includes` feature). */
  includes?(): boolean
  /** Extra file names tried after the standard ones. */
  fallbacks?(): readonly string[]
  /** Names that mark a project root; an empty list means the session directory only. `.git` by default. */
  rootMarkers?(): readonly string[]
  /** Where an upward walk without a root marker stops. The user's home by default. */
  home?: string
}

export type InstructionSection = {
  /** The path as found (before symlinks). */
  file: string
  resolved: string
  /** The file's text, already cut to the remaining aggregate budget. */
  text: string
  /** `mtimeMs:size`: changes when the file is edited. */
  signature: string
  included: boolean
}
export type InstructionState = { visited: Set<string>; remaining: number }
export const newInstructionState = (): InstructionState => ({ visited: new Set(), remaining: MAX_INSTRUCTION_TOTAL_CHARS })

type Cached = { signature: string; text: string }
const cache = new Map<string, Cached>()

const signatureOf = (info: { mtimeMs: number; size: number }) => `${info.mtimeMs}:${info.size}`
const real = (file: string) => { try { return realpathSync(file) } catch { return undefined } }
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative === "" || !(relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
}

/** The file's text (bounded) and signature, re-read only when its mtime or size changed. */
export function readInstructionFile(file: string, maxChars = MAX_INSTRUCTION_CHARS): { text: string; signature: string } | undefined {
  let info: ReturnType<typeof statSync>
  try {
    info = statSync(file)
    if (!info.isFile()) return undefined
  } catch {
    return undefined
  }
  const signature = signatureOf(info)
  const key = `${maxChars}\u0000${file}`
  const cached = cache.get(key)
  if (cached?.signature === signature) return cached
  let raw: string
  try {
    const fd = openSync(file, "r")
    try {
      const bytes = Buffer.alloc(maxChars * 4 + 1)
      const length = readSync(fd, bytes)
      raw = bytes.subarray(0, length).toString("utf8")
    } finally { closeSync(fd) }
  } catch { return undefined }
  const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n[… truncated at ${maxChars} characters]` : raw
  if (cache.size >= MAX_CACHED) cache.clear()
  const entry = { signature, text }
  cache.set(key, entry)
  return entry
}

/** The instruction file of one directory (the rule above), or undefined. */
export function instructionFileIn(dir: string, options: Pick<InstructionOptions, "fallbacks"> = {}): string | undefined {
  for (const name of [...INSTRUCTION_FILES, ...(options.fallbacks?.() ?? [])]) {
    const file = path.join(dir, name)
    if (statSync(file, { throwIfNoEntry: false })?.isFile()) return file
  }
  return undefined
}

/**
 * Directories from the project root down to `cwd`. The root is the first directory holding one of the root markers. Without
 * a marker the walk is bounded: inside the user's home it stops at the home (included) or where the filesystem changes;
 * outside it the session directory stands alone. It never reaches `/`.
 */
export function instructionChain(cwd: string, options: Pick<InstructionOptions, "rootMarkers" | "home"> = {}): string[] {
  const markers = options.rootMarkers?.() ?? [".git"]
  const start = path.resolve(cwd)
  if (markers.length === 0) return [start]
  const home = real(options.home ?? homedir())
  const resolvedStart = real(start) ?? start
  const bounded = home !== undefined && inside(home, resolvedStart)
  const device = (dir: string) => statSync(dir, { throwIfNoEntry: false })?.dev
  const dirs: string[] = []
  let dir = start
  while (true) {
    dirs.unshift(dir)
    if (markers.some((marker) => existsSync(path.join(dir, marker)))) return dirs
    const parent = path.dirname(dir)
    if (parent === dir) break
    // Inside the home the search for a marker never goes above the home or across a filesystem boundary.
    if (bounded && ((real(dir) ?? dir) === home || device(parent) !== device(dir))) break
    dir = parent
  }
  return bounded ? dirs : [start]
}

/**
 * Reads `file` and, when includes are on, the files its whole `@relative/path` lines name (outside code fences). Included
 * files resolve from the containing file, never leave the project root, and share the aggregate budget in `state`; each
 * file is delivered once. `emit` receives the file first, then its includes.
 */
export function collectInstructions(file: string, input: { root: string; includes: boolean; maxChars?: number; state: InstructionState; emit(section: InstructionSection): void }, depth = 0): void {
  const resolved = real(file)
  const { state } = input
  if (!resolved || state.visited.has(resolved) || state.visited.size >= MAX_INSTRUCTION_FILES || depth > MAX_INCLUDE_DEPTH || state.remaining <= 0) return
  state.visited.add(resolved)
  const read = readInstructionFile(file, input.maxChars ?? MAX_INSTRUCTION_CHARS)
  const text = read?.text.trim()
  if (!read || !text) return
  input.emit({ file, resolved, text: text.slice(0, state.remaining), signature: read.signature, included: depth > 0 })
  state.remaining -= text.length
  let fence: string | undefined
  for (const line of input.includes ? text.split(/\r?\n/) : []) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      fence = fence?.[0] === marker[0] ? undefined : marker
      continue
    }
    if (fence) continue
    const include = /^@([^\s<>"'`]+)$/.exec(line.trim())?.[1]
    if (!include || path.isAbsolute(include) || include.startsWith("~") || include.includes(":")) continue
    const target = real(path.resolve(path.dirname(file), include))
    if (target && inside(input.root, target) && target !== input.root) collectInstructions(target, input, depth + 1)
  }
}

/**
 * Project instructions for the system prompt: in each directory from the session directory up to the project root the
 * instruction file (rule above), outermost first, plus a global file (its AGENTS.override.md sibling wins over it) and
 * explicitly configured `paths`. Each file is bounded; files are re-read only when their mtime or size changes.
 */
export function createInstructionLoader(options: InstructionOptions & { globalFile?: string; paths?(cwd: string): string[] } = {}) {
  const maxChars = options.maxChars ?? MAX_INSTRUCTION_CHARS
  const globalOverride = () => options.globalFile ? path.join(path.dirname(options.globalFile), INSTRUCTION_OVERRIDE) : undefined

  function files(cwd: string) {
    const found = new Map<string, string>()
    const add = (file: string) => {
      if (found.size >= MAX_INSTRUCTION_FILES) return
      const resolved = real(file)
      if (resolved && statSync(resolved, { throwIfNoEntry: false })?.isFile() && !found.has(resolved)) found.set(resolved, file)
    }
    if (options.globalFile) {
      const override = globalOverride()
      add(override && statSync(override, { throwIfNoEntry: false })?.isFile() ? override : options.globalFile)
    }
    const chain = instructionChain(cwd, options)
    for (const dir of chain) {
      const file = instructionFileIn(dir, options)
      if (file) add(file)
    }
    for (const raw of options.paths?.(cwd) ?? []) {
      if (/^https?:\/\//i.test(raw)) continue
      const pattern = raw.startsWith("~/") ? path.join(homedir(), raw.slice(2)) : raw
      const roots = path.isAbsolute(pattern) ? [path.parse(pattern).root] : chain
      const glob = new Bun.Glob(pattern.replace(/^\//, ""))
      for (const root of roots) {
        try { for (const file of glob.scanSync({ cwd: root, absolute: true, onlyFiles: true, followSymlinks: false })) {
          if (found.size >= MAX_INSTRUCTION_FILES) break
          if (!path.isAbsolute(pattern)) {
            const rel = path.relative(realpathSync(root), realpathSync(file))
            if (rel === ".." || rel.startsWith(".." + path.sep)) continue
          }
          add(file)
        } } catch {}
      }
    }
    return [...found.values()]
  }
  function instructionsFor(cwd: string) {
    const sections: string[] = []
    const root = real(instructionChain(cwd, options)[0]!)
    if (!root) return ""
    const state = newInstructionState()
    for (const file of files(cwd)) {
      collectInstructions(file, {
        root, includes: options.includes?.() !== false, maxChars, state,
        emit: (section) => {
          const source = section.file === options.globalFile || section.file === globalOverride() ? "global" : path.relative(cwd, section.file)
          const safeSource = source.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
          sections.push(`<instructions source="${safeSource}">\n${section.text}\n</instructions>`)
        },
      })
    }
    return sections.join("\n\n")
  }
  return Object.assign(instructionsFor, { files })
}
