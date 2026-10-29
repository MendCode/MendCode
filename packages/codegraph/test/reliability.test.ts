import { describe, expect, test } from "bun:test"
import { readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cacheName, createIndexer } from "../src/indexer"
import { sourceExcerpts } from "../src/source"
import { expectValidRender, harness, project, put, useTempDirs } from "./helpers"

const temp = useTempDirs()
const setup = (files: Record<string, string>) => harness({ root: project({ root: temp(), files }), cacheDir: temp() })
const out = (h: ReturnType<typeof setup>, symbol: string) => h.call("graph_callers", { symbol, direction: "out" })

describe("binding-aware edges", () => {
  test("named aliases, default imports, namespaces, optional calls and CommonJS bindings resolve to their actual declarations", async () => {
    const h = setup({
      "lib.ts": "export function original() {}\nexport default function fallback() {}\n",
      "main.ts": [
        'import fallback, { original as alias } from "./lib"',
        'import * as lib from "./lib"',
        'const { original: cjsAlias } = require("./lib")',
        'const namespace = require("./lib")',
        "export function use() {",
        "  alias?.()",
        "  fallback()",
        "  lib?.original()",
        "  cjsAlias()",
        "  namespace.original()",
        "}",
      ].join("\n"),
      "unrelated.ts": "export function alias() {}\nexport function original() {}\n",
    })
    const result = await out(h, "use")
    expect(result.output).toContain("lib.ts:1  function original")
    expect(result.output).toContain("lib.ts:2  function fallback")
    expect(result.output).not.toContain("unrelated.ts")
    expect(result.meta?.results).toBe(2)
  })

  test("follows named and star re-exports through cyclic barrels without leaking default exports", async () => {
    const h = setup({
      "leaf.ts": "function implementation() {}\nexport { implementation as publicName }\nexport default function privateDefault() {}\n",
      "a.ts": 'export { publicName as renamed } from "./leaf"\nexport * from "./b"\n',
      "b.ts": 'export * from "./a"\nexport * from "./leaf"\n',
      "forward.ts": 'import { renamed as local } from "./a"\nexport { local as forwarded }\n',
      "use.ts": 'import { forwarded } from "./forward"\nimport hidden from "./b"\nexport function use() { forwarded(); hidden() }\n',
    })
    const result = await out(h, "use")
    expect(result.output).toContain("leaf.ts:1  function implementation")
    expect(result.output).not.toContain("privateDefault")
    expect(result.meta?.results).toBe(1)
  })

  test("external, missing and unimported names never invent script edges", async () => {
    const h = setup({
      "main.ts": 'import { remote } from "external"\nimport { missing } from "./absent"\nexport function use() { remote(); missing(); unbound(); JSON.parse("{}"); obj.this.step() }\n',
      "other.ts": "export function remote() {}\nexport function missing() {}\nexport function unbound() {}\nexport function parse() {}\n",
    })
    expect((await out(h, "use")).meta?.results).toBe(0)
  })

  test("an imported class alias resolves static methods without grabbing a different class", async () => {
    const h = setup({
      "type.ts": "export class Actual {\n  static make() {}\n}\n",
      "use.ts": 'import { Actual as Alias } from "./type"\nexport function use() { Alias.make() }\n',
      "noise.ts": "export class Alias {\n  static make() {}\n}\n",
    })
    const result = await out(h, "use")
    expect(result.output).toContain("Actual.make")
    expect(result.output).not.toContain("noise.ts")
  })

  test("local require bindings and side-effect imports do not become global receivers", async () => {
    const h = setup({
      "lib.ts": "export function work() {}\nexport class Remote {\n  static make() {}\n}\n",
      "use.ts": 'import "./lib"\nexport function local() {\n  const lib = require("./lib")\n}\nexport function other() { lib.work(); Remote.make() }\n',
    })
    expect((await out(h, "other")).meta?.results).toBe(0)
  })

  test("masked comments cannot invent imports, re-exports or namespace bindings", async () => {
    const h = setup({
      "main.ts": '/*\nimport * as fake from "./lib"\nexport * from "./lib"\n*/\nexport function use() { fake.work() }\n',
      "lib.ts": "export function work() {}\n",
    })
    expect((await out(h, "use")).meta?.results).toBe(0)
    expect((await h.call("graph_file_api", { path: "main.ts" })).output).not.toContain("imports:")
  })

  test("Python module aliases and renamed imports resolve without cross-language false positives", async () => {
    const h = setup({
      "pkg/lib.py": "def work():\n    pass\ndef _private():\n    pass\n",
      "pkg/use.py": "import pkg.lib as lib\nfrom .lib import (\n    work as alias,\n    _private,\n)\ndef use():\n    lib.work()\n    alias()\n    _private()\n",
      "noise.ts": "export function alias() {}\nexport function work() {}\n",
    })
    const result = await out(h, "use")
    expect(result.meta?.results).toBe(2)
    expect(result.output).toContain("pkg/lib.py:1")
    expect(result.output).toContain("pkg/lib.py:3")
    expect(result.output).not.toContain("noise.ts")
  })

  test("conflicting star exports do not manufacture multiple targets", async () => {
    const h = setup({
      "a.ts": "export function same() {}\n",
      "b.ts": "export function same() {}\n",
      "barrel.ts": 'export * from "./a"\nexport * from "./b"\n',
      "use.ts": 'import { same } from "./barrel"\nexport function use() { same() }\n',
    })
    expect((await out(h, "use")).meta?.results).toBe(0)
    put({ root: h.root, path: "barrel.ts", content: 'export * from "./a"\nexport * from "./b"\nexport { same } from "./a"\n' })
    expect((await out(h, "use")).output).toContain("a.ts:1")
    expect((await out(h, "use")).output).not.toContain("b.ts:1")
  })

  test(".mts and .cts resolve .mjs and .cjs imports", async () => {
    const h = setup({
      "esm.mts": "export function esm() {}\n",
      "cjs.cts": "export function cjs() {}\n",
      "use.ts": 'import { esm } from "./esm.mjs"\nimport { cjs } from "./cjs.cjs"\nexport function use() { esm(); cjs() }\n',
    })
    const result = await out(h, "use")
    expect(result.output).toContain("esm.mts:1")
    expect(result.output).toContain("cjs.cts:1")
  })
})

describe("workspace packages", () => {
  test("resolves package exports, conditions, barrels and subpath wildcards without node_modules", async () => {
    const h = setup({
      "packages/lib/package.json": JSON.stringify({ name: "@app/lib", exports: { ".": { types: "./src/index.ts", default: "./dist/index.js" }, "./utils/*": "./src/*.ts", "./private": null } }),
      "packages/lib/src/index.ts": 'export { work } from "./work"\n',
      "packages/lib/src/work.ts": "export function work() {}\n",
      "packages/lib/src/extra.ts": "export function extra() {}\n",
      "use.ts": 'import { work } from "@app/lib"\nimport { extra } from "@app/lib/utils/extra"\nexport function use() { work(); extra() }\n',
    })
    const result = await out(h, "use")
    expect(result.output).toContain("packages/lib/src/work.ts:1")
    expect(result.output).toContain("packages/lib/src/extra.ts:1")
    const impact = await h.call("graph_impact", { path: "packages/lib/src/work.ts" })
    expect(impact.output).toContain("Import dependents:")
    expect(impact.output).toContain("use.ts")
  })

  test("manifest edits re-resolve edges without rescanning unchanged source files, including after restart", async () => {
    const h = setup({
      "lib/package.json": JSON.stringify({ name: "lib", exports: "./a.ts" }),
      "lib/a.ts": "export function target() {}\n",
      "lib/b.ts": "export function target() {}\n",
      "use.ts": 'import { target } from "lib"\nexport function use() { target() }\n',
    })
    expect((await out(h, "use")).output).toContain("lib/a.ts")
    h.scans.length = 0
    put({ root: h.root, path: "lib/package.json", content: JSON.stringify({ name: "lib", exports: "./b.ts" }) })
    expect((await out(h, "use")).output).toContain("lib/b.ts")
    expect(h.scans).toEqual([])
    const again = h.restart()
    expect((await out(again, "use")).output).toContain("lib/b.ts")
    expect(again.scans).toEqual([])
  })

  test("private subpaths and escaping export targets are not linked", async () => {
    const h = setup({
      "pkg/package.json": JSON.stringify({ name: "pkg", exports: { ".": "../outside.ts", "./private": null } }),
      "pkg/private.ts": "export function privateFn() {}\n",
      "outside.ts": "export function outside() {}\n",
      "use.ts": 'import { outside } from "pkg"\nimport { privateFn } from "pkg/private"\nexport function use() { outside(); privateFn() }\n',
    })
    expect((await out(h, "use")).meta?.results).toBe(0)
  })
})

describe("complete traversals with bounded presentation", () => {
  test("all traverses cycles and chains deeper than 9, with valid rendered hop depths", async () => {
    const functions = Array.from({ length: 15 }, (_, i) => `export function f${i}() { f${(i + 1) % 15}() }`).join("\n")
    const h = setup({ "chain.ts": functions })
    const result = await h.call("graph_callers", { symbol: "f0", direction: "out", depth: "all" })
    expect(result.meta?.results).toBe(14)
    expect(result.output).toContain("d14")
    expect(result.truncated).toBe(false)
    expectValidRender(result)
    expect((await h.call("graph_callers", { symbol: "f0" })).output).toContain("f14")
  })

  test("counts descendants of omitted rows instead of silently pruning the blast radius", async () => {
    const branches = Array.from({ length: 60 }, (_, i) => `export function branch${i}() { leaf${i}() }\nexport function leaf${i}() {}`)
    const h = setup({ "wide.ts": `export function root() { ${branches.map((_, i) => `branch${i}()`).join("; ")} }\n${branches.join("\n")}\n` })
    const result = await h.call("graph_callers", { symbol: "root", direction: "out", depth: "all" })
    expect(result.meta?.results).toBe(50)
    expect(result.output).toContain("70 more")
    expect(result.truncated).toBe(true)
    expectValidRender(result)
  })

  test("path scope cannot be bypassed using an exact symbol id", async () => {
    const h = setup({ "a.ts": "export function target() {}\n", "b.ts": "export function other() {}\n" })
    expect((await h.call("graph_callers", { symbol: "a.ts#target", path: "b.ts" })).isError).toBe(true)
  })

  test("cached impact reaches callers and import-only dependents without rescanning after an edit", async () => {
    const h = setup({
      "a.ts": "export function target() {}\n",
      "b.ts": 'import { target } from "./a"\nexport function middle() { target() }\n',
      "c.ts": 'import { middle } from "./b"\nexport function outer() { middle() }\n',
      "types.ts": 'import type { target } from "./a"\nexport type Uses = typeof target\n',
    })
    await h.call("graph_map", {})
    const scanned = h.scans.length
    put({ root: h.root, path: "a.ts", content: "export function replacement() {}\n" })
    const result = await h.call("graph_impact", { path: "a.ts" })
    expect(result.meta).toMatchObject({ callers: 1, reachable: 2, importingFiles: 3, cached: true })
    expect(result.output).toContain("d2 c.ts")
    expect(result.output).toContain("types.ts")
    expect(h.scans).toHaveLength(scanned)
    expect((await h.call("graph_impact", { path: "new.ts" })).output).toContain("not indexed")
  })
})

describe("cache and discovery resilience", () => {
  test("same-size edits with restored mtime are detected using ctime", async () => {
    const h = setup({ "a.ts": "export function before() {}\n" })
    await h.call("graph_map", {})
    const before = statSync(join(h.root, "a.ts"))
    await Bun.sleep(5)
    put({ root: h.root, path: "a.ts", content: "export function after_() {}\n", mtime: before.mtimeMs })
    h.scans.length = 0
    expect((await h.call("graph_find", { query: "after_" })).meta?.results).toBe(1)
    expect(h.scans).toEqual(["a.ts"])
  })

  test("malformed cached records are discarded and rebuilt rather than poisoning every query", async () => {
    const h = setup({ "a.ts": "export function good() {}\n" })
    await h.call("graph_map", {})
    const file = join(h.cacheDir, cacheName(h.root))
    const original = JSON.parse(readFileSync(file, "utf8"))
    for (const corrupt of [null, { symbols: null }, { calls: [{ from: 99, name: "bad" }] }, { bindings: [{}] }, { exports: {} }, { ctimeMs: "bad" }]) {
      const cache = structuredClone(original)
      cache.files["a.ts"] = corrupt === null ? null : { ...cache.files["a.ts"], ...corrupt }
      writeFileSync(file, JSON.stringify(cache))
      const restarted = h.restart()
      expect((await restarted.call("graph_find", { query: "good" })).meta?.results).toBe(1)
      expect(restarted.scans).toEqual(["a.ts"])
    }
  })

  test("Graft rewrites with restored mtime are detected, and stale target ids never fall back to names", async () => {
    const wiring = (name: string) => JSON.stringify({
      nodes: [{ id: `a.ts#${name}`, name, kind: "function", path: "a.ts", span: "L1-L1", exported: true }],
      edges: [{ source: `a.ts#${name}`, target: "missing.ts#same", relation: "calls" }],
    })
    const h = setup({ "a.ts": "export function scanned() {}\n", "other.ts": "export function same() {}\n" })
    const file = put({ root: h.root, path: "graft/.graph/wiring.json", content: wiring("first") })
    const stamp = statSync(file).mtimeMs
    expect((await h.call("graph_find", { query: "first" })).meta?.results).toBe(1)
    expect((await out(h, "first")).meta?.results).toBe(0)
    await Bun.sleep(5)
    put({ root: h.root, path: "graft/.graph/wiring.json", content: wiring("other"), mtime: stamp })
    expect((await h.call("graph_find", { query: "other", path: "a.ts" })).meta?.results).toBe(1)
  })

  test("an interrupted refresh resumes without losing already scanned records", async () => {
    const root = project({ root: temp(), files: { "a.ts": "export function a() {}\n", "b.ts": "export function b() {}\n" } })
    const controller = new AbortController()
    const scans: string[] = []
    const indexer = createIndexer({ cacheDir: temp(), now: Date.now, onScan: (path) => { scans.push(path); controller.abort() } })
    await expect(indexer.graph({ cwd: root, signal: controller.signal })).rejects.toThrow("aborted")
    const graph = await indexer.graph({ cwd: root, signal: new AbortController().signal })
    expect(graph.nodes.map((node) => node.name)).toEqual(["a", "b"])
    expect(scans).toEqual(["a.ts", "b.ts"])
  })

  test("old cache versions rebuild automatically", async () => {
    const h = setup({ "a.ts": "export function fresh() {}\n" })
    await h.call("graph_map", {})
    const file = join(h.cacheDir, cacheName(h.root))
    const cache = JSON.parse(readFileSync(file, "utf8"))
    cache.version = 1
    writeFileSync(file, JSON.stringify(cache))
    const restarted = h.restart()
    expect((await restarted.call("graph_find", { query: "fresh" })).meta?.results).toBe(1)
    expect(restarted.scans).toEqual(["a.ts"])
  })

  test("nested ignore rules, ordered negations and escaped markers respect directory scope", async () => {
    const h = setup({
      ".gitignore": "*.generated.ts\n!keep.generated.ts\n\\#secret.ts\n\\!secret.ts\nignored/\n!ignored/reinclude.ts\n",
      "src/.gitignore": "!local.generated.ts\n/only-here.ts\n",
      "src/local.generated.ts": "export function yes() {}\n",
      "src/drop.generated.ts": "export function no() {}\n",
      "src/keep.generated.ts": "export function keep() {}\n",
      "src/only-here.ts": "export function no() {}\n",
      "other/only-here.ts": "export function elsewhere() {}\n",
      "other/local.generated.ts": "export function no() {}\n",
      "ignored/reinclude.ts": "export function no() {}\n",
      "#secret.ts": "export function no() {}\n",
      "!secret.ts": "export function no() {}\n",
    })
    await h.call("graph_map", {})
    expect(h.scans.sort()).toEqual(["other/only-here.ts", "src/keep.generated.ts", "src/local.generated.ts"])
    put({ root: h.root, path: "src/.gitignore", content: "*.ts\n" })
    expect((await h.call("graph_map", {})).meta?.files).toBe(1)
  })

  test("oversized files mark coverage partial but do not stop discovery of later directories", async () => {
    const h = setup({ "a.ts": " ".repeat(513 * 1024), "z/b.ts": "export function keep() {}\n" })
    const result = await h.call("graph_map", {})
    expect(result.meta).toMatchObject({ partial: true, files: 1 })
    expect(result.output).toContain("1 files indexed")
    expect(result.output).not.toContain("first 20000")
  })

  test("concurrent queries share a single incremental scan", async () => {
    const h = setup({ "a.ts": "export function a() {}\n", "b.ts": "export function b() {}\n" })
    const results = await Promise.all(Array.from({ length: 8 }, () => h.call("graph_map", {})))
    expect(results.every((result) => !result.isError)).toBe(true)
    expect(h.scans.sort()).toEqual(["a.ts", "b.ts"])
  })
})

describe("bounded source context", () => {
  test("source excerpts include numbered code, truncate long definitions, and do not change default output", async () => {
    const h = setup({ "a.ts": `export function long() {\n${Array.from({ length: 15 }, (_, i) => `  const value${i} = ${i}`).join("\n")}\n}\n` })
    const source = await h.call("graph_find", { query: "long", source: true })
    expect(source.output).toContain("1 | export function long() {")
    expect(source.output).toContain("8 | ")
    expect(source.output).not.toContain("9 | ")
    expect(source.output).toContain("L9-L17 omitted")
    expect((await h.call("graph_find", { query: "long" })).output).not.toContain(" | ")
    expectValidRender(source)
  })

  test("a source changed after indexing or replaced by an external symlink is not exposed", async () => {
    const root = project({ root: temp(), files: { "a.ts": "export function before() {}\n" } })
    const indexer = createIndexer({ cacheDir: temp(), now: Date.now })
    const signal = new AbortController().signal
    const graph = await indexer.graph({ cwd: root, signal })
    put({ root, path: "a.ts", content: "export function changed() {}\n" })
    expect((await sourceExcerpts({ graph, nodes: graph.nodes, signal })).size).toBe(0)
    const outside = put({ root: temp(), path: "secret.ts", content: "do not expose" })
    const { unlinkSync } = await import("node:fs")
    unlinkSync(join(root, "a.ts"))
    symlinkSync(outside, join(root, "a.ts"))
    expect((await sourceExcerpts({ graph, nodes: graph.nodes, signal })).size).toBe(0)
  })
})
