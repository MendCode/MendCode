import { existsSync, readdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { walkProject } from "./walk"

/** The home folder or a directory above it: indexing it would read every project and private file of the user for one lookup. */
export function holdsHome(cwd: string, home = homedir()): boolean {
  const holds = (above: string, below: string) => {
    const from = relative(above, below)
    return from === "" || (!from.startsWith("..") && !isAbsolute(from))
  }
  // A session's directory is stored resolved, while HOME may be spelled through a link (`/home` -> `/var/home`, `/tmp` -> `/private/tmp`).
  return holds(resolve(cwd), resolve(home)) || holds(realOrSame(cwd), realOrSame(home))
}

function realOrSame(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return resolve(dir)
  }
}

/**
 * Where the code graph indexes (docs/code-graph.md, "Where it indexes"). No question is asked and nothing is shown when a folder is
 * skipped but one short footer phrase. `auto` (the default) indexes a folder inside a git repository, or a project folder without
 * one (`PROJECT_MARKERS`), whose sources, after ignores, stay under `AUTO_INDEX_MAX_FILES`; `on` indexes any folder; `off` none. Never the home folder, the root or a directory above them.
 */
export const GRAPH_INDEX_MODES = ["auto", "on", "off"] as const
export type GraphIndexMode = (typeof GRAPH_INDEX_MODES)[number]

/** Source files (after ignores) above which `auto` leaves a repository alone; `/graph on` indexes it anyway, up to the indexer's own cap. */
export const AUTO_INDEX_MAX_FILES = 10_000

/** Why a folder is not indexed, as the footer says it after `graph off · `. */
export const SKIP_REASONS = ["off", "home folder", "no git repo", "several repos", "large folder"] as const
export type GraphSkipReason = (typeof SKIP_REASONS)[number]
export type GraphGate = { index: true } | { index: false; reason: GraphSkipReason }

const INDEX: GraphGate = { index: true }
const skip = (reason: GraphSkipReason): GraphGate => ({ index: false, reason })

/** Size verdicts kept at once, and how long one holds before the folder is walked again. */
const KEPT = 64
const FRESH_MS = 10 * 60_000

/** The nearest directory at or above `dir` with a `.git` entry (a folder or a worktree's file), never the home folder or above it. */
export function gitRoot(dir: string, home = homedir()): string | undefined {
  for (let at = resolve(dir); ; at = dirname(at)) {
    if (holdsHome(at, home)) return undefined
    if (existsSync(join(at, ".git"))) return at
    if (dirname(at) === at) return undefined
  }
}

/** Whether `dir` holds two or more git repositories among its direct children (a folder of projects, not one). */
function holdsRepos(dir: string): boolean {
  let found = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue
      if (existsSync(join(dir, entry.name, ".git")) && ++found >= 2) return true
    }
  } catch {
    return false
  }
  return false
}

/** Files at a folder's top that make it a project even without git: an agent's instructions or a build manifest. */
const PROJECT_MARKERS = ["AGENTS.md", "CLAUDE.md", "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "setup.py", "requirements.txt", "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "mix.exs", "deno.json", "Package.swift", "CMakeLists.txt", "Makefile", "platformio.ini"]

/** Whether `dir` itself holds a project marker (`PROJECT_MARKERS`). */
export function isProject(dir: string): boolean {
  return PROJECT_MARKERS.some((name) => existsSync(join(dir, name)))
}

/** The standard folders of a home (Downloads, Desktop…): a stray manifest dropped there does not make them a project (a project unpacked inside one still is). */
const PERSONAL_FOLDERS = new Set(["Downloads", "Desktop", "Documents", "Pictures", "Movies", "Music", "Videos", "Public", "Library", "OneDrive", "iCloud Drive"])

function personalFolder(dir: string, home: string): boolean {
  const from = relative(resolve(home), resolve(dir))
  return PERSONAL_FOLDERS.has(from)
}

export type IndexGate = {
  /** What is known now without walking the folder: everything but the size of a repository not measured yet (`undefined` then). */
  peek(input: { cwd: string; mode: GraphIndexMode }): GraphGate | undefined
  /** The verdict, measuring the repository's size once per `FRESH_MS` when `auto` needs it. */
  check(input: { cwd: string; mode: GraphIndexMode; signal?: AbortSignal | undefined }): Promise<GraphGate>
}

/**
 * The gate every start of indexing asks (a graph tool, the Galaxy panel's code mode) and the daemon asks before it lists the graph tools.
 * Bounded: one walk per folder (stopped at the limit, the files dropped right after), at most `KEPT` verdicts remembered.
 */
export function createIndexGate(options: { home?: string | undefined; maxFiles?: number | undefined; now?: (() => number) | undefined } = {}): IndexGate {
  const home = options.home ?? homedir()
  const limit = options.maxFiles ?? AUTO_INDEX_MAX_FILES
  const now = options.now ?? Date.now
  const sizes = new Map<string, { at: number; large: boolean }>()
  const walking = new Map<string, Promise<boolean>>()

  function quick(cwd: string, mode: GraphIndexMode): GraphGate | "measure" {
    if (mode === "off") return skip("off")
    if (holdsHome(cwd, home)) return skip("home folder")
    if (mode === "on") return INDEX
    if (gitRoot(cwd, home)) return "measure"
    if (holdsRepos(cwd)) return skip("several repos")
    // Unpacked or not yet committed source still says it is a project: it is measured like a repository.
    return isProject(cwd) && !personalFolder(cwd, home) ? "measure" : skip("no git repo")
  }

  function measured(cwd: string): boolean | undefined {
    const known = sizes.get(cwd)
    return known && now() - known.at < FRESH_MS ? known.large : undefined
  }

  async function measure(cwd: string, signal: AbortSignal | undefined): Promise<boolean> {
    const known = measured(cwd)
    if (known !== undefined) return known
    let running = walking.get(cwd)
    if (!running) {
      running = walkProject({ cwd, signal: new AbortController().signal, maxFiles: limit })
        .then((walk) => walk.files.size >= limit)
        .catch(() => false)
        .then((large) => {
          sizes.delete(cwd)
          sizes.set(cwd, { at: now(), large })
          while (sizes.size > KEPT) sizes.delete(sizes.keys().next().value as string)
          return large
        })
        .finally(() => walking.delete(cwd))
      walking.set(cwd, running)
    }
    if (!signal) return running
    signal.throwIfAborted()
    return await Promise.race([running, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))])
  }

  return {
    peek({ cwd, mode }) {
      const verdict = quick(resolve(cwd), mode)
      if (verdict !== "measure") return verdict
      const large = measured(resolve(cwd))
      if (large === undefined) {
        void measure(resolve(cwd), undefined)
        return undefined
      }
      return large ? skip("large folder") : INDEX
    },
    async check({ cwd, mode, signal }) {
      const verdict = quick(resolve(cwd), mode)
      if (verdict !== "measure") return verdict
      return (await measure(resolve(cwd), signal)) ? skip("large folder") : INDEX
    },
  }
}
