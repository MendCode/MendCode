import { readFileSync, type Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { fileIgnore } from "./file-ignore"
import type { FileEntry } from "@mendcode/protocol"
import { canonicalDir } from "@mendcode/tools"
import { indexEntry, rankEntries, type IndexedEntry } from "./file-score"

const MAX_ENTRIES = 50_000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
/** Cache lifetime: a project's file tree rarely changes mid-typing burst, so this only costs a rebuild every few seconds. */
const CACHE_TTL_MS = 4_000
/** Bound on the non-git fallback walk; past it the walk stops and the cache is marked partial (never blocks the daemon). */
const WALK_BUDGET_MS = 800
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage", "out"])

type CacheEntry = { entries: IndexedEntry[]; builtAt: number; partial: boolean; building?: Promise<void> }
const cache = new Map<string, CacheEntry>()

async function git(cwd: string, args: string[]) {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return code === 0 ? stdout : undefined
  } catch {
    return undefined
  }
}

/** `git ls-files` (tracked + untracked, ignore rules applied by git itself) — the fast path for a repository. */
async function listGit(directory: string): Promise<string[] | undefined> {
  const stdout = await git(directory, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
  return stdout === undefined ? undefined : stdout.split("\0").filter(Boolean)
}

/** Top-level `.gitignore` names only (no glob support) — "basics" for the non-git fallback walk. */
function loadSimpleIgnore(directory: string): Set<string> {
  try {
    const text = readFileSync(path.join(directory, ".gitignore"), "utf8")
    return new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => line.replace(/^\/+|\/+$/g, "")),
    )
  } catch {
    return new Set()
  }
}

/** Bounded recursive walk for a directory that is not a git repository. Time- and count-bounded; never blocks. */
async function walk(directory: string): Promise<{ files: string[]; partial: boolean }> {
  const ignore = loadSimpleIgnore(directory)
  const out: string[] = []
  const start = Date.now()
  let partial = false
  async function visit(dir: string, rel: string) {
    if (partial) return
    if (out.length >= MAX_ENTRIES || Date.now() - start > WALK_BUDGET_MS) {
      partial = true
      return
    }
    let entries: Dirent<string>[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name) || ignore.has(entry.name)) continue
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), relPath)
      else if (entry.isFile()) out.push(relPath)
      if (out.length >= MAX_ENTRIES || Date.now() - start > WALK_BUDGET_MS) {
        partial = true
        return
      }
    }
  }
  await visit(directory, "")
  return { files: out, partial }
}

/** Files plus every ancestor directory of a file, deduped — directories are searchable even without a native listing. */
function deriveEntries(files: string[]): IndexedEntry[] {
  const dirs = new Set<string>()
  const out: IndexedEntry[] = []
  for (const file of files) {
    out.push(indexEntry(file, "file"))
    const segments = file.split("/")
    let acc = ""
    for (let i = 0; i < segments.length - 1; i++) {
      acc = acc ? `${acc}/${segments[i]}` : segments[i]!
      dirs.add(acc)
    }
  }
  for (const dir of dirs) out.push(indexEntry(dir, "dir"))
  return out
}

async function buildEntries(directory: string): Promise<{ entries: IndexedEntry[]; partial: boolean }> {
  const gitFiles = await listGit(directory)
  if (gitFiles !== undefined) return { entries: deriveEntries(gitFiles.slice(0, MAX_ENTRIES)), partial: gitFiles.length > MAX_ENTRIES }
  const { files, partial } = await walk(directory)
  return { entries: deriveEntries(files), partial }
}

/** Builds (or reuses) the cached entry list for `directory`. Bounded by the walk budget, so this never blocks indefinitely. */
async function ensureFresh(directory: string): Promise<CacheEntry> {
  const cached = cache.get(directory)
  if (cached && !cached.building && Date.now() - cached.builtAt < CACHE_TTL_MS) return cached
  if (cached?.building) {
    await cached.building
    return cache.get(directory)!
  }
  const placeholder: CacheEntry = cached ?? { entries: [], builtAt: 0, partial: true }
  const building = (async () => {
    const { entries, partial } = await buildEntries(directory)
    cache.set(directory, { entries, builtAt: Date.now(), partial })
  })()
  placeholder.building = building
  cache.set(directory, placeholder)
  await building
  return cache.get(directory)!
}

/**
 * Fuzzy file/directory search under `directory` for the `@` mention picker. Per-directory cache with a
 * short TTL; the first call for a fresh directory builds the index (bounded, see `ensureFresh`), every
 * call after that is a pure in-memory rank over the cached entries (well under 10 ms for 50k paths).
 */
export async function searchFiles(options: { directory: string; query: string; limit?: number; ignore?: string[] | undefined }): Promise<{ files: FileEntry[] }> {
  const directory = canonicalDir(options.directory)
  const { entries } = await ensureFresh(directory)
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const ignored = fileIgnore(options.ignore)
  const visible = entries.filter((entry) => !ignored(entry.path))
  const ranked = rankEntries(visible, options.query, limit)
  return { files: ranked.map(({ path: entryPath, kind }) => ({ path: entryPath, kind })) }
}

/** Test-only: drops every cached directory so a test's temp repo starts from a clean index. */
export function clearFilesIndexCache() {
  cache.clear()
}
