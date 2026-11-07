import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cacheName, createIndexer } from "../src"
import { CACHE_IDLE_MS, TEMP_GRACE_MS, pruneCaches } from "../src/prune"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "codegraph-prune-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const cacheDir = join(root, "caches")
  mkdirSync(cacheDir)
  const now = Date.now()
  const cache = (name: string, folder: string, ageMs = 0) => {
    const file = join(cacheDir, `${name}.json`)
    writeFileSync(file, JSON.stringify({ version: 2, cwd: folder, builtAt: 1, graftMtimeMs: null, partial: false, files: { "a.ts": { padding: "x".repeat(50_000) } } }))
    const at = new Date(now - ageMs)
    utimesSync(file, at, at)
    return file
  }
  return { root, cacheDir, now, cache }
}

describe("graph cache pruning", () => {
  test("a cache whose folder is gone is deleted, one whose folder exists is kept", async () => {
    const w = workspace()
    const alive = join(w.root, "alive")
    mkdirSync(alive)
    const kept = w.cache("alive", alive)
    const orphan = w.cache("gone", join(w.root, "worktrees", "pr42-abc"))
    const result = await pruneCaches({ cacheDir: w.cacheDir, now: w.now })
    expect(existsSync(kept)).toBe(true)
    expect(existsSync(orphan)).toBe(false)
    expect(result).toMatchObject({ orphaned: 1, removed: 1, scanned: 2 })
  })
  test("an existing folder whose cache was not used for a month is deleted; one used yesterday is kept", async () => {
    const w = workspace()
    const alive = join(w.root, "alive")
    mkdirSync(alive)
    const stale = w.cache("stale", alive, CACHE_IDLE_MS + 1_000)
    const recent = w.cache("recent", alive, 86_400_000)
    const result = await pruneCaches({ cacheDir: w.cacheDir, now: w.now })
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(result.idle).toBe(1)
  })
  test("a leftover .tmp goes once it is older than the grace; a fresh one (a write in flight) stays", async () => {
    const w = workspace()
    const old = join(w.cacheDir, "abc.json.123.x.tmp")
    const fresh = join(w.cacheDir, "def.json.456.y.tmp")
    writeFileSync(old, "{")
    writeFileSync(fresh, "{")
    const at = new Date(w.now - TEMP_GRACE_MS - 1_000)
    utimesSync(old, at, at)
    const result = await pruneCaches({ cacheDir: w.cacheDir, now: w.now })
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(result.temporary).toBe(1)
  })
  test("one pass looks at a bounded number of entries, oldest first", async () => {
    const w = workspace()
    for (let index = 0; index < 5; index++) w.cache(`gone${index}`, join(w.root, `missing${index}`), (5 - index) * 1_000)
    const result = await pruneCaches({ cacheDir: w.cacheDir, now: w.now, limit: 3 })
    expect(result).toMatchObject({ scanned: 3, removed: 3 })
    expect(await pruneCaches({ cacheDir: w.cacheDir, now: w.now, limit: 3 })).toMatchObject({ scanned: 2, removed: 2 })
  })
  test("a missing cache directory is nothing to do", async () => {
    expect(await pruneCaches({ cacheDir: join(tmpdir(), "no-such-codegraph-dir-xyz"), now: Date.now() })).toMatchObject({ scanned: 0, removed: 0 })
  })
  test("loading a cache renews its age, so a project still in use is never pruned as idle", async () => {
    const w = workspace()
    const project = join(w.root, "project")
    mkdirSync(project)
    writeFileSync(join(project, "a.ts"), "export const a = 1\n")
    const indexer = createIndexer({ cacheDir: w.cacheDir, now: Date.now })
    await indexer.graph({ cwd: project, signal: new AbortController().signal })
    const file = join(w.cacheDir, cacheName(project))
    const old = new Date(w.now - CACHE_IDLE_MS - 5_000)
    utimesSync(file, old, old)
    const second = createIndexer({ cacheDir: w.cacheDir, now: Date.now })
    await second.graph({ cwd: project, signal: new AbortController().signal })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await pruneCaches({ cacheDir: w.cacheDir, now: Date.now() })).toMatchObject({ removed: 0 })
    expect(existsSync(file)).toBe(true)
  })
})
