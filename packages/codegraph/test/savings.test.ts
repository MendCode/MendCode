import { readFileSync } from "node:fs"
import { join } from "node:path"
import { estimateTokens } from "@mendcode/protocol/wire"
import { describe, expect, test } from "bun:test"
import { parseRenderSpec } from "@mendcode/protocol"
import { harness, project, useTempDirs } from "./helpers"
import { createIndexer } from "../src"
import { hitChars, LINE_BYTES, lookupSavings, rangeChars, sumChars } from "../src/savings"

const tmp = useTempDirs()

function setup(files: Record<string, string>) {
  return harness({ root: project({ root: tmp(), files }), cacheDir: tmp() })
}

/** Every line of the fixtures is as wide as the assumed bytes per line, so the estimate and the estimate can be compared with rg's real output. */
const WIDTH = LINE_BYTES - 1
const row = (text: string) => `${text}${" ".repeat(Math.max(0, WIDTH - text.length))}`
const body = (name: string, count: number) => Array.from({ length: count }, (_, i) => row(`  const ${name}${i} = compute(${i}) //`)).join("\n")

/** What `rg -n <needle>` prints over the project: `path:line:text` per matching line, the same shape the estimate prices. */
function rgOutput({ root, needle }: { root: string; needle: string }): string {
  const out: string[] = []
  for (const path of [...new Bun.Glob("**/*.ts").scanSync({ cwd: root })].sort()) {
    readFileSync(join(root, path), "utf8").split("\n").forEach((text, index) => { if (text.includes(needle)) out.push(`${path}:${index + 1}:${text}`) })
  }
  return `${out.join("\n")}\n`
}

/** `target` declared once and called from five other files, each of them long. */
function callerProject() {
  const files: Record<string, string> = { "src/lib.ts": `${row("export function target() {")}\n${row("  return 1")}\n${row("}")}\n${body("lib", 300)}\n` }
  for (let n = 0; n < 5; n++) files[`src/user${n}.ts`] = `${row('import { target } from "./lib"')}\n${row(`export function use${n}() {`)}\n${row("  return target()")}\n${row("}")}\n${body(`user${n}`, 300)}\n`
  return files
}

const within = (estimate: number, real: number, tolerance: number) => Math.abs(estimate - real) <= real * tolerance

describe("graph lookup savings estimate", () => {
  test("graph_find prices the rg -n of its query, not the files it points at: the estimate is the rg output minus the result", async () => {
    const h = setup(callerProject())
    const result = await h.call("graph_find", { query: "target" })
    const real = estimateTokens(rgOutput({ root: h.root, needle: "target(" }).length)
    const returned = estimateTokens(result.output.length)
    const saved = Number(result.meta?.savedTokens)
    // `rg -n "target("` is the declaration and the five calls; the import lines `rg -n target` adds are not counted, so the figure is a floor.
    expect(saved).toBeGreaterThan(0)
    expect(saved + returned).toBeLessThanOrEqual(real)
    expect(within(saved + returned, real, 0.2)).toBe(true)
    expect(result.meta?.filter).toBe("graph")
    // Reading the six files whole is what the old figure counted; it was an order of magnitude more.
    expect(saved).toBeLessThan(estimateTokens(Object.values(callerProject()).join("").length) / 10)
  })

  test("graph_callers (in) prices one rg hit per declaration and per caller", async () => {
    const h = setup(callerProject())
    const result = await h.call("graph_callers", { symbol: "target", direction: "in" })
    const real = estimateTokens(rgOutput({ root: h.root, needle: "target(" }).length)
    const saved = Number(result.meta?.savedTokens)
    expect(saved).toBeGreaterThan(0)
    expect(saved + estimateTokens(result.output.length)).toBeLessThanOrEqual(real)
    expect(within(saved + estimateTokens(result.output.length), real, 0.2)).toBe(true)
    const spec = parseRenderSpec(result.render)
    expect(spec.ok && spec.spec.type === "codemap" ? spec.spec.saved : undefined).toBe(saved)
  })

  test("graph_callers (out) prices reading the symbol's lines, not its file", async () => {
    const lines = [row("export function caller() {"), ...Array.from({ length: 30 }, (_, i) => row(`  helper${i % 3}(${i})`)), row("}"), row("function helper0() {}"), row("function helper1() {}"), row("function helper2() {}"), body("pad", 400)]
    const h = setup({ "src/a.ts": `${lines.join("\n")}\n` })
    const graph = await createIndexer({ cacheDir: h.cacheDir, now: () => 1 }).graph({ cwd: h.root, signal: new AbortController().signal })
    const node = graph.byId.get("src/a.ts#caller") ?? graph.nodes.find((entry) => entry.name === "caller")!
    const read = lines.slice(node.start - 1, node.end).join("\n") + "\n"
    expect(within(rangeChars({ node })!, read.length, 0.05)).toBe(true)
    const result = await h.call("graph_callers", { symbol: "caller", direction: "out" })
    const saved = result.meta?.savedTokens
    const wholeFile = estimateTokens(lines.join("\n").length)
    expect(saved === undefined || Number(saved) < estimateTokens(read.length)).toBe(true)
    expect(saved === undefined || Number(saved) < wholeFile / 5).toBe(true)
  })

  test("a hundred hits across sixty-five files are priced as the hundred rg lines they are, not as the files", async () => {
    const files: Record<string, string> = {}
    for (let n = 0; n < 65; n++) files[`src/m${n}.ts`] = `${row(`export function threshold_tokens${n}() {`)}\n${row(`  return ${n}`)}\n${row("}")}\n${body(`m${n}`, 200)}\n`
    const h = setup(files)
    const result = await h.call("graph_find", { query: "threshold_tokens", limit: 20 })
    const real = estimateTokens(rgOutput({ root: h.root, needle: "threshold_tokens" }).length)
    const saved = Number(result.meta?.savedTokens)
    expect(saved + estimateTokens(result.output.length)).toBeLessThanOrEqual(real)
    expect(within(saved + estimateTokens(result.output.length), real, 0.15)).toBe(true)
    expect(saved).toBeLessThan(estimateTokens(Object.values(files).join("").length) / 20)
  })

  test("graph_file_api keeps pricing the whole file it spares the model from reading", async () => {
    const file = `${row("export function target() {")}\n${row("  return 1")}\n${row("}")}\n${body("big", 400)}\n`
    const h = setup({ "src/big.ts": file })
    const result = await h.call("graph_file_api", { path: "src/big.ts" })
    expect(Number(result.meta?.savedTokens)).toBe(estimateTokens(file.length) - estimateTokens(result.output.length))
  })

  test("graph_map reports no saving: there is no honest alternative to price", async () => {
    const h = setup(callerProject())
    const result = await h.call("graph_map", {})
    expect(result.isError).toBe(false)
    expect(result.meta?.savedTokens).toBeUndefined()
    expect(result.meta?.filter).toBeUndefined()
  })

  test("a lookup that is no smaller than rg claims next to nothing, never a negative figure", async () => {
    const h = setup({ "a.ts": "export function f() {}\n" })
    for (const [name, args] of [["graph_callers", { symbol: "f", direction: "in" }], ["graph_find", { query: "f" }]] as const) {
      const result = await h.call(name, args)
      expect(result.isError).toBe(false)
      // One declaration and no callers: rg prints one line, the graph about the same, so nothing worth a figure is claimed.
      expect(Number(result.meta?.savedTokens ?? 0)).toBeLessThan(10)
    }
  })

  test("lookupSavings is the alternative over four minus the output, clamped; an unknown alternative reports nothing", () => {
    expect(lookupSavings({ alternativeChars: 4000, output: "x".repeat(400) })).toBe(900)
    expect(lookupSavings({ alternativeChars: 400, output: "x".repeat(400) })).toBeUndefined()
    expect(lookupSavings({ alternativeChars: 100, output: "x".repeat(400) })).toBeUndefined()
    expect(lookupSavings({ alternativeChars: undefined, output: "" })).toBeUndefined()
    expect(sumChars([10, undefined, 5])).toBeUndefined()
    expect(sumChars([10, 5])).toBe(15)
  })

  test("a hit is priced as path:line: plus the assumed bytes per line", () => {
    expect(hitChars({ path: "src/lib.ts", line: 7 })).toBe("src/lib.ts".length + 2 + 1 + LINE_BYTES)
    expect(hitChars({ path: "src/lib.ts", line: 120 })).toBe("src/lib.ts".length + 2 + 3 + LINE_BYTES)
  })
})
