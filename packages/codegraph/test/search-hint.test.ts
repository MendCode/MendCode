import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { SEARCH_HINT, createIndexer, createSearchHints, searchHint, type Indexer } from "../src"
import { buildGraph } from "../src/graph"
import type { FileRec } from "../src/types"
import { TS_PROJECT } from "./fixtures"
import { project, put, useTempDirs } from "./helpers"

const tmp = useTempDirs()
const signal = () => new AbortController().signal

/** An indexed fixture project, then a second indexer over the same cache as after a restart: nothing of it is in memory. */
async function indexed() {
  const root = project({ root: tmp(), files: TS_PROJECT })
  const cacheDir = tmp()
  await createIndexer({ cacheDir, now: () => 1_700_000_000_000 }).graph({ cwd: root, signal: signal() })
  const scans: string[] = []
  const indexer = createIndexer({ cacheDir, now: () => 1_700_000_000_000, onScan: (path) => scans.push(path) })
  return { root, cacheDir, indexer, scans }
}

describe("the graph's answer for a text search", () => {
  test("says where each searched name is declared and who calls it, from the cache file alone", async () => {
    const { root, cacheDir, indexer, scans } = await indexed()
    const hint = createSearchHints({ cacheDir, indexer: () => indexer, budgetMs: 2000 })
    const found = await hint({ cwd: root, terms: ["helper", "main", "nothingCalledThis"] })
    expect(found?.identifiers).toBe(2)
    expect(found?.text.split("\n")).toEqual([
      "[code graph] Where the searched names are declared and who calls them (graph_find and graph_callers give more):",
      "helper  function  src/b.ts:1  export  2 callers",
      "  called by main  src/a.ts:3",
      "  called by Service.run  src/a.ts:13",
      "  also declared: function helper  svc/main.go:16",
      "main  function  src/a.ts:3  export  1 caller",
      "  called by entry  src/c.ts:3",
    ])
    // The index was read, not rebuilt: no file was scanned, and the graph stays for the next search.
    expect(scans).toEqual([])
    expect(indexer.peek(root)).toBeDefined()
  })

  test("a folder below the indexed one is answered from it, with where the paths start", async () => {
    const { root, cacheDir, indexer } = await indexed()
    const found = await createSearchHints({ cacheDir, indexer: () => indexer, budgetMs: 2000 })({ cwd: join(root, "src"), terms: ["deep"] })
    expect(found?.text.split("\n").slice(1, 3)).toEqual([`(paths are relative to ${root})`, "deep  function  src/b.ts:5  export  1 caller"])
  })

  test("a project with no index gets nothing, and none is built for it", async () => {
    const root = project({ root: tmp(), files: TS_PROJECT })
    const cacheDir = tmp()
    let asked = 0
    const hint = createSearchHints({ cacheDir, indexer: () => (asked++, createIndexer({ cacheDir, now: Date.now })), budgetMs: 2000 })
    expect(await hint({ cwd: root, terms: ["helper"] })).toBeUndefined()
    expect(asked).toBe(0)
    expect(readdirSync(cacheDir)).toEqual([])
  })

  test("names the graph does not know, no names at all and a folder the gate refuses give nothing", async () => {
    const { root, cacheDir, indexer } = await indexed()
    const hint = createSearchHints({ cacheDir, indexer: () => indexer, budgetMs: 2000 })
    expect(await hint({ cwd: root, terms: ["notInTheProject", "Helper"] })).toBeUndefined()
    expect(await hint({ cwd: root, terms: [] })).toBeUndefined()
    expect(await createSearchHints({ cacheDir, indexer: () => indexer, allowed: () => false, budgetMs: 2000 })({ cwd: root, terms: ["helper"] })).toBeUndefined()
  })

  test("a file changed since it was indexed is left out: a line number that moved is not an answer", async () => {
    const { root, cacheDir, indexer } = await indexed()
    put({ root, path: "src/b.ts", content: `// moved\n${TS_PROJECT["src/b.ts"]}`, mtime: 1_800_000_000_000 })
    const found = await createSearchHints({ cacheDir, indexer: () => indexer, budgetMs: 2000 })({ cwd: root, terms: ["deep", "main"] })
    expect(found?.identifiers).toBe(1)
    expect(found?.text).not.toContain("src/b.ts")
    expect(found?.text).toContain("main  function  src/a.ts:3")
  })

  test("a file that takes the place of a changed one is checked too: promoted declarations and callers past the first ten are never cited stale", async () => {
    const moved = (files: Record<string, string>, paths: string[], root: string) => { for (const path of paths) put({ root, path, content: `// moved\n${files[path]}`, mtime: 1_800_000_000_000 }) }
    const cacheDir = tmp()
    const callers: Record<string, string> = { "lib.ts": "export function work() {}\n" }
    for (let i = 0; i < 12; i++) callers[`c${String(i).padStart(2, "0")}.ts`] = `import { work } from "./lib"\nexport function call${i}() {\n  work()\n}\n`
    const callerRoot = project({ root: tmp(), files: callers })
    await createIndexer({ cacheDir, now: () => 1_700_000_000_000 }).graph({ cwd: callerRoot, signal: signal() })
    // The first ten callers and the eleventh changed: only the twelfth is a fresh answer.
    moved(callers, Array.from({ length: 11 }, (_, i) => `c${String(i).padStart(2, "0")}.ts`), callerRoot)
    const afterCallers = await createSearchHints({ cacheDir, indexer: () => createIndexer({ cacheDir, now: () => 1_700_000_000_000 }), budgetMs: 2000 })({ cwd: callerRoot, terms: ["work"] })
    expect(afterCallers?.text.split("\n").filter((line) => line.startsWith("  called by "))).toEqual(["  called by call11  c11.ts:2"])

    const declared: Record<string, string> = {}
    for (let i = 1; i <= 4; i++) declared[`d${i}.ts`] = `export function shared() {}\n`
    const declaredRoot = project({ root: tmp(), files: declared })
    await createIndexer({ cacheDir, now: () => 1_700_000_000_000 }).graph({ cwd: declaredRoot, signal: signal() })
    // The first declaration and the fourth changed: the fourth must not be promoted into the answer unchecked.
    moved(declared, ["d1.ts", "d4.ts"], declaredRoot)
    const afterDeclared = await createSearchHints({ cacheDir, indexer: () => createIndexer({ cacheDir, now: () => 1_700_000_000_000 }), budgetMs: 2000 })({ cwd: declaredRoot, terms: ["shared"] })
    expect(afterDeclared?.text).toContain("d2.ts")
    expect(afterDeclared?.text).toContain("d3.ts")
    expect(afterDeclared?.text).not.toMatch(/d[14]\.ts/)
  })

  test("an answer that is not there in time is dropped, and the loaded graph serves the next search", async () => {
    const { root, cacheDir, indexer } = await indexed()
    const slow: Indexer = { ...indexer, cached: async (cwd) => { await new Promise((resolve) => setTimeout(resolve, 60)); return indexer.cached(cwd) } }
    const hint = createSearchHints({ cacheDir, indexer: () => slow, budgetMs: 10 })
    const started = performance.now()
    expect(await hint({ cwd: root, terms: ["helper"] })).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(55)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect((await createSearchHints({ cacheDir, indexer: () => indexer, budgetMs: 2000 })({ cwd: root, terms: ["helper"] }))?.identifiers).toBe(1)
  })

  test("the block is capped: three names, five callers each, 25 lines and 2 KB", () => {
    const names = ["alphaOne", "betaTwo", "gammaThree", "deltaFour"]
    const files: Record<string, FileRec> = {}
    const rec = (symbols: FileRec["symbols"], calls: FileRec["calls"] = []): FileRec => ({ mtimeMs: 1, ctimeMs: 1, size: 10, language: "typescript", source: "scan", imports: [], symbols, calls })
    files["lib.ts"] = rec(names.map((name, i) => ({ name, kind: "function", start: i + 1, end: i + 1, exported: true })))
    for (let i = 0; i < 12; i++) files[`callers/${"long-directory-name/".repeat(3)}user${String(i).padStart(2, "0")}.ts`] = rec([{ name: `caller${i}`, kind: "function", start: 1, end: 3, exported: false }], names.map((name) => ({ from: 0, name })))
    const graph = buildGraph({ cwd: "/p", files, partial: false, builtAt: 1 })
    const found = searchHint({ graph, terms: names })!
    const lines = found.text.split("\n")
    expect(found.identifiers).toBe(SEARCH_HINT.identifiers)
    expect(lines.length).toBeLessThanOrEqual(SEARCH_HINT.lines)
    expect(Buffer.byteLength(found.text)).toBeLessThanOrEqual(SEARCH_HINT.bytes)
    expect(lines.filter((line) => line.startsWith("  called by ")).length).toBe(SEARCH_HINT.identifiers * SEARCH_HINT.callers)
    expect(lines[1]).toBe("alphaOne  function  lib.ts:1  export  12 callers")
    expect(found.text).not.toContain("deltaFour")
    // A name declared in too many places is not one symbol: nothing is said about it.
    const many: Record<string, FileRec> = {}
    for (let i = 0; i < 6; i++) many[`m${i}.ts`] = rec([{ name: "run", kind: "function", start: 1, end: 2, exported: true }])
    expect(searchHint({ graph: buildGraph({ cwd: "/p", files: many, partial: false, builtAt: 1 }), terms: ["run"] })).toBeUndefined()
    // Narrower bounds than the content: no line is cut, the block just ends.
    const wide: Record<string, FileRec> = { "lib.ts": files["lib.ts"]! }
    for (let i = 0; i < 12; i++) wide[`${"very-long-directory-name-for-the-cap/".repeat(8)}user${i}.ts`] = rec([{ name: `caller${i}`, kind: "function", start: 1, end: 3, exported: false }], names.map((name) => ({ from: 0, name })))
    const capped = searchHint({ graph: buildGraph({ cwd: "/p", files: wide, partial: false, builtAt: 1 }), terms: names })!
    expect(Buffer.byteLength(capped.text)).toBeLessThanOrEqual(SEARCH_HINT.bytes)
    for (const line of capped.text.split("\n").slice(1)) expect(line).toMatch(/(\.ts:\d+|callers?)$/)
  })
})
