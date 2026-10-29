import { describe, expect, test } from "bun:test"
import { mkdirSync, realpathSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { createIndexer, indexStatus, type IndexStatus } from "../src"
import { holdsHome } from "../src/tools"
import { project, put, useTempDirs } from "./helpers"

const temp = useTempDirs()
const signal = () => new AbortController().signal

const FILES = {
  "a.ts": "import { b } from \"./b\"\nexport function a() { return b() }\n",
  "b.ts": "export function b() { return 1 }\n",
}

describe("the graph never indexes the home folder", () => {
  test("the home folder and the directories above it are not projects; a folder inside it is", () => {
    expect(holdsHome("/Users/ana", "/Users/ana")).toBe(true)
    expect(holdsHome("/Users/ana/", "/Users/ana")).toBe(true)
    expect(holdsHome("/Users", "/Users/ana")).toBe(true)
    expect(holdsHome("/", "/Users/ana")).toBe(true)
    expect(holdsHome("/Users/ana/Code/app", "/Users/ana")).toBe(false)
    expect(holdsHome("/Users/anabel", "/Users/ana")).toBe(false)
    expect(holdsHome("/tmp/x", "/Users/ana")).toBe(false)
  })

  test("a home spelled through a link is still the home folder when the session directory is the resolved path", () => {
    const real = realpathSync(temp())
    const home = join(real, "home")
    const link = join(real, "link")
    mkdirSync(join(home, "Code", "app"), { recursive: true })
    symlinkSync(home, link)
    expect(holdsHome(home, link)).toBe(true)
    expect(holdsHome(link, home)).toBe(true)
    expect(holdsHome(real, link)).toBe(true)
    expect(holdsHome(join(home, "Code", "app"), link)).toBe(false)
  })
})

describe("index status for a client's footer", () => {
  test("the first build says it is indexing, then reports the counts; nothing is said per request", async () => {
    const root = project({ root: temp(), files: FILES })
    const seen: IndexStatus[] = []
    const indexer = createIndexer({ cacheDir: temp(), now: Date.now, onIndex: (status) => seen.push(status) })
    await indexer.graph({ cwd: root, signal: signal() })
    expect(seen.map((status) => status.state)).toEqual(["indexing", "indexed"])
    expect(seen[1]).toMatchObject({ cwd: root, files: 2, symbols: 2, partial: false })
    expect(seen[1]!.edges).toBeGreaterThanOrEqual(1)
    // The same project again with nothing changed is silent: the footer is not woken by every lookup.
    await indexer.graph({ cwd: root, signal: signal() })
    await indexer.graph({ cwd: root, signal: signal() })
    expect(seen).toHaveLength(2)
  })

  test("a change to a file reports the new counts once, without a second `indexing`", async () => {
    const root = project({ root: temp(), files: FILES })
    const seen: IndexStatus[] = []
    const indexer = createIndexer({ cacheDir: temp(), now: Date.now, onIndex: (status) => seen.push(status) })
    await indexer.graph({ cwd: root, signal: signal() })
    put({ root, path: "c.ts", content: "import { a } from \"./a\"\nexport function c() { return a() }\n" })
    await indexer.graph({ cwd: root, signal: signal() })
    expect(seen.map((status) => status.state)).toEqual(["indexing", "indexed", "indexed"])
    expect(seen[2]).toMatchObject({ files: 3, symbols: 3 })
  })

  test("a first build that is interrupted ends with `none`, so the client drops its indexing line", async () => {
    const root = project({ root: temp(), files: FILES })
    const controller = new AbortController()
    const seen: IndexStatus[] = []
    const indexer = createIndexer({ cacheDir: temp(), now: Date.now, onScan: () => controller.abort(), onIndex: (status) => seen.push(status) })
    await expect(indexer.graph({ cwd: root, signal: controller.signal })).rejects.toThrow("aborted")
    expect(seen.map((status) => status.state)).toEqual(["indexing", "none"])
  })

  test("indexStatus counts files, symbols and call edges of a graph in one pass", async () => {
    const root = project({ root: temp(), files: FILES })
    const graph = await createIndexer({ cacheDir: temp(), now: Date.now }).graph({ cwd: root, signal: signal() })
    expect(indexStatus(graph)).toEqual({ cwd: root, state: "indexed", files: 2, symbols: 2, edges: indexStatus(graph).edges, partial: false })
  })
})

describe("graphs held in memory", () => {
  test("only the two most recently asked projects stay built; an older one reloads from its cache file when asked again", async () => {
    const cacheDir = temp()
    const indexer = createIndexer({ cacheDir, now: () => 0 })
    const roots = [0, 1, 2].map(() => project({ root: temp(), files: FILES }))
    for (const root of roots) await indexer.graph({ cwd: root, signal: signal() })
    expect(roots.map((root) => indexer.peek(root) !== undefined)).toEqual([false, true, true])
    const again = await indexer.graph({ cwd: roots[0]!, signal: signal() })
    expect(again.byName.get("a")?.length).toBe(1)
    expect(roots.map((root) => indexer.peek(root) !== undefined)).toEqual([true, false, true])
  })
})
