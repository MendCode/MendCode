import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { buildGraph, type Graph } from "./graph"
import { HOSTED_SCAN_FILES, hostedScan } from "./scan-host"
import { readWiring, wiringStamp } from "./graft"
import { scanSource } from "./scan"
import { walkProject, type WalkedFile } from "./walk"
import { CACHE_VERSION, LANGUAGES, MAX_FILE_BYTES, MAX_INDEXED_FILES, SYMBOL_KINDS, type CacheFile, type FileRec } from "./types"

export type IndexerOptions = {
  cacheDir: string
  now: () => number
  /** Called once per file the own scanner reads (tests count re-scans through it). */
  onScan?: ((path: string) => void) | undefined
  maxFiles?: number | undefined
  /** Called when the index of a project starts its first build in this process and whenever a refresh changed it: never per request, never per frame. */
  onIndex?: ((status: IndexStatus) => void) | undefined
  /** Called while a first build scans, at every tenth of its files (`indexing` with `percent`): a client that shows progress asks for it; `onIndex` stays one event at the start and one at the end. */
  onProgress?: ((status: IndexStatus) => void) | undefined
  /** The command of a scan host (`scanHostCommand`, scan-host.ts): a refresh with at least `HOSTED_SCAN_FILES` files to scan scans them there. */
  scanHost?: string[] | undefined
}

/** What an index holds, for a client that shows it: the count of files, symbols and call edges, and whether the first build is still running (`none`: it ended without a graph). */
export type IndexStatus = { cwd: string; state: "indexing" | "indexed" | "none"; files: number; symbols: number; edges: number; partial: boolean; /** While `indexing`: how much of the first build is done, 0 to 99, in steps of ten. */ percent?: number }

/** The first build of a project in this process: files scanned of those to scan. */
export type IndexProgress = { done: number; total: number }

/**
 * What changed on disk since the last index: the files a refresh would scan or drop, of those indexed, and `bytes`, the amount of code
 * that moved. A new file counts its size, a deleted one the size it had when indexed, a modified one the larger of its size change and
 * `touchBytes` (capped by its own size): a same-size edit shows no size change, but a file the disk says was written is not free.
 */
export type IndexDrift = { changed: number; indexed: number; bytes: number }

/** The counts of a built graph, one pass over its nodes. */
export function indexStatus(graph: Graph): IndexStatus {
  let edges = 0
  for (const callees of graph.callees.values()) edges += callees.length
  return { cwd: graph.cwd, state: "indexed", files: graph.files.size, symbols: graph.nodes.length, edges, partial: graph.partial }
}

export type Indexer = {
  /** The up-to-date graph of `cwd`: first call builds it, later calls re-scan only changed, new and deleted files. */
  graph(args: { cwd: string; signal: AbortSignal }): Promise<Graph>
  /** Last in-memory graph only: post-edit notes must never rebuild or walk the project. */
  peek(cwd: string): Graph | undefined
  /** Path of the JSON cache file for `cwd`. */
  cachePath(cwd: string): string
  /** Where a build or refresh of `cwd` that is running now stands; undefined when none runs. */
  progress(cwd: string): IndexProgress | undefined
  /** Files new, changed or deleted since the last index, from one walk and no scan; undefined when the project was never indexed. */
  drift(args: { cwd: string; signal: AbortSignal; touchBytes?: number | undefined }): Promise<IndexDrift | undefined>
}

/** `dirty`: records changed since the graph was last derived (an aborted refresh leaves this set). */
type State = { cache: CacheFile; graph: Graph | undefined; dirty: boolean }

const aborted = () => new DOMException("aborted", "AbortError")

export const cacheName = (cwd: string): string => `${createHash("sha1").update(cwd).digest("hex").slice(0, 16)}.json`

/** A walked file that is not what the cache recorded: new, or another mtime, ctime or size. */
function differs(current: FileRec | undefined, walked: WalkedFile): boolean {
  return current === undefined || current.mtimeMs !== walked.mtimeMs || current.ctimeMs !== walked.ctimeMs || current.size !== walked.size
}

function validFile(value: unknown): value is FileRec {
  if (!value || typeof value !== "object") return false
  const rec = value as FileRec
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string")
  if (!Number.isFinite(rec.mtimeMs) || !Number.isFinite(rec.ctimeMs) || !Number.isFinite(rec.size) || rec.size < 0 || rec.size > MAX_FILE_BYTES || !LANGUAGES.includes(rec.language) || !["scan", "graft"].includes(rec.source)) return false
  if (!strings(rec.imports) || !Array.isArray(rec.symbols) || !Array.isArray(rec.calls)) return false
  if (!rec.symbols.every((node) => node && typeof node.name === "string" && SYMBOL_KINDS.has(node.kind) && Number.isInteger(node.start) && node.start >= 0 && Number.isInteger(node.end) && node.end >= node.start && typeof node.exported === "boolean" && (node.parent === undefined || typeof node.parent === "string") && (node.id === undefined || typeof node.id === "string"))) return false
  if (!rec.calls.every((call) => call && Number.isInteger(call.from) && call.from >= 0 && call.from < rec.symbols.length && typeof call.name === "string" && (call.target === undefined || typeof call.target === "string") && (call.qualifier === undefined || typeof call.qualifier === "string") && (call.self === undefined || typeof call.self === "boolean") && (call.dot === undefined || typeof call.dot === "boolean"))) return false
  if (rec.bindings !== undefined && (!Array.isArray(rec.bindings) || !rec.bindings.every((entry) => entry && typeof entry.local === "string" && typeof entry.imported === "string" && typeof entry.source === "string"))) return false
  return rec.exports === undefined || (Array.isArray(rec.exports) && rec.exports.every((entry) => entry && typeof entry.exported === "string" && typeof entry.local === "string" && (entry.source === undefined || typeof entry.source === "string")))
}

async function loadCache({ file, cwd }: { file: string; cwd: string }): Promise<CacheFile | undefined> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as Partial<CacheFile>
    if (!data || data.version !== CACHE_VERSION || data.cwd !== cwd || typeof data.files !== "object" || data.files === null || Array.isArray(data.files)) return undefined
    if (!Object.entries(data.files).every(([path, rec]) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..") && validFile(rec))) return undefined
    if (data.packages !== undefined && (!Array.isArray(data.packages) || !data.packages.every((pkg) => pkg && typeof pkg.name === "string" && typeof pkg.dir === "string" && pkg.entries && typeof pkg.entries === "object" && Object.values(pkg.entries).every((values) => Array.isArray(values) && values.every((value) => typeof value === "string"))))) return undefined
    return { version: CACHE_VERSION, cwd, builtAt: Number.isFinite(data.builtAt) ? data.builtAt! : 0, graftMtimeMs: typeof data.graftMtimeMs === "number" ? data.graftMtimeMs : null, graftStamp: typeof data.graftStamp === "string" ? data.graftStamp : null, partial: data.partial === true, files: data.files, packages: data.packages ?? [] }
  } catch {
    return undefined
  }
}

async function saveCache({ file, cache }: { file: string; cache: CacheFile }): Promise<void> {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await mkdir(join(file, ".."), { recursive: true })
    await writeFile(temp, JSON.stringify(cache))
    await rename(temp, file)
  } catch {
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

/** Projects whose graph stays built in memory at once; a graph of a few thousand files is tens of MB. */
export const MAX_PROJECTS_IN_MEMORY = 2
/** A project's graph nobody asked for in this long is dropped from memory; the next question rebuilds it from the cache file. */
export const IDLE_DROP_MS = 10 * 60_000

export function createIndexer({ cacheDir, now, onScan, onIndex, onProgress, scanHost, maxFiles = MAX_INDEXED_FILES }: IndexerOptions): Indexer {
  const states = new Map<string, State>()
  const queues = new Map<string, Promise<unknown>>()
  /** When each project's graph was last asked for; one left alone for `IDLE_DROP_MS` is dropped from memory (its cache file stays). */
  const usedAt = new Map<string, number>()
  let sweeper: ReturnType<typeof setInterval> | undefined
  function forget(cwd: string) {
    states.delete(cwd)
    usedAt.delete(cwd)
    if (!queues.has(cwd)) return
    // The settled promise of the last build holds the graph too.
    queues.delete(cwd)
  }
  function touch(cwd: string) {
    usedAt.delete(cwd)
    usedAt.set(cwd, now())
    // Only the most recently used projects stay built in memory; the others reload from their cache file when asked again.
    for (const old of [...usedAt.keys()].slice(0, Math.max(0, usedAt.size - MAX_PROJECTS_IN_MEMORY))) if (!busy.has(old)) forget(old)
    sweeper ??= setInterval(() => {
      for (const [project, at] of usedAt) if (now() - at >= IDLE_DROP_MS && !busy.has(project)) forget(project)
      if (!usedAt.size) { clearInterval(sweeper); sweeper = undefined }
    }, Math.min(IDLE_DROP_MS, 60_000))
    sweeper.unref?.()
  }
  const busy = new Set<string>()
  const progress = new Map<string, IndexProgress>()
  const cachePath = (cwd: string) => join(cacheDir, cacheName(cwd))

  async function refresh({ cwd, signal }: { cwd: string; signal: AbortSignal }): Promise<Graph> {
    if (signal.aborted) throw aborted()
    let state = states.get(cwd)
    if (!state) {
      const loaded = await loadCache({ file: cachePath(cwd), cwd })
      // Loading a cache is using it: renew its age so the pruning (prune.ts) keeps what a project still asks for.
      if (loaded) { const at = new Date(now()); void utimes(cachePath(cwd), at, at).catch(() => undefined) }
      const cache = loaded ?? { version: CACHE_VERSION, cwd, builtAt: 0, graftMtimeMs: null, partial: false, files: {} }
      state = { cache, graph: undefined, dirty: false }
      states.set(cwd, state)
    }
    const { cache } = state
    // The first build of a project in this process is the slow one: tell the client it is running (later refreshes are incremental and quick).
    if (state.graph === undefined) onIndex?.({ cwd, state: "indexing", files: Object.keys(cache.files).length, symbols: 0, edges: 0, partial: cache.partial })
    const walk = await walkProject({ cwd, signal, maxFiles })
    const stamp = await wiringStamp(cwd)
    const graftChanged = (stamp?.key ?? null) !== (cache.graftStamp ?? null)
    const wiring = graftChanged ? await readWiring(cwd) : undefined
    let changed = state.dirty || graftChanged || walk.partial !== cache.partial || state.graph === undefined || JSON.stringify(cache.packages ?? []) !== JSON.stringify(walk.packages)
    let incomplete = walk.partial
    let sinceYield = 0
    // Files this run will scan: the denominator of the progress a client or a tool result reports for a first build.
    let toScan = 0
    for (const [path, walked] of walk.files) if (differs(cache.files[path], walked) && !(wiring && Math.max(walked.mtimeMs, walked.ctimeMs) <= wiring.mtimeMs && wiring.files.has(path))) toScan++
    const coveredBy = (path: string, walked: WalkedFile) => wiring && Math.max(walked.mtimeMs, walked.ctimeMs) <= wiring.mtimeMs ? wiring.files.get(path) : undefined
    const scans = (path: string, walked: WalkedFile) => {
      const current = cache.files[path]
      return !coveredBy(path, walked) && !(current !== undefined && !differs(current, walked) && (current.source === "scan" || !graftChanged))
    }
    let host: ReturnType<typeof hostedScan> | undefined
    if (scanHost && toScan >= HOSTED_SCAN_FILES) {
      try {
        host = hostedScan({ command: scanHost, signal, request: { cwd, files: [...walk.files].filter(([path, walked]) => scans(path, walked)).map(([path, walked]) => ({ path, walked })) } })
      } catch {
        host = undefined
      }
    }
    const scanOne = async (path: string, walked: WalkedFile) => {
      if (host) {
        try {
          const rec = await host.next(path)
          onScan?.(path)
          return rec
        } catch {
          // A host that died or failed: the files left are scanned here.
          host.close()
          host = undefined
          if (signal.aborted) throw aborted()
        }
      }
      return scanFile({ cwd, path, walked, onScan })
    }
    const first = state.graph === undefined
    let scanned = 0
    let lastTen = 0
    progress.set(cwd, { done: 0, total: toScan })
    try {
      for (const [path, walked] of walk.files) {
        const current = cache.files[path]
        const unchanged = current !== undefined && !differs(current, walked)
        const covered = coveredBy(path, walked)
        if (covered) {
          cache.files[path] = { mtimeMs: walked.mtimeMs, ctimeMs: walked.ctimeMs, size: walked.size, language: walked.language, source: "graft", imports: covered.imports, symbols: covered.symbols, calls: covered.calls }
          changed = true
          state.dirty = true
          continue
        }
        if (unchanged && (current.source === "scan" || !graftChanged)) continue
        if (!host && ++sinceYield % 50 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        if (signal.aborted) throw aborted()
        const rec = await scanOne(path, walked)
        changed = true
        state.dirty = true
        if (rec) cache.files[path] = rec
        else { delete cache.files[path]; incomplete = true }
        progress.set(cwd, { done: ++scanned, total: toScan })
        // A first build tells its client at every tenth: enough for a footer to move, never one event per file.
        const ten = toScan > 0 ? Math.min(9, Math.floor((scanned / toScan) * 10)) : 0
        if (first && ten > lastTen) { lastTen = ten; onProgress?.({ cwd, state: "indexing", files: scanned, symbols: 0, edges: 0, partial: cache.partial, percent: ten * 10 }) }
      }
    } finally {
      host?.close()
    }
    for (const path of Object.keys(cache.files)) {
      if (!walk.files.has(path)) {
        delete cache.files[path]
        changed = true
        state.dirty = true
      }
    }
    if (changed) {
      cache.partial = incomplete
      cache.graftMtimeMs = stamp?.mtimeMs ?? null
      cache.graftStamp = stamp?.key ?? null
      cache.builtAt = now()
      cache.packages = walk.packages
      state.graph = buildGraph({ cwd, files: cache.files, partial: cache.partial, builtAt: cache.builtAt, packages: walk.packages })
      state.dirty = false
      await saveCache({ file: cachePath(cwd), cache })
      onIndex?.(indexStatus(state.graph))
    }
    return state.graph as Graph
  }

  return {
    cachePath,
    peek: (cwd) => states.get(cwd)?.graph,
    progress: (cwd) => progress.get(cwd),
    async drift({ cwd, signal, touchBytes = 0 }) {
      const cache = states.get(cwd)?.cache ?? (await loadCache({ file: cachePath(cwd), cwd }))
      if (!cache) return undefined
      const walk = await walkProject({ cwd, signal, maxFiles })
      let changed = 0
      let bytes = 0
      for (const [path, walked] of walk.files) {
        const current = cache.files[path]
        if (!differs(current, walked)) continue
        changed++
        bytes += current === undefined ? walked.size : Math.max(Math.abs(walked.size - current.size), Math.min(walked.size, touchBytes))
      }
      for (const [path, current] of Object.entries(cache.files)) if (!walk.files.has(path)) { changed++; bytes += current.size }
      return { changed, indexed: Object.keys(cache.files).length, bytes }
    },
    graph({ cwd, signal }) {
      touch(cwd)
      const previous = queues.get(cwd) ?? Promise.resolve()
      busy.add(cwd)
      const run = previous.catch(() => undefined).then(() => refresh({ cwd, signal })).catch((error: unknown) => {
        // A first build that did not finish leaves no graph: the client drops its "indexing" line.
        if (states.get(cwd)?.graph === undefined) onIndex?.({ cwd, state: "none", files: 0, symbols: 0, edges: 0, partial: false })
        throw error
      }).finally(() => { progress.delete(cwd); if (queues.get(cwd) === run) busy.delete(cwd) })
      queues.set(cwd, run)
      return run
    },
  }
}

/** Reads and scans one file (also the scan host's work); undefined for a file that cannot be read or scanned. */
export async function scanFile({ cwd, path, walked, onScan }: { cwd: string; path: string; walked: WalkedFile; onScan: ((path: string) => void) | undefined }): Promise<FileRec | undefined> {
  let buffer: Buffer
  try {
    buffer = await readFile(join(cwd, path))
  } catch {
    return undefined
  }
  onScan?.(path)
  if (buffer.length > MAX_FILE_BYTES) return undefined
  const base = { mtimeMs: walked.mtimeMs, ctimeMs: walked.ctimeMs, size: walked.size, language: walked.language, source: "scan" as const }
  if (buffer.subarray(0, 8192).includes(0)) return { ...base, imports: [], symbols: [], calls: [] }
  try {
    const scanned = scanSource({ path, text: buffer.toString("utf8") })
    // The names the scanner returns are slices of the file's text, and a slice keeps its whole source alive: copied through JSON,
    // a record holds only its own short strings (on a 2,873-file repository, 73 MB of heap after the scan became 17).
    return scanned ? { ...base, ...(JSON.parse(JSON.stringify(scanned)) as typeof scanned) } : undefined
  } catch {
    return undefined
  }
}
