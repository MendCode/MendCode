import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

/**
 * What `/fetch` learns from the working directory: the git branch and the project's languages. Offline and bounded:
 * a few small file reads and one capped directory walk. The file system and the clock are injected so tests use temp
 * dirs and a fake clock; `nodeFs` is the real one.
 */

export type FetchFs = {
  /** The file's text, or undefined when it is missing or unreadable. */
  readText(file: string): string | undefined
  /** The entries of a directory, or undefined when it is missing or unreadable. */
  list(dir: string): Array<{ name: string; dir: boolean }> | undefined
}

export const nodeFs: FetchFs = {
  readText(file) {
    try {
      return readFileSync(file, "utf8")
    } catch {
      return undefined
    }
  },
  list(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
    } catch {
      return undefined
    }
  },
}

export const SCAN_LIMITS = { files: 5_000, budgetMs: 40, top: 4 } as const
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "build", "graft"])

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", swift: "Swift",
  c: "C", h: "C", cc: "C++", cpp: "C++", hpp: "C++", cs: "C#", rb: "Ruby", php: "PHP",
  sh: "Shell", bash: "Shell", zsh: "Shell", lua: "Lua", dart: "Dart", zig: "Zig", ex: "Elixir", exs: "Elixir",
  vue: "Vue", svelte: "Svelte", html: "HTML", css: "CSS", scss: "CSS", sql: "SQL",
}

const SHORT_SHA = 7

/**
 * The branch of the repository containing `cwd`, found by walking up to a `.git` (a directory, or a worktree's
 * `gitdir:` file): the branch name, the short sha when HEAD is detached, "no git" otherwise.
 */
export function gitBranch(input: { cwd: string; fs: FetchFs }): string {
  const { fs } = input
  for (let dir = path.resolve(input.cwd); ; dir = path.dirname(dir)) {
    const git = path.join(dir, ".git")
    let head = fs.readText(path.join(git, "HEAD"))
    if (head === undefined) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readText(git) ?? "")?.[1]?.trim()
      if (pointer) head = fs.readText(path.join(path.resolve(dir, pointer), "HEAD"))
    }
    if (head !== undefined) {
      const ref = /^ref:\s*(?:refs\/heads\/)?(.+)$/m.exec(head)?.[1]?.trim()
      if (ref) return ref
      const sha = /^[0-9a-f]{40,64}\b/m.exec(head)?.[0]
      return sha ? sha.slice(0, SHORT_SHA) : "no git"
    }
    if (path.dirname(dir) === dir) return "no git"
  }
}

export type LanguageShare = { name: string; files: number; percent: number }
export type LanguageScan = { top: LanguageShare[]; /** Files seen, recognised or not. */ seen: number; /** The walk stopped at the file or time cap, so the shares are estimates. */ capped: boolean }

/**
 * Top languages by file count from a breadth-first walk of `root` (shallow files first): at most `files` files
 * and `budgetMs` of the injected clock, skipping dependency and build directories.
 */
export function scanLanguages(input: { root: string; fs: FetchFs; now(): number; files?: number; budgetMs?: number; top?: number }): LanguageScan {
  const limit = input.files ?? SCAN_LIMITS.files
  const deadline = input.now() + (input.budgetMs ?? SCAN_LIMITS.budgetMs)
  const counts = new Map<string, number>()
  const queue = [path.resolve(input.root)]
  let seen = 0
  let capped = false
  for (let head = 0; head < queue.length && !capped; head++) {
    const entries = input.fs.list(queue[head]!)
    if (!entries) continue
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.dir) {
        if (!SKIPPED_DIRS.has(entry.name)) queue.push(path.join(queue[head]!, entry.name))
        continue
      }
      if (seen >= limit) {
        capped = true
        break
      }
      seen++
      const language = LANGUAGES[entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase()]
      if (language && entry.name.includes(".")) counts.set(language, (counts.get(language) ?? 0) + 1)
    }
    if (!capped && head + 1 < queue.length && input.now() >= deadline) capped = true
  }
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0)
  const top = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, input.top ?? SCAN_LIMITS.top)
    .map(([name, files]) => ({ name, files, percent: Math.round((files / total) * 100) }))
  return { top, seen, capped }
}

/** What `/fetch` reads from disk for `cwd`. */
export function projectFacts(input: { cwd: string; fs?: FetchFs; now?(): number }) {
  const fs = input.fs ?? nodeFs
  return {
    project: path.basename(path.resolve(input.cwd)) || input.cwd,
    branch: gitBranch({ cwd: input.cwd, fs }),
    languages: scanLanguages({ root: input.cwd, fs, now: input.now ?? Date.now }),
  }
}
