import { estimateTokens } from "@mendcode/protocol/wire"
import { describe, expect, test } from "bun:test"
import { graftReportedSavings, parseRenderSpec } from "@mendcode/protocol"
import { harness, project, useTempDirs } from "./helpers"
import { createIndexer } from "../src"
import { lookupSavings } from "../src/tools"

const tmp = useTempDirs()

/** `main` in a large file, called from a second large file: reading both would cost far more than the lookup's answer. */
const padding = (name: string) => Array.from({ length: 400 }, (_, i) => `// ${name} filler line ${i} that makes the file long enough to matter`).join("\n")
const BIG: Record<string, string> = {
  "src/big.ts": `export function target() {\n  return 1\n}\n${padding("big")}\n`,
  "src/user.ts": `import { target } from "./big"\nexport function useTarget() {\n  return target()\n}\n${padding("user")}\n`,
}

function setup(files: Record<string, string>) {
  return harness({ root: project({ root: tmp(), files }), cacheDir: tmp() })
}

describe("graph lookup savings estimate", () => {
  test("graph_callers reports the files it spares the model from reading, in meta and in the map", async () => {
    const h = setup(BIG)
    const result = await h.call("graph_callers", { symbol: "target", direction: "in" })
    const saved = Number(result.meta?.savedTokens)
    const bytes = BIG["src/big.ts"]!.length + BIG["src/user.ts"]!.length
    expect(saved).toBeGreaterThan(bytes / 4 - result.output.length / 4 - 2)
    expect(saved).toBeLessThanOrEqual(estimateTokens(bytes))
    expect(result.meta?.filter).toBe("graph")
    const spec = parseRenderSpec(result.render)
    expect(spec.ok).toBe(true)
    expect(spec.ok && spec.spec.type === "codemap" ? spec.spec.saved : undefined).toBe(saved)
  })

  test("graph_find counts only the files of the matches it lists", async () => {
    const h = setup(BIG)
    const result = await h.call("graph_find", { query: "useTarget" })
    const saved = Number(result.meta?.savedTokens)
    expect(saved).toBeGreaterThan(0)
    expect(saved).toBeLessThan(estimateTokens(BIG["src/user.ts"]!.length) + 1)
  })

  test("a lookup whose answer is not smaller than the files saves nothing: no figure, never negative", async () => {
    const h = setup({ "a.ts": "export function f() {}\n" })
    for (const [name, args] of [["graph_callers", { symbol: "f", direction: "in" }], ["graph_find", { query: "f" }]] as const) {
      const result = await h.call(name, args)
      expect(result.isError).toBe(false)
      expect(result.meta?.savedTokens).toBeUndefined()
      expect(result.meta?.filter).toBeUndefined()
      const spec = parseRenderSpec(result.render)
      expect(spec.ok && spec.spec.type === "codemap" ? spec.spec.saved : "missing").toBeUndefined()
    }
  })

  test("lookupSavings is the file bytes over four minus the output, clamped, and ignores unknown files", async () => {
    const h = setup(BIG)
    const graph = await createIndexer({ cacheDir: h.cacheDir, now: () => 1 }).graph({ cwd: h.root, signal: new AbortController().signal })
    const bytes = BIG["src/big.ts"]!.length
    expect(lookupSavings({ graph, paths: ["src/big.ts"], output: "x".repeat(400) })).toBe(estimateTokens(bytes) - 100)
    expect(lookupSavings({ graph, paths: ["src/big.ts", "src/big.ts"], output: "" })).toBe(estimateTokens(bytes))
    expect(lookupSavings({ graph, paths: ["src/big.ts"], output: "x".repeat(bytes * 2) })).toBeUndefined()
    expect(lookupSavings({ graph, paths: ["missing.ts"], output: "" })).toBeUndefined()
    expect(lookupSavings({ graph, paths: [], output: "" })).toBeUndefined()
  })
})

describe("graft's reported savings", () => {
  test("reads the number of graft's own line and nothing else", () => {
    expect(graftReportedSavings("[graft] tokens saved ≈ 16,491 (98%) — this output ≈ 316 tok")).toBe(16_491)
    expect(graftReportedSavings("x\n[graft] tokens saved ≈ 812 (40%)\ny")).toBe(812)
    expect(graftReportedSavings("tokens saved ≈ 99")).toBeUndefined()
    expect(graftReportedSavings("[graft] tokens saved ≈ 0 (0%)")).toBeUndefined()
    expect(graftReportedSavings("[graft] no graft/ here")).toBeUndefined()
    expect(graftReportedSavings("")).toBeUndefined()
  })
})
