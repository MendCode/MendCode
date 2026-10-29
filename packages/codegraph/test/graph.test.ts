import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, rmSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { TS_PROJECT } from "./fixtures"
import { expectValidRender, harness, project, put, useTempDirs } from "./helpers"

const tmp = useTempDirs()

function setup(files: Record<string, string> = TS_PROJECT) {
  const root = project({ root: tmp(), files })
  return harness({ root, cacheDir: tmp() })
}

describe("indexing", () => {
  test("builds lazily on the first call and caches per-file mtime and size as JSON named by sha1(cwd)", async () => {
    const h = setup()
    expect(h.scans).toEqual([])
    const found = await h.call("graph_find", { query: "main" })
    expect(found.isError).toBe(false)
    expect(h.scans.length).toBe(6)
    const name =`${createHash("sha1").update(h.root).digest("hex").slice(0, 16)}.json`
    const cachePath = join(h.cacheDir, name)
    expect(existsSync(cachePath)).toBe(true)
    const cache = JSON.parse(readFileSync(cachePath, "utf8"))
    expect(cache).toMatchObject({ version: 2, cwd: h.root, partial: false, graftMtimeMs: null, builtAt: 1_700_000_000_000 })
    expect(Object.keys(cache.files).sort()).toEqual(["core/lib.rs", "src/a.ts", "src/b.ts", "src/c.ts", "svc/main.go", "tools/util.py"])
    expect(cache.files["src/a.ts"]).toMatchObject({ language: "typescript", source: "scan", size: TS_PROJECT["src/a.ts"]?.length })
    expect(typeof cache.files["src/a.ts"].mtimeMs).toBe("number")
  })

  test("a later call re-scans nothing; a new tool set over the same cache dir loads it without scanning", async () => {
    const h = setup()
    await h.call("graph_find", { query: "main" })
    const first = h.scans.length
    await h.call("graph_find", { query: "helper" })
    expect(h.scans.length).toBe(first)
    const again = h.restart()
    const result = await again.call("graph_find", { query: "helper" })
    expect(result.output).toContain("src/b.ts:1")
    expect(again.scans).toEqual([])
  })

  test("after one edit only that file is re-scanned", async () => {
    const h = setup()
    await h.call("graph_find", { query: "main" })
    h.scans.length = 0
    put({ root: h.root, path: "src/b.ts", content: `${TS_PROJECT["src/b.ts"]}export function added() {}\n`, mtime: Date.now() + 10_000 })
    const result = await h.call("graph_find", { query: "added" })
    expect(h.scans).toEqual(["src/b.ts"])
    expect(result.output).toContain("src/b.ts:8  function added")
    h.scans.length = 0
    await h.call("graph_find", { query: "added" })
    expect(h.scans).toEqual([])
  })

  test("a new file is scanned alone; a deleted file drops its nodes and edges", async () => {
    const h = setup()
    await h.call("graph_find", { query: "main" })
    h.scans.length = 0
    put({ root: h.root, path: "src/d.ts", content: "export function fresh() {}\n" })
    expect((await h.call("graph_find", { query: "fresh" })).output).toContain("src/d.ts:1")
    expect(h.scans).toEqual(["src/d.ts"])
    expect((await h.call("graph_find", { query: "entry" })).output).toContain("src/c.ts:3")
    expect((await h.call("graph_callers", { symbol: "main", direction: "in" })).output).toContain("entry")
    h.scans.length = 0
    rmSync(join(h.root, "src/c.ts"))
    expect((await h.call("graph_find", { query: "entry" })).output).toContain("No symbols match")
    expect((await h.call("graph_callers", { symbol: "main", direction: "in" })).output).toContain("No callers found")
    expect(h.scans).toEqual([])
    const cache = JSON.parse(readFileSync(join(h.cacheDir, `${createHash("sha1").update(h.root).digest("hex").slice(0, 16)}.json`), "utf8"))
    expect("src/c.ts" in cache.files).toBe(false)
  })

  test("skips node_modules, dist, build, graft, hidden dirs, .gitignore matches, oversized and binary files", async () => {
    const h = setup({
      "src/keep.ts": "export function keep() {}\n",
      "node_modules/pkg/index.ts": "export function vendored() {}\n",
      "dist/out.js": "function built() {}\n",
      "build/out.js": "function built2() {}\n",
      "graft/x.ts": "export function grafted() {}\n",
      ".hidden/x.ts": "export function hidden() {}\n",
      "gen/out.ts": "export function generated() {}\n",
      "logs/a.log.ts": "export function logged() {}\n",
      "src/huge.ts": `export function huge() {}\n${"// pad\n".repeat(90_000)}`,
      "src/bin.ts": `export function binary() {}\n\0\0\0`,
      ".gitignore": "gen/\n*.log.ts\n",
    })
    await h.call("graph_find", { query: "e" })
    expect(h.scans.sort()).toEqual(["src/bin.ts", "src/keep.ts"])
    expect((await h.call("graph_find", { query: "binary" })).output).toContain("No symbols match")
  })

  test("caps the number of files and reports partial", async () => {
    const root = project({ root: tmp(), files: { "a.ts": "export function a1() {}\n", "b.ts": "export function b1() {}\n", "c.ts": "export function c1() {}\n" } })
    const h = harness({ root, cacheDir: tmp(), options: { maxFiles: 2 } })
    const result = await h.call("graph_map", {})
    expect(result.meta?.partial).toBe(true)
    expect(result.meta?.files).toBe(2)
    expect(result.output).toContain("[partial")
  })
})

describe("graft wiring source", () => {
  const wiring = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      meta: { version: 1 },
      nodes: [
        { id: "src/a.ts", name: "a.ts", kind: "file", path: "src/a.ts", span: "L1-L18" },
        { id: "src/a.ts#wiredOnly", name: "wiredOnly", kind: "function", path: "src/a.ts", span: "L3-L6", exported: true },
        { id: "src/a.ts#wiredHelper", name: "wiredHelper", kind: "function", path: "src/a.ts", span: "L8-L10", exported: false },
        { id: "src/a.ts#Wired.method", name: "method", kind: "method", path: "src/a.ts", span: "L12-L14", exported: false },
        { id: "src/b.ts", name: "b.ts", kind: "file", path: "src/b.ts", span: "L1-L7" },
        { id: "src/b.ts#wiredTarget", name: "wiredTarget", kind: "function", path: "src/b.ts", span: null, exported: true },
      ],
      edges: [
        { source: "src/a.ts", target: "src/a.ts#wiredOnly", relation: "contains" },
        { source: "src/a.ts", target: "src/b.ts", relation: "imports" },
        { source: "src/a.ts#wiredOnly", target: "src/a.ts#wiredHelper", relation: "calls" },
        { source: "src/a.ts#wiredOnly", target: "src/b.ts#wiredTarget", relation: "calls" },
      ],
      ...extra,
    })

  function withWiring() {
    const old = Date.now() - 60_000
    const root = project({ root: tmp(), files: TS_PROJECT })
    for (const path of Object.keys(TS_PROJECT)) utimesSync(join(root, path), old / 1000, old / 1000)
    put({ root, path: "graft/.graph/wiring.json", content: wiring() })
    return harness({ root, cacheDir: tmp() })
  }

  test("covered, unchanged files come from wiring.json and are not scanned; uncovered files are scanned", async () => {
    const h = withWiring()
    const result = await h.call("graph_find", { query: "wired" })
    expect(result.output).toContain("src/a.ts:3  function wiredOnly")
    expect(result.output).toContain("src/b.ts  function wiredTarget")
    expect(h.scans.sort()).toEqual(["core/lib.rs", "src/c.ts", "svc/main.go", "tools/util.py"])
    expect((await h.call("graph_find", { query: "entry" })).output).toContain("src/c.ts:3")
    const out = await h.call("graph_callers", { symbol: "wiredOnly", direction: "out" })
    expect(out.output).toContain("wiredHelper")
    expect(out.output).toContain("wiredTarget")
    const cache = JSON.parse(readFileSync(join(h.cacheDir, `${createHash("sha1").update(h.root).digest("hex").slice(0, 16)}.json`), "utf8"))
    expect(cache.files["src/a.ts"].source).toBe("graft")
    expect(cache.files["src/c.ts"].source).toBe("scan")
    expect(cache.graftMtimeMs).toBeGreaterThan(0)
  })

  test("a file edited after the wiring was written falls back to the own scanner, alone", async () => {
    const h = withWiring()
    await h.call("graph_find", { query: "wired" })
    h.scans.length = 0
    put({ root: h.root, path: "src/a.ts", content: `${TS_PROJECT["src/a.ts"]}export function later() {}\n`, mtime: Date.now() + 10_000 })
    const result = await h.call("graph_find", { query: "later" })
    expect(result.output).toContain("src/a.ts")
    expect(h.scans).toEqual(["src/a.ts"])
    expect((await h.call("graph_find", { query: "wiredOnly" })).output).toContain("No symbols match")
    expect((await h.call("graph_find", { query: "wiredTarget" })).output).toContain("src/b.ts")
  })

  test("a wiring.json older than the files is ignored", async () => {
    const root = project({ root: tmp(), files: TS_PROJECT })
    put({ root, path: "graft/.graph/wiring.json", content: wiring(), mtime: Date.now() - 600_000 })
    const h = harness({ root, cacheDir: tmp() })
    const result = await h.call("graph_find", { query: "wiredOnly" })
    expect(result.output).toContain("No symbols match")
    expect(h.scans.length).toBe(6)
  })

  test("a malformed wiring.json is skipped without failing", async () => {
    const root = project({ root: tmp(), files: TS_PROJECT })
    put({ root, path: "graft/.graph/wiring.json", content: "{not json", mtime: Date.now() + 60_000 })
    const h = harness({ root, cacheDir: tmp() })
    expect((await h.call("graph_find", { query: "main" })).isError).toBe(false)
    expect(h.scans.length).toBe(6)
  })
})

describe("queries", () => {
  test("graph_find ranks exact over prefix over substring and gives file:line", async () => {
    const h = setup({
      "a.ts": "export function parse() {}\nexport function parseAll() {}\nexport function reparse() {}\nexport function unrelated() {}\n",
    })
    const lines = (await h.call("graph_find", { query: "parse" })).output.split("\n")
    expect(lines[0]).toContain("a.ts:1  function parse")
    expect(lines[1]).toContain("a.ts:2  function parseAll")
    expect(lines[2]).toContain("a.ts:3  function reparse")
    expect(lines.length).toBe(3)
    expect((await setup().call("graph_find", { query: "Service.run" })).output).toContain("src/a.ts:13  method Service.run")
    expect((await h.call("graph_find", { query: "zzz" })).output).toContain("No symbols match")
    expect((await h.call("graph_find", { query: "x", kind: "nope" })).isError).toBe(true)
  })

  test("graph_find bounds results to 50", async () => {
    const source = Array.from({ length: 80 }, (_, i) => `export function item${i}() {}`).join("\n")
    const h = setup({ "many.ts": source })
    const result = await h.call("graph_find", { query: "item", limit: 50 })
    expect(result.output.split("\n").filter((line) => line.includes("function item")).length).toBe(50)
    expect(result.output).toContain("30 more matches")
    expect((await h.call("graph_find", { query: "item", limit: 51 }).catch((error) => error)) instanceof Error).toBe(true)
  })

  test("graph_callers follows callers in and callees out to depth 2", async () => {
    const h = setup()
    const into = await h.call("graph_callers", { symbol: "deep", direction: "in", depth: 2 })
    expect(into.isError).toBe(false)
    expect(into.output).toContain("d1  src/b.ts:1  function helper")
    expect(into.output).toContain("d2  src/a.ts:3  function main  (calls helper)")
    expect(into.output).toContain("Service.run")
    const d1only = await h.call("graph_callers", { symbol: "deep", direction: "in" })
    expect(d1only.output).not.toContain("main")
    const out = await h.call("graph_callers", { symbol: "main", direction: "out", depth: 2 })
    expect(out.output).toContain("d1  src/b.ts:1  function helper")
    expect(out.output).toContain("d1  src/a.ts:8  function local")
    expect(out.output).toContain("d2  src/b.ts:5  function deep  (called by helper)")
    const self = await h.call("graph_callers", { symbol: "Service.run", direction: "out" })
    expect(self.output).toContain("Service.step")
    const missing = await h.call("graph_callers", { symbol: "nothingHere", direction: "in" })
    expect(missing.isError).toBe(true)
  })

  test("graph_callers handles cross-language edges: python, go and rust", async () => {
    const h = setup()
    expect((await h.call("graph_callers", { symbol: "clean", direction: "in" })).output).toContain("tools/util.py:3  function parse")
    expect((await h.call("graph_callers", { symbol: "Box.open", direction: "out" })).output).toContain("Box.close")
    expect((await h.call("graph_callers", { symbol: "Server.Start", direction: "out" })).output).toContain("function helper")
    expect((await h.call("graph_callers", { symbol: "boost", direction: "in" })).output).toContain("Engine.new")
    expect((await h.call("graph_callers", { symbol: "Engine.new", direction: "in" })).output).toContain("Engine.run")
  })

  test("graph_file_api lists symbols with kinds and line spans", async () => {
    const h = setup()
    const result = await h.call("graph_file_api", { path: "src/a.ts" })
    expect(result.isError).toBe(false)
    const lines = result.output.split("\n")
    expect(lines[0]).toBe("src/a.ts (typescript, 5 symbols)")
    expect(lines[1]).toBe("imports: src/b.ts")
    expect(lines).toContain("L3-L6  function main (export)")
    expect(lines).toContain("L8-L10  function local")
    expect(lines).toContain("L12-L18  class Service (export)")
    expect(lines).toContain("L13-L16    method run")
    expect(lines).toContain("L17-L17    method step")
    expect((await h.call("graph_file_api", { path: "./src/a.ts" })).output).toContain("class Service")
    expect((await h.call("graph_file_api", { path: join(h.root, "src/a.ts") })).output).toContain("class Service")
    expect((await h.call("graph_file_api", { path: "../etc/passwd" })).isError).toBe(true)
    expect((await h.call("graph_file_api", { path: "README.md" })).output).toContain("unsupported language")
    expect((await h.call("graph_file_api", { path: "src/missing.ts" })).isError).toBe(true)
  })

  test("graph_map counts files per language per directory and ranks hubs by callers", async () => {
    const h = setup()
    const result = await h.call("graph_map", {})
    expect(result.meta).toMatchObject({ files: 6, partial: false })
    const lines = result.output.split("\n")
    expect(lines).toContain("src  3 files  ts 3")
    expect(lines).toContain("tools  1 files  py 1")
    expect(lines).toContain("svc  1 files  go 1")
    expect(lines).toContain("core  1 files  rs 1")
    const hubs = lines.slice(lines.indexOf("Hub symbols (most callers):") + 1)
    expect(hubs[0]).toMatch(/^helper {2}src\/b\.ts:1 {2}callers:2$/)
    const scoped = await h.call("graph_map", { path: "src" })
    expect(scoped.meta?.files).toBe(3)
    const shallow = await h.call("graph_map", { depth: 1 })
    expect(shallow.output).toContain("src  3 files")
  })

  test("an aborted call is cancelled and the next call still builds the full graph", async () => {
    const h = setup()
    const controller = new AbortController()
    controller.abort()
    const result = await h.call("graph_find", { query: "main" }, controller.signal)
    expect(result).toMatchObject({ isError: true, output: "cancelled" })
    expect((await h.call("graph_find", { query: "main" })).output).toContain("src/a.ts:3")
  })
})

describe("render specs", () => {
  type MapSpec = { type: string; center: { label: string; file?: string; line?: number }; left: { title: string; entries: Array<{ label: string; file?: string; line?: number; depth?: number }>; more?: number; flow?: string }; right: { title: string; entries: Array<{ label: string; depth?: number }>; more?: number; flow?: string } }

  test("graph_find returns a codemap with the matches on the right that the protocol accepts", async () => {
    const h = setup()
    const result = await h.call("graph_find", { query: "e" })
    const spec = expectValidRender(result) as MapSpec
    expect(spec.type).toBe("codemap")
    expect(spec.center).toMatchObject({ label: "search: e", kind: "search" })
    expect(spec.left).toEqual({ title: "", entries: [] })
    expect(spec.right).toMatchObject({ title: "matches", flow: "none", more: 0 })
    expect(spec.right.entries.length).toBeGreaterThan(0)
  })

  test("graph_callers in returns the callers with hop depth on the left and the direct callees on the right", async () => {
    const h = setup()
    const result = await h.call("graph_callers", { symbol: "deep", direction: "in", depth: 2 })
    const spec = expectValidRender(result) as MapSpec
    expect(spec.type).toBe("codemap")
    expect(spec.center).toMatchObject({ label: "deep", file: "src/b.ts", line: 5 })
    expect(spec.left).toMatchObject({ title: "callers", flow: "in", more: 0 })
    expect(spec.left.entries).toMatchObject([
      { label: "helper", file: "src/b.ts", line: 1, depth: 1 },
      { label: "main", file: "src/a.ts", line: 3, depth: 2 },
      { label: "Service.run", file: "src/a.ts", line: 13, depth: 2 },
    ])
    expect(spec.right).toMatchObject({ title: "callees", flow: "out", entries: [] })
    const out = await h.call("graph_callers", { symbol: "main", direction: "out" })
    const outSpec = expectValidRender(out) as MapSpec
    expect(outSpec.right.entries.map((entry) => entry.label)).toEqual(["local", "helper"])
    expect(outSpec.left.entries.map((entry) => entry.label)).toEqual(["entry"])
  })

  test("a hop past the first names the entry it was reached through (via); direct hops carry none", async () => {
    const h = setup()
    const into = expectValidRender(await h.call("graph_callers", { symbol: "deep", direction: "in", depth: 2 })) as MapSpec
    const byLabel = (spec: MapSpec["left"]) => Object.fromEntries(spec.entries.map((entry) => [entry.label, (entry as { via?: string }).via]))
    expect(byLabel(into.left)).toEqual({ helper: undefined, main: "helper", "Service.run": "helper" })
    const out = expectValidRender(await h.call("graph_callers", { symbol: "main", direction: "out", depth: 2 })) as MapSpec
    expect(byLabel(out.right as MapSpec["left"])).toEqual({ local: undefined, helper: undefined, deep: "helper" })
    const direct = expectValidRender(await h.call("graph_callers", { symbol: "main", direction: "out" })) as MapSpec
    for (const entry of direct.right.entries) expect("via" in entry).toBe(false)
  })

  test("graph_map render is valid, rooted at the project directory", async () => {
    const h = setup()
    const spec = expectValidRender(await h.call("graph_map", {})) as { children: Array<{ type: string; root?: string }> }
    expect(spec.children[0]?.type).toBe("graph")
    expect(spec.children[0]?.root).toBe(h.root.split("/").pop())
  })

  test("graph_map is the map and one muted summary row; its hub table (preview) holds at most 6 rows and its lists only show once opened", async () => {
    const h = setup()
    type Node = { type: string; at?: string; children?: Node[]; text?: string; tone?: string; rows?: unknown[][] }
    const spec = expectValidRender(await h.call("graph_map", {})) as { type: string; children: Node[] }
    expect(spec.children.map((node) => node.type)).toEqual(["graph", "text", "detail", "detail"])
    const summary = spec.children[1]!
    expect(summary.text).toMatch(/^\d+ dirs? · \d+ files?/)
    expect(summary.tone).toBe("muted")
    const [preview, open] = [spec.children[2]!, spec.children[3]!]
    expect([preview.at, open.at]).toEqual(["preview", "open"])
    const table = preview.children?.find((node) => node.type === "table")
    if (table) expect(table.rows!.length).toBeLessThanOrEqual(6)
    expect(open.children?.some((node) => node.type === "list")).toBe(true)
  })

  test("graph_file_api draws its language, counts, a symbol table in preview and every symbol when opened", async () => {
    const h = setup()
    const result = await h.call("graph_file_api", { path: "src/a.ts" })
    type Node = { type: string; at?: string; children?: Node[] }
    const spec = expectValidRender(result) as { children: Node[] }
    expect(spec.children[0]!.type).toBe("text")
    expect(spec.children.filter((node) => node.type === "detail").map((node) => node.at)).toEqual(["preview", "open"])
  })

  test("at most 50 entries per side however large the fan-out, with the rest counted", async () => {
    const callees = Array.from({ length: 60 }, (_, i) => `export function leaf${i}() {}`)
    const hub = `export function hub() {\n${callees.map((_, i) => `  leaf${i}()`).join("\n")}\n}`
    const h = setup({ "big.ts": `${callees.join("\n")}\n${hub}\n` })
    const result = await h.call("graph_callers", { symbol: "hub", direction: "out" })
    const spec = expectValidRender(result) as MapSpec
    expect(spec.right.entries.length).toBe(50)
    expect(spec.right.more).toBe(10)
    expect(spec.left.entries.length).toBe(0)
    expect(result.truncated).toBe(true)
    expect(result.output).toContain("10 more")
  })

  test("the side the tool was not asked about shows at most 12 direct neighbours", async () => {
    const callers = Array.from({ length: 20 }, (_, i) => `export function user${i}() { target() }`)
    const h = setup({ "big.ts": `export function target() {}\n${callers.join("\n")}\n` })
    const spec = expectValidRender(await h.call("graph_callers", { symbol: "target", direction: "out" })) as MapSpec
    expect(spec.left.entries.length).toBe(12)
    expect(spec.left.more).toBe(8)
    expect(spec.left.entries.every((entry) => entry.depth === 1)).toBe(true)
  })
})
